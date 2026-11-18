// Uçtan uca test: iki ayrı tarayıcı profili aynı odaya girer, senkronu doğrular.
// Kullanım: node tests/e2e.mjs [http://localhost:8080/]
import { chromium } from '../node_modules/playwright-core/index.mjs';
import fs from 'node:fs';
const BASE = process.argv[2] || 'http://localhost:8080/';
const CHROME = process.env.CHROME || '/usr/bin/google-chrome';
fs.mkdirSync('tests/shots', { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const ok = (name, pass, info = '') => { results.push({ name, pass, info }); console.log(pass ? '✓' : '✗', name, info); };
async function waitFor(fn, ms = 20000, step = 250) { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { const v = await fn(); if (v) return v; } catch {} await sleep(step); } return null; }

const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--auto-select-desktop-capture-source=Entire screen', '--auto-accept-this-tab-capture'] });
const errors = { A: [], B: [] };
async function page(tag) {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 860 }, permissions: ['camera', 'microphone'] });
  const p = await ctx.newPage();
  p.on('console', (m) => { if (m.type() === 'error' && (m.location().url || '').startsWith(BASE)) errors[tag].push(m.text()); });
  p.on('pageerror', (e) => errors[tag].push('PAGEERROR ' + e.message));
  return p;
}
const A = await page('A'), B = await page('B');

await A.goto(BASE);
await A.waitForSelector('#createBtn');
await A.screenshot({ path: 'tests/shots/01-lobby.png' });
await A.fill('#nameInput', 'Veysel');
await A.click('#createBtn');
await A.waitForSelector('#roomView:not([hidden])');
const code = await A.textContent('#roomCodeText');
ok('oda oluşturuldu', /^[a-z2-9]{6}$/.test(code), code);

await B.goto(BASE + '#room=' + code);
await B.fill('#nameInput', 'Ayşe');
ok('davet linki kodu doldurdu', (await B.inputValue('#codeInput')) === code);
await B.click('#joinForm button[type=submit]');
await B.waitForSelector('#roomView:not([hidden])');

const met = await waitFor(async () => (await A.textContent('#memberCount')) === '2' && (await B.textContent('#memberCount')) === '2', 30000);
ok('iki üye birbirini gördü', !!met);
ok('röle bağlantısı', /Bağlı/.test(await A.textContent('#netText')), await A.textContent('#netText'));

await A.fill('#chatInput', 'Merhaba Ayşe!'); await A.press('#chatInput', 'Enter');
ok('sohbet iletildi', !!(await waitFor(async () => (await B.textContent('#chatList')).includes('Merhaba Ayşe!'))));
await B.fill('#chatInput', 'Selam https://example.com'); await B.press('#chatInput', 'Enter');
ok('sohbet geri iletildi + link', !!(await waitFor(async () => (await A.$$('#chatList a[href="https://example.com"]')).length)));

// ---- MP4 senkron
await A.fill('#urlInput', 'https://archive.org/download/BigBuckBunny_124/Content/big_buck_bunny_720p_surround.mp4');
await A.press('#urlInput', 'Enter');
const bv = await waitFor(() => B.evaluate(() => { const v = document.querySelector('#stageVideo'); return !v.hidden && v.currentSrc.includes('big_buck_bunny') && v.readyState >= 2; }), 30000);
ok('MP4 B tarafında açıldı', !!bv);
await sleep(9000);
const tA = await A.evaluate(() => document.querySelector('#stageVideo').currentTime);
const tB = await B.evaluate(() => document.querySelector('#stageVideo').currentTime);
const playingB = await B.evaluate(() => !document.querySelector('#stageVideo').paused);
ok('MP4 iki tarafta oynuyor ve yakın', playingB && Math.abs(tA - tB) < 2.5, `A=${tA.toFixed(1)} B=${tB.toFixed(1)}`);
await A.screenshot({ path: 'tests/shots/02-room-mp4.png' });

