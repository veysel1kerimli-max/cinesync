// CineSync — uygulama giriş noktası: lobi, oda, sahne, sohbet, görüşme ve tam ekranı birbirine bağlar.

import { RELAYS, ICE_SERVERS, ALLOWED_SITES, SITE_CATEGORIES, FEATURED_FILMS, LICENSE_LABEL } from './config.js';
import { parseInput } from './url-parser.js';
import { Room, generateRoomCode, normalizeRoomCode, validateRoomCode, probeRoom } from './room.js';
import { Mesh } from './rtc.js';
import { Stage } from './stage.js';
import { PipLayer } from './pip.js';
import { $, $$, toast, copyText, escapeHtml, formatTime, clockTime, initials, colorFor, timeAgo } from './ui/dom.js';
import { ACCENTS, applyTheme, themePref, accentPref, effectiveTheme, setThemePref, setAccentPref, toggleTheme, onThemeChange } from './theme.js';
import { qrSvg } from './qr.js';
import { icon, hydrateIcons } from './ui/icons.js';

const env = { hostname: location.hostname, protocol: location.protocol };
const store = {
  get: (k, d = '') => { try { return localStorage.getItem('cinesync:' + k) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem('cinesync:' + k, v); } catch {} },
  json: (k, d) => { try { return JSON.parse(localStorage.getItem('cinesync:' + k)) ?? d; } catch { return d; } },
  setJson: (k, v) => { try { localStorage.setItem('cinesync:' + k, JSON.stringify(v)); } catch {} },
};
const PALETTE = [250, 280, 320, 350, 15, 35, 50, 140, 170, 200].map((h) => `hsl(${h} 75% 64%)`);
const isDesktop = () => matchMedia('(min-width: 1024px)').matches;

const S = {
  room: null, mesh: null, stage: null, pip: null,
  cam: null, screen: null, mic: false, camOn: false,
  remote: new Map(),            // peerId -> Map(streamId -> MediaStream)
  history: [], laser: false, unread: 0, tab: 'chat',
  lastLaserSend: 0, laserDots: new Map(),
  color: store.get('color') || PALETTE[0],
  sound: store.get('sound', '1') === '1',
  muteRemote: false, mutedPeers: new Set(),
  fs: false, pseudoFs: false, camsHidden: store.get('camsHidden') === '1', idleTimer: null,
  installPrompt: null,
  autoHide: store.get('autoHide', '1') === '1', reactionsOn: store.get('reactions', '1') === '1', chatToasts: store.get('chatToasts', '1') === '1',
  replyTo: null, typing: new Map(), lastTypingSent: 0, catFilter: 'all', lastDeniedToast: 0, subsKey: '', localSubs: false,
  audioEls: new Map(),          // peerId -> Map(streamId -> <audio>)
  audioBlocked: false,
  dev: { mic: store.get('devMic'), out: store.get('devOut'), cam: store.get('devCam') },
  duckOn: store.get('duck', '1') === '1', speaking: new Set(), lastSpeakAt: 0,
  peerState: new Map(),         // peerId -> {state, quality}
  relays: { open: 0, total: 0 }, errors: [], lastErrToast: 0, hiddenAt: 0,
  peerVol: store.json('peerVol', {}),   // üye adı -> ses düzeyi (0–1); cihazda hatırlanır
  countdown: null,              // {id, at, by, timer}
  subsSize: store.get('subsSize', 'm'), lastHostId: null, mentionIdx: 0, lastEndedKey: '',
};
const APP_VERSION = '2.4.0';
const QUICK_REACTS = ['👍', '❤️', '😂', '😮', '😢', '🔥'];
const CHAT_EMOJIS = ['😀', '😂', '🤣', '😍', '🥰', '😎', '🤔', '😮', '😢', '😡', '👍', '👏', '🙏', '🔥', '🎉', '❤️', '🍿', '🎬', '👀', '💯'];
const MOBILE_MQ = '(max-width: 760px), (orientation: landscape) and (max-height: 520px)';
const isMobileUI = () => matchMedia(MOBILE_MQ).matches;

// ======================================================= Yardımcılar

function setIcon(btn, name) {
  if (!btn) return;
  const old = btn.querySelector('svg.ic');
  if (old) old.outerHTML = icon(name); else btn.insertAdjacentHTML('afterbegin', icon(name));
}
const KIND_LABEL = { video: 'Video', youtube: 'YouTube', vimeo: 'Vimeo', embed: 'Gömülü', web: 'Web', blocked: 'Engelli', screen: 'Yansıtma', empty: '—' };
const inviteLink = (code) => `${location.origin}${location.pathname}#room=${code}`;
function readInviteCode() {
  const h = new URLSearchParams(location.hash.slice(1));
  const q = new URLSearchParams(location.search);
  return normalizeRoomCode(h.get('room') || q.get('room') || '');
}
function linkify(text) {
  return escapeHtml(text).replace(/https?:\/\/[^\s<]+/g, (u) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`);
}
const memberColor = (m) => (m && m.color) || colorFor(m?.id || '');
function isTyping(e) {
  const t = e.target;
  return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
}

// Bildirim sesi: her seferinde kısa ömürlü bir AudioContext açılır ve hemen kapatılır.
// Sürekli açık bir AudioContext, mobilde ses oturumunu ele geçirip sesi kulaklık yerine hoparlöre
// yönlendirebiliyordu; artık ses çıkışını yalnızca işletim sistemi belirler.
function ping() {
  if (!S.sound || document.hidden) return;
  if (S.mic && /iPhone|iPad|iPod/.test(navigator.userAgent)) return; // iOS'ta görüşme sırasında ses oturumunu bozmamak için
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'sine'; o.frequency.value = 880;
    g.gain.setValueAtTime(0.0001, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.08, ctx.currentTime + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.25);
    o.connect(g).connect(ctx.destination); o.start(); o.stop(ctx.currentTime + 0.26);
    setTimeout(() => ctx.close().catch(() => {}), 500);
  } catch {}
}

function updateTitle() {
  const base = S.room ? `${S.room.code} · CineSync` : 'CineSync — Ortak İzleme Odası';
  document.title = S.unread ? `(${S.unread}) ${base}` : base;
}

// ======================================================= Yerel medya

// Yankı engelleme + gürültü bastırma + otomatik kazanç: hoparlörden gelen film sesi karşıya geri dönmez
const AUDIO_CONSTRAINTS = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
async function getTrack(kind, deviceId) {
  if (!navigator.mediaDevices?.getUserMedia) { const e = new Error('no-media'); e.name = window.isSecureContext ? 'NotSupportedError' : 'SecurityError'; throw e; }
  const id = deviceId ? { deviceId: { exact: deviceId } } : {};
  const constraints = kind === 'audio'
    ? { audio: { ...AUDIO_CONSTRAINTS, ...id } }
    : { video: { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 24 }, ...(deviceId ? id : { facingMode: 'user' }) } };
  let s;
  try { s = await navigator.mediaDevices.getUserMedia(constraints); }
  catch (e) {
    // Seçili cihaz artık yok (çıkarıldı) ya da kısıt karşılanamadı: varsayılan cihazla tekrar dene
    if (deviceId && (e.name === 'OverconstrainedError' || e.name === 'NotFoundError')) return getTrack(kind, '');
    throw e;
  }
  return s.getTracks()[0];
}
function mediaError(e, what) {
  const n = e?.name;
  const msg = n === 'NotAllowedError' ? `${what} izni verilmedi. Adres çubuğundaki kilit/ayar simgesinden izin verebilirsin.`
    : n === 'NotFoundError' ? `${what} bulunamadı. Takılı olduğundan emin ol.`
    : n === 'NotReadableError' || n === 'AbortError' ? `${what} başka bir uygulama tarafından kullanılıyor olabilir. Onu kapatıp tekrar dene.`
    : n === 'OverconstrainedError' ? `Seçili ${what.toLocaleLowerCase('tr')} kullanılamıyor; Ayarlar → Cihazlar'dan başka birini seç.`
    : n === 'SecurityError' || !window.isSecureContext ? `${what} yalnızca https:// veya localhost üzerinde çalışır.`
    : n === 'NotSupportedError' ? `Bu tarayıcı ${what.toLocaleLowerCase('tr')} erişimini desteklemiyor.`
    : `${what} açılamadı.`;
  toast(msg, 'error', 5000);
}
function watchTrack(t) {
  // iOS: telefon görüşmesi, Siri veya başka bir uygulama mikrofonu alınca iz biter; geri dönünce yeniden alırız
  t.addEventListener('ended', () => { if (S.cam?.getTracks().includes(t)) setTimeout(() => reacquireTrack(t.kind, 'ended'), 400); });
}
async function toggleMic() {
  try {
    if (!S.cam) S.cam = new MediaStream();
    let t = S.cam.getAudioTracks()[0];
    if (t && t.readyState === 'ended') { S.cam.removeTrack(t); t = null; }
    if (!t) { t = await getTrack('audio', S.dev.mic); watchTrack(t); S.cam.addTrack(t); S.mic = true; }
    else { S.mic = !S.mic; t.enabled = S.mic; }
    store.set('micWanted', S.mic ? '1' : '0');
  } catch (e) { return mediaError(e, 'Mikrofon'); }
  afterLocalMediaChange();
  populateDevices();
}
async function toggleCam() {
  try {
    if (!S.cam) S.cam = new MediaStream();
    const t = S.cam.getVideoTracks()[0];
    if (t) { t.stop(); S.cam.removeTrack(t); S.camOn = false; }
    else { const nt = await getTrack('video', S.dev.cam); watchTrack(nt); S.cam.addTrack(nt); S.camOn = true; }
  } catch (e) { return mediaError(e, 'Kamera'); }
  afterLocalMediaChange();
  populateDevices();
}
/** Mikrofonu/kamerayı yeniden alır ve bağlantılardaki izi yeniden pazarlık yapmadan değiştirir */
let reacquiring = null;
async function reacquireTrack(kind, why) {
  if (!S.cam) return;
  const old = kind === 'audio' ? S.cam.getAudioTracks()[0] : S.cam.getVideoTracks()[0];
  if (!old) return;
  if (reacquiring) return reacquiring;
  reacquiring = (async () => {
    try {
      const nt = await getTrack(kind, kind === 'audio' ? S.dev.mic : S.dev.cam);
      nt.enabled = kind === 'audio' ? S.mic : true;
      watchTrack(nt);
      S.cam.addTrack(nt);
      S.cam.removeTrack(old);
      if (S.mesh) await S.mesh.replaceTrack(old, nt);
      try { old.stop(); } catch {}
      afterLocalMediaChange();
      if (why === 'ended') toast(kind === 'audio' ? 'Mikrofon yeniden bağlandı.' : 'Kamera yeniden bağlandı.', 'success', 2500);
    } catch (e) {
      if (why !== 'device') mediaError(e, kind === 'audio' ? 'Mikrofon' : 'Kamera');
    } finally { reacquiring = null; }
  })();
  return reacquiring;
}
function afterLocalMediaChange() {
  const hasVideo = !!(S.camOn && S.cam && S.cam.getVideoTracks().length);
  const pv = $('#lobbyPreview');
  pv.srcObject = hasVideo ? S.cam : null;
  $('#lobbyPreviewEmpty').hidden = hasVideo;
  for (const [id, on, onIcon, offIcon, label] of [
    ['#lobbyMic', S.mic, 'mic', 'micOff', 'Mikrofon'], ['#lobbyCam', S.camOn, 'cam', 'camOff', 'Kamera'],
    ['#micBtn', S.mic, 'mic', 'micOff', 'Mikrofon'], ['#camBtn', S.camOn, 'cam', 'camOff', 'Kamera'],
    ['#camsMicBtn', S.mic, 'mic', 'micOff', 'Mikrofon'], ['#camsCamBtn', S.camOn, 'cam', 'camOff', 'Kamera'],
    ['#mMic', S.mic, 'mic', 'micOff', 'Mikrofon'], ['#mCam', S.camOn, 'cam', 'camOff', 'Kamera'],
  ]) {
    const b = $(id); setIcon(b, on ? onIcon : offIcon);
    b.classList.toggle('on', on); b.classList.toggle('off', !on);
    b.setAttribute('aria-pressed', String(on));
    b.setAttribute('aria-label', `${label} ${on ? 'açık — kapat' : 'kapalı — aç'}`);
  }
  const sv = $('#selfVideo');
  sv.srcObject = hasVideo ? S.cam : null;
  sv.style.opacity = hasVideo ? 1 : 0;
  $('#selfAvatar').hidden = hasVideo;
  $('#selfFlags').innerHTML = S.mic ? '' : icon('micOff');
  if (S.room) {
    S.mesh.setStream('cam', S.cam);
    S.room.updateSelf({ mic: S.mic, cam: hasVideo, camStreamId: S.cam?.id || null });
  }
  refreshPip();
}

// ======================================================= Lobi

function renderColorPicker() {
  $('#colorPicker').innerHTML = PALETTE.map((c, i) => `<button type="button" class="swatch" role="radio" aria-checked="${c === S.color}" aria-label="Renk ${i + 1}" style="--c:${c}" data-color="${c}"></button>`).join('');
}
function renderRecentRooms() {
  const list = store.json('recentRooms', []);
  const last = list[0];
  const rb = $('#rejoinBtn');
  if (rb) { rb.hidden = !(last && Date.now() - last.ts < 24 * 3600e3); if (last) { $('#rejoinCode').textContent = last.code; rb.dataset.room = last.code; } }
  $('#recentRooms').hidden = !list.length;
  $('#recentRoomList').innerHTML = list.map((r) => `<span class="chip room-chip"><button type="button" class="rc-go" data-room="${escapeHtml(r.code)}" title="${escapeHtml(r.code)} odasına gir">${icon(r.locked ? 'lock' : 'history')}<span>${escapeHtml(r.code)}</span><small>${escapeHtml(timeAgo(r.ts))}</small></button><button type="button" class="rc-x" data-forget="${escapeHtml(r.code)}" aria-label="${escapeHtml(r.code)} odasını listeden kaldır" title="Listeden kaldır">${icon('x')}</button></span>`).join('');
}
function rememberRoom(code, locked = false) {
  const list = store.json('recentRooms', []).filter((r) => r.code !== code);
  list.unshift({ code, ts: Date.now(), locked: !!locked });
  store.setJson('recentRooms', list.slice(0, 5));
}

function initLobby() {
  $('#nameInput').value = store.get('name');
  renderColorPicker();
  renderRecentRooms();
  const code = readInviteCode();
  if (code) {
    $('#codeInput').value = code;
    toast(`${code} odasına davet edildin. Adını yazıp “Katıl”a bas.`, 'info', 5000);
  }
  $('#colorPicker').addEventListener('click', (e) => {
    const b = e.target.closest('[data-color]'); if (!b) return;
    S.color = b.dataset.color; store.set('color', S.color); renderColorPicker();
  });
  $('#colorPicker').addEventListener('keydown', (e) => {
    if (!['ArrowRight', 'ArrowLeft'].includes(e.key)) return;
    const i = (PALETTE.indexOf(S.color) + (e.key === 'ArrowRight' ? 1 : -1) + PALETTE.length) % PALETTE.length;
    S.color = PALETTE[i]; store.set('color', S.color); renderColorPicker(); $(`[data-color="${S.color}"]`).focus();
  });
  $('#recentRoomList').addEventListener('click', (e) => {
    const x = e.target.closest('[data-forget]');
    if (x) { store.setJson('recentRooms', store.json('recentRooms', []).filter((r) => r.code !== x.dataset.forget)); renderRecentRooms(); toast('Oda listeden kaldırıldı.', 'info', 1800); return; }
    const b = e.target.closest('[data-room]'); if (b) enterRoom(b.dataset.room, false);
  });
  $('#themeBtn').addEventListener('click', () => { toggleTheme(); });
  for (const id of ['#whatsNewBtn', '#whatsNewLink']) $(id).addEventListener('click', (e) => { e.preventDefault(); $('#whatsNewDialog').showModal(); store.set('seenVersion', APP_VERSION); });
  $('#rejoinBtn').addEventListener('click', (e) => enterRoom(e.currentTarget.dataset.room, false));
  $('#lobbyMic').addEventListener('click', toggleMic);
  $('#lobbyCam').addEventListener('click', toggleCam);
  $('#createBtn').addEventListener('click', createRoom);
  $('#customCode').addEventListener('input', () => {
    const raw = $('#customCode').value, hint = $('#customCodeHint');
    const err = raw.trim() ? validateRoomCode(raw) : '';
    const c = normalizeRoomCode(raw);
    hint.classList.toggle('err', !!err);
    hint.textContent = !raw.trim() ? 'Boş bırakırsan rastgele kod üretilir · 4–32 harf, rakam veya tire' : err || `Oda kodu: ${c}`;
    $('#createBtn').lastChild.textContent = raw.trim() ? ' Bu kodla oda oluştur' : ' Yeni oda oluştur';
  });
  $('#customCode').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); createRoom(); } });
  $('#joinForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const raw = $('#codeInput').value;
    const err = validateRoomCode(raw);
    if (err) return toast(err, 'warn');
    enterRoom(normalizeRoomCode(raw), false, $('#roomPass').value);
  });
  $('#passForm').addEventListener('submit', () => {});
  $('#passDialog').addEventListener('close', () => {
    const d = $('#passDialog'), pw = $('#passInput').value;
    if (d.returnValue === 'ok' && S.room) { const code = S.room.code; $('#passInput').value = ''; enterRoom(code, false, pw); }
  });
  $('#aboutLink').addEventListener('click', (e) => { e.preventDefault(); $('#helpDialog').showModal(); });
  $$('[data-cta]').forEach((a) => a.addEventListener('click', (e) => {
    e.preventDefault();
    const card = $('#basla');
    card.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' });
    card.classList.remove('pulse'); void card.offsetWidth; card.classList.add('pulse');
    const target = a.dataset.cta === 'join' ? $('#codeInput') : $('#nameInput');
    setTimeout(() => target.focus({ preventScroll: true }), 350);
  }));
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); S.installPrompt = e; $('#installBtn').hidden = false; });
  $('#installBtn').addEventListener('click', async () => {
    if (!S.installPrompt) return;
    S.installPrompt.prompt();
    await S.installPrompt.userChoice.catch(() => {});
    S.installPrompt = null; $('#installBtn').hidden = true;
  });
}

