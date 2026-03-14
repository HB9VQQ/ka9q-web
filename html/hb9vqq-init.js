// hb9vqq-init.js — HB9VQQ fork custom initialisation
// Extracted from radio.html. Loaded after dx-cluster.js.
// Do NOT merge this file with upstream radio.html.

// ════════════════════════════════════════════════════
// // ── DX Cluster initialisation ──
// ════════════════════════════════════════════════════

// ── DX Cluster initialisation ──────────────────────────────────────────────
// dxCanvas declared at outer scope so syncOverlaySize() is accessible from
// the window resize listener and wf-resizer mouseup handler.
let dxCanvas;

function syncOverlaySize() {
  if (!dxCanvas || typeof spectrum === 'undefined') return;
  const dpr = window.devicePixelRatio || 1;
  const wfw = document.getElementById('wf-wrap');
  dxCanvas.width  = wfw.offsetWidth;
  dxCanvas.height = wfw.offsetHeight;

  dxCanvas.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0);
}

function setSolPill(label, value, cssClass) {
  document.querySelectorAll('.sol-pill').forEach(pill => {
    const lbl = pill.querySelector('.lbl');
    if (lbl && lbl.textContent.trim() === label) {
      const val = pill.querySelector('.val');
      if (val) { val.textContent = value; val.className = 'val ' + cssClass; }
    }
  });
}

