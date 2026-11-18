// CineSync — WebRTC görüntülü görüşme ağı (mesh)
// Her üye çifti arasında doğrudan bağlantı kurulur. Sinyalleşme şifreli oda kanalı üzerinden yapılır.
// "Perfect negotiation" deseni kullanılır: iki taraf aynı anda teklif gönderse bile çakışma çözülür.
//
// Dayanıklılık (v2.3):
//  • Her bağlantının bir oturum kimliği (sid) vardır. Karşı taraf bağlantısını baştan kurduysa (sayfa
//    yenilendi, bağlantı sıfırlandı) eski bağlantı otomatik atılır, yenisi kurulur.
//  • Bağlantı "disconnected" olursa birkaç saniye beklenir, düzelmezse ICE yeniden başlatılır;
//    "failed" kalırsa bağlantı tamamen yeniden kurulur. Sayfa öne gelince tüm bağlantılar kontrol edilir.
//  • Bağlantı kalitesi (gecikme, paket kaybı) ve konuşma seviyesi ölçülür.

const rid = () => Math.random().toString(36).slice(2, 10);

export class Mesh {
  constructor(room, { iceServers, onTrack, onPeerGone, onState }) {
    this.room = room;
    this.iceServers = iceServers;
    this.onTrack = onTrack;
    this.onPeerGone = onPeerGone;
    this.onState = onState || (() => {});
    this.peers = new Map();
    this.streams = { cam: null, screen: null };
    this.closed = false;
    this._h = {
      rtc: (data, from) => this._onSignal(from, data),
      join: (m) => { if (this._hasTracks()) this._ensure(m.id); },
      leave: (m) => this._close(m.id),
    };
    room.on('rtc', this._h.rtc);
    room.on('member-join', this._h.join);
    room.on('member-leave', this._h.leave);
    this.statsTimer = setInterval(() => this._pollStats(), 4000);
  }

  _hasTracks() {
    return [this.streams.cam, this.streams.screen].some((s) => s && s.getTracks().some((t) => t.readyState === 'live'));
  }

  _localTracks() {
    const list = [];
    for (const s of [this.streams.cam, this.streams.screen]) if (s) s.getTracks().forEach((t) => { if (t.readyState === 'live') list.push([t, s]); });
    return list;
  }

  setStream(kind, stream) {
    if (this.closed) return;
    this.streams[kind] = stream;
    if (this._hasTracks()) {
      for (const m of this.room.memberList()) if (!m.self) this._ensure(m.id);
    }
    for (const id of this.peers.keys()) this._syncSenders(id);
  }

  /** Mikrofon/kamera değişince (kulaklık takıldı, cihaz seçildi) yeniden pazarlık yapmadan izi değiştirir */
  async replaceTrack(oldTrack, newTrack) {
    for (const { pc } of this.peers.values()) {
      for (const sender of pc.getSenders()) {
        if (sender.track === oldTrack) { try { await sender.replaceTrack(newTrack); } catch (e) { console.warn('[rtc] replaceTrack', e); } }
      }
    }
  }

  _send(id, payload) {
    const peer = this.peers.get(id);
    return this.room.send('rtc', { ...payload, sid: peer?.sid }, id);
  }

  _ensure(id) {
    if (this.closed) return null;
    if (this.peers.has(id)) return this.peers.get(id);
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    const peer = { pc, sid: rid(), remoteSid: null, polite: this.room.selfId > id, makingOffer: false, ignoreOffer: false, candBuf: [], candTimer: null, remoteCands: [], state: 'new', quality: null, level: 0, discTimer: null, failTimer: null, createdAt: Date.now() };
    this.peers.set(id, peer);

    pc.onnegotiationneeded = async () => {
      try {
        peer.makingOffer = true;
        await pc.setLocalDescription();
        if (pc.localDescription) this._send(id, { description: pc.localDescription.toJSON() });
      } catch (e) { console.warn('[rtc] offer', e); } finally { peer.makingOffer = false; }
    };
    pc.onicecandidate = ({ candidate }) => {
      if (!candidate) return;
      peer.candBuf.push(candidate.toJSON());
      clearTimeout(peer.candTimer);
      peer.candTimer = setTimeout(() => {
        const candidates = peer.candBuf.splice(0);
        if (candidates.length && this.peers.get(id) === peer) this._send(id, { candidates });
      }, 250);
    };
    pc.ontrack = (ev) => {
      const stream = ev.streams[0] || new MediaStream([ev.track]);
      this.onTrack(id, stream, ev.track);
      ev.track.onunmute = () => this.onTrack(id, stream, ev.track);
    };
    const onConn = () => {
      if (this.peers.get(id) !== peer) return;
      const st = pc.connectionState || pc.iceConnectionState;
      peer.state = st;
      this.onState(id, st);
      clearTimeout(peer.discTimer);
      if (st === 'connected') { clearTimeout(peer.failTimer); peer.failTimer = null; }
      if (st === 'disconnected') peer.discTimer = setTimeout(() => this._restart(id), 3000);
      if (st === 'failed') {
        this._restart(id);
        if (!peer.failTimer) peer.failTimer = setTimeout(() => { if (this.peers.get(id) === peer && peer.pc.connectionState !== 'connected') this.reset(id); }, 15000);
      }
    };
    pc.onconnectionstatechange = onConn;
    pc.oniceconnectionstatechange = () => { if (!('connectionState' in pc)) onConn(); };
    this._syncSenders(id);
    return peer;
  }

