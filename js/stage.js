// CineSync — sahne (oynatıcı motorları)
// Kaynağın türüne göre doğru motoru seçer:
//   video   : HTML5 <video> + hls.js (MP4, WebM, HLS)         -> tam senkron
//   youtube : YouTube IFrame API                              -> tam senkron
//   vimeo   : Vimeo Player API                                -> tam senkron
//   embed   : resmi gömme oynatıcıları (Dailymotion, Twitch…) -> kaynak senkron, oynatma yerel
//   web     : gömülmeye izin veren web siteleri                -> adres senkron
//   blocked : gömülmeyi yasaklayan siteler                     -> "yeni sekmede aç" kartı
//   screen  : bir üyenin ekran/sekme paylaşımı (WebRTC)

import { $, loadScript, escapeHtml } from './ui/dom.js';
import { icon } from './ui/icons.js';
import { HLS_SRC } from './config.js';

const SUPPRESS_MS = 1200;

export class Stage {
  constructor(root, { onUserAction, onEngine, onBlockedAction, onBuffer, onEnded, hlsSrc } = {}) {
    this.root = root;
    const userAction = onUserAction || (() => {});
    // Tarayıcının kendisi (sekme arka plana alındı, ekran kilitlendi) oynatıcıyı durdurursa bu bir
    // kullanıcı işlemi değildir: odadaki herkesi durdurmamalı. Görünürlük değişiminden sonraki kısa süre de yok sayılır.
    this._visAt = 0;
    document.addEventListener('visibilitychange', () => { this._visAt = Date.now(); });
    window.addEventListener('pagehide', () => { this._visAt = Date.now(); });
    this.onUserAction = (a) => {
      if (!a.fromClick && (document.hidden || Date.now() - this._visAt < 1500)) return;
      try { userAction(a); } catch (e) { console.warn('[stage] action', e); }
    };
    this.onBuffer = onBuffer || (() => {});
    // Video sona erdi (ortak sıradaki bir sonraki kaynağa geçmek için)
    this.onEnded = (engine) => { try { (onEnded || (() => {}))(engine); } catch (e) { console.warn('[stage] ended', e); } };
    this.subsOffset = 0; this._subsVtt = ''; this._subsLabel = '';
    this._loadSeq = 0;
    this.nudge = 1;
    this.onEngine = onEngine || (() => {});
    this.onBlockedAction = onBlockedAction || (() => {});
    this.hlsSrc = hlsSrc || HLS_SRC;
    this.engine = 'empty';
    this.key = '';
    this.rate = 1;
    this.subsUrl = null;
    this.suppressUntil = 0;
    this.video = $('#stageVideo', root);
    this.screenVideo = $('#stageScreen video', root);
    this.frame = $('#stageFrame iframe', root);
    this.hls = null;
    this.yt = null; this.ytReady = false;
    this.vimeo = null; this.vimeoState = { time: 0, duration: 0, paused: true };
    this._bindVideo();
    setInterval(() => this._watchSeeks(), 1000);
  }

  get controllable() { return ['video', 'youtube', 'vimeo'].includes(this.engine); }
  _suppressed() { return Date.now() < this.suppressUntil; }
  _suppress(ms = SUPPRESS_MS) { this.suppressUntil = Date.now() + ms; }

  _show(engine) {
    const ids = { video: '#stageVideo', youtube: '#stageYT', vimeo: '#stageVimeo', embed: '#stageFrame', web: '#stageFrame', blocked: '#stageBlocked', screen: '#stageScreen', empty: '#stageEmpty' };
    Object.entries(ids).forEach(([k, sel]) => { const el = $(sel, this.root); if (el) el.hidden = true; });
    const el = $(ids[engine], this.root);
    if (el) el.hidden = false;
    if (engine !== 'video') { try { this.video.pause(); } catch {} }
    if (engine !== 'youtube' && this.yt && this.ytReady) { try { this.yt.pauseVideo(); } catch {} }
    if (engine !== 'vimeo' && this.vimeo) { this.vimeo.pause().catch(() => {}); }
    if (engine !== 'embed' && engine !== 'web' && this.frame.src && this.frame.src !== 'about:blank') this.frame.src = 'about:blank';
    if (engine !== 'screen') this.screenVideo.srcObject = null;
    $('#frameHint', this.root).hidden = engine !== 'web' && engine !== 'embed';
    this.engine = engine;
    this.onEngine(engine);
  }

