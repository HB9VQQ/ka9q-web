// bcl-overlay.js — HB9VQQ fork: BCL/SWL broadcast station overlay
// Draws station name + frequency lines on the spectrum.
// Labels at top of each line, lines at varying heights (4 tiers).
// Always on, filtered to visible frequency range.
// Do NOT merge this file with upstream radio.html.

// ── HB9VQQ BEGIN: BCL overlay ──

(function initBCLOverlay() {

  let BCL_JSON_URL = localStorage.getItem('bcl_db') || 'bcl_stations.json';
  const LINE_COLOR   = 'rgba(255, 200, 50, 0.70)';
  const LABEL_COLOR  = '#ffc832';
  const LABEL_FONT   = '9px "JetBrains Mono", monospace';
  const MIN_PX_LABEL = 4;    // min px gap between label right edge and next line
  // Line height tiers: fraction of specH the line extends down from label bottom
  const TIERS = [1.0, 0.72, 0.48, 0.28];
  const LABEL_TOP = 32;      // y of label text for tier-0 lines (below spectrum.js axis ~20px)

  let _stations = [], _loaded = false, _canvas = null, _spectrum = null;

  function getSpecH(H) {
    // Read spec-resizer top position — most reliable source
    const sr = document.getElementById('spec-resizer');
    if (sr) {
      const t = parseFloat(sr.style.top);
      if (t > 10) return t;
    }
    if (_spectrum && _spectrum.spectrumHeight > 10) return _spectrum.spectrumHeight;
    const frac = (typeof SPEC_FRAC !== 'undefined') ? SPEC_FRAC : 0.40;
    return Math.round(H * frac);
  }

  // Simple hash of frequency → tier index (deterministic, looks varied)
  function tier(freqKhz) {
    const h = (freqKhz * 2654435761) >>> 0;
    return h % TIERS.length;
  }

  function loadStations() {
    const bust = '?t=' + Math.floor(Date.now() / 3600000);
    Promise.all([
      fetch(BCL_JSON_URL + bust).then(r => r.ok ? r.json() : []),
      fetch('bcl_local.json' + bust).then(r => r.ok ? r.json() : []).catch(() => [])
    ]).then(([db, local]) => {
      // Merge: local entries override db entries at same frequency+name
      const map = new Map(db.map(e => [e.f + '|' + e.n, e]));
      local.forEach(e => map.set(e.f + '|' + e.n, e));
      _stations = Array.from(map.values()).sort((a,b) => a.f - b.f);
      _loaded = true;
      draw();
    }).catch(err => console.warn('BCL overlay:', err));
  }

  function draw() {
    if (!_canvas || !_spectrum || !_loaded) return;
    const ctx = _canvas.getContext('2d');
    const W   = _canvas.width;
    const H   = _canvas.height;
    ctx.clearRect(0, 0, W, H);

    // Only show overlay when Broadcast category is selected
    const _cat = document.getElementById('band_category');
    if (!_cat || _cat.value !== 'broadcast') return;

    const startHz = _spectrum.start_freq;
    const spanHz  = _spectrum.spanHz;
    if (!startHz || !spanHz) return;

    const hzPerPx  = spanHz / W;
    const startKhz = startHz / 1000;
    const endKhz   = (startHz + spanHz) / 1000;
    const specH    = getSpecH(H);

    const entries = _stations
      .filter(s => s.f >= startKhz && s.f <= endKhz)
      .map(s => ({
        ...s,
        x: Math.round((s.f * 1000 - startHz) / hzPerPx),
        t: tier(s.f)
      }));

    if (!entries.length) return;

    ctx.save();
    ctx.font = LABEL_FONT;

    // Group entries by x pixel — multiple stations on same frequency stack vertically
    const byX = new Map();
    entries.forEach(e => {
      if (!byX.has(e.x)) byX.set(e.x, []);
      byX.get(e.x).push(e);
    });

    let lastLabelRightX = -999;
    const drawnX = new Set();

    entries.forEach(e => {
      const x     = e.x;
      const group = byX.get(x);
      const nStack = group.length;

      // Line top: leave room for all stacked labels (11px each)
      const lineTop = LABEL_TOP + nStack * 11 + 2;
      const lineBot = Math.min(specH, lineTop + Math.round((specH - lineTop) * TIERS[e.t]));

      // Draw line + tick only once per unique x
      if (!drawnX.has(x)) {
        drawnX.add(x);
        ctx.strokeStyle = LINE_COLOR;
        ctx.lineWidth   = 1;
        ctx.setLineDash([3, 4]);
        ctx.beginPath();
        ctx.moveTo(x, lineTop);
        ctx.lineTo(x, lineBot);
        ctx.stroke();
        ctx.setLineDash([]);

        ctx.strokeStyle = '#ffc832';
        ctx.lineWidth   = 1.5;
        ctx.beginPath();
        ctx.moveTo(x, lineBot - 3);
        ctx.lineTo(x, lineBot + 3);
        ctx.stroke();

        // Draw all labels in group stacked, if enough space from last label block
        if (x >= lastLabelRightX + MIN_PX_LABEL) {
          let maxW = 0;
          group.forEach((g, i) => {
            const label  = (g.n || '').substring(0, 14);
            const tw     = ctx.measureText(label).width + 6;
            const labelY = LABEL_TOP + i * 11 + 9;

            ctx.fillStyle = 'rgba(4, 8, 16, 0.92)';
            ctx.fillRect(x - 1, labelY - 10, tw + 4, 12);

            ctx.shadowColor = 'rgba(0,0,0,1)';
            ctx.shadowBlur  = 4;
            ctx.fillStyle   = '#ffffff';
            ctx.fillText(label, x + 2, labelY);
            ctx.shadowBlur  = 0;

            if (tw > maxW) maxW = tw;
          });
          lastLabelRightX = x + maxW;
        }
      }
    });

    ctx.restore();
  }

  function syncSize() {
    if (!_canvas) return;
    const wfw = document.getElementById('wf-wrap');
    if (!wfw) return;
    _canvas.width  = wfw.offsetWidth;
    _canvas.height = wfw.offsetHeight;
  }

  (function waitForSpectrum() {
    if (typeof spectrum === 'undefined' || spectrum === null) {
      setTimeout(waitForSpectrum, 50);
      return;
    }
    _spectrum = spectrum;

    const wfw = document.getElementById('wf-wrap');
    _canvas = document.createElement('canvas');
    _canvas.id                  = 'bcl-overlay';
    _canvas.style.position      = 'absolute';
    _canvas.style.top           = '0';
    _canvas.style.left          = '0';
    _canvas.style.width         = '100%';
    _canvas.style.height        = '100%';
    _canvas.style.pointerEvents = 'none';
    _canvas.style.zIndex        = '2';
    wfw.appendChild(_canvas);

    syncSize();
    loadStations();

    if (window.ResizeObserver) {
      new ResizeObserver(() => { syncSize(); draw(); }).observe(wfw);
    }
    window.addEventListener('resize', () => { syncSize(); draw(); });

    let lastStart = null, lastSpan = null;
    setInterval(() => {
      if (_spectrum.start_freq !== lastStart || _spectrum.spanHz !== lastSpan) {
        lastStart = _spectrum.start_freq;
        lastSpan  = _spectrum.spanHz;
        draw();
      }
    }, 500);

    // Restore saved DB selection in the options dialog
    const _sel = document.getElementById('bclDbSelect');
    if (_sel) _sel.value = BCL_JSON_URL;

    // Redraw (clear) when band category changes
    const _catEl = document.getElementById('band_category');
    if (_catEl) _catEl.addEventListener('change', () => draw());

    window._bclOverlay = {
      draw,
      syncSize,
      setDb: function(url) {
        BCL_JSON_URL = url;
        _loaded = false;
        _stations = [];
        loadStations();
        // Keep options dialog in sync
        const sel = document.getElementById('bclDbSelect');
        if (sel) sel.value = url;
      }
    };
  })();

})();

// ── HB9VQQ END: BCL overlay ──