// ======================================================= Oda

function askOccupied(r) {
  const d = $('#occupiedDialog');
  $('#occText').textContent = r.locked
    ? 'Bu kod kullanımda — katılmak ister misin? Bu oda şifreli görünüyor (ya da yazdığın şifre farklı); katılırken doğru şifre gerekir.'
    : `Bu kod kullanımda — katılmak ister misin? Odada şu an ${r.members} kişi var.`;
  d.returnValue = '';
  d.showModal();
  return new Promise((res) => d.addEventListener('close', () => res(d.returnValue), { once: true }));
}

/** "Yeni oda oluştur": özel kod yazıldıysa doğrula, kullanımda mı diye yokla; yoksa rastgele kod üret */
async function createRoom() {
  const btn = $('#createBtn');
  if (btn.disabled) return;
  const raw = $('#customCode').value.trim();
  const pass = $('#roomPass').value;
  let code = generateRoomCode();
  if (raw) {
    const err = validateRoomCode(raw);
    if (err) { $('#advRoom').open = true; $('#customCode').focus(); return toast(err, 'warn'); }
    code = normalizeRoomCode(raw);
    btn.disabled = true; btn.setAttribute('aria-busy', 'true');
    const label = btn.lastChild.textContent; btn.lastChild.textContent = ' Kod kontrol ediliyor…';
    let r = null;
    try { r = await probeRoom({ code, password: pass, relays: RELAYS }); } catch (e) { console.warn('[probe]', e); }
    btn.disabled = false; btn.removeAttribute('aria-busy'); btn.lastChild.textContent = label;
    if (r?.occupied) {
      const choice = await askOccupied(r);
      if (choice !== 'join') { $('#customCode').focus(); $('#customCode').select(); return; }
      return enterRoom(code, false, pass);
    }
    if (r && !r.relaysOpen) toast('Röle sunucularına ulaşılamadı; kodun boş olduğu doğrulanamadı.', 'warn', 4000);
  }
  return enterRoom(code, true, pass);
}

/** Oda içi görünür durumu temizler (çıkışta ve oda yeniden kurulduğunda) */
function clearRoomContent() {
  S.history = [];
  S.stage.reset();
  $('#chatList').innerHTML = '<div class="chat-empty">' + icon('chat') + '<p>Henüz mesaj yok.<br><span class="muted tiny">Sohbet uçtan uca şifrelidir.</span></p></div>';
  $('#historyList').innerHTML = '<li class="muted">Henüz işlem yok.</li>';
  $('#urlInput').value = ''; $('#clearUrl').hidden = true;
  $('#embedNote').hidden = true; $('#frameHint').hidden = true;
  $('#syncLabel').textContent = '';
  setReply(null); S.typing.clear(); renderTyping(); S.subsKey = ''; S.localSubs = false;
  $('#lockPill').hidden = true; $('#player').classList.remove('locked-out');
  $('#backBtn').disabled = true;
  cancelCountdown(false);
  S.lastHostId = null; S.lastEndedKey = '';
  renderQueue();
  setBadge?.('empty');
}

/** Oda için cihazda tutulan önbellek varsa sil (oda boşalınca iz kalmasın) */
function purgeRoomCache(code) {
  try {
    for (const st of [localStorage, sessionStorage]) {
      for (let i = st.length - 1; i >= 0; i--) { const k = st.key(i); if (k && k.includes(`room:${code}`)) st.removeItem(k); }
    }
  } catch {}
}

async function enterRoom(code, created, password = '') {
  let name = $('#nameInput').value.trim();
  if (!name) { name = 'Misafir ' + Math.floor(100 + Math.random() * 900); $('#nameInput').value = name; }
  store.set('name', name);
  rememberRoom(code, !!password);

  if (S.room) await leaveRoom();
  const room = new Room({ code, name, relays: RELAYS, color: S.color, password });
  S.room = room;
  S.mesh = new Mesh(room, {
    iceServers: ICE_SERVERS, onTrack: onRemoteTrack,
    onPeerGone: (id) => { S.remote.delete(id); dropAudio(id); S.peerState.delete(id); refreshRemoteMedia(); updateConn(); },
    onState: (id, state, quality) => { S.peerState.set(id, { state, quality: quality || S.peerState.get(id)?.quality }); updateQuality(id); updateConn(); },
  });
  bindRoomEvents(room);
  try { sessionStorage.setItem('cinesync:active', JSON.stringify({ code, ts: Date.now(), pw: password || undefined })); } catch {}
  $('#roomPass').value = ''; $('#customCode').value = ''; $('#customCode').dispatchEvent(new Event('input'));

  $('#roomCodeText').textContent = code;
  $('#roomLockIc').hidden = !password;
  $('#codePill').setAttribute('aria-label', `Oda kodunu kopyala: ${code}${password ? ' (şifreli oda)' : ''}`);
  $('#selfName').textContent = name + ' (sen)';
  $('#selfAvatar').innerHTML = `<span style="background:${S.color}">${escapeHtml(initials(name))}</span>`;
  history.replaceState(null, '', `${location.pathname}#room=${code}`);
  $('#lobby').hidden = true;
  $('#roomView').hidden = false;
  document.documentElement.classList.add('in-room');
  fitViewport();
  S.unread = 0; updateTitle();
  renderQuickBar();
  setTools(store.get('toolsOpen') === '1');
  setLockUI();
  window.scrollTo(0, 0);
  if (isDesktop() && S.tab === 'cams') switchTab('chat');

  try { await room.join(); }
  catch (e) { console.warn('[room] join', e); toast('Odaya bağlanırken sorun oldu; yeniden deneniyor…', 'warn'); setTimeout(() => S.room === room && room.resume(), 2000); }
  room.setHidden(document.hidden);
  afterLocalMediaChange();
  renderMembers(room.memberList());
  addSystem(created ? `Oda oluşturuldu. Davet linkini paylaş: ${inviteLink(code)}${password ? ' — oda şifreli; şifreyi ayrıca söyle.' : ''}` : 'Odaya katıldın.');
}

async function leaveRoom() {
  if (!S.room) return;
  exitFullscreen();
  stopScreenShare(false);
  const room = S.room, mesh = S.mesh;
  S.room = null; S.mesh = null;
  const alone = room.memberList().filter((m) => m.id !== room.selfId).length === 0;
  try { mesh?.closeAll(); } catch {}
  try { await room.leave(); } catch {}
  if (alone) purgeRoomCache(room.code);
  try { sessionStorage.removeItem('cinesync:active'); } catch {}
  for (const id of Array.from(S.audioEls.keys())) dropAudio(id);
  S.peerState.clear(); S.speaking.clear(); S.stage.setDuck(1); S.stage.setNudge(1);
  $('#connPill').hidden = true; $('#audioUnlock').hidden = true; S.audioBlocked = false;
  if ($('#moreSheet').open) $('#moreSheet').close();
  S.remote.clear(); S.mutedPeers.clear();
  S.pip.clear();
  $$('#videoGrid .tile:not(#tile-self)').forEach((t) => t.remove());
  clearRoomContent();
  closePops();
  if ($('#passDialog').open) $('#passDialog').close();
  history.replaceState(null, '', location.pathname);
  S.unread = 0; updateTitle();
  $('#roomView').hidden = true;
  $('#lobby').hidden = false;
  document.documentElement.classList.remove('in-room');
  renderRecentRooms();
}

function setNet(open, total) {
  const cls = !navigator.onLine || open === 0 ? 'err' : open >= 2 ? 'ok' : 'warn';
  for (const el of [$('#netPill'), $('#netDot')]) { el.classList.remove('ok', 'warn', 'err'); el.classList.add(cls); }
  const txt = !navigator.onLine ? 'Çevrimdışı' : open ? `Bağlı · ${open}/${total} röle` : 'Bağlanıyor…';
  $('#netText').textContent = txt;
  $('#codePill').title = `Oda kodunu kopyala · ${txt}`;
}

function bindRoomEvents(room) {
  S.relays = { open: 0, total: RELAYS.length };
  room.on('status', (s) => { if (S.room !== room) return; S.relays = s; setNet(s.open, s.total); updateConn(); });
  room.on('members', renderMembers);
  room.on('member-away', (m) => { updateQuality(m.id); updateConn(); });
  room.on('member-back', (m) => { updateQuality(m.id); S.mesh?.heal(); updateConn(); });
  room.on('member-join', (m) => { addSystem(`${m.name} odaya katıldı`); ping(); });
  room.on('member-leave', (m) => {
    addSystem(`${m.name} odadan ayrıldı`); removeTile(m.id); refreshPip();
    S.typing.delete(m.id); renderTyping();
    if (room.media?.locked && room.media.hostId === m.id) { room.media.locked = false; setLockUI(); addSystem('Kontrol kilidi açıldı (kilitleyen kişi ayrıldı).'); }
  });
  room.on('media', (m) => { applyMedia(m); renderQueue(); });
  S.qPrevIds = new Set();
  room.on('queue', (q, meta) => {
    const prev = S.qPrevIds; S.qPrevIds = new Set(q.items.map((it) => it.id));
    if (!meta?.local) {
      const added = q.items.filter((it) => !prev.has(it.id));
      const who = room.members.get(q.byId)?.name || 'Biri';
      if (added.length === 1 && prev.size + 1 === q.items.length) addSystem(`${who} sıraya ekledi: ${added[0].title}`);
      else if (added.length > 1) addSystem(`${who} sıraya ${added.length} öğe ekledi`);
      else if (!q.items.length && prev.size) addSystem(`${who} sırayı temizledi`);
    }
    renderQueue();
  });
  room.on('chat-react', (msg) => renderReacts(msg));
  room.on('countdown', (d, from) => onCountdown(d, from));
  room.on('tick', () => driftCheck(true));
  room.on('chat', renderChat);
  room.on('system', addSystem);
  room.on('emoji', (d, from) => spawnEmoji(d.e, room.members.get(from)?.name));
  room.on('typing', (d, from) => {
    const m = room.members.get(from); if (!m) return;
    clearTimeout(S.typing.get(from)?.t);
    if (d && d.on === false) S.typing.delete(from);
    else S.typing.set(from, { name: m.name, t: setTimeout(() => { S.typing.delete(from); renderTyping(); }, 5000) });
    renderTyping();
  });
  room.on('laser', (d, from) => drawLaser(from, d));
  room.on('reset', ({ reason }) => {
    if (S.room !== room) return;
    clearRoomContent(); setLockUI();
    if (reason === 'stale') addSystem('Uzun süre uzaktaydın; oda boşalmış olabilir. Temiz bir oturumla yeniden katıldın.');
  });
  room.on('password-mismatch', () => {
    if (S.room !== room || $('#passDialog').open) return;
    $('#passText').textContent = room.password
      ? 'Odadakilerin mesajları bu şifreyle çözülemiyor: şifre yanlış olabilir. Doğru şifreyi gir.'
      : 'Bu kodla açık bir oda var ama şifreli. Oda şifresini gir.';
    $('#passDialog').returnValue = '';
    $('#passDialog').showModal();
    setTimeout(() => $('#passInput').focus(), 50);
  });
}

// ======================================================= Oynatma durumu

function applyMedia(m) {
  const hostNow = m.locked && S.room.members.has(m.hostId) ? m.hostId : null;
  if (hostNow !== S.lastHostId) {
    if (hostNow === S.room.selfId && S.lastHostId && m.byId !== S.room.selfId) toast(`${m.byName} kontrolü sana devretti. Artık oynatmayı yalnızca sen yönetiyorsun.`, 'success', 5000);
    S.lastHostId = hostNow;
    if (S.room) renderMembers(S.room.memberList());
  }
  if (m.label) {
    const who = m.byId === S.room.selfId ? 'Sen' : m.byName;
    $('#syncLabel').textContent = `${who} ${m.label}`;
    addHistory(`${who} ${m.label}`);
  }
  const src = m.src;
  if (src && document.activeElement !== $('#urlInput')) { $('#urlInput').value = src.url; $('#clearUrl').hidden = false; }

  if (m.screen) {
    const mine = m.screen.sharerId === S.room.selfId;
    if (mine && S.screen) S.stage.showScreen(S.screen, 'Ekranını paylaşıyorsun');
    else {
      const stream = findRemoteStream(m.screen.sharerId, m.screen.streamId);
      if (stream) S.stage.showScreen(stream, `${m.screen.sharerName} ekranını paylaşıyor`);
      else S.stage.showScreenWaiting(`${m.screen.sharerName} ekranını paylaşıyor · bağlanıyor…`);
    }
    setBadge('screen');
    $('#fsTitle').textContent = `${mine ? 'Sen' : m.screen.sharerName} · ekran yansıtma`;
    $('#embedNote').hidden = true;
    return;
  }
  setBadge(src ? src.kind : 'empty', src?.provider);
  $('#fsTitle').textContent = src ? (src.title || `${src.provider} · ${hostOf(src.url)}`) : '';
  const note = $('#embedNote');
  if (src && src.kind === 'embed') {
    note.textContent = `${src.provider}: Bu oynatıcı dışarıdan kontrol edilemediği için link herkeste açıldı ama oynat/duraklat herkeste ayrı. Aynı anda başlamak için geri sayım yapın ya da sekmeyi yansıtın.`;
    note.hidden = false;
  } else note.hidden = true;
  const room = S.room;
  const rate = Number(m.rate) > 0 ? Number(m.rate) : 1;
  setLockUI();
  updateRateUI(rate);
  const p = S.stage.load(src, { get time() { return room.positionNow(); }, playing: !!m.playing, rate });
  Promise.resolve(p).then(() => applySubs(m));
}
async function applySubs(m) {
  const want = m.subs?.url || '';
  if (S.stage.engine !== 'video') { S.subsKey = ''; return; }
  const key = `${S.stage.key}|${want}`;
  if (S.subsKey === key || S.localSubs) return;
  S.subsKey = key;
  try { await S.stage.setSubtitles(want ? { url: want, label: 'Altyazı' } : {}); }
  catch { toast('Altyazı indirilemedi (site izin vermiyor olabilir). Dosyayı “Dosyadan” ile yükleyebilirsin.', 'warn', 5000); }
}
function updateRateUI(rate) {
  $$('#rateSeg [data-rate]').forEach((b) => b.setAttribute('aria-checked', String(Number(b.dataset.rate) === rate)));
  const rb = $('#rateBadge'); rb.hidden = rate === 1; rb.textContent = `${rate}×`;
}
function canControl() {
  const md = S.room?.media;
  return !md || !md.locked || md.hostId === S.room.selfId || !S.room.members.has(md.hostId);
}
function deny() {
  if (Date.now() - S.lastDeniedToast > 2500) {
    S.lastDeniedToast = Date.now();
    const host = S.room.members.get(S.room.media.hostId)?.name || 'Oda sahibi';
    toast(`Kontrol kilitli: yalnızca ${host} oynatabilir, durdurabilir veya kaynak değiştirebilir.`, 'warn', 3500);
  }
  return false;
}
function setLockUI() {
  const md = S.room?.media;
  const locked = !!(md && md.locked && S.room.members.has(md.hostId));
  const mine = locked && md.hostId === S.room.selfId;
  const hostName = locked ? (mine ? 'Sen' : S.room.members.get(md.hostId)?.name || '') : '';
  $('#lockPill').hidden = !locked;
  $('#lockText').textContent = locked ? `Kilitli · ${hostName} yönetiyor` : '';
  $('#lockMenuLabel').textContent = mine ? 'Kontrol kilidini aç' : locked ? `Kilitli (${hostName})` : 'Kontrolü kilitle (yalnızca ben)';
  $('[data-menu=lock]').disabled = locked && !mine;
  $('#sheetLockLabel').textContent = mine ? 'Kilidi aç' : locked ? `Kilitli · ${hostName}` : 'Kontrolü kilitle';
  $('#player').classList.toggle('locked-out', locked && !mine);
}
function toggleLock() {
  const md = S.room?.media;
  if (md?.locked && md.hostId !== S.room.selfId && S.room.members.has(md.hostId)) return deny();
  const on = !md?.locked || !S.room.members.has(md.hostId);
  S.room.setMedia({ locked: on, hostId: on ? S.room.selfId : null }, on ? 'kontrolü kilitledi' : 'kontrol kilidini açtı');
  toast(on ? 'Kontrol kilitlendi: yalnızca sen yönetebilirsin.' : 'Kilit açıldı: herkes kontrol edebilir.', 'success', 3000);
}
function hostOf(u) { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } }
function setBadge(kind, provider) {
  const b = $('#engineBadge');
  b.className = `engine-badge k-${kind}`;
  b.textContent = kind === 'embed' || kind === 'web' ? (provider || KIND_LABEL[kind]) : KIND_LABEL[kind] || 'Web';
}

function rememberLink(src) {
  if (!src || src.isSearch) return;
  const list = store.json('recentLinks', []).filter((l) => l.url !== src.url);
  list.unshift({ url: src.url, provider: src.provider, label: `${src.provider} · ${hostOf(src.url)}` });
  store.setJson('recentLinks', list.slice(0, 8));
  renderQuickBar();
}
function renderQuickBar() {
  const recent = store.json('recentLinks', []).slice(0, 6);
  $('#quickBar').innerHTML = recent.map((r, i) => `<button class="chip recent" type="button" data-recent="${i}" title="${escapeHtml(r.url)}">${icon('history')}<span>${escapeHtml(shortUrl(r.url))}</span><small>${escapeHtml(r.provider)}</small></button>`).join('');
  $('#quickBar')._recent = recent;
}
function shortUrl(u) {
  try { const x = new URL(u); const p = x.pathname.length > 18 ? x.pathname.slice(0, 16) + '…' : x.pathname; return x.hostname.replace(/^www\./, '') + (p === '/' ? '' : p); } catch { return u.slice(0, 30); }
}

