# CineSync v2.3 — Ortak İzleme Odası

Canlı: https://cinesync-veysel.netlify.app

Arkadaşlarınla aynı anda video izle, görüntülü konuş, sohbet et ve ekranını paylaş.
Sunucu, hesap veya API anahtarı gerektirmez; statik bir web sitesi olarak her yerde yayınlanabilir.

## Özellikler

| Özellik | Açıklama |
|---|---|
| Oda sistemi | Rastgele 6 haneli kod **ya da kendi seçtiğin kod** (ör. `film-gecesi`), isteğe bağlı **oda şifresi**, davet linki (`…#room=kod`), üye listesi, katıldı/ayrıldı bildirimleri. Oda boşalınca tamamen silinir |
| Tam senkron oynatma | MP4/WebM/MOV, HLS canlı yayın (.m3u8), **YouTube** (IFrame API), **Vimeo** (Player API). Oynat, duraklat, ileri/geri sar, “Herkesi eşitle”. Oynatıcının kendi düğmeleri de senkronlanır. Kayma (buffer) her 4 saniyede düzeltilir |
| Akıllı link çözümleyici | YouTube (watch, youtu.be, shorts, live, embed, mobil, music, playlist, `t=1m30s`), Vimeo (gizli linkler dahil), Twitch (kanal/video/klip, doğru `parent`), Dailymotion, Google Drive, Streamable, OK.ru, Rutube, Archive.org, Spotify, SoundCloud, Kick |
| Web siteleri | Gömülmeye izin veren siteler sahnede açılır. İzin vermeyenler için boş çerçeve yerine **“Bu sayfa burada açılamıyor” kartı**: *Yeni sekmede aç*, *O sekmeyi odaya yansıt*, *Linki kopyala* — kart odadaki herkeste aynı anda görünür |
| Ekran / sekme yansıtma | Korumalı siteler (Netflix, Google vb.) dahil her şeyi canlı paylaşma (WebRTC) |
| Görüntülü görüşme | Kamera + mikrofon, kişiden kişiye (WebRTC mesh), STUN; TURN eklenebilir |
| Sohbet | Uçtan uca şifreli, link algılama, okunmamış sayacı, sonradan katılana son 40 mesaj |
| Eğlence | Uçan emoji tepkileri, ortak lazer işaretçi |
| Arayüz | Türkçe, koyu tema, satır içi SVG ikonlar (harici font/CDN yok) |

## v2.3'te yenilenenler

### Sorunların asıl sebepleri (sade anlatım)

