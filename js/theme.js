// CineSync — tema (koyu / açık / sistem) ve vurgu rengi. Tercih cihazda saklanır.

export const ACCENTS = [
  { id: 'mor', label: 'Mor', c: '#6d5dfc', grad: '#b05cff' },
  { id: 'mavi', label: 'Mavi', c: '#2f7cf6', grad: '#22b8f0' },
  { id: 'turkuaz', label: 'Turkuaz', c: '#0e9fb1', grad: '#2dd4bf' },
  { id: 'yesil', label: 'Yeşil', c: '#16a34a', grad: '#84cc16' },
  { id: 'turuncu', label: 'Turuncu', c: '#ea6a0a', grad: '#f59e0b' },
  { id: 'pembe', label: 'Pembe', c: '#e0458e', grad: '#f472b6' },
];

const get = (k, d) => { try { return localStorage.getItem('cinesync:' + k) || d; } catch { return d; } };
const set = (k, v) => { try { localStorage.setItem('cinesync:' + k, v); } catch {} };

function hexToRgb(h) { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
function mix(hex, toward, amt) {
  const a = hexToRgb(hex), b = toward === 'white' ? [255, 255, 255] : [0, 0, 0];
  return '#' + a.map((v, i) => Math.round(v + (b[i] - v) * amt).toString(16).padStart(2, '0')).join('');
}
const rgba = (hex, al) => { const [r, g, b] = hexToRgb(hex); return `rgba(${r}, ${g}, ${b}, ${al})`; };

const mq = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: light)') : null;
const listeners = new Set();

export function themePref() { return get('theme', 'dark'); }
export function accentPref() { return ACCENTS.some((a) => a.id === get('accent', '')) ? get('accent', '') : 'mor'; }
export function effectiveTheme(pref = themePref()) { return pref === 'system' ? (mq && mq.matches ? 'light' : 'dark') : pref === 'light' ? 'light' : 'dark'; }

/** Tema ve vurgu rengini belgeye uygular (CSS değişkenleri) */
export function applyTheme() {
  const root = document.documentElement;
  const theme = effectiveTheme();
  const acc = ACCENTS.find((a) => a.id === accentPref()) || ACCENTS[0];
  root.dataset.theme = theme;
  root.dataset.accent = acc.id;
  const st = root.style;
  st.setProperty('--accent', acc.c);
  st.setProperty('--accent2', theme === 'light' ? mix(acc.c, 'black', 0.12) : mix(acc.c, 'white', 0.22));
  st.setProperty('--accent-soft', rgba(acc.c, theme === 'light' ? 0.12 : 0.16));
  st.setProperty('--accent-line', rgba(acc.c, 0.45));
  st.setProperty('--accent-text', theme === 'light' ? mix(acc.c, 'black', 0.28) : mix(acc.c, 'white', 0.68));
  st.setProperty('--accent-grad', acc.grad);
  const meta = document.querySelector('meta[name=theme-color]');
  if (meta) meta.content = theme === 'light' ? '#f5f7fb' : '#0b0f1a';
  listeners.forEach((fn) => { try { fn(theme); } catch {} });
  return theme;
}

export function setThemePref(v) { set('theme', ['dark', 'light', 'system'].includes(v) ? v : 'dark'); return applyTheme(); }
export function setAccentPref(id) { set('accent', id); return applyTheme(); }
export function onThemeChange(fn) { listeners.add(fn); }
/** Koyu ↔ açık hızlı geçiş (sistem tercihi seçiliyse onun tersine sabitlenir) */
export function toggleTheme() { return setThemePref(effectiveTheme() === 'light' ? 'dark' : 'light'); }

mq?.addEventListener?.('change', () => { if (themePref() === 'system') applyTheme(); });
