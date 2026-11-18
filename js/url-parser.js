// CineSync — akıllı adres çözümleyici
// Kullanıcının yapıştırdığı her türlü izleme/paylaşım linkini, resmi ve gömülebilir oynatıcı
// adresine çevirir. Saf (DOM'suz) bir modüldür; Node ile birim testi yapılabilir.

import { FRAME_BLOCKED_DOMAINS, FRAME_ALLOWED_HOSTS } from './config.js';

const DIRECT_VIDEO_RE = /\.(mp4|m4v|webm|ogv|ogg|mov|mkv|mp3|m4a|aac|wav|flac)$/i;
const HLS_RE = /\.m3u8$/i;
const DASH_RE = /\.mpd$/i;

/** "1h2m3s", "90", "90s", "1:30", "01:02:03" -> saniye */
export function parseTimeParam(value) {
  if (value == null || value === '') return 0;
  const v = String(value).trim();
  if (/^\d+(\.\d+)?$/.test(v)) return Math.floor(Number(v));
  if (/^\d+(:\d{1,2}){1,2}$/.test(v)) {
    return v.split(':').map(Number).reduce((acc, n) => acc * 60 + n, 0);
  }
  const m = v.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/i);
  if (m && (m[1] || m[2] || m[3])) {
    return (Number(m[1] || 0) * 3600) + (Number(m[2] || 0) * 60) + Number(m[3] || 0);
  }
  return 0;
}

function hostMatches(host, domain) {
  return host === domain || host.endsWith('.' + domain);
}

export function isFrameAllowed(u) {
  const hp = (u.hostname + u.pathname).toLowerCase();
  return FRAME_ALLOWED_HOSTS.some((p) => hp.startsWith(p) || (p.indexOf('/') === -1 && hostMatches(u.hostname, p)));
}

export function findBlockingDomain(u) {
  if (isFrameAllowed(u)) return null;
  const host = u.hostname.toLowerCase();
  return FRAME_BLOCKED_DOMAINS.find((d) => hostMatches(host, d)) || null;
}

