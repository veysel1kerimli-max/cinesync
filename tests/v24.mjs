// v2.4 özellik testleri: ortak sıra (ekle/sırala/sonraki/otomatik geçiş), 3-2-1 geri sayım, QR davet,
// sohbet tepkileri, @bahsetme, kişi başına ses, kontrolü devretme, altyazı kaydırma, tema, son odalar.
// Kullanım: node tests/v24.mjs [http://localhost:8080/] [chromium|firefox|webkit]
import { chromium, firefox, webkit } from '../node_modules/playwright-core/index.mjs';
import fs from 'node:fs';
const BASE = process.argv[2] || 'http://localhost:8080/';
const ENGINE = process.argv[3] || 'chromium';
const OUT = 'tests/shots/v24'; fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const launcher = { chromium, firefox, webkit }[ENGINE];
const browser = await launcher.launch(ENGINE === 'chromium' ? { executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] } : {});
let pass = 0, fail = 0; const errors = [];
const ok = (name, cond, extra = '') => { cond ? pass++ : fail++; console.log(`${cond ? '✓' : '✗'} ${name}${extra ? ' — ' + extra : ''}`); };
const waitFor = async (fn, ms = 15000) => { const t = Date.now(); while (Date.now() - t < ms) { try { const v = await fn(); if (v) return v; } catch {} await sleep(200); } return null; };
async function page(name, vp = { width: 1366, height: 860 }) {
  const ctx = await browser.newContext({ viewport: vp, ...(ENGINE === 'chromium' ? { permissions: ['camera', 'microphone', 'clipboard-read', 'clipboard-write'] } : {}) });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(`${name}: PAGEERROR ${e.message}`));
  p.on('console', (m) => { if (m.type() === 'error' && !/favicon|establish a connection|interactive-widget|ERR_|net::|Failed to load resource|WebSocket|youtube|vimeo|doubleclick|googlevideo/i.test(m.text())) errors.push(`${name}: ${m.text()}`); });
  await p.goto(BASE); await p.waitForSelector('#createBtn'); await p.fill('#nameInput', name);
  return p;
}
const MP4 = 'https://archive.org/download/BigBuckBunny_124/Content/big_buck_bunny_720p_surround.mp4';
const MP4B = 'https://archive.org/download/ElephantsDream/ed_1024_512kb.mp4';
const YT = 'https://www.youtube.com/watch?v=aqz-KE-bpKQ';

const A = await page('Veysel');
ok('sürüm 2.4.0', (await A.evaluate(() => window.CineSync.version)) === '2.4.0');
ok('ana sayfada "Yeni · v2.4" rozeti', await A.isVisible('#whatsNewBtn'));
await A.click('#whatsNewBtn');
ok('Yenilikler penceresi açıldı', await A.isVisible('#whatsNewDialog[open]'));
await A.screenshot({ path: `${OUT}/whatsnew.png` });
await A.click('#whatsNewDialog button[value=ok]');
// Tema (ana sayfa)
await A.click('#themeBtn');
ok('tema düğmesi açık temaya geçirdi', (await A.evaluate(() => document.documentElement.dataset.theme)) === 'light');
await A.screenshot({ path: `${OUT}/lobby-light.png` });
await A.click('#themeBtn');
ok('tema geri koyu', (await A.evaluate(() => document.documentElement.dataset.theme)) === 'dark');

await A.click('#createBtn');
await A.waitForSelector('#roomView:not([hidden])');
const code = await A.textContent('#roomCodeText');
const B = await page('Ayşe Yılmaz');
await B.fill('#codeInput', code); await B.click('#joinForm button[type=submit]');
await B.waitForSelector('#roomView:not([hidden])');
ok('iki üye buluştu', !!(await waitFor(async () => (await A.textContent('#memberCount')) === '2' && (await B.textContent('#memberCount')) === '2', 30000)));

