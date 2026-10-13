// Günlük hatırlatma: Vercel zamanlanmış görevi (vercel.json) her akşam bir kez çağırır.
// Yalnızca o gün görev yapmamış, son 14 gün içinde uygulamaya girmiş ve hatırlatmayı açık bırakmış kişilere,
// günde en fazla bir bildirim gider.
import { dbVar, redis, jsonOku, gunNo, cevap } from './_db.js';
import { pushHazir, bildirimAyari, bildirimGonder } from './_push.js';

const UNUTMA_SURESI = 14; // gün

export default async function handler(req, res) {
  const gizli = process.env.CRON_SECRET;
  if (!gizli || req.headers.authorization !== `Bearer ${gizli}`) return cevap(res, 401, { hata: 'Yetkisiz' });
  if (!dbVar() || !pushHazir()) return cevap(res, 503, { hata: 'Bildirimler kurulu değil' });

  const bugun = gunNo();
  let gonderilen = 0, atlanan = 0;
  for (const k of await redis('SMEMBERS', 'push:kullanicilar') || []) {
    try {
      if (!(await bildirimAyari(k)).hatirlatma) { atlanan++; continue; }
      const son = await redis('ZREVRANGE', 'aktif:' + k, 0, 0);
      const sonGun = son && son.length ? Number(son[0]) : null;
      if (sonGun === bugun || sonGun === null || bugun - sonGun > UNUTMA_SURESI) { atlanan++; continue; }
      if (await redis('SET', `pushgun:${k}:${bugun}`, '1', 'NX', 'EX', 90000) !== 'OK') { atlanan++; continue; }
      const d = jsonOku(await redis('GET', 'durum:' + k)) || {};
      const seri = sonGun === bugun - 1 ? Number(d.streak) || 0 : 0;
      const icerik = seri > 0
        ? { baslik: `${seri} günlük serin tehlikede!`, metin: 'Bugünkü görevini ya da quizini yap, serin devam etsin. Filiz seni bekliyor.', etiket: 'hatirlatma' }
        : { baslik: 'Bugünkü çevre görevin hazır', metin: 'Küçük bir adım yeter: bir görev ya da 5 soruluk quiz. Filiz seni özledi!', etiket: 'hatirlatma' };
      gonderilen += await bildirimGonder(k, icerik, 'hatirlatma') ? 1 : 0;
      if (!Number(await redis('HLEN', 'push:' + k))) await redis('SREM', 'push:kullanicilar', k);
    } catch (e) {
      console.error('hatirlatma', k, e.message);
    }
  }
  return cevap(res, 200, { gonderilen, atlanan });
}