function openSource(raw, label) {
  if (!S.room) return;
  const src = parseInput(raw, env);
  if (!src) return toast('Bu adres anlaşılamadı. Tam linki yapıştırmayı dene.', 'warn');
  openSrc(src, label);
}
function openSrc(src, label, opts = {}) {
  if (!S.room) return;
  if (!canControl()) return deny();
  // Elle açılan link sıradaki bir öğeyse onu "şimdi oynuyor" yap, değilse sıradaki işaret kalksın
  if (!opts.fromQueue && S.room.queue?.items.length) {
    const hit = S.room.queue.items.find((it) => it.url === src.url);
    if ((hit?.id || null) !== S.room.queue.cur) S.room.setQueue({ cur: hit?.id || null });
  }
  S.localSubs = false;
  if (S.screen) stopScreenShare(false);
  if (S.room.media?.src) {
    S.history.push(S.room.media.src.url);
    if (S.history.length > 30) S.history.shift();
    $('#backBtn').disabled = false;
  }
  S.room.setMedia({ src, playing: !!src.syncable, time: src.start || 0, screen: null, rate: 1, subs: null }, label || `${src.isSearch ? 'arama yaptı' : 'şunu açtı'}: ${src.isSearch ? src.query : src.provider}`);
  rememberLink(src);
  if (src.kind === 'blocked') toast('Bu site gömülmeye izin vermiyor; herkese “yeni sekmede aç” kartı gösterildi.', 'warn', 5000);
  $('#urlInput').value = src.url; $('#clearUrl').hidden = false;
}

function onUserPlayerAction(a) {
  const room = S.room;
  if (!room || !room.media || room.media.screen) return;
  if (!canControl()) { deny(); S.stage.apply({ time: room.positionNow(), playing: !!room.media.playing, rate: room.media.rate || 1 }, 1); return; }
  const pos = room.positionNow();
  if (a.type !== 'seek' && room.media.playing === a.playing && Math.abs(a.time - pos) < 2) return;
  if (a.type === 'seek' && Math.abs(a.time - pos) < 1.5) return;
  const label = a.type === 'seek' ? `${formatTime(a.time)} konumuna atladı` : a.playing ? 'oynattı' : 'duraklattı';
  room.setMedia({ playing: a.playing, time: a.time }, label);
}
function transport(action) {
  const room = S.room;
  if (!room?.media || !S.stage.controllable) return;
  if (!canControl()) return deny();
  const cur = S.stage.getTime();
  const dur = S.stage.getDuration() || Infinity;
  if (action === 'toggle') room.setMedia({ playing: !room.media.playing, time: cur }, room.media.playing ? 'duraklattı' : 'oynattı');
  if (action === 'rew') room.setMedia({ time: Math.max(0, cur - 10) }, '10 sn geri aldı');
  if (action === 'fwd') room.setMedia({ time: Math.min(dur, cur + 10) }, '10 sn ileri sardı');
  if (action === 'resync') room.setMedia({ time: cur, playing: S.stage.isPlaying() }, 'herkesi kendi konumuna eşitledi');
}
function updateTransportUI() {
  if (!S.room || !S.stage.controllable) return;
  const cur = S.stage.getTime(), dur = S.stage.getDuration();
  $('#curTime').textContent = formatTime(cur);
  $('#durTime').textContent = dur ? formatTime(dur) : 'CANLI';
  const bar = $('#seekBar');
  if (dur > 0 && document.activeElement !== bar) bar.value = Math.round((cur / dur) * 1000);
  const playing = !!S.room.media?.playing;
  if (S.fs && $('#player').classList.contains('idle') && controlsMustStay()) wakeControls();
  const pb = $('#playBtn');
  if (pb.dataset.state !== String(playing)) { setIcon(pb, playing ? 'pause' : 'play'); pb.dataset.state = String(playing); pb.setAttribute('aria-label', playing ? 'Duraklat' : 'Oynat'); }
}

// ======================================================= Ortak izleme sırası
// Sıra odada herkesle paylaşılır. "cur" o an oynayan öğedir; Sonraki/Önceki ve video bitince otomatik geçiş buna göre çalışır.

const qItems = () => S.room?.queue?.items || [];
function qIndex() { const q = S.room?.queue; return q && q.cur ? q.items.findIndex((it) => it.id === q.cur) : -1; }
function fileTitle(url) {
  try {
    const seg = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() || '');
    const t = seg.replace(/\.(mp4|webm|m4v|mov|ogv|ogg|m3u8|mkv)$/i, '').replace(/[_+.]+/g, ' ').replace(/\s+/g, ' ').trim();
    return t && t.length > 2 ? t.slice(0, 80) : '';
  } catch { return ''; }
}
function queueLabel(src) {
  if (src.title) return src.title;
  if (src.kind === 'youtube') return 'YouTube videosu';
  if (src.kind === 'vimeo') return 'Vimeo videosu';
  if (src.kind === 'video') return fileTitle(src.url) || `${src.provider || 'Video'} · ${hostOf(src.url)}`;
  return `${src.provider || 'Bağlantı'} · ${hostOf(src.url)}`;
}
/** YouTube / Vimeo başlığını resmî oEmbed uç noktasından alır (yalnızca başlık; 4 sn zaman aşımı) */
async function fetchTitle(src) {
  const u = src.kind === 'youtube' ? `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(src.url)}`
    : src.kind === 'vimeo' ? `https://vimeo.com/api/oembed.json?url=${encodeURIComponent(src.url)}` : '';
  if (!u) return '';
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 4000);
  try { const r = await fetch(u, { signal: ac.signal, credentials: 'omit' }); if (!r.ok) return ''; const j = await r.json(); return String(j.title || '').slice(0, 120); }
  catch { return ''; } finally { clearTimeout(t); }
}
function makeItem(src, title) {
  return { id: Math.random().toString(36).slice(2, 10), url: src.url, title: (title || queueLabel(src)).slice(0, 120), provider: src.provider || KIND_LABEL[src.kind] || '', by: S.room?.name || '' };
}
function addToQueue(srcOrRaw, title, { quiet = false } = {}) {
  if (!S.room) return false;
  if (!canControl()) return deny();
  const src = typeof srcOrRaw === 'string' ? parseInput(srcOrRaw, env) : srcOrRaw;
  if (!src || src.isSearch || !/^https?:\/\//i.test(src.url || '')) { toast('Sıraya yalnızca bir link (https://…) eklenebilir.', 'warn'); return false; }
  const items = qItems();
  if (items.length >= 50) { toast('Sıra dolu (en fazla 50 öğe).', 'warn'); return false; }
  if (items.some((it) => it.url === src.url)) { toast('Bu link zaten sırada.', 'info', 2000); return false; }
  const item = makeItem(src, title);
  // Hiçbir şey oynamıyorsa ve sıra boşsa doğrudan başlat
  const idle = !S.room.media?.src && !S.room.media?.screen && !items.length;
  S.room.setQueue({ items: [...items, item], cur: idle ? item.id : S.room.queue?.cur || null });
  if (idle) { openSrc(src, `sıradan başlattı: ${item.title}`, { fromQueue: true }); refineTitle(src, item, title); return true; }
  if (!quiet) toast(`Sıraya eklendi: ${item.title}`, 'success', 3500, { action: { label: 'Geri al', fn: () => removeFromQueue(item.id) } });
  refineTitle(src, item, title);
  return true;
}
function refineTitle(src, item, title) {
  if (title || src.title || (src.kind !== 'youtube' && src.kind !== 'vimeo')) return;
  const room = S.room;
  fetchTitle(src).then((t) => {
    if (!t || S.room !== room || !canControl()) return;
    const items = qItems(); const i = items.findIndex((x) => x.id === item.id);
    if (i < 0 || items[i].title !== item.title) return;
    S.room.setQueue({ items: items.map((x) => (x.id === item.id ? { ...x, title: t } : x)) });
  });
}
function removeFromQueue(id) {
  if (!S.room || !canControl()) return deny();
  const items = qItems().filter((it) => it.id !== id);
  S.room.setQueue({ items, cur: S.room.queue?.cur === id ? null : S.room.queue?.cur });
}
function moveInQueue(id, dir) {
  if (!S.room || !canControl()) return deny();
  const items = [...qItems()];
  const i = items.findIndex((it) => it.id === id), j = i + dir;
  if (i < 0 || j < 0 || j >= items.length) return;
  [items[i], items[j]] = [items[j], items[i]];
  S.room.setQueue({ items });
  requestAnimationFrame(() => $(`#queueList li[data-qid="${CSS.escape(id)}"] [data-qmove="${dir}"]`)?.focus());
}
function playQueueItem(id, why = '') {
  if (!S.room) return;
  if (!canControl()) return deny();
  const it = qItems().find((x) => x.id === id); if (!it) return;
  const src = parseInput(it.url, env);
  if (!src) return toast('Bu öğe açılamadı.', 'warn');
  if (it.title) src.title = src.title || it.title;
  S.room.setQueue({ cur: id });
  openSrc(src, `${why || 'sıradan açtı'}: ${it.title}`, { fromQueue: true });
}
function queueStep(dir, auto = false) {
  const items = qItems();
  if (!items.length) { if (!auto) toast('Sırada başka öğe yok. “Sıra” sekmesinden ekleyebilirsin.', 'info', 2500); return false; }
  const i = qIndex();
  const j = i < 0 ? (dir > 0 ? 0 : -1) : i + dir;
  if (j < 0 || j >= items.length) { if (!auto) toast(dir > 0 ? 'Sıranın sonuna geldiniz.' : 'Sıranın başındasınız.', 'info', 2000); return false; }
  playQueueItem(items[j].id, auto ? 'sıradakine geçti' : dir > 0 ? 'sıradakine geçti' : 'öncekine döndü');
  return true;
}
/** Video bitti: yalnızca son işlemi yapan kişi (o yoksa odadaki en eski üye) sıradakini başlatır; böylece tek komut gider */
function onMediaEnded() {
  const room = S.room;
  if (!room?.media?.src || !room.queue?.auto) return;
  const key = `${room.media.ver}|${room.media.src.url}`;
  if (S.lastEndedKey === key) return;
  const items = qItems(), i = qIndex();
  const next = items[i + 1];
  if (!next) return;
  const authority = room.members.has(room.media.byId) ? room.media.byId : room.memberList()[0]?.id;
  const md = room.media;
  const host = md.locked && room.members.has(md.hostId) ? md.hostId : null;
  if ((host || authority) !== room.selfId) return;
  S.lastEndedKey = key;
  toast(`Sıradaki başlıyor: ${next.title}`, 'info', 2500);
  setTimeout(() => { if (S.room === room && room.media && `${room.media.ver}|${room.media.src?.url}` === key) queueStep(1, true); }, 1500);
}
function renderQueueBadge() {
  const n = qItems().length;
  const c = $('#queueCount'); c.textContent = n; c.hidden = !n;
  $('#sheetQueue').textContent = n;
}
function renderQueue() {
  const items = qItems();
  const cur = qIndex();
  renderQueueBadge();
  $('#queueEmpty').hidden = !!items.length;
  $('#queueClear').hidden = !items.length;
  $('#queueAuto').checked = S.room?.queue ? S.room.queue.auto !== false : true;
  const locked = !canControl();
  const ol = $('#queueList');
  const focusId = document.activeElement?.closest?.('#queueList li')?.dataset.qid;
  ol.innerHTML = items.map((it, i) => `<li data-qid="${escapeHtml(it.id)}" class="${i === cur ? 'cur' : i < cur ? 'done' : ''}">
    <button type="button" class="q-main" data-qplay="${escapeHtml(it.id)}" ${locked ? 'disabled' : ''} title="${escapeHtml(it.url)}" aria-label="${escapeHtml(it.title)} — şimdi oynat">
      <span class="q-n">${i === cur ? icon('play') : i + 1}</span>
      <span class="q-t"><b>${escapeHtml(it.title)}</b><small>${escapeHtml([i === cur ? 'Şimdi oynuyor' : '', it.provider, it.by ? `${it.by} ekledi` : ''].filter(Boolean).join(' · '))}</small></span>
    </button>
    <span class="q-acts">
      <button type="button" class="mini-btn" data-qmove="-1" data-qid-btn="${escapeHtml(it.id)}" aria-label="Yukarı taşı" title="Yukarı" ${i === 0 || locked ? 'disabled' : ''}>${icon('chevronUp')}</button>
      <button type="button" class="mini-btn" data-qmove="1" data-qid-btn="${escapeHtml(it.id)}" aria-label="Aşağı taşı" title="Aşağı" ${i === items.length - 1 || locked ? 'disabled' : ''}>${icon('chevronDown')}</button>
      <button type="button" class="mini-btn" data-qdel="${escapeHtml(it.id)}" aria-label="Sıradan kaldır" title="Kaldır" ${locked ? 'disabled' : ''}>${icon('x')}</button>
    </span></li>`).join('');
  if (focusId) ol.querySelector(`li[data-qid="${CSS.escape(focusId)}"] .q-main`)?.focus({ preventScroll: true });
  // Taşıma düğmeleri: Sonraki / Önceki
  const hasNext = items.length > 0 && cur < items.length - 1;
  const hasPrev = cur > 0;
  $('#nextBtn').hidden = !hasNext; $('#prevBtn').hidden = !hasPrev;
  if (hasNext) $('#nextBtn').title = `Sıradaki: ${items[cur + 1].title} (N)`;
}

// ======================================================= 3-2-1 geri sayım
// Başlatan kişi oynatmayı duraklatır ve herkese "şu anda başla" zamanını gönderir. Herkes geri sayımı kendi saatine
// çevirerek (NTP benzeri saat farkı) aynı anda görür; sıfırda başlatan "oynat" komutunu yollar.
const CD_MS = 3000;
function startCountdown() {
  const room = S.room;
  if (!room) return;
  if (S.countdown) { room.send('countdown', { id: S.countdown.id, cancel: true }); cancelCountdown(true); return; }
  if (!canControl()) return deny();
  if (!room.media?.src && !room.media?.screen) return toast('Önce bir video aç; sonra geri sayımla herkesle aynı anda başlatın.', 'info', 3500);
  const id = Math.random().toString(36).slice(2, 10);
  const at = Date.now() + CD_MS;
  if (S.stage.controllable && room.media.playing) room.setMedia({ playing: false, time: S.stage.getTime() }, 'geri sayım başlattı');
  room.send('countdown', { id, at, name: room.name });
  runCountdown({ id, at, by: room.selfId, name: 'Sen' });
}
function onCountdown(d, from) {
  if (!d || typeof d.id !== 'string') return;
  if (d.cancel) { if (S.countdown?.id === d.id) { cancelCountdown(false); toast(`${S.room.members.get(from)?.name || 'Biri'} geri sayımı iptal etti.`, 'info', 2000); } return; }
  const local = S.room.localTimeOf(from, Number(d.at));
  const now = Date.now();
  const at = local !== null && local > now - 500 && local < now + 8000 ? local : now + CD_MS;
  runCountdown({ id: d.id, at, by: from, name: S.room.members.get(from)?.name || String(d.name || 'Biri').slice(0, 24) });
}
function runCountdown(cd) {
  cancelCountdown(false);
  S.countdown = cd;
  const box = $('#countdown');
  box.hidden = false;
  $('#cdSub').textContent = `${cd.name} geri sayımı başlattı · hazır olun`;
  $('#countdownBtn').classList.add('on');
  if (S.fs) wakeControls();
  let last = null;
  const tick = () => {
    if (S.countdown !== cd) return;
    const left = cd.at - Date.now();
    if (left <= 0) {
      $('#cdNum').textContent = 'Başla!';
      box.classList.add('go');
      $('#cdSub').textContent = S.stage.controllable ? 'İyi seyirler!' : 'Şimdi herkes oynat’a bassın!';
      if (cd.by === S.room?.selfId && S.room.media && S.stage.controllable) S.room.setMedia({ playing: true, time: S.stage.getTime() }, 'geri sayımla başlattı');
      cd.timer = setTimeout(() => { if (S.countdown === cd) cancelCountdown(false); }, 1100);
      return;
    }
    const n = Math.ceil(left / 1000);
    if (n !== last) { last = n; $('#cdNum').textContent = String(n); box.classList.remove('pop'); void box.offsetWidth; box.classList.add('pop'); ping(); }
    cd.timer = setTimeout(tick, Math.min(100, left));
  };
  tick();
}
function cancelCountdown(announce) {
  const cd = S.countdown;
  if (cd) clearTimeout(cd.timer);
  S.countdown = null;
  const box = $('#countdown'); if (box) { box.hidden = true; box.classList.remove('go', 'pop'); }
  $('#countdownBtn')?.classList.remove('on');
  if (announce && cd) toast('Geri sayım iptal edildi.', 'info', 1800);
}

// ======================================================= Davet (QR kod)
function openInvite() {
  if (!S.room) return;
  const link = inviteLink(S.room.code);
  const text = `Birlikte izleyelim! CineSync oda kodu: ${S.room.code}`;
  $('#invCode').textContent = S.room.code;
  $('#invLink').value = link;
  $('#invPass').hidden = !S.room.password;
  try { $('#qrBox').innerHTML = qrSvg(link); } catch { $('#qrBox').innerHTML = '<p class="muted tiny">QR kod üretilemedi.</p>'; }
  $('#invWa').href = `https://wa.me/?text=${encodeURIComponent(`${text} ${link}`)}`;
  $('#invTg').href = `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(text)}`;
  $('#invMail').href = `mailto:?subject=${encodeURIComponent('CineSync daveti')}&body=${encodeURIComponent(`${text}\n${link}`)}`;
  $('#invShare').hidden = !navigator.share;
  if (S.fs) exitFullscreen();
  closePops();
  $('#inviteDialog').showModal();
  $('#invCopy').focus();
}

// ======================================================= Altyazı zamanlaması ve boyutu (yalnızca bu cihazda)
function shiftSubs(delta) {
  if (!S.stage.hasSubtitles) return toast('Önce bir altyazı ekle.', 'info', 2000);
  const v = delta === 0 ? 0 : S.stage.subsOffset + delta;
  const off = S.stage.setSubtitleOffset(v);
  $('#subsOffVal').textContent = `${off > 0 ? '+' : ''}${off.toFixed(1).replace('.', ',')} sn`;
}
function setSubsSize(sz) {
  S.subsSize = ['s', 'm', 'l'].includes(sz) ? sz : 'm';
  store.set('subsSize', S.subsSize);
  const v = $('#stageVideo');
  v.classList.remove('subs-s', 'subs-m', 'subs-l'); v.classList.add('subs-' + S.subsSize);
  $$('#subsSize [data-subs-size]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.subsSize === S.subsSize)));
}
function updateSubsTune() {
  const on = S.stage.hasSubtitles;
  $('#subsTune').classList.toggle('disabled', !on);
  const off = S.stage.subsOffset || 0;
  $('#subsOffVal').textContent = `${off > 0 ? '+' : ''}${off.toFixed(1).replace('.', ',')} sn`;
}

// ======================================================= Görünüm (tema, vurgu rengi)
function renderAppearance() {
  const pref = themePref();
  $$('#themeSeg [data-theme-opt]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.themeOpt === pref)));
  const acc = accentPref();
  $('#accentPicker').innerHTML = ACCENTS.map((a) => `<button type="button" class="swatch" role="radio" aria-checked="${a.id === acc}" aria-label="${a.label}" title="${a.label}" style="--c:${a.c}" data-accent="${a.id}"></button>`).join('');
}
function updateThemeLabels(theme = effectiveTheme()) {
  const next = theme === 'light' ? 'Koyu tema' : 'Açık tema';
  const ic = theme === 'light' ? 'moon' : 'sun';
  for (const el of [$('#themeMenuLabel'), $('#sheetThemeLabel')]) if (el) el.textContent = next;
  for (const b of [$('[data-menu=theme]'), $('[data-sheet=theme]'), $('#themeBtn')]) if (b) setIcon(b, ic);
  $('#themeBtn')?.setAttribute('aria-label', `${next}ya geç`);
}

// ======================================================= Ekran paylaşımı

async function startScreenShare() {
  if (!S.room) return;
  if (S.screen) return stopScreenShare(true);
  if (!navigator.mediaDevices?.getDisplayMedia) return toast('Bu cihaz/tarayıcı ekran paylaşımını desteklemiyor (mobil tarayıcılar genelde desteklemez).', 'warn', 5000);
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 30 } }, audio: true });
    S.screen = stream;
    stream.getVideoTracks()[0].addEventListener('ended', () => stopScreenShare(true));
    S.mesh.setStream('screen', stream);
    S.room.updateSelf({ screenStreamId: stream.id });
    S.room.setMedia({ screen: { sharerId: S.room.selfId, sharerName: S.room.name, streamId: stream.id } }, 'ekranını yansıtmaya başladı');
    $('#screenBtn').classList.add('on');
    toast('Yansıtma başladı. Ses için paylaşırken “Sekme sesini paylaş” seçeneğini işaretle.', 'success', 5000);
  } catch (e) {
    if (e?.name !== 'NotAllowedError') toast('Ekran paylaşımı başlatılamadı.', 'error');
  }
}
function stopScreenShare(broadcast) {
  if (!S.screen) return;
  S.screen.getTracks().forEach((t) => t.stop());
  S.screen = null;
  $('#screenBtn').classList.remove('on');
  if (S.mesh) S.mesh.setStream('screen', null);
  if (S.room) {
    S.room.updateSelf({ screenStreamId: null });
    if (broadcast && S.room.media?.screen?.sharerId === S.room.selfId) S.room.setMedia({ screen: null }, 'yansıtmayı bitirdi');
  }
}

