// CineSync service worker — yalnızca uygulama kabuğunu önbelleğe alır (çevrimdışı açılış + kurulabilirlik).
// Strateji: önce ağ, ağ yoksa önbellek. Böylece yeni sürüm yayınlandığında hemen görünür.
const CACHE = 'cinesync-shell-v2.4.0';
const SHELL = [
  './', './index.html', './css/app.css', './manifest.webmanifest', './icons/icon.svg', './icons/icon-192.png',
  './js/app.js', './js/config.js', './js/url-parser.js', './js/room.js', './js/rtc.js', './js/stage.js', './js/pip.js', './js/theme.js', './js/qr.js', './js/vendor/qrcode.js',
  './js/ui/dom.js', './js/ui/icons.js', './js/net/relay-pool.js', './js/net/room-channel.js', './js/vendor/schnorr.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))).catch(() => {}).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // video, oynatıcı ve röle trafiğine dokunma
  if (req.headers.has('range') || /\.(mp4|webm|m3u8|ts)$/i.test(url.pathname)) return;
  e.respondWith(
    fetch(req, { cache: 'no-cache' }).then((res) => {
      if (res.ok && res.type === 'basic') { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {}); }
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: true }).then((r) => r || (req.mode === 'navigate' ? caches.match('./index.html') : Response.error())))
  );
});
