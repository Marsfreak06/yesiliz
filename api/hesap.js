// Hesap işlemleri: kayıt, giriş, çıkış, oturum bilgisi ve ilerleme kaydı.
//   GET  /api/hesap                      → { kullanici, durum } ya da 401
//   POST /api/hesap { islem: 'kayit' | 'giris', ad, sifre }
//   POST /api/hesap { islem: 'cikis' }
//   POST /api/hesap { islem: 'okul', okul } → okul adını kaydeder
//   POST /api/hesap { islem: 'adDegistir', ad } → kullanıcı adını değiştirir (günde bir kez), kayıtları taşır
//   PUT  /api/hesap { durum }            → ilerlemeyi kaydeder
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { hesabiTemizle } from './_hesapsil.js';
import { hesabiTasi } from './_hesaptasi.js';
import { dbVar, redis, cerezOku, gecerliJeton, oturumKullanici, oturumDegeri, sifreOzeti, haftaNo, gunNo } from './_db.js';

// Oturum 180 gün sürer ve site her açıldığında yenilenir; düzenli kullanan bir daha şifre girmez.
const OTURUM_SURESI = 60 * 60 * 24 * 180;
const AD_KURALI = /^[a-zA-Z0-9_.çğıöşüÇĞİÖŞÜ]{3,20}$/;
const EN_BUYUK_DURUM = 300_000;
const HAFTALIK_PUAN_UST = 3000;
const AD_BEKLEME = 24 * 3600_000;

function cevap(res, kod, veri) {
  res.setHeader('Cache-Control', 'no-store');
  res.status(kod).json(veri);
}

function cerezYaz(res, jeton, sure) {
  res.setHeader('Set-Cookie', `oturum=${jeton}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${sure}`);
}

function govdeAl(req) {
  let g = req.body;
  if (typeof g === 'string') { try { g = JSON.parse(g); } catch { g = null; } }
  return g && typeof g === 'object' ? g : null;
}

// Aynı IP'den 15 dakikada en fazla 20 giriş / kayıt denemesi.
async function denemeHakkiVar(req) {
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'yok';
  const anahtar = 'deneme:' + ip;
  const sayi = await redis('INCR', anahtar);
  if (sayi === 1) await redis('EXPIRE', anahtar, 900);
  return sayi <= 20;
}

async function oturumAc(res, anahtar, olusturma) {
  const jeton = randomBytes(32).toString('hex');
  await redis('SET', 'oturum:' + jeton, oturumDegeri(anahtar, olusturma), 'EX', OTURUM_SURESI);
  cerezYaz(res, jeton, OTURUM_SURESI);
}

