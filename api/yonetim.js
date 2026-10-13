// Yönetici paneli. Şifre koda yazılmaz; Vercel'deki ADMIN_SIFRE ortam değişkeninden okunur.
//   GET  /api/yonetim?islem=durum          → { yonetici: true|false, kurulu: true|false }
//   GET  /api/yonetim?islem=kullanicilar   → { kullanicilar: [...] }
//   GET  /api/yonetim?islem=icerik         → { fidanlar, alanlar, degerlendirmeler, fiyat }
//   POST /api/yonetim { islem: 'giris', sifre } | { islem: 'cikis' }
//   POST /api/yonetim { islem: 'hediye', ad, miktar, not }
//   POST /api/yonetim { islem: 'fiyat', fiyatlar: { ürünKimliği: puan | null } }
//   POST /api/yonetim { islem: 'sil', tip: 'fidan' | 'alan' | 'gonderi', id }
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { dbVar, redis, cerezOku, jsonOku, ciftler, govdeAl, cevap, haftaNo, kullaniciAnahtari } from './_db.js';
import { gonderiSil } from './akis.js';

const OTURUM = 8 * 3600;           // yönetici oturumu 8 saat
const HEDIYE_UST = 100_000;
const FIYAT_UST = 100_000;

const ozet = s => createHash('sha256').update(String(s)).digest();
const jetonGecerli = t => typeof t === 'string' && /^[a-f0-9]{64}$/.test(t);

function cerezYaz(res, jeton, sure) {
  res.setHeader('Set-Cookie', `yonetici=${jeton}; HttpOnly; Secure; SameSite=Strict; Path=/api/yonetim; Max-Age=${sure}`);
}

async function yoneticiMi(req) {
  const t = cerezOku(req, 'yonetici');
  return jetonGecerli(t) && (await redis('GET', 'yonetici:' + t)) === '1';
}

// Aynı IP'den 15 dakikada en fazla 5 yönetici girişi denemesi.
async function denemeHakkiVar(req) {
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'yok';
  const k = 'deneme:yonetim:' + ip;
  const n = await redis('INCR', k);
  if (n === 1) await redis('EXPIRE', k, 900);
  return n <= 5;
}

async function tumKullanicilar() {
  const anahtarlar = [];
  let imlec = '0';
  for (let i = 0; i < 100; i++) {
    const [yeni, liste] = await redis('SCAN', imlec, 'MATCH', 'kullanici:*', 'COUNT', 500);
    anahtarlar.push(...liste);
    imlec = String(yeni);
    if (imlec === '0') break;
  }
  if (!anahtarlar.length) return [];
  const kayitlar = await redis('MGET', ...anahtarlar);
  const durumlar = await redis('MGET', ...anahtarlar.map(k => 'durum:' + k.slice('kullanici:'.length)));
  return anahtarlar.map((k, i) => {
    const u = jsonOku(kayitlar[i]);
    if (!u) return null;
    const d = jsonOku(durumlar[i]) || {};
    return {
      ad: u.ad, olusturma: u.olusturma,
      puan: Number(d.points) || 0, toplam: Number(d.earned) || 0, seri: Number(d.streak) || 0,
      enUzun: Number(d.best) || 0, sonAktif: d.last || null, gorev: Number(d.total) || 0,
    };
  }).filter(Boolean).sort((a, b) => b.toplam - a.toplam);
}

