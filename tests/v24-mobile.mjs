// v2.4 mobil/tablet/masaüstü kontrolleri: yeni paneller (Sıra, davet QR, geri sayım, tepkiler, açık tema)
// her boyutta yatay taşma yapmamalı ve görünür alanda kalmalı.
// Kullanım: node tests/v24-mobile.mjs [http://localhost:8080/] [chromium|firefox|webkit]
import { chromium, firefox, webkit } from '../node_modules/playwright-core/index.mjs';
import fs from 'node:fs';
import { isMobileUI, sheet, showTab } from './ui-helpers.mjs';
const BASE = process.argv[2] || 'http://localhost:8080/';
const ENGINE = process.argv[3] || 'chromium';
const OUT = 'tests/shots/v24'; fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const launcher = { chromium, firefox, webkit }[ENGINE];
const browser = await launcher.launch(ENGINE === 'chromium' ? { executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] } : {});
const ALLS = [[320, 568, true], [390, 844, true], [844, 390, true], [768, 1024, true], [1024, 768, true], [1366, 768, false], [1920, 1080, false]];
const SIZES = process.env.VP ? ALLS.filter(([w, h]) => process.env.VP.split(',').includes(`${w}x${h}`)) : ALLS;
let pass = 0, fail = 0; const errors = [];
const ok = (name, cond, extra = '') => { cond ? pass++ : fail++; console.log(`${cond ? '✓' : '✗'} ${name}${extra ? ' — ' + extra : ''}`); };
const overflow = (p) => p.evaluate(() => {
  const vw = document.documentElement.clientWidth;
  const bad = [];
  for (const el of document.querySelectorAll('#roomView *, dialog[open] *')) {
    if (!el.getClientRects().length || el.closest('[hidden], .quickbar, .chat-list .msg-acts, .q-t, .seek-row, .reacts')) continue;
    const r = el.getBoundingClientRect();
    if (r.width && (r.right > vw + 1 || r.left < -1)) bad.push(`${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}.${String(el.className).split(' ')[0]} ${Math.round(r.left)}..${Math.round(r.right)}`);
  }
  return { sw: document.documentElement.scrollWidth - vw, bad: bad.slice(0, 5) };
});
const host = await browser.newPage({ viewport: { width: 1200, height: 800 } });
await host.goto(BASE); await host.fill('#nameInput', 'Ayşe'); await host.click('#createBtn'); await host.waitForSelector('#roomView:not([hidden])');
const code = await host.textContent('#roomCodeText');
await host.evaluate(() => { window.CineSync.addToQueue('https://archive.org/download/BigBuckBunny_124/Content/big_buck_bunny_720p_surround.mp4'); window.CineSync.addToQueue('https://archive.org/download/ElephantsDream/ed_1024_512kb.mp4'); });
await host.fill('#chatInput', 'Hoş geldin @Veysel 🎬'); await host.press('#chatInput', 'Enter');

