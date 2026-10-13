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

// Oturum çerezindeki jetona bağlı kullanıcı anahtarını döndürür; geçersizse null.
export async function oturumKullanici(req) {
  const jeton = cerezOku(req, 'oturum');
  if (!gecerliJeton(jeton)) return null;
  const deger = await redis('GET', 'oturum:' + jeton);
  if (!deger) return null;
  const [anahtar, olusturma] = String(deger).split('|');
  const ham = await redis('GET', 'kullanici:' + anahtar);
  let k = null;
  try { k = ham ? JSON.parse(ham) : null; } catch { k = null; }
  return k && String(k.olusturma) === olusturma ? anahtar : null;
}

export async function sifreOzeti(sifre, tuz) {
  return (await scrypt(sifre, Buffer.from(tuz, 'hex'), 64)).toString('hex');
}
