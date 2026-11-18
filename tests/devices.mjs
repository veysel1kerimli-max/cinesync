// Çapraz tarayıcı + cihaz testi: ana sayfa gerçekten kayıyor mu, oda ekrana tam oturuyor mu?
// Motorlar: Chromium (Chrome/Android/Edge), WebKit (iOS/macOS Safari yaklaşımı), Firefox.
// Kullanım: node tests/devices.mjs [chromium|webkit|firefox] [http://localhost:8080/]
import { chromium, webkit, firefox } from '../node_modules/playwright-core/index.mjs';
import fs from 'node:fs';
import { openLink, BADGE_SCRIPT, badgeOverlap, isMobileUI } from './ui-helpers.mjs';
const ENGINE = process.argv[2] || 'chromium';
const BASE = process.argv[3] || 'http://localhost:8080/';
const OUT = 'tests/shots/devices'; fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// [ad, genişlik, yükseklik, dokunmatik]
const DEVICES = [
  ['iPhone SE 1', 320, 568, true], ['iPhone SE', 375, 667, true], ['Android', 360, 740, true], ['iPhone 14', 390, 844, true], ['Pixel 7', 412, 915, true], ['iPhone Pro Max', 430, 932, true],
  ['iPhone SE yatay', 568, 320, true], ['iPhone 8 yatay', 667, 375, true], ['iPhone 14 yatay', 844, 390, true], ['Pro Max yatay', 932, 430, true],
  ['iPad mini dikey', 768, 1024, true], ['iPad Air dikey', 820, 1180, true], ['iPad Pro dikey', 1024, 1366, true],
  ['iPad mini yatay', 1024, 768, true], ['iPad Air yatay', 1180, 820, true], ['iPad Pro yatay', 1366, 1024, true],
  ['Laptop küçük', 1366, 768, false], ['Laptop', 1280, 800, false], ['MacBook', 1440, 900, false], ['Masaüstü FHD', 1920, 1080, false],
];
const only = process.env.DEV ? process.env.DEV.split(',') : null;
const launchers = { chromium: () => chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] }), webkit: () => webkit.launch(), firefox: () => firefox.launch() };
const browser = await launchers[ENGINE]();
const rows = []; let fails = 0; const errors = [];
const log = (pass, dev, what, extra = '') => { if (!pass) fails++; rows.push({ engine: ENGINE, device: dev, what, pass, extra }); console.log(pass ? '✓' : '✗', ENGINE.padEnd(8), dev.padEnd(26), what, extra); };

