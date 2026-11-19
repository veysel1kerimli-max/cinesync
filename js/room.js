// CineSync — oda protokolü
// Üyelik (presence), paylaşılan oynatma durumu, sohbet geçmişi ve olay dağıtımı.
// Sunucu yoktur: her üye durumu tutar; yeni gelene en eski üye anlık görüntü (snapshot) gönderir.

import { RoomChannel } from './net/room-channel.js';

const HEARTBEAT_MS = 6000;
const AWAY_MS = 20000;            // bu süre ses gelmezse "bağlantı zayıf / arka planda" gösterilir
const MEMBER_TIMEOUT_MS = 180000; // telefon cebe girse, sekme arka plana alınsa bile 3 dk boyunca odada sayılır
const CLOCK_PING_MS = 15000;
const CHAT_KEEP = 80;

export function randomId(len = 12) {
  const a = 'abcdefghijkmnpqrstuvwxyz23456789';
  return Array.from(crypto.getRandomValues(new Uint8Array(len)), (b) => a[b % a.length]).join('');
}

export function generateRoomCode() {
  const a = 'abcdefghjkmnpqrstuvwxyz23456789';
  return Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => a[b % a.length]).join('');
}

const TR_MAP = { ç: 'c', ğ: 'g', ı: 'i', i̇: 'i', ö: 'o', ş: 's', ü: 'u', â: 'a', î: 'i', û: 'u' };
/**
 * Oda kodunu tek biçime getirir: küçük harf (Türkçe kurallarıyla), Türkçe harfler Latin karşılığına,
 * boşluk/alt çizgi tireye; yalnızca a–z, 0–9 ve tire kalır; en fazla 32 karakter.
 * "Film Gecesi Çğ" → "film-gecesi-cg"
 */
export function normalizeRoomCode(raw) {
  return String(raw || '').trim().toLocaleLowerCase('tr-TR')
    .replace(/i̇/g, 'i').replace(/[çğıöşüâîû]/g, (c) => TR_MAP[c] || c)
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[\s_.]+/g, '-').replace(/[^a-z0-9-]/g, '').replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 32).replace(/-+$/, '');
}
/** Özel kod doğrulama: hata mesajı (geçerliyse boş) */
export function validateRoomCode(raw) {
  const c = normalizeRoomCode(raw);
  if (!c) return 'Oda kodu boş olamaz.';
  if (c.length < 4) return 'Oda kodu en az 4 karakter olmalı (harf, rakam veya tire).';
  const full = String(raw || '').trim().replace(/[\s_.]+/g, '-').replace(/[^\p{L}\p{N}-]/gu, '');
  if (full.length > 32) return 'Oda kodu en fazla 32 karakter olabilir.';
  return '';
}

/** Bir oda kodunda şu an birileri var mı? Kimseyi odaya eklemeden (iz bırakmadan) yoklar. */
export async function probeRoom({ code, password = '', relays, waitMs = 3000 }) {
  const selfId = randomId();
  const start = Date.now();
  const seen = new Set(), foreign = new Set();
  const ch = new RoomChannel({
    roomCode: code, password, selfId, relays,
    onMessage: (m) => { if (m.from && !m.stored && m.type !== 'probe' && m.type !== 'bye' && (Number(m.ts) || 0) > start - 3000) seen.add(m.from); },
    onForeign: (pk, stored) => { if (!stored) foreign.add(pk); },
  });
  await ch.open();
  // Röleler bağlanınca yokla; varsa üyeler "here" ile cevap verir (kalp atışları da sayılır)
  const t1 = setTimeout(() => ch.send('probe', {}).catch(() => {}), 700);
  const t2 = setTimeout(() => ch.send('probe', {}).catch(() => {}), 1600);
  await new Promise((r) => setTimeout(r, waitMs));
  clearTimeout(t1); clearTimeout(t2);
  const relaysOpen = ch.connected;
  ch.close();
  return { occupied: seen.size > 0 || foreign.size > 0, members: seen.size, locked: seen.size === 0 && foreign.size > 0, relaysOpen, ms: Date.now() - start };
}