  reset() { this.key = ''; this._destroyHls(); this._show('empty'); }

  /** Kaynağı yükler. state: {time, playing} */
  async load(src, state = {}) {
    if (!src) return this.reset();
    const key = `${src.kind}|${src.embedUrl || src.url}`;
    if (key === this.key) return this.apply(state);
    this.key = key;
    this._loadSeq++;
    this.nudge = 1;
    this._hideUnlock();
    switch (src.kind) {
      case 'video': return this._loadVideo(src, state);
      case 'youtube': return this._loadYouTube(src, state);
      case 'vimeo': return this._loadVimeo(src, state);
      case 'embed':
      case 'web': return this._loadFrame(src);
      default: return this._showBlocked(src);
    }
  }

  // ---------------- HTML5 / HLS ----------------
  _bindVideo() {
    const v = this.video;
    const emit = (type) => {
      if (this.engine !== 'video' || this._suppressed()) return;
      this.onUserAction({ type, playing: !v.paused, time: v.currentTime });
    };
    v.addEventListener('play', () => emit('play'));
    v.addEventListener('pause', () => { if (!v.ended) emit('pause'); });
    v.addEventListener('seeked', () => emit('seek'));
    v.addEventListener('ended', () => { if (this.engine === 'video') this.onEnded('video'); });
    v.addEventListener('error', () => {
      if (this.engine === 'video') this._showError('Video yüklenemedi. Bağlantı geçersiz olabilir, sunucu erişimi kısıtlıyor olabilir veya biçim tarayıcınızca desteklenmiyor.');
    });
    v.addEventListener('click', () => this.onUserAction({ type: v.paused ? 'play' : 'pause', playing: v.paused, time: v.currentTime, fromClick: true }));
    // Tampon bitti / takıldı: senkron düzeltmesi iste
    v.addEventListener('waiting', () => { this._waitingAt = Date.now(); });
    v.addEventListener('playing', () => { if (this._waitingAt && this.engine === 'video') { this._waitingAt = 0; this.onBuffer('end'); } });
  }

  _destroyHls() { if (this.hls) { try { this.hls.destroy(); } catch {} this.hls = null; } }

  async _loadVideo(src, state) {
    const seq = this._loadSeq;
    this._show('video');
    this._destroyHls();
    const v = this.video;
    v.removeAttribute('src');
    if (src.stream === 'hls' && !v.canPlayType('application/vnd.apple.mpegurl')) {
      try {
        if (!window.Hls) {
          if (window.__CINESYNC_SINGLE__) await loadScript(this.hlsSrc.cdn);
          else await loadScript(this.hlsSrc.local).catch(() => loadScript(this.hlsSrc.cdn));
        }
      } catch { return seq === this._loadSeq && this._showError('HLS oynatıcı kütüphanesi yüklenemedi.'); }
      if (seq !== this._loadSeq) return;
      if (!window.Hls.isSupported()) return this._showError('Bu tarayıcı HLS (.m3u8) oynatmayı desteklemiyor.');
      this.hls = new window.Hls({ enableWorker: true });
      this.hls.on(window.Hls.Events.ERROR, (_e, d) => {
        if (!d.fatal || seq !== this._loadSeq) return;
        // Ağ hatasında bir kez yeniden dene, olmazsa kullanıcıya bildir
        if (d.type === 'networkError' && !this._hlsRetried) { this._hlsRetried = true; try { this.hls.startLoad(); return; } catch {} }
        this._showError('Canlı yayın akışı açılamadı (sunucu CORS izni vermiyor veya akış kapalı).');
      });
      this.hls.loadSource(src.url);
      this.hls.attachMedia(v);
    } else {
      v.src = src.url;
    }
    this._hlsRetried = false;
    v.playbackRate = this.rate;
    await new Promise((res) => { const done = () => { v.removeEventListener('loadedmetadata', done); res(); }; v.addEventListener('loadedmetadata', done); setTimeout(done, 6000); });
    if (seq !== this._loadSeq || this.engine !== 'video') return;
    this.apply(state);
  }

