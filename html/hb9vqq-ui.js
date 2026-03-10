// hb9vqq-ui.js — HB9VQQ fork UI components
// Extracted from radio.html block 1.
// Contains: spec/wf resizer, waterfall resize, UTC clock,
//           analog S-meter canvas renderer, floating S-meter panel.
// Do NOT merge this file with upstream radio.html.


/* ── Canvas painting ── */
const SPAN_LO = 14150000, SPAN_HI = 14350000;
let SPEC_FRAC = 0.40;   // mutable — dragged by spec-resizer

// Position the internal spec/wf split handle to match SPEC_FRAC
function positionSpecResizer() {
  const wrap = document.getElementById('wf-wrap');
  const h    = document.getElementById('spec-resizer');
  if (!wrap || !h) return;
  const frac = (typeof spectrum !== 'undefined' && spectrum.spectrumPercent)
    ? spectrum.spectrumPercent / 100
    : SPEC_FRAC;
  const specH = Math.round(wrap.clientHeight * frac);
  h.style.top = (specH - 2) + 'px';
}

// ── Spec/WF internal split drag ──
(function(){
  const handle  = document.getElementById('spec-resizer');
  const wfWrap  = document.getElementById('wf-wrap');
  const MIN_FRAC = 0.12, MAX_FRAC = 0.80;
  let dragging = false, startY = 0, startFrac = SPEC_FRAC;

  // Redraw DX overlay continuously during spec-resizer drag
  document.addEventListener('mousemove', () => {
    if (window._dxOverlay) requestAnimationFrame(() => window._dxOverlay.draw());
  });

  handle.addEventListener('mousedown', e => {
    dragging  = true;
    startY    = e.clientY;
    startFrac = SPEC_FRAC;
    handle.classList.add('dragging');
    document.body.style.cursor     = 'ns-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });

  document.addEventListener('mousemove', e => {
    if (!dragging) return;
    const H     = wfWrap.clientHeight;
    const delta = e.clientY - startY;
    SPEC_FRAC   = Math.min(MAX_FRAC, Math.max(MIN_FRAC, startFrac + delta / H));
    positionSpecResizer();
  });

  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove('dragging');
    document.body.style.cursor     = '';
    document.body.style.userSelect = '';
    if (typeof spectrum !== 'undefined') {
      spectrum.setSpectrumPercent(Math.round(SPEC_FRAC * 100));
    }
  });

  // Touch
  handle.addEventListener('touchstart', e => {
    dragging  = true;
    startY    = e.touches[0].clientY;
    startFrac = SPEC_FRAC;
    handle.classList.add('dragging');
    e.preventDefault();
  }, { passive: false });

  document.addEventListener('touchmove', e => {
    if (!dragging) return;
    const H     = wfWrap.clientHeight;
    const delta = e.touches[0].clientY - startY;
    SPEC_FRAC   = Math.min(MAX_FRAC, Math.max(MIN_FRAC, startFrac + delta / H));
    positionSpecResizer();
    e.preventDefault();
  }, { passive: false });

  document.addEventListener('touchend', () => {
    dragging = false; handle.classList.remove('dragging');
    if (typeof spectrum !== 'undefined') {
      spectrum.setSpectrumPercent(Math.round(SPEC_FRAC * 100));
    }
  });
})();

const SPOTS = [
  {call:'VK2XX',  freq:14165000, mode:'SSB',  age:3},
  {call:'JA1ABC', freq:14178000, mode:'SSB',  age:9},
  {call:'K1ZZ',   freq:14195000, mode:'CW',   age:1},
  {call:'OZ5AAH', freq:14210000, mode:'FT8',  age:5},
  {call:'5B4AHJ', freq:14225000, mode:'SSB',  age:22},
  {call:'PY2YU',  freq:14238000, mode:'CW',   age:7},
  {call:'4X4DX',  freq:14252000, mode:'RTTY', age:16},
  {call:'ZL2BX',  freq:14270000, mode:'SSB',  age:4},
  {call:'LU3HY',  freq:14288000, mode:'SSB',  age:11},
  {call:'UA9XL',  freq:14302000, mode:'CW',   age:2},
];