// ---- Davet (QR)
await A.click('#inviteBtn');
ok('davet penceresi açıldı', await A.isVisible('#inviteDialog[open]'));
const qr = await A.evaluate(() => { const s = document.querySelector('#qrBox svg'); return s ? { w: s.getBoundingClientRect().width, path: s.querySelector('path').getAttribute('d').length } : null; });
ok('QR kod yerel olarak çizildi', qr && qr.w > 100 && qr.path > 200, JSON.stringify(qr));
ok('davet linki odaya işaret ediyor', (await A.inputValue('#invLink')).endsWith('#room=' + code));
ok('WhatsApp/Telegram bağlantıları', /wa\.me/.test(await A.getAttribute('#invWa', 'href')) && /t\.me\/share/.test(await A.getAttribute('#invTg', 'href')));
await A.screenshot({ path: `${OUT}/invite-qr.png` });
await A.keyboard.press('Escape');

// ---- Ortak sıra
await A.click('.tab[data-tab=queue]');
ok('Sıra sekmesi boş durum', await A.isVisible('#queueEmpty'));
await A.fill('#queueInput', MP4); await A.press('#queueInput', 'Enter');
const started = await waitFor(() => B.evaluate((u) => window.CineSync.S.room.media?.src?.url === u, MP4), 15000);
ok('boş odada sıraya eklenen ilk öğe herkeste başladı', !!started);
await A.fill('#queueInput', MP4B); await A.press('#queueInput', 'Enter');
await A.fill('#queueInput', YT); await A.press('#queueInput', 'Enter');
ok('B tarafında sıra 3 öğe', !!(await waitFor(() => B.evaluate(() => window.CineSync.S.room.queue?.items.length === 3), 10000)));
ok('B sekme rozeti 3', (await B.textContent('#queueCount')) === '3');
ok('Sonraki düğmesi görünüyor', await A.isVisible('#nextBtn'));
// Sırala: son öğeyi yukarı taşı
await A.click('#queueList li:nth-child(3) [data-qmove="-1"]');
ok('sıralama herkese yansıdı', !!(await waitFor(() => B.evaluate((y) => window.CineSync.S.room.queue.items[1].url.includes('aqz-KE-bpKQ'), YT), 8000)));
await A.screenshot({ path: `${OUT}/queue-desktop.png` });
// Sonraki (B tetikler)
await B.click('.tab[data-tab=queue]');
await B.click('#nextBtn');
ok('B "Sonraki" ile ikinci öğeye geçti, A da geçti', !!(await waitFor(() => A.evaluate(() => window.CineSync.S.room.media?.src?.kind === 'youtube'), 12000)));
ok('Önceki düğmesi görünür', await B.isVisible('#prevBtn'));
await B.keyboard.press('Escape');
await B.click('#stage', { position: { x: 5, y: 5 } }).catch(() => {});
await B.evaluate(() => { document.activeElement?.blur(); window.focus(); });
await B.focus('#nextBtn');
await B.keyboard.press('p');
ok('P kısayolu öncekine döndü', !!(await waitFor(() => A.evaluate((u) => window.CineSync.S.room.media?.src?.url === u, MP4), 12000)));
// Otomatik geçiş: video sonunu taklit et (yetkili tarafta)
const auth = await A.evaluate(() => window.CineSync.S.room.media.byId === window.CineSync.S.room.selfId) ? A : B;
await auth.evaluate(() => window.CineSync.onMediaEnded());
ok('video bitince sıradakine otomatik geçildi', !!(await waitFor(() => A.evaluate(() => window.CineSync.S.room.media?.src?.kind === 'youtube'), 12000)));
// Katalogdan sıraya ekle
await A.click('#catalogBtn'); await A.waitForSelector('#catalogDialog[open]');
await A.click('[data-film-q="0"]');
ok('katalogdan film sıraya eklendi', !!(await waitFor(() => B.evaluate(() => window.CineSync.S.room.queue.items.length === 4), 8000)));
ok('film kartı "sırada" işaretli', !!(await A.$('[data-film-q="0"].on')));
await A.click('#catalogDialog [data-close]');

