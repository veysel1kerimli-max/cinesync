// Küçük DOM yardımcıları: seçiciler, bildirimler, biçimlendirme.
import { icon } from './icons.js';

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (s) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[s]));
}

export function formatTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '00:00';
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60);
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

export function clockTime(ts = Date.now()) {
  return new Date(ts).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
}

const TOAST_ICON = { info: 'info', success: 'check', warn: 'alert', error: 'alert' };
export function toast(message, type = 'info', ms = 3600) {
  const host = $('#toasts');
  if (!host) return;
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.setAttribute('role', type === 'error' ? 'alert' : 'status');
  el.innerHTML = `${icon(TOAST_ICON[type] || 'info')}<span>${escapeHtml(message)}</span>`;
  host.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 300); }, ms);
}

export async function copyText(text, okMsg = 'Panoya kopyalandı') {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.cssText = 'position:fixed;opacity:0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } catch {}
    ta.remove();
  }
  toast(okMsg, 'success');
}

export function initials(name) {
  return String(name || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toLocaleUpperCase('tr-TR') || '').join('') || '?';
}

export function colorFor(id) {
  let h = 0;
  for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return `hsl(${h % 360} 70% 60%)`;
}

export function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src; s.async = true;
    s.onload = () => resolve(); s.onerror = () => reject(new Error('Betik yüklenemedi: ' + src));
    document.head.appendChild(s);
  });
}
