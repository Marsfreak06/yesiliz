// Yeşiliz bildirim çalışanı: sunucudan gelen bildirimleri gösterir, tıklanınca uygulamayı açar.
// Çevrimdışı önbellek tutmaz; sayfalar her zaman güncel sürümüyle açılır.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { metin: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.baslik || 'Yeşiliz', {
    body: d.metin || '',
    icon: '/ikon-192.png',
    badge: '/ikon-rozet.png',
    tag: d.etiket || 'yesiliz',   // aynı türden bildirimler üst üste yığılmaz, birbirinin yerini alır
    data: { url: d.url || '/' },
    lang: 'tr',
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const hedef = new URL(e.notification.data && e.notification.data.url || '/', self.location.origin).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(pencereler => {
    for (const p of pencereler) if (p.url.startsWith(self.location.origin)) return p.focus();
    return self.clients.openWindow(hedef);
  }));
});
