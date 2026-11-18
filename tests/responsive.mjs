// Duyarlılık testi: her ekran boyutunda ve durumda yatay taşma olmamalı, konsol hatası olmamalı.
// Kullanım: node tests/responsive.mjs [http://localhost:8080/]
import { chromium } from '../node_modules/playwright-core/index.mjs';
import fs from 'node:fs';
import { openLink, menu, clickCam, openCatalogUI, showTab, isMobileUI, BADGE_SCRIPT, badgeOverlap } from './ui-helpers.mjs';
const BASE = process.argv[2] || 'http://localhost:8080/';
const OUT = 'tests/shots/responsive';
fs.mkdirSync(OUT, { recursive: true });
const ALL = [[320, 568], [360, 740], [390, 844], [412, 915], [844, 390], [768, 1024], [1024, 768], [1180, 820], [1366, 1024], [1280, 800], [1366, 768], [1440, 900], [1920, 1080]];
const VIEWPORTS = process.env.VP ? ALL.filter(([w, h]) => process.env.VP.split(',').includes(`${w}x${h}`)) : ALL;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
const errors = [];
const rows = [];
let fails = 0;

async function newPage(vw, vh, mobile) {
  const ctx = await browser.newContext({ viewport: { width: vw, height: vh }, permissions: ['camera', 'microphone', 'clipboard-read'], hasTouch: mobile, isMobile: mobile, deviceScaleFactor: 1 });
  await ctx.addInitScript(BADGE_SCRIPT);
  const p = await ctx.newPage();
  p.on('console', (m) => { if (m.type() === 'error' && (m.location().url || '').startsWith(BASE) && !/WebSocket/.test(m.text())) errors.push(`${vw}x${vh}: ${m.text()}`); });
  p.on('pageerror', (e) => errors.push(`${vw}x${vh} PAGEERROR ${e.message}`));
  return p;
}

// Taşma ölçümü: kök kaydırma genişliği + görünür kapsayıcının dışına taşan öğeler
async function overflow(p) {
  return p.evaluate(() => {
    const de = document.documentElement, b = document.body;
    const prev = [de.style.overflowX, b.style.overflowX];
    de.style.overflowX = 'visible'; b.style.overflowX = 'visible';
    const sw = Math.max(de.scrollWidth, b.scrollWidth), iw = window.innerWidth;
    const bad = [];
    const clipped = (el) => { for (let a = el.parentElement; a && a !== b; a = a.parentElement) { const o = getComputedStyle(a).overflowX; if (o !== 'visible') return true; } return false; };
    for (const el of document.querySelectorAll('body *')) {
      if (el.closest('[hidden], dialog:not([open]), svg')) continue;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      if ((r.right > iw + 1 || r.left < -1) && !clipped(el)) bad.push(`${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}.${(el.className && el.className.baseVal === undefined ? el.className : '').toString().split(' ')[0]} [${Math.round(r.left)}..${Math.round(r.right)}]`);
    }
    de.style.overflowX = prev[0]; b.style.overflowX = prev[1];
    return { sw, iw, bad: bad.slice(0, 5) };
  });
}
async function check(p, tag, vw, vh, state) {
  const o = await overflow(p);
  const pass = o.sw <= o.iw && o.bad.length === 0;
  if (!pass) fails++;
  rows.push({ viewport: `${vw}x${vh}`, state, scrollWidth: o.sw, innerWidth: o.iw, pass, offenders: o.bad });
  await p.screenshot({ path: `${OUT}/${vw}x${vh}-${tag}.png` });
  console.log(pass ? '✓' : '✗', `${vw}x${vh}`, state.padEnd(22), `scrollWidth=${o.sw} innerWidth=${o.iw}`, o.bad.length ? o.bad.join(' | ') : '');
}

