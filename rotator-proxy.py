#!/usr/bin/env python3
"""
rotator-proxy.py — HB9VQQ fork
Polls PstRotatorAz HTTP web server, extracts current bearing,
serves it as JSON on a local HTTP port for the browser compass panel.

Endpoint: GET http://localhost:9376/  → {"azimuth": 65, "ok": true}
On error:                             → {"azimuth": null, "ok": false, "error": "..."}
"""

import asyncio, re, json, time, logging
from aiohttp import web, ClientSession, ClientTimeout

ROTATOR_URL   = 'http://192.168.1.44/PstRotatorAz.htm'
POLL_INTERVAL = 5
LISTEN_PORT   = 9376
FETCH_TIMEOUT = 4

state = {'azimuth': None, 'ok': False, 'error': 'Starting up', 'ts': 0}

logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
log = logging.getLogger('rotator-proxy')

async def poll_rotator():
    timeout = ClientTimeout(total=FETCH_TIMEOUT)
    async with ClientSession(timeout=timeout) as session:
        while True:
            try:
                async with session.get(ROTATOR_URL) as resp:
                    html = await resp.text()
                m = re.search(r'Bearing\s*=\s*(\d+)\s*deg', html)
                if m:
                    az = int(m.group(1))
                    state.update({'azimuth': az, 'ok': True, 'error': None, 'ts': time.time()})
                    log.debug(f'Azimuth: {az}deg')
                else:
                    state.update({'azimuth': None, 'ok': False, 'error': 'Bearing not found in response'})
                    log.warning('Bearing not found in PstRotatorAz response')
            except Exception as e:
                state.update({'azimuth': None, 'ok': False, 'error': str(e)})
                log.warning(f'Poll error: {e}')
            await asyncio.sleep(POLL_INTERVAL)

async def handle(request):
    body = json.dumps({'azimuth': state['azimuth'], 'ok': state['ok'], 'error': state['error']})
    return web.Response(text=body, content_type='application/json',
        headers={'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache'})

async def main():
    app = web.Application()
    app.router.add_get('/', handle)
    app.router.add_get('/azimuth', handle)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, '127.0.0.1', LISTEN_PORT)
    await site.start()
    log.info(f'rotator-proxy listening on http://127.0.0.1:{LISTEN_PORT}/')
    log.info(f'Polling {ROTATOR_URL} every {POLL_INTERVAL}s')
    await poll_rotator()

if __name__ == '__main__':
    asyncio.run(main())