// ======================================================= Uzak medya, kutucuklar, PiP

function onRemoteTrack(peerId, stream) {
  if (!S.remote.has(peerId)) S.remote.set(peerId, new Map());
  S.remote.get(peerId).set(stream.id, stream);
  stream.onremovetrack = () => refreshRemoteMedia();
  refreshRemoteMedia();
}
const findRemoteStream = (peerId, streamId) => S.remote.get(peerId)?.get(streamId) || null;
function camStreamOf(m) {
  const streams = S.remote.get(m.id);
  let cam = null;
  if (streams) for (const [sid, st] of streams) if (sid !== m.screenStreamId) cam = st;
  return cam;
}
function peerVolume(m) { const v = Number(S.peerVol[m?.name]); return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1; }
function applyRemoteMute(m) {
  const muted = S.muteRemote || S.mutedPeers.has(m.id);
  const vol = peerVolume(m);
  for (const a of (S.audioEls.get(m.id) || new Map()).values()) { a.muted = muted; try { a.volume = vol; } catch {} }
}
function setPeerVolume(id, v) {
  const m = S.room?.members.get(id); if (!m) return;
  S.peerVol[m.name] = Math.round(v * 100) / 100;
  if (S.peerVol[m.name] === 1) delete S.peerVol[m.name];
  store.setJson('peerVol', S.peerVol);
  applyRemoteMute(m);
}
// Uzak ses, görüntüden ayrı, sade <audio> öğeleriyle çalınır:
//  • Mobil tarayıcılar arka plandaki <video> öğelerini duraklatabilir; <audio> çalmaya devam eder.
//  • Ses yönlendirmesi (kulaklık / Bluetooth / hoparlör) işletim sistemine bırakılır; setSinkId yalnızca
//    kullanıcı açıkça bir çıkış cihazı seçerse (masaüstü Chrome/Edge) kullanılır.
function ensureAudio(peerId, stream) {
  if (!S.audioEls.has(peerId)) S.audioEls.set(peerId, new Map());
  const map = S.audioEls.get(peerId);
  let a = map.get(stream.id);
  if (!a) {
    a = document.createElement('audio');
    a.autoplay = true; a.setAttribute('playsinline', ''); a.dataset.peer = peerId;
    $('#remoteAudio').appendChild(a);
    map.set(stream.id, a);
    if (S.dev.out && a.setSinkId) a.setSinkId(S.dev.out).catch(() => {});
  }
  if (a.srcObject !== stream) a.srcObject = stream;
  playAudio(a);
  return a;
}
function playAudio(a) {
  if (!a.srcObject || !a.paused) return;
  a.play().then(() => { if (S.audioBlocked && [...$$('#remoteAudio audio')].every((x) => !x.paused || !x.srcObject)) { S.audioBlocked = false; $('#audioUnlock').hidden = true; } })
    .catch((e) => { if (e?.name === 'NotAllowedError') { S.audioBlocked = true; $('#audioUnlock').hidden = false; } });
}
function dropAudio(peerId) {
  for (const a of (S.audioEls.get(peerId) || new Map()).values()) { try { a.pause(); a.srcObject = null; a.remove(); } catch {} }
  S.audioEls.delete(peerId);
}
/** Tüm uzak sesleri (ve görüntüleri) yeniden başlatır: öne gelince, cihaz değişince, dokununca */
function resumeAudio(reattach = false) {
  for (const a of $$('#remoteAudio audio')) {
    if (reattach && a.srcObject) { const st = a.srcObject; a.srcObject = null; a.srcObject = st; if (S.dev.out && a.setSinkId) a.setSinkId(S.dev.out).catch(() => {}); }
    playAudio(a);
  }
  for (const v of $$('#videoGrid video, #pipLayer video, #stageScreen video')) if (v.srcObject && v.paused) v.play().catch(() => {});
}
function refreshRemoteMedia() {
  if (!S.room) return;
  for (const m of S.room.memberList()) {
    if (m.self) continue;
    const cam = camStreamOf(m);
    const tile = ensureTile(m);
    const v = tile.querySelector('video');
    v.muted = true; // ses <audio> öğesinden gelir
    if (cam && v.srcObject !== cam) { v.srcObject = cam; v.play().catch(() => {}); }
    const streams = S.remote.get(m.id);
    if (streams) for (const [sid, st] of streams) { if (sid !== m.screenStreamId && st.getAudioTracks().length) ensureAudio(m.id, st); }
    applyRemoteMute(m);
    const showVideo = !!(cam && m.cam && cam.getVideoTracks().some((t) => t.readyState === 'live'));
    v.style.opacity = showVideo ? 1 : 0;
    tile.querySelector('.avatar').hidden = showVideo;
  }
  const sc = S.room.media?.screen;
  if (sc && sc.sharerId !== S.room.selfId) {
    const st = findRemoteStream(sc.sharerId, sc.streamId);
    if (st) S.stage.showScreen(st, `${sc.sharerName} ekranını paylaşıyor`);
  }
  refreshPip();
}
function refreshPip() {
  if (!S.pip) return;
  if (!S.room) return S.pip.render([]);
  const items = [];
  if (S.camOn && S.cam) items.push({ id: 'self', self: true, name: S.room.name, color: S.color, stream: S.cam });
  for (const m of S.room.memberList()) {
    if (m.self || !m.cam) continue;
    const cam = camStreamOf(m);
    if (cam) items.push({ id: m.id, name: m.name, color: memberColor(m), stream: cam });
  }
  if (window.__testPips) items.push(...window.__testPips); // yalnızca otomatik testler için
  S.pip.render(items);
  const btn = $('#fsCamsBtn');
  btn.disabled = !items.length;
  btn.title = items.length ? 'Kameraları gizle / göster (V)' : 'Açık kamera yok';
}
function ensureTile(m) {
  let tile = document.getElementById('tile-' + m.id);
  if (!tile) {
    tile = document.createElement('div');
    tile.className = 'tile'; tile.id = 'tile-' + m.id; tile.dataset.id = m.id;
    tile.innerHTML = `<video autoplay playsinline muted style="opacity:0"></video><div class="avatar"><span></span></div><div class="tile-label"><span class="q" aria-hidden="true"><i></i><i></i><i></i></span><span class="name"></span><span class="flags"></span></div><button type="button" class="tile-mute" aria-label="Bu kişinin sesini kapat">${icon('volume')}</button>`;
    tile.querySelector('.tile-mute').addEventListener('click', () => {
      if (S.mutedPeers.has(m.id)) S.mutedPeers.delete(m.id); else S.mutedPeers.add(m.id);
      const on = S.mutedPeers.has(m.id);
      const b = tile.querySelector('.tile-mute');
      b.classList.toggle('on', on); setIcon(b, on ? 'volumeOff' : 'volume');
      b.setAttribute('aria-label', on ? 'Bu kişinin sesini aç' : 'Bu kişinin sesini kapat');
      refreshRemoteMedia();
    });
    $('#videoGrid').appendChild(tile);
  }
  const av = tile.querySelector('.avatar span');
  av.textContent = initials(m.name); av.style.background = memberColor(m);
  tile.querySelector('.name').textContent = m.name;
  tile.querySelector('.flags').innerHTML = m.mic ? '' : icon('micOff');
  return tile;
}
function removeTile(id) { document.getElementById('tile-' + id)?.remove(); }
const Q_LABEL = { good: 'Bağlantı iyi', fair: 'Bağlantı orta', poor: 'Bağlantı zayıf', down: 'Bağlantı koptu · yeniden bağlanıyor', connecting: 'Bağlanıyor…', away: 'Arka planda / yanıt vermiyor' };
function qualityOf(m) {
  if (!m || m.self) return '';
  if (m.away) return 'away';
  const ps = S.peerState.get(m.id);
  if (!ps) return '';
  if (ps.state === 'failed' || ps.state === 'disconnected') return 'down';
  return ps.quality || (ps.state === 'connected' ? 'good' : 'connecting');
}
function updateQuality(id) {
  const m = S.room?.members.get(id); if (!m) return;
  const q = qualityOf(m);
  const tile = document.getElementById('tile-' + id);
  if (tile) { tile.dataset.q = q; tile.querySelector('.q')?.setAttribute('title', Q_LABEL[q] || ''); tile.classList.toggle('away', !!m.away); }
  const li = $(`#memberList li[data-id="${CSS.escape(id)}"]`);
  if (li) { li.dataset.q = q; const qs = li.querySelector('.q'); if (qs) { const t = qualityText(m); qs.title = t; qs.setAttribute('aria-label', t); } const st = li.querySelector('.st'); if (st) st.textContent = m.away ? 'arka planda' : m.hidden ? 'başka sekmede' : ''; }
}
/** Bağlantı kalitesi + ölçülen gecikme (varsa): "Bağlantı iyi · 42 ms" */
function qualityText(m) {
  const q = qualityOf(m);
  const rtt = S.mesh?.info?.(m.id)?.rtt;
  return (Q_LABEL[q] || '') + (Number.isFinite(rtt) && q !== 'down' && q !== 'away' ? ` · ${Math.round(rtt)} ms` : '');
}
function memberHtml(m, host) {
  const md = S.room?.media;
  const iAmHost = host && host === S.room.selfId;
  const isHost = host === m.id;
  const vol = Math.round(peerVolume(m) * 100);
  return `<span class="av" style="background:${memberColor(m)}">${escapeHtml(initials(m.name))}</span>
    <span class="nm">${isHost ? `<span class="crown" title="Oda sahibi (kontrol onda)">${icon('crown')}</span>` : ''}${escapeHtml(m.name)}${m.self ? ' <span class="muted">(sen)</span>' : ''} <small class="st muted">${m.away ? 'arka planda' : m.hidden ? 'başka sekmede' : ''}</small></span>
    ${m.self ? '' : `<span class="q" role="img" aria-label="${escapeHtml(qualityText(m))}" title="${escapeHtml(qualityText(m))}"><i></i><i></i><i></i></span>`}
    <span class="sr-only">${m.mic ? 'mikrofon açık' : 'mikrofon kapalı'}, ${m.cam ? 'kamera açık' : 'kamera kapalı'}</span>
    ${icon(m.mic ? 'mic' : 'micOff', m.mic ? 'on' : '')}${icon(m.cam ? 'cam' : 'camOff', m.cam ? 'on' : '')}
    ${m.self ? '' : `<div class="m-row">
      <label class="pvol" title="${escapeHtml(m.name)} ses düzeyi">${icon(vol ? 'volume' : 'volumeOff')}<input type="range" min="0" max="100" step="5" value="${vol}" data-vol-id="${escapeHtml(m.id)}" aria-label="${escapeHtml(m.name)} ses düzeyi"><output>${vol}%</output></label>
      ${iAmHost && md?.locked ? `<button type="button" class="mini-btn handover" data-handover="${escapeHtml(m.id)}" title="Kontrolü ${escapeHtml(m.name)} kişisine devret" aria-label="Kontrolü ${escapeHtml(m.name)} kişisine devret">${icon('crown')}<span>Devret</span></button>` : ''}
    </div>`}`;
}
/** Kişi listesi: her kalp atışında yeniden çizmek kaydırıcıyı/odaklanmayı bozardı; yalnızca değişen satır güncellenir */
function renderMembers(list) {
  $('#memberCount').textContent = list.length;
  $('#sheetCount').textContent = list.length;
  const ul = $('#memberList');
  const md = S.room?.media;
  const host = md && md.locked && S.room?.members.has(md.hostId) ? md.hostId : null;
  const keep = new Set(list.map((m) => m.id));
  for (const li of [...ul.children]) if (!keep.has(li.dataset.id)) li.remove();
  list.forEach((m, i) => {
    const html = memberHtml(m, host);
    let li = ul.querySelector(`li[data-id="${CSS.escape(m.id)}"]`);
    if (!li) { li = document.createElement('li'); li.dataset.id = m.id; }
    if (ul.children[i] !== li) ul.insertBefore(li, ul.children[i] || null);
    li.dataset.q = qualityOf(m);
    li.classList.toggle('is-host', host === m.id);
    if (li._html !== html && !li.contains(document.activeElement)) { li.innerHTML = html; li._html = html; }
  });
  for (const m of list) if (!m.self) { ensureTile(m); updateQuality(m.id); }
  refreshRemoteMedia();
}
function handOver(id) {
  const md = S.room?.media, m = S.room?.members.get(id);
  if (!m || !md?.locked || md.hostId !== S.room.selfId) return;
  S.room.setMedia({ locked: true, hostId: id }, `kontrolü ${m.name} kişisine devretti`);
  toast(`Kontrol ${m.name} kişisine devredildi.`, 'success', 3000);
  renderMembers(S.room.memberList());
}

// ======================================================= Sohbet

