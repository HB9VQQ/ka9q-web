/**
 * station-config.js — HB9VQQ fork station configuration
 *
 * Edit this file to customise the fork for your station.
 * All other JS files read from this object — no other changes needed.
 */

const STATION_CONFIG = {

    // ── Station identity ──────────────────────────────────────────────────────
    callsign:    'HB9VQQ',
    locator:     'JN47',
    siteUrl:     'rx888.hb9vqq.ch',

    // ── External services ─────────────────────────────────────────────────────
    dxClusterWs: 'wss://dxmap.hb9vqq.ch/dx-ws',
    solarApiUrl: 'https://dxmap.hb9vqq.ch/data/eu_v4.json',

    // ── Per-port antenna configuration ───────────────────────────────────────
    // WAN ports (nginx HTTPS) and LAN ports (direct HTTP) both listed.
    // type: 'omni'        — omnidirectional, no rotator
    // type: 'directional' — beam antenna with rotator
    ports: {
        8081: { name: 'N4CY Loop',          type: 'omni',        wanPort: 8081 },
        9081: { name: 'N4CY Loop',          type: 'omni',        wanPort: 8081 },
        8082: { name: 'Spiderbeam HD Yagi', type: 'directional', wanPort: 8082,
                rotatorUrl: 'http://192.168.1.44/PstRotatorAz.htm' },
        9082: { name: 'Spiderbeam HD Yagi', type: 'directional', wanPort: 8082,
                rotatorUrl: 'http://192.168.1.44/PstRotatorAz.htm' }
    }
};
