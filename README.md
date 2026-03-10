# ka9q-web — HB9VQQ Fork

**Fork by:** Roland, HB9VQQ  
**Upstream:** https://github.com/scottnewell/ka9q-web  
**Live instances:** http://rx888.hb9vqq.ch:8081 · http://rx888.hb9vqq.ch:8082

---

## What's new in this fork

### Dark theme UI (`radio.html`)

* Full dark theme with teal/amber/violet accent colors and scanline texture
* Solar indices bar: SFI, Kp, SWS, DRAP — live data from dxmap.hb9vqq.ch, updated every 5 minutes
* UTC clock in header
* Band selector with Amateur / Broadcast / Utility categories
* Mode auto-switching by frequency (LSB below 10 MHz, USB above)
* Resizable spectrum/waterfall with live DX overlay tracking
* **Passband drag** — drag the grey passband bar to retune frequency
* **Click-to-tune on DX spots** — click any callsign label to tune to that frequency
* Keyboard shortcuts — frequency tuning and fullscreen toggle
* Settings persistence — band, mode, frequency, DX filters and spectrum position survive page reload

### Audio (`pcm-player.js`)

* **Working pan slider** — stereo panning now actually works
* **Recording** — record received audio to a .webm file with one click; button flashes red while recording

### Analog S-meter (`smeter.js`)

* Green vintage style: radial gradient background, bezel ring, minor tick marks
* Gradient needle with drop shadow and pivot circle
* **Digital LCD mode** — toggle between analog gauge and digital S-unit display
* Mode toggle buttons (∿ / ▤) in the S-meter title bar, persisted in localStorage
* EMA smoothing on both analog and digital modes

### DX cluster spot overlay (`dx-cluster.js`)

* Live DX cluster spots overlaid on the spectrum as vertical dashed lines
* Callsign labels with ◇ prefix, color-coded by mode:
  * CW: cyan · SSB: yellow · FT8/FT4: magenta · RTTY: orange
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
* Connects to configurable DX cluster (default: dxcluster.hb9vqq.ch:7300)
* Serves spots as JSON on ws://host:9373
* In-memory spot cache with age pruning
* FT8/FT4 mode inference from frequency windows
* Systemd service included (`dx-cluster-bridge.service`)

### Spectrum (`spectrum.js`)

* Spectrum overlay traces — load and display reference spectrum traces over the live display
* Click-to-tune suppression so DX spot clicks are not overridden by the spectrum pan handler

### radio.js patches

* `-n` argument underscores display as spaces in heading and tab title



---

## Deployment

### Requirements

* Python 3.10+: `sudo apt install python3-websockets`
* All other dependencies unchanged from upstream

### Files

| File | Location |
|---|---|
| `html/radio.html` | `/usr/local/share/ka9q-web/html/` |
| `html/radio.js` | `/usr/local/share/ka9q-web/html/` |
| `html/dx-cluster.js` | `/usr/local/share/ka9q-web/html/` |
| `html/smeter.js` | `/usr/local/share/ka9q-web/html/` |
| `html/spectrum.js` | `/usr/local/share/ka9q-web/html/` |
| `dx-cluster-bridge.py` | `/usr/local/bin/` |
| `dx-cluster-bridge.service` | `/etc/systemd/system/` |

### Bridge service
```
sudo cp dx-cluster-bridge.py /usr/local/bin/
sudo chmod +x /usr/local/bin/dx-cluster-bridge.py
sudo cp dx-cluster-bridge.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now dx-cluster-bridge
sudo ufw allow 9373/tcp comment "DX cluster WS bridge"
```

### Bridge options
```
--cluster-host   DX Spider hostname  (required — no default)
--cluster-port   DX Spider port      (default: 7300)
--callsign       Login callsign      (required — set to your own callsign)
--ws-port        WebSocket port      (default: 9373)
--max-age        Spot max age (min)  (default: 30)
```

---

## Customisation — what to change for your own deployment

This fork contains references to HB9VQQ's specific infrastructure. Before deploying
on your own station, change the following:

| File | What to change |
|---|---|
| `dx-cluster-bridge.service` | `--cluster-host` → your DX cluster hostname<br>`--callsign` → your own callsign (e.g. `W1AW-6`) |
| `html/hb9vqq-init.js` | Line ~44: WebSocket URL `wss://dxmap.hb9vqq.ch/dx-ws` → `ws://YOUR-SERVER-IP:9373`<br>Line ~124: same fallback URL<br>Line ~266: `https://dxmap.hb9vqq.ch/data/eu_v4.json` → your own region data endpoint, or remove the spotter region filter |
| `html/radio.html` | `<title>` tag and footer text — replace `HB9VQQ` with your callsign |

> **Note:** The solar indices bar in the header fetches live data from `wspr.hb9vqq.ch`.
> You can leave this as-is (it is a public API) or point it at your own source.

---

## Known issues / TODO
