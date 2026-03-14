# ka9q-web — HB9VQQ Fork

**Fork by:** Roland, HB9VQQ  
**Upstream:** https://github.com/scottnewell/ka9q-web  
**Live instances:** http://rx888.hb9vqq.ch:8081 · http://rx888.hb9vqq.ch:8082

---

## What's new in this fork

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
* **Local overrides** (`bcl_local.json`) — for stations missing from both databases (e.g. Radio Caroline 1395 kHz)
* **User-selectable database** via Options dialog: EiBi only / AOKI only / merged
* **Twice-yearly cron update** via `bcl_to_json.py`
* **On-air filter** — "Now on air only" checkbox in Options dialog hides stations not currently broadcasting according to EiBi schedule data

### DX cluster spot overlay (`dx-cluster.js`)

* Live DX cluster spots overlaid on the spectrum as vertical dashed lines
* Callsign labels with ◇ prefix, color-coded by mode:
  + CW: cyan · SSB: yellow · FT8/FT4: magenta · RTTY: orange
* Age fade over configurable window (default 30 min)
* Row staggering for overlapping spots
* Downward arrow at spectrum/waterfall boundary
* Click-to-tune on spot frequency
* Mode filter (ALL / CW / SSB / FT8 / FT4 / RTTY)
* Spotter region filter (ALL / EU / NA / SA / AS / AF / OC)
* Spot count display
* Reconnecting WebSocket with exponential backoff

### DX cluster bridge (`dx-cluster-bridge.py`)

* Python asyncio bridge: DX Spider telnet → WebSocket JSON
* Connects to configurable DX cluster
* Serves spots as JSON on ws://host:9373
* In-memory spot cache with age pruning
* FT8/FT4 mode inference from frequency windows
* Systemd service included (`dx-cluster-bridge.service`)

### Spectrum fixes (`spectrum.js`)

* dBm axis labels corrected (negative sign)
* CSS pixel fix for click-to-tune on non-integer DPR displays

### radio.js patches

* `-n` argument underscores display as spaces in heading and tab title
* NaN guards for increment/step on missing localStorage key
* Band dropdown correctly repopulated on page reload

---

## Deployment

### Requirements

* **[ka9q-radio](https://github.com/ka9q/ka9q-radio)** — must be installed and running.
  This fork is a pure HTML/JS frontend with no standalone function without a ka9q-radio backend.
  Install and configure ka9q-radio first, then deploy these files into its HTML directory.
* Python 3.10+: `sudo apt install python3-websockets`
* All other dependencies unchanged from upstream

### Files

| File | Location |
| --- | --- |
| `html/radio.html` | `/usr/local/share/ka9q-web/html/` |
| `html/radio.js` | `/usr/local/share/ka9q-web/html/` |
| `html/hb9vqq-ui.js` | `/usr/local/share/ka9q-web/html/` |
| `html/hb9vqq-init.js` | `/usr/local/share/ka9q-web/html/` |
| `html/dx-cluster.js` | `/usr/local/share/ka9q-web/html/` |
| `html/bcl-overlay.js` | `/usr/local/share/ka9q-web/html/` |
| `html/optionsDialog.html` | `/usr/local/share/ka9q-web/html/` |
| `html/spectrum.js` | `/usr/local/share/ka9q-web/html/` |
| `dx-cluster-bridge.py` | `/usr/local/bin/` |
| `dx-cluster-bridge.service` | `/etc/systemd/system/` |

### Server-side files (not in repo — generated)

| File | Description |
| --- | --- |
| `/usr/local/bin/bcl_to_json.py` | Converts EiBi + AOKI schedules to JSON |
| `/usr/local/share/ka9q-web/html/bcl_stations.json` | Merged station database (~6700 entries) |
| `/usr/local/share/ka9q-web/html/bcl_eibi.json` | EiBi-only database |
| `/usr/local/share/ka9q-web/html/bcl_aoki.json` | AOKI-only database |
| `/usr/local/share/ka9q-web/html/bcl_local.json` | Manual station overrides |
| `/etc/cron.d/eibi-update` | Cron job for twice-yearly database update |

### Deploying HTML files

ka9q-web has a built-in HTTP server. Replacing open files without signalling it causes the
process to hang silently. Always `kill -HUP` after copying:

```bash
sudo cp html/* /usr/local/share/ka9q-web/html/
sudo kill -HUP $(pgrep -f "ka9q-web")
```

### BCL station database setup

Generate the station database after deploying `bcl_to_json.py`:

```bash
sudo cp bcl_to_json.py /usr/local/bin/
sudo python3 /usr/local/bin/bcl_to_json.py
# → downloads EiBi + AOKI, writes bcl_stations.json (~550 KB), bcl_eibi.json, bcl_aoki.json
# → bcl_stations.json includes EiBi schedule data for on-air filtering
```

Create a local overrides file for stations missing from both databases:

```bash
echo '[]' | sudo tee /usr/local/share/ka9q-web/html/bcl_local.json
```

Set up twice-yearly cron updates (after season changes, last Sunday of March/October):

```bash
echo '0 3 29 3  * root python3 /usr/local/bin/bcl_to_json.py
0 3 29 10 * root python3 /usr/local/bin/bcl_to_json.py' | sudo tee /etc/cron.d/eibi-update
```

### Bridge service

Browsers cannot make raw TCP connections — they speak only HTTP and WebSocket. DX Spider
clusters use a plain telnet protocol (port 7300). `dx-cluster-bridge.py` sits between the
two: it connects to your DX cluster via telnet, parses incoming spot lines into JSON, and
re-serves them as a WebSocket stream on port 9373 that `dx-cluster.js` in the browser
consumes to draw spots on the waterfall. Without it, the DX overlay has no data source.

```bash
sudo cp dx-cluster-bridge.py /usr/local/bin/
sudo chmod +x /usr/local/bin/dx-cluster-bridge.py
sudo cp dx-cluster-bridge.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now dx-cluster-bridge
sudo ufw allow 9373/tcp comment "DX cluster WS bridge"
```

### Bridge options

Edit `dx-cluster-bridge.service` before deploying and set your values on the `ExecStart` line:

```ini
ExecStart=/usr/local/bin/dx-cluster-bridge.py \
    --cluster-host your-cluster.example.com \
    --callsign N0CALL \
    --cluster-port 7300 \
    --ws-port 9373 \
    --max-age 30
```

| Option | Description | Default |
| --- | --- | --- |
| `--cluster-host` | DX Spider telnet hostname | required |
| `--cluster-port` | DX Spider telnet port | 7300 |
| `--callsign` | Login callsign | required |
| `--ws-port` | WebSocket port served to browser | 9373 |
| `--max-age` | Spot cache age in minutes | 30 |

---

## Known issues / TODO

* Cosmetic polish on controls strip
* GitHub Actions CI not yet configured for this fork
* BCL overlay: scheduled filtering uses EiBi data only — AOKI-only entries hidden when filter is active
