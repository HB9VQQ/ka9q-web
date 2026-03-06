window.DXCluster = class DXCluster {
  constructor(wsUrl, maxAgeMinutes = 30) {
    this._url = wsUrl; this.maxAge = maxAgeMinutes;
    this._spots = new Map(); this._ws = null;
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
      if (hz >= lowHz && hz <= highHz) out.push(spot);
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
    const hz_per_pixel = this._spectrum.spanHz / this._spectrum.canvas.width;
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
