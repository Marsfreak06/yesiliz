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

  const ayar = { key, model: process.env.GEMINI_MODEL || 'gemini-2.5-flash' };
  try {
    await fn(govde, ayar);
  } catch (e) {
    cevap(res, 502, { hata: e.message || 'Gemini\'ye ulaşılamadı' });
  }
}

export async function gemini(ayar, govde) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(ayar.model)}:generateContent`;
  let r;
  try {
    r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': ayar.key },
      body: JSON.stringify(govde),
    });
  } catch {
    throw new Error('Gemini\'ye ulaşılamadı');
  }
  if (!r.ok) {
    console.error('Gemini', r.status, (await r.text()).slice(0, 500));
    throw new Error(`Gemini hata verdi (${r.status})`);
  }
  const json = await r.json();
  const metin = (json.candidates?.[0]?.content?.parts || [])
    .filter(p => !p.thought && typeof p.text === 'string')
    .map(p => p.text)
    .join('');
  if (!metin) throw new Error('Gemini boş yanıt verdi');
  return metin;
}
