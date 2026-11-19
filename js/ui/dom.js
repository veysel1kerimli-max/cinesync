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
/**
 * Kısa bildirim. Dokununca kapanır; aynı anda en fazla 4 tane görünür (en eskisi kapanır).
 * opts.action = { label, fn } verilirse bildirimde bir işlem düğmesi (ör. "Geri al") gösterilir.
 */
export function toast(message, type = 'info', ms = 3600, opts = {}) {
  const host = $('#toasts');
  if (!host) return;
  // Aynı metin zaten görünüyorsa yenisini ekleme, süresini uzat
  for (const t of host.children) if (t._msg === message && !t.classList.contains('out')) { clearTimeout(t._timer); t._timer = setTimeout(() => close(t), ms); return t; }
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el._msg = message;
  el.setAttribute('role', type === 'error' ? 'alert' : 'status');
  el.innerHTML = `${icon(TOAST_ICON[type] || 'info')}<span class="toast-text">${escapeHtml(message)}</span>`;
  if (opts.action && typeof opts.action.fn === 'function') {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'toast-act'; b.textContent = opts.action.label || 'Tamam';
    b.addEventListener('click', (e) => { e.stopPropagation(); try { opts.action.fn(); } catch {} close(el); });
    el.appendChild(b);
  }
  const x = document.createElement('button');
  x.type = 'button'; x.className = 'toast-x'; x.setAttribute('aria-label', 'Bildirimi kapat'); x.innerHTML = icon('x');
  x.addEventListener('click', (e) => { e.stopPropagation(); close(el); });
  el.appendChild(x);
  el.addEventListener('click', () => close(el));
  host.appendChild(el);
  const live = [...host.children].filter((t) => !t.classList.contains('out'));
  while (live.length > 4) close(live.shift());
  requestAnimationFrame(() => el.classList.add('show'));
  el._timer = setTimeout(() => close(el), ms);
  return el;
  function close(t) {
    if (!t || t.classList.contains('out')) return;
    clearTimeout(t._timer);
    t.classList.add('out'); t.classList.remove('show');
    setTimeout(() => t.remove(), 300);
  }
}

/** Göreli zaman: "az önce", "5 dk önce", "2 sa önce", "3 gün önce" */
export function timeAgo(ts, now = Date.now()) {
  const d = Math.max(0, now - Number(ts || 0)) / 1000;
  if (d < 60) return 'az önce';
  if (d < 3600) return `${Math.floor(d / 60)} dk önce`;
  if (d < 86400) return `${Math.floor(d / 3600)} sa önce`;
  if (d < 86400 * 30) return `${Math.floor(d / 86400)} gün önce`;
  return new Date(ts).toLocaleDateString('tr-TR');
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
