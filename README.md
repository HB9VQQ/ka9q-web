# ka9q-web — HB9VQQ Fork

**Fork by:** Roland, HB9VQQ  
**Upstream:** https://github.com/scottnewell/ka9q-web  
**Live instances:** https://rx888.hb9vqq.ch:8081 · https://rx888.hb9vqq.ch:8082

---

## What's new in this fork

### RMNoise AI Denoising (`rmnoise.js`, `ka9q-rmnoise-worklet.js`)

* **AI-powered noise reduction** via [rmnoise.com](https://rmnoise.com) — requires a free rmnoise.com account
* Integrated natively into the ka9q-web UI — no OS audio routing or browser extensions required
* Floating draggable modal: credentials, AI filter model selector, mix slider (0–100%), bypass button, statistics, log
* **Mix slider** — blend from 0% (original) to 100% (fully denoised) with no echo at any value
* **AudioWorklet path** (HTTPS) — echo-free blend via frame-number keyed pairing and AI lookahead delay compensation (38.75 ms)
* **JS fallback path** (HTTP) — full blend functionality on plain HTTP connections
* **Auto-bypass** — automatically bypasses when switching to AM/FM/NFM (unsupported modes); resumes on return to SSB/CW
* **3 kHz send-path LPF** — removes SDR noise above voice band before AI processing, preventing aliasing artifacts
* Requires HTTPS for AudioWorklet (nginx + Let's Encrypt setup documented below)

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

### Spectrum fixes (`spectrum.js`)

* dBm axis labels corrected
* CSS pixel fix for click-to-tune on non-integer DPR displays
* Firefox black waterfall fix (colormap guards + canvas clientHeight)

### radio.js patches

* `-n` argument underscores display as spaces in heading and tab title
* NaN guards for increment/step on missing localStorage key
* Band dropdown correctly repopulated on page reload
* Filter edge save/restore across reloads

---

## Deployment

### Requirements

* **[ka9q-radio](https://github.com/ka9q/ka9q-radio)** — must be installed and running
* Python 3.10+: `sudo apt install python3-websockets python3-aiohttp`
* nginx + certbot for HTTPS (required for RMNoise AudioWorklet path)

### Files

| File | Location |
| --- | --- |
| `html/radio.html` | `/usr/local/share/ka9q-web/html/` |
| `html/radio.js` | `/usr/local/share/ka9q-web/html/` |
| `html/rmnoise.js` | `/usr/local/share/ka9q-web/html/` |
| `html/ka9q-rmnoise-worklet.js` | `/usr/local/share/ka9q-web/html/` |
| `html/pcm-player.js` | `/usr/local/share/ka9q-web/html/` |
| `html/hb9vqq-ui.js` | `/usr/local/share/ka9q-web/html/` |
| `html/hb9vqq-init.js` | `/usr/local/share/ka9q-web/html/` |
| `html/dx-cluster.js` | `/usr/local/share/ka9q-web/html/` |
| `html/bcl-overlay.js` | `/usr/local/share/ka9q-web/html/` |
| `html/spectrum.js` | `/usr/local/share/ka9q-web/html/` |
| `dx-cluster-bridge.py` | `/usr/local/bin/` |
| `dx-cluster-bridge.service` | `/etc/systemd/system/` |
| `rmnoise-proxy.py` | `/usr/local/bin/` |
| `rmnoise-proxy.service` | `/etc/systemd/system/` |
| `nginx/rx888.conf` | `/etc/nginx/sites-available/` |

### Deploying HTML files

```bash
sudo cp html/* /usr/local/share/ka9q-web/html/
sudo kill -HUP $(pgrep -f "ka9q-web")
```

### RMNoise setup (optional)

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

### BCL station database setup

```bash
sudo cp bcl_to_json.py /usr/local/bin/
sudo python3 /usr/local/bin/bcl_to_json.py
echo '[]' | sudo tee /usr/local/share/ka9q-web/html/bcl_local.json
echo '0 3 29 3  * root python3 /usr/local/bin/bcl_to_json.py
0 3 29 10 * root python3 /usr/local/bin/bcl_to_json.py' | sudo tee /etc/cron.d/eibi-update
```

### Bridge service

```bash
sudo cp dx-cluster-bridge.py /usr/local/bin/
sudo chmod +x /usr/local/bin/dx-cluster-bridge.py
sudo cp dx-cluster-bridge.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now dx-cluster-bridge
sudo ufw allow 9373/tcp comment "DX cluster WS bridge"
```

Edit `dx-cluster-bridge.service` and set your values:

```ini
ExecStart=/usr/local/bin/dx-cluster-bridge.py \
    --cluster-host your-cluster.example.com \
    --callsign N0CALL \
    --cluster-port 7300 \
    --ws-port 9373 \
    --max-age 30
```

---

## Known issues / TODO

* GitHub Actions CI not yet configured for this fork
* BCL overlay: scheduled filtering uses EiBi data only — AOKI-only entries hidden when filter is active

