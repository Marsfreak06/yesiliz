// Telefon ve bilgisayar bildirimleri (Web Push).
// Anahtarlar Vercel'deki VAPID_PUBLIC_KEY ve VAPID_PRIVATE_KEY ortam değişkenlerinden okunur.
// Kullanıcıyı sıkmamak için: anlık bildirimler 22:00-08:00 arası gönderilmez ve kişi başı günde en fazla 3 tanedir;
// günlük hatırlatma ayrı tutulur ve günde bir kezdir (bkz. hatirlatma.js).
import webpush from 'web-push';
import { createHash } from 'node:crypto';
import { redis, jsonOku, ciftler, gunNo } from './_db.js';

const GUNLUK_ANLIK_UST = 3;
let ayarlandi = false;

export const pushHazir = () => Boolean(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
export const abonelikKimligi = endpoint => createHash('sha256').update(String(endpoint)).digest('hex').slice(0, 24);
export const sessizSaat = () => { const s = new Date(Date.now() + 3 * 3600_000).getUTCHours(); return s >= 22 || s < 8; };

export async function bildirimAyari(anahtar) {
  return { hatirlatma: true, arkadas: true, ...(jsonOku(await redis('GET', 'pushayar:' + anahtar)) || {}) };
}

// tur: 'hatirlatma' (günlük), 'arkadas' (dürtme, istekler), 'hediye', 'deneme'
export async function bildirimGonder(anahtar, { baslik, metin, etiket = 'yesiliz', url = '/' }, tur) {
  if (!pushHazir()) return 0;
  const abonelikler = ciftler(await redis('HGETALL', 'push:' + anahtar));
  if (!abonelikler.length) return 0;
  if (tur === 'arkadas' || tur === 'hediye') {
    if (tur === 'arkadas' && !(await bildirimAyari(anahtar)).arkadas) return 0;
    if (sessizSaat()) return 0;
    const k = `pushsay:${anahtar}:${gunNo()}`;
    const n = await redis('INCR', k);
    if (n === 1) await redis('EXPIRE', k, 90000);
    if (n > GUNLUK_ANLIK_UST) return 0;
  }
  if (!ayarlandi) {
    webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:iletisim@yesiliz.space', process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
    ayarlandi = true;
  }
  const veri = JSON.stringify({ baslik, metin, etiket, url });
  let gonderilen = 0;
  for (const [id, ham] of abonelikler) {
    const abonelik = jsonOku(ham);
    if (!abonelik) continue;
    try {
      await webpush.sendNotification(abonelik, veri, { TTL: 6 * 3600, urgency: tur === 'hatirlatma' ? 'normal' : 'high', topic: etiket.slice(0, 32) });
      gonderilen++;
    } catch (e) {
      // Kullanıcı izni kaldırdıysa ya da cihaz değiştiyse abonelik silinir.
      if (e.statusCode === 404 || e.statusCode === 410) await redis('HDEL', 'push:' + anahtar, id);
      else console.error('push', e.statusCode, String(e.body || e.message).slice(0, 200));
    }
  }
  return gonderilen;
}

// Başka bir işlemi bozmasın diye hatalar yutulur.
export function bildirimDene(anahtar, icerik, tur) {
  return bildirimGonder(anahtar, icerik, tur).catch(e => { console.error('push', e.message); return 0; });
}
