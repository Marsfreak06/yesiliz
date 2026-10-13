// Bildirim aboneliği ve ayarları.
//   GET  /api/bildirim?islem=anahtar          → { anahtar } (tarayıcının abone olması için açık anahtar)
//   GET  /api/bildirim?islem=ayar             → { ayar, cihaz }
//   POST /api/bildirim { islem: 'abone', abonelik }
//   POST /api/bildirim { islem: 'iptal', endpoint }
//   POST /api/bildirim { islem: 'ayar', hatirlatma, arkadas }
//   POST /api/bildirim { islem: 'deneme' }     → bu kullanıcının cihazlarına deneme bildirimi
import { dbVar, redis, oturumBilgi, govdeAl, cevap } from './_db.js';
import { pushHazir, abonelikKimligi, bildirimAyari, bildirimGonder } from './_push.js';

const CIHAZ_UST = 5;

export default async function handler(req, res) {
  if (!dbVar()) return cevap(res, 503, { hata: 'Hesap sistemi henüz kurulmadı' });
  try {
    const q = req.query || {};
    if (req.method === 'GET' && q.islem === 'anahtar') return cevap(res, 200, { anahtar: pushHazir() ? process.env.VAPID_PUBLIC_KEY : null });

    const ben = await oturumBilgi(req);
    if (!ben) return cevap(res, 401, { hata: 'Önce giriş yap' });
    const k = ben.anahtar;

    if (req.method === 'GET' && q.islem === 'ayar') {
      return cevap(res, 200, { ayar: await bildirimAyari(k), cihaz: Number(await redis('HLEN', 'push:' + k)) || 0 });
    }
    if (req.method !== 'POST') return cevap(res, 405, { hata: 'Desteklenmeyen istek' });
    const g = govdeAl(req);
    if (!g) return cevap(res, 400, { hata: 'Geçersiz istek' });

    if (g.islem === 'abone') {
      const a = g.abonelik || {};
      const gecerli = typeof a.endpoint === 'string' && /^https:\/\//.test(a.endpoint) && a.endpoint.length < 1000
        && a.keys && typeof a.keys.p256dh === 'string' && typeof a.keys.auth === 'string' && a.keys.p256dh.length < 200 && a.keys.auth.length < 100;
      if (!gecerli) return cevap(res, 400, { hata: 'Bildirim aboneliği geçersiz' });
      if (Number(await redis('HLEN', 'push:' + k)) >= CIHAZ_UST && !(await redis('HEXISTS', 'push:' + k, abonelikKimligi(a.endpoint)))) {
        return cevap(res, 429, { hata: `En fazla ${CIHAZ_UST} cihazda bildirim açabilirsin` });
      }
      await redis('HSET', 'push:' + k, abonelikKimligi(a.endpoint), JSON.stringify({ endpoint: a.endpoint, keys: { p256dh: a.keys.p256dh, auth: a.keys.auth } }));
      await redis('SADD', 'push:kullanicilar', k);
      return cevap(res, 200, { tamam: true });
    }
    if (g.islem === 'iptal') {
      await redis('HDEL', 'push:' + k, abonelikKimligi(g.endpoint || ''));
      if (!Number(await redis('HLEN', 'push:' + k))) await redis('SREM', 'push:kullanicilar', k);
      return cevap(res, 200, { tamam: true });
    }
    if (g.islem === 'ayar') {
      const ayar = { hatirlatma: g.hatirlatma !== false, arkadas: g.arkadas !== false };
      await redis('SET', 'pushayar:' + k, JSON.stringify(ayar));
      return cevap(res, 200, { ayar });
    }
    if (g.islem === 'deneme') {
      const n = await bildirimGonder(k, { baslik: 'Yeşiliz bildirimleri açık', metin: 'Filiz sana böyle haber verecek. Sadece önemli şeyler için, söz!', etiket: 'deneme' }, 'deneme');
      return n ? cevap(res, 200, { gonderilen: n }) : cevap(res, 404, { hata: 'Bu hesapta bildirim açılmış bir cihaz bulunamadı' });
    }
    return cevap(res, 400, { hata: 'Geçersiz istek' });
  } catch (e) {
    console.error('bildirim', e);
    return cevap(res, 500, { hata: 'Sunucuda bir sorun oldu.' });
  }
}
