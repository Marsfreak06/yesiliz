// Kullanıcı adı değişince hesabın bütün kayıtlarını eski anahtardan yeni anahtara taşır.
// Taşınanlar: ilerleme, profil fotoğrafı, arkadaşlıklar ve istekler (karşı taraftaki kayıtlar dahil), haritadaki
// fidanlar ve alanlar (sahiplik ve ekip üyeliği), akış paylaşımları ve beğeniler, değerlendirme, gizli kod kullanımı,
// bildirim abonelikleri, bu hafta ile geçen haftanın sıralama puanları. Kullanıcı kaydının kendisini çağıran taraf yazar.
import { redis, haftaNo, jsonOku, ciftler } from './_db.js';

const KISISEL = ['durum', 'benim', 'arkadas', 'giden', 'istekler', 'avatar', 'hediye', 'bildirim', 'aktif',
  'akis:benim', 'kodlarim', 'push', 'pushayar'];

async function uyeTasi(kume, eski, yeni) {
  if (await redis('SREM', kume, eski)) await redis('SADD', kume, yeni);
}

export async function hesabiTasi(eski, yeni, eskiAd, yeniAd) {
  for (const o of await redis('SMEMBERS', 'arkadas:' + eski)) await uyeTasi('arkadas:' + o, eski, yeni);
  for (const o of await redis('SMEMBERS', 'giden:' + eski)) await uyeTasi('istekler:' + o, eski, yeni);
  for (const o of await redis('SMEMBERS', 'istekler:' + eski)) await uyeTasi('giden:' + o, eski, yeni);
  for (const h of await redis('SMEMBERS', 'kodlarim:' + eski)) await uyeTasi('kod:kullanan:' + h, eski, yeni);
  await uyeTasi('push:kullanicilar', eski, yeni);

  const deg = jsonOku(await redis('HGET', 'degerlendirmeler', eski));
  if (deg) {
    await redis('HSET', 'degerlendirmeler', yeni, JSON.stringify({ ...deg, ad: yeniAd }));
    await redis('HDEL', 'degerlendirmeler', eski);
  }

  const h = haftaNo();
  for (const hafta of [h, h - 1]) {
    for (const t of ['fidan', 'alan', 'sulama', 'puan', 'fuzyon']) {
      const k = `h:${hafta}:${t}`, skor = await redis('ZSCORE', k, eski);
      if (skor === null || skor === undefined) continue;
      await redis('ZADD', k, skor, yeni);
      await redis('ZREM', k, eski);
    }
  }

  for (const id of await redis('SMEMBERS', 'akis:benim:' + eski)) {
    const p = jsonOku(await redis('HGET', 'akis:gonderi', id));
    if (p) await redis('HSET', 'akis:gonderi', id, JSON.stringify({ ...p, sahip: yeni, ad: yeniAd }));
  }
  for (const id of await redis('ZRANGE', 'akis:zaman', 0, -1)) {
    await uyeTasi('begeni:' + id, eski, yeni);
    await uyeTasi('begeniKredi:' + id, eski, yeni);
  }

  for (const tablo of ['fidanlar', 'alanlar']) {
    for (const [id, ham] of ciftler(await redis('HGETALL', tablo))) {
      const f = jsonOku(ham);
      if (!f) continue;
      let degisti = false;
      if (f.sahip === eski) { f.sahip = yeni; f.ad = yeniAd; degisti = true; }
      for (const e of Array.isArray(f.ekip) ? f.ekip : []) if (e && e.a === eski) { e.a = yeni; e.ad = yeniAd; degisti = true; }
      if (f.sonSulayan && f.sonSulayan === eskiAd) { f.sonSulayan = yeniAd; degisti = true; }
      if (degisti) await redis('HSET', tablo, id, JSON.stringify(f));
    }
  }

  for (const on of KISISEL) {
    if (Number(await redis('EXISTS', `${on}:${eski}`))) await redis('RENAME', `${on}:${eski}`, `${on}:${yeni}`);
  }
}