// spectrum is created inside fetch('optionsDialog.html').then() → init() in radio.js.
// That fetch is async — DOMContentLoaded fires before it resolves, leaving spectrum
// undefined. Poll at 50 ms until spectrum exists before wiring up dx-cluster.
(function waitForSpectrum() {
  if (typeof spectrum === 'undefined' || spectrum === null) {
    setTimeout(waitForSpectrum, 50);
    return;
  }

  const dxCluster = new DXCluster(
    (document.querySelector('.bridge-inp') || {value: ''}).value || 'wss://dxmap.hb9vqq.ch/dx-ws',
    30
  );
  dxCanvas = document.getElementById('dx-overlay');
  const dxOverlay = new DXOverlay(dxCanvas, dxCluster, spectrum);
  window._dxOverlay = dxOverlay;

  dxCluster.onUpdate = () => dxOverlay.draw();
  const dxRegionSel = document.getElementById('dx-region-sel');
  if (dxRegionSel) dxRegionSel.addEventListener('change', () => {
    dxCluster.spotterRegion = dxRegionSel.value;
    dxOverlay.draw();
    if (typeof saveSettings === 'function') saveSettings();
  });
  dxCluster.connect();
  // Redraw every 60 s to age-fade spots even when no new spots arrive
  setInterval(() => dxOverlay.draw(), 60000);

  positionSpecResizer();  // position inner handle correctly on first load
  setInterval(positionSpecResizer, 500);  // keep in sync if spectrum changes
  syncOverlaySize();      // canvas defaults to 300×150 until explicitly sized

  // Resize observer: update overlay immediately when wf-wrap changes size
  const _wfWrapEl = document.getElementById('wf-wrap');
  if (_wfWrapEl && window.ResizeObserver) {
    new ResizeObserver(() => {
      syncOverlaySize();
      if (window._dxOverlay) window._dxOverlay.draw();
    }).observe(_wfWrapEl);
  }

  window.addEventListener('resize', () => {
    if (typeof spectrum !== 'undefined') spectrum.resize();
    syncOverlaySize();
  });

  // Span/centre change polling — spectrum.js fires no events; poll at 500 ms
  let lastStart = null, lastSpan = null;
  setInterval(() => {
    if (spectrum.start_freq !== lastStart || spectrum.spanHz !== lastSpan) {
      lastStart = spectrum.start_freq;
      lastSpan  = spectrum.spanHz;
      dxOverlay.draw();
    }
  }, 500);

  // Status indicator DOM refs
  const dxToggle = document.getElementById('dx-toggle');
  const dxDot    = document.getElementById('dx-dot');
  const dxStatus = document.getElementById('dx-status');

  // Wire DXCluster status → dx-dot / dx-status
  dxCluster.onStatus = (state) => {
    if (dxDot) {
      dxDot.classList.remove('connecting', 'off');
      if (state !== 'connected')
        dxDot.classList.add(state === 'reconnecting' ? 'connecting' : 'off');
    }
    if (dxStatus) dxStatus.textContent =
      state === 'connected'    ? 'Connected'     :
      state === 'reconnecting' ? 'Reconnecting…' : 'Error';
  };

  // DX toggle button
  if (dxToggle) dxToggle.addEventListener('click', () => {
    dxOverlay.enabled = !dxOverlay.enabled;
    dxToggle.classList.toggle('off', !dxOverlay.enabled);
    dxToggle.textContent = dxOverlay.enabled ? '◉ DX SPOTS' : '○ DX SPOTS';
    if (dxDot) {
      dxDot.classList.remove('connecting', 'off');
      if (!dxOverlay.enabled) dxDot.classList.add('off');
    }
    if (dxStatus) dxStatus.textContent = dxOverlay.enabled ? 'Connected' : 'Off';
    dxOverlay.draw();
  });

  // DX strip controls
  const ageSelect  = document.querySelector('.dxg .sel:nth-of-type(1)');
  const modeSelect = document.querySelector('.dxg .sel:nth-of-type(2)');
  const bridgeInp = document.querySelector('.bridge-inp');
  if (bridgeInp && !bridgeInp.value) bridgeInp.value = 'wss://dxmap.hb9vqq.ch/dx-ws';
  const applyBtn   = document.querySelector('.bridge-inp + .icon-btn');

  if (ageSelect) ageSelect.addEventListener('change', () => {
    dxCluster.maxAge = parseInt(ageSelect.value);
    dxCluster.purge();
    dxOverlay.draw();
  });
  if (modeSelect) modeSelect.addEventListener('change', () => {
    dxOverlay.modeFilter = modeSelect.value.toUpperCase();
    dxOverlay.draw();
    if (typeof saveSettings === 'function') saveSettings();
  });
  if (applyBtn) applyBtn.addEventListener('click', () => {
    const url = (document.querySelector('.bridge-inp') || {value: ''}).value;
    if (url) dxCluster.reconnect(url);
  });

  // Click-to-tune: suppress if pointer moved >4px (pan drag)
  let _tuneDownX = 0, _tuneDownY = 0, _tuneDragged = false;
  // ── HB9VQQ BEGIN: pointerdown: cancel restore + track drag start ──
  spectrum.canvas.addEventListener('pointerdown', e => {
    _tuneDownX = e.clientX; _tuneDownY = e.clientY; _tuneDragged = false;
    if (window._dxOverlay) window._dxOverlay._labelBoxes = [];
    window._restoreCenterPackets = 0;
  });
  // ── HB9VQQ END: pointerdown: cancel restore + track drag start ──

  // ── Filter bar drag ──
  (function() {
    let _filterDrag = null; // null | 'low' | 'high' | 'center'
    let _filterStartX = 0, _filterStartLow = 0, _filterStartHigh = 0, _filterStartFreq = 0;
    const EDGE_TOL = 8; // px hit tolerance for edges

    function getFilterXs() {
      const cssW = spectrum.canvas.getBoundingClientRect().width;
      const hzpp = spectrum.spanHz / cssW;
      const x0 = ((spectrum.frequency - spectrum.start_freq) + spectrum.filter_low) / hzpp;
      const x1 = ((spectrum.frequency - spectrum.start_freq) + spectrum.filter_high) / hzpp;
      return { x0, x1, hzpp };
    }

    spectrum.canvas.addEventListener('mousedown', function(e) {
      if (e.button !== 0) return;
      const specH = spectrum.spectrumHeight || (spectrum.canvas.height * (spectrum.spectrumPercent / 100));
      if (e.offsetY > specH) { _filterDrag = null; return; }
      const mx = e.offsetX;
      const { x0, x1, hzpp } = getFilterXs();
      const low  = parseFloat(document.getElementById('filterLowInput').value);
      const high = parseFloat(document.getElementById('filterHighInput').value);
      // Only capture center drag (not edges)
      if (mx < x0 + EDGE_TOL || mx > x1 - EDGE_TOL) {
        _filterDrag = null; return;
      }
      _filterDrag = 'center';
      _filterStartX = mx;
      _filterStartLow = low;
      _filterStartHigh = high;
      _filterStartFreq = spectrum.frequency;
      window._suppressSpectrumClick = true;
      e.stopImmediatePropagation();
    }, true); // capture phase — fires before spectrum.js

    window.addEventListener('mousemove', function(e) {
      if (!_filterDrag) return;
      const rect = spectrum.canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const cssW = rect.width;
      const hzpp = spectrum.spanHz / cssW;
      const dHz = (mx - _filterStartX) * hzpp;
      const lowEl  = document.getElementById('filterLowInput');
      const highEl = document.getElementById('filterHighInput');
      if (_filterDrag === 'center') {
        const newFreq = _filterStartFreq + dHz;
        const step = parseFloat(document.getElementById('step').value) || 100;
        const snapped = Math.round(newFreq / step) * step;
        const snapped_khz = snapped / 1000;
        document.getElementById('freq').value = snapped_khz.toFixed(3);
        spectrum.frequency = snapped;
        if (ws && ws.readyState === WebSocket.OPEN) ws.send('F:' + snapped_khz.toFixed(3));
      }
    });

    window.addEventListener('mouseup', function(e) {
      if (!_filterDrag) return;
      _filterDrag = null;
    });

    // Change cursor on hover over filter edges/center
    spectrum.canvas.addEventListener('mousemove', function(e) {
      if (_filterDrag) return;
      const specH = spectrum.spectrumHeight || (spectrum.canvas.height * (spectrum.spectrumPercent / 100));
      if (e.offsetY > specH) { spectrum.canvas.style.cursor = ''; return; }
      const mx = e.offsetX;
      const { x0, x1 } = getFilterXs();
      if (mx > x0 + EDGE_TOL && mx < x1 - EDGE_TOL) {
        spectrum.canvas.style.cursor = 'grab';
      } else {
        spectrum.canvas.style.cursor = '';
      }
    });
  })();
  spectrum.canvas.addEventListener('pointermove', e => {
    if (Math.abs(e.clientX - _tuneDownX) > 4 || Math.abs(e.clientY - _tuneDownY) > 4)
      _tuneDragged = true;
  });
  // ── HB9VQQ BEGIN: click-to-tune: DX spot click tunes radio ──
spectrum.canvas.addEventListener('click', e => {
    if (_tuneDragged) return;
    const rect   = spectrum.canvas.getBoundingClientRect();
    const x      = e.clientX - rect.left;
    const y      = e.clientY - rect.top;
    const freqHz = spectrum.start_freq + x * (spectrum.spanHz / rect.width);
    const spot   = (window._dxOverlay && window._dxOverlay.spotAtPoint(x, y)) || dxCluster.nearestSpot(freqHz, 2000);
    if (spot) {
      window._suppressSpectrumClick = true;
      const hz = spot.frequency * 1000;
      document.getElementById('freq').value = (hz / 1000).toFixed(3);
      ws.send('F:' + (hz / 1000).toFixed(3));
      spectrum.setFrequency(hz);
    }
  });
// ── HB9VQQ END: click-to-tune: DX spot click tunes radio ──

  dxCluster.connect();
  // Restore saved DX filter settings
  // ── HB9VQQ BEGIN: restore saved DX filter settings (region + mode) ──
const _savedRegion = localStorage.getItem("dx_region");
  if (_savedRegion) { const r = document.getElementById("dx-region-sel"); if (r) { r.value = _savedRegion; dxCluster.spotterRegion = _savedRegion; } }
  const _savedDxMode = localStorage.getItem("dx_mode");
  if (_savedDxMode) { const dm = document.getElementById("dx-mode-sel"); if (dm) { dm.value = _savedDxMode; dxOverlay.modeFilter = _savedDxMode.toUpperCase(); } }
// ── HB9VQQ END: restore saved DX filter settings (region + mode) ──
})();