/** Oturumdan bağımsız (bağlantı, üyelik, saat) mesajlar */
const EPOCH_FREE = new Set(['hello', 'presence', 'bye', 'rtc', 'tping', 'tpong', 'syncreq']);
const epochTime = (ep) => parseInt(String(ep || '').split('-')[0], 36) || 0;
/** a, b'den daha eski bir oturum mu? (eski oturum kazanır; eşitlikte metin sırası) */
const olderEpoch = (a, b) => epochTime(a) < epochTime(b) || (epochTime(a) === epochTime(b) && String(a) < String(b));

export class Room {
  constructor({ code, name, relays, color, password = '' }) {
    this.color = color || null;
    this.code = code;
    this.password = password;
    // Oda oturumu (epoch): odaya ilk giren üretir, sonra gelenler devralır. Oda tamamen boşalınca kimse
    // durumu saklamadığı (röleler geçici olayları saklamaz) için aynı koda sonradan gelen yeni bir oturum açar;
    // eski oturumdan kalan hiçbir şey (sohbet, video, kilit) yeniden oynatılmaz.
    this.epoch = null;
    this.foreign = new Set();
    this._epNudge = new Map();
    this.decrypted = 0;
    this.selfId = randomId();
    this.joinedAt = Date.now();
    this.name = name;
    this.relays = relays;
    this.handlers = {};
    this.members = new Map();
    this.chat = [];
    this.media = null; // {ver, byId, byName, label, src, playing, time, refAt, screen}
    this.queue = null; // ortak izleme sırası: {ver, byId, items:[{id,url,title,provider}], cur, auto}
    this.selfInfo = { mic: false, cam: false, camStreamId: null, screenStreamId: null };
    this.members.set(this.selfId, this._memberRecord({ id: this.selfId, name, color: this.color, joinedAt: this.joinedAt, self: true }));
    this.clock = new Map(); // üye -> {offset (onun saati - benim saatim, ms), rtt, samples[]}
    this.left = false;
  }

  on(evt, fn) { (this.handlers[evt] ||= []).push(fn); return this; }
  emit(evt, ...args) { (this.handlers[evt] || []).forEach((fn) => { try { fn(...args); } catch (e) { console.warn('[room]', evt, e); } }); }
  off(evt, fn) { this.handlers[evt] = (this.handlers[evt] || []).filter((f) => f !== fn); }

  _memberRecord(m) {
    return { id: m.id, name: String(m.name || 'Misafir').slice(0, 24), color: typeof m.color === 'string' && /^hsl\(\d{1,3} \d{1,3}% \d{1,3}%\)$/.test(m.color) ? m.color : null, joinedAt: m.joinedAt || Date.now(), lastSeen: Date.now(), self: !!m.self,
      mic: !!m.mic, cam: !!m.cam, camStreamId: m.camStreamId || null, screenStreamId: m.screenStreamId || null, hidden: !!m.hidden, away: false };
  }

  async join() {
    this.channel = new RoomChannel({
      roomCode: this.code, password: this.password, selfId: this.selfId, relays: this.relays,
      onMessage: (m) => this._onMessage(m),
      onStatus: (s) => this.emit('status', s),
      onForeign: (pk) => this._onForeign(pk),
      getEpoch: () => { if (this._lastBeat && Date.now() - this._lastBeat > MEMBER_TIMEOUT_MS) this._freshStart(); return this.epoch; },
    });
    await this.channel.open();
    this._sendPresence('hello');
    this._lastBeat = Date.now();
    // Kimse cevap vermezse oturumu biz başlatırız
    this._epochTimer = setTimeout(() => { if (!this.epoch && !this.left) this._found(); }, 3000);
    // Röle bağlantıları gecikirse, ilk saniyelerde birkaç kez daha duyur
    [1500, 4000, 9000].forEach((d) => setTimeout(() => this.channel && this._sendPresence('presence'), d));
    this.hbTimer = setInterval(() => {
      // Cihaz uzun süre dondurulduysa (telefon cebe girdi, sekme uyutuldu) diğerleri bizi çoktan odadan
      // çıkarmış ve oda boşalıp yeniden kurulmuş olabilir: eski durumu taşımadan temiz başla.
      if (Date.now() - this._lastBeat > MEMBER_TIMEOUT_MS) this._freshStart();
      this._lastBeat = Date.now();
      this._sendPresence('presence');
    }, HEARTBEAT_MS);
    this.pruneTimer = setInterval(() => this._prune(), 4000);
    this.clockTimer = setInterval(() => this._pingClocks(), CLOCK_PING_MS);
    // Yalnızca sayfa gerçekten kapanıyorsa (bfcache'e girmiyorsa) "hoşça kal" deriz.
    // Uygulama değiştirme, ekran kilidi, sekme değiştirme odadan çıkarmaz.
    this._onPageHide = (e) => { if (!e.persisted && this.channel) this.channel.send('bye', {}); };
    window.addEventListener('pagehide', this._onPageHide);
  }

