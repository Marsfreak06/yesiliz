// Profil fotoğrafı, arkadaşlar ve haftalık şampiyonlar.
//   GET  /api/sosyal?avatar=<kullanıcı adı>        → JPEG (yoksa 404)
//   GET  /api/sosyal?islem=sampiyonlar              → bu haftanın ve geçen haftanın sıralamaları
//   GET  /api/sosyal?islem=arkadaslar               → { arkadaslar, istekler, giden }
//   GET  /api/sosyal?islem=degerlendirmeler         → { sayi, ortalama, dagilim[1..5 yıldız] }
//   GET  /api/sosyal?islem=magaza                   → { fiyat: { ürünKimliği: puan } }
//   GET  /api/sosyal?islem=hediyeler                → { hediyeler: [{ miktar, not, t }] } (teslim edilince silinir)
//   POST /api/sosyal { islem: 'degerlendir', yildiz, metin }
//   GET  /api/sosyal?islem=okullar                  → { okullar: [{ ad, uye }] }
//   POST /api/sosyal { islem: 'istek' | 'kabul' | 'reddet' | 'cikar' | 'durt', ad }
//   POST /api/sosyal { islem: 'avatar', resim } | { islem: 'avatarSil' }
import { dbVar, redis, oturumBilgi, jsonOku, ciftler, govdeAl, cevap, haftaNo, gunNo, kullaniciAnahtari, adlariGetir } from './_db.js';

const AVATAR_UST = 60_000; // karakter (yaklaşık 45 KB JPEG)
const TURLER = ['fidan', 'alan', 'sulama', 'puan'];
// Şampiyonluk puanı = fidan × 100 + temizlenen m² ÷ 10 + sulama × 25 + haftalık puan ÷ 10
// (puan tarayıcıda hesaplandığı için ağırlığı düşük tutulur; gerçek dünyadaki eylemler öne çıkar)
const AGIRLIK = { fidan: 100, alan: 0.1, sulama: 25, puan: 0.1 };

async function siralama(hafta, ben) {
  const k = t => `h:${hafta}:${t}`;
  await redis('ZUNIONSTORE', k('fuzyon'), TURLER.length, ...TURLER.map(k), 'WEIGHTS', ...TURLER.map(t => AGIRLIK[t]));
  await redis('EXPIRE', k('fuzyon'), 3600);
  const ham = {};
  for (const t of [...TURLER, 'fuzyon']) {
    ham[t] = ciftler(await redis('ZREVRANGE', k(t), 0, 9, 'WITHSCORES')).map(([a, s]) => ({ a, s: Math.round(Number(s)) }));
  }
  const adlar = await adlariGetir(Object.values(ham).flat().map(x => x.a));
  const sonuc = {};
  for (const [t, liste] of Object.entries(ham)) {
    sonuc[t] = liste.filter(x => adlar[x.a] && x.s > 0).map(x => ({ ad: adlar[x.a], s: x.s }));
  }
  if (ben) {
    const [sira, skor] = await Promise.all([redis('ZREVRANK', k('fuzyon'), ben.anahtar), redis('ZSCORE', k('fuzyon'), ben.anahtar)]);
    const benim = {};
    for (const t of TURLER) benim[t] = Math.round(Number(await redis('ZSCORE', k(t), ben.anahtar)) || 0);
    sonuc.ben = { sira: sira === null || sira === undefined ? null : Number(sira) + 1, skor: Math.round(Number(skor) || 0), ...benim };
  }
  return sonuc;
}

// Uygulama değerlendirmeleri: kişi başı bir kayıt; yorumlar herkese açık değildir, yalnızca özet döner.
async function degerlendirmeOzeti() {
  const kayitlar = ciftler(await redis('HGETALL', 'degerlendirmeler')).map(([, v]) => jsonOku(v)).filter(Boolean);
  const dagilim = [0, 0, 0, 0, 0];
  for (const k of kayitlar) if (k.yildiz >= 1 && k.yildiz <= 5) dagilim[k.yildiz - 1]++;
  const sayi = dagilim.reduce((a, b) => a + b, 0);
  const ortalama = sayi ? Math.round(dagilim.reduce((a, n, i) => a + n * (i + 1), 0) / sayi * 10) / 10 : 0;
  return { sayi, ortalama, dagilim };
}

