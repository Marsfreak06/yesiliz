// Veritabanı (Upstash Redis REST) ve oturum yardımcıları.
// Bağlantı bilgileri Vercel'de Upstash eklenince otomatik gelen ortam değişkenlerinden okunur.
import { scrypt as _scrypt } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(_scrypt);

function baglanti() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url, token } : null;
}

export const dbVar = () => baglanti() !== null;

export async function redis(...komut) {
  const b = baglanti();
  if (!b) throw new Error('Veritabanı bağlı değil');
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
