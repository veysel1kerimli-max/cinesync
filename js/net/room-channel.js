// CineSync — şifreli oda kanalı
// Oda kodundan bir konu (topic) ve AES-GCM anahtarı türetir. Tüm oda mesajları
// (sohbet, oynatma durumu, WebRTC sinyalleri) şifrelenip Nostr "geçici olay" (ephemeral event)
// olarak yayınlanır. Röleler bu olayları saklamaz; içerikleri de okuyamaz.

import { RelayPool, sha256Hex } from './relay-pool.js';
import { APP } from '../config.js';

const EPHEMERAL_KIND = 25050; // NIP-01: 20000–29999 aralığı röleler tarafından saklanmaz
const enc = new TextEncoder();
const dec = new TextDecoder();

const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

// Şifreli odalarda anahtar kod + şifreden türetilir; konu (topic) yalnızca koddan türetildiği için
// şifreyi bilmeyen biri odanın dolu olduğunu görebilir ama mesajları okuyamaz.
async function deriveKey(roomCode, password = '') {
  const material = await crypto.subtle.importKey('raw', enc.encode(password ? `${roomCode}\u0000${password}` : roomCode), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: enc.encode(APP.protocol + ':salt'), iterations: 120000, hash: 'SHA-256' },
    material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  );
}

export class RoomChannel {
  constructor({ roomCode, password = '', selfId, relays, onMessage, onStatus, onForeign, getEpoch }) {
    this.roomCode = roomCode;
    this.password = password;
    this.onForeign = onForeign || (() => {});
    this.getEpoch = getEpoch || (() => null);
    this.selfId = selfId;
    this.relays = relays;
    this.onMessage = onMessage;
    this.onStatus = onStatus;
    this.key = null;
    this.topic = null;
    this.pool = null;
  }

  async open() {
    this.key = await deriveKey(this.roomCode, this.password);
    this.topic = (await sha256Hex(`${APP.protocol}:room:${this.roomCode}`)).slice(0, 40);
    this.pool = new RelayPool(this.relays, {
      onEvent: (ev) => this._onEvent(ev),
      onStatus: (s) => this.onStatus && this.onStatus(s),
    });
    this.pool.subscribe({ kinds: [EPHEMERAL_KIND], '#t': [this.topic] });
    this.pool.connect();
  }

  async _onEvent(ev) {
    try {
      const [ivB64, ctB64] = String(ev.content).split('.');
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(ivB64) }, this.key, unb64(ctB64));
      const msg = JSON.parse(dec.decode(plain));
      if (!msg || msg.from === this.selfId) return;
      if (msg.to && msg.to !== this.selfId) return;
      msg.stored = !!ev._stored;
      this.onMessage(msg);
    } catch { this.onForeign(ev.pubkey, !!ev._stored); /* farklı anahtar (yanlış şifre) / bozuk mesaj */ }
  }

  async send(type, data = {}, to = null) {
    if (!this.pool || !this.key) return;
    const msg = { v: 2, type, from: this.selfId, to, data, ts: Date.now(), ep: this.getEpoch() || undefined };
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, this.key, enc.encode(JSON.stringify(msg)));
    await this.pool.publish(EPHEMERAL_KIND, [['t', this.topic]], `${b64(iv)}.${b64(ct)}`);
  }

  reconnect() { if (this.pool) this.pool.reconnectNow(); }

  get connected() { return this.pool ? this.pool.openCount : 0; }

  close() { if (this.pool) this.pool.close(); this.pool = null; }
}