  _found() {
    this.epoch = `${Date.now().toString(36)}-${randomId(6)}`;
    this.emit('epoch', this.epoch, { founded: true });
  }

  _adopt(ep) {
    const had = !!this.epoch;
    clearTimeout(this._epochTimer);
    this.epoch = ep;
    if (had) {
      // Başka (daha eski) bir oturum varmış: bizim kısa ömürlü durumumuzu bırakıp onunkini al
      this.media = null; this.chat = []; this.queue = null;
      this.emit('reset', { reason: 'merge' });
      this._sendPresence('hello');
    }
    this.emit('epoch', ep, { founded: false });
  }

  /** Uzun süre uzak kaldıktan sonra: eski oturumu ve durumu bırak, odaya yeni gelmiş gibi katıl */
  _freshStart() {
    if (this.left) return;
    this._lastBeat = Date.now();
    this.joinedAt = Date.now();
    const me = this.members.get(this.selfId); if (me) me.joinedAt = this.joinedAt;
    this.epoch = null; this.media = null; this.chat = []; this.queue = null; this.clock.clear();
    for (const id of Array.from(this.members.keys())) if (id !== this.selfId) this._removeMember(id);
    this.emit('reset', { reason: 'stale' });
    this._sendPresence('hello');
    clearTimeout(this._epochTimer);
    this._epochTimer = setTimeout(() => { if (!this.epoch && !this.left) this._found(); }, 3000);
  }

  _onForeign(pk, stored) {
    if (stored) return;
    // Konuya gelen ama çözülemeyen olaylar: odada farklı şifre kullanan biri var (ya da yanlış şifre)
    this.foreign.add(pk);
    if (this.foreign.size && this.decrypted === 0 && !this._pwWarned && Date.now() - this.joinedAt > 2500) { this._pwWarned = true; this.emit('password-mismatch'); }
  }

  async leave() {
    this.left = true;
    clearTimeout(this._epochTimer);
    clearInterval(this.hbTimer); clearInterval(this.pruneTimer); clearInterval(this.clockTimer);
    window.removeEventListener('pagehide', this._onPageHide);
    try { await this.channel.send('bye', {}); } catch {}
    const ch = this.channel;
    setTimeout(() => { try { ch && ch.close(); } catch {} }, 300);
  }

  /** Arka plandan dönünce / ağ geri gelince: röleleri yenile, kendini yeniden duyur, durum iste */
  resume() {
    if (this.left || !this.channel) return;
    if (this._lastBeat && Date.now() - this._lastBeat > MEMBER_TIMEOUT_MS) this._freshStart();
    this.channel.reconnect();
    this._sendPresence('hello');
    setTimeout(() => !this.left && this._sendPresence('presence'), 1500);
    this.requestSync();
    this._pingClocks();
  }

  /** Görünürlük bilgisini paylaş (diğerleri "arka planda" gösterir, odadan çıkarmaz) */
  setHidden(hidden) {
    if (this.selfInfo.hidden === hidden) return;
    this.selfInfo.hidden = hidden;
    if (this.channel && !this.left) this._sendPresence('presence');
  }