export default async function handler(req, res) {
  if (!dbVar()) return cevap(res, 503, { hata: 'Veritabanı bağlı değil' });
  const sifre = process.env.ADMIN_SIFRE;

  try {
    if (req.method === 'GET') {
      const q = req.query || {};
      if (q.islem === 'durum') return cevap(res, 200, { yonetici: await yoneticiMi(req), kurulu: Boolean(sifre) });
      if (!await yoneticiMi(req)) return cevap(res, 401, { hata: 'Yönetici girişi gerekli' });
      if (q.islem === 'kullanicilar') return cevap(res, 200, { kullanicilar: await tumKullanicilar() });
      if (q.islem === 'icerik') {
        const [f, a, d, p, gn] = await Promise.all([
          redis('HGETALL', 'fidanlar'), redis('HGETALL', 'alanlar'), redis('HGETALL', 'degerlendirmeler'), redis('HGETALL', 'magaza:fiyat'),
          redis('HGETALL', 'akis:gonderi'),
        ]);
        const fiyat = {};
        for (const [id, v] of ciftler(p)) fiyat[id] = Number(v);
        return cevap(res, 200, {
          fidanlar: ciftler(f).map(([, v]) => jsonOku(v)).filter(Boolean).sort((x, y) => y.t - x.t),
          alanlar: ciftler(a).map(([, v]) => jsonOku(v)).filter(Boolean).sort((x, y) => y.t - x.t),
          degerlendirmeler: ciftler(d).map(([, v]) => jsonOku(v)).filter(Boolean).sort((x, y) => y.t - x.t),
          gonderiler: ciftler(gn).map(([, v]) => jsonOku(v)).filter(Boolean).sort((x, y) => y.t - x.t),
          fiyat,
        });
      }
      return cevap(res, 400, { hata: 'Geçersiz istek' });
    }

    if (req.method !== 'POST') return cevap(res, 405, { hata: 'Desteklenmeyen istek' });
    const g = govdeAl(req);
    if (!g) return cevap(res, 400, { hata: 'Geçersiz istek' });

    if (g.islem === 'giris') {
      if (!sifre) return cevap(res, 503, { hata: "Yönetici şifresi henüz tanımlanmamış. Vercel'de ADMIN_SIFRE ayarını ekle." });
      if (!await denemeHakkiVar(req)) return cevap(res, 429, { hata: 'Çok fazla deneme. 15 dakika sonra tekrar dene.' });
      if (!timingSafeEqual(ozet(g.sifre || ''), ozet(sifre))) return cevap(res, 401, { hata: 'Şifre yanlış' });
      const jeton = randomBytes(32).toString('hex');
      await redis('SET', 'yonetici:' + jeton, '1', 'EX', OTURUM);
      cerezYaz(res, jeton, OTURUM);
      return cevap(res, 200, { tamam: true });
    }
    if (g.islem === 'cikis') {
      const t = cerezOku(req, 'yonetici');
      if (jetonGecerli(t)) await redis('DEL', 'yonetici:' + t);
      cerezYaz(res, '', 0);
      return cevap(res, 200, { tamam: true });
    }

    if (!await yoneticiMi(req)) return cevap(res, 401, { hata: 'Yönetici girişi gerekli' });

    if (g.islem === 'hediye') {
      const anahtar = kullaniciAnahtari(g.ad);
      const u = jsonOku(await redis('GET', 'kullanici:' + anahtar));
      if (!u) return cevap(res, 404, { hata: 'Kullanıcı bulunamadı' });
      const miktar = Math.round(Number(g.miktar));
      if (!(miktar >= 1 && miktar <= HEDIYE_UST)) return cevap(res, 400, { hata: `Hediye 1 ile ${HEDIYE_UST.toLocaleString('tr-TR')} puan arasında olmalı` });
      const not = String(g.not || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 140);
      await redis('RPUSH', 'hediye:' + anahtar, JSON.stringify({ miktar, not, t: Date.now() }));
      await redis('EXPIRE', 'hediye:' + anahtar, 90 * 86400);
      return cevap(res, 200, { tamam: true, ad: u.ad, miktar });
    }

    if (g.islem === 'fiyat') {
      const fiyatlar = g.fiyatlar && typeof g.fiyatlar === 'object' ? g.fiyatlar : {};
      let n = 0;
      for (const [id, p] of Object.entries(fiyatlar).slice(0, 200)) {
        if (!/^[a-z]_[a-z0-9_]{1,30}$/.test(id)) continue;
        if (p === null || p === '') { await redis('HDEL', 'magaza:fiyat', id); n++; continue; }
        const v = Math.round(Number(p));
        if (!(v >= 0 && v <= FIYAT_UST)) return cevap(res, 400, { hata: `Fiyat 0 ile ${FIYAT_UST.toLocaleString('tr-TR')} arasında olmalı` });
        await redis('HSET', 'magaza:fiyat', id, v); n++;
      }
      return cevap(res, 200, { tamam: true, degisen: n });
    }

    if (g.islem === 'sil' && g.tip === 'gonderi') {
      await gonderiSil(String(g.id || ''));
      return cevap(res, 200, { tamam: true });
    }

    if (g.islem === 'sil') {
      const tip = g.tip === 'alan' ? 'alan' : 'fidan';
      const tablo = tip === 'alan' ? 'alanlar' : 'fidanlar';
      const id = String(g.id || '');
      const k = jsonOku(await redis('HGET', tablo, id));
      if (!k) return cevap(res, 404, { hata: 'Kayıt bulunamadı' });
      await redis('HDEL', tablo, id);
      await redis('SREM', 'benim:' + k.sahip, (tip === 'alan' ? 'a:' : 'f:') + id);
      // Aynı hafta içinde silinirse haftalık sıralamadan da düşülür.
      if (haftaNo(k.t) === haftaNo()) {
        const key = `h:${haftaNo()}:${tip}`;
        for (const a of [k.sahip, ...(k.ekip || []).map(e => e.a)]) await redis('ZINCRBY', key, tip === 'alan' ? -k.m2 : -1, a);
      }
      return cevap(res, 200, { tamam: true });
    }

    return cevap(res, 400, { hata: 'Geçersiz istek' });
  } catch (e) {
    console.error('yonetim', e);
    return cevap(res, 500, { hata: 'Sunucuda bir sorun oldu.' });
  }
}