for (const [name, vw, vh, touch] of DEVICES) {
  const dev = `${name} ${vw}x${vh}`;
  if (only && !only.includes(`${vw}x${vh}`)) continue;
  const opts = { viewport: { width: vw, height: vh }, hasTouch: touch, deviceScaleFactor: 1 };
  if (ENGINE !== 'firefox') opts.isMobile = touch && Math.min(vw, vh) < 600;
  const ctx = await browser.newContext(opts);
  await ctx.addInitScript(BADGE_SCRIPT); // canlı sitedeki Netlify rozetini taklit et
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(`${dev} PAGEERROR ${e.message}`));
  try {
    await p.goto(BASE); await p.waitForSelector('#createBtn'); await sleep(400);
    // 1) Ana sayfa kaydırma — gerçek giriş olayları
    const info = await p.evaluate(() => { const de = document.documentElement, b = document.body, cs = (e) => getComputedStyle(e); return { maxY: de.scrollHeight - innerHeight, scroller: document.scrollingElement.tagName, bodyOY: cs(b).overflowY, htmlOY: cs(de).overflowY, touchAction: cs(b).touchAction + '/' + cs(de).touchAction }; });
    const structOk = info.maxY > 200 && info.scroller === 'HTML' && info.bodyOY === 'visible' && !/hidden|clip/.test(info.htmlOY) && !/none/.test(info.touchAction);
    log(structOk, dev, 'ana sayfa: belge kaydırılabilir yapı', JSON.stringify(info));
    let y = 0, method;
    await p.mouse.move(vw / 2, vh / 2).catch(() => {});
    if (touch && ENGINE === 'chromium') {
      method = 'parmak (touch)';
      const cdp = await ctx.newCDPSession(p);
      const swipe = async () => { const x = Math.round(vw / 2), y0 = Math.round(vh * 0.8), y1 = Math.round(vh * 0.2);
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: y0 }] });
        for (let k = 1; k <= 10; k++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: Math.round(y0 + (y1 - y0) * k / 10) }] }); await sleep(16); }
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); };
      for (let i = 0; i < 80 && y < info.maxY - 2; i++) { await swipe(); await sleep(100); y = await p.evaluate(() => scrollY); }
    } else if (ENGINE === 'webkit' && opts.isMobile) {
      method = 'klavye (PageDown; mobil WebKit tekerlek desteklemiyor)';
      await p.click('.hero h1').catch(() => {});
      for (let i = 0; i < 80 && y < info.maxY - 2; i++) { await p.keyboard.press('PageDown'); await sleep(120); y = await p.evaluate(() => scrollY); }
    } else {
      method = 'tekerlek (wheel)';
      for (let i = 0; i < 80 && y < info.maxY - 2; i++) { await p.mouse.wheel(0, 600); await sleep(70); y = await p.evaluate(() => scrollY); }
    }
    await sleep(500); y = await p.evaluate(() => scrollY);
    const foot = await p.evaluate(() => { const r = document.querySelector('.site-foot').getBoundingClientRect(); return r.top < innerHeight && r.bottom <= innerHeight + 2; });
    log(y >= info.maxY - 2 && foot, dev, `ana sayfa ${method} ile en alta`, `scrollY=${Math.round(y)}/${info.maxY}${foot ? ' alt bilgi görünüyor' : ' ALT BİLGİ YOK'}`);
    await p.screenshot({ path: `${OUT}/${ENGINE}-${vw}x${vh}-landing-bottom.png` });
    { const bo = await badgeOverlap(p); log(bo.length === 0, dev, 'ana sayfa: rozet altında düğme/link yok', bo.join(' ')); }
    // Klavye ile de (Home tuşu başa döner)
    await p.keyboard.press('Home').catch(() => {}); await sleep(600);
    const back = await p.evaluate(() => scrollY);
    log(back < 5, dev, 'ana sayfa Home tuşu ile başa döndü', `scrollY=${Math.round(back)}`);
    const hx = await p.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    log(hx <= 0, dev, 'ana sayfa yatay taşma yok', `fark=${hx}`);
    await p.evaluate(() => { document.documentElement.style.scrollBehavior = 'auto'; scrollTo(0, 0); });
    // 2) Oda: ekrana tam oturma
    await p.fill('#nameInput', 'Veysel'); await p.click('#createBtn');
    await p.waitForSelector('#roomView:not([hidden])'); await sleep(600);
    const fit = async (label, W, H) => {
      const f = await p.evaluate(() => {
        const ih = innerHeight, iw = innerWidth, de = document.documentElement;
        const box = (sel) => { const e = document.querySelector(sel); if (!e || e.offsetParent === null) return null; const r = e.getBoundingClientRect(); if (!r.height) return null; return [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)]; };
        const parts = { topbar: box('.topbar'), address: box('#addressBar'), stage: box('#stage'), transport: box('#transport'), tabs: box('.tabs'), chatForm: box('#chatForm'), mbar: box('#mbar') };
        const inside = Object.values(parts).filter(Boolean).every(([l, t, r, b]) => t >= -1 && b <= ih + 1 && l >= -1 && r <= iw + 1);
        return { pageScrollY: de.scrollHeight - ih, pageScrollX: de.scrollWidth - iw, inside, stageH: parts.stage ? parts.stage[3] - parts.stage[1] : 0, missing: Object.keys(parts).filter((k) => !parts[k]) };
      });
      const minStage = H <= 430 && W > H ? 100 : 110; // alçak yatay telefonda 100px (+ tam ekran düğmesi)
      const pass = f.pageScrollY <= 1 && f.pageScrollX <= 0 && f.inside && f.stageH >= minStage;
      log(pass, dev, `oda ekrana oturuyor (${label} ${W}x${H})`, JSON.stringify(f));
      const bo = await badgeOverlap(p);
      log(bo.length === 0, dev, `oda: rozet altında düğme yok (${label})`, bo.join(' '));
      await p.screenshot({ path: `${OUT}/${ENGINE}-${vw}x${vh}-room-${label.replace(/[^a-z0-9]+/gi, '_')}.png` });
    };
    await fit('boş', vw, vh);
    await openLink(p, 'https://archive.org/download/BigBuckBunny_124/Content/big_buck_bunny_720p_surround.mp4'); await sleep(2500);
    if (await isMobileUI(p)) {
      const mb = await p.evaluate(() => { const r = document.querySelector('#mbar').getBoundingClientRect(); return { n: [...document.querySelectorAll('#mbar .mb')].filter((b) => b.offsetParent).length, bottom: Math.round(r.bottom), h: innerHeight, topBtns: [...document.querySelectorAll('.topbar button, .topbar .pill')].filter((b) => b.offsetParent && b.getBoundingClientRect().width).length }; });
      log(mb.n === 5 && mb.bottom <= mb.h && mb.topBtns <= 3, dev, 'mobil: sade üst çubuk + 5 düğmeli alt çubuk', JSON.stringify(mb));
    }
    await fit('video', vw, vh);
    // Tarayıcı çubuğu açılıp kapanınca (yükseklik ~%86) ve döndürünce
    const h2 = Math.round(vh * 0.86); await p.setViewportSize({ width: vw, height: h2 }); await sleep(500); await fit('adres çubuğu', vw, h2);
    if (touch) { await p.setViewportSize({ width: vh, height: vw }); await sleep(600); await fit('döndürüldü', vh, vw); }
    // Odadayken sayfa tekerlek/parmakla kaymamalı
    if (ENGINE === 'webkit' && opts.isMobile) { await p.keyboard.press('PageDown').catch(() => {}); } else await p.mouse.wheel(0, 800).catch(() => {});
    await sleep(300);
    const sy = await p.evaluate(() => scrollY);
    log(sy === 0, dev, 'odada sayfa kaymıyor', `scrollY=${sy}`);
  } catch (e) { log(false, dev, 'HATA', e.message.split('\n')[0]); }
  await ctx.close();
}
await browser.close();
fs.writeFileSync(`tests/devices-${ENGINE}.json`, JSON.stringify({ engine: ENGINE, fails, errors, rows }, null, 1));
console.log(`\n${ENGINE}: ${rows.length - fails}/${rows.length} geçti` + (errors.length ? ` · sayfa hataları: ${errors.length}\n` + errors.slice(0, 5).join('\n') : ''));
process.exit(fails ? 1 : 0);