  presencePayload() {
    return { name: this.name, color: this.color, joinedAt: this.joinedAt, ...this.selfInfo };
  }

  _sendPresence(type, to = null) {
    if (!this.channel || this.left) return;
    this.channel.send(type, this.presencePayload(), to).catch(() => {});
  }

  updateSelf(partial) {
    Object.assign(this.selfInfo, partial);
    Object.assign(this.members.get(this.selfId), partial);
    this.emit('members', this.memberList());
    if (this.channel) this._sendPresence('presence');
  }

  memberList() {
    return Array.from(this.members.values()).sort((a, b) => a.joinedAt - b.joinedAt);
  }

  _upsertMember(id, data) {
    const isNew = !this.members.has(id);
    const wasAway = !isNew && this.members.get(id).away;
    const rec = this._memberRecord({ id, ...data });
    this.members.set(id, rec);
    if (isNew) { this.emit('member-join', rec); this._pingClocks(id); }
    else if (wasAway) this.emit('member-back', rec);
    this.emit('members', this.memberList());
    return isNew;
  }

  _prune() {
    const now = Date.now();
    let changed = false;
    for (const [id, m] of this.members) {
      if (m.self) continue;
      if (now - m.lastSeen > MEMBER_TIMEOUT_MS) { this._removeMember(id); continue; }
      const away = now - m.lastSeen > AWAY_MS;
      if (away !== m.away) { m.away = away; changed = true; this.emit(away ? 'member-away' : 'member-back', m); }
    }
    if (changed) this.emit('members', this.memberList());
  }

  // ---------- Saat eşitleme (NTP benzeri) ----------
  // Her üyeye ara sıra "ping" atılır; gidiş-dönüş süresi (RTT) en kısa örnekten saat farkı hesaplanır.
  // Böylece "şu an 12.4. saniyedeyiz" bilgisi rölelerin gecikmesinden bağımsız, gönderildiği ana göre yorumlanır.
  _pingClocks(only) {
    if (!this.channel || this.left) return;
    for (const m of this.members.values()) {
      if (m.self || (only && m.id !== only)) continue;
      this.channel.send('tping', { t0: Date.now() }, m.id).catch(() => {});
    }
  }

  _onClock(from, { t0, t1 }) {
    const t3 = Date.now();
    const rtt = t3 - t0;
    if (!(rtt >= 0 && rtt < 20000) || !Number.isFinite(t1)) return;
    const offset = t1 - (t0 + t3) / 2; // onun saati - benim saatim
    const c = this.clock.get(from) || { samples: [] };
    c.samples.push({ rtt, offset });
    if (c.samples.length > 8) c.samples.shift();
    const best = c.samples.reduce((a, b) => (b.rtt < a.rtt ? b : a));
    c.offset = best.offset; c.rtt = best.rtt;
    this.clock.set(from, c);
    this.emit('clock', from, c);
  }

  /** Göndericinin saatine göre damgalanmış bir anı benim saatime çevirir */
  localTimeOf(from, at) {
    const c = this.clock.get(from);
    if (!Number.isFinite(at)) return null;
    if (c && Number.isFinite(c.offset)) return at - c.offset;
    return null;
  }

  /** Oynatma durumunun yetkilisinden anlık konum ister (döndükten sonra, tampon bittiğinde) */
  requestSync() {
    if (!this.channel || this.left || !this.media || this.media.byId === this.selfId) return;
    this.channel.send('syncreq', { ver: this.media.ver }, this.media.byId).catch(() => {});
  }

  _removeMember(id) {
    const m = this.members.get(id);
    if (!m) return;
    this.members.delete(id);
    this.emit('member-leave', m);
    this.emit('members', this.memberList());
  }

  _isOldestExcept(newId) {
    const others = this.memberList().filter((m) => m.id !== newId);
    return others.length && others[0].id === this.selfId;
  }

  // ---------- Oynatma durumu ----------