function toUrl(input) {
  let s = String(input || '').trim();
  if (!s) return null;
  if (/^\/\//.test(s)) s = 'https:' + s;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'https://' + s;
  try {
    const u = new URL(s);
    if (!['http:', 'https:'].includes(u.protocol)) return null;
    if (!u.hostname.includes('.') && u.hostname !== 'localhost') return null;
    return u;
  } catch {
    return null;
  }
}

function looksLikeSearch(s) {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return false;
  if (/\s/.test(s)) return true;
  // "film" gibi noktasız tek kelime -> arama; "example.com" -> adres
  return !/^[^\s/]+\.[a-z]{2,}(?::\d+)?(\/|$|\?|#)/i.test(s) && !/^localhost(:\d+)?/i.test(s);
}

function result(base) {
  return {
    kind: 'web', provider: 'Web', url: '', embedUrl: '', syncable: false,
    start: 0, youtube: null, vimeo: null, stream: null, reason: '', blockedBy: null,
    ...base,
  };
}

// ---------------- Sağlayıcı çözümleyiciler ----------------

function parseYouTube(u) {
  const host = u.hostname.replace(/^(www\.|m\.|music\.)/, '');
  let id = null;
  const list = u.searchParams.get('list');
  if (host === 'youtu.be') {
    id = u.pathname.slice(1).split('/')[0];
  } else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    const p = u.pathname;
    if (p === '/watch') id = u.searchParams.get('v');
    else {
      const m = p.match(/^\/(?:embed|shorts|live|v|e)\/([A-Za-z0-9_-]{11})/);
      if (m) id = m[1];
      else if (p === '/playlist' && list) id = null;
      else return null;
    }
  } else return null;

  if (id && !/^[A-Za-z0-9_-]{11}$/.test(id)) id = null;
  if (!id && !list) return null;
  const start = parseTimeParam(u.searchParams.get('t') || u.searchParams.get('start') || (u.hash.match(/t=([^&]+)/) || [])[1]);
  const embed = id
    ? `https://www.youtube.com/embed/${id}?${new URLSearchParams({ ...(list ? { list } : {}), ...(start ? { start: String(start) } : {}), playsinline: '1', rel: '0' })}`
    : `https://www.youtube.com/embed/videoseries?list=${encodeURIComponent(list)}`;
  return result({
    kind: 'youtube', provider: 'YouTube', url: u.href, embedUrl: embed, syncable: true, start,
    youtube: { id, list: list || null },
  });
}

function parseVimeo(u) {
  const host = u.hostname.replace(/^www\./, '');
  if (host !== 'vimeo.com' && host !== 'player.vimeo.com') return null;
  const parts = u.pathname.split('/').filter(Boolean);
  const idx = parts.findIndex((p) => /^\d{5,}$/.test(p));
  if (idx === -1) return null;
  const id = parts[idx];
  let hash = u.searchParams.get('h');
  if (!hash && parts[idx + 1] && /^[0-9a-f]{6,}$/i.test(parts[idx + 1])) hash = parts[idx + 1];
  const start = parseTimeParam((u.hash.match(/t=([^&]+)/) || [])[1]);
  const qs = new URLSearchParams({ ...(hash ? { h: hash } : {}), dnt: '1' });
  return result({
    kind: 'vimeo', provider: 'Vimeo', url: u.href,
    embedUrl: `https://player.vimeo.com/video/${id}?${qs}${start ? `#t=${start}s` : ''}`,
    syncable: true, start, vimeo: { id, hash: hash || null },
  });
}

function parseTwitch(u, env) {
  const host = u.hostname.replace(/^(www\.|m\.)/, '');
  if (!['twitch.tv', 'clips.twitch.tv', 'player.twitch.tv'].includes(host)) return null;
  const parent = env.hostname;
  const base = { kind: 'embed', provider: 'Twitch', url: u.href };
  const needParent = !parent || env.protocol !== 'https:' && parent !== 'localhost';
  let embedUrl = null;
  const parts = u.pathname.split('/').filter(Boolean);
  if (host === 'player.twitch.tv') {
    const q = new URLSearchParams(u.search); q.set('parent', parent || '');
    embedUrl = `https://player.twitch.tv/?${q}`;
  } else if (host === 'clips.twitch.tv') {
    const slug = parts[0] === 'embed' ? u.searchParams.get('clip') : parts[0];
    if (slug) embedUrl = `https://clips.twitch.tv/embed?clip=${encodeURIComponent(slug)}&parent=${parent}`;
  } else if (parts[0] === 'videos' && /^\d+$/.test(parts[1] || '')) {
    embedUrl = `https://player.twitch.tv/?video=v${parts[1]}&parent=${parent}&autoplay=true`;
  } else if (parts[1] === 'clip' && parts[2]) {
    embedUrl = `https://clips.twitch.tv/embed?clip=${encodeURIComponent(parts[2])}&parent=${parent}`;
  } else if (parts.length === 1 && /^[A-Za-z0-9_]{2,25}$/.test(parts[0]) && !['directory', 'settings', 'search', 'p'].includes(parts[0])) {
    embedUrl = `https://player.twitch.tv/?channel=${parts[0]}&parent=${parent}&autoplay=true`;
  }
  if (!embedUrl) return null;
  if (needParent) {
    return result({ ...base, kind: 'blocked', blockedBy: 'twitch.tv', reason: 'Twitch oynatıcısı yalnızca https:// üzerinden yayınlanan bir sitede çalışır (parent alan adı zorunlu). Dosyayı bilgisayardan açtıysanız, yayınlanmış adresi kullanın.' });
  }
  return result({ ...base, embedUrl });
}

function parseSimpleEmbeds(u) {
  const host = u.hostname.replace(/^(www\.|m\.)/, '');
  const p = u.pathname;
  let m;
  // Dailymotion
  if (host === 'dailymotion.com' && (m = p.match(/^\/(?:embed\/)?video\/([a-zA-Z0-9]+)/))) {
    return result({ kind: 'embed', provider: 'Dailymotion', url: u.href, embedUrl: `https://www.dailymotion.com/embed/video/${m[1]}` });
  }
  if (host === 'dai.ly' && (m = p.match(/^\/([a-zA-Z0-9]+)/))) {
    return result({ kind: 'embed', provider: 'Dailymotion', url: u.href, embedUrl: `https://www.dailymotion.com/embed/video/${m[1]}` });
  }
  if (host === 'geo.dailymotion.com' && u.searchParams.get('video')) {
    return result({ kind: 'embed', provider: 'Dailymotion', url: u.href, embedUrl: u.href });
  }
  // Google Drive
  if (host === 'drive.google.com') {
    const id = (p.match(/\/file\/d\/([a-zA-Z0-9_-]+)/) || [])[1] || u.searchParams.get('id');
    if (id) return result({ kind: 'embed', provider: 'Google Drive', url: u.href, embedUrl: `https://drive.google.com/file/d/${id}/preview` });
  }
  // Streamable
  if (host === 'streamable.com' && (m = p.match(/^\/(?:e\/|o\/)?([a-zA-Z0-9]+)/))) {
    return result({ kind: 'embed', provider: 'Streamable', url: u.href, embedUrl: `https://streamable.com/e/${m[1]}` });
  }
  // OK.ru
  if (host === 'ok.ru' && (m = p.match(/^\/(?:video|videoembed|live)\/(\d+)/))) {
    return result({ kind: 'embed', provider: 'OK.ru', url: u.href, embedUrl: `https://ok.ru/videoembed/${m[1]}` });
  }
  // Rutube
  if (host === 'rutube.ru' && (m = p.match(/^\/(?:video|play\/embed|shorts)\/([a-zA-Z0-9]+)/))) {
    return result({ kind: 'embed', provider: 'Rutube', url: u.href, embedUrl: `https://rutube.ru/play/embed/${m[1]}` });
  }
  // Archive.org
  if (host === 'archive.org' && (m = p.match(/^\/(?:details|embed)\/([^/?#]+)/))) {
    return result({ kind: 'embed', provider: 'Archive.org', url: u.href, embedUrl: `https://archive.org/embed/${m[1]}` });
  }
  // Spotify
  if (host === 'open.spotify.com' && (m = p.match(/^\/(?:intl-[a-z]+\/)?(?:embed\/)?(track|album|playlist|episode|show|artist)\/([a-zA-Z0-9]+)/))) {
    return result({ kind: 'embed', provider: 'Spotify', url: u.href, embedUrl: `https://open.spotify.com/embed/${m[1]}/${m[2]}` });
  }
  // SoundCloud
  if (host === 'soundcloud.com' && p.split('/').filter(Boolean).length >= 2) {
    return result({ kind: 'embed', provider: 'SoundCloud', url: u.href, embedUrl: `https://w.soundcloud.com/player/?url=${encodeURIComponent(u.origin + p)}&auto_play=true&visual=true` });
  }
  // Kick
  if (host === 'kick.com' && (m = p.match(/^\/([A-Za-z0-9_-]{2,})\/?$/))) {
    return result({ kind: 'embed', provider: 'Kick', url: u.href, embedUrl: `https://player.kick.com/${m[1]}` });
  }
  if (host === 'player.kick.com') {
    return result({ kind: 'embed', provider: 'Kick', url: u.href, embedUrl: u.href });
  }
  // Google Maps (paylaşım linkleri gömülemez; embed linki gerekir)
  return null;
}

/**
 * Kullanıcı girdisini çözümler.
 * @param {string} raw  Adres, paylaşım linki veya arama ifadesi
 * @param {{hostname?: string, protocol?: string}} env  Sitenin yayınlandığı ortam (Twitch parent, karışık içerik kontrolü)
 */
export function parseInput(raw, env = {}) {
  const input = String(raw || '').trim();
  if (!input) return null;
  const pageProtocol = env.protocol || 'https:';

  if (looksLikeSearch(input)) {
    const q = encodeURIComponent(input);
    return result({
      kind: 'web', provider: 'Wikipedia Arama', isSearch: true, query: input,
      url: `https://tr.wikipedia.org/w/index.php?search=${q}`,
      embedUrl: `https://tr.wikipedia.org/w/index.php?search=${q}`,
    });
  }

  const u = toUrl(input);
  if (!u) return null;

  const path = u.pathname;
  if (HLS_RE.test(path)) return result({ kind: 'video', provider: 'HLS Yayını', url: u.href, embedUrl: u.href, syncable: true, stream: 'hls', ...mixed(u, pageProtocol) });
  if (DASH_RE.test(path)) return result({ kind: 'blocked', provider: 'DASH', url: u.href, reason: 'MPEG-DASH (.mpd) akışları desteklenmiyor. MP4 veya HLS (.m3u8) bağlantısı kullanın.' });
  if (DIRECT_VIDEO_RE.test(path)) return result({ kind: 'video', provider: 'Video Dosyası', url: u.href, embedUrl: u.href, syncable: true, stream: 'file', ...mixed(u, pageProtocol) });

  const parsed = parseYouTube(u) || parseVimeo(u) || parseTwitch(u, env) || parseSimpleEmbeds(u);
  if (parsed) return parsed;

  // Genel web sitesi
  if (u.protocol === 'http:' && pageProtocol === 'https:') {
    return result({ kind: 'blocked', provider: 'Web', url: u.href, blockedBy: u.hostname, reason: 'Bu adres şifresiz (http://). Güvenli (https) bir sayfanın içinde tarayıcılar http içeriğini engeller.' });
  }
  const blocker = findBlockingDomain(u);
  if (blocker) {
    return result({
      kind: 'blocked', provider: 'Web', url: u.href, blockedBy: blocker,
      reason: `${blocker} başka sitelerin içinde açılmayı güvenlik başlıklarıyla (X-Frame-Options / CSP) yasaklıyor.`,
    });
  }
  const isPlayer = /(\/embed\/|\/embed\?|^player\.|\/player\/)/i.test(u.hostname + u.pathname) || /^player\./i.test(u.hostname);
  return result({ kind: isPlayer ? 'embed' : 'web', provider: isPlayer ? 'Gömülü Oynatıcı' : 'Web', url: u.href, embedUrl: u.href });
}

function mixed(u, pageProtocol) {
  if (u.protocol === 'http:' && pageProtocol === 'https:') {
    return { kind: 'blocked', reason: 'Video adresi şifresiz (http://). Tarayıcılar güvenli sayfada http medya akışını engeller; https sürümünü kullanın.', blockedBy: u.hostname };
  }
  return {};
}