  // ---------------- YouTube ----------------
  _ensureYTApi() {
    if (window.YT && window.YT.Player) return Promise.resolve();
    // Aynı anda birden fazla yükleme isteği tek betik/söz üzerinden beklenir
    this._ytApiP ||= new Promise((resolve, reject) => {
      const prev = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => { try { prev && prev(); } catch {} resolve(); };
      loadScript('https://www.youtube.com/iframe_api').catch(reject);
      setTimeout(() => reject(new Error('YouTube API zaman aşımı')), 15000);
    }).catch((e) => { this._ytApiP = null; throw e; });
    return this._ytApiP;
  }

  async _loadYouTube(src, state) {
    const seq = this._loadSeq;
    this._show('youtube');
    try { await this._ensureYTApi(); } catch { return seq === this._loadSeq && this._showError('YouTube oynatıcısı yüklenemedi. Ağınız youtube.com\'u engelliyor olabilir.', src); }
    if (seq !== this._loadSeq || this.engine !== 'youtube') return;
    if (this.yt) { try { this.yt.destroy(); } catch {} this.yt = null; this.ytReady = false; }
    const host = $('#stageYT', this.root);
    host.innerHTML = '<div id="ytPlayer"></div>';
    const { id, list } = src.youtube;
    const playerVars = { autoplay: 0, controls: 1, rel: 0, playsinline: 1, modestbranding: 1, fs: 0, start: Math.floor(state.time || src.start || 0) };
    if (location.origin && location.origin.startsWith('http')) playerVars.origin = location.origin;
    if (list) { playerVars.list = list; playerVars.listType = 'playlist'; }
    await new Promise((resolve) => {
      setTimeout(resolve, 20000); // oynatıcı hiç hazır olmazsa bekleme sonsuza sürmesin
      this.yt = new window.YT.Player('ytPlayer', {
        width: '100%', height: '100%', videoId: id || undefined, playerVars,
        events: {
          onReady: () => { this.ytReady = true; resolve(); },
          onStateChange: (e) => {
            if (this._suppressed() || this.engine !== 'youtube') return;
            const S = window.YT.PlayerState;
            if (e.data === S.ENDED) { this.onEnded('youtube'); return; }
            if (e.data === S.PLAYING) this.onUserAction({ type: 'play', playing: true, time: this.getTime() });
            else if (e.data === S.PAUSED) this.onUserAction({ type: 'pause', playing: false, time: this.getTime() });
          },
          onError: (e) => {
            const map = { 2: 'Geçersiz video kimliği.', 5: 'Video HTML5 oynatıcıda açılamadı.', 100: 'Video bulunamadı veya gizli.', 101: 'Video sahibi başka sitelerde oynatılmasına izin vermiyor.', 150: 'Video sahibi başka sitelerde oynatılmasına izin vermiyor.', 153: 'YouTube, sayfanın kimliğini (Referer) doğrulayamadı. Dosyayı bilgisayardan açtıysanız yayınlanmış (https) adresi kullanın.' };
            if (seq === this._loadSeq) this._showError(map[e.data] || `YouTube hatası (${e.data}).`, src);
            resolve();
          },
        },
      });
    });
    if (seq !== this._loadSeq || this.engine !== 'youtube') return;
    this.apply(state);
  }