| Sorun | Neden oluyordu | Ne yapıldı |
|---|---|---|
| Uygulamayı kapatmadan çıkınca birkaç saniye sonra karşı tarafın sesi gidiyor | Telefonda başka uygulamaya geçince tarayıcı `pagehide` olayı gönderiyor; uygulama bunu "odadan çıktı" sanıp herkese **veda mesajı** yolluyordu. Karşı taraf seni listeden silip sesli bağlantıyı kapatıyordu. Ayrıca sesler video kutucuklarından çalınıyordu (mobil tarayıcı arka planda videoları duraklatır), bağlantı kopunca yeniden kurma yoktu ve 70 sn'lik zaman aşımı kısaydı | Veda yalnızca **"Odadan çık"** düğmesiyle ya da sayfa gerçekten kapanınca (`pagehide` + `persisted=false`) gönderilir. Arka plandaki kişi "arka planda" görünür, **3 dakika** boyunca odada kalır; 6 sn'de bir kalp atışı. Uzak sesler ayrı `<audio>` öğelerinden çalar. Geri dönünce röleler yenilenir, WebRTC **ICE yeniden başlatılır**, ses yeniden başlatılır, durum yeniden istenir. Bağlantı koparken üstte **"Yeniden bağlanıyor…"** göstergesi |
| Mobilde arayüz çok karmaşık | Masaüstündeki tüm düğmeler telefonda da gösteriliyordu | Telefonda üstte yalnızca oda adı + bağlantı noktası + menü; büyük oynatıcı; altta tek çubuk (**Mikrofon, Kamera, Sohbet, Emoji, Daha fazla**). Geri kalan her şey **"Daha fazla"** alt sayfasında |
| Bazen sistem hata veriyor | Yakalanmamış hatalar, YouTube API hazır olmadan çağrı, hızlı kaynak değiştirince eski yüklemenin yenisinin üstüne yazması, mikrofon izin hataları, röle kopmaları | Genel hata yakalayıcı (kullanıcıya sade bir uyarı + otomatik toparlanma), tüm röle/eş/oynatıcı çağrıları korumalı, yükleme sıra numarası (yarış durumu yok), YouTube API tek sefer yüklenir, artan bekleme ile yeniden deneme, sessiz kalan röle soketi 45 sn'de yenilenir. 11 dk'lık dayanıklılık testinde bulunan tüm konsol hataları giderildi |
| Kulaklık takınca ses hâlâ hoparlörden | Bildirim sesi için sürekli açık tutulan bir `AudioContext` mobilde ses oturumunu "hoparlör" moduna kilitleyebiliyordu; cihaz değişince akışlar yeniden bağlanmıyordu | Ses hiçbir zaman `AudioContext` üzerinden yönlendirilmez (kısa bildirim sesi hemen kapatılır, iOS'ta mikrofon açıkken hiç çalınmaz), hoparlör zorlanmaz. Kulaklık takılıp çıkarılınca (`devicechange`) uzak sesler yeniden bağlanır, mikrofon yeniden alınır. Ayarlar > Cihazlar: **mikrofon seçimi** ve destekleyen tarayıcılarda **çıkış (hoparlör/kulaklık) seçimi** (`setSinkId`). iOS'ta düz `<audio playsinline>` |
| Senkron | Saat farkı hesaba katılmıyordu, kayma kaba atlamalarla düzeltiliyordu | Aşağıda |

### Ses çıkışını kim belirler? (önemli)

Telefonda sesin **kulaklıktan mı hoparlörden mi** geleceğine tarayıcı değil **işletim sistemi** karar verir:

- **iPhone / iPad:** Kulaklık (kablolu ya da Bluetooth) bağlıysa iOS sesi oraya yollar. Safari'de çıkış seçimi yoktur; değiştirmek için Denetim Merkezi > ses kartındaki AirPlay simgesi. Mikrofon açıkken iOS "görüşme" moduna geçer; bazı Bluetooth kulaklıklar bu modda daha düşük kaliteli (HFP) profile geçer, bu normaldir.
- **Android (Chrome):** Kulaklık bağlanınca Android sesi oraya yollar. Bluetooth kulaklık bağlı olduğu hâlde ses hoparlörden geliyorsa: bildirim panelinden medya çıkışını kulaklık seçin ya da kulaklığı bir kez çıkarıp takın (uygulama bunu algılayıp sesi yeniden bağlar).
- **Bilgisayar (Chrome / Edge / Firefox):** Ayarlar > Cihazlar'dan çıkış seçilebilir. Safari'de seçim yoktur, sistem ayarı geçerlidir.

### Senkronizasyon

- **Saat eşitleme (NTP benzeri):** her üye diğerleriyle saat farkını ölçer (en düşük gecikmeli ölçüm kullanılır); konumlar karşı tarafın saatine göre düzeltilir.
- **Tek yetkili durum + sıra numarası:** her oynatma değişikliği artan bir sürüm numarası taşır; eski/yinelenen mesajlar yok sayılır.
- **Yumuşak düzeltme:** küçük kaymada (0,12 sn üstü) oynatma hızı en fazla ±%8 hafifçe ayarlanır (fark edilmez); büyük kaymada (video 1 sn, YouTube/Vimeo 1,6 sn üstü) doğrudan konuma atlanır.
- Arabellek bitince, odaya yeniden girince ve sekmeye geri dönünce **otomatik yeniden eşitleme**. Kaynak, hız, altyazı ve kilit herkese gider.
- Oynatıcı menüsü > Senkron: **"Herkesi bana eşitle"** ve **"Kendimi odaya eşitle"**.

### Oda kodu, şifre ve odanın silinmesi

- **Özel oda kodu:** "Özel oda kodu ve şifre" bölümünden kendi kodunu yaz (4–32 karakter; harf, rakam, tire). Küçük harfe çevrilir, Türkçe harfler dönüştürülür ("Film Gecesi Çğ" → `film-gecesi-cg`). Boş bırakılırsa rastgele kod üretilir (varsayılan).
- **"Bu kod kullanımda — katılmak ister misin?"** Oluşturmadan önce kodda şu an birinin olup olmadığı yoklanır; varsa sorulur.
- **Şifreli oda:** Şifre girilirse tüm mesajlar kod + şifreden türetilen anahtarla şifrelenir (PBKDF2 → AES-GCM). Şifre davet linkine **eklenmez**; ayrıca söylenmelidir. Yanlış/eksik şifreyle girilirse "Bu oda şifreli" penceresi açılır.
- **Boşalan oda silinir:** Mesajlar rölelerde saklanmayan geçici olaylardır (Nostr kind 25050), oda durumu yalnızca **şu an odada olanlardan** gelir. Odayı ilk açan bir **oturum kimliği** üretir; sonradan gelenler onu devralır, eski oturumdan gelen mesajlar yok sayılır, rölelerin kısa süreli tekrar gönderdiği eski olaylar da işlenmez. Herkes çıkınca (ya da 3 dk'dan uzun süre kimse kalmayınca) aynı koda gelen kişi **sıfırdan** başlar: eski sohbet, video ya da kilit gelmez. Cihazda odaya özel önbellek varsa silinir. Kalıcı bir şey saklanmadığı için ayrıca silme (NIP-09) isteğine gerek yoktur.

### Ek geliştirmeler

- Her katılımcı için **bağlantı kalitesi** çubukları (iyi / orta / zayıf), konuşanın kutusu vurgulanır.
- **Otomatik kısma:** biri konuşurken video sesi geçici olarak kısılır (Ayarlar'dan kapatılabilir).
- Mikrofonda **yankı engelleme, gürültü bastırma, otomatik kazanç**.
- **Resim içinde resim** (PiP) düğmesi.
- **Son odaya hızlı dönüş** düğmesi; sekme arka planda kapatılıp açılırsa odaya kendiliğinden dönülür.
- Netlify rozeti korunur; sağ altta rozetin altına hiçbir düğme denk gelmez (mobilde alt şerit, masaüstünde kenar boşluğu).

### Bağlantı notu (TURN)

Çoğu ev/mobil ağda doğrudan bağlantı (STUN) yeterlidir. Bazı operatörlerin katı NAT'ı (CGNAT) veya kurumsal ağlarda görüntülü/sesli bağlantı kurulamayabilir; bunun için bir **TURN sunucusu** gerekir (ör. Cloudflare Calls TURN, Twilio, metered.ca ya da kendi `coturn` sunucunuz). `js/config.js` içindeki `ICE_SERVERS` listesine eklenebilir. Ücretsiz açık TURN sunucuları güvenilir olmadığı için varsayılan olarak eklenmedi.

## v2.1'de yenilenenler

| Alan | Ne değişti |
|---|---|
| Tüm cihazlara uyum | Telefon (dikey/yatay), tablet, dizüstü ve geniş ekran için ayrı yerleşimler. Telefonda oynatıcı üstte, altta sekmeli panel (Sohbet / Kameralar / Kişiler); 1024px ve üstünde sağda kenar çubuğu. Yatay telefonda iki sütun. Yatay kayma/taşma yok (320px'e kadar test edildi), uzun isim ve linkler kısaltılır ya da satır kırılır |
| Mobil ayrıntılar | Çentik/güvenli alan boşlukları, `100dvh`, en az 44px dokunma alanı, 16px giriş kutuları (iOS yakınlaştırma yapmaz), 16:9 sabit oran oynatıcı |
| Tam ekran | Tam ekran yalnızca videoyu değil tüm sahneyi kaplar (kontroller + kameralar). Kameralar köşelerde **yüzen küçük kutucuklar** olarak görünür (sen sağ altta, diğerleri öteki köşelerde); sürükle bırak, en yakın köşeye oturur, çift tık / “Boyut” ile küçük-orta-büyük. **“Kameraları gizle”** düğmesi ve `V` kısayolu ile gizle/göster. Kontroller 3 sn hareketsizlikte gizlenir. Diğerlerinin sesini kapat düğmesi. iPhone Safari için sahte tam ekran yedeği |
| Kullanım kolaylığı | Sinema modu (kenar çubuğunu gizler), son odalar ve son linkler, isim + avatar rengi hatırlanır, sistem paylaşım menüsü (`navigator.share`), bildirim balonları, bağlantı durumu göstergesi, okunmamış mesaj rozeti, bildirim sesi aç/kapa |
| Uygulama olarak yükleme (PWA) | Ana ekrana eklenebilir; simge + manifest; yalnızca arayüz dosyalarını önbelleğe alan servis çalışanı (videolar önbelleğe alınmaz) |
| Erişilebilirlik | Klavyeyle tam kullanım, görünür odak çerçeveleri, ekran okuyucu etiketleri, “içeriğe atla” linki, hareket azaltma ve yüksek kontrast desteği |

### Klavye kısayolları

| Tuş | İşlev |
|---|---|
| Boşluk / K | Oynat / duraklat |
| ← / → | 10 sn geri / ileri |
| F | Tam ekran |
| V | Kameraları göster / gizle |
| B | Kamera kutucuğu boyutu |
| T | Paneli gizle / göster (sinema modu) |
| S | İzin verilen siteler kataloğu |
| E | Tepki paneli |
| 1–6 | Hızlı tepki (😂 😍 😮 👏 🔥 😢) |
| M | Sesi kapat |
| L | Lazer işaretçi |
| / | Adres çubuğu |
| Enter | Sohbete yaz |
| Ctrl+D / Ctrl+E | Mikrofon / kamera |
| ? | Yardım |
| Esc | Menü / paneli kapat, sahte tam ekrandan çık |


## v2.2'de yenilenenler

| Alan | Ne değişti |
|---|---|
| Ana sayfa | Oda kurmadan önce açılan sayfa artık gerçek bir web sitesi: üst menü, başlık + “Oda oluştur / Odaya katıl” düğmeleri, özellikler, 3 adımda nasıl çalışır, desteklenen kaynaklar, SSS ve alt bilgi. Tüm ekranlara uyumlu |
| Sade oda ekranı | Ekranda duran “Test yayını / Vimeo örneği…” düğmeleri kaldırıldı; oynatıcı büyüdü. Yenile / ekran yansıt / lazer ve son linkler **Araçlar** simgesinin arkasına, emoji satırı oynatıcıdaki **😊** düğmesine taşındı. Kenar paneli (sohbet/kameralar) üstteki panel simgesi veya `T` ile gizlenip gösterilir; kamera listesi katlanabilir |
| İzin verilen siteler | Hiçbir site ekranda görünmez; **“Siteleri göster”** düğmesine (veya `S`) basınca düzenli bir katalog açılır: arama, kategori filtresi, her site için simge, kısa not ve **“Odada açılır” / “Yeni sekmede”** rozeti. Ayrıca odada tam senkron izlenebilen 14 ücretsiz film. Seçilen şey odadaki herkeste açılır. Liste `js/config.js` içindeki `ALLOWED_SITES` ve `FEATURED_FILMS` dizilerindedir |
| Tam ekran kontrolleri | Kontrol çubuğu (oynat/duraklat, ileri-geri, eşitle…) artık her zaman ulaşılabilir: fareyi oynatınca ya da ekrana dokununca geri gelir (YouTube/Vimeo/web sayfası iframe’lerinin üstünde bile), video **duraklatılınca hep görünür**, üzerindeyken gizlenmez, iframe ve kamera kutucuklarının üstündedir, çentik/alt çubuk boşluklarına uyar. Gerçek ve iPhone (sahte) tam ekranda çalışır. İstersen Ayarlar’dan otomatik gizlemeyi kapatabilirsin |
| Tam ekranda tepki | Tam ekranda da 😊 düğmesiyle 12 emojilik panel; uçan tepkiler herkesin ekranında, gönderenin adıyla görünür. `1`–`6` hızlı tepki, `E` paneli açar. Bildirimler tam ekranda da görünür |
| Oynatma hızı | 0.5×–2× hız odadaki herkese uygulanır, senkron hıza göre hesaplanır |
| Altyazı | Doğrudan video dosyaları için `.vtt` / `.srt` altyazı: link ile (herkeste; sunucunun CORS izni gerekir) veya dosyadan (yalnızca sende) |
| Oda sahibi kilidi | Menü → “Kontrolü kilitle”: oynat/duraklat/sar/kaynak değiştirme yalnızca kilitleyende. Kilitleyen ayrılırsa kilit kendiliğinden açılır |
| Sohbet | Mesajlara **yanıt** (alıntılı), “… yazıyor” göstergesi |
| Ayarlar | Ad değiştirme (odadayken), profil rengi, bildirim sesi, tam ekranda otomatik gizleme, uçan tepkiler, tam ekranda sohbet bildirimleri |
| Ana sayfa kaydırma (v2.2.2) | Bazı tarayıcılarda ana sayfa parmakla/tekerlekle kaymıyordu. Sebep: `body` öğesindeki `overflow-x: hidden` + `overscroll-behavior` onu ayrı bir kaydırma kutusuna çeviriyordu, kaydırma hareketi sayfaya ulaşmıyordu. Yatay kırpma `html`'e taşındı; Chrome, Safari (WebKit) ve Firefox'ta dokunma, tekerlek ve klavye ile en alta kadar kayıyor. Service worker önbelleği yenilendi (`v2.2.2`), eski sürüm kendiliğinden değişir |
| Odada ekrana tam oturma (v2.2.2) | Oda tam olarak ekran yüksekliğini kullanır (`100dvh` + `visualViewport`): sayfa kaymaz, oynatıcı kalan alanı en-boy oranını koruyarak doldurur, sohbet/paneller kendi içinde kayar. Mobil tarayıcı adres çubuğu açılıp kapanınca, telefon döndürülünce ve pencere boyutu değişince anında yeniden yerleşir. Küçük/alçak ekranlarda (iPhone SE, yatay telefon) üst çubuk, adres satırı ve kontrol çubuğu sıkışır, oynatıcıya yer kalır |
| Hata düzeltmesi | Vimeo/YouTube’dan başka bir kaynağa geçerken eski oynatıcının geç gelen “duraklatıldı” olayı yeni kaynağı herkeste duraklatabiliyordu; düzeltildi |

## İzin verilen siteler ve neden yalnızca yasal kaynaklar

CineSync yalnızca **yasal, resmî ve ücretsiz** kaynakları listeler. Korsan/lisanssız yayın siteleri bilinçli olarak eklenmedi: telif hakkını ihlal ederler, çoğu zararlı reklam, sahte “oynat” düğmeleri ve kötü amaçlı yazılım barındırır, sık sık kapanıp adres değiştirirler. Katalogdaki filmler kamu malıdır ya da Creative Commons ile serbestçe paylaşılır; siteler ise içeriğin hak sahibi olan resmî platformlardır.

Her site 18.11.2026’da iki yolla kontrol edildi: `curl` ile `X-Frame-Options` / `Content-Security-Policy: frame-ancestors` başlıkları ve Chrome içinde gerçek bir iframe denemesi. Gömülmeye izin verenler **odada açılır**, vermeyenler herkese **“yeni sekmede aç”** kartı olarak gösterilir (gerekirse “O sekmeyi odaya yansıt” ile paylaşılır). Bölge kısıtlamaları ve üyelik gereklilikleri sitelerin kendi kararıdır.

| Site | Durum | Not |
|---|---|---|
| Internet Archive · Uzun Metraj (archive.org/details/feature_films) | ✅ Odada açılır | Kamu malı klasik filmler |
| Internet Archive · Sessiz Filmler (archive.org/details/silent_films) | ✅ Odada açılır | Chaplin, Keaton, Méliès |
| Internet Archive · Hareketli Görüntü Arşivi (archive.org/details/movies) | ✅ Odada açılır | Belgesel, kısa film, açık lisanslı yapımlar |
| Wikimedia Commons · Kamu malı filmler | ✅ Odada açılır | Video dosyası linkleri tam senkron oynar |
| tabii (TRT İzle — trtizle.com buraya yönlenir) | ✅ Odada açılır | TRT’nin resmî ücretsiz platformu; bazı içerikler üyelik ister |
| puhutv | ✅ Odada açılır | Resmî, ücretsiz (reklamlı); bazı içerikler üyelik ister |
| Pluto TV | ✅ Odada açılır | Ücretsiz, reklamlı; her ülkede açık değil |
| YouTube · Filmler | ↗ Yeni sekmede | Film/video linkini yapıştırınca odada **senkron** oynar |
| Dailymotion | ↗ Yeni sekmede | Video linkleri odada resmî oynatıcıyla açılır |
| Vimeo · Staff Picks | ↗ Yeni sekmede | Video linkleri odada **senkron** oynar |
| Blender Studio · Açık Filmler | ↗ Yeni sekmede | Creative Commons animasyonlar |
| Tubi | ↗ Yeni sekmede | Ücretsiz, reklamlı; bölgeye göre değişir |
| Plex · Ücretsiz Filmler | ↗ Yeni sekmede | Ücretsiz, reklamlı; bölgeye göre değişir |
| ARTE · Sinema | ↗ Yeni sekmede | Avrupa kamu yayıncısı |
| NFB / ONF (Kanada) | ↗ Yeni sekmede | Ücretsiz belgesel/animasyon; bazıları bölge kısıtlı |
| Kanopy | ↗ Yeni sekmede | Kütüphane/üniversite üyeliğiyle ücretsiz |
| Library of Congress · National Screening Room | ↗ Yeni sekmede | Kamu malı film koleksiyonu |

### Odada tam senkron izlenebilen ücretsiz filmler

Hepsi doğrudan MP4/WebM dosyası olduğu için oynat/duraklat/sar/hız herkeste aynı anda uygulanır (Chrome’da oynatma doğrulandı).

| Film | Yıl | Lisans | Kaynak |
|---|---|---|---|
| Night of the Living Dead | 1968 | Kamu malı | archive.org/details/night_of_the_living_dead_dvd |
| His Girl Friday | 1940 | Kamu malı | archive.org/details/his_girl_friday |
| Nosferatu | 1922 | CC0 / kamu malı | archive.org/details/Nosferatu1922 |
| The General (Buster Keaton) | 1926 | Kamu malı | archive.org/details/TheGeneral_201312 |
| Charlie Chaplin Festivali | 1938 | Kamu malı | archive.org/details/charlie_chaplin_film_fest |
| Gulliver’in Gezileri | 1939 | Kamu malı | archive.org/details/gullivers_travels1939 |
| The Lost World | 1925 | Kamu malı | archive.org/details/lost_world |
| Dr. Caligari’nin Muayenehanesi | 1920 | Kamu malı | archive.org/details/DasKabinettdesDoktorCaligariTheCabinetofDrCaligari |
| Sita Sings the Blues | 2008 | CC0 | archive.org/details/Sita_Sings_the_Blues |
| Aya Yolculuk (Méliès) | 1902 | Kamu malı (kayıt CC BY) | archive.org/details/ATripToTheMoon20Fps |
| Tears of Steel | 2012 | CC BY (Blender) | archive.org/details/Tears-of-Steel |
| Sintel | 2010 | CC BY (Blender) | Wikimedia Commons |
| Big Buck Bunny | 2008 | CC BY (Blender) | archive.org/details/BigBuckBunny_124 |
| Elephants Dream | 2006 | CC BY (Blender) | archive.org/details/ElephantsDream |

## Orijinal koddaki “siteler açılmıyor” sorununun nedenleri

1. **Oda hiç kurulamıyordu.** Kod, Firebase ayarını yalnızca geliştirme ortamının enjekte ettiği `__firebase_config`
   değişkeninden okuyordu. Dosya normal bir tarayıcıda / sitede açılınca bu değişken yok → *“Sunucu yapılandırması bulunamadı”*,
   “Oda oluştur / Katıl” düğmeleri kapalı kalıyor; adres çubuğu da oda olmadan hiçbir şey açmıyordu.
2. **Siteler iframe içinde yasaklı.** Google, YouTube ana sayfası, Instagram, Netflix, Twitch, OK.ru, Rutube vb.
   `X-Frame-Options: SAMEORIGIN/DENY` veya CSP `frame-ancestors` gönderir; tarayıcı bu sayfaları başka sitenin içinde
   göstermez ve sonuç boş/gri bir çerçevedir.
3. **“Akıllı köprü” (açık CORS proxy) güvenilmez.** Testte (18 Kasım 2026) corsproxy.io 401 (anahtar gerekli) döndürdü,
   allorigins.win ve codetabs yanıt vermedi. Çalıştığında bile sayfanın HTML'ini başka bir adresten (srcdoc) gösterdiği için betikler,
   girişler, çerezler ve videolar bozuluyordu.
4. **`referrerpolicy="no-referrer"`** iframe'e konmuştu; YouTube gibi oynatıcılar Referer olmadan oynatmayı reddediyor (hata 153).
5. **Hazır örnek videolar ölü.** Google'ın `gtv-videos-bucket` (Big Buck Bunny, Sintel) adresleri artık *AccessDenied (403)*.
6. Twitch linki yalnızca `twitch.tv/kanal` biçiminde ve `parent` boşken çalışmayacak şekilde çevriliyordu; YouTube `t=` başlangıç
   zamanı, playlist, gizli Vimeo linkleri desteklenmiyordu.

## Neler düzeltildi

- Firebase bağımlılığı kaldırıldı. Oda mesajlaşması **herkese açık Nostr röleleri** (WSS, 443 portu) üzerinden yapılır:
  aynı anda 7 röleye bağlanılır, mesajlar hepsine gönderilir ve tekilleştirilir; bir röle çökse de oda çalışır.
  Mesajlar oda kodundan türetilen anahtarla (PBKDF2 → AES-GCM-256) **şifrelenir**; “geçici olay” (kind 25050) olarak
  gönderildiği için röleler saklamaz.
- Link çözümleyici baştan yazıldı (46 birim testi).
- Gömülemeyen siteler için sahte “boş sayfa” yerine açıklayıcı kart + yansıtma yolu.
- Proxy yolu **bilerek kaldırıldı** (aşağıya bakın).
- Doğru `allow` / `referrerpolicy="strict-origin-when-cross-origin"` öznitelikleri; web siteleri `sandbox` içinde açılır
  (sitenin bizim sayfamızı yönlendirmesi engellenir).
- Otomatik oynatma engellenirse sessiz başlatılır ve “Sesi açmak için dokun” düğmesi çıkar.
- Senkron: sürüm numaralı durum (çakışmalarda son yazan kazanır), konum cihaz saatinden bağımsız hesaplanır, son işlemi yapan
  kişi gerçek oynatıcı konumunu düzenli yayınlar.
- Kod modüler hale getirildi, harici Tailwind/FontAwesome CDN'leri kaldırıldı.

### Neden CORS proxy kullanılmıyor?

Proxy ile bir sitenin `X-Frame-Options`/CSP başlıklarını sökmek, o sitenin bilerek koyduğu bir güvenlik korumasını
(clickjacking ve oturum çalma önlemi) aşmak demektir. Ayrıca güvenilmez: ücretsiz proxy'ler kapanıyor veya ücretli oluyor,
giriş gerektiren siteler/videolar bu yolla zaten çalışmıyor ve tüm trafik üçüncü bir tarafın sunucusundan geçiyor.
Doğru çözüm, sitenin **resmi gömme oynatıcısını** kullanmak; yoksa siteyi **yeni sekmede açıp ekran yansıtmak**.

## Bilinen sınırlamalar

- Netflix, Disney+, Prime gibi DRM'li servisler hiçbir şekilde gömülemez; ekran yansıtmada da çoğu siyah görüntü verir (DRM).
- Gömülü oynatıcılarda (Dailymotion, Twitch, Drive, OK.ru…) link herkeste açılır ama oynat/duraklat kişiye özeldir
  (bu servisler dışarıdan kontrol API'si sunmaz veya kısıtlar).
- Web sitesi içinde tıklanan linkler senkronlanmaz (farklı alan adındaki iframe'in içi güvenlik gereği okunamaz).
  Herkesin görmesini istediğin sayfanın adresini adres çubuğuna yapıştır.
- Görüntülü görüşme kişiden kişiye kurulur; çok katı ağlarda (bazı şirket/okul ağları, bazı mobil operatörler) bağlantı
  için TURN sunucusu gerekir. `js/config.js` → `ICE_SERVERS` içine kendi TURN bilgini ekleyebilirsin. Mesh yapısı ~6 kameralı
  kişiye kadar idealdir.
- Ekran paylaşımı mobil tarayıcılarda genelde desteklenmez.
- Twitch ve YouTube oynatıcıları sayfanın **https** adresinden açılmasını ister; `cinesync.html` dosyasını bilgisayardan
  çift tıklayarak (file://) açarsan bu ikisi çalışmayabilir. Yayınlanmış adresi kullan.
- Herkese açık röleler ücretsiz gönüllü altyapıdır; hız sınırı veya geçici kesinti olabilir (birden fazla röle bu yüzden kullanılıyor).
  İstersen `js/config.js` → `RELAYS` listesini değiştirebilirsin.

## Dosya yapısı

```
index.html            Sayfa iskeleti
css/app.css           Tüm stiller
js/config.js          Röleler, STUN/TURN, gömmeyi yasaklayan site listesi, izinli siteler ve ücretsiz filmler
js/url-parser.js      Link çözümleyici (saf modül, test edilebilir)
js/net/relay-pool.js  Nostr röle havuzu (çoklu bağlantı, yeniden bağlanma, imzalama)
js/net/room-channel.js Şifreli oda kanalı (AES-GCM)
js/room.js            Oda protokolü: üyelik, oturum (epoch), saat eşitleme, oynatma durumu, sohbet, özel kod, yoklama
js/rtc.js             WebRTC görüntülü görüşme (perfect negotiation, ICE yeniden başlatma, bağlantı kalitesi)
js/stage.js           Oynatıcı motorları (HTML5/HLS, YouTube, Vimeo, iframe, engelli kartı, yansıtma)
js/app.js             Arayüz bağlantıları, tam ekran, kısayollar
js/pip.js             Tam ekranda yüzen kamera kutucukları
manifest.webmanifest, sw.js, icons/  PWA dosyaları
js/ui/*.js            DOM yardımcıları ve SVG ikonlar
js/vendor/schnorr.js  noble-curves (MIT) — Nostr imzası için
vendor/hls.min.js     hls.js (Apache-2.0)
dist/cinesync.html    Tek dosyalık sürüm (her şey satır içi)
scripts/build.mjs     Tek dosya derleyici
tests/                Birim + uçtan uca testler
```

## Çalıştırma ve yayınlama

Yerelde: `python3 -m http.server 8080` → http://localhost:8080 (kamera için https ya da localhost gerekir).

Statik barındırma — derleme adımı yok, klasörü olduğu gibi yükle:

- **GitHub Pages:** depoya yükle → Settings → Pages → *Deploy from branch* → `main` / root.
- **Netlify Drop:** https://app.netlify.com/drop adresine klasörü (veya yalnızca `dist/cinesync.html`'i `index.html` adıyla) sürükle.
- **Cloudflare Pages:** *Upload assets* ile klasörü yükle.
- Tek dosya istiyorsan `dist/cinesync.html` yeterlidir (hls.js gerekirse CDN'den yüklenir).

Geliştirme: `npm install` → `npm test` (link testleri) → `npm run build` (tek dosya) →
`node tests/e2e.mjs http://localhost:8080/` (iki tarayıcıyla uçtan uca test; Chrome gerekir) →
`node tests/devices.mjs chromium|webkit|firefox` (20 cihaz: telefon/tablet/dizüstü/masaüstü, dikey ve yatay, dokunmatik öykünme; ana sayfa gerçekten kayıyor mu, oda ekrana oturuyor mu, döndürme ve adres çubuğu değişimi; görüntüler `tests/shots/devices/`) →
`node tests/rooms.mjs http://localhost:8080/ chromium|firefox|webkit` (özel kod doğrulama, "kod kullanımda" uyarısı, boşalan odanın sıfırdan başlaması, uzun donmadan sonra temiz dönüş, şifreli oda ve yanlış şifre) →
`node tests/soak.mjs http://localhost:8080/ 11 firefox` (11 dk dayanıklılık: iki tarayıcı sesli+görüntülü; kaynak değiştirme, üçüncü kişinin girip çıkması, arka plana alma, ağ kopması, cihaz değişikliği; her adımda sesin aktığı ve video kayması ölçülür) →
`node tests/responsive.mjs` (13 ekran boyutunda ana sayfa, katalog, tam ekran kontrolleri ve emoji dahil taşma/yerleşim testi, ekran görüntüleri `tests/shots/responsive/`; `VP=390x844,1440x900` ile seçilebilir).

## Lisanslar

CineSync kodu: MIT. Dahil edilen kütüphaneler: noble-curves (MIT), hls.js (Apache-2.0). İkon çizimleri Lucide (ISC) tarzındadır.
