# Yeşiliz

Öğrencilerin her gün küçük bir çevre görevi yapıp seri, puan ve rozet topladığı iklim uygulaması.

- Günlük seri, rütbeler ve 7 günlük seri bonusu
- Arkadaşlarla ortak seri (ikisi de aynı gün görev yaparsa) ve dürtme
- Kayıtta okul seçimi ve okullar arası haftalık yarış
- Herkese açık Yeşil Akış (paylaşım, beğeni, +2 puan)
- Seri Dostu Filiz, puan mağazası, rozetler
- Gemini ile fotoğraflı görev doğrulama (fotoğraflar saklanmaz)
- Yeşil Harita: dikilen fidanlar (kim, ne zaman, son sulama) ve çöpten temizlenen alanlar
- Fidan sulama (fidanın 150 m yakınında olmak gerekir)
- Arkadaş ekleme ve birlikte yapılan işlerde arkadaşları etiketleme
- Haftalık şampiyonlar: fidan, temizlenen m², sulama ve puan
- Günlük quiz, günün sözü, sosyal akış, Yaprak chatbotu
- Kullanıcı adı ve şifreyle hesap, profil fotoğrafı
- Doğrulama fotoğrafları yalnızca uygulama içi kamerayla çekilir
- Çöp Yılanı mini oyunu (günde en fazla 30 puan)
- Filiz için şapka, gözlük, aksesuar, kıyafet ve renk seçenekleri

## Yayınlama (Vercel)

1. Bu depoyu Vercel'e bağla (Add New → Project → depoyu seç → Deploy).
2. Project Settings → Environment Variables bölümüne ekle:
   - `GEMINI_API_KEY`: Google AI Studio'dan alınan anahtar
   - `GEMINI_MODEL` (isteğe bağlı): boş bırakılırsa `gemini-3.5-flash`, sonra yedek modeller denenir
3. Değişkeni ekledikten sonra Deployments → son yayın → Redeploy.

`api` klasöründeki her dosya bir uç noktadır: `/api/dogrula`, `/api/sohbet`, `/api/hesap`, `/api/harita`, `/api/sosyal`, `/api/akis`, `/api/yonetim`. `_` ile başlayan dosyalar ortak yardımcılardır. Anahtar hiçbir zaman depoya yazılmaz.

## Veritabanı (Redis)

Vercel'de Storage bölümünden bir Redis veritabanı oluşturup projeye bağla. İki tür desteklenir:

- Redis Cloud vb.: `REDIS_URL`
- Upstash (REST): `KV_REST_API_URL` + `KV_REST_API_TOKEN`

Veritabanı bağlı değilse site hesapsız çalışır, ilerleme yalnızca o cihazda tutulur, harita ve arkadaşlar kapalıdır.

Şifreler scrypt ile tuzlanarak saklanır; oturum HttpOnly çerezle tutulur. Hesap sistemi kuruluyken Gemini uçları yalnızca giriş yapmış kullanıcılara açıktır.

### Hileye karşı kurallar

- Haritaya fidan ve alan yalnızca Gemini'nin onayladığı fotoğraftan sonra üretilen tek kullanımlık jetonla eklenebilir.
- Kişi başı günde en fazla 5 fidan ve 5 alan; bir alan 10–10.000 m².
- Etiketlenen kişiler gerçekten arkadaş olmalı (en fazla 4).
- Bir fidan aynı kişi tarafından günde bir kez sulanabilir.

### Şampiyonluk puanı

`fidan × 100 + temizlenen m² ÷ 10 + sulama × 25 + haftalık puan ÷ 10`, haftalar pazartesi (Türkiye saati) başlar.

## Yönetici paneli

Vercel'de `ADMIN_SIFRE` ortam değişkenini ekle (Production) ve yeniden yayınla. Giriş ekranının sağ altındaki ve Ayarlar'ın en altındaki "Yönetici" bağlantısından şifreyle girilir. Panelde: kullanıcı listesi ve hediye puan gönderme, mağaza fiyatlarını değiştirme, haritadaki fidan ve alanları silme, değerlendirme yorumlarını okuma. Yönetici oturumu 8 saat sürer; aynı IP'den 15 dakikada en fazla 5 giriş denemesi yapılabilir.

## Harita

Leaflet 1.9 ve OpenStreetMap karoları (© OpenStreetMap katkıcıları) kullanılır; anahtar gerekmez.

## Sunum modu

Adresin sonuna `#demo` eklenirse (ör. `https://yesiliz.space/#demo`) günleri ileri alma, örnek veri yükleme ve bildirim önizleme düğmeleri görünür.