  /** Şu anki konum (sn), yerel saatle hesaplanır (cihaz saatleri farklı olsa bile doğru) */
  positionNow() {
    if (!this.media) return 0;
    const rate = Number(this.media.rate) > 0 ? Number(this.media.rate) : 1;
    return this.media.time + (this.media.playing ? ((Date.now() - this.media.refAt) / 1000) * rate : 0);
  }

  setMedia(partial, label) {
    if (!this.channel || this.left) return;
    if (!this.epoch) this._found();
    const next = {
      ...(this.media || { playing: false, time: 0, src: null, screen: null }),
      ...partial,
      ver: (this.media?.ver || 0) + 1, byId: this.selfId, byName: this.name, label: label || '',
    };
    this.media = { ...next, refAt: Date.now() };
    this.channel.send('media', this.mediaSnapshot()).catch(() => {});
    this.emit('media', this.media, { local: true });
  }

  mediaSnapshot() {
    if (!this.media) return null;
    const { refAt, ...rest } = this.media;
    return { ...rest, time: this.positionNow(), at: Date.now() };
  }

  /** Gelen durumun "time" değerinin geçerli olduğu yerel an: saat farkı biliniyorsa gönderim anı, yoksa varış anı - yarım RTT tahmini */
  _refAtFor(from, at) {
    const local = this.localTimeOf(from, at);
    const now = Date.now();
    if (local !== null && local <= now + 50 && now - local < 10000) return local;
    return now - 120; // ortalama röle gecikmesi tahmini
  }

  _acceptMedia(data, fromSnapshot = false, from = null) {
    if (!data || typeof data !== 'object') return false;
    const cur = this.media;
    const newer = !cur || data.ver > cur.ver || (data.ver === cur.ver && data.byId > cur.byId && data.byId !== cur.byId);
    if (!newer) return false;
    // Kilit: oda sahibi kontrolü kilitlediyse yalnızca onun (veya kilidi açan sahibin) değişiklikleri kabul edilir
    if (!fromSnapshot && cur && cur.locked && cur.hostId && data.byId !== cur.hostId && this.members.has(cur.hostId)) return false;
    const { at, ...rest } = data;
    this.media = { ...rest, refAt: this._refAtFor(from || data.byId, at) };
    this.emit('media', this.media, { local: false, snapshot: fromSnapshot });
    return true;
  }

  /** Son işlemi yapan üye, oynatıcısının GERÇEK konumunu periyodik yayınlar (tamponlama kaymasını düzeltir) */
  sendTick(actualTime, to = null) {
    if (!this.channel || this.left) return;
    if (!this.media || this.media.byId !== this.selfId || this.media.screen) return;
    if (!this.media.playing && !to) return;
    const time = Number.isFinite(actualTime) ? actualTime : this.positionNow();
    this.media.time = time; this.media.refAt = Date.now();
    this.channel.send('tick', { ver: this.media.ver, time, at: Date.now(), playing: !!this.media.playing }, to).catch(() => {});
  }

  // ---------- Ortak izleme sırası (playlist) ----------
  // Sıra, oynatma durumundan ayrı sürümlenir: son yazan kazanır (sürüm, eşitlikte üye kimliği).
  // Kontrol kilitliyse yalnızca oda sahibinin değişiklikleri kabul edilir.

