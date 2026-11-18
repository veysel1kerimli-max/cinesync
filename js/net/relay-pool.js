// CineSync — Nostr röle havuzu
// Birden fazla herkese açık röleye aynı anda bağlanır, olayları hepsine yayınlar ve
// gelenleri kimliklerine göre tekilleştirir. Bir röle çökse bile oda çalışmaya devam eder.

import { schnorr } from '../vendor/schnorr.js';

const enc = new TextEncoder();
const toHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

export async function sha256Hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', enc.encode(str));
  return toHex(new Uint8Array(buf));
}

export class RelayPool {
  constructor(urls, { onEvent, onStatus } = {}) {
    this.urls = urls;
    this.onEvent = onEvent || (() => {});
    this.onStatus = onStatus || (() => {});
    this.sockets = new Map(); // url -> {ws, open, retry, timer}
    this.filters = null;
    this.subId = 'cs' + Math.random().toString(36).slice(2, 10);
    this.seen = new Set();
    this.seenQueue = [];
    this.closed = false;
    this.secretKey = schnorr.utils.randomSecretKey();
    this.pubkey = toHex(schnorr.getPublicKey(this.secretKey));
    this.pending = [];
    // Canlılık bekçisi: kendi kalp atışlarımız da röleden geri döner; uzun süre hiçbir şey gelmeyen
    // "açık" soket aslında ölüdür (mobil ağ değişimi, uyku). Kapatıp hemen yeniden bağlanırız.
    this.watchdog = setInterval(() => this._checkAlive(), 10000);
  }

  _checkAlive(maxSilentMs = 45000) {
    if (this.closed) return;
    const now = Date.now();
    for (const [url, s] of this.sockets) {
      if (s.open && now - (s.lastRx || s.openedAt || now) > maxSilentMs) { try { s.ws.close(); } catch {} s.open = false; this.status(); this._open(url); }
    }
  }

  /** Sayfa öne gelince / internet geri gelince: kapalı soketleri beklemeden aç, sessiz kalanları yenile */
  reconnectNow() {
    if (this.closed) return;
    for (const url of this.urls) {
      const s = this.sockets.get(url);
      if (!s || (!s.open && s.ws?.readyState !== WebSocket.CONNECTING)) { if (s) { clearTimeout(s.timer); s.retry = 0; } this._open(url); }
    }
    this._checkAlive(20000);
  }

  get openCount() {
    let n = 0;
    for (const s of this.sockets.values()) if (s.open) n++;
    return n;
  }

  status() {
    this.onStatus({ open: this.openCount, total: this.urls.length });
  }

  subscribe(filter) {
    this.filters = filter;
    for (const s of this.sockets.values()) if (s.open) this._req(s);
  }

  connect() {
    for (const url of this.urls) this._open(url);
  }

  _open(url) {
    if (this.closed) return;
    const prev = this.sockets.get(url) || { retry: 0 };
    let ws;
    try { ws = new WebSocket(url); } catch { return this._schedule(url, prev); }
    const s = { ...prev, ws, open: false, lastRx: 0, openedAt: 0 };
    clearTimeout(prev.timer);
    try { if (prev.ws && prev.ws !== ws && prev.ws.readyState <= 1) { prev.ws.onclose = null; prev.ws.close(); } } catch {}
    this.sockets.set(url, s);
    const openTimeout = setTimeout(() => { if (!s.open) try { ws.close(); } catch {} }, 8000);
    ws.onopen = () => {
      clearTimeout(openTimeout);
      if (this.sockets.get(url) !== s) { try { ws.close(); } catch {} return; }
      s.open = true; s.retry = 0; s.openedAt = Date.now(); s.lastRx = Date.now();
      if (this.filters) this._req(s);
      this.pending = this.pending.filter((ev) => Date.now() / 1000 - ev.created_at < 30);
      for (const ev of this.pending) this._send(s, ['EVENT', ev]);
      this.status();
    };
    ws.onmessage = (m) => {
      s.lastRx = Date.now();
      let msg;
      try { msg = JSON.parse(m.data); } catch { return; }
      if (msg[0] === 'EVENT' && msg[2]) this._incoming(msg[2], !s.eose);
      else if (msg[0] === 'EOSE') s.eose = true;
    };
    ws.onclose = () => {
      clearTimeout(openTimeout);
      if (this.sockets.get(url) !== s) return; // yerine yenisi açıldı
      const wasOpen = s.open; s.open = false;
      if (wasOpen) this.status();
      this._schedule(url, s);
    };
    ws.onerror = () => {};
  }

  _schedule(url, s) {
    if (this.closed) return;
    s.retry = Math.min((s.retry || 0) + 1, 5);
    const delay = Math.min(15000, 500 * 2 ** s.retry) + Math.random() * 800;
    clearTimeout(s.timer);
    s.timer = setTimeout(() => this._open(url), delay);
  }

  _req(s) {
    s.eose = false; // EOSE gelene kadar gelenler rölede saklanmış (geçmiş) olaylardır
    this._send(s, ['REQ', this.subId, { ...this.filters, since: Math.floor(Date.now() / 1000) - 5 }]);
  }

  _send(s, arr) {
    try { if (s.ws && s.ws.readyState === 1) s.ws.send(JSON.stringify(arr)); } catch {}
  }

  _incoming(ev, stored = false) {
    if (!ev || !ev.id || this.seen.has(ev.id)) return;
    ev._stored = stored;
    this.seen.add(ev.id); this.seenQueue.push(ev.id);
    if (this.seenQueue.length > 4000) this.seen.delete(this.seenQueue.shift());
    if (ev.pubkey === this.pubkey) return;
    this.onEvent(ev);
  }

  async publish(kind, tags, content) {
    const created_at = Math.floor(Date.now() / 1000);
    const serial = JSON.stringify([0, this.pubkey, created_at, kind, tags, content]);
    const id = await sha256Hex(serial);
    const sig = toHex(await schnorr.sign(hexToBytes(id), this.secretKey));
    const ev = { id, pubkey: this.pubkey, created_at, kind, tags, content, sig };
    this.seen.add(id);
    let sent = 0;
    for (const s of this.sockets.values()) if (s.open) { this._send(s, ['EVENT', ev]); sent++; }
    if (!sent) { this.pending.push(ev); if (this.pending.length > 50) this.pending.shift(); }
    return ev;
  }

  close() {
    this.closed = true;
    clearInterval(this.watchdog);
    for (const s of this.sockets.values()) {
      clearTimeout(s.timer);
      try { if (s.open) this._send(s, ['CLOSE', this.subId]); if (s.ws) { s.ws.onclose = null; s.ws.close(); } } catch {}
    }
    this.sockets.clear();
  }
}

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}
