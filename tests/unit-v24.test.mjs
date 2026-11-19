// v2.4 birim testleri (tarayıcı gerekmez): altyazı kaydırma, sıra doğrulama, QR üretimi, göreli zaman.
import assert from 'node:assert/strict';
import { shiftVtt, toVtt } from '../js/stage.js';
import { Room } from '../js/room.js';
import { qrMatrix, qrSvg } from '../js/qr.js';
import { timeAgo } from '../js/ui/dom.js';
let n = 0; const t = (name, fn) => { fn(); n++; console.log('✓', name); };

t('SRT → VTT → +1,5 sn kaydırma', () => {
  const v = toVtt('1\n00:00:01,000 --> 00:00:03,250\nMerhaba\n\n2\n00:59:59,900 --> 01:00:00,500\nSon\n');
  const s = shiftVtt(v, 1.5);
  assert.match(s, /00:00:02\.500 --> 00:00:04\.750/);
  assert.match(s, /01:00:01\.400 --> 01:00:02\.000/);
});
t('negatif kaydırma 0 altına düşmez', () => {
  const s = shiftVtt('WEBVTT\n\n00:01.000 --> 00:02.000\nA\n', -5);
  assert.match(s, /00:00:00\.000 --> 00:00:00\.000/);
});
t('kaydırma 0 ise metin değişmez', () => { const v = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nA\n'; assert.equal(shiftVtt(v, 0), v); });
t('sıra doğrulama: geçersiz linkler ve fazla öğeler atılır', () => {
  const items = [{ id: 'a', url: 'https://x.com/a.mp4', title: 'A' }, { id: 'b', url: 'javascript:alert(1)' }, { id: 'c', url: 'ftp://x' }, ...Array.from({ length: 60 }, (_, i) => ({ id: 'z' + i, url: `https://x.com/${i}.mp4` }))];
  const q = Room.cleanQueue({ ver: 3, byId: 'u1', items, cur: 'b', auto: false });
  assert.equal(q.items[0].url, 'https://x.com/a.mp4');
  assert.ok(q.items.every((it) => it.url.startsWith('https://')));
  assert.ok(q.items.length <= 50);
  assert.equal(q.cur, null, 'listede olmayan "cur" temizlenir');
  assert.equal(q.auto, false);
});
t('sıra doğrulama: uzun başlık kısaltılır', () => {
  const q = Room.cleanQueue({ items: [{ url: 'https://a.b/c.mp4', title: 'x'.repeat(500) }] });
  assert.equal(q.items[0].title.length, 120);
});
t('QR kod üretimi (davet linki)', () => {
  const m = qrMatrix('https://cinesync-veysel.netlify.app/#room=film-gecesi');
  assert.ok(m.length >= 25 && m.length % 4 === 1, 'QR boyutu 4k+17');
  assert.ok(m[0][0] && m[0][6] && m[6][0], 'konum işaretleri');
  assert.match(qrSvg('test'), /^<svg[^>]+viewBox="0 0 25 25"/);
});
t('göreli zaman', () => {
  const now = Date.now();
  assert.equal(timeAgo(now - 10e3, now), 'az önce');
  assert.equal(timeAgo(now - 5 * 60e3, now), '5 dk önce');
  assert.equal(timeAgo(now - 3 * 3600e3, now), '3 sa önce');
  assert.equal(timeAgo(now - 2 * 86400e3, now), '2 gün önce');
});
console.log(`\n${n} birim testi geçti`);