const okulAnahtari = o => o.toLocaleLowerCase('tr-TR');
const okulTemizle = o => String(o || '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
// Gün numarasını istemcinin kullandığı "yyyy-aa-gg" biçimine çevirir.
const gunMetni = n => new Date(n * 86400_000).toISOString().slice(0, 10);

async function kullaniciAl(anahtar) {
  const ham = await redis('GET', 'kullanici:' + anahtar);
  try { return ham ? JSON.parse(ham) : null; } catch { return null; }
}

async function durumAl(anahtar) {
  const ham = await redis('GET', 'durum:' + anahtar);
  try { return ham ? JSON.parse(ham) : null; } catch { return null; }
}

export default async function handler(req, res) {
  if (!dbVar()) return cevap(res, 503, { kod: 'veritabani-yok', hata: 'Hesap sistemi henüz kurulmadı' });

  try {
    if (req.method === 'GET') {
      const anahtar = await oturumKullanici(req);
      const k = anahtar && await kullaniciAl(anahtar);
      if (!k) return cevap(res, 401, { hata: 'Giriş yapılmadı' });
      const jeton = cerezOku(req, 'oturum');
      await redis('EXPIRE', 'oturum:' + jeton, OTURUM_SURESI);
      cerezYaz(res, jeton, OTURUM_SURESI);
      return cevap(res, 200, { kullanici: k.ad, okul: k.okul || null, durum: await durumAl(anahtar) });
    }

    if (req.method === 'PUT') {
      const anahtar = await oturumKullanici(req);
      if (!anahtar) return cevap(res, 401, { hata: 'Oturumun kapanmış, tekrar giriş yap' });
      const g = govdeAl(req);
      if (!g || !g.durum || typeof g.durum !== 'object') return cevap(res, 400, { hata: 'Geçersiz istek' });
      const metin = JSON.stringify(g.durum);
      if (metin.length > EN_BUYUK_DURUM) return cevap(res, 413, { hata: 'Kayıt çok büyük' });
      await redis('SET', 'durum:' + anahtar, metin);
      // Ortak seriler için kullanıcının aktif olduğu günler tutulur (son 120 gün).
      const bugun = gunNo();
      if (!g.durum.offset && g.durum.last === gunMetni(bugun)) {
        await redis('ZADD', 'aktif:' + anahtar, bugun, bugun);
        await redis('ZREMRANGEBYSCORE', 'aktif:' + anahtar, 0, bugun - 120);
      }
      // Haftalık puan şampiyonluk sıralamasına yazılır (sunum modunda gün kaydırılmışsa yazılmaz).
      const d = g.durum;
      if (!d.offset && Number(d.weekIdx) === haftaNo() && Number.isFinite(Number(d.week))) {
        const k = `h:${haftaNo()}:puan`;
        await redis('ZADD', k, Math.max(0, Math.min(HAFTALIK_PUAN_UST, Math.round(Number(d.week)))), anahtar);
        await redis('EXPIRE', k, 60 * 86400);
      }
      return cevap(res, 200, { tamam: true });
    }

    if (req.method !== 'POST') return cevap(res, 405, { hata: 'Desteklenmeyen istek' });
    const g = govdeAl(req);
    if (!g) return cevap(res, 400, { hata: 'Geçersiz istek' });

    if (g.islem === 'okul') {
      const anahtar = await oturumKullanici(req);
      const k = anahtar && await kullaniciAl(anahtar);
      if (!k) return cevap(res, 401, { hata: 'Oturumun kapanmış, tekrar giriş yap' });
      const okul = okulTemizle(g.okul);
      if (okul.length < 3) return cevap(res, 400, { hata: 'Okulunun adını yaz (en az 3 harf).' });
      const yeni = okulAnahtari(okul);
      if (k.okul && okulAnahtari(k.okul) !== yeni) await redis('HINCRBY', 'okul:uye', okulAnahtari(k.okul), -1);
      if (!k.okul || okulAnahtari(k.okul) !== yeni) await redis('HINCRBY', 'okul:uye', yeni, 1);
      // Okulun görünen adı ilk yazana göre sabitlenir; aynı okulu farklı yazan herkes tek yerde toplanır.
      await redis('HSETNX', 'okul:ad', yeni, okul);
      k.okul = await redis('HGET', 'okul:ad', yeni) || okul;
      await redis('SET', 'kullanici:' + anahtar, JSON.stringify(k));
      return cevap(res, 200, { okul: k.okul });
    }

    if (g.islem === 'adDegistir') {
      const eski = await oturumKullanici(req);
      const k = eski && await kullaniciAl(eski);
      if (!k) return cevap(res, 401, { hata: 'Oturumun kapanmış, tekrar giriş yap' });
      const yeniAd = String(g.ad || '').trim();
      if (!AD_KURALI.test(yeniAd)) {
        return cevap(res, 400, { hata: 'Kullanıcı adı 3-20 karakter olmalı. Harf, rakam, nokta ve alt çizgi kullanabilirsin.' });
      }
      if (yeniAd === k.ad) return cevap(res, 400, { hata: 'Bu zaten senin adın.' });
      if (k.adDegisim && Date.now() - k.adDegisim < AD_BEKLEME) {
        return cevap(res, 429, { hata: 'Adını günde en fazla bir kez değiştirebilirsin. Yarın tekrar dene.' });
      }
      const yeni = yeniAd.toLocaleLowerCase('tr-TR');
      const kayit = JSON.stringify({ ...k, ad: yeniAd, adDegisim: Date.now() });
      if (yeni === eski) {
        // Sadece büyük-küçük harf değişti; anahtar aynı kalır.
        await redis('SET', 'kullanici:' + eski, kayit);
      } else {
        // Yeni ad önce kapılır, böylece aynı anda başka biri aynı adı alamaz.
        if (await redis('SET', 'kullanici:' + yeni, kayit, 'NX') !== 'OK') {
          return cevap(res, 409, { hata: 'Bu kullanıcı adı alınmış, başka bir ad dene.' });
        }
        await hesabiTasi(eski, yeni, k.ad, yeniAd);
        await redis('DEL', 'kullanici:' + eski);
        // Bu cihazın oturumu yeni ada geçer; diğer cihazlarda yeniden giriş gerekir.
        await redis('SET', 'oturum:' + cerezOku(req, 'oturum'), oturumDegeri(yeni, k.olusturma), 'EX', OTURUM_SURESI);
      }
      return cevap(res, 200, { kullanici: yeniAd });
    }

    if (g.islem === 'cikis') {
      const jeton = cerezOku(req, 'oturum');
      if (gecerliJeton(jeton)) await redis('DEL', 'oturum:' + jeton);
      cerezYaz(res, '', 0);
      return cevap(res, 200, { tamam: true });
    }

    if (g.islem === 'sil') {
      const anahtar = await oturumKullanici(req);
      const k = anahtar && await kullaniciAl(anahtar);
      if (!k) return cevap(res, 401, { hata: 'Oturumun kapanmış, tekrar giriş yap' });
      if (!await denemeHakkiVar(req)) return cevap(res, 429, { hata: 'Çok fazla deneme yaptın. 15 dakika sonra tekrar dene.' });
      const ozet = await sifreOzeti(String(g.sifre || ''), k.tuz);
      if (!timingSafeEqual(Buffer.from(ozet, 'hex'), Buffer.from(k.ozet, 'hex'))) return cevap(res, 401, { hata: 'Şifre yanlış.' });
      await hesabiTemizle(anahtar, k);
      await redis('DEL', 'oturum:' + cerezOku(req, 'oturum'));
      cerezYaz(res, '', 0);
      return cevap(res, 200, { tamam: true });
    }

    if (g.islem !== 'giris' && g.islem !== 'kayit') return cevap(res, 400, { hata: 'Geçersiz istek' });
    const ad = String(g.ad || '').trim();
    const sifre = String(g.sifre || '');
    if (!AD_KURALI.test(ad)) {
      return cevap(res, 400, { hata: 'Kullanıcı adı 3-20 karakter olmalı. Harf, rakam, nokta ve alt çizgi kullanabilirsin.' });
    }
    if (sifre.length < 6 || sifre.length > 72) return cevap(res, 400, { hata: 'Şifre en az 6 karakter olmalı.' });
    if (!await denemeHakkiVar(req)) return cevap(res, 429, { hata: 'Çok fazla deneme yaptın. 15 dakika sonra tekrar dene.' });

    const anahtar = ad.toLocaleLowerCase('tr-TR');

    if (g.islem === 'kayit') {
      const tuz = randomBytes(16).toString('hex');
      const ozet = await sifreOzeti(sifre, tuz);
      const olusturma = Date.now();
      const kayit = JSON.stringify({ ad, tuz, ozet, olusturma });
      const sonuc = await redis('SET', 'kullanici:' + anahtar, kayit, 'NX');
      if (sonuc !== 'OK') return cevap(res, 409, { hata: 'Bu kullanıcı adı alınmış, başka bir ad dene.' });
      await oturumAc(res, anahtar, olusturma);
      return cevap(res, 200, { kullanici: ad, durum: null });
    }

    const k = await kullaniciAl(anahtar);
    if (!k) {
      // Var olmayan kullanıcıda da aynı süre geçsin diye boşuna özet hesaplanır.
      await sifreOzeti(sifre, '00'.repeat(16));
      return cevap(res, 401, { hata: 'Kullanıcı adı veya şifre yanlış.' });
    }
    const ozet = await sifreOzeti(sifre, k.tuz);
    if (!timingSafeEqual(Buffer.from(ozet, 'hex'), Buffer.from(k.ozet, 'hex'))) {
      return cevap(res, 401, { hata: 'Kullanıcı adı veya şifre yanlış.' });
    }
    await oturumAc(res, anahtar, k.olusturma);
    return cevap(res, 200, { kullanici: k.ad, okul: k.okul || null, durum: await durumAl(anahtar) });
  } catch (e) {
    console.error('hesap', e);
    return cevap(res, 500, { hata: 'Sunucuda bir sorun oldu, biraz sonra tekrar dene.' });
  }
}
