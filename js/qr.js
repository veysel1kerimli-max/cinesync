// Davet linki için QR kod: tamamen cihazda üretilir (harici servis yok). SVG olarak çizilir.
import qrcode from './vendor/qrcode.js';

/** Metni QR kod SVG'sine çevirir. margin: sessiz bölge (modül cinsinden) */
export function qrSvg(text, { margin = 2, ecc = 'M', dark = '#0b0f1a', light = '#ffffff' } = {}) {
  const q = qrcode(0, ecc);
  q.addData(String(text));
  q.make();
  const n = q.getModuleCount();
  const size = n + margin * 2;
  let d = '';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (!q.isDark(r, c)) continue;
      let w = 1; while (c + w < n && q.isDark(r, c + w)) w++;
      d += `M${c + margin} ${r + margin}h${w}v1h-${w}z`;
      c += w - 1;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" role="presentation"><rect width="${size}" height="${size}" fill="${light}"/><path d="${d}" fill="${dark}"/></svg>`;
}

/** Testler için: modül matrisini döndürür */
export function qrMatrix(text, ecc = 'M') {
  const q = qrcode(0, ecc); q.addData(String(text)); q.make();
  const n = q.getModuleCount();
  return Array.from({ length: n }, (_, r) => Array.from({ length: n }, (_, c) => q.isDark(r, c)));
}
