// Uzun dayanıklılık testi (varsayılan 11 dk): iki tarayıcı sesli+görüntülü odada; kaynak değiştirme,
// üçüncü kişinin girip çıkması, arka plana alma/dondurma, ağ kopması (setOffline), cihaz değişikliği.
// Her adımdan sonra: üyelik, WebRTC bağlantısı, karşı tarafın sesinin akması (inbound-rtp bayt artışı,
// <audio> çalıyor) ve video kayması ölçülür; tüm konsol/sayfa hataları toplanır.
import { chromium, firefox } from '../node_modules/playwright-core/index.mjs';
import { clickMic, clickCam } from './ui-helpers.mjs';
const BASE = process.argv[2] || 'http://localhost:8080/';
const MINUTES = +(process.argv[3] || 11);
// Not: bu kutudaki Chrome hiç ICE adayı üretmiyor (ortam kısıtı; iki yerel RTCPeerConnection bile bağlanamıyor),
// bu yüzden WebRTC ses ölçümü Firefox'ta yapılır. Chromium'da yalnızca dondurma (CDP) ve senkron adımları anlamlıdır.
const ENGINE = process.argv[4] || 'firefox';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b = ENGINE === 'chromium'
  ? await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] })
  : await firefox.launch({ firefoxUserPrefs: { 'media.navigator.streams.fake': true, 'media.navigator.permission.disabled': true, 'media.autoplay.default': 0, 'media.autoplay.blocking_policy': 0, 'media.devices.insecure.enabled': true } });
const errors = []; const log = [];
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { cond ? pass++ : fail++; const l = `${cond ? '✓' : '✗'} ${name}${extra ? ' — ' + extra : ''}`; log.push(l); console.log(l); };
const waitFor = async (fn, ms = 20000) => { const t = Date.now(); while (Date.now() - t < ms) { try { const v = await fn(); if (v) return v; } catch {} await sleep(400); } return null; };
const IGNORE = /favicon|was interrupted while the page was loading|establish a connection|net::ERR|Failed to load resource|WebSocket|ERR_INTERNET_DISCONNECTED|youtube|vimeo|doubleclick|googleads|play\.google|\[Report Only\]|Permissions policy|www-widgetapi|ERR_NAME_NOT_RESOLVED|CORS/i;
async function mk(name) {
  const ctx = await b.newContext({ viewport: { width: 1280, height: 800 }, ...(ENGINE === 'chromium' ? { permissions: ['microphone', 'camera'] } : {}) });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(`${name} pageerror: ${e.message}`));
  p.on('console', (m) => { if (m.type() === 'error' && !IGNORE.test(m.text())) errors.push(`${name} console: ${m.text().slice(0, 200)}`); });
  await p.goto(BASE); await p.waitForSelector('#createBtn'); await p.fill('#nameInput', name);
  return { p, ctx, cdp: ENGINE === 'chromium' ? await ctx.newCDPSession(p) : null };
}
const st = (p) => p.evaluate(async () => {
  const S = window.CineSync.S, out = { members: S.room?.memberList().length || 0, peers: [], appErrors: (S.errors || []).length };
  for (const [id, peer] of S.mesh?.peers || []) {
    let bytes = 0;
    try { const rep = await Promise.race([peer.pc.getStats(), new Promise((r) => setTimeout(() => r(null), 2500))]); rep && rep.forEach((r) => { if (r.type === 'inbound-rtp' && r.kind === 'audio') bytes += r.bytesReceived || 0; }); } catch {}
    out.peers.push({ id, state: peer.pc.connectionState, bytes });
  }
  out.audio = [...document.querySelectorAll('#remoteAudio audio')].map((a) => ({ paused: a.paused, live: !!a.srcObject && a.srcObject.getAudioTracks().some((t) => t.readyState === 'live') }));
  const v = document.querySelector('#stageVideo');
  out.video = v && !v.hidden ? { t: v.currentTime, paused: v.paused } : null;
  out.mic = S.cam?.getAudioTracks?.()[0]?.readyState || null;
  return out;
});
async function audioFlows(X, Y, label) {
  // Y'nin sesi X'e akıyor mu: 3 sn içinde bayt artışı + <audio> çalıyor
  const s1 = await st(X.p); await sleep(3000); const s2 = await st(X.p);
  const yId = await Y.p.evaluate(() => window.CineSync.S.room.selfId);
  const a = s1.peers.find((q) => q.id === yId), c = s2.peers.find((q) => q.id === yId);
  const flowing = a && c && c.state === 'connected' && c.bytes > a.bytes;
  const playing = s2.audio.some((x) => !x.paused && x.live);
  ok(`${label}: ses akıyor`, !!(flowing && playing), c ? `${c.state} +${c && a ? c.bytes - a.bytes : 0}B audio=${JSON.stringify(s2.audio)}` : 'peer yok');
}
async function connected(X, Y, label, ms = 45000) {
  const yId = await Y.p.evaluate(() => window.CineSync.S.room.selfId);
  const r = await waitFor(async () => { const s = await st(X.p); return s.peers.find((q) => q.id === yId && q.state === 'connected') && s.members >= 2; }, ms);
  ok(`${label}: bağlantı`, !!r, r ? '' : JSON.stringify(await st(X.p)) + ' yId=' + yId);
  return !!r;
}
async function drift(label) {
  await sleep(4000);
  const [a, c] = await Promise.all([st(A.p), st(B.p)]);
  if (!a.video || !c.video) return ok(`${label}: video ikisinde de açık`, false, JSON.stringify([a.video, c.video]));
  const d = Math.abs(a.video.t - c.video.t);
  ok(`${label}: kayma ${d.toFixed(2)} sn`, d < 0.6);
}
const hide = (X, on) => X.p.evaluate((on) => {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => on });
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (on ? 'hidden' : 'visible') });
  document.dispatchEvent(new Event('visibilitychange'));
}, on);

