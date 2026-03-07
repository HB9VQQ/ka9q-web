
window._spotterContinent = function(call) {
  if (!call) return '?';
  const c = call.toUpperCase();
  if (/^(W|K|N|AA|AB|AC|AD|AE|AF|AG|AH|AI|AJ|AK|AL|WA|WB|WC|WD|WE|WF|WG|WH|WI|WJ|WK|WL|WM|WN|WO|WP|WQ|WR|WS|WT|WU|WV|WW|WX|WY|WZ|KA|KB|KC|KD|KE|KF|KG|KH|KI|KJ|KK|KL|KM|KN|KO|KP|KQ|KR|KS|KT|KU|KV|KW|KX|KY|KZ|NA|NB|NC|ND|NE|NF|NG|NH|NI|NJ|NK|NL|NM|NN|NO|NP|NQ|NR|NS|NT|NU|NV|NW|NX|NY|NZ)[0-9]/.test(c)) return 'NA';
  if (/^(VE|VA|VY|VO)/.test(c)) return 'NA';
  if (/^(XE|XF)/.test(c)) return 'NA';
  if (/^(TG|YN|TI|HR|HP|HH|HI|J3|J6|J7|J8|V2|V4|ZF|CO|CM)/.test(c)) return 'NA';
  if (/^(PY|PP|PQ|PR|PS|PT|PU|PV|PW|ZV|ZW|ZX|ZY|ZZ|LU|LW|CE|HC|HJ|HK|CP|OA|OB|OC|YV|YW|CX|ZP|8R|9Y)/.test(c)) return 'SA';
  const m2 = c.match(/^(?:UA|RA|U[A-Z])(\d)/);
  if (m2) { const n=parseInt(m2[1]); return (n===0||n===9)?'AS':'EU'; }
  if (/^(G|M|2E|2I|2J|2M|2W|GD|GI|GJ|GM|GU|GW|F|TM|DL|DA|DB|DC|DD|DE|DF|DG|DH|DJ|DK|DM|DN|DO|DP|DQ|DR|I|IK|IZ|IW|IU|IS|PA|PB|PC|PD|PE|PF|PG|PH|PI|SP|SQ|SR|OK|OL|OM|OE|HB|HB0|ON|OO|OR|OZ|SM|SA|SB|SC|SD|SE|SF|SG|SH|SI|SJ|SK|SL|OH|OF|OG|ES|YL|LY|LA|LB|LC|LD|LE|LF|LG|LH|LJ|LK|TF|EI|EJ|EA|EB|EC|ED|EE|EF|EG|EH|CT|CQ|CR|CS|SV|SW|SX|YO|YP|YQ|YR|LZ|T9|E7|9A|S5|HA|HG|YU|YT|4O)/.test(c)) return 'EU';
  if (/^(JA|JE|JF|JG|JH|JI|JJ|JK|JL|JM|JN|JO|JP|JQ|JR|JS|HL|DS|DT|BY|BA|BD|BG|BH|BJ|BL|BT|BU|BV|VU|AT|AU|AV|AW|HS|E2|UN|UP|UQ|EK|EW|ER|EX|EY|EZ|UK|4J|4K|4L|A4|A6|A7|A9|HZ|OD|YK|4X|4Z|EP|EQ|AP)/.test(c)) return 'AS';
  if (/^(ZS|ZR|ZT|ZU|V5|A2|7P|C9|9J|5H|5X|5Z|7Q|ET|ST|SS|SU|CN|6W|TU|TJ|TR|TT|TL|TZ|XT|5V|5N|D2|D4|D6|J2|J5|S9|3C|3X|5A|ZE|9Q|9U|9X|T5|C5|EL)/.test(c)) return 'AF';
  if (/^(VK|AX|ZL|ZM)/.test(c)) return 'OC';
  return '?';
};
window.DXCluster = class DXCluster {
  constructor(wsUrl, maxAgeMinutes = 30) {
    this._url = wsUrl; this.maxAge = maxAgeMinutes;
    this._spots = new Map(); this._ws = null; this.spotterRegion = 'All';
    this._backoff = 1000; this._intentionalClose = false;
    this.onUpdate = null; this.onStatus = null;
  }
  connect() {
    this._intentionalClose = false;
    this._ws = new WebSocket(this._url);
    this._ws.onopen = () => { this._backoff = 1000; this.onStatus?.('connected'); };
    this._ws.onmessage = e => {
      let parsed; try { parsed = JSON.parse(e.data); } catch { return; }
      if (Array.isArray(parsed)) parsed.forEach(s => this._insertSpot(s));
      else this._insertSpot(parsed);
      this.onUpdate?.();
    };
    this._ws.onerror = () => this.onStatus?.('error');
    this._ws.onclose = () => {
      if (this._intentionalClose) return;
      this.onStatus?.('reconnecting');
      this._backoff = Math.min(this._backoff * 2, 30000);
      setTimeout(() => this.connect(), this._backoff);
    };
  }
  reconnect(newUrl) {
    this._intentionalClose = true; this._ws?.close();
    this._url = newUrl; this._backoff = 1000; this.connect();
  }
  _insertSpot(spot) {
    if (!spot || !spot.dx_call) return;
    spot._continent = window._spotterContinent(spot.spotter || '');
    this._spots.set(spot.dx_call, spot);
  }
  purge() {
    const cutoff = Date.now() - this.maxAge * 60000;
    for (const [call, spot] of this._spots)
      if (Date.parse(spot.time) < cutoff) this._spots.delete(call);
  }
  getSpotsInRange(lowHz, highHz) {
    const out = [];
    for (const spot of this._spots.values()) {
      const hz = spot.frequency * 1000;
      if (hz >= lowHz && hz <= highHz) {
        if (this.spotterRegion === 'All' || spot._continent === this.spotterRegion) out.push(spot);
      }
    }
    return out;
  }
  nearestSpot(freqHz, thresholdHz) {
    let best = null, bestDist = Infinity;
    for (const spot of this._spots.values()) {
      const dist = Math.abs(spot.frequency * 1000 - freqHz);
      if (dist < thresholdHz && dist < bestDist) { bestDist = dist; best = spot; }
    }
    return best;
  }
};
window.DXOverlay = class DXOverlay {
  constructor(canvas, cluster, spectrumRef) {
    this._canvas = canvas; this._ctx = canvas.getContext('2d');
    this._cluster = cluster; this._spectrum = spectrumRef;
    this.enabled = true; this.modeFilter = 'ALL';
  }
  _modeColor(mode) {
    switch (mode) {
      case 'CW':   return '#00ffff';
      case 'SSB':  return '#ffff00';
      case 'FT8':
      case 'FT4':  return '#ff40ff';
      case 'RTTY': return '#ff8800';
      default:     return '#888888';
    }
  }
  freqToX(freqHz) {
    const dpr = this._canvas._dpr || window.devicePixelRatio || 1;
    const hz_per_pixel = this._spectrum.spanHz / (this._spectrum.canvas.width / dpr);
    if (!hz_per_pixel) return -1;
    return Math.round((freqHz - this._spectrum.start_freq) / hz_per_pixel);
  }
  draw() {
    const ctx = this._ctx, canvas = this._canvas;
    this._cluster.purge();
    const dpr = canvas._dpr || window.devicePixelRatio || 1;
    ctx.setTransform(dpr,0,0,dpr,0,0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setLineDash([]);
    ctx.lineWidth = 1;
    ctx.globalAlpha = 1;
    if (!this.enabled || !this._spectrum.spanHz) return;
    const now = Date.now(), maxAge = this._cluster.maxAge;
    const vis = [];
    for (const spot of this._cluster._spots.values()) {
      if (this.modeFilter !== 'ALL' && spot.mode !== this.modeFilter) continue;
      if (this._cluster.spotterRegion !== 'All' && spot._continent !== this._cluster.spotterRegion) continue;
      const x = this.freqToX(spot.frequency * 1000);
      if (x < 0 || x > canvas.width) continue;
      vis.push({ spot, x });
    }
    vis.sort((a, b) => a.x - b.x);
    const specH = Math.round((canvas.height/dpr) * (this._spectrum.spectrumPercent || 50) / 100);
    const ROW_H = 14, Y0 = 42, ROWS = 3;
    const usedRows = [];
    
    vis.forEach(({ spot, x }, i) => {
      const ageMins = (now - Date.parse(spot.time)) / 60000;
      const alpha   = Math.max(0.3, 1.0 - (ageMins / maxAge) * 0.7);
      const color   = this._modeColor(spot.mode);
      let row = 0;
      if (i > 0 && Math.abs(x - vis[i-1].x) < 90)
        row = (usedRows[i-1] + 1) % ROWS;
      usedRows.push(row);
      const labelY = Y0 + row * ROW_H;
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = color; ctx.lineWidth = 1;
      ctx.setLineDash([2, 2]);
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, Math.round(labelY) + 12);
      ctx.lineTo(x + 0.5, specH - 4);
      ctx.stroke();
      ctx.setLineDash([]);

      // Arrow at spectrum/waterfall boundary
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(x, specH + 6);
      ctx.lineTo(x - 4, specH);
      ctx.lineTo(x + 4, specH);
      ctx.closePath(); ctx.fill();

      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.fillStyle = color;
      ctx.beginPath();
      const lbl = '\u25C7' + spot.dx_call;
      ctx.font = 'bold 11px Arial, sans-serif';
      ctx.textBaseline = 'top';
      ctx.fillStyle = color;
      ctx.fillText(lbl, Math.round(x) + 2, Math.round(labelY));
    });
    ctx.globalAlpha = 1;
    const countEl = document.getElementById('dx-count');
    if (countEl) countEl.textContent = vis.length;
  }
};