function clearChatEmpty() { $('#chatList .chat-empty')?.remove(); }
function chatVisible() { return !document.hidden && (S.tab === 'chat' || false) && !$('#roomView').hidden && !(S.fs); }
const normName = (n) => String(n || '').toLocaleLowerCase('tr-TR').replace(/\s+/g, ' ').trim();
/** Mesaj beni anıyor mu? "@Veysel" ya da çok kelimeli adın tamamı ("@Misafir 123") */
function mentionsMe(text) {
  if (!S.room) return false;
  const me = normName(S.room.name);
  const t = normName(text);
  if (!me) return false;
  if (t.includes('@' + me)) return true;
  const first = me.split(' ')[0];
  return first.length >= 2 && new RegExp(`(^|\\s)@${first.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'u').test(t);
}
/** Bağlantıları tıklanabilir yapar, @bahsetmeleri vurgular */
function formatChat(text) {
  return linkify(text).replace(/(^|\s)@([\p{L}\p{N}_.-]{1,24})/gu, (m0, sp, name) => `${sp}<span class="mention">@${name}</span>`);
}
function renderChat(msg) {
  clearChatEmpty();
  const list = $('#chatList');
  const mine = msg.fromId === S.room?.selfId;
  const el = document.createElement('div');
  const atMe = !mine && mentionsMe(msg.text);
  el.className = 'msg' + (mine ? ' mine' : '') + (atMe ? ' mentioned' : '');
  el.dataset.id = msg.id || '';
  const q = msg.reply && typeof msg.reply === 'object' ? `<a class="quote" href="#" data-goto="${escapeHtml(String(msg.reply.id || ''))}">↪ <b>${escapeHtml(String(msg.reply.name || ''))}</b>: ${escapeHtml(String(msg.reply.text || ''))}</a>` : '';
  el.innerHTML = `<div class="meta"><b>${escapeHtml(mine ? 'Sen' : msg.name)}</b> · ${clockTime(msg.ts)}</div><div class="bubble">${q}${formatChat(msg.text)}</div>
    <div class="msg-acts"><button type="button" class="react-btn" data-react-open aria-label="Tepki ekle" title="Tepki ekle">${icon('smilePlus')}</button><button type="button" class="reply-btn" data-reply aria-label="Yanıtla" title="Yanıtla">${icon('reply')}</button></div>
    <div class="reacts" role="group" aria-label="Tepkiler"></div>`;
  el.querySelector('[data-reply]').addEventListener('click', () => setReply({ id: msg.id, name: mine ? S.room.name : msg.name, text: msg.text }));
  if (!mine && S.typing.has(msg.fromId)) { clearTimeout(S.typing.get(msg.fromId).t); S.typing.delete(msg.fromId); renderTyping(); }
  const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
  list.appendChild(el);
  renderReacts(msg);
  if (nearBottom || mine) list.scrollTop = list.scrollHeight;
  if (!mine) {
    if (!chatVisible()) { S.unread++; for (const b of [$('#unread'), $('#mUnread')]) { b.textContent = S.unread > 99 ? '99+' : S.unread; b.hidden = false; } updateTitle(); }
    if (document.hidden || !chatVisible() || atMe) ping();
    if (atMe && (!chatVisible() || S.fs)) toast(`${msg.name} senden bahsetti: ${msg.text.slice(0, 80)}`, 'info', 5000, { action: { label: 'Göster', fn: () => { if (S.fs) exitFullscreen(); switchTab('chat'); el.scrollIntoView({ block: 'center' }); } } });
    else if (S.fs && S.chatToasts) toast(`${msg.name}: ${msg.text.slice(0, 80)}`, 'info', 3000);
  }
}
/** Bir mesajın altındaki tepki çiplerini (👍 2) çizer */
function renderReacts(msg) {
  const el = $(`#chatList .msg[data-id="${CSS.escape(msg.id || '')}"] .reacts`);
  if (!el || !S.room) return;
  const r = msg.reacts || {};
  const names = (ids) => ids.map((id) => id === S.room.selfId ? 'Sen' : S.room.members.get(id)?.name || 'biri').join(', ');
  el.innerHTML = Object.entries(r).filter(([, ids]) => ids.length).map(([e, ids]) => {
    const minePressed = ids.includes(S.room.selfId);
    return `<button type="button" class="react-chip" data-react="${escapeHtml(e)}" aria-pressed="${minePressed}" title="${escapeHtml(names(ids))}" aria-label="${escapeHtml(e)} tepkisi, ${ids.length} kişi${minePressed ? ', sen de dahil' : ''}">${escapeHtml(e)}<b>${ids.length}</b></button>`;
  }).join('');
  el.hidden = !el.childElementCount;
}
function toggleReact(id, e) {
  const msg = S.room?.chat.find((m) => m.id === id); if (!msg) return;
  const on = !(msg.reacts?.[e] || []).includes(S.room.selfId);
  S.room.reactChat(id, e, on);
}
function openReactPicker(msgEl) {
  closeReactPicker();
  const pick = document.createElement('div');
  pick.className = 'react-pick';
  pick.setAttribute('role', 'group'); pick.setAttribute('aria-label', 'Tepki seç');
  pick.innerHTML = QUICK_REACTS.map((e) => `<button type="button" data-pick="${e}" aria-label="${e} tepkisi">${e}</button>`).join('');
  msgEl.appendChild(pick);
  pick.querySelector('button').focus({ preventScroll: true });
}
function closeReactPicker() { $$('#chatList .react-pick').forEach((x) => x.remove()); }

// ---- @bahsetme önerileri
function mentionQuery() {
  const inp = $('#chatInput');
  const before = inp.value.slice(0, inp.selectionStart ?? inp.value.length);
  const m = before.match(/(?:^|\s)@([\p{L}\p{N}_.-]{0,24})$/u);
  return m ? { q: m[1], start: before.length - m[1].length - 1 } : null;
}
function updateMentions() {
  const box = $('#mentionList');
  const mq = S.room ? mentionQuery() : null;
  const others = S.room ? S.room.memberList().filter((m) => !m.self) : [];
  const hits = mq ? others.filter((m) => normName(m.name).startsWith(normName(mq.q)) || normName(m.name).includes(' ' + normName(mq.q))).slice(0, 6) : [];
  if (!hits.length) { box.hidden = true; box._hits = []; $('#chatInput').removeAttribute('aria-activedescendant'); return; }
  S.mentionIdx = Math.min(S.mentionIdx, hits.length - 1);
  box._hits = hits; box._q = mq;
  box.innerHTML = hits.map((m, i) => `<button type="button" role="option" id="mention-${i}" data-mention="${i}" aria-selected="${i === S.mentionIdx}"><span class="av" style="background:${memberColor(m)}">${escapeHtml(initials(m.name))}</span>${escapeHtml(m.name)}</button>`).join('');
  box.hidden = false;
  $('#chatInput').setAttribute('aria-activedescendant', `mention-${S.mentionIdx}`);
}
function pickMention(i) {
  const box = $('#mentionList'), m = box._hits?.[i], mq = box._q;
  if (!m || !mq) return;
  const inp = $('#chatInput');
  const end = inp.selectionStart ?? inp.value.length;
  inp.value = inp.value.slice(0, mq.start) + '@' + m.name + ' ' + inp.value.slice(end);
  const pos = mq.start + m.name.length + 2;
  inp.setSelectionRange(pos, pos); inp.focus();
  box.hidden = true; S.mentionIdx = 0;
}
function toggleChatEmoji(force) {
  const pop = $('#chatEmojiPop');
  const open = force ?? pop.hidden;
  if (open && !pop.childElementCount) pop.innerHTML = CHAT_EMOJIS.map((e) => `<button type="button" data-ins="${e}" aria-label="${e} ekle">${e}</button>`).join('');
  pop.hidden = !open;
  $('#chatEmojiBtn').setAttribute('aria-expanded', String(open));
}
function insertAtCaret(inp, text) {
  const a = inp.selectionStart ?? inp.value.length, b = inp.selectionEnd ?? a;
  inp.value = (inp.value.slice(0, a) + text + inp.value.slice(b)).slice(0, 1000);
  const p = Math.min(inp.value.length, a + text.length);
  inp.setSelectionRange(p, p);
}

function setReply(r) {
  S.replyTo = r;
  $('#replyBar').hidden = !r;
  if (r) { $('#replyText').textContent = `${r.name}: ${r.text}`; if (!isDesktop() && S.tab !== 'chat') switchTab('chat'); $('#chatInput').focus(); }
}
function renderTyping() {
  const names = [...S.typing.values()].map((t) => t.name);
  $('#typing').textContent = !names.length ? '' : names.length === 1 ? `${names[0]} yazıyor…` : `${names.slice(0, 2).join(', ')}${names.length > 2 ? ` ve ${names.length - 2} kişi` : ''} yazıyor…`;
}
function addSystem(text) {
  clearChatEmpty();
  const list = $('#chatList');
  const el = document.createElement('div');
  el.className = 'msg sys';
  el.innerHTML = linkify(text);
  list.appendChild(el);
  list.scrollTop = list.scrollHeight;
}
function addHistory(text) {
  const ul = $('#historyList');
  ul.querySelector('li.muted')?.remove();
  const li = document.createElement('li');
  li.innerHTML = `<time>${clockTime()}</time>${escapeHtml(text)}`;
  ul.prepend(li);
  while (ul.children.length > 30) ul.lastChild.remove();
}
function switchTab(tab) {
  S.tab = tab;
  $$('.tab').forEach((t) => { const on = t.dataset.tab === tab; t.classList.toggle('active', on); t.setAttribute('aria-selected', String(on)); t.tabIndex = on ? 0 : -1; });
  $('#tab-chat').hidden = tab !== 'chat';
  $('#tab-members').hidden = tab !== 'members';
  $('#tab-cams').hidden = tab !== 'cams';
  $('#tab-queue').hidden = tab !== 'queue';
  if (tab === 'chat') { S.unread = 0; $('#unread').hidden = true; $('#mUnread').hidden = true; updateTitle(); const l = $('#chatList'); l.scrollTop = l.scrollHeight; }
}

// ======================================================= Tepkiler & lazer

function spawnEmoji(e, who) {
  if (!/^\p{Extended_Pictographic}/u.test(e || '') || e.length > 8) return;
  if (!S.reactionsOn) return;
  const layer = $('#reactions');
  if (layer.childElementCount > 40) return;
  const el = document.createElement('div');
  el.className = 'float-emoji';
  el.textContent = e;
  if (who) { const n = document.createElement('small'); n.textContent = who; el.appendChild(n); }
  el.style.left = (8 + Math.random() * 80) + '%';
  layer.appendChild(el);
  setTimeout(() => el.remove(), 2700);
}
function drawLaser(from, d) {
  const layer = $('#laserLayer');
  let dot = S.laserDots.get(from);
  if (!dot) {
    dot = document.createElement('div');
    dot.className = 'laser-dot';
    const m = S.room?.members.get(from);
    dot.style.color = from === S.room?.selfId ? S.color : memberColor(m || { id: from });
    dot.innerHTML = '<span></span>';
    layer.appendChild(dot);
    S.laserDots.set(from, dot);
  }
  dot.querySelector('span').textContent = d.name || '';
  dot.style.left = (Math.min(1, Math.max(0, d.x)) * 100) + '%';
  dot.style.top = (Math.min(1, Math.max(0, d.y)) * 100) + '%';
  dot.style.opacity = d.on ? 1 : 0;
  clearTimeout(dot._t);
  dot._t = setTimeout(() => { dot.style.opacity = 0; }, 2500);
}
function toggleLaser() {
  S.laser = !S.laser;
  $('#laserLayer').classList.toggle('active', S.laser);
  $('#laserBtn').classList.toggle('on', S.laser);
  $('#laserBtn').setAttribute('aria-pressed', String(S.laser));
  toast(S.laser ? 'Lazer açık: sahnenin üzerinde imleci gezdir. (Açıkken sayfaya tıklanamaz.)' : 'Lazer kapandı.', 'info');
}
function bindLaser() {
  const layer = $('#laserLayer');
  $('#laserBtn').addEventListener('click', toggleLaser);
  const send = (e, on) => {
    if (!S.laser || !S.room) return;
    const now = Date.now();
    if (on && now - S.lastLaserSend < 90) return;
    S.lastLaserSend = now;
    const r = layer.getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    const y = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
    S.room.send('laser', { x, y, on, name: S.room.name });
    drawLaser(S.room.selfId, { x, y, on, name: 'Sen' });
  };
  layer.addEventListener('pointermove', (e) => send(e, true));
  layer.addEventListener('pointerleave', (e) => send(e, false));
}

// ======================================================= Tam ekran & sinema modu

function fsSupported(el) { return !!(document.fullscreenEnabled && el.requestFullscreen) || !!el.webkitRequestFullscreen; }
async function enterFullscreen() {
  const el = $('#player');
  if (S.fs) return;
  let real = false;
  if (fsSupported(el)) {
    try {
      if (el.requestFullscreen) await el.requestFullscreen({ navigationUI: 'hide' }); else el.webkitRequestFullscreen();
      real = true;
    } catch { real = false; }
  }
  if (!real) { S.pseudoFs = true; document.body.classList.add('pseudo-fs'); setFsState(true); }
  try { if (matchMedia('(pointer: coarse)').matches) await screen.orientation?.lock?.('landscape'); } catch {}
}
function exitFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else if (document.webkitFullscreenElement) document.webkitExitFullscreen?.();
  if (S.pseudoFs) { S.pseudoFs = false; document.body.classList.remove('pseudo-fs'); setFsState(false); }
  try { screen.orientation?.unlock?.(); } catch {}
}
function toggleFullscreen() { S.fs ? exitFullscreen() : enterFullscreen(); }
function setFsState(on) {
  S.fs = on;
  const p = $('#player');
  const t = $('#toasts');
  if (on && t.parentElement !== p) p.appendChild(t);
  if (!on && t.parentElement !== document.body) document.body.insertBefore(t, document.body.firstChild);
  closePops();
  S.overControls = false;
  p.classList.toggle('is-fs', on);
  p.classList.toggle('cams-hidden', S.camsHidden);
  for (const b of [$('#fsBtn'), $('#fsFloatBtn')]) { setIcon(b, on ? 'minimize' : 'maximize'); b.setAttribute('aria-label', on ? 'Tam ekrandan çık' : 'Tam ekran'); }
  if (on) { wakeControls(); requestAnimationFrame(() => S.pip.layout()); }
  else { clearTimeout(S.idleTimer); p.classList.remove('idle'); }
  if (!on && S.tab === 'chat') { S.unread = 0; $('#unread').hidden = true; $('#mUnread').hidden = true; updateTitle(); }
}
function onFsChange() {
  const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
  if (S.pseudoFs) return;
  setFsState(fsEl === $('#player'));
}
// Tam ekranda kontroller: hareketle görünür, duraklatılmışken / panel açıkken / üzerindeyken hep görünür.
function controlsMustStay() {
  const p = $('#player');
  if (!S.autoHide) return true;
  if (S.stage.controllable && !S.room?.media?.playing) return true;
  if (!$('#emojiPop').hidden || !$('#playerPop').hidden) return true;
  if (S.overControls) return true;
  const fe = document.activeElement;
  if (fe && p.contains(fe) && (fe.tagName === 'INPUT' || fe.type === 'range')) return true;
  return false;
}
function wakeControls() {
  const p = $('#player');
  p.classList.remove('idle');
  clearTimeout(S.idleTimer);
  if (!S.fs) return;
  const arm = () => {
    S.idleTimer = setTimeout(() => {
      if (!S.fs) return;
      if (controlsMustStay()) return arm();
      p.classList.add('idle');
    }, 3000);
  };
  arm();
}
function toggleCamsHidden() {
  S.camsHidden = !S.camsHidden;
  store.set('camsHidden', S.camsHidden ? '1' : '0');
  $('#player').classList.toggle('cams-hidden', S.camsHidden);
  const b = $('#fsCamsBtn');
  b.setAttribute('aria-pressed', String(!S.camsHidden));
  setIcon(b, S.camsHidden ? 'eyeOff' : 'cam');
  $('#fsCamsLabel').textContent = S.camsHidden ? 'Kameraları göster' : 'Kameraları gizle';
  if (!S.camsHidden) requestAnimationFrame(() => S.pip.layout());
  if (S.fs) toast(S.camsHidden ? 'Kameralar gizlendi (V ile geri getir).' : 'Kameralar gösteriliyor.', 'info', 1800);
}
function setMuteRemote(v) {
  S.muteRemote = v;
  $('#muteRemoteLabel').textContent = v ? 'Diğerlerinin sesini aç' : 'Diğerlerinin sesini kapat';
  $('#fsMuteLabel').textContent = v ? 'Sesler kapalı' : 'Sesler açık';
  $('#sheetMuteLabel').textContent = v ? 'Diğerlerinin sesini aç' : 'Diğerlerini sustur';
  setIcon($('#fsMuteBtn'), v ? 'volumeOff' : 'volume');
  $('#fsMuteBtn').setAttribute('aria-pressed', String(v));
  refreshRemoteMedia();
}
function toggleTheater() {
  const on = !$('#roomView').classList.contains('theater');
  $('#roomView').classList.toggle('theater', on);
  $('#theaterBtn').title = on ? 'Paneli göster (T)' : 'Paneli gizle (T)';
  requestAnimationFrame(() => S.pip && S.pip.layout());
  $('#theaterBtn').classList.toggle('on', on);
  $('#theaterBtn').setAttribute('aria-pressed', String(on));
}

// ======================================================= Menü & kısayollar

