// Veritabanı ve oturum yardımcıları.
// İki tür Redis bağlantısı desteklenir; bilgiler Vercel'de veritabanı projeye bağlanınca gelen
// ortam değişkenlerinden okunur:
//   - Upstash (HTTP/REST): KV_REST_API_URL + KV_REST_API_TOKEN ya da UPSTASH_REDIS_REST_URL + _TOKEN
//   - Redis Cloud vb. (klasik bağlantı): REDIS_URL
import { scrypt as _scrypt } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(_scrypt);

function baglanti() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) return { tur: 'rest', url, token };
  if (process.env.REDIS_URL) return { tur: 'tcp' };
  return null;
}

export const dbVar = () => baglanti() !== null;

// Klasik Redis bağlantısı fonksiyon örneği yaşadıkça yeniden kullanılır.
let istemciSozu = null;
function tcpIstemci() {
  if (!istemciSozu) {
    istemciSozu = (async () => {
      const { createClient } = await import('redis');
      const c = createClient({
        url: process.env.REDIS_URL,
        socket: { connectTimeout: 5000, reconnectStrategy: deneme => (deneme > 2 ? false : 200) },
      });
      c.on('error', e => console.error('redis', e.message));
      await c.connect();
      return c;
    })().catch(e => { istemciSozu = null; throw e; });
  }
  return istemciSozu;
}

export async function redis(...komut) {
  const b = baglanti();
  if (!b) throw new Error('Veritabanı bağlı değil');
  if (b.tur === 'tcp') {
    const c = await tcpIstemci();
    return await c.sendCommand(komut.map(String));
  }
  const r = await fetch(b.url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${b.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(komut),
  });
  const json = await r.json().catch(() => ({}));
  if (!r.ok || json.error) throw new Error('Veritabanı hatası: ' + (json.error || r.status));
  return json.result;
}

export function cerezOku(req, ad) {
  for (const parca of String(req.headers.cookie || '').split(';')) {
    const [k, ...v] = parca.trim().split('=');
    if (k === ad) return decodeURIComponent(v.join('='));
  }
  return null;
}

export const gecerliJeton = t => typeof t === 'string' && /^[a-f0-9]{64}$/.test(t);

// Oturum kaydı "kullanıcı anahtarı|hesabın oluşturulma zamanı" biçimindedir. Hesap silinip aynı adla
// yeniden açılırsa eski hesabın diğer cihazlarda kalan oturumları yeni hesaba erişemez.
export const oturumDegeri = (anahtar, olusturma) => `${anahtar}|${olusturma}`;

export function jsonOku(ham) {
  try { return ham ? JSON.parse(ham) : null; } catch { return null; }
}

// Oturum çerezindeki kullanıcıyı { anahtar, ad } olarak döndürür; geçersizse null.
export async function oturumBilgi(req) {
  const jeton = cerezOku(req, 'oturum');
  if (!gecerliJeton(jeton)) return null;
  const deger = await redis('GET', 'oturum:' + jeton);
  if (!deger) return null;
  const [anahtar, olusturma] = String(deger).split('|');
  const k = jsonOku(await redis('GET', 'kullanici:' + anahtar));
  return k && String(k.olusturma) === olusturma ? { anahtar, ad: k.ad } : null;
}

export async function oturumKullanici(req) {
  const b = await oturumBilgi(req);
  return b ? b.anahtar : null;
}

export const kullaniciAnahtari = ad => String(ad || '').trim().toLocaleLowerCase('tr-TR');

// Türkiye saatine göre gün ve hafta numarası (haftalar pazartesi başlar).
export const gunNo = (t = Date.now()) => Math.floor((t + 3 * 3600_000) / 86400_000);
export const haftaNo = (t = Date.now()) => Math.floor((gunNo(t) + 3) / 7);

// Redis'in düz dizi ya da nesne olarak dönen [alan, değer, alan, değer] cevaplarını çiftlere çevirir.
export function ciftler(cevap) {
  if (!cevap) return [];
  if (!Array.isArray(cevap)) return Object.entries(cevap);
  if (cevap.length && Array.isArray(cevap[0])) return cevap;
  const r = [];
  for (let i = 0; i < cevap.length; i += 2) r.push([cevap[i], cevap[i + 1]]);
  return r;
}

export function govdeAl(req) {
  let g = req.body;
  if (typeof g === 'string') { try { g = JSON.parse(g); } catch { g = null; } }
  return g && typeof g === 'object' ? g : null;
}

export function cevap(res, kod, veri) {
  res.setHeader('Cache-Control', 'no-store');
  res.status(kod).json(veri);
}

// Verilen anahtarların görünen adlarını tek seferde getirir (silinmiş kullanıcılar atlanır).
export async function adlariGetir(anahtarlar) {
  const liste = [...new Set(anahtarlar)].filter(Boolean);
  if (!liste.length) return {};
  const hamlar = await redis('MGET', ...liste.map(a => 'kullanici:' + a));
  const sonuc = {};
  liste.forEach((a, i) => { const k = jsonOku(hamlar[i]); if (k) sonuc[a] = k.ad; });
  return sonuc;
}

export async function sifreOzeti(sifre, tuz) {
  return (await scrypt(sifre, Buffer.from(tuz, 'hex'), 64)).toString('hex');
}
