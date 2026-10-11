# Yeşiliz

Öğrencilerin her gün küçük bir çevre görevi yapıp seri, puan ve rozet topladığı iklim uygulaması.

- Günlük seri, rütbeler ve 7 günlük seri bonusu
- Arkadaşla ortak seri ve ortak maskot Filiz
- Gemini ile fotoğraflı görev doğrulama
- Günlük quiz, günün sözü, haftalık lig
- Puan mağazası, rozetler, sosyal akış
- Yaprak: iklim sorularını yanıtlayan chatbot

## Yayınlama (Vercel)

1. Bu depoyu Vercel'e bağla (Add New → Project → depoyu seç → Deploy).
2. Project Settings → Environment Variables bölümüne ekle:
   - `GEMINI_API_KEY`: Google AI Studio'dan alınan anahtar
   - `GEMINI_MODEL` (isteğe bağlı): boş bırakılırsa `gemini-3.5-flash`, sonra yedek modeller denenir
3. Değişkeni ekledikten sonra Deployments → son yayın → Redeploy.

`api` klasöründeki dosyalar `/api/dogrula` ve `/api/sohbet` adreslerinde çalışır. Anahtar hiçbir zaman depoya yazılmaz.