function setMenu(open) {
  $('#menu').hidden = !open;
  $('#menuBtn').setAttribute('aria-expanded', String(open));
  if (open) $('#menu button')?.focus();
}
function menuAction(act) {
  setMenu(false);
  if (act === 'invite') $('#inviteBtn').click();
  if (act === 'copy') copyText(S.room.code, 'Oda kodu kopyalandı');
  if (act === 'theater') toggleTheater();
  if (act === 'catalog') openCatalog();
  if (act === 'lock') toggleLock();
  if (act === 'syncAll') transport('resync');
  if (act === 'devices') openSettings(true);
  if (act === 'settings') openSettings();
  if (act === 'sound') { S.sound = !S.sound; store.set('sound', S.sound ? '1' : '0'); updateSoundLabel(); toast(S.sound ? 'Bildirim sesi açık.' : 'Bildirim sesi kapalı.', 'info', 1800); }
  if (act === 'muteRemote') setMuteRemote(!S.muteRemote);
  if (act === 'help') $('#helpDialog').showModal();
  if (act === 'queue') showQueue();
  if (act === 'countdown') startCountdown();
  if (act === 'theme') toggleTheme();
  if (act === 'leave') leaveRoom();
}
function updateSoundLabel() {
  const l = $('#soundLabel'); if (l) l.textContent = `Bildirim sesi: ${S.sound ? 'açık' : 'kapalı'}`;
  const b = $('[data-menu=sound]'); if (b) setIcon(b, S.sound ? 'bell' : 'bellOff');
}
function cyclePipSize() { const s = S.pip.cycleSize(); toast(`Kamera boyutu: ${{ s: 'küçük', m: 'orta', l: 'büyük' }[s]}`, 'info', 1500); }
function showQueue() {
  if (S.fs) exitFullscreen();
  if ($('#roomView').classList.contains('theater')) toggleTheater();
  switchTab('queue');
  setTimeout(() => { if (matchMedia('(pointer: fine)').matches) $('#queueInput').focus(); }, 50);
}
function onKey(e) {
  if (!S.room || $('#roomView').hidden) return;
  if (e.key === 'Escape') {
    if (!$('#menu').hidden) return setMenu(false);
    if (!$('#emojiPop').hidden || !$('#playerPop').hidden) return closePops();
    if (S.pseudoFs) return exitFullscreen();
  }
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
    if (e.key.toLowerCase() === 'd') { e.preventDefault(); return toggleMic(); }
    if (e.key.toLowerCase() === 'e') { e.preventDefault(); return toggleCam(); }
    return;
  }
  if (isTyping(e) || e.altKey || document.querySelector('dialog[open]')) return;
  if (S.fs) wakeControls();
  const QUICK = ['😂', '😍', '😮', '👏', '🔥', '😢'];
  if (/^[1-6]$/.test(e.key) && !e.target.closest?.('input')) { e.preventDefault(); return sendReaction(QUICK[Number(e.key) - 1]); }
  const k = e.key;
  const map = {
    ' ': () => transport('toggle'), k: () => transport('toggle'), K: () => transport('toggle'),
    ArrowLeft: () => transport('rew'), ArrowRight: () => transport('fwd'),
    f: toggleFullscreen, F: toggleFullscreen, v: toggleCamsHidden, V: toggleCamsHidden,
    b: cyclePipSize, B: cyclePipSize,
    t: toggleTheater, T: toggleTheater, m: () => $('#muteBtn').click(), M: () => $('#muteBtn').click(),
    l: toggleLaser, L: toggleLaser, '/': () => { if (S.fs) exitFullscreen(); $('#urlInput').focus(); }, '?': () => $('#helpDialog').showModal(),
    s: openCatalog, S: openCatalog,
    n: () => queueStep(1), N: () => queueStep(1), p: () => queueStep(-1), P: () => queueStep(-1),
    q: showQueue, Q: showQueue, g: startCountdown, G: startCountdown, i: openInvite, I: openInvite,
    e: () => togglePop($('#emojiPop'), [$('#emojiBtn'), $('#fsEmojiBtn'), $('#fsEmojiFloat')].find((b) => b.offsetParent !== null)),
    E: () => togglePop($('#emojiPop'), [$('#emojiBtn'), $('#fsEmojiBtn'), $('#fsEmojiFloat')].find((b) => b.offsetParent !== null)),
    Enter: () => { if (S.fs) return; if (!isDesktop()) switchTab('chat'); $('#chatInput').focus(); },
  };
  const fn = map[k];
  if (!fn) return;
  if ([' ', 'ArrowLeft', 'ArrowRight'].includes(k) && !S.stage.controllable) return;
  if (e.target.closest && e.target.closest('button, a, input[type=range]') && (k === ' ' || k === 'Enter')) return;
  e.preventDefault();
  fn();
  if (S.fs) wakeControls();
}


// ======================================================= Açılır paneller (tepki, hız/altyazı)

