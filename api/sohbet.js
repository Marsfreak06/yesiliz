// Yaprak chatbotu: son birkaç mesajı Gemini'ye gönderip yanıt alır.
import { cevap, islem, gemini } from './_gemini.js';

// Yedek modeller denenirken süre yetsin.
export const config = { maxDuration: 60 };

const SISTEM = 'Adın Yaprak. Yeşiliz uygulamasında ortaokul ve lise öğrencilerine iklim değişikliği, çevre, geri dönüşüm, '
  + 'sürdürülebilirlik, yeşil beceriler ve TYMM OB8 Sürdürülebilirlik Okuryazarlığı hakkında yardım ediyorsun. '
  + 'Türkçe, sade ve samimi yaz; yanıtın en fazla 4-5 cümle olsun. Emin olmadığın bilgiyi uydurma. '
  + 'Konu dışı sorularda kibarca iklim ve çevre konularına yönlendir. Öğrenciden kişisel bilgi isteme.';

export default function handler(req, res) {
  return islem(req, res, 'sohbet', 40, async (istek, ayar) => {
    const mesajlar = Array.isArray(istek.messages) ? istek.messages.slice(-8) : [];
    const icerik = mesajlar
      .map(m => ({ role: m && m.me ? 'user' : 'model', text: String((m && m.t) || '').trim().slice(0, 600) }))
      .filter(m => m.text)
      .map(m => ({ role: m.role, parts: [{ text: m.text }] }));
    while (icerik.length && icerik[0].role !== 'user') icerik.shift();
    if (!icerik.length || icerik[icerik.length - 1].role !== 'user') return cevap(res, 400, { hata: 'Soru bulunamadı' });

    const yanit = await gemini(ayar, {
      system_instruction: { parts: [{ text: SISTEM }] },
      contents: icerik,
      generationConfig: { temperature: 0.6 },
    });
    cevap(res, 200, { yanit: yanit.trim() });
  });
}
