// Herkese açık Yeşil Akış.
//   GET  /api/akis                         → { gonderiler: [...] } (en yeni 60)
//   GET  /api/akis?resim=<id>              → JPEG
//   POST /api/akis { islem: 'paylas', metin, resim }
//   POST /api/akis { islem: 'begen', id }  → beğeniyi açar/kapatır
//   POST /api/akis { islem: 'sil', id }    → yalnızca kendi paylaşımı
// Her ilk beğeni paylaşana +2 puan olarak bildirilir (bildirim kuyruğu üzerinden).
import { randomBytes } from 'node:crypto';
import { dbVar, redis, oturumBilgi, jsonOku, govdeAl, cevap, gunNo } from './_db.js';

const EN_FAZLA = 300;          // saklanan paylaşım sayısı
const LISTE = 60;              // bir seferde gönderilen paylaşım
const RESIM_UST = 80_000;      // karakter (yaklaşık 60 KB JPEG)
const GUNLUK_PAYLASIM = 10;

const temizle = (v, n) => String(v || '').replace(/[\u0000-\u0009\u000b-\u001f]/g, ' ').trim().slice(0, n);

async function gonderiSil(id) {
  const g = jsonOku(await redis('HGET', 'akis:gonderi', id));
  await redis('HDEL', 'akis:gonderi', id);
  await redis('HDEL', 'akis:resim', id);
  await redis('ZREM', 'akis:zaman', id);
  await redis('DEL', 'begeni:' + id, 'begeniKredi:' + id);
  if (g) await redis('SREM', 'akis:benim:' + g.sahip, id);
}
export { gonderiSil };

export default async function handler(req, res) {
  if (!dbVar()) return cevap(res, 503, { kod: 'veritabani-yok', hata: 'Akış için hesap sistemi gerekli' });

  try {
    if (req.method === 'GET') {
      const q = req.query || {};
      if (q.resim) {
        const veri = await redis('HGET', 'akis:resim', String(q.resim));
        const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(veri || '');
        res.setHeader('Cache-Control', 'private, max-age=3600');
        if (!m) return res.status(404).end();
        res.setHeader('Content-Type', 'image/jpeg');
        return res.status(200).end(Buffer.from(m[1], 'base64'));
      }
      const ben = await oturumBilgi(req);
      const idler = await redis('ZREVRANGE', 'akis:zaman', 0, LISTE - 1) || [];
      if (!idler.length) return cevap(res, 200, { gonderiler: [] });
      const hamlar = await redis('HMGET', 'akis:gonderi', ...idler);
      const gonderiler = [];
      for (let i = 0; i < idler.length; i++) {
        const g = jsonOku(hamlar[i]);
        if (!g) continue;
        const [sayi, benim] = await Promise.all([
          redis('SCARD', 'begeni:' + g.id), ben ? redis('SISMEMBER', 'begeni:' + g.id, ben.anahtar) : 0,
        ]);
        gonderiler.push({ ...g, sahip: undefined, benim: !!ben && g.sahip === ben.anahtar, begeni: Number(sayi) || 0, begendim: !!Number(benim) });
      }
      return cevap(res, 200, { gonderiler });
    }

    if (req.method !== 'POST') return cevap(res, 405, { hata: 'Desteklenmeyen istek' });
    const ben = await oturumBilgi(req);
    if (!ben) return cevap(res, 401, { hata: 'Önce giriş yap' });
    const g = govdeAl(req);
    if (!g) return cevap(res, 400, { hata: 'Geçersiz istek' });

    if (g.islem === 'paylas') {
      const metin = temizle(g.metin, 280);
      const resim = g.resim ? String(g.resim) : '';
      if (resim && !/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(resim)) return cevap(res, 400, { hata: 'Fotoğraf okunamadı' });
      if (resim.length > RESIM_UST) return cevap(res, 413, { hata: 'Fotoğraf çok büyük' });
      if (!metin && !resim) return cevap(res, 400, { hata: 'Paylaşmak için bir yazı ya da fotoğraf ekle' });
      const k = `gunluk:paylas:${ben.anahtar}:${gunNo()}`;
      const n = await redis('INCR', k);
      if (n === 1) await redis('EXPIRE', k, 90000);
      if (n > GUNLUK_PAYLASIM) return cevap(res, 429, { hata: `Günde en fazla ${GUNLUK_PAYLASIM} paylaşım yapabilirsin` });
      const kul = jsonOku(await redis('GET', 'kullanici:' + ben.anahtar)) || {};
      const gonderi = { id: randomBytes(6).toString('hex'), sahip: ben.anahtar, ad: ben.ad, okul: kul.okul || null, metin, resimVar: !!resim, t: Date.now() };
      await redis('HSET', 'akis:gonderi', gonderi.id, JSON.stringify(gonderi));
      if (resim) await redis('HSET', 'akis:resim', gonderi.id, resim);
      await redis('ZADD', 'akis:zaman', gonderi.t, gonderi.id);
      await redis('SADD', 'akis:benim:' + ben.anahtar, gonderi.id);
      // En eski paylaşımlar silinerek veritabanı sınırı aşılmaz.
      const fazla = Number(await redis('ZCARD', 'akis:zaman')) - EN_FAZLA;
      if (fazla > 0) for (const id of await redis('ZRANGE', 'akis:zaman', 0, fazla - 1)) await gonderiSil(id);
      return cevap(res, 200, { gonderi: { ...gonderi, sahip: undefined, benim: true, begeni: 0, begendim: false } });
    }

    const id = String(g.id || '');
    const gonderi = jsonOku(await redis('HGET', 'akis:gonderi', id));
    if (!gonderi) return cevap(res, 404, { hata: 'Paylaşım bulunamadı' });

    if (g.islem === 'begen') {
      const kume = 'begeni:' + id;
      if (await redis('SISMEMBER', kume, ben.anahtar)) {
        await redis('SREM', kume, ben.anahtar);
      } else {
        await redis('SADD', kume, ben.anahtar);
        // Paylaşan, her kişinin ilk beğenisi için bir kez puan alır; kendi paylaşımını beğenmek puan getirmez.
        if (gonderi.sahip !== ben.anahtar && await redis('SADD', 'begeniKredi:' + id, ben.anahtar)) {
          await redis('RPUSH', 'bildirim:' + gonderi.sahip, JSON.stringify({ tur: 'begeni', kimden: ben.ad, puan: 2, t: Date.now() }));
          await redis('EXPIRE', 'bildirim:' + gonderi.sahip, 7 * 86400);
        }
      }
      const [sayi, benim] = await Promise.all([redis('SCARD', kume), redis('SISMEMBER', kume, ben.anahtar)]);
      return cevap(res, 200, { begeni: Number(sayi) || 0, begendim: !!Number(benim) });
    }

    if (g.islem === 'sil') {
      if (gonderi.sahip !== ben.anahtar) return cevap(res, 403, { hata: 'Sadece kendi paylaşımını silebilirsin' });
      await gonderiSil(id);
      return cevap(res, 200, { tamam: true });
    }

    return cevap(res, 400, { hata: 'Geçersiz istek' });
  } catch (e) {
    console.error('akis', e);
    return cevap(res, 500, { hata: 'Sunucuda bir sorun oldu, biraz sonra tekrar dene.' });
  }
}