  // ---------------- Vimeo ----------------
  async _loadVimeo(src, state) {
    const seq = this._loadSeq;
    this._show('vimeo');
    const host = $('#stageVimeo', this.root);
    host.innerHTML = `<iframe src="${escapeHtml(src.embedUrl)}" allow="autoplay; picture-in-picture; encrypted-media" referrerpolicy="strict-origin-when-cross-origin" title="Vimeo"></iframe>`;
    try {
      if (!window.Vimeo || !window.Vimeo.Player) await loadScript('https://player.vimeo.com/api/player.js');
      if (seq !== this._loadSeq || this.engine !== 'vimeo') return;
      this.vimeo = new window.Vimeo.Player(host.querySelector('iframe'));
      const p = this.vimeo;
      p.on('timeupdate', (d) => { this.vimeoState.time = d.seconds; this.vimeoState.duration = d.duration; });
      const live = () => this.engine === 'vimeo' && this.vimeo === p && !this._suppressed();
      p.on('play', (d) => { this.vimeoState.paused = false; if (live()) this.onUserAction({ type: 'play', playing: true, time: d.seconds }); });
      p.on('pause', (d) => { this.vimeoState.paused = true; if (live()) this.onUserAction({ type: 'pause', playing: false, time: d.seconds }); });
      p.on('seeked', (d) => { this.vimeoState.time = d.seconds; if (live()) this.onUserAction({ type: 'seek', playing: !this.vimeoState.paused, time: d.seconds }); });
      p.on('ended', () => { if (this.engine === 'vimeo' && this.vimeo === p) this.onEnded('vimeo'); });
      p.on('error', () => {});
      await p.ready();
      this.vimeoState.duration = await p.getDuration().catch(() => 0);
      if (seq !== this._loadSeq || this.engine !== 'vimeo' || this.vimeo !== p) return;
      this.apply(state);
    } catch {
      this.vimeo = null; // oynatıcı yine görünür; sadece senkron kontrolü yok
    }
  }

  // ---------------- iframe (embed & web) ----------------
  _loadFrame(src) {
    this._show(src.kind);
    const f = this.frame;
    if (src.kind === 'web') {
      // Sitenin bizim sayfamızı yönlendirmesini (frame-busting) engeller, normal çalışmasına izin verir
      f.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-presentation allow-downloads');
    } else {
      f.removeAttribute('sandbox');
    }
    f.src = src.embedUrl;
    const hint = $('#frameHint', this.root);
    hint.querySelector('[data-role=text]').textContent = src.kind === 'web'
      ? 'Sayfa boş görünüyorsa bu site gömülmeye izin vermiyor olabilir.'
      : `${src.provider} oynatıcısı — bu kaynakta oynat/duraklat herkes için ayrı çalışır.`;
    hint.querySelector('a').href = src.url;
  }

  _showBlocked(src) {
    this._show('blocked');
    const card = $('#stageBlocked', this.root);
    let host = '';
    try { host = new URL(src.url).hostname; } catch {}
    card.innerHTML = `
      <div class="blocked-card">
        <div class="blocked-icon">${icon('shield')}</div>
        <h3>Bu sayfa burada açılamıyor</h3>
        <p class="muted">${escapeHtml(src.reason || 'Site başka sayfaların içinde gösterilmeyi yasaklıyor.')}</p>
        <div class="blocked-url">${icon('globe')}<span>${escapeHtml(host || src.url)}</span></div>
        <div class="blocked-actions">
          <a class="btn btn-primary" href="${escapeHtml(src.url)}" target="_blank" rel="noopener noreferrer">${icon('external')}Yeni sekmede aç</a>
          <button class="btn btn-ghost" data-act="share-screen" type="button">${icon('screen')}O sekmeyi odaya yansıt</button>
          <button class="btn btn-ghost" data-act="copy" type="button">${icon('copy')}Linki kopyala</button>
        </div>
        <p class="tiny muted">İpucu: Siteyi yeni sekmede açın, ardından “O sekmeyi odaya yansıt” ile görüntüyü herkesle canlı paylaşın.</p>
      </div>`;
    card.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', () => this.onBlockedAction(b.dataset.act, src)));
  }

  _showError(message, src) {
    this._showBlocked({ ...(src || {}), url: src?.url || this.video.currentSrc || '', reason: message, kind: 'blocked' });
    this.key = '';
  }