const MCOL = {CW:'#00ffff',SSB:'#ffff00',FT8:'#ff40ff',FT4:'#ff40ff',RTTY:'#ff8800'};
const mc = m => MCOL[m]||'#888888';
const ageAlpha = (a,max=30) => Math.max(0.25, 1-(a/max)*0.75);
const f2x = (f,W) => (f-SPAN_LO)/(SPAN_HI-SPAN_LO)*W;

const SIGS = [
  {f:14165000,p:26},{f:14175000,p:18},{f:14178000,p:22},
  {f:14195000,p:52},{f:14210000,p:35},{f:14220000,p:16},
  {f:14225000,p:28},{f:14238000,p:40},{f:14252000,p:44},
  {f:14270000,p:20},{f:14288000,p:30},{f:14302000,p:55},
  {f:14315000,p:18},{f:14330000,p:22},
];

let frame=0;
// ── Demo waterfall animation ──────────────────────────────────────────────
// ── Waterfall resize ──
(function(){
  const handle = document.getElementById('wf-resizer');
  const wfWrap = document.getElementById('wf-wrap');
  const app    = document.getElementById('app');
  const MIN_H  = 80;

  // Set initial height: fill available space minus all fixed strips
  function fixedHeight() {
    let h = 0;
    for (const el of app.children) {
      if (el === wfWrap || el === handle) continue;
      h += el.offsetHeight;
    }
    return h;
  }
  function initHeight() {
    const saved = localStorage.getItem('wf_wrap_height');
    if (saved && parseFloat(saved) > MIN_H) {
      wfWrap.style.height = saved + 'px';
    } else {
      const avail = window.innerHeight - fixedHeight() - handle.offsetHeight;
      wfWrap.style.height = Math.max(MIN_H, avail) + 'px';
    }
  }
  window.addEventListener('load', initHeight);
  window.addEventListener('resize', initHeight);

  let startY = 0, startH = 0, dragging = false;

  // Redraw DX overlay continuously during spec-resizer drag
  document.addEventListener('mousemove', () => {
    if (window._dxOverlay) requestAnimationFrame(() => window._dxOverlay.draw());
  });

  handle.addEventListener('mousedown', e => {
    dragging = true;
    startY   = e.clientY;
    startH   = wfWrap.offsetHeight;
    handle.classList.add('dragging');
    document.body.style.cursor = 'ns-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });

  document.addEventListener('mousemove', e => {
    if (!dragging) return;
    const delta = e.clientY - startY;
    const newH  = Math.max(MIN_H, startH + delta);
    wfWrap.style.height = newH + 'px';
  });

  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    localStorage.setItem('wf_wrap_height', wfWrap.offsetHeight);
    if (typeof spectrum !== 'undefined') {
      spectrum.resize();
      if (typeof syncOverlaySize === 'function') syncOverlaySize();
    }
  });

  // Touch support
  handle.addEventListener('touchstart', e => {
    dragging = true;
    startY   = e.touches[0].clientY;
    startH   = wfWrap.offsetHeight;
    handle.classList.add('dragging');
    e.preventDefault();
  }, { passive: false });

  document.addEventListener('touchmove', e => {
    if (!dragging) return;
    const delta = e.touches[0].clientY - startY;
    wfWrap.style.height = Math.max(MIN_H, startH + delta) + 'px';
    e.preventDefault();
  }, { passive: false });

  document.addEventListener('touchend', () => {
    dragging = false;
    handle.classList.remove('dragging');
    if (typeof spectrum !== 'undefined') {
      spectrum.resize();
      if (typeof syncOverlaySize === 'function') syncOverlaySize();
    }
  });
})();


// ── Clock ──
function tick() {
  const n=new Date();
  document.getElementById('clock').textContent =
    n.getUTCHours().toString().padStart(2,'0')+':'+
    n.getUTCMinutes().toString().padStart(2,'0')+':'+
    n.getUTCSeconds().toString().padStart(2,'0')+' UTC';
}
setInterval(tick,1000); tick();


// ── Callsign uppercase ──
const _callInp = document.querySelector('.call-inp'); if (_callInp) _callInp.addEventListener('input',function(){
  const s=this.selectionStart;
  this.value=this.value.toUpperCase();
  this.setSelectionRange(s,s);
});

// ── Audio button ──


