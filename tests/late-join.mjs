// Sonradan katılan üye mevcut videoyu, konumu ve sohbet geçmişini alıyor mu?
import { chromium } from '../node_modules/playwright-core/index.mjs';
const BASE = process.argv[2] || 'http://localhost:8080/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
const A = await (await b.newContext()).newPage();
await A.goto(BASE); await A.fill('#nameInput', 'Veysel'); await A.click('#createBtn');
const code = await A.textContent('#roomCodeText');
await A.fill('#urlInput', 'https://media.w3.org/2010/05/sintel/trailer.mp4'); await A.press('#urlInput', 'Enter');
await A.fill('#chatInput', 'Erken mesaj'); await A.press('#chatInput', 'Enter');
await sleep(12000);
const C = await (await b.newContext()).newPage();
await C.goto(BASE + '#room=' + code); await C.fill('#nameInput', 'Geç Gelen'); await C.click('#joinForm button[type=submit]');
let res = null;
for (let i = 0; i < 60 && !res; i++) {
  await sleep(500);
  res = await C.evaluate(() => { const v = document.querySelector('#stageVideo'); return (!v.hidden && v.currentTime > 5 && document.querySelector('#chatList').innerText.includes('Erken mesaj')) ? { t: v.currentTime } : null; });
}
const tA = await A.evaluate(() => document.querySelector('#stageVideo').currentTime);
console.log(res ? `✓ geç katılan video+sohbeti aldı (A=${tA.toFixed(1)} C=${res.t.toFixed(1)})` : '✗ geç katılım başarısız');
await b.close(); process.exit(res ? 0 : 1);
