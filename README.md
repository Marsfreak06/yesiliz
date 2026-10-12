# Yeşiliz

Öğrencilerin her gün küçük bir çevre görevi yapıp seri, puan ve rozet topladığı iklim uygulaması.

- Günlük seri, rütbeler ve 7 günlük seri bonusu
- Arkadaşla ortak seri ve ortak maskot Filiz
- Gemini ile fotoğraflı görev doğrulama
- Günlük quiz, günün sözü, haftalık lig
- Puan mağazası, rozetler, sosyal akış
- Yaprak: iklim sorularını yanıtlayan chatbot
- Kullanıcı adı ve şifreyle hesap; ilerleme hesapta saklanır

## Yayınlama (Vercel)

1. Bu depoyu Vercel'e bağla (Add New → Project → depoyu seç → Deploy).
2. Project Settings → Environment Variables bölümüne ekle:
   - `GEMINI_API_KEY`: Google AI Studio'dan alınan anahtar
   - `GEMINI_MODEL` (isteğe bağlı): boş bırakılırsa `gemini-3.5-flash`, sonra yedek modeller denenir
3. Değişkeni ekledikten sonra Deployments → son yayın → Redeploy.

`api` klasöründeki dosyalar `/api/dogrula` ve `/api/sohbet` adreslerinde çalışır. Anahtar hiçbir zaman depoya yazılmaz.

## Hesap sistemi (Upstash Redis)

1. Vercel'de projeyi aç → Storage → Create Database → Upstash for Redis (ücretsiz plan) → projeye bağla.
2. Vercel bağlantı bilgilerini (`KV_REST_API_URL`, `KV_REST_API_TOKEN`) projeye kendisi ekler. Sonra Redeploy.
3. Veritabanı bağlı değilse site hesapsız çalışır, ilerleme yalnızca o cihazda tutulur.

Şifreler scrypt ile tuzlanarak saklanır; oturum HttpOnly çerezle tutulur. Hesap sistemi kuruluyken Gemini uçları yalnızca giriş yapmış kullanıcılara açıktır.

## Sunum modu

Adresin sonuna `#demo` eklenirse (ör. `https://yesiliz.space/#demo`) günleri ileri alma, örnek veri yükleme ve bildirim önizleme düğmeleri görünür.

