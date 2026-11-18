// CineSync — tam ekranda yüzen kamera kutucukları
// Sürükle-bırak ile en yakın köşeye yapışır; boyut (küçük/orta/büyük) ve köşe tercihleri saklanır.

import { initials } from './ui/dom.js';

const GAP = 8;

export class PipLayer {
  constructor(layer, { getInsets, store }) {
    this.layer = layer;
    this.getInsets = getInsets || (() => ({ top: 12, bottom: 12, left: 12, right: 12 }));
    this.store = store;
    this.tiles = new Map(); // id -> {el, video, data}
    this.corners = new Map();
    this.size = store?.get('pipSize', 'm') || 'm';
    layer.dataset.size = this.size;
    this._ro = new ResizeObserver(() => this.layout());
    this._ro.observe(layer);
  }

  cycleSize() {
    this.size = { s: 'm', m: 'l', l: 's' }[this.size] || 'm';
    this.layer.dataset.size = this.size;
    this.store?.set('pipSize', this.size);
    requestAnimationFrame(() => this.layout());
    return this.size;
  }

  /** items: [{id, name, color, stream, self}] — yalnızca kamerası açık olanlar */
  render(items) {
    const ids = new Set(items.map((i) => i.id));
    for (const [id, t] of this.tiles) if (!ids.has(id)) { t.el.remove(); this.tiles.delete(id); }
    items.forEach((it, idx) => {
      let t = this.tiles.get(it.id);
      if (!t) {
        const el = document.createElement('div');
        el.className = 'pip' + (it.self ? ' self' : '');
        el.dataset.id = it.id;
        el.setAttribute('role', 'img');
        el.innerHTML = '<video autoplay playsinline muted></video><div class="pip-av" hidden><span></span></div><span class="pip-name"></span>';
        this.layer.appendChild(el);
        t = { el, video: el.querySelector('video') };
        this.tiles.set(it.id, t);
        this._bindDrag(t, it.id);
        if (!this.corners.has(it.id)) this.corners.set(it.id, this._pickCorner(it.self));
      }
      t.data = it;
      t.el.setAttribute('aria-label', `${it.name} kamerası`);
      t.el.querySelector('.pip-name').textContent = it.self ? `${it.name} (sen)` : it.name;
      const av = t.el.querySelector('.pip-av');
      av.querySelector('span').textContent = initials(it.name);
      av.querySelector('span').style.background = it.color;
      const hasVideo = !!(it.stream && it.stream.getVideoTracks().some((x) => x.readyState === 'live' && x.enabled !== false));
      av.hidden = hasVideo;
      if (t.video.srcObject !== it.stream) { t.video.srcObject = it.stream || null; t.video.play().catch(() => {}); }
    });
    this.layout();
  }

  _pickCorner(self) {
    if (self) return 'br';
    const order = ['tl', 'tr', 'bl', 'br'];
    const use = Object.fromEntries(order.map((c) => [c, 0]));
    for (const id of this.tiles.keys()) { const c = this.corners.get(id); if (c) use[c]++; }
    return order.reduce((best, c) => (use[c] < use[best] ? c : best), 'tl');
  }

  _rect() {
    const w = this.layer.clientWidth, h = this.layer.clientHeight;
    return { w, h };
  }

  layout() {
    const { w, h } = this._rect();
    if (!w || !h) return;
    const ins = this.getInsets();
    const groups = { tl: [], tr: [], bl: [], br: [] };
    for (const [id, t] of this.tiles) {
      if (t.el.classList.contains('dragging')) continue;
      (groups[this.corners.get(id)] || groups.br).push(t);
    }
    // Kısa ekranlarda (yatay telefon) aynı sütundaki kutucuklar sığmazsa küçült
    for (const side of ['l', 'r']) {
      const col = [...groups['t' + side], ...groups['b' + side]];
      col.forEach((t) => { t.el.style.width = ''; });
      if (!col.length) continue;
      const avail = h - ins.top - ins.bottom - GAP * col.length;
      const need = col.reduce((sum, t) => sum + t.el.offsetHeight, 0);
      if (need > avail && avail > 0) {
        const targetH = Math.floor(avail / col.length);
        col.forEach((t) => { t.el.style.width = Math.max(56, Math.floor(targetH * 4 / 3)) + 'px'; });
      }
    }
    for (const [corner, list] of Object.entries(groups)) {
      let offset = 0;
      for (const t of list) {
        const tw = t.el.offsetWidth, th = t.el.offsetHeight;
        const left = corner.endsWith('l') ? ins.left : w - ins.right - tw;
        let top = corner.startsWith('t') ? ins.top + offset : h - ins.bottom - th - offset;
        top = Math.max(4, Math.min(h - th - 4, top));
        t.el.style.left = Math.max(4, left) + 'px';
        t.el.style.top = top + 'px';
        offset += th + GAP;
      }
    }
  }

  _bindDrag(t, id) {
    let sx = 0, sy = 0, ox = 0, oy = 0, moved = false, pid = null;
    const el = t.el;
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      pid = e.pointerId; el.setPointerCapture(pid);
      sx = e.clientX; sy = e.clientY; ox = el.offsetLeft; oy = el.offsetTop; moved = false;
      e.stopPropagation();
    });
    el.addEventListener('pointermove', (e) => {
      if (pid !== e.pointerId) return;
      const dx = e.clientX - sx, dy = e.clientY - sy;
      if (!moved && Math.hypot(dx, dy) < 5) return;
      moved = true; el.classList.add('dragging');
      const { w, h } = this._rect();
      el.style.left = Math.max(0, Math.min(w - el.offsetWidth, ox + dx)) + 'px';
      el.style.top = Math.max(0, Math.min(h - el.offsetHeight, oy + dy)) + 'px';
    });
    const end = (e) => {
      if (pid !== e.pointerId) return;
      pid = null;
      if (!moved) return;
      el.classList.remove('dragging');
      const { w, h } = this._rect();
      const cx = el.offsetLeft + el.offsetWidth / 2, cy = el.offsetTop + el.offsetHeight / 2;
      const corner = (cy < h / 2 ? 't' : 'b') + (cx < w / 2 ? 'l' : 'r');
      this.corners.set(id, corner);
      this.layout();
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('dblclick', () => this.cycleSize());
  }

  clear() { for (const t of this.tiles.values()) t.el.remove(); this.tiles.clear(); }
}
