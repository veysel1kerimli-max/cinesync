// Testler için ortak yardımcılar: mobil sade arayüz (alt çubuk + "Daha fazla") ile masaüstü arayüzü aynı adımlarla sürmek.
export const MOBILE_MQ = '(max-width: 760px), (orientation: landscape) and (max-height: 520px)';
export const isMobileUI = (p) => p.evaluate((mq) => matchMedia(mq).matches, MOBILE_MQ);

export async function openSheet(p) {
  if (await p.isVisible('#moreSheet[open]')) return;
  await p.click('#mMore');
  await p.waitForSelector('#moreSheet[open]');
}
export async function openLink(p, url) {
  if (await p.isVisible('#urlInput')) { await p.fill('#urlInput', url); await p.press('#urlInput', 'Enter'); return; }
  await openSheet(p);
  await p.fill('#sheetUrl', url); await p.press('#sheetUrl', 'Enter');
}
export async function sheet(p, act) { await openSheet(p); await p.click(`#moreSheet [data-sheet=${act}]`); }
export async function menu(p, act) {
  if (await isMobileUI(p)) return sheet(p, act);
  await p.click('#menuBtn'); await p.click(`[data-menu=${act}]`);
}
export async function clickCam(p) { await p.click((await p.isVisible('#camBtn')) ? '#camBtn' : '#mCam'); }
export async function clickMic(p) { await p.click((await p.isVisible('#micBtn')) ? '#micBtn' : '#mMic'); }
export async function openCatalogUI(p) { if (await p.isVisible('#catalogBtn')) await p.click('#catalogBtn'); else await sheet(p, 'catalog'); await p.waitForSelector('#catalogDialog[open]'); }
export async function showTab(p, tab) {
  if (await p.isVisible(`.tab[data-tab=${tab}]`)) return p.click(`.tab[data-tab=${tab}]`);
  if (tab === 'chat') return p.click('#mChat');
  return sheet(p, tab);
}

// Canlı sitedeki Netlify rozetinin birebir kopyası (sağ altta sabit iframe, 192×64, kırpma yolu ile 176×48 görünür)
export const BADGE_SCRIPT = `(() => { if (window !== window.top) return; const add = () => { if (document.getElementById('nl-badge-frame')) return; const f = document.createElement('iframe'); f.id = 'nl-badge-frame'; f.setAttribute('style', 'position: fixed; bottom: 0px; right: 0px; border: 0px; margin: 0px; padding: 0px; background: transparent; z-index: 2147483645; width: 192px; height: 64px; clip-path: path("M 3 3 H 179 V 51 H 3 Z");'); document.body.appendChild(f); }; if (document.body) add(); else document.addEventListener('DOMContentLoaded', add); })();`;

/** Rozetin görünen alanının altında tıklanabilir bir öğe var mı? (açık diyaloglar üst katmanda olduğu için hariç) */
export function badgeOverlap(p) {
  return p.evaluate(() => {
    if (document.fullscreenElement || !document.getElementById('nl-badge-frame')) return [];
    const vw = innerWidth, vh = innerHeight;
    const z = { l: vw - 189, r: vw - 13, t: vh - 61, b: vh - 13 };
    const bad = [];
    for (const el of document.querySelectorAll('button, a[href], input, select, textarea, [role=tab]')) {
      if (el.closest('dialog[open], [hidden]')) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none' || +cs.opacity === 0 || cs.pointerEvents === 'none') continue;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      if (r.right > z.l && r.left < z.r && r.bottom > z.t && r.top < z.b) bad.push(`${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${el.className && typeof el.className === 'string' ? '.' + el.className.split(' ')[0] : ''}`);
    }
    return bad;
  });
}