  static cleanQueue(q) {
    if (!q || typeof q !== 'object') return null;
    const items = (Array.isArray(q.items) ? q.items : []).slice(0, 50).filter((it) => it && typeof it.url === 'string' && /^https?:\/\//i.test(it.url) && it.url.length <= 2000)
      .map((it) => ({ id: String(it.id || randomId(8)).slice(0, 16), url: it.url, title: String(it.title || '').slice(0, 120), provider: String(it.provider || '').slice(0, 40), by: String(it.by || '').slice(0, 24) }));
    const cur = items.some((it) => it.id === q.cur) ? q.cur : null;
    return { ver: Number(q.ver) || 0, byId: String(q.byId || ''), items, cur, auto: q.auto !== false };
  }

  setQueue(partial) {
    if (!this.channel || this.left) return;
    if (!this.epoch) this._found();
    const base = this.queue || { items: [], cur: null, auto: true };
    const next = Room.cleanQueue({ ...base, ...partial, ver: (this.queue?.ver || 0) + 1, byId: this.selfId });
    this.queue = next;
    this.channel.send('queue', next).catch(() => {});
    this.emit('queue', next, { local: true });
  }

  _acceptQueue(data, fromSnapshot) {
    const q = Room.cleanQueue(data);
    if (!q) return false;
    const cur = this.queue;
    const newer = !cur || q.ver > cur.ver || (q.ver === cur.ver && q.byId > cur.byId);
    if (!newer) return false;
    const md = this.media;
    if (!fromSnapshot && md && md.locked && md.hostId && q.byId !== md.hostId && this.members.has(md.hostId)) return false;
    this.queue = q;
    this.emit('queue', q, { local: false });
    return true;
  }

  // ---------- Sohbet & olaylar ----------

  /** Bir sohbet mesajına emoji tepkisi ekler/kaldırır (herkeste aynı sayılır) */
  reactChat(id, e, on) {
    const ok = this._applyReact(id, e, this.selfId, on);
    if (ok && this.channel && !this.left) this.channel.send('chatreact', { id, e, on: !!on }).catch(() => {});
    return ok;
  }

  _onChatReact(data, from) {
    if (!data || typeof data.id !== 'string') return;
    this._applyReact(data.id, data.e, from, !!data.on);
  }

  _applyReact(id, e, who, on) {
    if (typeof e !== 'string' || e.length > 8 || !/^\p{Extended_Pictographic}/u.test(e)) return false;
    const msg = this.chat.find((m) => m.id === id);
    if (!msg) return false;
    const r = (msg.reacts ||= {});
    const set = new Set(Array.isArray(r[e]) ? r[e] : []);
    if (on) set.add(who); else set.delete(who);
    if (set.size) r[e] = [...set].slice(0, 100); else delete r[e];
    if (Object.keys(r).length > 12) return false;
    this.emit('chat-react', msg);
    return true;
  }


  sendChat(text, reply) {
    const msg = { id: randomId(8), fromId: this.selfId, name: this.name, text: String(text).slice(0, 1000), ts: Date.now() };
    if (reply && reply.id) msg.reply = { id: String(reply.id).slice(0, 16), name: String(reply.name || '').slice(0, 24), text: String(reply.text || '').slice(0, 140) };
    this._pushChat(msg);
    if (this.channel && !this.left) this.channel.send('chat', msg).catch(() => {});
  }

  /** Görünen adı değiştirir ve herkese duyurur */
  rename(name) {
    this.name = String(name || '').slice(0, 24) || this.name;
    this.members.get(this.selfId).name = this.name;
    this.emit('members', this.memberList());
    if (this.channel) this._sendPresence('presence');
  }

  systemNote(text) { this.emit('system', text); }

  _pushChat(msg) {
    if (this.chat.some((m) => m.id === msg.id)) return;
    if (msg.reacts && typeof msg.reacts === 'object') {
      const clean = {};
      for (const [e, ids] of Object.entries(msg.reacts).slice(0, 12)) if (typeof e === 'string' && e.length <= 8 && /^\p{Extended_Pictographic}/u.test(e) && Array.isArray(ids)) clean[e] = ids.filter((x) => typeof x === 'string').slice(0, 100);
      msg.reacts = clean;
    } else delete msg.reacts;
    this.chat.push(msg);
    this.chat.sort((a, b) => a.ts - b.ts);
    if (this.chat.length > CHAT_KEEP) this.chat.shift();
    this.emit('chat', msg);
  }

  send(type, data, to) {
    if (!this.channel || this.left) return Promise.resolve();
    return this.channel.send(type, data, to).catch((e) => { console.warn('[room] send', type, e); });
  }

  _onMessage(msg) {
    if (this.left || !msg || typeof msg !== 'object') return;
    const { type, from } = msg;
    const data = msg.data && typeof msg.data === 'object' ? msg.data : {};
    if (typeof from !== 'string' || from === this.selfId) return;
    // Odaya girmeden önce gönderilmiş (rölede kısa süre saklanmış) olaylar yeniden oynatılmaz: oda durumu
    // yalnızca şu an odada olanlardan gelir. Saat farkı payı: 3 sn (yalnızca girişin ilk 10 sn'sinde).
    const ts = Number(msg.ts) || 0;
    if (msg.stored && ts < this.joinedAt + 1000) return;
    if (Date.now() - this.joinedAt < 10000 && ts && ts < this.joinedAt - 3000) return;
    if (type === 'bye' && msg.ep && msg.ep !== this.epoch) { this._removeMember?.(from); return; }
    if (type === 'probe') { this.channel.send('here', {}, from).catch(() => {}); return; }
    if (type === 'here') return;
    this.decrypted++;
    // Oturum (epoch) kontrolü
    const ep = typeof msg.ep === 'string' ? msg.ep.slice(0, 40) : null;
    if (ep && ep !== this.epoch) {
      if (!this.epoch || olderEpoch(ep, this.epoch)) this._adopt(ep);
      else {
        // Daha yeni (ya da eski kalmış) bir oturumdan geliyor: oda içeriğini (video, sohbet, kilit…) alma;
        // bağlantı/üyelik mesajları geçer. Kendimizi tanıtalım ki bizim (daha eski) oturuma katılsın.
        const now = Date.now();
        if (now - (this._epNudge.get(from) || 0) > 2000) { this._epNudge.set(from, now); this._sendPresence('presence', from); }
        if (!EPOCH_FREE.has(type)) return;
      }
    }
    const known = this.members.get(from);
    if (known) {
      known.lastSeen = Date.now();
      if (known.away) { known.away = false; this.emit('member-back', known); this.emit('members', this.memberList()); }
    } else if (type !== 'bye' && type !== 'hello' && type !== 'presence') {
      // Üyeyi tanımıyoruz (ör. biz arka plandayken silindi): "hello" ile tanışırız, o da kendini tanıtır
      this._askedWho ||= new Map();
      if (Date.now() - (this._askedWho.get(from) || 0) > 10000) { this._askedWho.set(from, Date.now()); this._sendPresence('hello', from); }
    }
    switch (type) {
      case 'tping': this.channel.send('tpong', { t0: data.t0, t1: Date.now() }, from).catch(() => {}); break;
      case 'tpong': this._onClock(from, data); break;
      case 'syncreq': this.sendTick(undefined, from); break;
      case 'hello': {
        this._upsertMember(from, data);
        this._sendPresence('presence', from);
        if (this._isOldestExcept(from)) {
          this.channel.send('snapshot', { media: this.mediaSnapshot(), chat: this.chat.slice(-40), queue: this.queue }, from);
        }
        break;
      }
      case 'presence': this._upsertMember(from, data); break;
      case 'bye': this._removeMember(from); break;
      case 'snapshot':
        if (ep && ep !== this.epoch) break;
        if (data.media) this._acceptMedia(data.media, true, from);
        if (data.queue) this._acceptQueue(data.queue, true);
        (Array.isArray(data.chat) ? data.chat : []).forEach((m) => m && typeof m.text === 'string' && this._pushChat(m));
        break;
      case 'media':
        if (!known) this._upsertMember(from, { name: data.byName });
        this._acceptMedia(data, false, from);
        break;
      case 'tick':
        if (this.media && data.ver === this.media.ver && this.media.byId === from && Number.isFinite(data.time)) {
          this.media.time = data.time; this.media.refAt = this._refAtFor(from, data.at);
          this.emit('tick', this.positionNow());
        }
        break;
      case 'queue': this._acceptQueue(data, false); break;
      case 'chatreact': this._onChatReact(data, from); break;
      case 'chat':
        if (!data || typeof data.text !== 'string') break;
        if (data.reply && typeof data.reply !== 'object') delete data.reply;
        this._pushChat(data); break;
      default: this.emit(type, data, from);
    }
  }
}