const A = await mk('Veysel'), B = await mk('Ayşe');
await A.p.click('#createBtn');
const code = await waitFor(async () => { const c = await A.p.textContent('#roomCodeText'); return /^[a-z0-9-]{4,}$/.test(c) && c; });
await B.p.fill('#codeInput', code); await B.p.click('#joinForm button[type=submit]');
await clickMic(A.p); await clickMic(B.p); await sleep(500); await clickCam(A.p); await clickCam(B.p);
await connected(A, B, 'başlangıç'); await audioFlows(A, B, 'başlangıç A←B'); await audioFlows(B, A, 'başlangıç B←A');
const MP4 = 'https://media.w3.org/2010/05/sintel/trailer.mp4';
await A.p.evaluate((u) => window.CineSync.openSource(u), MP4);
await waitFor(() => B.p.evaluate(() => { const v = document.querySelector('#stageVideo'); return !v.hidden && v.currentTime > 1; }));
await drift('ilk video');

const sources = [MP4, 'https://www.youtube.com/watch?v=aqz-KE-bpKQ', 'https://vimeo.com/76979871', 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8', MP4];
const steps = [
  async (i) => { const u = sources[i % sources.length]; const by = i % 2 ? B : A; await by.p.evaluate((u) => window.CineSync.openSource(u), u); await sleep(6000); if (u === MP4) await drift(`kaynak→mp4 #${i}`); else ok(`kaynak→${u.split('/')[2]} #${i}`, true); },
  async (i) => { await hide(B, true); await sleep(25000); await hide(B, false); await connected(A, B, `arka plan 25sn #${i}`); await audioFlows(A, B, `arka plan dönüş A←B #${i}`); await audioFlows(B, A, `arka plan dönüş B←A #${i}`); },
  async (i) => {
    await hide(B, true);
    if (B.cdp) { await B.cdp.send('Page.setWebLifecycleState', { state: 'frozen' }); await sleep(20000); await B.cdp.send('Page.setWebLifecycleState', { state: 'active' }); }
    else { await sleep(15000); await B.ctx.setOffline(true); await sleep(15000); await B.ctx.setOffline(false); await sleep(10000); } // telefon cepte: arka plan + kısa ağ kopması
    await hide(B, false); await connected(A, B, `dondurma/arka plan+ağ #${i}`, 60000); await audioFlows(A, B, `dondurma dönüş A←B #${i}`); await audioFlows(B, A, `dondurma dönüş B←A #${i}`); },
  async (i) => { await B.ctx.setOffline(true); await sleep(12000); await B.ctx.setOffline(false); await connected(A, B, `ağ kopması 12sn #${i}`, 60000); await audioFlows(A, B, `ağ dönüşü A←B #${i}`); },
  async (i) => { const C = await mk('Misafir'); await C.p.fill('#codeInput', code); await C.p.click('#joinForm button[type=submit]'); const r = await waitFor(async () => (await st(A.p)).members === 3, 30000); ok(`C katıldı #${i}`, !!r); await sleep(5000); await C.p.evaluate(() => window.CineSync.leaveRoom()); await C.ctx.close(); const g = await waitFor(async () => (await st(A.p)).members === 2, 15000); ok(`C ayrıldı #${i}`, !!g); await audioFlows(A, B, `C sonrası A←B #${i}`); },
  async (i) => { await B.p.evaluate(() => { navigator.mediaDevices.dispatchEvent(new Event('devicechange')); }); await sleep(3500); const s = await st(B.p); ok(`devicechange mikrofon canlı #${i}`, s.mic === 'live'); await audioFlows(A, B, `devicechange sonrası A←B #${i}`); await audioFlows(B, A, `devicechange sonrası B←A #${i}`); },
];
const end = Date.now() + MINUTES * 60e3;
let i = 0;
while (Date.now() < end) {
  const t = Date.now();
  try { await steps[i % steps.length](i); } catch (e) { ok(`adım ${i} istisna`, false, e.message.split('\n')[0]); }
  console.log(`  [${((Date.now() - (end - MINUTES * 60e3)) / 60e3).toFixed(1)} dk] adım ${i} ${((Date.now() - t) / 1000).toFixed(0)} sn`);
  i++;
}
// Son durum: mp4'e dön, kayma
await A.p.evaluate((u) => window.CineSync.openSource(u), MP4); await sleep(8000);
await drift('son');
await audioFlows(A, B, 'son A←B'); await audioFlows(B, A, 'son B←A');
const appErr = await Promise.all([A, B].map((x) => x.p.evaluate(() => window.CineSync.S.errors || [])));
ok('uygulama hata kaydı boş', appErr.flat().length === 0, JSON.stringify(appErr.flat().slice(0, 5)));
ok('konsol/sayfa hatası yok', errors.length === 0, [...new Set(errors)].slice(0, 8).join(' | '));
console.log(`\nSOAK ${MINUTES} dk, ${i} adım: ${pass} geçti, ${fail} kaldı`);
await b.close(); process.exit(fail ? 1 : 0);