// Odayı dolduran ikinci kişi
const helper = await newPage(1280, 800, false);
for (const [vw, vh] of VIEWPORTS) {
  const mobile = vw < 1024 && Math.min(vw, vh) < 600;
  const p = await newPage(vw, vh, mobile);
  await p.goto(BASE);
  await p.waitForSelector('#createBtn');
  await sleep(300);
  await check(p, '01-lobby', vw, vh, 'ana sayfa (üst)');
  // Gerçek kaydırma: masaüstünde fare tekerleği, mobilde parmakla kaydırma (dokunma hareketi)
  {
    const maxY = await p.evaluate(() => document.documentElement.scrollHeight - innerHeight);
    await p.mouse.move(vw / 2, vh / 2);
    let y = 0;
    if (mobile) {
      const cdp = await p.context().newCDPSession(p);
      // Gerçek dokunma olayları (touchStart → touchMove… → touchEnd): parmakla yukarı kaydırma
      const swipe = async () => {
        const x = Math.round(vw / 2), y0 = Math.round(vh * 0.8), y1 = Math.round(vh * 0.2);
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: y0 }] });
        for (let k = 1; k <= 10; k++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: Math.round(y0 + (y1 - y0) * k / 10) }] }); await sleep(16); }
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      };
      for (let i = 0; i < 60 && y < maxY - 2; i++) { await swipe(); await sleep(120); y = await p.evaluate(() => scrollY); }
    } else {
      for (let i = 0; i < 60 && y < maxY - 2; i++) { await p.mouse.wheel(0, 500); await sleep(60); y = await p.evaluate(() => scrollY); }
    }
    await sleep(400);
    y = await p.evaluate(() => scrollY);
    const footerVisible = await p.evaluate(() => { const r = document.querySelector('.site-foot').getBoundingClientRect(); return r.top < innerHeight && r.bottom <= innerHeight + 2; });
    const pass = maxY > 0 && y >= maxY - 2 && footerVisible;
    if (!pass) fails++;
    rows.push({ viewport: `${vw}x${vh}`, state: `ana sayfa ${mobile ? 'parmakla' : 'tekerlekle'} kaydırma`, pass, scrollY: y, maxY });
    console.log(pass ? '✓' : '✗', `${vw}x${vh}`, `ana sayfa ${mobile ? 'dokunarak' : 'tekerlekle'} en alta kaydı`, `scrollY=${y}/${maxY}`, footerVisible ? 'alt bilgi görünüyor' : 'ALT BİLGİ GÖRÜNMÜYOR');
    await p.evaluate(() => { document.documentElement.style.scrollBehavior = 'auto'; scrollTo(0, 0); document.documentElement.style.scrollBehavior = ''; });
  }
  await p.screenshot({ path: `${OUT}/${vw}x${vh}-01b-landing-full.png`, fullPage: true });
  for (const sec of ['#ozellikler', '#kaynaklar', '#sss']) { await p.evaluate((s) => document.querySelector(s).scrollIntoView(), sec); await sleep(150); }
  await p.click('#sss details summary');
  await check(p, '01c-landing-faq', vw, vh, 'ana sayfa (SSS açık)');
  await p.evaluate(() => window.scrollTo(0, 0));
  await p.fill('#nameInput', 'Veysel Kerimli Uzun İsim');
  await p.click('#createBtn');
  await p.waitForSelector('#roomView:not([hidden])');
  const code = await p.textContent('#roomCodeText');
  await helper.goto(BASE + '#room=' + code);
  await helper.fill('#nameInput', 'Çok Uzun Kullanıcı Adı Burada');
  await helper.click('#joinForm button[type=submit]');
  await p.waitForFunction(() => document.querySelector('#memberCount').textContent === '2', null, { timeout: 30000 }).catch(() => {});
  await helper.fill('#chatInput', 'Uzun link testi: https://www.example.com/cok/uzun/bir/adres/ki/satira/sigmayabilir?parametre=degeriiiiiiiiiiiiiiiiiiiiiiiiiiiii');
  await helper.press('#chatInput', 'Enter');
  await sleep(800);
  await check(p, '02-room-empty', vw, vh, 'oda (boş sahne)');
  // Oda ekrana tam oturur: sayfa kaymaz, her şey görünür alanda
  { const bo = await badgeOverlap(p); }
  const fitCheck = async (label) => {
    const f = await p.evaluate(() => {
      const ih = innerHeight, iw = innerWidth, de = document.documentElement;
      const box = (sel) => { const e = document.querySelector(sel); if (!e || e.offsetParent === null) return null; const r = e.getBoundingClientRect(); return [Math.round(r.top), Math.round(r.bottom)]; };
      const parts = { topbar: box('.topbar'), address: box('#addressBar'), stage: box('#stage'), transport: box('#transport'), tabs: box('.tabs'), chatForm: box('#chatForm') };
      const inside = Object.values(parts).filter(Boolean).every(([t, b]) => t >= -1 && b <= ih + 1);
      return { pageScroll: de.scrollHeight - ih, inside, parts, stageH: parts.stage ? parts.stage[1] - parts.stage[0] : 0 };
    });
    const pass = f.pageScroll <= 1 && f.inside && f.stageH >= 110;
    if (!pass) fails++;
    rows.push({ viewport: `${vw}x${vh}`, state: `oda ekrana oturuyor (${label})`, pass, ...f });
    console.log(pass ? '✓' : '✗', `${vw}x${vh}`, `oda ekrana oturuyor (${label})`, JSON.stringify(f));
  };
  await fitCheck('boş');
  // Sohbet sekmesi
  await showTab(p, 'chat').catch(() => {});
  await check(p, '03-chat', vw, vh, 'sohbet açık');
  if (vw < 1024) { await showTab(p, 'cams'); await check(p, '04-cams', vw, vh, 'kameralar sekmesi'); await showTab(p, 'members'); await check(p, '05-members', vw, vh, 'kişiler sekmesi'); await showTab(p, 'chat'); }
  // Menü (mobilde "Daha fazla" sayfası)
  await p.click((await p.isVisible('#menuBtn')) ? '#menuBtn' : '#mMore'); await sleep(250); await check(p, '06-menu', vw, vh, 'menü açık'); await p.keyboard.press('Escape'); await sleep(150);
  // Rozet (sağ alt) altında düğme yok
  { const bo = await badgeOverlap(p); const ok = bo.length === 0; if (!ok) fails++; rows.push({ viewport: `${vw}x${vh}`, state: 'rozet altında düğme yok (oda)', pass: ok, bo }); console.log(ok ? '✓' : '✗', `${vw}x${vh}`, 'rozet altında düğme yok (oda)', bo.join(' ')); }
  // Katalog (izin verilen siteler)
  await openCatalogUI(p);
  const catCounts = await p.evaluate(() => ({ films: document.querySelectorAll('#filmGrid .film').length, sites: document.querySelectorAll('#siteGrid .site').length }));
  await check(p, '06b-catalog', vw, vh, `katalog açık (${catCounts.films} film, ${catCounts.sites} site)`);
  await p.click('#catFilters [data-cat=turk]');
  await check(p, '06c-catalog-filter', vw, vh, 'katalog: Türk filtresi');
  await p.click('#catalogDialog [data-close]');
  // Video oynuyor
  await openLink(p, 'https://archive.org/download/BigBuckBunny_124/Content/big_buck_bunny_720p_surround.mp4');
  await p.waitForFunction(() => { const v = document.querySelector('#stageVideo'); return !v.hidden && v.currentTime > 0.3; }, null, { timeout: 30000 }).catch(() => {});
  await check(p, '07-video', vw, vh, 'video oynuyor');
  await fitCheck('video');
  // Tarayıcı boyutu değişince (adres çubuğu / pencere) yeniden oturur
  await p.setViewportSize({ width: vw, height: Math.round(vh * 0.86) });
  await sleep(400);
  await fitCheck('yükseklik %86');
  await p.setViewportSize({ width: vw, height: vh });
  await sleep(400);
  // Engelli site kartı
  await openLink(p, 'https://www.google.com/search?q=cok-uzun-bir-arama-ifadesi-ile-test-ediyoruz-taşma-olmasın');
  await p.waitForSelector('#stageBlocked:not([hidden])');
  await check(p, '08-blocked', vw, vh, 'yedek kart (engelli)');
  // Tam ekran + kameralar
  await openLink(p, 'https://archive.org/download/BigBuckBunny_124/Content/big_buck_bunny_720p_surround.mp4');
  await sleep(1500);
  await clickCam(p);
  await p.evaluate(() => {
    const mk = (hue) => { const c = document.createElement('canvas'); c.width = 320; c.height = 240; const g = c.getContext('2d'); setInterval(() => { g.fillStyle = `hsl(${hue} 70% 50%)`; g.fillRect(0, 0, 320, 240); g.fillStyle = '#fff'; g.font = '40px sans-serif'; g.fillText(new Date().getSeconds(), 120, 140); }, 200); return c.captureStream(5); };
    window.__testPips = [{ id: 't1', name: 'Ayşe', color: 'hsl(320 75% 64%)', stream: mk(320) }, { id: 't2', name: 'Mehmet Uzunisimli', color: 'hsl(140 75% 64%)', stream: mk(140) }];
  });
  await sleep(800);
  await p.click(await p.isVisible('#fsBtn') ? '#fsBtn' : '#fsFloatBtn');
  await p.waitForFunction(() => document.querySelector('#player').classList.contains('is-fs'), null, { timeout: 5000 }).catch(() => {});
  await sleep(700);
  const fsInfo = await p.evaluate(() => ({ real: !!document.fullscreenElement, pseudo: window.CineSync.S.pseudoFs, tiles: [...document.querySelectorAll('#pipLayer .pip')].map((t) => { const r = t.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]; }), vw: innerWidth, vh: innerHeight }));
  const inside = fsInfo.tiles.length === 3 && fsInfo.tiles.every(([l, t, w, h]) => l >= 0 && t >= 0 && l + w <= fsInfo.vw && t + h <= fsInfo.vh);
  const overlap = fsInfo.tiles.some((a, i) => fsInfo.tiles.some((b, j) => j > i && a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3]));
  console.log(inside && !overlap ? '✓' : '✗', `${vw}x${vh}`, 'tam ekran kutucuklar'.padEnd(22), JSON.stringify(fsInfo.tiles), fsInfo.real ? 'gerçek tam ekran' : 'sahte tam ekran');
  if (!(inside && !overlap)) fails++;
  rows.push({ viewport: `${vw}x${vh}`, state: 'tam ekran kutucuk yerleşimi', pass: inside && !overlap, tiles: fsInfo.tiles, mode: fsInfo.real ? 'real' : 'pseudo' });
  await check(p, '09-fullscreen-cams', vw, vh, 'tam ekran + kameralar');
  // Kontroller: oynarken gizlenir, hareketle geri gelir, en üstte ve tıklanabilir
  const ctl = () => p.evaluate(() => {
    const t = document.querySelector('#transport'), b = document.querySelector('#playBtn'), r = b.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    const tr = t.getBoundingClientRect();
    return { idle: document.querySelector('#player').classList.contains('idle'), opacity: +getComputedStyle(t).opacity, onTop: !!hit && b.contains(hit), inView: tr.left >= 0 && tr.right <= innerWidth && tr.bottom <= innerHeight && tr.top >= 0 };
  });
  await sleep(3800);
  const hiddenState = await ctl();
  if (mobile) await p.touchscreen.tap(Math.round(vw / 2), Math.round(vh / 2)); else { await p.mouse.move(vw / 2, vh / 2); await p.mouse.move(vw / 2 + 20, vh / 2 + 10); }
  await sleep(500);
  const woke = await ctl();
  const ctlPass = hiddenState.idle && woke.opacity === 1 && woke.onTop && woke.inView && !woke.idle;
  if (!ctlPass) fails++;
  rows.push({ viewport: `${vw}x${vh}`, state: 'tam ekran kontrolleri geri geliyor', pass: ctlPass, hiddenState, woke });
  console.log(ctlPass ? '✓' : '✗', `${vw}x${vh}`, 'kontroller: gizlendi→hareketle göründü, en üstte', JSON.stringify({ hiddenState, woke }));
  // Duraklatılınca kontroller sürekli görünür
  await p.click('#playBtn');
  await sleep(4200);
  const paused = await ctl();
  const pausePass = !paused.idle && paused.opacity === 1 && paused.onTop;
  if (!pausePass) fails++;
  rows.push({ viewport: `${vw}x${vh}`, state: 'duraklatınca kontroller sabit', pass: pausePass, paused });
  console.log(pausePass ? '✓' : '✗', `${vw}x${vh}`, 'duraklatınca kontroller görünür kaldı');
  await p.click('#playBtn');
  // Tam ekranda emoji
  await p.click('#emojiBtn');
  await p.waitForSelector('#emojiPop:not([hidden])');
  await p.click('#emojiPop [data-emoji="🔥"]');
  await p.click('#emojiPop [data-emoji="😂"]');
  await sleep(350);
  const emo = await p.evaluate(() => { const pop = document.querySelector('#emojiPop').getBoundingClientRect(); const fl = [...document.querySelectorAll('#reactions .float-emoji')].map((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.left >= 0 && r.right <= innerWidth && getComputedStyle(e).visibility !== 'hidden'; }); return { pop: pop.left >= 0 && pop.right <= innerWidth && pop.top >= 0 && pop.bottom <= innerHeight, floats: fl.length, visible: fl.every(Boolean) }; });
  const emoPass = emo.pop && emo.floats >= 2 && emo.visible;
  if (!emoPass) fails++;
  rows.push({ viewport: `${vw}x${vh}`, state: 'tam ekranda emoji', pass: emoPass, emo });
  console.log(emoPass ? '✓' : '✗', `${vw}x${vh}`, 'tam ekranda emoji paneli + uçan tepkiler', JSON.stringify(emo));
  await check(p, '09b-fullscreen-emoji', vw, vh, 'tam ekran + emoji + kontroller');
  await p.keyboard.press('Escape'); // paneli kapat
  await p.keyboard.press('v');
  await sleep(300);
  const hidden = await p.evaluate(() => getComputedStyle(document.querySelector('#pipLayer')).display === 'none');
  console.log(hidden ? '✓' : '✗', `${vw}x${vh}`, 'V ile kameralar gizlendi');
  if (!hidden) fails++;
  await check(p, '10-fullscreen-hidden', vw, vh, 'tam ekran, kameralar gizli');
  await p.keyboard.press('v');
  // Sahte tam ekran (iOS yolu)
  await p.evaluate(() => window.CineSync.exitFullscreen());
  await sleep(400);
  await p.evaluate(() => { window.CineSync.S.pseudoFs = true; document.body.classList.add('pseudo-fs'); document.querySelector('#player').classList.add('is-fs'); window.CineSync.S.fs = true; window.CineSync.S.pip.layout(); });
  await sleep(500);
  await check(p, '11-pseudo-fullscreen', vw, vh, 'sahte tam ekran (iOS)');
  const pctl = await p.evaluate(() => { const b = document.querySelector('#playBtn'), r = b.getBoundingClientRect(); const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return !!hit && b.contains(hit); });
  if (!pctl) fails++;
  rows.push({ viewport: `${vw}x${vh}`, state: 'sahte tam ekranda kontroller tıklanabilir', pass: pctl });
  console.log(pctl ? '✓' : '✗', `${vw}x${vh}`, 'sahte tam ekranda oynat düğmesi en üstte');
  await p.keyboard.press('Escape');
  await sleep(300);
  const exited = await p.evaluate(() => !document.querySelector('#player').classList.contains('is-fs'));
  if (!exited) fails++;
  console.log(exited ? '✓' : '✗', `${vw}x${vh}`, 'Esc ile sahte tam ekrandan çıkıldı');
  // iframe kaynağı (web sitesi) tam ekranda: kontroller gizlense bile hareketle geri gelir
  await p.evaluate(() => { const s = window.CineSync; s.S.room.setMedia({ src: { kind: 'web', provider: 'Internet Archive', url: 'https://archive.org/details/feature_films', embedUrl: 'https://archive.org/details/feature_films' }, playing: false, time: 0, screen: null }, 'test'); });
  await sleep(1500);
  await p.click('#fsFloatBtn');
  await sleep(3800);
  const fIdle = await p.evaluate(() => document.querySelector('#player').classList.contains('idle'));
  if (mobile) await p.touchscreen.tap(Math.round(vw / 2), Math.round(vh / 2)); else { await p.mouse.move(vw / 2 - 30, vh / 2); await p.mouse.move(vw / 2, vh / 2 + 5); }
  await sleep(400);
  const fBar = await p.evaluate(() => { const b = document.querySelector('#fsExitBtn'), r = b.getBoundingClientRect(); const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return { idle: document.querySelector('#player').classList.contains('idle'), onTop: !!hit && b.contains(hit), op: +getComputedStyle(document.querySelector('.fs-bar')).opacity }; });
  const fPass = fIdle && !fBar.idle && fBar.onTop && fBar.op === 1;
  if (!fPass) fails++;
  rows.push({ viewport: `${vw}x${vh}`, state: 'iframe tam ekran: üst çubuk geri geliyor', pass: fPass, fIdle, fBar });
  console.log(fPass ? '✓' : '✗', `${vw}x${vh}`, 'iframe üzerinde tam ekran: çubuk hareketle geri geldi', JSON.stringify({ fIdle, ...fBar }));
  await check(p, '12-fullscreen-iframe', vw, vh, 'tam ekran (iframe kaynak)');
  await p.evaluate(() => window.CineSync.exitFullscreen());
  await sleep(300);
  await p.evaluate(() => { window.__testPips = null; });
  await clickCam(p);
  await menu(p, 'leave');
  await helper.click('#leaveBtn').catch(() => {});
  await p.context().close();
}
await browser.close();
fs.writeFileSync('tests/responsive-results.json', JSON.stringify({ rows, errors }, null, 2));
console.log(`\nKonsol hataları (${errors.length}):`, errors.slice(0, 10));
console.log(`\n${rows.filter((r) => r.pass).length}/${rows.length} taşma/yerleşim kontrolü geçti; toplam hata: ${fails}`);
process.exit(fails || errors.length ? 1 : 0);
