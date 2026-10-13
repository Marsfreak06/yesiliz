// Fidan ve temizlik haritası.
//   GET  /api/harita                                  → { fidanlar, alanlar }
//   POST /api/harita { islem: 'fidan', lat, lng, tur, ekip, jeton }
//   POST /api/harita { islem: 'alan', nokta: [[lat,lng]...], ad, ekip, jeton }
//   POST /api/harita { islem: 'sula', id, lat, lng }
//   POST /api/harita { islem: 'sil', tip: 'fidan' | 'alan', id }
// Fotoğraflar saklanmaz: ekleme için /api/dogrula'nın onay verdiğinde ürettiği tek kullanımlık jeton gerekir.
import { randomBytes } from 'node:crypto';
import {
  dbVar, redis, oturumBilgi, jsonOku, ciftler, govdeAl, cevap, gunNo, haftaNo, kullaniciAnahtari, adlariGetir,
} from './_db.js';

const SULAMA_MESAFESI = 150;      // metre
const EN_BUYUK_ALAN = 10_000;     // m²
const EN_KUCUK_ALAN = 10;         // m²
const GUNLUK_HAK = 5;             // kişi başı günde fidan / alan
const EKIP_UST = 4;
const HAFTALIK_SURE = 60 * 86400; // haftalık sıralama kayıtları 60 gün tutulur

const sayi = v => (typeof v === 'number' ? v : Number(v));
const gecerliKonum = (lat, lng) => Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
const yuvarla = v => Math.round(v * 1e6) / 1e6;
const kisaMetin = (v, n) => String(v || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);