  showScreen(stream, label) {
    this.key = 'screen';
    this._show('screen');
    $('#stageScreen [data-role=label]', this.root).textContent = label;
    if (this.screenVideo.srcObject !== stream) this.screenVideo.srcObject = stream;
    this.screenVideo.play().catch(() => {});
  }

  showScreenWaiting(label) {
    this.key = 'screen-wait';
    this._show('screen');
    $('#stageScreen [data-role=label]', this.root).textContent = label;
    this.screenVideo.srcObject = null;
  }

  // ---------------- Ortak kontrol ----------------
  getTime() {
    if (this.engine === 'video') return this.video.currentTime || 0;
    if (this.engine === 'youtube' && this.ytReady && this.yt?.getCurrentTime) return this.yt.getCurrentTime() || 0;
    if (this.engine === 'vimeo') return this.vimeoState.time || 0;
    return 0;
  }

  getDuration() {
    if (this.engine === 'video') return Number.isFinite(this.video.duration) ? this.video.duration : 0;
    if (this.engine === 'youtube' && this.ytReady && this.yt?.getDuration) return this.yt.getDuration() || 0;
    if (this.engine === 'vimeo') return this.vimeoState.duration || 0;
    return 0;
  }

  isPlaying() {
    if (this.engine === 'video') return !this.video.paused;
    if (this.engine === 'youtube' && this.ytReady) return this.yt.getPlayerState?.() === 1;
    if (this.engine === 'vimeo') return !this.vimeoState.paused;
    return false;
  }

  /**
   * Uzak durumu oynatıcıya uygular. playing undefined ise yalnızca konum düzeltilir (periyodik tick).
   * Yalnızca gerçekten bir değişiklik yapılırsa kullanıcı olayları kısa süre bastırılır.
   */
  apply(state = {}, tolerance = 1.5) {
    try { this._apply(state, tolerance); } catch (e) { console.warn('[stage] apply', e); }
  }

  _apply({ time = 0, playing, rate } = {}, tolerance = 1.5) {
    if (!this.controllable) return;
    if (Number(rate) > 0 && rate !== this.rate) this.setRate(rate);
    const cur = this.getTime();
    const needSeek = Number.isFinite(time) && Math.abs(cur - time) > tolerance;
    const isPlaying = this.isPlaying();
    const needPlay = playing === true && !isPlaying;
    const needPause = playing === false && isPlaying;
    if (needSeek || needPlay || needPause) this._suppress();
    if (this.engine === 'video') {
      const v = this.video;
      if (needSeek) { try { v.currentTime = time; } catch {} }
      if (needPlay) this._playWithFallback();
      if (needPause) v.pause();
    } else if (this.engine === 'youtube' && this.ytReady && this.yt) {
      if (needSeek) this.yt.seekTo(time, true);
      if (needPlay) {
        this.yt.playVideo();
        setTimeout(() => {
          const st = this.yt?.getPlayerState?.();
          if (this.engine === 'youtube' && st !== 1 && st !== 3) { this._suppress(); this.yt.mute(); this.yt.playVideo(); this._showUnlock(); }
        }, 1500);
      }
      if (needPause) this.yt.pauseVideo();
    } else if (this.engine === 'vimeo' && this.vimeo) {
      if (needSeek) this.vimeo.setCurrentTime(time).catch(() => {});
      if (needPlay) this.vimeo.play().catch(() => { this.vimeo.setMuted(true).then(() => this.vimeo.play()).catch(() => {}); this._showUnlock(); });
      if (needPause) this.vimeo.pause().catch(() => {});
    }
    this._lastSample = null;
  }

  async _playWithFallback() {
    const v = this.video;
    try { await v.play(); } catch (e) {
      if (e.name === 'NotAllowedError') {
        this._suppress();
        v.muted = true;
        try { await v.play(); } catch {}
        this._showUnlock();
      }
    }
  }

  _showUnlock() { const o = $('#unlockOverlay', this.root); if (o) o.hidden = false; }
  _hideUnlock() { const o = $('#unlockOverlay', this.root); if (o) o.hidden = true; }

