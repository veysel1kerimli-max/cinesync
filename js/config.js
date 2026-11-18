// CineSync — merkezi yapılandırma
// Tüm ağ uç noktaları ve bilinen site kuralları burada tutulur; kodun geri kalanı bu dosyayı okur.

export const APP = {
  name: 'CineSync',
  version: '2.3.0',
  protocol: 'cinesync-v2',
};

// Oda mesajlaşması (sohbet, senkron, sinyalleşme) için herkese açık Nostr röleleri.
// Hepsi 443 portu üzerinden WSS çalışır; şirket ağları ve mobil operatörlerde de genelde açıktır.
// Mesajlar oda koduyla AES-GCM ile şifrelenir; röleler içeriği göremez.
export const RELAYS = [
  'wss://nos.lol',
  'wss://relay.primal.net',
  'wss://relay.nostr.net',
  'wss://nostr.mom',
  'wss://offchain.pub',
  'wss://relay.damus.io',
  'wss://relay.snort.social',
];

// Görüntülü görüşme (WebRTC) için STUN sunucuları. Kendi TURN sunucunuz varsa buraya ekleyin:
// { urls: 'turn:turn.example.com:3478', username: 'u', credential: 'p' }
export const ICE_SERVERS = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  { urls: 'stun:stun.cloudflare.com:3478' },
];

export const HLS_SRC = {
  local: 'vendor/hls.min.js',
  cdn: 'https://cdn.jsdelivr.net/npm/hls.js@1.5.20/dist/hls.min.js',
};

// Başka sitelerin içine gömülmeyi (iframe) X-Frame-Options veya CSP frame-ancestors ile
// yasaklayan bilinen alan adları. Bunlar boş çerçeve yerine "yeni sekmede aç" kartıyla gösterilir.
// Alt alan adları da eşleşir (ör. "google.com" -> "www.google.com", "mail.google.com").
export const FRAME_BLOCKED_DOMAINS = [
  'google.com', 'google.com.tr', 'gmail.com', 'youtube.com', 'youtu.be',
  'facebook.com', 'fb.com', 'instagram.com', 'threads.net', 'whatsapp.com', 'messenger.com',
  'twitter.com', 'x.com', 'tiktok.com', 'reddit.com', 'linkedin.com', 'pinterest.com',
  'netflix.com', 'primevideo.com', 'amazon.com', 'amazon.com.tr', 'disneyplus.com', 'hbomax.com', 'max.com',
  'blutv.com', 'exxen.com', 'gain.tv', 'todtv.com.tr', 'bein.com',
  'twitch.tv', 'kick.com', 'ok.ru', 'vk.com', 'rutube.ru', 'vimeo.com', 'dailymotion.com',
  'spotify.com', 'soundcloud.com', 'apple.com', 'microsoft.com', 'live.com', 'office.com', 'bing.com',
  'github.com', 'gitlab.com', 'stackoverflow.com', 'discord.com', 'telegram.org', 'web.telegram.org',
  'yandex.com', 'yandex.com.tr', 'yandex.ru', 'chatgpt.com', 'openai.com', 'paypal.com',
  'tubitv.com', 'plex.tv', 'arte.tv', 'nfb.ca', 'onf.ca', 'kanopy.com', 'loc.gov', 'studio.blender.org', 'popcornflix.com',
  'trendyol.com', 'hepsiburada.com', 'sahibinden.com', 'n11.com', 'eksisozluk.com', 'imdb.com',
];

// Bu alanların "oynatıcı" alt alan adları gömülmeye izin verir; FRAME_BLOCKED listesinden muaftır.
export const FRAME_ALLOWED_HOSTS = [
  'www.youtube.com/embed', 'www.youtube-nocookie.com', 'player.vimeo.com', 'player.twitch.tv', 'clips.twitch.tv',
  'www.dailymotion.com/embed', 'geo.dailymotion.com', 'ok.ru/videoembed', 'rutube.ru/play/embed',
  'open.spotify.com/embed', 'w.soundcloud.com', 'player.kick.com', 'www.google.com/maps/embed',
  'drive.google.com', 'docs.google.com',
];