for (const [w, h, touch] of SIZES) {
  const tag = `${w}x${h}`;
  const opts = { viewport: { width: w, height: h }, hasTouch: touch };
  if (ENGINE !== 'firefox') opts.isMobile = touch && Math.min(w, h) < 600;
  const ctx = await browser.newContext(opts);
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(`${tag}: ${e.message}`));
  await p.goto(BASE); await p.fill('#nameInput', 'Veysel');
  const lo = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ok(`${tag} ana sayfa (Yeni rozeti) taşma yok`, lo <= 0, String(lo));
  await p.fill('#codeInput', code); await p.click('#joinForm button[type=submit]');
  await p.waitForSelector('#roomView:not([hidden])');
  await p.waitForFunction(() => window.CineSync.S.room?.queue?.items.length === 2, null, { timeout: 20000 }).catch(() => {});
  await sleep(500);
  const mobile = await isMobileUI(p);
  // Sıra paneli
  await showTab(p, 'queue');
  await sleep(300);
  ok(`${tag} Sıra paneli görünür ve 2 öğe`, (await p.isVisible('#queueList')) && (await p.$$('#queueList li')).length === 2);
  let o = await overflow(p); ok(`${tag} Sıra paneli taşma yok`, o.sw <= 0 && !o.bad.length, JSON.stringify(o));
  await p.screenshot({ path: `${OUT}/${tag}-queue.png` });
  // Sohbet: tepki çipleri
  await showTab(p, 'chat'); await sleep(300);
  o = await overflow(p); ok(`${tag} sohbet taşma yok`, o.sw <= 0 && !o.bad.length, JSON.stringify(o));
  // Davet
  if (mobile) await sheet(p, 'invite'); else await p.click('#inviteBtn');
  await p.waitForSelector('#inviteDialog[open]');
  const qr = await p.evaluate(() => { const r = document.querySelector('#qrBox').getBoundingClientRect(); return { w: r.width, inView: r.top >= 0 && r.bottom <= innerHeight + 1 }; });
  o = await overflow(p); ok(`${tag} davet (QR) taşma yok ve QR görünür`, o.sw <= 0 && !o.bad.length && qr.w > 100, JSON.stringify({ o, qr }));
  await p.screenshot({ path: `${OUT}/${tag}-invite.png` });
  await p.keyboard.press('Escape');
  // Mobil "Daha fazla" sayfası: yeni düğmeler
  if (mobile) {
    await p.click('#mMore'); await p.waitForSelector('#moreSheet[open]');
    const sh = await p.evaluate(() => { const d = document.querySelector('#moreSheet'); const r = d.getBoundingClientRect(); return { ok: !!d.querySelector('[data-sheet=queue]') && !!d.querySelector('[data-sheet=countdown]') && !!d.querySelector('[data-sheet=theme]'), fits: r.bottom <= innerHeight + 1 && d.scrollHeight >= d.clientHeight }; });
    o = await overflow(p); ok(`${tag} "Daha fazla" yeni düğmeler + taşma yok`, sh.ok && o.sw <= 0 && !o.bad.length, JSON.stringify({ sh, o }));
    await p.screenshot({ path: `${OUT}/${tag}-sheet.png` });
    await p.click('#moreSheet [data-sheet=theme]');
  } else {
    await p.click('#menuBtn'); await p.click('[data-menu=theme]');
  }
  await sleep(400);
  ok(`${tag} açık tema`, await p.evaluate(() => document.documentElement.dataset.theme === 'light'));
  o = await overflow(p); ok(`${tag} açık tema taşma yok`, o.sw <= 0 && !o.bad.length, JSON.stringify(o));
  await p.screenshot({ path: `${OUT}/${tag}-light.png` });
  // Geri sayım (oda sahibi başlatır)
  await host.evaluate(() => window.CineSync.startCountdown());
  ok(`${tag} geri sayım görünür`, !!(await p.waitForSelector('#countdown:not([hidden])', { timeout: 6000 }).catch(() => null)));
  const cd = await p.evaluate(() => { const r = document.querySelector('.cd-ring').getBoundingClientRect(); const s = document.querySelector('#stage').getBoundingClientRect(); return r.top >= s.top - 1 && r.bottom <= s.bottom + 1; });
  ok(`${tag} geri sayım sahneye sığıyor`, cd);
  await p.screenshot({ path: `${OUT}/${tag}-countdown.png` });
  await p.waitForSelector('#countdown[hidden]', { state: 'attached', timeout: 8000 }).catch(() => {});
  await p.evaluate(() => localStorage.setItem('cinesync:theme', 'dark'));
  await ctx.close();
}
ok('sayfa hatası yok', !errors.length, errors.slice(0, 3).join(' | '));
console.log(`\n${pass}/${pass + fail} kontrol geçti (${ENGINE})`);
await browser.close();
process.exit(fail ? 1 : 0);