  unlockAudio() {
    this._hideUnlock();
    if (this.engine === 'video') { this.video.muted = false; this.video.play().catch(() => {}); }
    if (this.engine === 'youtube' && this.yt) { this.yt.unMute(); }
    if (this.engine === 'vimeo' && this.vimeo) { this.vimeo.setMuted(false).catch(() => {}); }
  }

  /**
   * Küçük kaymaları sıçratmadan düzeltmek için hızı geçici olarak çok az değiştirir (yalnızca video dosyaları).
   * factor: 0.9–1.1 arası; 1 = normal.
   */
  setNudge(factor) {
    const f = Math.min(1.1, Math.max(0.9, Number(factor) || 1));
    if (this.engine !== 'video') { this.nudge = 1; return false; }
    if (Math.abs(f - this.nudge) < 0.005) return true;
    this.nudge = f;
    try { this.video.playbackRate = this.rate * f; } catch {}
    return true;
  }

  /** Resim içinde resim (video dosyası veya ekran yansıtma) */
  async togglePip() {
    const v = this.engine === 'video' ? this.video : this.engine === 'screen' ? this.screenVideo : null;
    if (!v) return false;
    if (document.pictureInPictureElement) { await document.exitPictureInPicture(); return true; }
    if (v.requestPictureInPicture && document.pictureInPictureEnabled !== false) { await v.requestPictureInPicture(); return true; }
    if (v.webkitSupportsPresentationMode && v.webkitSupportsPresentationMode('picture-in-picture')) {
      v.webkitSetPresentationMode(v.webkitPresentationMode === 'picture-in-picture' ? 'inline' : 'picture-in-picture'); return true;
    }
    return false;
  }

  /** Film sesini belirli bir çıkış cihazına yönlendirir (destekleyen tarayıcılarda) */
  async setSink(deviceId) {
    for (const v of [this.video, this.screenVideo]) { if (v.setSinkId) { try { await v.setSinkId(deviceId || ''); } catch {} } }
  }

  /** Oynatma hızı (0.25–2). YouTube yalnızca desteklediği hızları kabul eder. */
  setRate(rate) {
    const r = Math.min(2, Math.max(0.25, Number(rate) || 1));
    this.rate = r;
    try {
      if (this.engine === 'video') this.video.playbackRate = r * (this.nudge || 1);
      if (this.engine === 'youtube' && this.ytReady) this.yt.setPlaybackRate(r);
      if (this.engine === 'vimeo' && this.vimeo) this.vimeo.setPlaybackRate(r).catch(() => {});
    } catch {}
  }

