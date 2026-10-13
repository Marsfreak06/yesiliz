// Bir hesabı ve ona bağlı her şeyi siler. Hem kullanıcının kendi hesabını silmesinde hem de yönetici panelinde kullanılır.
// Silinenler: kullanıcı kaydı ve ilerlemesi, haritadaki fidanları ve alanları, akıştaki paylaşımları, arkadaşlıkları ve
// istekleri, profil fotoğrafı, değerlendirmesi, okul sayımı, bildirim abonelikleri, bu haftaki sıralama puanları.
// Diğer cihazlardaki oturumlar, kullanıcı kaydı silindiği için kendiliğinden geçersiz olur (bkz. _db.js oturumDegeri).
import { redis, haftaNo } from './_db.js';

export async function hesabiTemizle(anahtar, k) {
  for (const kayit of await redis('SMEMBERS', 'benim:' + anahtar)) {
    const [tip, id] = String(kayit).split(':');
    await redis('HDEL', tip === 'a' ? 'alanlar' : 'fidanlar', id);
  }
  for (const o of await redis('SMEMBERS', 'arkadas:' + anahtar)) await redis('SREM', 'arkadas:' + o, anahtar);
  for (const o of await redis('SMEMBERS', 'giden:' + anahtar)) await redis('SREM', 'istekler:' + o, anahtar);
  for (const o of await redis('SMEMBERS', 'istekler:' + anahtar)) await redis('SREM', 'giden:' + o, anahtar);
  await redis('HDEL', 'degerlendirmeler', anahtar);
  for (const h of await redis('SMEMBERS', 'kodlarim:' + anahtar)) await redis('SREM', 'kod:kullanan:' + h, anahtar);
  await redis('SREM', 'push:kullanicilar', anahtar);
  if (k && k.okul) await redis('HINCRBY', 'okul:uye', k.okul.toLocaleLowerCase('tr-TR'), -1);
  for (const id of await redis('SMEMBERS', 'akis:benim:' + anahtar)) {
    await redis('HDEL', 'akis:gonderi', id); await redis('HDEL', 'akis:resim', id); await redis('ZREM', 'akis:zaman', id);
    await redis('DEL', 'begeni:' + id, 'begeniKredi:' + id);
  }
  const h = haftaNo();
  for (const t of ['fidan', 'alan', 'sulama', 'puan', 'fuzyon']) await redis('ZREM', `h:${h}:${t}`, anahtar);
  await redis('DEL', 'kullanici:' + anahtar, 'durum:' + anahtar,
    'benim:' + anahtar, 'arkadas:' + anahtar, 'giden:' + anahtar, 'istekler:' + anahtar, 'avatar:' + anahtar,
    'hediye:' + anahtar, 'bildirim:' + anahtar, 'aktif:' + anahtar, 'akis:benim:' + anahtar, 'kodlarim:' + anahtar,
    'push:' + anahtar, 'pushayar:' + anahtar);
}
