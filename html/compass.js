// compass.js — HB9VQQ fork
// Beam direction compass panel with simplified world map.
// Reads antenna config from STATION_CONFIG.ports[currentPort].
// Polls /api/rotator/ every 5s for directional antennas.
// Shows omnidirectional indicator for omni antennas.
// Hidden if port not in STATION_CONFIG.ports.

(function() {
'use strict';

// ── Config ────────────────────────────────────────────────────────────────────
const POLL_INTERVAL = 5000;  // ms
const API_URL       = '/api/rotator/';

// ── Math helpers ──────────────────────────────────────────────────────────────
function deg2rad(d) { return d * Math.PI / 180; }

// Simple equirectangular → compass canvas projection
// Map center: QTH lon/lat. Scale: pixels per degree.
function project(lon, lat, cx, cy, scale) {
  const qLon = 8.8, qLat = 47.2;
  const x = cx + (lon - qLon) * scale * Math.cos(deg2rad(qLat));
  const y = cy - (lat - qLat) * scale;
  return [x, y];
}


// ── Build panel HTML ──────────────────────────────────────────────────────────
function buildPanel(portConfig) {
  const panel = document.createElement('div');
  panel.id = 'compass-panel';
  panel.style.cssText = [
    'position:fixed',
    'top:80px',
    'left:20px',
    'width:120px',
    'background:#1a1a2e',
    'border:1px solid #00bcd4',
    'border-radius:8px',
    'z-index:900',
    'font-family:Arial,sans-serif',
    'font-size:12px',
    'color:#e0e0e0',
    'user-select:none',
    'display:none',
  ].join(';');

  const antName = portConfig ? portConfig.name : 'Antenna';
  const isOmni  = !portConfig || portConfig.type === 'omni';

  panel.innerHTML = `
    <div id="compass-titlebar" style="
      background:#111130;border-radius:8px 8px 0 0;
      padding:6px 10px;cursor:move;
      display:flex;justify-content:space-between;align-items:center;
      border-bottom:1px solid #00bcd4">
      <span style="font-size:11px;font-weight:bold;color:#00bcd4">
        &#9776; ${antName}</span>
      <span id="compass-close" style="cursor:pointer;color:#888;font-size:14px">&#x2715;</span>
    </div>
    <div style="padding:8px">
      <canvas id="compass-canvas" width="100" height="100"
        style="display:block;margin:0 auto;border-radius:50%"></canvas>
      <div id="compass-readout" style="
        text-align:center;margin-top:6px;font-size:16px;
        font-weight:bold;letter-spacing:2px;color:#e0e0e0">
        ${isOmni ? 'OMNI' : '---°'}
      </div>
      <div id="compass-status" style="
        text-align:center;font-size:10px;color:#557755;margin-top:2px">
        ${isOmni ? 'Omnidirectional' : 'Waiting...'}
      </div>
    </div>`;

  return panel;
}

// ── Draw compass canvas ──────────────────────────────────────────────────────
function drawCompass(canvas, azimuth, isOmni) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const cx = W / 2, cy = H / 2;
  const R = Math.min(W, H) / 2 - 6;

  ctx.clearRect(0, 0, W, H);

  // Background
  const bg = ctx.createRadialGradient(cx, cy, 0, cx, cy, R);
  bg.addColorStop(0, '#0d1b2a');
  bg.addColorStop(1, '#060b12');
  ctx.beginPath();
  ctx.arc(cx, cy, R + 4, 0, Math.PI * 2);
  ctx.fillStyle = bg;
  ctx.fill();

  // Outer ring
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.strokeStyle = '#1e3a5a';
  ctx.lineWidth = 2;
  ctx.stroke();

  // Tick marks every 10°
  for (let a = 0; a < 360; a += 10) {
    const rad = (a - 90) * Math.PI / 180;
    const isCard = a % 90 === 0;
    const isInterCard = a % 45 === 0;
    const len = isCard ? 10 : isInterCard ? 7 : 4;
    ctx.beginPath();
    ctx.moveTo(cx + R * Math.cos(rad), cy + R * Math.sin(rad));
    ctx.lineTo(cx + (R - len) * Math.cos(rad), cy + (R - len) * Math.sin(rad));
    ctx.strokeStyle = isCard ? '#00bcd4' : 'rgba(0,188,212,0.4)';
    ctx.lineWidth = isCard ? 1.5 : 0.8;
    ctx.stroke();
  }

  // Cardinal labels
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const lblR = R - 16;
  [['N', 0, '#ff4444'], ['E', 90, '#00bcd4'], ['S', 180, '#00bcd4'], ['W', 270, '#00bcd4']].forEach(([lbl, a, col]) => {
    const rad = (a - 90) * Math.PI / 180;
    ctx.font = 'bold ' + Math.max(9, Math.round(R * 0.18)) + 'px "Chakra Petch",Arial,sans-serif';
    ctx.fillStyle = col;
    ctx.fillText(lbl, cx + lblR * Math.cos(rad), cy + lblR * Math.sin(rad));
  });

  // Inner ring
  ctx.beginPath();
  ctx.arc(cx, cy, R * 0.45, 0, Math.PI * 2);
  ctx.strokeStyle = '#1e3a5a';
  ctx.lineWidth = 0.5;
  ctx.stroke();

  // QTH dot
  ctx.beginPath();
  ctx.arc(cx, cy, 4, 0, Math.PI * 2);
  ctx.fillStyle = '#ff4444';
  ctx.fill();

  if (isOmni) {
    ctx.beginPath();
    ctx.arc(cx, cy, R * 0.55, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,200,0,0.5)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 4]);
    ctx.stroke();
    ctx.setLineDash([]);
    return;
  }

  if (azimuth === null || azimuth === undefined) return;

  const bRad = (azimuth - 90) * Math.PI / 180;
  const beamR = R - 6;

  // Beam cone ±15°
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.arc(cx, cy, beamR, (azimuth - 15 - 90) * Math.PI / 180, (azimuth + 15 - 90) * Math.PI / 180);
  ctx.closePath();
  ctx.fillStyle = 'rgba(0,188,212,0.1)';
  ctx.fill();

  // Beam line
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx + beamR * Math.cos(bRad), cy + beamR * Math.sin(bRad));
  ctx.strokeStyle = '#00bcd4';
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.stroke();

  // Arrowhead
  const tipX = cx + beamR * Math.cos(bRad);
  const tipY = cy + beamR * Math.sin(bRad);
  const al = 10, aw = Math.PI / 7;
  ctx.beginPath();
  ctx.moveTo(tipX, tipY);
  ctx.lineTo(tipX - al * Math.cos(bRad - aw), tipY - al * Math.sin(bRad - aw));
  ctx.lineTo(tipX - al * Math.cos(bRad + aw), tipY - al * Math.sin(bRad + aw));
  ctx.closePath();
  ctx.fillStyle = '#00bcd4';
  ctx.fill();

  // Pivot
  ctx.beginPath();
  ctx.arc(cx, cy, 5, 0, Math.PI * 2);
  ctx.fillStyle = '#0d1b2a';
  ctx.fill();
  ctx.strokeStyle = '#00bcd4';
  ctx.lineWidth = 1;
  ctx.stroke();
}