// ---- Geri sayım (MP4'e dön)
await A.evaluate((u) => window.CineSync.openSource(u), MP4);
await waitFor(() => B.evaluate(() => { const v = document.querySelector('#stageVideo'); return !v.hidden && v.readyState >= 2; }), 30000);
await A.evaluate(() => document.activeElement?.blur());
await A.keyboard.press('g');
ok('A tarafında geri sayım görünüyor', await A.isVisible('#countdown'));
ok('B tarafında geri sayım görünüyor', !!(await waitFor(() => B.isVisible('#countdown'), 5000)));
await B.screenshot({ path: `${OUT}/countdown.png` });
ok('geri sayım sırasında duraklatıldı', !!(await waitFor(() => B.evaluate(() => window.CineSync.S.room.media.playing === false), 4000)));
ok('geri sayım sonunda herkeste oynuyor', !!(await waitFor(() => B.evaluate(() => window.CineSync.S.room.media.playing === true && !document.querySelector('#stageVideo').paused), 9000)));
ok('geri sayım kapandı', !!(await waitFor(async () => !(await A.isVisible('#countdown')) && !(await B.isVisible('#countdown')), 4000)));
// İptal
await A.keyboard.press('g'); await sleep(600);
await A.click('#cdCancel');
ok('geri sayım iptali B tarafına ulaştı', !!(await waitFor(async () => !(await B.isVisible('#countdown')), 5000)));

// ---- Sohbet: @bahsetme + tepki
await B.click('.tab[data-tab=chat]');
await A.click('.tab[data-tab=chat]');
await A.fill('#chatInput', ''); await A.type('#chatInput', 'Selam @Ay');
ok('@ önerisi açıldı', await A.isVisible('#mentionList'));
await A.press('#chatInput', 'Enter');
ok('öneri seçilince ad tamamlandı', (await A.inputValue('#chatInput')).includes('@Ayşe Yılmaz '));
await A.type('#chatInput', 'film başlıyor!'); await A.press('#chatInput', 'Enter');
ok('B tarafında mesaj "senden bahsetti" olarak vurgulandı', !!(await waitFor(() => B.$('#chatList .msg.mentioned .mention'), 8000)));
const mid = await B.evaluate(() => document.querySelector('#chatList .msg.mentioned').dataset.id);
await B.hover(`#chatList .msg[data-id="${mid}"]`);
await B.click(`#chatList .msg[data-id="${mid}"] [data-react-open]`);
await B.click(`#chatList .msg[data-id="${mid}"] [data-pick="👍"]`);
ok('tepki A tarafında görünüyor (👍 1)', !!(await waitFor(() => A.evaluate((id) => { const c = document.querySelector(`#chatList .msg[data-id="${id}"] .react-chip[data-react="👍"] b`); return c && c.textContent === '1'; }, mid), 8000)));
await A.click(`#chatList .msg[data-id="${mid}"] .react-chip[data-react="👍"]`);
ok('A da tepki verdi → 2', !!(await waitFor(() => B.evaluate((id) => document.querySelector(`#chatList .msg[data-id="${id}"] .react-chip b`)?.textContent === '2', mid), 8000)));
await A.click('#chatEmojiBtn');
ok('sohbet emoji paneli', await A.isVisible('#chatEmojiPop'));
await A.click('#chatEmojiPop [data-ins="🍿"]');
ok('emoji giriş kutusuna eklendi', (await A.inputValue('#chatInput')).includes('🍿'));
await A.fill('#chatInput', '');
await B.screenshot({ path: `${OUT}/chat-reactions.png` });