// ---------------------------------------------------------------------------------------------
// İZİN VERİLEN FİLM SİTELERİ (allowlist)
// Yalnızca yasal, resmî ve ücretsiz kaynaklar. Korsan/lisanssız yayın siteleri bilinçli olarak YOKTUR.
// embed: true  -> sitenin kendisi başka sayfalarda (iframe) gösterilmeye izin veriyor; odada açılır.
// embed: false -> site gömülmeyi yasaklıyor (X-Frame-Options / CSP frame-ancestors); herkese
//                 "yeni sekmede aç" kartı gösterilir. Bu sitelerdeki tek tek video linkleri
//                 (YouTube, Vimeo, Dailymotion) adres çubuğuna yapıştırılınca yine odada oynar.
// Doğrulama: 18.11.2026 — curl başlıkları + Chrome içinde iframe testi (tests/README notlarına bakın).
// ---------------------------------------------------------------------------------------------
export const ALLOWED_SITES = [
  { id: 'archive-feature', name: 'Internet Archive · Uzun Metraj', url: 'https://archive.org/details/feature_films', embed: true, cat: 'arsiv', mono: 'IA', color: '#e5e7eb', note: 'Telif süresi dolmuş (kamu malı) binlerce klasik film. Film sayfası odada gömülü oynatıcıyla açılır.' },
  { id: 'archive-silent', name: 'Internet Archive · Sessiz Filmler', url: 'https://archive.org/details/silent_films', embed: true, cat: 'arsiv', mono: 'IA', color: '#cbd5e1', note: 'Chaplin, Keaton, Méliès… Sessiz sinema klasikleri.' },
  { id: 'archive-movies', name: 'Internet Archive · Hareketli Görüntü Arşivi', url: 'https://archive.org/details/movies', embed: true, cat: 'arsiv', mono: 'IA', color: '#94a3b8', note: 'Belgeseller, kısa filmler, açık lisanslı yapımlar.' },
  { id: 'commons', name: 'Wikimedia Commons · Kamu Malı Filmler', url: 'https://commons.wikimedia.org/wiki/Category:Films_in_the_public_domain', embed: true, cat: 'arsiv', mono: 'W', color: '#38bdf8', note: 'Vikipedi’nin medya arşivi. Video dosyası linkleri odada tam senkron oynar.' },
  { id: 'tabii', name: 'tabii (TRT İzle)', url: 'https://www.tabii.com/', embed: true, cat: 'turk', mono: 'tb', color: '#22d3ee', note: 'TRT’nin resmî ücretsiz platformu: Türk filmleri, diziler, belgeseller. trtizle.com buraya yönlenir. Bazı içerikler üyelik ister.' },
  { id: 'puhutv', name: 'puhutv', url: 'https://puhutv.com/', embed: true, cat: 'turk', mono: 'pu', color: '#a3e635', note: 'Resmî Türk platformu; ücretsiz (reklamlı) dizi ve filmler. Bazı içerikler üyelik ister.' },
  { id: 'pluto', name: 'Pluto TV', url: 'https://pluto.tv/', embed: true, cat: 'tv', mono: 'P', color: '#facc15', note: 'Paramount’un ücretsiz, reklamlı film ve canlı TV servisi. Her ülkede açık değildir.' },
  { id: 'youtube-movies', name: 'YouTube · Filmler', url: 'https://www.youtube.com/feed/storefront', embed: false, cat: 'platform', mono: 'YT', color: '#ef4444', note: 'Resmî ücretsiz (reklamlı) filmler ve kanalların yüklediği filmler. Film linkini adres çubuğuna yapıştırın: odada senkron oynar.' },
  { id: 'dailymotion', name: 'Dailymotion', url: 'https://www.dailymotion.com/', embed: false, cat: 'platform', mono: 'd', color: '#60a5fa', note: 'Video linkleri odada resmî oynatıcıyla açılır.' },
  { id: 'vimeo', name: 'Vimeo · Staff Picks', url: 'https://vimeo.com/channels/staffpicks', embed: false, cat: 'platform', mono: 'v', color: '#38bdf8', note: 'Bağımsız kısa filmler. Video linkleri odada tam senkron oynar.' },
  { id: 'blender', name: 'Blender Studio · Açık Filmler', url: 'https://studio.blender.org/films/', embed: false, cat: 'platform', mono: 'B', color: '#fb923c', note: 'Creative Commons lisanslı animasyon filmleri (Sintel, Big Buck Bunny, Spring…).' },
  { id: 'tubi', name: 'Tubi', url: 'https://tubitv.com/', embed: false, cat: 'tv', mono: 'T', color: '#fbbf24', note: 'Fox’un ücretsiz, reklamlı film servisi. Bölgeye göre değişir.' },
  { id: 'plex', name: 'Plex · Ücretsiz Filmler', url: 'https://watch.plex.tv/', embed: false, cat: 'tv', mono: 'PX', color: '#eab308', note: 'Ücretsiz, reklamlı yasal film kataloğu. Bölgeye göre değişir.' },
  { id: 'arte', name: 'ARTE · Sinema', url: 'https://www.arte.tv/en/videos/cinema/', embed: false, cat: 'tv', mono: 'A', color: '#f97316', note: 'Avrupa kamu yayıncısının ücretsiz film ve belgeselleri.' },
  { id: 'nfb', name: 'NFB / ONF (Kanada)', url: 'https://www.nfb.ca/', embed: false, cat: 'arsiv', mono: 'NFB', color: '#f43f5e', note: 'Kanada Ulusal Film Kurulu’nun ücretsiz belgesel ve animasyonları. Bazıları bölge kısıtlı.' },
  { id: 'kanopy', name: 'Kanopy', url: 'https://www.kanopy.com/', embed: false, cat: 'tv', mono: 'K', color: '#e879f9', note: 'Kütüphane/üniversite üyeliğiyle ücretsiz sanat filmleri.' },
  { id: 'loc', name: 'Library of Congress · Ulusal Gösterim Salonu', url: 'https://www.loc.gov/collections/national-screening-room/', embed: false, cat: 'arsiv', mono: 'LoC', color: '#a78bfa', note: 'ABD Kongre Kütüphanesi’nin kamu malı film koleksiyonu.' },
];
export const SITE_CATEGORIES = [
  { id: 'all', label: 'Tümü' }, { id: 'arsiv', label: 'Film arşivleri' }, { id: 'turk', label: 'Türk platformları' },
  { id: 'tv', label: 'Ücretsiz TV / film servisleri' }, { id: 'platform', label: 'Video platformları' },
];

