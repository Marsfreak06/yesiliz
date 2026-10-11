// Ortak yardımcılar: istek kontrolü, hız sınırı ve Gemini çağrısı.
// Anahtar koda yazılmaz; Vercel'deki GEMINI_API_KEY ortam değişkeninden okunur.

const kayitlar = new Map();

export function cevap(res, kod, veri) {
  res.setHeader('Cache-Control', 'no-store');
  res.status(kod).json(veri);
}

function hizSiniri(req, ad, limit) {
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'yok';
  const anahtar = ad + ':' + ip;
  const simdi = Date.now();
  const liste = (kayitlar.get(anahtar) || []).filter(t => t > simdi - 3600_000);
  if (liste.length >= limit) return false;
  liste.push(simdi);
  kayitlar.set(anahtar, liste);
  return true;
}

export async function islem(req, res, ad, limit, fn) {
  if (req.method !== 'POST') return cevap(res, 405, { hata: 'Yalnızca POST kabul edilir' });
  const key = process.env.GEMINI_API_KEY;
  if (!key) return cevap(res, 503, { hata: 'Gemini anahtarı henüz girilmemiş' });
  if (!hizSiniri(req, ad, limit)) return cevap(res, 429, { hata: 'Çok fazla istek gönderdin, biraz sonra tekrar dene' });

  let govde = req.body;
  if (typeof govde === 'string') { try { govde = JSON.parse(govde); } catch { govde = null; } }
  if (!govde || typeof govde !== 'object') return cevap(res, 400, { hata: 'Geçersiz istek' });

  // Model kapanırsa ya da yoğunsa sıradaki denenir.
  const modeller = [process.env.GEMINI_MODEL, 'gemini-3.8-flash', 'gemini-3.5-flash', 'gemini-flash-latest']
    .filter((m, i, a) => m && a.indexOf(m) === i);
  const ayar = { key, modeller };
  try {
    await fn(govde, ayar);
  } catch (e) {
    cevap(res, 502, { hata: e.message || 'Gemini\'ye ulaşılamadı' });
  }
}

// 404: model kapatılmış, 429/500/503: geçici yoğunluk. Bu durumlarda sıradaki model denenir.
const SONRAKI_MODEL = new Set([404, 429, 500, 503]);

export async function gemini(ayar, govde) {
  let r, sonHata = 'Gemini\'ye ulaşılamadı';
  for (const model of ayar.modeller) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    try {
      r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': ayar.key },
        body: JSON.stringify(govde),
      });
    } catch {
      r = null;
      continue;
    }
    if (r.ok) break;
    console.error('Gemini', model, r.status, (await r.text()).slice(0, 500));
    sonHata = `Gemini hata verdi (${r.status})`;
    if (!SONRAKI_MODEL.has(r.status)) break;
  }
  if (!r || !r.ok) throw new Error(sonHata);
  const json = await r.json();
  const metin = (json.candidates?.[0]?.content?.parts || [])
    .filter(p => !p.thought && typeof p.text === 'string')
    .map(p => p.text)
    .join('');
  if (!metin) throw new Error('Gemini boş yanıt verdi');
  return metin;
}