// ---- Kişiler: ses düzeyi + kontrolü devretme
await A.click('.tab[data-tab=members]');
ok('kişi başına ses kaydırıcısı', !!(await A.$('#memberList [data-vol-id]')));
await A.evaluate(() => { const r = document.querySelector('#memberList [data-vol-id]'); r.value = 40; r.dispatchEvent(new Event('input', { bubbles: true })); });
ok('ses düzeyi uygulandı ve hatırlandı', (await A.evaluate(() => window.CineSync.S.peerVol['Ayşe Yılmaz'])) === 0.4);
await A.click('#menuBtn'); await A.click('[data-menu=lock]');
ok('kilitlenince "Devret" düğmesi çıktı', !!(await waitFor(() => A.$('#memberList [data-handover]'), 4000)));
await A.screenshot({ path: `${OUT}/members-host.png` });
await A.click('#memberList [data-handover]');
ok('B artık oda sahibi', !!(await waitFor(() => B.evaluate(() => window.CineSync.S.room.media.hostId === window.CineSync.S.room.selfId), 8000)));
ok('A artık kontrol edemiyor', !!(await waitFor(() => A.evaluate(() => document.querySelector('#player').classList.contains('locked-out')), 5000)));
ok('kilitliyken A sıraya ekleyemez', !(await A.evaluate((u) => window.CineSync.addToQueue(u), 'https://example.com/a.mp4')));
await B.click('#menuBtn'); await B.click('[data-menu=lock]');
ok('B kilidi açtı', !!(await waitFor(() => A.evaluate(() => !window.CineSync.S.room.media.locked), 6000)));

// ---- Altyazı kaydırma
await A.evaluate(async () => { await window.CineSync.S.stage.setSubtitles({ text: '1\n00:00:01,000 --> 00:00:03,500\nMerhaba\n', label: 'test' }); });
await A.click('#playerSetBtn');
await A.click('[data-subs-shift="0.5"]'); await A.click('[data-subs-shift="0.5"]');
ok('altyazı +1,0 sn kaydırıldı', (await A.textContent('#subsOffVal')).includes('+1,0'));
const cue = await waitFor(() => A.evaluate(() => { const t = [...document.querySelector('#stageVideo').textTracks].pop(); return t?.cues?.length ? t.cues[0].startTime : null; }), 4000);
ok('kaydırılmış altyazı zamanı 2,0 sn', Math.abs((cue ?? 0) - 2) < 0.01, String(cue));
await A.click('[data-subs-size="l"]');
ok('altyazı boyutu büyük', await A.evaluate(() => document.querySelector('#stageVideo').classList.contains('subs-l')));
await A.keyboard.press('Escape');

// ---- Tema (oda) ve ayarlar
await A.click('#menuBtn'); await A.click('[data-menu=settings]');
await A.click('[data-theme-opt=light]'); await A.click('[data-accent=turkuaz]');
ok('ayarlardan açık tema + turkuaz', await A.evaluate(() => document.documentElement.dataset.theme === 'light' && document.documentElement.dataset.accent === 'turkuaz'));
await A.click('#settingsDialog button[value=ok]');
await A.click('.tab[data-tab=queue]');
await A.waitForTimeout(500);
await A.screenshot({ path: `${OUT}/room-light.png` });
const ovf = await A.evaluate(() => document.documentElement.scrollWidth - innerWidth);
ok('açık temada yatay taşma yok', ovf <= 0, String(ovf));
await A.reload(); await A.waitForSelector('#roomView:not([hidden]), #createBtn:visible');
ok('tema yeniden yüklemede korunur', await A.evaluate(() => document.documentElement.dataset.theme === 'light'));
await A.evaluate(() => { localStorage.setItem('cinesync:theme', 'dark'); localStorage.removeItem('cinesync:accent'); });

// ---- Son odalar: göreli zaman + kaldır
await A.evaluate(() => window.CineSync.leaveRoom()); await A.waitForSelector('#createBtn');
ok('son odalar listesinde zaman', /önce/.test(await A.textContent('#recentRoomList')));
const before = await A.$$eval('#recentRoomList .room-chip', (x) => x.length);
await A.click('#recentRoomList [data-forget]');
ok('son oda listeden kaldırıldı', (await A.$$eval('#recentRoomList .room-chip', (x) => x.length)) === before - 1);

ok('konsol hatası yok', errors.length === 0, errors.slice(0, 5).join(' | '));
console.log(`\n${pass}/${pass + fail} kontrol geçti (${ENGINE})`);
await browser.close();
process.exit(fail ? 1 : 0);