function closePops(except) {
  for (const id of ['#emojiPop', '#playerPop']) if ($(id) !== except) $(id).hidden = true;
  for (const b of ['#emojiBtn', '#fsEmojiBtn', '#fsEmojiFloat', '#playerSetBtn']) $(b)?.setAttribute('aria-expanded', 'false');
}
function togglePop(pop, anchor) {
  if (!pop.hidden) { closePops(); return; }
  closePops(pop);
  pop.hidden = false;
  anchor?.setAttribute('aria-expanded', 'true');
  placePop(pop, anchor);
  pop.querySelector('button, input')?.focus({ preventScroll: true });
  if (S.fs) wakeControls();
}
// Paneli tetikleyen düğmeye göre, oynatıcının sınırları içinde konumlar (taşma olmaz)
function placePop(pop, anchor) {
  const p = $('#player');
  const pr = p.getBoundingClientRect();
  const visible = anchor && anchor.offsetParent !== null;
  const ar = visible ? anchor.getBoundingClientRect() : { left: pr.right - 60, right: pr.right - 12, top: pr.bottom - 60, bottom: pr.bottom - 12 };
  pop.style.left = pop.style.right = pop.style.top = pop.style.bottom = '';
  const w = pop.offsetWidth, h = pop.offsetHeight;
  let left = Math.min(Math.max(8, ar.right - pr.left - w), pr.width - w - 8);
  const below = ar.top - pr.top < pr.height / 2; // düğme üst yarıdaysa (tam ekran üst çubuğu) aşağı aç
  let top = below ? ar.bottom - pr.top + 8 : ar.top - pr.top - h - 8;
  top = Math.min(Math.max(8, top), Math.max(8, pr.height - h - 8));
  pop.style.left = Math.max(8, left) + 'px';
  pop.style.top = top + 'px';
}
function sendReaction(e) {
  if (!S.room) return;
  spawnEmoji(e, 'Sen');
  S.room.send('emoji', { e });
  if (S.fs) wakeControls();
}
function setRate(r) {
  if (!S.room?.media || !S.stage.controllable) return toast('Hız yalnızca video, YouTube ve Vimeo kaynaklarında değiştirilebilir.', 'info');
  if (!canControl()) return deny();
  S.room.setMedia({ rate: r, time: S.stage.getTime() }, `oynatma hızını ${r}× yaptı`);
}
async function setSubsFromUrl(url) {
  if (!S.room?.media) return;
  if (S.stage.engine !== 'video') return toast('Altyazı yalnızca doğrudan video dosyalarında (MP4/WebM/HLS) çalışır.', 'info', 4000);
  if (!canControl()) return deny();
  if (url && !/^https?:\/\//i.test(url)) return toast('Geçerli bir altyazı linki gir (https://…).', 'warn');
  S.localSubs = false;
  S.room.setMedia({ subs: url ? { url } : null }, url ? 'altyazı ekledi' : 'altyazıyı kapattı');
}
async function setSubsFromFile(file) {
  if (!file) return;
  if (S.stage.engine !== 'video') return toast('Altyazı yalnızca doğrudan video dosyalarında çalışır.', 'info', 4000);
  if (file.size > 2 * 1024 * 1024) return toast('Altyazı dosyası çok büyük (en fazla 2 MB).', 'warn');
  const text = await file.text();
  await S.stage.setSubtitles({ text, label: file.name });
  S.localSubs = true;
  toast('Altyazı yüklendi (yalnızca sende görünür). Herkes için link ile ekleyebilirsin.', 'success', 4000);
}

// ======================================================= İzin verilen siteler (katalog)

function siteCard(s) {
  const badge = s.embed ? '<span class="bdg embed">Odada açılır</span>' : '<span class="bdg tab">Yeni sekmede</span>';
  return `<article class="site" data-site="${escapeHtml(s.id)}">
    <span class="logo" style="background:${escapeHtml(s.color)}" aria-hidden="true">${escapeHtml(s.mono)}</span>
    <span class="nm" title="${escapeHtml(s.name)}">${escapeHtml(s.name)}</span>
    <p class="nt">${escapeHtml(s.note)}</p>
    <div class="acts">${badge}
      <button class="btn btn-secondary btn-sm" type="button" data-open-site="${escapeHtml(s.id)}">${icon(s.embed ? 'play' : 'share')}${s.embed ? 'Odada aç' : 'Odaya kart gönder'}</button>
      <a class="link-btn" href="${escapeHtml(s.url)}" target="_blank" rel="noopener noreferrer">${icon('external')}Yeni sekme</a>
    </div></article>`;
}
function filmCard(f, i) {
  const queued = qItems().some((it) => it.url === f.url);
  return `<div class="film-wrap"><button class="film" type="button" data-film="${i}" title="${escapeHtml(f.title)} (${f.year}) — herkeste şimdi aç">
    <span class="play-ic">${icon('play')}</span><b>${escapeHtml(f.title)}</b>
    <span class="meta">${f.year} · ${f.min} dk · ${escapeHtml(f.genre)}</span>
    <span class="bdg lic">${escapeHtml(LICENSE_LABEL[f.lic] || '')}</span></button>
    <button class="film-q${queued ? ' on' : ''}" type="button" data-film-q="${i}" aria-label="${escapeHtml(f.title)} filmini sıraya ekle" title="${queued ? 'Sırada' : 'Sıraya ekle'}" ${queued ? 'aria-pressed="true"' : ''}>${icon(queued ? 'check' : 'listPlus')}</button></div>`;
}
function renderCatalog() {
  const q = $('#catSearch').value.trim().toLocaleLowerCase('tr');
  const f = S.catFilter;
  const match = (txt) => !q || txt.toLocaleLowerCase('tr').includes(q);
  $('#catFilters').innerHTML = [SITE_CATEGORIES[0], { id: 'films', label: 'Ücretsiz filmler' }, ...SITE_CATEGORIES.slice(1)].map((c) => `<button class="chip" type="button" data-cat="${c.id}" aria-pressed="${c.id === f}">${escapeHtml(c.label)}</button>`).join('');
  const films = FEATURED_FILMS.map((x, i) => [x, i]).filter(([x]) => (f === 'all' || f === 'films') && match(`${x.title} ${x.genre} ${x.year}`));
  const sites = ALLOWED_SITES.filter((x) => f !== 'films' && (f === 'all' || x.cat === f) && match(`${x.name} ${x.note}`));
  $('#filmGrid').innerHTML = films.length ? films.map(([x, i]) => filmCard(x, i)).join('') : '<p class="cat-empty">Eşleşen film yok.</p>';
  $('#filmGrid').parentElement.hidden = !(f === 'all' || f === 'films');
  $('#siteGrid').innerHTML = sites.length ? sites.map(siteCard).join('') : '<p class="cat-empty">Eşleşen site yok.</p>';
  $('#siteGrid').parentElement.hidden = f === 'films';
  const recent = store.json('recentLinks', []).slice(0, 6);
  $('#recentSec').hidden = !recent.length || !!q || f !== 'all';
  $('#recentGrid').innerHTML = recent.map((r) => `<button class="chip recent" type="button" data-recent-url="${escapeHtml(r.url)}" title="${escapeHtml(r.url)}">${icon('history')}<span>${escapeHtml(shortUrl(r.url))}</span><small>${escapeHtml(r.provider)}</small></button>`).join('');
}
function openCatalog() {
  if (!S.room) return;
  closePops();
  if (S.fs) exitFullscreen();
  renderCatalog();
  $('#catalogDialog').showModal();
  if (matchMedia('(pointer: fine)').matches) $('#catSearch').focus();
}
function onCatalogClick(e) {
  if (e.target.closest('[data-close]')) return $('#catalogDialog').close();
  const cat = e.target.closest('[data-cat]');
  if (cat) { S.catFilter = cat.dataset.cat; return renderCatalog(); }
  const fq = e.target.closest('[data-film-q]');
  if (fq) {
    const f = FEATURED_FILMS[fq.dataset.filmQ];
    const src = parseInput(f.url, env);
    src.provider = 'Film'; src.title = `${f.title} (${f.year})`;
    if (addToQueue(src, src.title, { quiet: true })) toast(`Sıraya eklendi: ${src.title}`, 'success', 2200);
    return renderCatalog();
  }
  const film = e.target.closest('[data-film]');
  if (film) {
    const f = FEATURED_FILMS[film.dataset.film];
    const src = parseInput(f.url, env);
    src.provider = 'Film'; src.title = `${f.title} (${f.year})`;
    $('#catalogDialog').close();
    return openSrc(src, `filmi açtı: ${f.title} (${f.year})`);
  }
  const site = e.target.closest('[data-open-site]');
  if (site) {
    const s = ALLOWED_SITES.find((x) => x.id === site.dataset.openSite);
    if (!s) return;
    $('#catalogDialog').close();
    if (s.embed) {
      const parsed = parseInput(s.url, env);
      // Koleksiyon sayfaları gömülü oynatıcıya değil sayfanın kendisine açılır
      const src = { ...parsed, kind: 'web', provider: s.name, url: s.url, embedUrl: s.url, syncable: false };
      return openSrc(src, `şu siteyi açtı: ${s.name}`);
    }
    const src = { ...parseInput(s.url, env), kind: 'blocked', provider: s.name, url: s.url, reason: `${s.name} başka sayfaların içinde gösterilmeye izin vermiyor. Yeni sekmede açıp filmi seçin; YouTube/Vimeo/Dailymotion linkini adres çubuğuna yapıştırırsanız odada oynar, diğerleri için “O sekmeyi odaya yansıt”ı kullanın.` };
    return openSrc(src, `şu siteyi önerdi: ${s.name}`);
  }
  const rec = e.target.closest('[data-recent-url]');
  if (rec) { $('#catalogDialog').close(); return openSource(rec.dataset.recentUrl); }
}

// ======================================================= Araç satırı & ayarlar

function setTools(open) {
  $('#toolRow').hidden = !open;
  $('#toolsBtn').setAttribute('aria-expanded', String(open));
  store.set('toolsOpen', open ? '1' : '0');
}
function openSettings(devices = false) {
  populateDevices();
  $('#setDuck').checked = S.duckOn;
  $('#setName').value = S.room?.name || store.get('name');
  $('#setSound').checked = S.sound;
  $('#setAutoHide').checked = S.autoHide;
  $('#setReactions').checked = S.reactionsOn;
  $('#setNotify').checked = S.chatToasts;
  renderSetColor();
  renderAppearance();
  $('#settingsDialog').showModal();
  if (devices) $('#devicesSec').scrollIntoView({ block: 'start' });
}
function renderSetColor() {
  $('#setColor').innerHTML = PALETTE.map((c, i) => `<button type="button" class="swatch" role="radio" aria-checked="${c === S.color}" aria-label="Renk ${i + 1}" style="--c:${c}" data-color="${c}"></button>`).join('');
}
function saveSettings() {
  S.sound = $('#setSound').checked; store.set('sound', S.sound ? '1' : '0'); updateSoundLabel();
  S.autoHide = $('#setAutoHide').checked; store.set('autoHide', S.autoHide ? '1' : '0');
  S.reactionsOn = $('#setReactions').checked; store.set('reactions', S.reactionsOn ? '1' : '0');
  S.chatToasts = $('#setNotify').checked; store.set('chatToasts', S.chatToasts ? '1' : '0');
  S.duckOn = $('#setDuck').checked; store.set('duck', S.duckOn ? '1' : '0'); if (!S.duckOn) S.stage.setDuck(1);
  const name = $('#setName').value.trim().slice(0, 24);
  if (S.room && name && name !== S.room.name) {
    S.room.rename(name); store.set('name', name); $('#nameInput').value = name;
    $('#selfName').textContent = name + ' (sen)';
    toast(`Adın “${name}” olarak güncellendi.`, 'success', 2500);
  }
  if (S.room) { S.room.color = S.color; S.room.updateSelf({}); }
  $('#selfAvatar').innerHTML = `<span style="background:${S.color}">${escapeHtml(initials(S.room?.name || name))}</span>`;
  refreshPip();
}

// ======================================================= Cihazlar (mikrofon, hoparlör/kulaklık, kamera)

const canPickOutput = () => typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype;
async function populateDevices() {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  let list = [];
  try { list = await navigator.mediaDevices.enumerateDevices(); } catch { return; }
  const fill = (sel, kind, cur, def) => {
    const el = $(sel); if (!el) return;
    const items = list.filter((d) => d.kind === kind && d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications');
    el.innerHTML = `<option value="">${def}</option>` + items.map((d, i) => `<option value="${escapeHtml(d.deviceId)}">${escapeHtml(d.label || `${kind === 'audioinput' ? 'Mikrofon' : kind === 'audiooutput' ? 'Çıkış' : 'Kamera'} ${i + 1}`)}</option>`).join('');
    el.value = items.some((d) => d.deviceId === cur) ? cur : '';
  };
  fill('#setMic', 'audioinput', S.dev.mic, 'Sistem varsayılanı');
  fill('#setCamSel', 'videoinput', S.dev.cam, 'Sistem varsayılanı');
  $('#setOutWrap').hidden = !canPickOutput();
  if (canPickOutput()) fill('#setOut', 'audiooutput', S.dev.out, 'Sistem varsayılanı (önerilen)');
  $('#devNote').textContent = canPickOutput()
    ? 'Kulaklık takınca ses otomatik olarak kulaklığa geçer. İstersen buradan belirli bir çıkış seçebilirsin.'
    : 'Bu tarayıcıda sesin nereden çıkacağını (hoparlör, kablolu veya Bluetooth kulaklık) işletim sistemi belirler; kulaklık takınca ses otomatik olarak oraya geçer.';
  // Seçili cihaz çıkarıldıysa varsayılana dön
  for (const [k, kind] of [['mic', 'audioinput'], ['out', 'audiooutput'], ['cam', 'videoinput']]) {
    if (S.dev[k] && list.length && list.some((d) => d.kind === kind && d.label) && !list.some((d) => d.deviceId === S.dev[k])) { S.dev[k] = ''; store.set('dev' + k[0].toUpperCase() + k.slice(1), ''); }
  }
}
async function setOutput(id) {
  S.dev.out = id; store.set('devOut', id);
  for (const a of $$('#remoteAudio audio')) if (a.setSinkId) await a.setSinkId(id || '').catch(() => {});
  await S.stage.setSink(id);
}
let devTimer = 0;
function onDeviceChange() {
  clearTimeout(devTimer);
  devTimer = setTimeout(async () => {
    await populateDevices();
    if (!S.room) return;
    // Kulaklık takıldı/çıkarıldı: sesleri yeniden bağla ki işletim sistemi yeni cihaza yönlendirsin,
    // mikrofonu (belirli bir cihaz seçilmediyse) yeniden al ki kulaklığın mikrofonu kullanılsın.
    resumeAudio(true);
    if (S.cam?.getAudioTracks()[0] && !S.dev.mic) await reacquireTrack('audio', 'device');
    toast('Ses cihazı değişti; ses yeni cihaza yönlendirildi.', 'info', 2500);
  }, 700);
}

// ======================================================= Senkron (kayma düzeltme)
// Yetkili (son işlemi yapan) her 3 sn'de gerçek konumunu yayınlar; diğerleri saat farkını hesaba katarak
// beklenen konumu bulur. Küçük kayma (0.12–1 sn) videoda hızı %1–8 değiştirerek fark ettirmeden kapatılır,
// büyük kayma atlama (seek) ile düzeltilir.
function driftCheck(fromTick = false) {
  const room = S.room, st = S.stage;
  if (!room?.media || room.media.screen || !st.controllable || document.hidden) return;
  const m = room.media;
  if (m.byId === room.selfId) { st.setNudge(1); return; }
  const want = room.positionNow();
  if (!m.playing) { st.setNudge(1); if (fromTick) st.apply({ time: want, playing: false }, 1); return; }
  if (!st.isPlaying()) { if (fromTick) st.apply({ time: want, playing: true, rate: m.rate || 1 }, 1); return; }
  const drift = st.getTime() - want; // + ileride, - geride
  const dur = st.getDuration();
  if (dur && want > dur) return;
  const hard = st.engine === 'video' ? 1.0 : 1.6;
  if (Math.abs(drift) > hard) { st.setNudge(1); st.apply({ time: want + (st.engine === 'video' ? 0.05 : 0.3), playing: true, rate: m.rate || 1 }, 0.3); S.lastDrift = drift; return; }
  if (st.engine === 'video') {
    if (Math.abs(drift) > 0.12) st.setNudge(1 - Math.max(-0.08, Math.min(0.08, drift * 0.25)));
    else if (Math.abs(drift) < 0.05) st.setNudge(1);
  }
  S.lastDrift = drift;
  const info = $('#syncInfo'); if (info) info.textContent = `· fark ${Math.round(Math.abs(drift) * 1000)} ms`;
}
function syncMe() {
  if (!S.room?.media) return;
  S.room.requestSync();
  S.stage.apply({ time: S.room.positionNow(), playing: !!S.room.media.playing, rate: S.room.media.rate || 1 }, 0.25);
  toast('Odaya eşitlendin.', 'success', 1500);
}

// ======================================================= Konuşma göstergesi + otomatik kısma
function speakLoop() {
  if (!S.mesh || !S.room) return;
  const lv = S.mesh.levels();
  let any = false;
  for (const [id, l] of lv) {
    const on = l > 0.04 && !S.mutedPeers.has(id) && !S.muteRemote;
    document.getElementById('tile-' + id)?.classList.toggle('speaking', on);
    $(`#pipLayer .pip[data-id="${CSS.escape(id)}"]`)?.classList.toggle('speaking', on);
    if (on) any = true;
  }
  if (any) S.lastSpeakAt = Date.now();
  const duck = S.duckOn && Date.now() - S.lastSpeakAt < 900;
  S.stage.setDuck(duck ? 0.35 : 1);
}

// ======================================================= Bağlantı durumu ve yeniden bağlanma
function updateConn() {
  const pill = $('#connPill'); if (!pill) return;
  if (!S.room) { pill.hidden = true; return; }
  const offline = !navigator.onLine;
  const noRelay = S.relays.open === 0;
  const peersDown = [...S.peerState.entries()].filter(([id, p]) => (p.state === 'failed' || p.state === 'disconnected') && S.room.members.has(id));
  const awayN = S.room.memberList().filter((m) => !m.self && m.away).length;
  let txt = '';
  if (offline) txt = 'Çevrimdışı · bağlantı bekleniyor';
  else if (noRelay) txt = 'Yeniden bağlanıyor…';
  else if (peersDown.length) txt = `Ses/görüntü yeniden bağlanıyor (${peersDown.length})`;
  pill.hidden = !txt;
  pill.classList.toggle('err', offline);
  $('#connText').textContent = txt;
  $('#mStatus').textContent = txt || (awayN ? `${awayN} kişi arka planda` : `${S.room.memberList().length} kişi · ${S.room.media?.src ? 'senkron' : 'hazır'}`);
}
function onVisible() {
  if (!S.room) return;
  S.room.setHidden(false);
  S.room.resume();
  S.mesh?.heal();
  resumeAudio();
  // iOS: arka planda biten mikrofon/kamera izini geri al
  const at = S.cam?.getAudioTracks()[0];
  if (at && at.readyState === 'ended') reacquireTrack('audio', 'ended');
  const vt = S.cam?.getVideoTracks()[0];
  if (vt && vt.readyState === 'ended') reacquireTrack('video', 'ended');
  // Oynatıcıyı odanın durumuna getir (arka planda tarayıcı durdurmuş olabilir)
  const m = S.room.media;
  if (m && !m.screen && S.stage.controllable) setTimeout(() => S.room && S.stage.apply({ time: S.room.positionNow(), playing: !!m.playing, rate: m.rate || 1 }, 0.8), 300);
  updateConn();
}
function onHidden() {
  S.hiddenAt = Date.now();
  S.room?.setHidden(true);
}

// ======================================================= Hata yakalama ve kendini onarma
function reportError(kind, err) {
  const msg = String(err?.message || err || '');
  // Başka sitelerin (YouTube, Vimeo) betik hataları ve kullanıcı iptalleri bize ait değildir
  if (!msg || msg === 'Script error.' || /AbortError|NotAllowedError|The play\(\) request was interrupted|ResizeObserver loop/i.test(msg) || err?.name === 'AbortError' || err?.name === 'NotAllowedError') return;
  S.errors.push({ kind, msg: msg.slice(0, 300), at: Date.now() });
  if (S.errors.length > 50) S.errors.shift();
  console.warn('[cinesync]', kind, err);
  // Kendini onar: bağlantıları tazele, oynatıcıyı odanın durumuna getir
  try { if (S.room) { S.room.resume(); S.mesh?.heal(); } } catch {}
  if (Date.now() - S.lastErrToast > 20000) { S.lastErrToast = Date.now(); toast('Küçük bir sorun oluştu, otomatik olarak düzeltildi. Devam edebilirsin.', 'info', 3500); }
}

// ======================================================= Mobil: alt çubuk ve "Daha fazla"
function openSheet() {
  closePops(); setMenu(false);
  $('#sheetScreen').hidden = !navigator.mediaDevices?.getDisplayMedia;
  $('#sheetUrl').value = '';
  $('#moreSheet').showModal();
}
function sheetAction(act) {
  const sheet = $('#moreSheet');
  if (act !== 'player') sheet.close();
  if (act === 'close') return;
  if (act === 'catalog') return openCatalog();
  if (act === 'invite') return $('#inviteBtn').click();
  if (act === 'members' || act === 'cams' || act === 'queue') return switchTab(act);
  if (act === 'countdown') return startCountdown();
  if (act === 'theme') return toggleTheme();
  if (act === 'player') { sheet.close(); if (!S.stage.controllable) return toast('Hız ve altyazı yalnızca video, YouTube ve Vimeo kaynaklarında kullanılabilir.', 'info'); return togglePop($('#playerPop'), $('#playBtn')); }
  if (act === 'pip') return togglePip();
  if (act === 'screen') return startScreenShare();
  if (act === 'help') return $('#helpDialog').showModal();
  return menuAction(act);
}
async function togglePip() {
  try { if (!(await S.stage.togglePip())) toast('Küçük pencere yalnızca video dosyalarında ve ekran yansıtmada çalışır (YouTube kendi düğmesini kullanır).', 'info', 4000); }
  catch { toast('Bu tarayıcı küçük pencereyi (resim içinde resim) desteklemiyor.', 'info'); }
}

// Barındırma rozeti (Netlify) sağ altta sabit durur; görünürse altına düğme gelmesin diye yer açılır.
function watchBadge() {
  const check = () => document.documentElement.classList.toggle('has-badge', !!document.getElementById('nl-badge-frame') || !!window.__testBadge);
  check();
  new MutationObserver(check).observe(document.body, { childList: true });
}

// Sekme arka planda kapatılıp (mobil bellek temizliği) geri açılınca odaya kendiliğinden dön
function autoRejoin() {
  let act = null;
  try { act = JSON.parse(sessionStorage.getItem('cinesync:active') || 'null'); } catch {}
  const code = readInviteCode();
  if (!act || !code || act.code !== code || Date.now() - act.ts > 6 * 3600e3 || !store.get('name')) return false;
  enterRoom(code, false, act.pw || '').then(async () => {
    toast('Odaya yeniden bağlandın.', 'success', 2500);
    if (store.get('micWanted') === '1' && !S.mic) { try { await toggleMic(); } catch {} }
  });
  return true;
}

// ======================================================= Bağlama

function bindRoomUI() {
  $('#addressBar').addEventListener('submit', (e) => { e.preventDefault(); openSource($('#urlInput').value); $('#urlInput').blur(); });
  $('#urlInput').addEventListener('input', () => { $('#clearUrl').hidden = !$('#urlInput').value; });
  $('#urlInput').addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); const v = $('#urlInput').value.trim(); if (v && addToQueue(v)) { $('#urlInput').value = ''; $('#clearUrl').hidden = true; } } });
  $('#urlInput').addEventListener('focus', () => $('#urlInput').select());
  $('#clearUrl').addEventListener('click', () => { $('#urlInput').value = ''; $('#clearUrl').hidden = true; $('#urlInput').focus(); });
  $('#backBtn').addEventListener('click', () => {
    const prev = S.history.pop();
    if (prev) { const len = S.history.length; openSource(prev, 'önceki kaynağa döndü'); S.history.length = len; }
    $('#backBtn').disabled = !S.history.length;
  });
  $('#reloadBtn').addEventListener('click', () => { if (S.room?.media) { S.stage.key = ''; applyMedia({ ...S.room.media, label: '' }); } });
  $('#quickBar').addEventListener('click', (e) => {
    const b = e.target.closest('[data-recent]'); if (!b) return;
    const url = $('#quickBar')._recent[b.dataset.recent].url;
    $('#urlInput').value = url; openSource(url);
  });
  $('#stageEmpty').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-empty]'); if (!b) return;
    if (b.dataset.empty === 'invite') return $('#inviteBtn').click();
    if (b.dataset.empty === 'catalog') return openCatalog();
    try {
      const t = (await navigator.clipboard.readText()).trim();
      if (!t) return toast('Panoda link yok.', 'warn');
      $('#urlInput').value = t; openSource(t);
    } catch { $('#urlInput').focus(); toast('Linki adres çubuğuna yapıştır (Ctrl+V / uzun bas).', 'info'); }
  });

  $('#codePill').addEventListener('click', () => copyText(S.room.code, 'Oda kodu kopyalandı'));
  $('#inviteBtn').addEventListener('click', openInvite);
  for (const id of ['#micBtn', '#camsMicBtn']) $(id).addEventListener('click', toggleMic);
  for (const id of ['#camBtn', '#camsCamBtn']) $(id).addEventListener('click', toggleCam);
  $('#leaveBtn').addEventListener('click', leaveRoom);
  $('#theaterBtn').addEventListener('click', toggleTheater);
  $('#menuBtn').addEventListener('click', (e) => { e.stopPropagation(); if (isMobileUI()) return openSheet(); setMenu($('#menu').hidden); });
  $('#menu').addEventListener('click', (e) => { const b = e.target.closest('[data-menu]'); if (b) menuAction(b.dataset.menu); });
  $('#menu').addEventListener('keydown', (e) => {
    const items = $$('#menu button'); const i = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
    if (e.key === 'Escape') { setMenu(false); $('#menuBtn').focus(); }
  });
  document.addEventListener('click', (e) => { if (!$('#menu').hidden && !e.target.closest('.menu-wrap')) setMenu(false); });
  $('#screenBtn').addEventListener('click', startScreenShare);
  $('#frameHint [data-act=share-screen]').addEventListener('click', startScreenShare);

  $('#playBtn').addEventListener('click', () => transport('toggle'));
  $('#rewBtn').addEventListener('click', () => transport('rew'));
  $('#fwdBtn').addEventListener('click', () => transport('fwd'));
  $('#resyncBtn').addEventListener('click', () => transport('resync'));
  $('#seekBar').addEventListener('change', (e) => {
    const dur = S.stage.getDuration();
    if (!dur || !S.room?.media) return;
    const t = (e.target.value / 1000) * dur;
    S.room.setMedia({ time: t }, `${formatTime(t)} konumuna atladı`);
  });
  let muted = false;
  const vol = () => S.stage.setVolume($('#volBar').value / 100, muted);
  const muteIcons = () => { for (const id of ['#muteBtn', '#muteBtn2']) { setIcon($(id), muted ? 'volumeOff' : 'volume'); $(id).setAttribute('aria-pressed', String(muted)); } };
  $('#volBar').addEventListener('input', () => { muted = false; $('#volBar2').value = $('#volBar').value; muteIcons(); vol(); });
  $('#muteBtn').addEventListener('click', () => { muted = !muted; muteIcons(); vol(); });

  $('#fsBtn').addEventListener('click', toggleFullscreen);
  $('#fsFloatBtn').addEventListener('click', toggleFullscreen);
  $('#fsExitBtn').addEventListener('click', exitFullscreen);
  $('#fsCamsBtn').addEventListener('click', toggleCamsHidden);
  $('#fsSizeBtn').addEventListener('click', () => S.pip.cycleSize());
  $('#fsMuteBtn').addEventListener('click', () => setMuteRemote(!S.muteRemote));
  document.addEventListener('fullscreenchange', onFsChange);
  document.addEventListener('webkitfullscreenchange', onFsChange);
  const player = $('#player');
  for (const ev of ['pointermove', 'pointerdown', 'touchstart']) player.addEventListener(ev, (e) => {
    S.overControls = ev === 'pointermove' && e.pointerType === 'mouse' && !!e.target.closest?.('#transport, .fs-bar, .pop');
    if (S.fs) wakeControls();
  }, { passive: true });
  $('#stage').addEventListener('dblclick', (e) => { if (!S.laser && S.stage.engine === 'video') { e.preventDefault(); toggleFullscreen(); } });

  $('#unlockOverlay').addEventListener('click', () => S.stage.unlockAudio());
  // Tepkiler, hız, altyazı
  $('#emojiPop').addEventListener('click', (e) => { const b = e.target.closest('[data-emoji]'); if (b) sendReaction(b.dataset.emoji); });
  for (const id of ['#emojiBtn', '#fsEmojiBtn', '#fsEmojiFloat']) $(id).addEventListener('click', (e) => { e.stopPropagation(); togglePop($('#emojiPop'), e.currentTarget); });
  $('#playerSetBtn').addEventListener('click', (e) => { e.stopPropagation(); updateSubsTune(); togglePop($('#playerPop'), e.currentTarget); });
  document.addEventListener('pointerdown', (e) => { if (!e.target.closest('.pop, #emojiBtn, #fsEmojiBtn, #fsEmojiFloat, #playerSetBtn')) closePops(); });
  $('#rateSeg').addEventListener('click', (e) => { const b = e.target.closest('[data-rate]'); if (b) setRate(Number(b.dataset.rate)); });
  $('#subsForm').addEventListener('submit', (e) => { e.preventDefault(); setSubsFromUrl($('#subsUrl').value.trim()); });
  $('#subsFile').addEventListener('change', (e) => { setSubsFromFile(e.target.files[0]).catch(() => toast('Altyazı dosyası okunamadı.', 'error')); e.target.value = ''; });
  $('#subsOff').addEventListener('click', async () => { if (S.localSubs) { S.localSubs = false; await S.stage.setSubtitles({}); S.subsKey = ''; toast('Altyazı kapatıldı.', 'info', 1500); } else setSubsFromUrl(''); });
  // Katalog, araçlar, ayarlar
  $('#catalogBtn').addEventListener('click', openCatalog);
  $('#catalogDialog').addEventListener('click', (e) => { if (e.target === $('#catalogDialog')) return $('#catalogDialog').close(); onCatalogClick(e); });
  $('#catSearch').addEventListener('input', renderCatalog);
  $('#toolsBtn').addEventListener('click', () => setTools($('#toolRow').hidden));
  $('#settingsDialog').addEventListener('close', saveSettings);
  $('#setColor').addEventListener('click', (e) => { const b = e.target.closest('[data-color]'); if (!b) return; S.color = b.dataset.color; store.set('color', S.color); renderSetColor(); renderColorPicker(); });
  $('#frameHint [data-act=dismiss]').addEventListener('click', () => { $('#frameHint').hidden = true; });
  $('#camsToggle').addEventListener('click', () => { const g = $('#videoGrid'); g.hidden = !g.hidden; $('#camsToggle').setAttribute('aria-expanded', String(!g.hidden)); });
  // Sohbet: yanıt, yazıyor
  $('#replyCancel').addEventListener('click', () => setReply(null));
  $('#chatList').addEventListener('click', (e) => {
    const q = e.target.closest('[data-goto]'); if (!q) return;
    e.preventDefault();
    const t = $(`#chatList .msg[data-id="${CSS.escape(q.dataset.goto)}"]`);
    if (t) { t.scrollIntoView({ block: 'center' }); t.classList.add('flash'); setTimeout(() => t.classList.remove('flash'), 1200); }
  });
  $('#chatInput').addEventListener('input', () => {
    if (!S.room || !$('#chatInput').value) return;
    if (Date.now() - S.lastTypingSent > 3000) { S.lastTypingSent = Date.now(); S.room.send('typing', { on: true }); }
  });
  // Tam ekran: kontroller iframe'lerin üstünde bile yeniden görünür
  const wake = $('#fsWake');
  for (const ev of ['pointermove', 'pointerdown']) wake.addEventListener(ev, (e) => {
    if (ev === 'pointerdown') { e.preventDefault(); S.swallowClickUntil = Date.now() + 700; }
    wakeControls();
  });
  // Uyandırmak için yapılan dokunuş, altındaki videoyu oynat/duraklat yapmasın
  $('#player').addEventListener('click', (e) => {
    if (Date.now() < (S.swallowClickUntil || 0) && !e.target.closest('#transport, .fs-bar, .pop, .pip')) { e.stopPropagation(); e.preventDefault(); S.swallowClickUntil = 0; }
  }, true);
  for (const sel of ['#transport', '.fs-bar']) {
    $(sel).addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse') S.overControls = true; wakeControls(); });
    $(sel).addEventListener('pointerleave', () => { S.overControls = false; });
    $(sel).addEventListener('focusin', () => wakeControls());
  }
  $('#volBar2').addEventListener('input', () => { $('#volBar').value = $('#volBar2').value; $('#volBar').dispatchEvent(new Event('input')); });
  $('#muteBtn2').addEventListener('click', () => $('#muteBtn').click());

  $$('.tab').forEach((t) => t.addEventListener('click', () => switchTab(t.dataset.tab)));
  $('.tabs').addEventListener('keydown', (e) => {
    if (!['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
    const tabs = $$('.tab').filter((t) => t.offsetParent !== null);
    const i = tabs.indexOf(document.activeElement);
    const n = tabs[(i + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
    n.focus(); switchTab(n.dataset.tab);
  });
  matchMedia('(min-width: 1024px)').addEventListener('change', (e) => { if (e.matches && S.tab === 'cams') switchTab('chat'); else switchTab(S.tab); requestAnimationFrame(() => S.pip.layout()); });
  $('#chatForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = $('#chatInput').value.trim();
    if (!text || !S.room) return;
    S.room.sendChat(text, S.replyTo);
    $('#chatInput').value = '';
    $('#mentionList').hidden = true; toggleChatEmoji(false);
    setReply(null);
    S.lastTypingSent = 0;
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && S.tab === 'chat' && !S.fs) { S.unread = 0; $('#unread').hidden = true; $('#mUnread').hidden = true; updateTitle(); } });
  document.addEventListener('keydown', onKey);
  // Mobil alt çubuk ve "Daha fazla" sayfası
  $('#mMic').addEventListener('click', toggleMic);
  $('#mCam').addEventListener('click', toggleCam);
  $('#mChat').addEventListener('click', () => { switchTab('chat'); $('#chatList').scrollTop = $('#chatList').scrollHeight; });
  $('#mEmoji').addEventListener('click', (e) => { e.stopPropagation(); togglePop($('#emojiPop'), e.currentTarget); });
  $('#mMore').addEventListener('click', openSheet);
  $('#moreSheet').addEventListener('click', (e) => {
    if (e.target === $('#moreSheet')) return $('#moreSheet').close();
    const b = e.target.closest('[data-sheet]'); if (b) sheetAction(b.dataset.sheet);
  });
  $('#sheetLink').addEventListener('submit', (e) => { e.preventDefault(); const v = $('#sheetUrl').value.trim(); if (!v) return; $('#moreSheet').close(); openSource(v); });
  // Senkron ve PiP
  $('#syncMeBtn').addEventListener('click', () => { closePops(); syncMe(); });
  $('#syncAllBtn').addEventListener('click', () => { closePops(); transport('resync'); });
  $('#pipBtn').addEventListener('click', () => { closePops(); togglePip(); });
  // Cihaz seçimi
  $('#setMic').addEventListener('change', async (e) => { S.dev.mic = e.target.value; store.set('devMic', S.dev.mic); if (S.cam?.getAudioTracks()[0]) await reacquireTrack('audio', 'pick'); });
  $('#setCamSel').addEventListener('change', async (e) => { S.dev.cam = e.target.value; store.set('devCam', S.dev.cam); if (S.cam?.getVideoTracks()[0]) await reacquireTrack('video', 'pick'); });
  $('#setOut').addEventListener('change', (e) => setOutput(e.target.value));
  navigator.mediaDevices?.addEventListener?.('devicechange', onDeviceChange);
  // Ses engellendiyse (otomatik oynatma kuralı) ilk dokunuşta aç
  $('#audioUnlock').addEventListener('click', () => resumeAudio(true));
  document.addEventListener('pointerdown', () => { if (S.audioBlocked) resumeAudio(); }, { capture: true, passive: true });
  // Öne gelme / arka plana gitme / ağ
  document.addEventListener('visibilitychange', () => (document.hidden ? onHidden() : onVisible()));
  window.addEventListener('pageshow', (e) => { if (e.persisted) onVisible(); });
  window.addEventListener('focus', () => { if (S.room && Date.now() - S.hiddenAt > 2000) resumeAudio(); });
  window.addEventListener('online', () => { if (!S.room) return; setNet(S.relays.open, S.relays.total); toast('İnternet bağlantısı geri geldi, yeniden bağlanılıyor…', 'success'); S.room.resume(); setTimeout(() => S.mesh?.heal(), 1500); updateConn(); });
  window.addEventListener('offline', () => { if (!S.room) return; setNet(0, S.relays.total); toast('İnternet bağlantısı koptu. Geri gelince kendiliğinden bağlanılacak.', 'warn', 5000); updateConn(); });
  // ---- v2.4: ortak sıra
  $('#queueForm').addEventListener('submit', (e) => { e.preventDefault(); const v = $('#queueInput').value.trim(); if (!v) return $('#queueInput').focus(); if (addToQueue(v)) $('#queueInput').value = ''; });
  $('#queueAddBtn').addEventListener('click', () => {
    const v = $('#urlInput').value.trim() || S.room?.media?.src?.url || '';
    if (!v) { showQueue(); return toast('Adres çubuğuna bir link yaz ya da “Sıra” sekmesinden ekle.', 'info', 3000); }
    addToQueue(v, v === S.room?.media?.src?.url ? S.room.media.src.title : undefined);
  });
  $('#queueList').addEventListener('click', (e) => {
    const pl = e.target.closest('[data-qplay]'); if (pl) return playQueueItem(pl.dataset.qplay);
    const mv = e.target.closest('[data-qmove]'); if (mv) return moveInQueue(mv.dataset.qidBtn, Number(mv.dataset.qmove));
    const del = e.target.closest('[data-qdel]'); if (del) return removeFromQueue(del.dataset.qdel);
  });
  $('#queueList').addEventListener('keydown', (e) => {
    const li = e.target.closest('li[data-qid]'); if (!li || !e.altKey) return;
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); moveInQueue(li.dataset.qid, e.key === 'ArrowUp' ? -1 : 1); }
  });
  $('#queueAuto').addEventListener('change', (e) => { if (!S.room) return; if (!canControl()) { e.target.checked = !e.target.checked; return deny(); } S.room.setQueue({ auto: e.target.checked }); });
  $('#queueClear').addEventListener('click', () => {
    if (!S.room || !qItems().length) return;
    if (!canControl()) return deny();
    const before = S.room.queue;
    S.room.setQueue({ items: [], cur: null });
    toast('Sıra temizlendi.', 'info', 4000, { action: { label: 'Geri al', fn: () => S.room?.setQueue({ items: before.items, cur: before.cur }) } });
  });
  $('#queueEmpty [data-empty=catalog]').addEventListener('click', openCatalog);
  $('#nextBtn').addEventListener('click', () => queueStep(1));
  $('#prevBtn').addEventListener('click', () => queueStep(-1));
  // ---- v2.4: geri sayım
  $('#countdownBtn').addEventListener('click', startCountdown);
  $('#cdCancel').addEventListener('click', () => { if (!S.countdown) return; S.room?.send('countdown', { id: S.countdown.id, cancel: true }); cancelCountdown(true); });
  // ---- v2.4: davet penceresi
  $('#inviteDialog').addEventListener('click', (e) => { if (e.target === $('#inviteDialog') || e.target.closest('[data-close]')) $('#inviteDialog').close(); });
  $('#invCopy').addEventListener('click', () => copyText($('#invLink').value, 'Davet linki kopyalandı'));
  $('#invCode').addEventListener('click', () => copyText(S.room?.code || '', 'Oda kodu kopyalandı'));
  $('#invLink').addEventListener('focus', (e) => e.target.select());
  $('#invShare').addEventListener('click', async () => {
    try { await navigator.share({ title: 'CineSync odası', text: `Birlikte izleyelim! Oda kodu: ${S.room.code}`, url: $('#invLink').value }); }
    catch (e) { if (e?.name !== 'AbortError') copyText($('#invLink').value, 'Davet linki kopyalandı'); }
  });
  // ---- v2.4: kişiler (ses düzeyi, kontrolü devret)
  $('#memberList').addEventListener('input', (e) => {
    const r = e.target.closest('[data-vol-id]'); if (!r) return;
    setPeerVolume(r.dataset.volId, r.value / 100);
    const out = r.parentElement.querySelector('output'); if (out) out.textContent = `${r.value}%`;
  });
  $('#memberList').addEventListener('change', () => S.room && setTimeout(() => renderMembers(S.room.memberList()), 0));
  $('#memberList').addEventListener('click', (e) => { const b = e.target.closest('[data-handover]'); if (b) handOver(b.dataset.handover); });
  // ---- v2.4: sohbet tepkileri, @bahsetme, emoji
  $('#chatList').addEventListener('click', (e) => {
    const open = e.target.closest('[data-react-open]');
    if (open) { const m = open.closest('.msg'); if (m.querySelector('.react-pick')) closeReactPicker(); else openReactPicker(m); return; }
    const pk = e.target.closest('[data-pick]');
    if (pk) { toggleReact(pk.closest('.msg').dataset.id, pk.dataset.pick); closeReactPicker(); return; }
    const chip = e.target.closest('[data-react]');
    if (chip) toggleReact(chip.closest('.msg').dataset.id, chip.dataset.react);
  });
  $('#chatList').addEventListener('keydown', (e) => { if (e.key === 'Escape' && $('#chatList .react-pick')) { e.stopPropagation(); const m = e.target.closest('.msg'); closeReactPicker(); m?.querySelector('[data-react-open]')?.focus(); } });
  document.addEventListener('pointerdown', (e) => {
    if (!e.target.closest('.react-pick, [data-react-open]')) closeReactPicker();
    if (!e.target.closest('#chatEmojiPop, #chatEmojiBtn')) toggleChatEmoji(false);
    if (!e.target.closest('#mentionList, #chatInput')) $('#mentionList').hidden = true;
  });
  $('#chatInput').addEventListener('input', () => { S.mentionIdx = 0; updateMentions(); });
  $('#chatInput').addEventListener('click', updateMentions);
  $('#chatInput').addEventListener('keydown', (e) => {
    const box = $('#mentionList');
    if (box.hidden || !box._hits?.length) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); S.mentionIdx = (S.mentionIdx + (e.key === 'ArrowDown' ? 1 : -1) + box._hits.length) % box._hits.length; updateMentions(); }
    else if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); pickMention(S.mentionIdx); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); box.hidden = true; }
  });
  $('#mentionList').addEventListener('click', (e) => { const b = e.target.closest('[data-mention]'); if (b) pickMention(Number(b.dataset.mention)); });
  $('#chatEmojiBtn').addEventListener('click', () => toggleChatEmoji());
  $('#chatEmojiPop').addEventListener('click', (e) => { const b = e.target.closest('[data-ins]'); if (!b) return; const inp = $('#chatInput'); insertAtCaret(inp, b.dataset.ins); inp.focus(); });
  // ---- v2.4: altyazı ayarı
  $('#subsTune').addEventListener('click', (e) => {
    const sh = e.target.closest('[data-subs-shift]'); if (sh) return shiftSubs(Number(sh.dataset.subsShift));
    const sz = e.target.closest('[data-subs-size]'); if (sz) return setSubsSize(sz.dataset.subsSize);
  });
  setSubsSize(S.subsSize);
  // ---- v2.4: görünüm
  $('#themeSeg').addEventListener('click', (e) => { const b = e.target.closest('[data-theme-opt]'); if (b) { setThemePref(b.dataset.themeOpt); renderAppearance(); } });
  $('#accentPicker').addEventListener('click', (e) => { const b = e.target.closest('[data-accent]'); if (b) { setAccentPref(b.dataset.accent); renderAppearance(); } });
  onThemeChange((t) => updateThemeLabels(t));
  bindLaser();
  updateSoundLabel();
  toggleCamsHidden(); toggleCamsHidden(); // etiketleri kayıtlı tercihe göre ayarla
}