// ── Drag support ──────────────────────────────────────────────────────────────
function makeDraggable(panel, handle) {
  let x0 = 0, y0 = 0;
  handle.addEventListener('mousedown', e => {
    e.preventDefault();
    x0 = e.clientX; y0 = e.clientY;
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
  function onMove(e) {
    const dx = e.clientX - x0, dy = e.clientY - y0;
    x0 = e.clientX; y0 = e.clientY;
    const rect = panel.getBoundingClientRect();
    panel.style.left   = (rect.left + dx) + 'px';
    panel.style.top    = (rect.top  + dy) + 'px';
    panel.style.right  = 'auto';
    panel.style.bottom = 'auto';
  }
  function onUp() {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
  }
}

// ── Poll ──────────────────────────────────────────────────────────────────────
function startPolling(canvas, readout, status) {
  function poll() {
    fetch(API_URL)
      .then(r => r.json())
      .then(d => {
        if (d.ok && d.azimuth !== null) {
          drawCompass(canvas, d.azimuth, false);
          readout.textContent = String(d.azimuth).padStart(3, '0') + '°';
          status.textContent  = '● Live';
          status.style.color  = '#28a745';
        } else {
          readout.textContent = '---°';
          status.textContent  = '⚠ ' + (d.error || 'No data');
          status.style.color  = '#dc3545';
        }
      })
      .catch(e => {
        status.textContent = '⚠ ' + e.message;
        status.style.color = '#dc3545';
      });
  }
  poll();
  return setInterval(poll, POLL_INTERVAL);
}

// ── Init ──────────────────────────────────────────────────────────────────────
function init() {
  // Determine current port
  const port = parseInt(window.location.port) || 80;
  const cfg  = (typeof STATION_CONFIG !== 'undefined') ? STATION_CONFIG : window.STATION_CONFIG;
  const portCfg = cfg && cfg.ports && (cfg.ports[port] || cfg.ports[String(port)]);

  // If port not in config — no compass button
  if (!portCfg) return;

  const isOmni = portCfg.type === 'omni';

  // Use existing button from HTML, or create one dynamically as fallback
  let btn = document.getElementById('compass-btn');
  if (!btn) {
    btn = document.createElement('button');
    btn.id        = 'compass-btn';
    btn.className = 'cbtn';
    btn.title     = 'Beam direction compass';
    btn.innerHTML = '&#9737; Beam';
    btn.style.cssText = 'background:#2d5a27;padding:3px 8px';
    const recBtn = document.getElementById('toggleRecording');
    const ctrlStrip = document.getElementById('ctrl-strip');
    if (recBtn) recBtn.parentElement.insertBefore(btn, recBtn.nextSibling);
    else if (ctrlStrip) ctrlStrip.appendChild(btn);
    else document.body.appendChild(btn);
  }
  // Hide on omni ports
  if (isOmni) btn.style.display = 'none';

  // Panel
  const panel = buildPanel(portCfg);
  document.body.appendChild(panel);

  const canvas  = panel.querySelector('#compass-canvas');
  const readout = panel.querySelector('#compass-readout');
  const status  = panel.querySelector('#compass-status');
  const titlebar = panel.querySelector('#compass-titlebar');
  const closeBtn = panel.querySelector('#compass-close');

  makeDraggable(panel, titlebar);

  let pollTimer = null;
  let currentAz = null;

  // Show on first load (hidden only if user explicitly closed it)
  if (localStorage.getItem('compassVisible') !== '0') {
    panel.style.display = 'block';
    if (isOmni) drawCompass(canvas, null, true);
    else pollTimer = startPolling(canvas, readout, status, az => { currentAz = az; });
  }

  btn.addEventListener('click', () => {
    const visible = panel.style.display !== 'none';
    if (visible) {
      panel.style.display = 'none';
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    } else {
      panel.style.display = 'block';
      if (isOmni) {
        drawCompass(canvas, null, true);
      } else {
        pollTimer = startPolling(canvas, readout, status);
      }
    }
  });

  closeBtn.addEventListener('click', () => {
    panel.style.display = 'none';
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  });
}

// Run after DOM ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

})();
