#!/usr/bin/env python3
"""
dx-cluster-bridge.py — DX Cluster WebSocket Bridge
HB9VQQ ka9q-web fork, Phase 1

Connects to a DX Spider telnet cluster, parses DX de spots,
and re-publishes them as JSON over a WebSocket server.

Install deps:  pip install 'websockets>=10'
Run:           python3 dx-cluster-bridge.py --callsign HB9VQQ
Systemd:       see dx-cluster-bridge.service
"""

import asyncio
import json
import re
import argparse
import logging
from datetime import datetime, timezone

import websockets

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s %(levelname)s %(message)s',
    datefmt='%Y-%m-%dT%H:%M:%SZ',
)
log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Spot regex — matches:  DX de EA4KD:  14025.0  VK3TZ  CW 599  2238Z
# groups: (spotter, freq_khz, dx_call, comment, time_z)
# ---------------------------------------------------------------------------
DX_RE = re.compile(
    r'^DX de\s+(\S+?):\s*(\d+\.\d+)\s+(\S+)\s*(.*?)\s*(\d{4}Z?)\s*$'
)

# ---------------------------------------------------------------------------
# Shared state
# ---------------------------------------------------------------------------
connected_clients: set = set()
spot_cache: list = []   # list of spot dicts, each has internal '_ts' key
_max_age: int = 30      # overwritten from --max-age in main()

# ---------------------------------------------------------------------------
# Mode inference
# ---------------------------------------------------------------------------
FT_WINDOWS = [          # (dial_kHz, mode) — match if abs(freq - dial) <= 2 kHz
    (7074,  'FT8'),
    (14074, 'FT8'),
    (21074, 'FT8'),
    (28074, 'FT8'),
    (7047,  'FT4'),
    (14080, 'FT4'),
]

BAND_MODES = [          # general fallback: (lo_kHz, hi_kHz, mode) — first match wins
    (1800,  2000,  'CW'),
    (3500,  3600,  'CW'),
    (3600,  3800,  'SSB'),
    (7000,  7060,  'CW'),
    (7060,  7300,  'SSB'),
    (10100, 10150, 'CW'),
    (14000, 14070, 'CW'),
    (14070, 14350, 'SSB'),
    (18068, 18110, 'CW'),
    (18110, 18168, 'SSB'),
    (21000, 21150, 'CW'),
    (21150, 21450, 'SSB'),
    (24890, 24920, 'CW'),
    (24920, 24990, 'SSB'),
    (28000, 28300, 'CW'),
    (28300, 29700, 'SSB'),
]


def infer_mode(freq_khz: float, comment: str) -> str:
    """Infer mode from comment keywords first, then FT windows, then band plan."""
    upper = comment.upper()
    # 1. Comment keywords take priority
    for kw in ('FT8', 'FT4', 'WSPR', 'JS8', 'PSK', 'RTTY', 'DIGI', 'CW', 'SSB'):
        if kw in upper:
            return kw
    # 2. Digital window check (±2 kHz)
    for dial, mode in FT_WINDOWS:
        if abs(freq_khz - dial) <= 2:
            return mode
    # 3. General band plan
    for lo, hi, mode in BAND_MODES:
        if lo <= freq_khz <= hi:
            return mode
    return 'OTHER'


# ---------------------------------------------------------------------------
# Spot parsing
# ---------------------------------------------------------------------------
def parse_spot(m: re.Match) -> dict | None:
    """Convert DX_RE match to spot dict. Returns None if required fields missing."""
    try:
        spotter, freq_str, dx_call, comment, time_z = m.group(1, 2, 3, 4, 5)
        freq_khz = float(freq_str)
        mode = infer_mode(freq_khz, comment)
        now = datetime.now(timezone.utc)
        hh = int(time_z[:2])
        mm = int(time_z[2:4])
        spot_time = now.replace(hour=hh, minute=mm, second=0, microsecond=0)
        return {
            'dx_call':   dx_call.upper(),
            'frequency': freq_khz,
            'spotter':   spotter.upper(),
            'mode':      mode,
            'comment':   comment.strip(),
            'time':      spot_time.strftime('%Y-%m-%dT%H:%M:%SZ'),
            '_ts':       spot_time.timestamp(),   # internal — stripped before sending
        }
    except Exception:
        return None


