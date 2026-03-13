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
* Mode auto-switching by frequency (LSB below 10 MHz, USB above)
* Improved Options dialog styling and positioning
* Frequency input Enter-to-tune support
* Resizable spectrum/waterfall with live DX overlay tracking

### DX cluster spot overlay (`dx-cluster.js`)

* Live DX cluster spots overlaid on the spectrum as vertical dashed lines
* Callsign labels with ◇ prefix, color-coded by mode:
  + CW: cyan · SSB: yellow · FT8/FT4: magenta · RTTY: orange
* Age fade over configurable window (default 30 min)
* Row staggering for overlapping spots
* Downward arrow at spectrum/waterfall boundary
* Click-to-tune on spot frequency
* Mode filter (ALL / CW / SSB / FT8 / FT4 / RTTY)
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

### radio.js patches

* `-n` argument underscores display as spaces in heading and tab title

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
| `html/dx-cluster.js` | `/usr/local/share/ka9q-web/html/` |
| `html/spectrum.js` | `/usr/local/share/ka9q-web/html/` |
| `dx-cluster-bridge.py` | `/usr/local/bin/` |
| `dx-cluster-bridge.service` | `/etc/systemd/system/` |

### Deploying HTML files

ka9q-web has a built-in HTTP server. Replacing open files without signalling it causes the
process to hang silently. Always `kill -HUP` after copying:

```bash
sudo cp html/* /usr/local/share/ka9q-web/html/
sudo kill -HUP $(pgrep -f "ka9q-web")
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

### Bridge options

```
--cluster-host   DX Spider hostname  (required — your DX cluster)
--cluster-port   DX Spider port      (default: 7300)
--callsign       Login callsign      (required — your callsign)
--ws-port        WebSocket port      (default: 9373)
--max-age        Spot max age (min)  (default: 30)
```

---

## Known issues / TODO

* Cosmetic polish on controls strip
* GitHub Actions CI not yet configured for this fork
