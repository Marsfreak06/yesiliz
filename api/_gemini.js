// Ortak yardımcılar: istek kontrolü, hız sınırı ve Gemini çağrısı.
// Anahtar koda yazılmaz; Vercel'deki GEMINI_API_KEY ortam değişkeninden okunur.

import { dbVar, oturumKullanici } from './_db.js';

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
  // Hesap sistemi kuruluysa Gemini yalnızca giriş yapmış kullanıcılara açılır.
  if (dbVar() && !(await oturumKullanici(req).catch(() => null))) {
    return cevap(res, 401, { hata: 'Önce giriş yap' });
  }
  if (!hizSiniri(req, ad, limit)) return cevap(res, 429, { hata: 'Çok fazla istek gönderdin, biraz sonra tekrar dene' });

  let govde = req.body;
  if (typeof govde === 'string') { try { govde = JSON.parse(govde); } catch { govde = null; } }
  if (!govde || typeof govde !== 'object') return cevap(res, 400, { hata: 'Geçersiz istek' });

  // Model kapanırsa ya da yoğunsa sıradaki denenir.
  // Hepsi düşük düşünme seviyesiyle fotoğrafı birkaç saniyede inceliyor; daha büyük modeller çok yavaş.
  const modeller = [process.env.GEMINI_MODEL, 'gemini-3.5-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite']
    .filter((m, i, a) => m && a.indexOf(m) === i);
  const ayar = { key, modeller };
  try {
    await fn(govde, ayar);
  } catch (e) {
    cevap(res, 502, { hata: e.message || 'Gemini\'ye ulaşılamadı' });
  }
}

// 404: model kapatılmış, 429/5xx: geçici yoğunluk. Bu durumlarda sıradaki model denenir.
const SONRAKI_MODEL = new Set([404, 429, 500, 502, 503, 504]);
// Vercel'in süre sınırına takılmamak için toplam bekleme süresi.
const TOPLAM_SURE = 50_000;

export async function gemini(ayar, govde) {
  const bitis = Date.now() + TOPLAM_SURE;
  let r = null, sonHata = 'Gemini\'ye ulaşılamadı';
  for (const model of ayar.modeller) {
    let dusunme = true;
    for (let tekrar = 0; tekrar < 2; tekrar++) {
      const kalan = bitis - Date.now();
      if (kalan < 3000) { sonHata = 'Gemini çok uzun sürdü, tekrar dene'; break; }
      const istek = dusunme
        ? { ...govde, generationConfig: { ...govde.generationConfig, thinkingConfig: { thinkingLevel: 'low' } } }
        : govde;
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
      try {
        r = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': ayar.key },
          body: JSON.stringify(istek),
          signal: AbortSignal.timeout(Math.min(kalan, 15_000)),
        });
      } catch {
        r = null;
        sonHata = 'Gemini çok uzun sürdü, tekrar dene';
        break;
      }
      if (r.ok) break;
      const hata = (await r.text()).slice(0, 500);
      console.error('Gemini', model, r.status, hata);
      sonHata = `Gemini hata verdi (${r.status})`;
      // Düşünme seviyesini desteklemeyen modelde aynı istek ayarsız tekrar gönderilir.
      if (r.status === 400 && dusunme && /thinking/i.test(hata)) { dusunme = false; continue; }
      break;
    }
    if (r && r.ok) break;
    if (r && !SONRAKI_MODEL.has(r.status) && r.status !== 400) break;
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