  _restart(id) {
    const peer = this.peers.get(id);
    if (!peer || this.closed) return;
    const st = peer.pc.connectionState;
    if (st === 'connected' || st === 'closed') return;
    try { peer.pc.restartIce(); } catch {}
  }

  /** Bağlantıyı tamamen baştan kurar (yeni oturum kimliğiyle) */
  reset(id, notify = true) {
    if (this.closed) return;
    this._close(id, true);
    if (notify) this.room.send('rtc', { reset: true }, id); // karşı taraf da eski bağlantıyı atsın
    if (this._hasTracks()) this._ensure(id);
  }

  /** Sayfa öne gelince / ağ değişince: kopuk bağlantıları onar */
  heal() {
    for (const [id, peer] of this.peers) {
      const st = peer.pc.connectionState;
      if (st === 'failed' || st === 'disconnected') this._restart(id);
      else if (st === 'new' || st === 'connecting') { if (Date.now() - peer.createdAt > 20000) this.reset(id); }
      else if (st === 'closed') this.reset(id);
    }
    if (this._hasTracks()) for (const m of this.room.memberList()) if (!m.self && !this.peers.has(m.id)) this._ensure(m.id);
  }

  _syncSenders(id) {
    const peer = this.peers.get(id);
    if (!peer) return;
    const { pc } = peer;
    if (pc.signalingState === 'closed') return;
    const wanted = this._localTracks();
    const senders = pc.getSenders();
    for (const sender of senders) {
      if (sender.track && !wanted.some(([t]) => t === sender.track)) {
        try { pc.removeTrack(sender); } catch {}
      }
    }
    for (const [track, stream] of wanted) {
      if (!senders.some((s) => s.track === track)) {
        try { pc.addTrack(track, stream); } catch (e) { console.warn('[rtc] addTrack', e); }
      }
    }
  }

  async _onSignal(from, data) {
    if (this.closed || !data || typeof data !== 'object') return;
    const { description, candidates, sid } = data;
    if (data.reset) { if (this.peers.has(from)) { this._close(from, true); } if (this._hasTracks()) this._ensure(from); return; }
    let peer = this.peers.get(from);
    // Eski oturuma ait bir yanıt geldi: iki taraf da temiz bağlantıyla yeniden başlasın
    if (peer && description?.type === 'answer' && sid && peer.remoteSid && sid !== peer.remoteSid) { this.reset(from); return; }
    // Karşı taraf yeni bir oturumla teklif gönderdiyse eski bağlantıyı at
    if (peer && description?.type === 'offer' && sid && peer.remoteSid && sid !== peer.remoteSid) { this._close(from, true); peer = null; }
    peer = peer || this._ensure(from);
    if (!peer) return;
    const { pc } = peer;
    try {
      if (description && typeof description.type === 'string') {
        const collision = description.type === 'offer' && (peer.makingOffer || pc.signalingState !== 'stable');
        peer.ignoreOffer = !peer.polite && collision;
        if (peer.ignoreOffer) return;
        if (description.type === 'answer' && pc.signalingState !== 'have-local-offer') return; // geç gelen/yinelenen yanıt
        await pc.setRemoteDescription(description);
        if (sid) peer.remoteSid = sid;
        const pending = peer.remoteCands.splice(0);
        for (const c of pending) { if (!c.sid || !peer.remoteSid || c.sid === peer.remoteSid) { try { await pc.addIceCandidate(c.c); } catch {} } }
        if (description.type === 'offer') {
          await pc.setLocalDescription();
          if (pc.localDescription) this._send(from, { description: pc.localDescription.toJSON() });
        }
      }
      if (Array.isArray(candidates)) {
        for (const c of candidates) {
          if (!pc.remoteDescription || (sid && peer.remoteSid && sid !== peer.remoteSid)) { if (peer.remoteCands.length < 200) peer.remoteCands.push({ c, sid }); continue; }
          try { await pc.addIceCandidate(c); } catch (e) { if (!peer.ignoreOffer) console.warn('[rtc] ice', e?.message || e); }
        }
      }
    } catch (e) { console.warn('[rtc] signal', e?.message || e); }
  }