  /** Altyazı (.vtt / .srt). text verilirse doğrudan kullanılır; url verilirse indirilir (CORS gerekir). */
  async setSubtitles({ url, text, label = 'Altyazı' } = {}) {
    this._subsVtt = ''; this.subsOffset = 0;
    this._clearTrack();
    if (!url && !text) return true;
    let body = text;
    if (!body) {
      const res = await fetch(url, { mode: 'cors' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      body = await res.text();
    }
    this._subsVtt = toVtt(body); this._subsLabel = label;
    this._mountTrack();
    return true;
  }

  get hasSubtitles() { return !!this._subsVtt; }

  /** Altyazıyı ileri/geri kaydırır (sn). Görüntü ile konuşma uyuşmuyorsa kullanılır; yalnızca bu cihazda. */
  setSubtitleOffset(sec) {
    this.subsOffset = Math.max(-600, Math.min(600, Math.round((Number(sec) || 0) * 10) / 10));
    if (this._subsVtt) this._mountTrack();
    return this.subsOffset;
  }

  _clearTrack() {
    const v = this.video;
    v.querySelectorAll('track').forEach((t) => t.remove());
    if (this.subsUrl) { URL.revokeObjectURL(this.subsUrl); this.subsUrl = null; }
  }

  _mountTrack() {
    const v = this.video;
    this._clearTrack();
    const vtt = this.subsOffset ? shiftVtt(this._subsVtt, this.subsOffset) : this._subsVtt;
    this.subsUrl = URL.createObjectURL(new Blob([vtt], { type: 'text/vtt' }));
    const tr = document.createElement('track');
    tr.kind = 'subtitles'; tr.label = this._subsLabel || 'Altyazı'; tr.srclang = 'tr'; tr.src = this.subsUrl; tr.default = true;
    v.appendChild(tr);
    setTimeout(() => { const t = v.textTracks[v.textTracks.length - 1]; if (t) t.mode = 'showing'; }, 50);
  }

  setVolume(vol, muted) {
    this._vol = { vol, muted };
    if (this.engine === 'video') { this.video.volume = vol * (this.duck || 1); this.video.muted = muted; }
    try { if (this.engine === 'youtube' && this.ytReady) { this.yt.setVolume(Math.round(vol * (this.duck || 1) * 100)); muted ? this.yt.mute() : this.yt.unMute(); } } catch {}
    if (this.engine === 'vimeo' && this.vimeo) { this.vimeo.setVolume(muted ? 0 : vol * (this.duck || 1)).catch(() => {}); }
  }

  /** Konuşma sırasında film sesini kısar (1 = normal, 0.35 = kısık) */
  setDuck(level) {
    const d = Math.min(1, Math.max(0.1, Number(level) || 1));
    if (Math.abs(d - (this.duck || 1)) < 0.01) return;
    this.duck = d;
    const { vol = 1, muted = false } = this._vol || {};
    this.setVolume(vol, muted);
  }

  // YouTube'un "seek" olayı yoktur; zaman sıçramalarını izleyerek kullanıcı atlamalarını yakalarız
  _watchSeeks() {
    if (this.engine !== 'youtube' || !this.ytReady || this._suppressed()) { this._lastSample = null; return; }
    const now = Date.now(), t = this.getTime(), playing = this.isPlaying();
    const prev = this._lastSample;
    this._lastSample = { t, at: now, playing };
    if (!prev) return;
    const expected = prev.t + (prev.playing ? ((now - prev.at) / 1000) * this.rate : 0);
    if (Math.abs(t - expected) > 3) this.onUserAction({ type: 'seek', playing, time: t });
  }
}

/** SRT'yi WebVTT'ye çevirir (VTT ise olduğu gibi bırakır). Saat damgalarındaki virgülü noktaya çevirir. */
export function toVtt(text) {
  const t = String(text || '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim();
  if (/^WEBVTT/.test(t)) return t + '\n';
  const body = t.replace(/(\d{1,2}:\d{2}:\d{2}),(\d{1,3})/g, (_, a, ms) => `${a.padStart(8, '0')}.${ms.padEnd(3, '0')}`)
    .replace(/^\d+\n(?=\d{2}:\d{2})/gm, '');
  return 'WEBVTT\n\n' + body + '\n';
}

const tsToSec = (h, m, sec, ms) => (Number(h) || 0) * 3600 + Number(m) * 60 + Number(sec) + Number(ms) / 1000;
function secToTs(t) {
  const v = Math.max(0, t);
  const h = Math.floor(v / 3600), m = Math.floor((v % 3600) / 60), s = Math.floor(v % 60), ms = Math.round((v - Math.floor(v)) * 1000);
  const p = (n, l = 2) => String(n).padStart(l, '0');
  return `${p(h)}:${p(m)}:${p(s)}.${p(ms >= 1000 ? 999 : ms, 3)}`;
}
/** WebVTT içindeki tüm zaman damgalarını "sec" saniye kaydırır (negatif = erken). 0'ın altına düşenler 0'da kalır. */
export function shiftVtt(vtt, sec) {
  const d = Number(sec) || 0;
  if (!d) return vtt;
  return String(vtt).replace(/(?:(\d{1,2}):)?(\d{2}):(\d{2})\.(\d{3})(\s+-->\s+)(?:(\d{1,2}):)?(\d{2}):(\d{2})\.(\d{3})/g,
    (_, h1, m1, s1, ms1, arrow, h2, m2, s2, ms2) => `${secToTs(tsToSec(h1, m1, s1, ms1) + d)}${arrow}${secToTs(tsToSec(h2, m2, s2, ms2) + d)}`);
}