// Kullanıcının son 60 gündeki aktif günleri (görev ya da quiz yaptığı günler).
async function aktifGunler(anahtar, bugun) {
  return new Set((await redis('ZRANGEBYSCORE', 'aktif:' + anahtar, bugun - 60, bugun) || []).map(Number));
}

// Ortak seri: ikisinin de aktif olduğu art arda günler. Bugün ikisi de yapmadıysa dünden geriye sayılır.
function ortakSeri(a, b, bugun) {
  let g = a.has(bugun) && b.has(bugun) ? bugun : bugun - 1, n = 0;
  while (a.has(g) && b.has(g)) { n++; g--; }
  return n;
}

async function arkadasListesi(anahtar) {
  const [ark, ist, gid] = await Promise.all([
    redis('SMEMBERS', 'arkadas:' + anahtar), redis('SMEMBERS', 'istekler:' + anahtar), redis('SMEMBERS', 'giden:' + anahtar),
  ]);
  const adlar = await adlariGetir([...ark, ...ist, ...gid]);
  const sirala = l => l.sort((x, y) => x.ad.localeCompare(y.ad, 'tr'));
  const liste = l => sirala(l.filter(a => adlar[a]).map(a => ({ ad: adlar[a] })));
  const bugun = gunNo(), benim = await aktifGunler(anahtar, bugun);
  const arkadaslar = [];
  for (const a of ark) {
    if (!adlar[a]) continue;
    const onun = await aktifGunler(a, bugun);
    arkadaslar.push({ ad: adlar[a], ortakSeri: ortakSeri(benim, onun, bugun), bugun: onun.has(bugun) });
  }
  return { arkadaslar: sirala(arkadaslar), istekler: liste(ist), giden: liste(gid), benBugun: benim.has(bugun) };
}

// Okul sıralaması: öğrencilerin bu haftaki şampiyonluk puanları toplanır.
async function okulSiralamasi(hafta, ben) {
  const uyeler = ciftler(await redis('ZREVRANGE', `h:${hafta}:fuzyon`, 0, -1, 'WITHSCORES'));
  if (!uyeler.length) return { liste: [], benim: null };
  const kayitlar = await redis('MGET', ...uyeler.map(([a]) => 'kullanici:' + a));
  const toplam = new Map();
  uyeler.forEach(([a, s], i) => {
    const u = jsonOku(kayitlar[i]);
    if (!u || !u.okul) return;
    const k = u.okul.toLocaleLowerCase('tr-TR'), o = toplam.get(k) || { ad: u.okul, s: 0, uye: 0 };
    o.s += Number(s) || 0; o.uye++; toplam.set(k, o);
  });
  const liste = [...toplam.values()].map(o => ({ ...o, s: Math.round(o.s) })).filter(o => o.s > 0).sort((x, y) => y.s - x.s);
  let benim = null;
  if (ben) { const u = jsonOku(await redis('GET', 'kullanici:' + ben.anahtar)); benim = u && u.okul || null; }
  return { liste: liste.slice(0, 20), benim };
}

