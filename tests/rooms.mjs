// v2.3 oda testleri: kod doğrulama, özel kod, "kod kullanımda" uyarısı, boş odanın sıfırlanması,
// uzun donmadan sonra temiz başlangıç, şifreli oda ve yanlış şifre.
import { chromium, firefox, webkit } from '../node_modules/playwright-core/index.mjs';
const BASE = process.argv[2] || 'http://localhost:8080/';
const ENGINE = process.argv[3] || 'chromium';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const launcher = { chromium, firefox, webkit }[ENGINE];
const b = await launcher.launch(ENGINE === 'chromium' ? { executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] } : {});
let pass = 0, fail = 0; const errors = [];
const ok = (name, cond, extra = '') => { cond ? pass++ : fail++; console.log(`${cond ? '✓' : '✗'} ${name}${extra ? ' — ' + extra : ''}`); };
const waitFor = async (fn, ms = 15000) => { const t = Date.now(); while (Date.now() - t < ms) { try { const v = await fn(); if (v) return v; } catch {} await sleep(250); } return null; };
async function page(name) {
  const ctx = await b.newContext({ viewport: { width: 1280, height: 800 } });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  p.on('console', (m) => { if (m.type() === 'error' && !/favicon|establish a connection|interactive-widget|ERR_|net::|Failed to load resource|WebSocket/i.test(m.text())) errors.push(`${name}: ${m.text()}`); });
  await p.goto(BASE); await p.waitForSelector('#createBtn'); await p.fill('#nameInput', name);
  return p;
}
const members = (p) => p.evaluate(() => window.CineSync.S.room?.memberList().length || 0);
const epoch = (p) => p.evaluate(() => window.CineSync.S.room?.epoch || null);
const chatText = (p) => p.evaluate(() => document.querySelector('#chatList').innerText);
const stageSrc = (p) => p.evaluate(() => window.CineSync.S.room?.media?.src?.url || '');
const locked = (p) => p.evaluate(() => !!window.CineSync.S.room?.media?.locked);
const leave = (p) => p.evaluate(() => window.CineSync.leaveRoom());
async function createCustom(p, code, pw = '') {
  await p.evaluate(() => { document.querySelector('#advRoom').open = true; });
  await p.fill('#customCode', code); if (pw) await p.fill('#roomPass', pw);
  await p.click('#createBtn');
}

const uniq = Math.random().toString(36).slice(2, 7);

// 1) Normalleştirme ve doğrulama
const A = await page('Veysel');
const norm = await A.evaluate(async () => {
  const m = await import('./js/room.js');
  const cases = ['Film Gecesi Çğ', 'İSTANBUL ışık', 'ŞÜKRÜ_öz!!', '  --a--b-- ', 'ab', 'x'.repeat(33), 'abcd'];
  return cases.map((c) => [m.normalizeRoomCode(c), m.validateRoomCode(c)]);
});
ok('Türkçe harfler + küçük harf', norm[0][0] === 'film-gecesi-cg' && norm[1][0] === 'istanbul-isik' && norm[2][0] === 'sukru-oz', JSON.stringify(norm.slice(0, 3).map((x) => x[0])));
ok('tire düzeltme', norm[3][0] === 'a-b');
ok('çok kısa reddedildi', !!norm[4][1] && !!norm[3][1]);
ok('çok uzun reddedildi', !!norm[5][1]);
ok('geçerli kod kabul', norm[6][1] === '');
await A.evaluate(() => { document.querySelector('#advRoom').open = true; });
await A.fill('#customCode', 'ab'); await A.click('#createBtn'); await sleep(400);
ok('geçersiz özel kodla oda açılmadı', await A.evaluate(() => !window.CineSync.S.room));
ok('ipucu hata gösteriyor', await A.evaluate(() => document.querySelector('#customCodeHint').classList.contains('err')));
const gen = await A.evaluate(async () => (await import('./js/room.js')).generateRoomCode());
ok('otomatik kod küçük harf', /^[a-z2-9]{6}$/.test(gen), gen);

// 2) Özel kodla oda oluşturma
const CODE = `Film Gecesi ${uniq}`;
const NCODE = `film-gecesi-${uniq}`;
await createCustom(A, CODE);
ok('özel kodla oda açıldı', !!(await waitFor(async () => (await A.textContent('#roomCodeText')) === NCODE, 10000)), await A.textContent('#roomCodeText'));
ok('URL normalize kodu taşıyor', (await A.evaluate(() => location.hash)) === `#room=${NCODE}`);
const epA = await waitFor(() => epoch(A), 8000);
ok('ilk üye oturum (epoch) kurdu', !!epA, epA);

// 3) Aynı kodla oluşturma → "kod kullanımda" uyarısı
const B = await page('Ayşe');
await createCustom(B, CODE.toUpperCase());
const occ = await waitFor(() => B.evaluate(() => document.querySelector('#occupiedDialog').open && document.querySelector('#occText').textContent), 12000);
ok('"Bu kod kullanımda — katılmak ister misin?" uyarısı', !!occ && occ.includes('Bu kod kullanımda — katılmak ister misin?'), occ || '');
await B.click('#occJoin');
ok('uyarıdan sonra katıldı', !!(await waitFor(async () => (await members(A)) === 2 && (await members(B)) === 2, 15000)));
ok('ikinci üye aynı oturumu devraldı', !!(await waitFor(async () => (await epoch(B)) === epA, 8000)));

