/**
 * station-config.js — HB9VQQ fork station configuration
 *
 * Edit this file to customise the fork for your station.
 * All other JS files read from this object — no other changes needed.
 *
 * port detection: window.location.port (or '80' if omitted)
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
    // type: 'omni'        — omnidirectional, no rotator
    // type: 'directional' — beam antenna with rotator
    //   rotatorUrl: URL of PstRotatorAz web server (polled every 5s)
    ports: {
        8081: {
            name: 'N4CY Loop',
            type: 'omni'
        },
        8082: {
            name: 'Spiderbeam HD Yagi',
            type: 'directional',
            rotatorUrl: 'http://192.168.1.44/PstRotatorAz.htm'
        }
    }
};