// ════════════════════════════════════════════════════
// // ── Solar indices pill updater ──
// ════════════════════════════════════════════════════

// ── Solar indices pill updater ─────────────────────────────────────────────
// Fetches live solar data from DX Map API every 5 minutes.
// setSolPill() is defined in the dx-cluster init block above.
(function updateSolarPills() {
  fetch('https://dxmap.hb9vqq.ch/data/eu_v4.json')
    .then(r => r.json())
    .then(d => {
      const s = d.solar;
      setSolPill('SFI',  Math.round(s.sfi),
                         s.sfi >= 150 ? 'ok' : s.sfi >= 100 ? 'warn' : 'bad');
      setSolPill('KP',   Math.round(s.kp),
                         s.kp < 4 ? 'ok' : s.kp < 6 ? 'warn' : 'bad');
      setSolPill('SWS',  Math.round(s.velocity) + ' km/s',
                         s.velocity < 500 ? 'ok' : s.velocity < 600 ? 'warn' : 'bad');
      setSolPill('DRAP', s.drap_sunlit < 1 ? 'CLEAR' : Math.round(s.drap_sunlit) + ' MHz',
                         s.drap_sunlit < 10 ? 'ok' : s.drap_sunlit < 20 ? 'warn' : 'bad');
    })
    .catch(() => {}); // silently ignore fetch failures — pills keep last value
  setTimeout(updateSolarPills, 5 * 60 * 1000);
})();

