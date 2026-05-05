# ka9q-web — HB9VQQ Fork

**Fork by:** Roland, HB9VQQ  
**Upstream:** https://github.com/scottnewell/ka9q-web  
**Live instances:** https://rx888.hb9vqq.ch:8081 · https://rx888.hb9vqq.ch:8082 · https://rx888.hb9vqq.ch:8083

---

## What's new in this fork

### Beam direction compass (`compass.js`, `rotator-proxy.py`)

* **Live rotator display** — floating draggable compass panel showing current beam heading in real time
* Polls the PstRotatorAz web server every 5 seconds via a local proxy (`rotator-proxy.py`)
* Canvas compass rose with N/E/S/W labels, beam needle, ±15° beam cone, and degree readout
* Only shown for directional antennas (configurable in `station-config.js`); hidden for omni antennas
* Opens automatically on page load; remembers open/closed state across reloads
* Requires `rotator-proxy.service` running on the ka9q-web host server (see Deployment below)

### RMNoise AI Denoising (`rmnoise.js`, `ka9q-rmnoise-worklet.js`)

* **AI-powered noise reduction** via [rmnoise.com](https://rmnoise.com) — requires a free rmnoise.com account
* Integrated natively into the ka9q-web UI — no OS audio routing or browser extensions required
* Floating draggable modal: credentials, AI filter model selector, mix slider (0–100%), bypass button, statistics, log
* **Mix slider** — blend from 0% (original) to 100% (fully denoised) with no echo at any value
* **AudioWorklet path** (HTTPS) — echo-free blend with no latency artifacts
* **JS fallback path** (HTTP) — full blend functionality on plain HTTP connections
* **Auto-bypass** — automatically bypasses when switching to AM/FM/NFM (unsupported modes); resumes on return to SSB/CW
* **3 kHz send-path LPF** — removes SDR noise above voice band before AI processing, preventing aliasing artifacts
* Requires HTTPS for AudioWorklet (nginx + Let's Encrypt setup documented below)

### C source changes (`ka9q-web.c`)

* **`listen_mcast()` 2-arg adaptation** — upstream scottnewell/ka9q-radio uses a 2-argument `listen_mcast()` signature; the first `NULL` source-specific argument is removed from both call sites
* **`Z:SIZE` zoom table handler** — responds to `Z:SIZE` WebSocket command with `ZSIZE:<n>`, enabling the JS zoom slider to set its max range dynamically from the server's zoom table

### Dark theme UI (`radio.html`)

* Full dark theme with teal/amber/violet accent colors and scanline texture
* Solar indices bar: SFI, A, K, Kp, SWS, DRAP — live data from dxmap.hb9vqq.ch
* UTC clock in header
* Band selector with Amateur / Broadcast / Utility categories
* Mode auto-switching by frequency (LSB below 10 MHz, USB above, AM for broadcast)
* Improved Options dialog styling and positioning
* Frequency input Enter-to-tune support
* Resizable spectrum/waterfall with live DX overlay tracking
* Analog S-meter floating panel (draggable, analog/digital modes)
* Audio recording, pan control, passband drag
* **Filter edge save/restore** — low/high filter values persisted across reloads

### Audio dynamics compressor (`pcm-player.js`)

* **Improves SSB intelligibility** — automatically levels weak and strong signals so you stop reaching for the volume knob
* Weak DX stations fading in and out become consistently audible
* Strong nearby stations are pulled back without clipping
* Toggle button in the Audio panel — state remembered across reloads
* Works alongside RMNoise AI denoising — compresses the already-denoised audio for best results

### BCL/SWL broadcast listener features

* **Broadcast band plan** — LW (216 kHz), MW (1000 kHz), 120M–11M (16 bands total)
* **AM mode auto-switch** — selecting any broadcast band automatically sets AM demodulation
* **BCL station overlay** (`bcl-overlay.js`) — amber dashed lines with station names on the spectrum waterfall:
  * Always on, filtered to visible frequency range
  * Multiple stations sharing a frequency stacked vertically above the line
  * 4-tier varying line heights (deterministic by frequency hash — visually varied)
  * Labels suppressed when too crowded; shown in full when zoomed in
  * 14-character name truncation
* **EiBi + AOKI dual database** — ~6700 unique stations merged from both sources
* **Local overrides** (`bcl_local.json`) — for stations missing from both databases
* **User-selectable database** via Options dialog: EiBi only / AOKI only / merged
* **Twice-yearly cron update** via `bcl_to_json.py`
* **On-air filter** — "Now on air only" checkbox hides stations not currently broadcasting

### DX cluster spot overlay (`dx-cluster.js`)

* Live DX cluster spots overlaid on the spectrum as vertical dashed lines
* Callsign labels with ◇ prefix, color-coded by mode:
  * CW: cyan · SSB: yellow · FT8/FT4: magenta · RTTY: orange
* Age fade over configurable window (default 30 min)
* Row staggering for overlapping spots
* Click-to-tune on spot frequency
* Mode filter (ALL / CW / SSB / FT8 / FT4 / RTTY)
* Spotter region filter (ALL / EU / NA / SA / AS / AF / OC)
* Reconnecting WebSocket with exponential backoff

### DX cluster bridge (`dx-cluster-bridge.py`)

* Python asyncio bridge: DX Spider telnet → WebSocket JSON
* In-memory spot cache with age pruning
* FT8/FT4 mode inference from frequency windows
* Systemd service included

---

## Deployment

### Quick start

This gets you the dark theme UI with spectrum, waterfall, S-meter, and zoom slider working. Optional features (DX cluster, RMNoise, BCL overlay, compass) are set up separately below.

```bash
# 1. Install build dependencies
sudo apt install libonion-dev libbsd-dev

# 2. Clone this fork and the required build headers
git clone https://github.com/HB9VQQ/ka9q-web ~/ka9q-web
git clone https://github.com/scottnewell/ka9q-radio ~/ka9q-radio-scottnewell
ln -s ~/ka9q-radio-scottnewell ~/ka9q-radio

# 3. Build
cd ~/ka9q-web
make

# 4. Back up the existing binary (in case you need to roll back)
sudo cp /usr/local/sbin/ka9q-web /usr/local/sbin/ka9q-web.stock
sudo cp -r /usr/local/share/ka9q-web/html /usr/local/share/ka9q-web/html.stock

# 5. Install (replaces both the binary and all HTML/JS files)
sudo make install

# 6. Restart ka9q-web
kill $(pgrep -f "ka9q-web")
# wsprdaemon or systemd will respawn it automatically
```

To roll back to the stock binary at any time:

```bash
sudo cp /usr/local/sbin/ka9q-web.stock /usr/local/sbin/ka9q-web
sudo cp /usr/local/share/ka9q-web/html.stock/* /usr/local/share/ka9q-web/html/
kill $(pgrep -f "ka9q-web")
```

> **What this replaces:** `sudo make install` overwrites `/usr/local/sbin/ka9q-web` (the binary) and everything in `/usr/local/share/ka9q-web/html/` (the UI). The stock scottnewell or wa2n-code binary is replaced. The running radiod is not affected.

> **Why two ka9q-radio repos?** The running radiod (from [ka9q/ka9q-radio](https://github.com/ka9q/ka9q-radio) or wsprdaemon's managed copy) uses newer headers that are incompatible with the upstream scottnewell `ka9q-web.c`. The [scottnewell/ka9q-radio](https://github.com/scottnewell/ka9q-radio) fork has the matching headers. The compiled binary works correctly with any radiod version — the TLV status protocol is backward-compatible.

### wsprdaemon integration

If you run [wsprdaemon](https://github.com/rrobinett/wsprdaemon), it manages its own copy of ka9q-web and will overwrite your fork on restart unless you prevent it.

**Comment out these lines** in `wsprdaemon.conf`:

```bash
# KA9Q_WEB_GIT_URL="https://github.com/HB9VQQ/ka9q-web"
# KA9Q_WEB_COMMIT="..."
```

With both lines commented out, WD will still respawn the ka9q-web process if it dies, but won't try to clone, build, or replace the binary.

If WD has multiple radiod instances, you may also need:

```bash
KA9Q_WEB_DNS="hf_0-status.local"     # tells ka9q-web which radiod to connect to
```

### Customizing for your station

Several files contain HB9VQQ-specific URLs and settings. Edit these for your own station:

**`html/station-config.js`** — antenna names, port assignments, rotator URL:

```javascript
ports: {
    8081: { name: 'My omni antenna', type: 'omni' },
    8082: { name: 'My beam', type: 'directional',
            rotatorUrl: 'http://192.168.1.x/PstRotatorAz.htm' }
}
```

**`html/hb9vqq-init.js`** — solar indices bar data source URL (defaults to `dxmap.hb9vqq.ch`). If you don't have your own solar data endpoint, the bar will show but with no data.

**`dx-cluster-bridge.service`** — DX cluster host, your callsign, ports:

```ini
ExecStart=/usr/local/bin/dx-cluster-bridge.py \
    --cluster-host your-cluster.example.com \
    --callsign YOURCALL \
    --cluster-port 7300 \
    --ws-port 9373 \
    --max-age 30
```

### Prerequisites

* **[ka9q-radio](https://github.com/ka9q/ka9q-radio)** radiod must be installed and running
* **[scottnewell/ka9q-radio](https://github.com/scottnewell/ka9q-radio)** — build headers (cloned during Quick Start)
* **libonion-dev**, **libbsd-dev** — C build dependencies
* Python 3.10+ (for optional services): `sudo apt install python3-websockets python3-aiohttp`
* nginx + certbot (only needed for RMNoise HTTPS AudioWorklet path)

### Files

| File | Location |
| --- | --- |
| `ka9q-web.c` | compiled → `/usr/local/sbin/ka9q-web` |
| `html/radio.html` | `/usr/local/share/ka9q-web/html/` |
| `html/radio.js` | `/usr/local/share/ka9q-web/html/` |
| `html/spectrum.js` | `/usr/local/share/ka9q-web/html/` |
| `html/compass.js` | `/usr/local/share/ka9q-web/html/` |
| `html/station-config.js` | `/usr/local/share/ka9q-web/html/` |
| `html/rmnoise.js` | `/usr/local/share/ka9q-web/html/` |
| `html/ka9q-rmnoise-worklet.js` | `/usr/local/share/ka9q-web/html/` |
| `html/pcm-player.js` | `/usr/local/share/ka9q-web/html/` |
| `html/hb9vqq-ui.js` | `/usr/local/share/ka9q-web/html/` |
| `html/hb9vqq-init.js` | `/usr/local/share/ka9q-web/html/` |
| `html/dx-cluster.js` | `/usr/local/share/ka9q-web/html/` |
| `html/bcl-overlay.js` | `/usr/local/share/ka9q-web/html/` |
| `dx-cluster-bridge.py` | `/usr/local/bin/` |
| `dx-cluster-bridge.service` | `/etc/systemd/system/` |
| `rmnoise-proxy.py` | `/usr/local/bin/` |
| `rmnoise-proxy.service` | `/etc/systemd/system/` |
| `rotator-proxy.py` | `/usr/local/bin/` |
| `rotator-proxy.service` | `/etc/systemd/system/` |
| `nginx/rx888.conf` | `/etc/nginx/sites-available/` |

### Updating after initial install

After the initial build, HTML/JS-only changes (most updates) can be deployed without restarting:

```bash
cd ~/ka9q-web
git pull
sudo cp html/* /usr/local/share/ka9q-web/html/
```

If `ka9q-web.c` changed, rebuild and restart:

```bash
cd ~/ka9q-web
git pull
rm -f ka9q-web.o ka9q-web
make
sudo make install
kill $(pgrep -f "ka9q-web")
```

### Optional: Compass / rotator proxy

```bash
sudo cp rotator-proxy.py /usr/local/bin/
sudo cp rotator-proxy.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now rotator-proxy
```

Then patch nginx to proxy the rotator API:

```bash
sudo python3 patch_nginx_rotator.py
sudo nginx -t && sudo systemctl reload nginx
```

### Optional: RMNoise AI denoising

RMNoise requires HTTPS. Set up nginx as a reverse proxy with Let's Encrypt:

```bash
sudo apt install certbot python3-certbot-dns-cloudflare python3-aiohttp
sudo cp nginx/rx888.conf /etc/nginx/sites-available/
sudo ln -s /etc/nginx/sites-available/rx888.conf /etc/nginx/sites-enabled/
sudo systemctl reload nginx
sudo cp rmnoise-proxy.py /usr/local/bin/
sudo cp rmnoise-proxy.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now rmnoise-proxy
```

Users must have their own [rmnoise.com](https://rmnoise.com/users2/register) account.

### Optional: BCL station database

```bash
sudo cp bcl_to_json.py /usr/local/bin/
sudo python3 /usr/local/bin/bcl_to_json.py
echo '[]' | sudo tee /usr/local/share/ka9q-web/html/bcl_local.json
echo '0 3 29 3  * root python3 /usr/local/bin/bcl_to_json.py
0 3 29 10 * root python3 /usr/local/bin/bcl_to_json.py' | sudo tee /etc/cron.d/eibi-update
```

### Optional: DX cluster bridge

```bash
sudo cp dx-cluster-bridge.py /usr/local/bin/
sudo chmod +x /usr/local/bin/dx-cluster-bridge.py
sudo cp dx-cluster-bridge.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now dx-cluster-bridge
sudo ufw allow 9373/tcp comment "DX cluster WS bridge"
```

---

## Known issues / TODO

* GitHub Actions CI not yet configured for this fork
* BCL overlay: scheduled filtering uses EiBi data only — AOKI-only entries hidden when filter is active