  async _pollStats() {
    if (this.closed) return;
    for (const [id, peer] of this.peers) {
      const { pc } = peer;
      if (pc.connectionState !== 'connected') { peer.quality = pc.connectionState === 'connecting' || pc.connectionState === 'new' ? 'connecting' : 'down'; this.onState(id, pc.connectionState, peer.quality); continue; }
      try {
        // Kapanan/değişen bağlantıda getStats asılı kalabilir: 2,5 sn sınır
        const stats = await Promise.race([pc.getStats(), new Promise((r) => setTimeout(() => r(null), 2500))]);
        if (!stats || this.closed || this.peers.get(id) !== peer || pc.signalingState === 'closed') continue;
        let rtt = null, lost = 0, recv = 0;
        stats.forEach((r) => {
          if (r.type === 'candidate-pair' && (r.nominated || r.selected) && r.state === 'succeeded' && Number.isFinite(r.currentRoundTripTime)) rtt = r.currentRoundTripTime * 1000;
          if (r.type === 'inbound-rtp' && !r.isRemote) { lost += r.packetsLost || 0; recv += r.packetsReceived || 0; }
        });
        const dLost = lost - (peer._lost || 0), dRecv = recv - (peer._recv || 0);
        peer._lost = lost; peer._recv = recv;
        const loss = dRecv + dLost > 0 ? (dLost / (dRecv + dLost)) * 100 : 0;
        peer.rtt = rtt; peer.loss = loss;
        peer.quality = (rtt !== null && rtt > 600) || loss > 10 ? 'poor' : (rtt !== null && rtt > 250) || loss > 3 ? 'fair' : 'good';
        this.onState(id, 'connected', peer.quality);
      } catch {}
    }
  }

  /** Karşıdan gelen sesin anlık seviyesi (0–1); konuşma göstergesi ve otomatik kısma için */
  levels() {
    const out = new Map();
    for (const [id, { pc }] of this.peers) {
      let lvl = 0;
      try {
        for (const r of pc.getReceivers()) {
          if (r.track?.kind !== 'audio' || !r.getSynchronizationSources) continue;
          for (const s of r.getSynchronizationSources()) if (Number.isFinite(s.audioLevel) && performance.timeOrigin + performance.now() - s.timestamp < 1000) lvl = Math.max(lvl, s.audioLevel);
        }
      } catch {}
      out.set(id, lvl);
    }
    return out;
  }

  info(id) { const p = this.peers.get(id); return p ? { state: p.pc.connectionState, quality: p.quality, rtt: p.rtt, loss: p.loss } : null; }

  _close(id, keepRemote = false) {
    const peer = this.peers.get(id);
    if (!peer) return;
    clearTimeout(peer.discTimer); clearTimeout(peer.failTimer); clearTimeout(peer.candTimer);
    try { peer.pc.onnegotiationneeded = null; peer.pc.onicecandidate = null; peer.pc.ontrack = null; peer.pc.onconnectionstatechange = null; peer.pc.close(); } catch {}
    this.peers.delete(id);
    if (!keepRemote) this.onPeerGone && this.onPeerGone(id);
  }

  closeAll() {
    this.closed = true;
    clearInterval(this.statsTimer);
    this.room.off?.('rtc', this._h.rtc); this.room.off?.('member-join', this._h.join); this.room.off?.('member-leave', this._h.leave);
    for (const id of Array.from(this.peers.keys())) this._close(id);
  }
}