# ---------------------------------------------------------------------------
# Cache management
# ---------------------------------------------------------------------------
def prune_cache(max_age_minutes: int) -> None:
    """Remove spots older than max_age_minutes from the in-memory cache."""
    cutoff = datetime.now(timezone.utc).timestamp() - max_age_minutes * 60
    spot_cache[:] = [s for s in spot_cache if s['_ts'] > cutoff]


def _public(spot: dict) -> dict:
    """Return spot without the internal _ts field."""
    return {k: v for k, v in spot.items() if k != '_ts'}


# ---------------------------------------------------------------------------
# WebSocket server
# ---------------------------------------------------------------------------
async def ws_handler(websocket) -> None:
    """Handle a single WebSocket client connection."""
    connected_clients.add(websocket)
    log.info('WS client connected — %d total', len(connected_clients))
    try:
        prune_cache(_max_age)
        # Send full cache as JSON array on connect
        await websocket.send(json.dumps([_public(s) for s in spot_cache]))
        # Keep connection alive; ignore any messages from client
        async for _ in websocket:
            pass
    except websockets.exceptions.ConnectionClosed:
        pass
    finally:
        connected_clients.discard(websocket)
        log.info('WS client disconnected — %d total', len(connected_clients))


async def broadcast(spot: dict, max_age_minutes: int) -> None:
    """Append spot to cache and broadcast it to all connected WS clients."""
    spot_cache.append(spot)
    prune_cache(max_age_minutes)
    if connected_clients:
        msg = json.dumps(_public(spot))
        results = await asyncio.gather(
            *[c.send(msg) for c in connected_clients],
            return_exceptions=True
        )
        errors = [r for r in results if isinstance(r, Exception)]
        if errors:
            log.debug('%d send error(s) on broadcast', len(errors))


# ---------------------------------------------------------------------------
# Telnet reader (reconnecting loop)
# ---------------------------------------------------------------------------
async def telnet_reader(args: argparse.Namespace) -> None:
    """Connect to DX cluster, parse spots, broadcast; reconnect on any failure."""
    while True:
        try:
            log.info('Connecting to %s:%d …', args.cluster_host, args.cluster_port)
            reader, writer = await asyncio.open_connection(
                args.cluster_host, args.cluster_port
            )
            log.info('Connected — logging in as %s', args.callsign)
            # Wait for login prompt (avoids parsing prompt text)
            await asyncio.sleep(1)
            writer.write(f'{args.callsign}\r\n'.encode())
            await writer.drain()
            log.info('Logged in — listening for spots')

            buf = ''
            while True:
                data = await reader.read(4096)
                if not data:
                    break
                buf += data.decode('utf-8', errors='replace')
                while '\n' in buf:
                    line, buf = buf.split('\n', 1)
                    line = line.strip().rstrip('\x07')
                    m = DX_RE.match(line)
                    if m:
                        spot = parse_spot(m)
                        if spot:
                            log.debug('Spot: %s %.1f %s %s',
                                      spot['dx_call'], spot['frequency'],
                                      spot['mode'], spot['spotter'])
                            await broadcast(spot, args.max_age)

            log.warning('Cluster connection closed (EOF)')

        except Exception as exc:
            log.warning('Cluster error: %s', exc)

        log.info('Reconnecting in 15 s …')
        await asyncio.sleep(15)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
async def main(args: argparse.Namespace) -> None:
    global _max_age
    _max_age = args.max_age
    log.info('Starting WS server on 0.0.0.0:%d (max-age=%d min)',
             args.ws_port, args.max_age)
    async with websockets.serve(ws_handler, '0.0.0.0', args.ws_port):
        await telnet_reader(args)   # runs forever (reconnect loop)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='DX Cluster WebSocket Bridge')
    parser.add_argument('--cluster-host', default='dxcluster.hb9vqq.ch',
                        help='DX Spider telnet host (default: dxcluster.hb9vqq.ch)')
    parser.add_argument('--cluster-port', type=int, default=7300,
                        help='DX Spider telnet port (default: 7300)')
    parser.add_argument('--callsign', default='HB9VQQ',
                        help='Login callsign (default: HB9VQQ)')
    parser.add_argument('--ws-port', type=int, default=9373,
                        help='WebSocket server port (default: 9373)')
    parser.add_argument('--max-age', type=int, default=30,
                        help='Spot cache age in minutes (default: 30)')
    asyncio.run(main(parser.parse_args()))