// ════════════════════════════════════════════════════
// // Close help modal on click outside
// ════════════════════════════════════════════════════

document.addEventListener("DOMContentLoaded", function() {
  // Close help modal on click outside
  document.getElementById('help-modal').addEventListener('click', function(e) {
    if (e.target === this) this.style.display = 'none';
  });
  // Close on Escape
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') document.getElementById('help-modal').style.display = 'none';
    // Arrow keys tune frequency by step (skip if focus is on an input)
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      const tag = document.activeElement ? document.activeElement.tagName : '';
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      e.preventDefault();
      const step = parseFloat(document.getElementById('step').value) || 100;
      const cur = parseFloat(document.getElementById('freq').value) * 1000 || spectrum.frequency;
      const newFreq = cur + (e.key === 'ArrowRight' ? step : -step);
      const newKhz = (newFreq / 1000).toFixed(3);
      document.getElementById('freq').value = newKhz;
      spectrum.frequency = newFreq;
      if (ws && ws.readyState === WebSocket.OPEN) ws.send('F:' + newKhz);
    }
  });
});

// ── HB9VQQ BEGIN: fullscreen wf-wrap (includes dx-overlay + bcl-overlay) ──
(function overrideFullscreen() {
  function doOverride() {
    if (typeof spectrum === 'undefined' || spectrum === null) {
      setTimeout(doOverride, 100);
      return;
    }
    spectrum.toggleFullscreen = function() {
      const wfw = document.getElementById('wf-wrap');
      if (!wfw) return;
      if (document.fullscreenElement) {
        document.exitFullscreen();
      } else {
        wfw.requestFullscreen().catch(function(e) {
          console.warn('Fullscreen failed:', e);
        });
      }
    };
  }
  doOverride();
})();
// ── HB9VQQ END: fullscreen wf-wrap ──