// Odada TAM SENKRON izlenebilen, hukuken serbest filmler (doğrudan MP4; Chrome'da oynatma doğrulandı).
// lic: 'pd' kamu malı, 'cc0', 'ccby' Creative Commons Atıf
export const FEATURED_FILMS = [
  { title: 'Night of the Living Dead', year: 1968, min: 96, genre: 'Korku', lic: 'pd', url: 'https://archive.org/download/night_of_the_living_dead_dvd/Night.mp4', page: 'https://archive.org/details/night_of_the_living_dead_dvd' },
  { title: 'His Girl Friday', year: 1940, min: 92, genre: 'Komedi', lic: 'pd', url: 'https://archive.org/download/his_girl_friday/his_girl_friday.mp4', page: 'https://archive.org/details/his_girl_friday' },
  { title: 'Nosferatu', year: 1922, min: 92, genre: 'Sessiz · Korku', lic: 'cc0', url: 'https://archive.org/download/Nosferatu1922/Nosferatu.mp4', page: 'https://archive.org/details/Nosferatu1922' },
  { title: 'The General (Buster Keaton)', year: 1926, min: 79, genre: 'Sessiz · Komedi', lic: 'pd', url: 'https://archive.org/download/TheGeneral_201312/The-General-v2.mp4', page: 'https://archive.org/details/TheGeneral_201312' },
  { title: 'Charlie Chaplin Festivali', year: 1938, min: 77, genre: 'Komedi', lic: 'pd', url: 'https://archive.org/download/charlie_chaplin_film_fest/charlie_chaplin_film_fest.mp4', page: 'https://archive.org/details/charlie_chaplin_film_fest' },
  { title: 'Gulliver’in Gezileri', year: 1939, min: 73, genre: 'Animasyon', lic: 'pd', url: 'https://archive.org/download/gullivers_travels1939/gullivers_travels1939.mp4', page: 'https://archive.org/details/gullivers_travels1939' },
  { title: 'The Lost World', year: 1925, min: 68, genre: 'Macera', lic: 'pd', url: 'https://archive.org/download/lost_world/lost_world.mp4', page: 'https://archive.org/details/lost_world' },
  { title: 'Dr. Caligari’nin Muayenehanesi', year: 1920, min: 51, genre: 'Sessiz · Gerilim', lic: 'pd', url: 'https://archive.org/download/DasKabinettdesDoktorCaligariTheCabinetofDrCaligari/The_Cabinet_of_Dr._Caligari_512kb.mp4', page: 'https://archive.org/details/DasKabinettdesDoktorCaligariTheCabinetofDrCaligari' },
  { title: 'Sita Sings the Blues', year: 2008, min: 82, genre: 'Animasyon', lic: 'cc0', url: 'https://archive.org/download/Sita_Sings_the_Blues/Sita_Sings_the_Blues_480p_2150kbps.mp4', page: 'https://archive.org/details/Sita_Sings_the_Blues' },
  { title: 'Aya Yolculuk (Méliès)', year: 1902, min: 11, genre: 'Sessiz · Bilimkurgu', lic: 'ccby', url: 'https://archive.org/download/ATripToTheMoon20Fps/TripToTheMoon20Fps.mp4', page: 'https://archive.org/details/ATripToTheMoon20Fps' },
  { title: 'Tears of Steel', year: 2012, min: 12, genre: 'Bilimkurgu', lic: 'ccby', url: 'https://archive.org/download/Tears-of-Steel/tears_of_steel_720p.mp4', page: 'https://archive.org/details/Tears-of-Steel' },
  { title: 'Sintel', year: 2010, min: 15, genre: 'Animasyon', lic: 'ccby', url: 'https://upload.wikimedia.org/wikipedia/commons/transcoded/f/f1/Sintel_movie_4K.webm/Sintel_movie_4K.webm.720p.vp9.webm', page: 'https://durian.blender.org/' },
  { title: 'Big Buck Bunny', year: 2008, min: 10, genre: 'Animasyon', lic: 'ccby', url: 'https://archive.org/download/BigBuckBunny_124/Content/big_buck_bunny_720p_surround.mp4', page: 'https://peach.blender.org/' },
  { title: 'Elephants Dream', year: 2006, min: 11, genre: 'Animasyon', lic: 'ccby', url: 'https://archive.org/download/ElephantsDream/ed_hd.mp4', page: 'https://orange.blender.org/' },
];
export const LICENSE_LABEL = { pd: 'Kamu malı', cc0: 'CC0', ccby: 'CC BY' };