await A.click('#playBtn'); // duraklat
ok('duraklatma senkron', !!(await waitFor(() => B.evaluate(() => document.querySelector('#stageVideo').paused), 8000)));
await B.evaluate(() => { const r = document.querySelector('#seekBar'); r.value = 500; r.dispatchEvent(new Event('change')); });
const seekOk = await waitFor(async () => { const a = await A.evaluate(() => document.querySelector('#stageVideo').currentTime); return a > 250 ? a : null; }, 8000);
ok('B ileri sardı, A eşitlendi', !!seekOk, seekOk ? `A=${seekOk.toFixed(0)}s` : '');
await B.click('#playBtn');
ok('B oynattı, A oynuyor', !!(await waitFor(() => A.evaluate(() => !document.querySelector('#stageVideo').paused), 8000)));

// ---- HLS
await A.fill('#urlInput', 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8'); await A.press('#urlInput', 'Enter');
ok('HLS B tarafında oynuyor', !!(await waitFor(() => B.evaluate(() => { const v = document.querySelector('#stageVideo'); return !v.hidden && v.readyState >= 2 && v.currentTime > 0.5 && /m3u8/.test(window.CineSync.S.room.media.src.url); }), 30000)));

// ---- Engelli site
await A.fill('#urlInput', 'google.com'); await A.press('#urlInput', 'Enter');
ok('google.com -> B tarafında "yeni sekmede aç" kartı', !!(await waitFor(() => B.evaluate(() => { const c = document.querySelector('#stageBlocked'); return !c.hidden && c.querySelector('a[href^="https://google.com"]'); }), 10000)));
await B.screenshot({ path: 'tests/shots/03-blocked.png' });

// ---- Gömülebilir web sitesi
await A.fill('#urlInput', 'https://tr.wikipedia.org/wiki/Sinema'); await A.press('#urlInput', 'Enter');
const wiki = await waitFor(() => B.evaluate(() => { const f = document.querySelector('#stageFrame'); return !f.hidden && f.querySelector('iframe').src.includes('wikipedia'); }), 10000);
ok('Wikipedia B tarafında iframe olarak açıldı', !!wiki);
await sleep(3000);
const wikiFrame = B.frames().find((f) => f.url().includes('wikipedia.org'));
let wikiTitle = '';
try { wikiTitle = wikiFrame ? await wikiFrame.title() : ''; } catch {}
ok('Wikipedia içeriği gerçekten yüklendi', /Sinema/i.test(wikiTitle), wikiTitle);
await B.screenshot({ path: 'tests/shots/04-wikipedia.png' });

// ---- YouTube
await A.fill('#urlInput', 'https://youtu.be/aqz-KE-bpKQ?t=30'); await A.press('#urlInput', 'Enter');
const yt = await waitFor(() => B.evaluate(() => { const f = document.querySelector('#stageYT iframe'); return f && f.src.includes('youtube.com/embed/aqz-KE-bpKQ') ? f.src : null; }), 20000);
ok('YouTube oynatıcısı B tarafında oluştu', !!yt, yt ? yt.slice(0, 80) : '');
await sleep(6000);
const ytState = await B.evaluate(() => { const y = window.CineSync.S.stage.yt; try { return { st: y.getPlayerState(), t: y.getCurrentTime() }; } catch (e) { return { err: String(e) }; } });
ok('YouTube oynatma durumu okunabiliyor (IFrame API)', ytState && typeof ytState.st === 'number', JSON.stringify(ytState));
const ytA = await A.evaluate(() => { try { return window.CineSync.S.stage.yt.getCurrentTime(); } catch { return null; } });
const ytB = await B.evaluate(() => { try { return window.CineSync.S.stage.yt.getCurrentTime(); } catch { return null; } });
ok('YouTube iki tarafta aynı konumda', ytA != null && ytB != null && Math.abs(ytA - ytB) < 2.5, `A=${ytA?.toFixed(1)} B=${ytB?.toFixed(1)}`);
await B.evaluate(() => window.CineSync.S.stage.yt.pauseVideo());
ok('B YouTube içinde duraklattı -> A duraklatıldı', !!(await waitFor(() => A.evaluate(() => window.CineSync.S.stage.yt.getPlayerState() === 2), 10000)));
await B.screenshot({ path: 'tests/shots/05-youtube.png' });

// ---- Vimeo
await A.fill('#urlInput', 'https://vimeo.com/76979871'); await A.press('#urlInput', 'Enter');
const vm = await waitFor(() => B.evaluate(() => { const f = document.querySelector('#stageVimeo iframe'); return f && f.src.includes('player.vimeo.com/video/76979871'); }), 15000);
ok('Vimeo oynatıcısı B tarafında oluştu', !!vm);
await sleep(5000);
ok('Vimeo Player API bağlandı (senkron kontrolü)', await B.evaluate(() => !!window.CineSync.S.stage.vimeo));
await B.screenshot({ path: 'tests/shots/06-vimeo.png' });

// ---- v2.2: katalog, hız senkronu, tepki, yazıyor, yanıt, kilit
await A.click('#catalogBtn');
await A.waitForSelector('#catalogDialog[open]');
const catN = await A.evaluate(() => [document.querySelectorAll('#filmGrid .film').length, document.querySelectorAll('#siteGrid .site').length]);
ok('Katalog açıldı (filmler + izinli siteler)', catN[0] >= 10 && catN[1] >= 10, `film=${catN[0]} site=${catN[1]}`);
await A.click('#filmGrid [data-film="10"]'); // Tears of Steel (CC BY)
const film = await waitFor(() => B.evaluate(() => { const v = document.querySelector('#stageVideo'); return !v.hidden && v.currentSrc.includes('tears_of_steel') && v.readyState >= 2 && !v.paused; }), 30000);
ok('Katalogdan seçilen film B tarafında oynuyor', !!film);
await A.click('#playerSetBtn'); await A.click('#rateSeg [data-rate="1.5"]');
ok('Oynatma hızı 1.5× B tarafına geçti', !!(await waitFor(() => B.evaluate(() => document.querySelector('#stageVideo').playbackRate === 1.5), 10000)));
await sleep(8000);
const rA = await A.evaluate(() => document.querySelector('#stageVideo').currentTime);
const rB = await B.evaluate(() => document.querySelector('#stageVideo').currentTime);
ok('1.5× hızda iki taraf yakın', Math.abs(rA - rB) < 2.5, `A=${rA.toFixed(1)} B=${rB.toFixed(1)}`);
await A.keyboard.press('Escape');
await A.click('#emojiBtn'); await A.click('#emojiPop [data-emoji="🔥"]');
ok('Tepki (🔥) B tarafında uçtu', !!(await waitFor(() => B.evaluate(() => [...document.querySelectorAll('#reactions .float-emoji')].some((e) => e.textContent.includes('🔥'))), 6000, 100)));
await A.keyboard.press('Escape');
await A.click('#chatInput'); await A.keyboard.type('yazıyorum', { delay: 30 });
ok('“yazıyor…” göstergesi B tarafında', !!(await waitFor(async () => /Veysel yazıyor/.test(await B.textContent('#typing')), 8000)));
await A.fill('#chatInput', '');
await B.hover('#chatList .msg:not(.mine):not(.sys)');
await B.click('#chatList .msg:not(.mine):not(.sys) .reply-btn');
await B.fill('#chatInput', 'Bu bir yanıt'); await B.press('#chatInput', 'Enter');
ok('Yanıtlı mesaj A tarafında alıntıyla göründü', !!(await waitFor(() => A.evaluate(() => [...document.querySelectorAll('#chatList .msg .quote')].some((q) => /Merhaba Ayşe/.test(q.textContent))), 8000)));
await A.click('#menuBtn'); await A.click('[data-menu=lock]');
ok('Kilit B tarafında görünüyor', !!(await waitFor(() => B.evaluate(() => !document.querySelector('#lockPill').hidden && /Veysel/.test(document.querySelector('#lockText').textContent)), 8000)));
const before = [await A.evaluate(() => [!document.querySelector('#stageVideo').paused, JSON.stringify({ l: window.CineSync.S.room.media.locked, p: window.CineSync.S.room.media.playing, hist: [...document.querySelectorAll('#historyList li')].slice(0,6).map(x=>x.textContent) })]), await B.evaluate(() => [!document.querySelector('#stageVideo').paused, JSON.stringify({ l: window.CineSync.S.room.media.locked, h: window.CineSync.S.room.media.hostId, p: window.CineSync.S.room.media.playing })])];
console.log('   (bilgi) kilit öncesi', JSON.stringify(before));
await B.click('#playBtn');
await sleep(2500);
console.log('   (bilgi) kilit sonrası', await A.evaluate(() => !document.querySelector('#stageVideo').paused), await B.evaluate(() => !document.querySelector('#stageVideo').paused));
const stillPlaying = await A.evaluate(() => !document.querySelector('#stageVideo').paused) && await B.evaluate(() => !document.querySelector('#stageVideo').paused);
ok('Kilitliyken B duraklatamadı (A ve B oynamaya devam)', stillPlaying);
await A.click('#menuBtn'); await A.click('[data-menu=lock]');
ok('Kilit açıldı', !!(await waitFor(() => B.evaluate(() => document.querySelector('#lockPill').hidden), 8000)));
await A.click('#catalogBtn'); await A.click('[data-open-site="archive-feature"]');
const iaFrame = await waitFor(() => B.evaluate(() => { const f = document.querySelector('#stageFrame'); return !f.hidden && f.querySelector('iframe').src.includes('archive.org/details/feature_films'); }), 10000);
ok('İzinli site (Internet Archive) B tarafında odada açıldı', !!iaFrame);
await A.click('#catalogBtn'); await A.click('[data-open-site="tubi"]');
ok('Gömülemeyen site (Tubi) B tarafında “yeni sekmede aç” kartıyla açıldı', !!(await waitFor(() => B.evaluate(() => { const c = document.querySelector('#stageBlocked'); return !c.hidden && c.querySelector('a[href^="https://tubitv.com"]'); }), 10000)));
await B.screenshot({ path: 'tests/shots/09-catalog-blocked.png' });

// ---- Görüntülü görüşme sinyalleşmesi (kamera aç -> SDP teklif/cevap)
await A.click('#camBtn');
await A.click('#micBtn');
const neg = await waitFor(() => A.evaluate(() => { const p = [...window.CineSync.S.mesh.peers.values()][0]; return p && p.pc.remoteDescription && p.pc.remoteDescription.type === 'answer' && p.pc.signalingState === 'stable' ? 'stable' : null; }), 20000);
ok('WebRTC teklif/cevap odada iletildi (sinyalleşme)', neg === 'stable', String(neg));
const bFlags = await waitFor(() => B.evaluate(() => { const m = [...window.CineSync.S.room.members.values()].find((x) => !x.self); return m && m.cam && m.mic; }), 15000);
ok('B, A\'nın kamera/mikrofon durumunu gördü', !!bFlags);
const ice = await A.evaluate(() => { const p = [...window.CineSync.S.mesh.peers.values()][0]; return p.pc.iceConnectionState + '/' + p.pc.connectionState; });
console.log('   (bilgi) ICE durumu:', ice, '- bu test makinesinde UDP/WebRTC politikası nedeniyle medya akışı doğrulanamaz');

// ---- Ekran paylaşımı durumu
const shared = await A.evaluate(async () => { try { await window.CineSync.S.stage && document.querySelector('#screenBtn').click(); return true; } catch (e) { return String(e); } });
const scr = await waitFor(() => B.evaluate(() => { const s = document.querySelector('#stageScreen'); return !s.hidden ? s.innerText : null; }), 12000);
ok('Ekran paylaşımı başladığında B sahnesi yansıtma moduna geçti', !!scr, scr || '');
await B.screenshot({ path: 'tests/shots/08-screen.png' });

// ---- Mobil görünüm
const M = await page('A');
await M.setViewportSize({ width: 390, height: 844 });
await M.goto(BASE);
await M.screenshot({ path: 'tests/shots/07-mobile-lobby.png' });

ok('A konsol hatası yok', errors.A.filter((e) => !/WebSocket|favicon|Failed to load resource/.test(e)).length === 0, JSON.stringify(errors.A.slice(0, 6)));
ok('B konsol hatası yok', errors.B.filter((e) => !/WebSocket|favicon|Failed to load resource/.test(e)).length === 0, JSON.stringify(errors.B.slice(0, 6)));
console.log('\nTüm konsol hataları:', JSON.stringify(errors, null, 1).slice(0, 3000));
await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} kontrol geçti`);
fs.writeFileSync('tests/e2e-results.json', JSON.stringify(results, null, 2));
process.exit(failed.length ? 1 : 0);