function mesafe([lat1, lng1], [lat2, lng2]) {
  const r = Math.PI / 180, R = 6371000;
  const a = Math.sin((lat2 - lat1) * r / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin((lng2 - lng1) * r / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Küre üzerinde çokgen alanı (m²).
function alanHesapla(nokta) {
  const r = Math.PI / 180, R = 6378137;
  let t = 0;
  for (let i = 0; i < nokta.length; i++) {
    const [la1, lo1] = nokta[i], [la2, lo2] = nokta[(i + 1) % nokta.length];
    t += (lo2 - lo1) * r * (2 + Math.sin(la1 * r) + Math.sin(la2 * r));
  }
  return Math.abs(t * R * R / 2);
}

async function jetonKullan(jeton, anahtar, gorev) {
  if (typeof jeton !== 'string' || !/^[a-f0-9]{48}$/.test(jeton)) return false;
  const deger = await redis('GET', 'dogrulama:' + jeton);
  if (deger !== `${anahtar}|${gorev}`) return false;
  await redis('DEL', 'dogrulama:' + jeton);
  return true;
}

async function gunlukHakVar(anahtar, tur) {
  const k = `gunluk:${tur}:${anahtar}:${gunNo()}`;
  const n = await redis('INCR', k);
  if (n === 1) await redis('EXPIRE', k, 90000);
  return n <= GUNLUK_HAK;
}

async function haftalikEkle(tur, anahtarlar, miktar, hafta = haftaNo()) {
  const k = `h:${hafta}:${tur}`;
  for (const a of anahtarlar) await redis('ZINCRBY', k, miktar, a);
  await redis('EXPIRE', k, HAFTALIK_SURE);
}

// Etiketlenen kişilerin gerçekten arkadaş olduğu doğrulanır.
async function ekipHazirla(sahip, liste) {
  const adlar = (Array.isArray(liste) ? liste : []).slice(0, EKIP_UST).map(kullaniciAnahtari).filter(a => a && a !== sahip);
  const ekip = [];
  for (const a of [...new Set(adlar)]) {
    if (await redis('SISMEMBER', 'arkadas:' + sahip, a)) ekip.push(a);
  }
  const gorunen = await adlariGetir(ekip);
  return ekip.filter(a => gorunen[a]).map(a => ({ a, ad: gorunen[a] }));
}

export default async function handler(req, res) {
  if (!dbVar()) return cevap(res, 503, { kod: 'veritabani-yok', hata: 'Harita için hesap sistemi gerekli' });

  try {
    if (req.method === 'GET') {
      const [f, a] = await Promise.all([redis('HGETALL', 'fidanlar'), redis('HGETALL', 'alanlar')]);
      return cevap(res, 200, {
        fidanlar: ciftler(f).map(([, v]) => jsonOku(v)).filter(Boolean),
        alanlar: ciftler(a).map(([, v]) => jsonOku(v)).filter(Boolean),
        simdi: Date.now(),
      });
    }
    if (req.method !== 'POST') return cevap(res, 405, { hata: 'Desteklenmeyen istek' });

    const ben = await oturumBilgi(req);
    if (!ben) return cevap(res, 401, { hata: 'Önce giriş yap' });
    const g = govdeAl(req);
    if (!g) return cevap(res, 400, { hata: 'Geçersiz istek' });

    if (g.islem === 'fidan') {
      const lat = sayi(g.lat), lng = sayi(g.lng);
      if (!gecerliKonum(lat, lng)) return cevap(res, 400, { hata: 'Konum geçersiz' });
      if (!await jetonKullan(g.jeton, ben.anahtar, 'fidan')) return cevap(res, 403, { hata: 'Önce fidan fotoğrafını doğrulat' });
      if (!await gunlukHakVar(ben.anahtar, 'fidan')) return cevap(res, 429, { hata: `Günde en fazla ${GUNLUK_HAK} fidan ekleyebilirsin` });
      const ekip = await ekipHazirla(ben.anahtar, g.ekip);
      const kayit = {
        id: randomBytes(6).toString('hex'), lat: yuvarla(lat), lng: yuvarla(lng),
        tur: kisaMetin(g.tur, 30) || 'Fidan', sahip: ben.anahtar, ad: ben.ad, ekip,
        t: Date.now(), sulama: 0, sonSulama: null, sonSulayan: null,
      };
      await redis('HSET', 'fidanlar', kayit.id, JSON.stringify(kayit));
      await redis('SADD', 'benim:' + ben.anahtar, 'f:' + kayit.id);
      await haftalikEkle('fidan', [ben.anahtar, ...ekip.map(e => e.a)], 1);
      return cevap(res, 200, { fidan: kayit });
    }

    if (g.islem === 'alan') {
      const nokta = (Array.isArray(g.nokta) ? g.nokta : []).map(p => [sayi(p?.[0]), sayi(p?.[1])]);
      if (nokta.length < 3 || nokta.length > 40 || !nokta.every(([la, lo]) => gecerliKonum(la, lo))) {
        return cevap(res, 400, { hata: 'Alanı en az 3, en fazla 40 köşeyle çiz' });
      }
      const m2 = Math.round(alanHesapla(nokta));
      if (m2 < EN_KUCUK_ALAN) return cevap(res, 400, { hata: 'Alan çok küçük, köşeleri biraz daha geniş çiz' });
      if (m2 > EN_BUYUK_ALAN) return cevap(res, 400, { hata: `Bir alan en fazla ${EN_BUYUK_ALAN.toLocaleString('tr-TR')} m² olabilir` });
      if (!await jetonKullan(g.jeton, ben.anahtar, 'temizlik')) return cevap(res, 403, { hata: 'Önce temizlik fotoğrafını doğrulat' });
      if (!await gunlukHakVar(ben.anahtar, 'alan')) return cevap(res, 429, { hata: `Günde en fazla ${GUNLUK_HAK} alan ekleyebilirsin` });
      const ekip = await ekipHazirla(ben.anahtar, g.ekip);
      const kayit = {
        id: randomBytes(6).toString('hex'), nokta: nokta.map(([la, lo]) => [yuvarla(la), yuvarla(lo)]), m2,
        isim: kisaMetin(g.ad, 40), sahip: ben.anahtar, ad: ben.ad, ekip, t: Date.now(),
      };
      await redis('HSET', 'alanlar', kayit.id, JSON.stringify(kayit));
      await redis('SADD', 'benim:' + ben.anahtar, 'a:' + kayit.id);
      await haftalikEkle('alan', [ben.anahtar, ...ekip.map(e => e.a)], m2);
      return cevap(res, 200, { alan: kayit });
    }

    if (g.islem === 'sula') {
      const id = String(g.id || '');
      const f = jsonOku(await redis('HGET', 'fidanlar', id));
      if (!f) return cevap(res, 404, { hata: 'Fidan bulunamadı' });
      const lat = sayi(g.lat), lng = sayi(g.lng);
      if (!gecerliKonum(lat, lng)) return cevap(res, 400, { hata: 'Konumun alınamadı' });
      const uzaklik = Math.round(mesafe([lat, lng], [f.lat, f.lng]));
      if (uzaklik > SULAMA_MESAFESI) {
        return cevap(res, 403, { hata: `Sulamak için fidanın yanında olmalısın. Şu an yaklaşık ${uzaklik.toLocaleString('tr-TR')} m uzaktasın.` });
      }
      const ilk = await redis('SET', `sulama:${id}:${ben.anahtar}:${gunNo()}`, '1', 'NX', 'EX', 90000);
      if (ilk !== 'OK') return cevap(res, 409, { hata: 'Bu fidanı bugün zaten suladın' });
      f.sulama = (f.sulama || 0) + 1;
      f.sonSulama = Date.now();
      f.sonSulayan = ben.ad;
      await redis('HSET', 'fidanlar', id, JSON.stringify(f));
      await haftalikEkle('sulama', [ben.anahtar], 1);
      return cevap(res, 200, { fidan: f });
    }

    if (g.islem === 'sil') {
      const tip = g.tip === 'alan' ? 'alan' : 'fidan';
      const tablo = tip === 'alan' ? 'alanlar' : 'fidanlar';
      const id = String(g.id || '');
      const k = jsonOku(await redis('HGET', tablo, id));
      if (!k) return cevap(res, 404, { hata: 'Kayıt bulunamadı' });
      if (k.sahip !== ben.anahtar) return cevap(res, 403, { hata: 'Sadece kendi eklediğini silebilirsin' });
      await redis('HDEL', tablo, id);
      await redis('SREM', 'benim:' + ben.anahtar, (tip === 'alan' ? 'a:' : 'f:') + id);
      // Aynı hafta içinde silinirse haftalık sıralamadan da düşülür.
      if (haftaNo(k.t) === haftaNo()) {
        await haftalikEkle(tip, [k.sahip, ...(k.ekip || []).map(e => e.a)], tip === 'alan' ? -k.m2 : -1);
      }
      return cevap(res, 200, { tamam: true });
    }

    return cevap(res, 400, { hata: 'Geçersiz istek' });
  } catch (e) {
    console.error('harita', e);
    return cevap(res, 500, { hata: 'Sunucuda bir sorun oldu, biraz sonra tekrar dene.' });
  }
}