// Oda içeriği: sohbet, video, kilit
await A.fill('#chatInput', `eski mesaj ${uniq}`); await A.press('#chatInput', 'Enter');
await A.evaluate(() => window.CineSync.openSource('https://media.w3.org/2010/05/sintel/trailer.mp4'));
await sleep(1000);
await A.evaluate(() => { document.querySelector('[data-act="lock"], [data-menu="lock"], #lockBtn')?.click(); });
await waitFor(() => locked(A), 3000);
ok('B içeriği aldı', !!(await waitFor(async () => (await chatText(B)).includes(`eski mesaj ${uniq}`) && (await stageSrc(B)).includes('sintel'), 10000)));

// 4) Herkes çıkar → aynı koda gelen yeni üye temiz başlar
await leave(B); await leave(A);
await sleep(2500);
const C = await page('Yeni');
await C.fill('#codeInput', NCODE); await C.click('#joinForm button[type=submit]');
await waitFor(() => epoch(C), 8000);
await sleep(4000);
ok('boş oda: eski sohbet yok', !(await chatText(C)).includes('eski mesaj'));
ok('boş oda: eski video yok', (await stageSrc(C)) === '');
ok('boş oda: kilit yok', !(await locked(C)));
const epC = await epoch(C);
ok('boş oda: yeni oturum', !!epC && epC !== epA, `${epA} → ${epC}`);

// 5) Odadakilerden biri uzun süre donmuş gibi dönerse: eski durumunu taşımadan temiz başlar
await C.fill('#chatInput', `c mesaj ${uniq}`); await C.press('#chatInput', 'Enter');
const D = await page('Donan');
await D.fill('#codeInput', NCODE); await D.click('#joinForm button[type=submit]');
await waitFor(async () => (await members(D)) === 2 && (await epoch(D)) === epC, 15000);
await leave(C); await sleep(1500);  // D tek kaldı; sonra "donmuş" gibi davranıp dönüyor
const E = await page('Sonraki');
await D.evaluate(() => { const r = window.CineSync.S.room; r._lastBeat = Date.now() - 200000; });
await E.fill('#codeInput', NCODE); await E.click('#joinForm button[type=submit]');
await D.evaluate(() => window.CineSync.S.room.resume());
ok('donmadan dönen üye sohbeti temizledi', !!(await waitFor(async () => !(await chatText(D)).includes(`c mesaj ${uniq}`), 5000)));
ok('donan ve yeni gelen aynı oturumda buluştu', !!(await waitFor(async () => (await members(E)) === 2 && (await epoch(E)) === (await epoch(D)), 15000)));
await leave(D); await leave(E);

// 6) Şifreli oda
const PCODE = `gizli-${uniq}`;
const P1 = await page('Sahip');
await createCustom(P1, PCODE, 'dogru-sifre');
await waitFor(() => epoch(P1), 8000);
ok('şifreli oda kilit simgesi', await P1.evaluate(() => !document.querySelector('#roomLockIc').hidden));
ok('davet linkinde şifre yok', !(await P1.evaluate(() => location.href)).includes('dogru-sifre'));
await P1.fill('#chatInput', `sır ${uniq}`); await P1.press('#chatInput', 'Enter');

// Şifresiz oluşturmaya çalışan → kullanımda (şifreli) uyarısı
const P2 = await page('Meraklı');
await createCustom(P2, PCODE);
const occ2 = await waitFor(() => P2.evaluate(() => document.querySelector('#occupiedDialog').open && document.querySelector('#occText').textContent), 12000);
ok('şifreli oda da "kullanımda" görünüyor', !!occ2 && occ2.includes('şifreli'), occ2 || '');
await P2.click('#occJoin');
const pd = await waitFor(() => P2.evaluate(() => document.querySelector('#passDialog').open), 20000);
ok('şifresiz katılımda şifre penceresi', !!pd);
ok('şifresiz katılan içeriği göremedi', !(await chatText(P2)).includes(`sır ${uniq}`) && (await members(P2)) === 1);
// Yanlış şifre
await P2.fill('#passInput', 'yanlis'); await P2.click('#passDialog button[value=ok]');
await sleep(500);
const pd2 = await waitFor(() => P2.evaluate(() => document.querySelector('#passDialog').open && document.querySelector('#passText').textContent), 20000);
ok('yanlış şifrede yine uyarı', !!pd2 && pd2.includes('yanlış'), pd2 || '');
ok('yanlış şifreyle üye görünmüyor', (await members(P1)) === 1);
// Doğru şifre
await P2.fill('#passInput', 'dogru-sifre'); await P2.click('#passDialog button[value=ok]');
ok('doğru şifreyle katıldı', !!(await waitFor(async () => (await members(P1)) === 2 && (await members(P2)) === 2, 15000)));
ok('doğru şifreyle sohbet geldi', !!(await waitFor(async () => (await chatText(P2)).includes(`sır ${uniq}`), 10000)));
ok('kilit simgesi katılanda da', await P2.evaluate(() => !document.querySelector('#roomLockIc').hidden));

ok('sayfa hatası yok', errors.length === 0, errors.slice(0, 5).join(' | '));
console.log(`\n${ENGINE}: ${pass} geçti, ${fail} kaldı`);
await b.close(); process.exit(fail ? 1 : 0);