export default async function handler(req, res) {
  if (!dbVar()) return cevap(res, 503, { kod: 'veritabani-yok', hata: 'Hesap sistemi henüz kurulmadı' });

  try {
    if (req.method === 'GET') {
      const q = req.query || {};
      // Fotoğraf yalnızca tarayıcıda kısa süre önbelleğe alınır; Vercel önbelleği tutmaz ki silinen fotoğraf hemen kaybolsun.
      if (q.avatar) {
        const veri = await redis('GET', 'avatar:' + kullaniciAnahtari(q.avatar));
        const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(veri || '');
        if (!m) { res.setHeader('Cache-Control', 'private, max-age=60'); return res.status(404).end(); }
        res.setHeader('Content-Type', 'image/jpeg');
        res.setHeader('Cache-Control', 'private, max-age=60');
        return res.status(200).end(Buffer.from(m[1], 'base64'));
      }
      if (q.islem === 'degerlendirmeler') return cevap(res, 200, await degerlendirmeOzeti());
      // Kayıtta öneri olarak gösterilen okul listesi (öğrenci sayısına göre).
      if (q.islem === 'okullar') {
        const [uye, ad] = await Promise.all([redis('HGETALL', 'okul:uye'), redis('HGETALL', 'okul:ad')]);
        const adlar = Object.fromEntries(ciftler(ad));
        const okullar = ciftler(uye).map(([k, n]) => ({ ad: adlar[k], uye: Number(n) })).filter(o => o.ad && o.uye > 0).sort((x, y) => y.uye - x.uye);
        return cevap(res, 200, { okullar: okullar.slice(0, 300) });
      }
      // Yöneticinin değiştirdiği mağaza fiyatları (yalnızca değişenler döner).
      if (q.islem === 'magaza') {
        const fiyat = {};
        for (const [id, p] of ciftler(await redis('HGETALL', 'magaza:fiyat'))) fiyat[id] = Number(p);
        return cevap(res, 200, { fiyat });
      }
      const ben = await oturumBilgi(req);
      if (q.islem === 'sampiyonlar') {
        const h = haftaNo();
        const [bu, gecen] = await Promise.all([siralama(h, ben), siralama(h - 1, null)]);
        const okullar = await okulSiralamasi(h, ben);
        return cevap(res, 200, { hafta: bu, gecen: gecen.fuzyon.slice(0, 3), okullar, agirlik: AGIRLIK });
      }
      // Yöneticinin gönderdiği bekleyen hediyeler: bir kez teslim edilir, sonra silinir.
      if (q.islem === 'hediyeler') {
        if (!ben) return cevap(res, 401, { hata: 'Önce giriş yap' });
        const k = 'hediye:' + ben.anahtar, b = 'bildirim:' + ben.anahtar;
        const liste = (await redis('LRANGE', k, 0, -1) || []).map(jsonOku).filter(h => h && h.miktar > 0);
        const bildirimler = (await redis('LRANGE', b, 0, -1) || []).map(jsonOku).filter(Boolean);
        if (liste.length) await redis('DEL', k);
        if (bildirimler.length) await redis('DEL', b);
        return cevap(res, 200, { hediyeler: liste, bildirimler });
      }
      if (q.islem === 'arkadaslar') {
        if (!ben) return cevap(res, 401, { hata: 'Önce giriş yap' });
        return cevap(res, 200, await arkadasListesi(ben.anahtar));
      }
      return cevap(res, 400, { hata: 'Geçersiz istek' });
    }

    if (req.method !== 'POST') return cevap(res, 405, { hata: 'Desteklenmeyen istek' });
    const ben = await oturumBilgi(req);
    if (!ben) return cevap(res, 401, { hata: 'Önce giriş yap' });
    const g = govdeAl(req);
    if (!g) return cevap(res, 400, { hata: 'Geçersiz istek' });
    const me = ben.anahtar;

    if (g.islem === 'avatar') {
      const resim = String(g.resim || '');
      if (!/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(resim)) return cevap(res, 400, { hata: 'Fotoğraf okunamadı' });
      if (resim.length > AVATAR_UST) return cevap(res, 413, { hata: 'Fotoğraf çok büyük' });
      await redis('SET', 'avatar:' + me, resim);
      return cevap(res, 200, { tamam: true });
    }
    if (g.islem === 'degerlendir') {
      const yildiz = Math.round(Number(g.yildiz));
      if (!(yildiz >= 1 && yildiz <= 5)) return cevap(res, 400, { hata: '1 ile 5 arasında yıldız seç' });
      const metin = String(g.metin || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 500);
      await redis('HSET', 'degerlendirmeler', me, JSON.stringify({ yildiz, metin, ad: ben.ad, t: Date.now() }));
      return cevap(res, 200, await degerlendirmeOzeti());
    }
    if (g.islem === 'avatarSil') {
      await redis('DEL', 'avatar:' + me);
      return cevap(res, 200, { tamam: true });
    }

    const o = kullaniciAnahtari(g.ad);
    if (!o) return cevap(res, 400, { hata: 'Kullanıcı adını yaz' });

    if (g.islem === 'istek') {
      if (o === me) return cevap(res, 400, { hata: 'Kendini arkadaş olarak ekleyemezsin' });
      const k = jsonOku(await redis('GET', 'kullanici:' + o));
      if (!k) return cevap(res, 404, { hata: 'Bu kullanıcı adıyla kimse bulunamadı' });
      if (await redis('SISMEMBER', 'arkadas:' + me, o)) return cevap(res, 409, { hata: `${k.ad} zaten arkadaşın` });
      // Karşı taraf da bana istek göndermişse doğrudan arkadaş olunur.
      if (await redis('SISMEMBER', 'istekler:' + me, o)) {
        await redis('SADD', 'arkadas:' + me, o); await redis('SADD', 'arkadas:' + o, me);
        await redis('SREM', 'istekler:' + me, o); await redis('SREM', 'giden:' + o, me);
        return cevap(res, 200, { durum: 'arkadas', ad: k.ad, ...(await arkadasListesi(me)) });
      }
      if (Number(await redis('SCARD', 'istekler:' + o)) >= 50) return cevap(res, 429, { hata: 'Bu kullanıcının bekleyen çok fazla isteği var' });
      await redis('SADD', 'istekler:' + o, me); await redis('SADD', 'giden:' + me, o);
      return cevap(res, 200, { durum: 'gonderildi', ad: k.ad, ...(await arkadasListesi(me)) });
    }
    if (g.islem === 'kabul') {
      if (!await redis('SISMEMBER', 'istekler:' + me, o)) return cevap(res, 404, { hata: 'Böyle bir istek yok' });
      await redis('SADD', 'arkadas:' + me, o); await redis('SADD', 'arkadas:' + o, me);
      await redis('SREM', 'istekler:' + me, o); await redis('SREM', 'giden:' + o, me);
      return cevap(res, 200, await arkadasListesi(me));
    }
    if (g.islem === 'reddet') {
      await redis('SREM', 'istekler:' + me, o); await redis('SREM', 'giden:' + o, me);
      // Gönderdiğim isteği geri çekmek için de kullanılır.
      await redis('SREM', 'giden:' + me, o); await redis('SREM', 'istekler:' + o, me);
      return cevap(res, 200, await arkadasListesi(me));
    }
    if (g.islem === 'durt') {
      if (!await redis('SISMEMBER', 'arkadas:' + me, o)) return cevap(res, 403, { hata: 'Sadece arkadaşlarını dürtebilirsin' });
      const ilk = await redis('SET', `durt:${me}:${o}:${gunNo()}`, '1', 'NX', 'EX', 90000);
      if (ilk !== 'OK') return cevap(res, 429, { hata: 'Bu arkadaşını bugün zaten dürttün' });
      await redis('RPUSH', 'bildirim:' + o, JSON.stringify({ tur: 'durt', kimden: ben.ad, t: Date.now() }));
      await redis('EXPIRE', 'bildirim:' + o, 7 * 86400);
      return cevap(res, 200, { tamam: true });
    }
    if (g.islem === 'cikar') {
      await redis('SREM', 'arkadas:' + me, o); await redis('SREM', 'arkadas:' + o, me);
      return cevap(res, 200, await arkadasListesi(me));
    }
    return cevap(res, 400, { hata: 'Geçersiz istek' });
  } catch (e) {
    console.error('sosyal', e);
    return cevap(res, 500, { hata: 'Sunucuda bir sorun oldu, biraz sonra tekrar dene.' });
  }
}