// ── Analog S-meter — mode-aware ──
// mode: 0=Signal/RSSI, 1=SNR, 2=OVR
function drawAnalogSMeter(value, mode) {
  const canvas = document.getElementById('sMeter');
  if (!canvas || canvas.offsetParent === null) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const cx = W / 2, cy = H - 14, R = H - 22;

  // Background
  ctx.fillStyle = '#060b12';
  ctx.fillRect(0, 0, W, H);
  ctx.beginPath();
  ctx.arc(cx, cy, R, Math.PI, 2 * Math.PI);
  ctx.fillStyle = '#0d1b2a';
  ctx.fill();
  ctx.strokeStyle = '#1e2d3d';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(cx, cy, R, Math.PI, 2 * Math.PI);
  ctx.stroke();

  // Mode-specific scales
  let scaleMarks, fraction, arcColor, labelText;

  if (mode === 0) {
    // ── Signal (RSSI) scale ──
    scaleMarks = [
      {f:0,     t:'1'  }, {f:0.125, t:'3'  }, {f:0.25,  t:'5'  },
      {f:0.375, t:'7'  }, {f:0.5,   t:'9'  }, {f:0.667, t:'+20'},
      {f:0.833, t:'+40'}, {f:1.0,   t:'+60'}
    ];
    // fraction from smeter.js logic
    const adj = value - smallestSig;
    if (value <= s9Level)
      fraction = Math.max(0, adj / belowS9Span * s9pfs);
    else if (value >= biggestSig)
      fraction = 1;
    else
      fraction = s9pfs + (adj - adjAtS9) / aboveS9Span * (1 - s9pfs);
    arcColor  = fraction > s9pfs ? '#ff5030' : '#00d4c8';
    labelText = value + ' dBm';

  } else if (mode === 1) {
    // ── SNR scale: −10 … 0 … +50 dB ──
    scaleMarks = [
      {f:0,    t:'−10'}, {f:0.167, t:'0' }, {f:0.333, t:'+10'},
      {f:0.5,  t:'+20'}, {f:0.667, t:'+30'}, {f:0.833, t:'+40'},
      {f:1.0,  t:'+50'}
    ];
    // −10→0 is 1/6 of arc, 0→+50 is 5/6
    const zf = 1/6;
    if (value <= -10) fraction = 0;
    else if (value <= 0) fraction = zf * ((value + 10) / 10);
    else fraction = zf + (5/6) * Math.min(1, value / 50);
    arcColor  = value < 0 ? '#ff5030' : '#00d4c8';
    labelText = 'SNR: ' + (value >= 0 ? '+' : '') + value + ' dB';

  } else {
    // ── OVR scale: 0 … 100% ──
    scaleMarks = [
      {f:0,    t:'0'  }, {f:0.25,  t:'25' }, {f:0.5,   t:'50' },
      {f:0.75, t:'75' }, {f:1.0,   t:'100'}
    ];
    fraction  = Math.max(0, Math.min(1, value));
    arcColor  = fraction > 0.7 ? '#ff5030' : '#f5a623';
    labelText = 'OVR ' + (value * 100).toFixed(0) + '%';
  }

  fraction = Math.max(0, Math.min(1, fraction));

  // Tick marks
  scaleMarks.forEach((m, i) => {
    const a  = Math.PI + Math.PI * m.f;
    const r1 = R - 12;
    ctx.strokeStyle = '#2a4060'; ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(cx + R  * Math.cos(a), cy + R  * Math.sin(a));
    ctx.lineTo(cx + r1 * Math.cos(a), cy + r1 * Math.sin(a));
    ctx.stroke();
    // minor ticks between marks
    if (i < scaleMarks.length - 1) {
      const fmid = (m.f + scaleMarks[i+1].f) / 2;
      const am   = Math.PI + Math.PI * fmid;
      ctx.strokeStyle = '#1e2d3d'; ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(cx + R       * Math.cos(am), cy + R       * Math.sin(am));
      ctx.lineTo(cx + (R - 7) * Math.cos(am), cy + (R - 7) * Math.sin(am));
      ctx.stroke();
    }
    // label
    const rl = R - 24;
    const isOver = m.t.startsWith('+') && mode === 0;
    ctx.fillStyle = isOver ? '#ff8844' : '#4a8aaa';
    ctx.font = `bold ${m.t.length > 2 ? 8 : 9}px "JetBrains Mono"`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(m.t, cx + rl * Math.cos(Math.PI + Math.PI * m.f),
                      cy + rl * Math.sin(Math.PI + Math.PI * m.f));
  });

  // Red-zone arc (top 33%)
  if (mode === 0) {
    ctx.strokeStyle = 'rgba(255,80,40,0.2)'; ctx.lineWidth = 8;
    ctx.beginPath();
    ctx.arc(cx, cy, R - 5, Math.PI * 1.5, 2 * Math.PI);
    ctx.stroke();
  }

  // Active arc
  const angle = Math.PI + Math.PI * fraction;
  ctx.strokeStyle = arcColor; ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(cx, cy, R - 5, Math.PI, angle);
  ctx.stroke();

  // Zero line for SNR
  if (mode === 1) {
    const zAngle = Math.PI + Math.PI * (1/6);
    ctx.strokeStyle = 'rgba(255,255,255,0.2)'; ctx.lineWidth = 1;
    ctx.setLineDash([2,2]);
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + (R-5) * Math.cos(zAngle), cy + (R-5) * Math.sin(zAngle));
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // Needle shadow
  ctx.strokeStyle = 'rgba(0,0,0,0.4)'; ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(cx+1, cy+1);
  ctx.lineTo(cx + (R-14)*Math.cos(angle)+1, cy + (R-14)*Math.sin(angle)+1);
  ctx.stroke();

  // Needle
  ctx.strokeStyle = '#ff3030'; ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx + (R-14)*Math.cos(angle), cy + (R-14)*Math.sin(angle));
  ctx.stroke();

  // Pivot
  ctx.beginPath(); ctx.arc(cx, cy, 5, 0, 2*Math.PI);
  ctx.fillStyle = '#243447'; ctx.fill();
  ctx.strokeStyle = arcColor; ctx.lineWidth = 1; ctx.stroke();

  // Value label
  ctx.fillStyle = '#4a8aaa'; ctx.font = '10px "JetBrains Mono"';
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  ctx.fillText(labelText, cx, H - 13);
}
// ── Floating S-meter toggle + drag ──
(function(){
  const panel  = document.getElementById('smeter-float');
  const btn    = document.getElementById('smeter-popup-btn');
  const close  = document.getElementById('smeter-float-close');
  const hdr    = document.getElementById('smeter-float-hdr');
  let visible  = false;
  let dragX=0, dragY=0, dragging=false;
  let panelX=0, panelY=0;

  function show() {
    visible = true;
    panel.style.display = 'block';
    btn.style.color        = 'var(--teal)';
    btn.style.borderColor  = 'var(--teal-dim)';
    btn.style.background   = 'rgba(0,212,200,0.08)';
    const box = document.getElementById('analog_smeter_box');
    if (box) box.style.display = 'block';
  }
  function hide() {
    visible = false;
    panel.style.display = 'none';
    btn.style.color       = 'var(--teal-dim)';
    btn.style.borderColor = 'var(--rule2)';
    btn.style.background  = 'var(--ink3)';
    const box = document.getElementById('analog_smeter_box');
    if (box) box.style.display = 'none';
  }

  btn.addEventListener('click', () => visible ? hide() : show());
  close.addEventListener('click', () => {
    hide();
    const ck = document.getElementById('ckAnalogSMeter');
    if (ck) { ck.checked = false; }
    if (typeof setAnalogMeterVisible === 'function') setAnalogMeterVisible(false);
  });

  // Drag
  hdr.addEventListener('mousedown', e => {
    dragging = true;
    const rect = panel.getBoundingClientRect();
    dragX = e.clientX - rect.left;
    dragY = e.clientY - rect.top;
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });
  document.addEventListener('mousemove', e => {
    if (!dragging) return;
    panel.style.right = 'auto';
    panel.style.left  = (e.clientX - dragX) + 'px';
    panel.style.top   = (e.clientY - dragY) + 'px';
  });
  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    document.body.style.userSelect = '';
  });

  // Expose visibility state for external queries
  window._smeterFloatVisible = () => visible;
})();
document.querySelectorAll('.leg').forEach(l=>{
  l.addEventListener('click',function(){this.classList.toggle('on');});
});