function pipInsets() {
  const p = $('#player');
  const cs = getComputedStyle(document.documentElement);
  const safe = (v) => parseFloat(cs.getPropertyValue(v)) || 0;
  const tr = $('#transport');
  const small = p.clientWidth < 600;
  const m = small ? 8 : 14;
  const bar = $('.fs-bar');
  return {
    top: (bar && bar.offsetHeight ? bar.offsetHeight - 14 : 56) + 4,
    bottom: (!tr.hidden ? tr.offsetHeight + 20 : 0) + m + safe('--safe-b'),
    left: m + safe('--safe-l'), right: m + safe('--safe-r'),
  };
}

// Uygulama kabuğu yüksekliği: mobil tarayıcı adres çubuğu açılıp kapanınca ve klavye açılınca görünen alana uyar
function fitViewport() {
  const vv = window.visualViewport;
  const h = Math.round(vv ? vv.height : window.innerHeight);
  document.documentElement.style.setProperty('--app-h', h + 'px');
  if (S.room && vv && vv.offsetTop && !S.fs) window.scrollTo(0, 0);
  requestAnimationFrame(() => S.pip && S.pip.layout());
}

function boot() {
  applyTheme();
  hydrateIcons();
  updateThemeLabels();
  fitViewport();
  let fitRaf = 0;
  const fit = () => { cancelAnimationFrame(fitRaf); fitRaf = requestAnimationFrame(fitViewport); };
  window.addEventListener('resize', fit);
  window.addEventListener('orientationchange', () => setTimeout(fitViewport, 250));
  window.visualViewport?.addEventListener('resize', fit);
  S.stage = new Stage($('.stage-col'), {
    onUserAction: onUserPlayerAction,
    onEngine: (engine) => {
      const c = ['video', 'youtube', 'vimeo'].includes(engine);
      $('#transport').hidden = !c;
      $('#player').classList.toggle('has-transport', c);
      requestAnimationFrame(() => S.pip && S.pip.layout());
    },
    onBuffer: () => { S.room?.requestSync(); setTimeout(() => driftCheck(true), 400); },
    onEnded: () => onMediaEnded(),
    onBlockedAction: (act, src) => {
      if (act === 'share-screen') { window.open(src.url, '_blank', 'noopener'); setTimeout(startScreenShare, 400); }
      if (act === 'copy') copyText(src.url, 'Link kopyalandı');
    },
  });
  S.pip = new PipLayer($('#pipLayer'), { getInsets: pipInsets, store });
  initLobby();
  bindRoomUI();
  afterLocalMediaChange();
  setInterval(() => { try { updateTransportUI(); } catch (e) { reportError('ui', e); } }, 500);
  setInterval(() => { try { S.room && S.room.sendTick(S.stage.controllable && S.stage.isPlaying() ? S.stage.getTime() : undefined); } catch (e) { reportError('tick', e); } }, 3000);
  setInterval(() => { try { driftCheck(); } catch (e) { reportError('drift', e); } }, 1000);
  setInterval(() => { try { speakLoop(); } catch {} }, 300);
  // Sağlık kontrolü: hiçbir röleye bağlı değilsek beklemeden yeniden dene; kopuk görüşmeleri onar
  setInterval(() => { if (!S.room || document.hidden) return; if (S.relays.open === 0) S.room.channel?.reconnect(); S.mesh?.heal(); updateConn(); }, 10000);
  window.addEventListener('error', (e) => { if (e.error || e.message) reportError('error', e.error || e.message); });
  window.addEventListener('unhandledrejection', (e) => { reportError('promise', e.reason); });
  watchBadge();
  populateDevices();
  if ('serviceWorker' in navigator && !window.__CINESYNC_SINGLE__ && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    // Yeni sürüm yayınlanınca eski servis çalışanı eski dosyaları sunmaya devam edemez:
    // sw.js HTTP önbelleğine alınmaz, her açılışta güncellik kontrol edilir; yeni sürüm devraldığında
    // kullanıcı odada değilse sayfa bir kez yenilenir.
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then((r) => r.update()).catch(() => {});
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController || S.room || sessionStorage.getItem('cinesync:swReloaded')) return;
      sessionStorage.setItem('cinesync:swReloaded', '1');
      location.reload();
    });
  }
  window.CineSync = { S, parseInput, enterFullscreen, exitFullscreen, toggleCamsHidden, openSource, onDeviceChange, driftCheck, leaveRoom, enterRoom, addToQueue, queueStep, startCountdown, onMediaEnded, version: APP_VERSION }; // hata ayıklama ve testler için
  autoRejoin();
}

boot();
