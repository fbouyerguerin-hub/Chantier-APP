const CACHE_NAME = 'chantier-app-V5'; // ⚠️ à aligner sur APP_VERSION de chantier-app.html à chaque version
const ASSETS = [
  '/Chantier-APP/chantier-app.html',
  '/Chantier-APP/manifest.json',
  '/Chantier-APP/logo-guerin.jpg',
  '/Chantier-APP/plan-atelier.png',
];
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache =>
      Promise.all(ASSETS.map(url =>
        fetch(url + '?v=' + CACHE_NAME, { cache: 'reload' })
          .then(response => { if (response.ok) return cache.put(url, response); })
          .catch(() => {})
      ))
    )
  );
  self.skipWaiting();
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
  ));
  self.clients.claim();
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // Données et services externes (Worker Cloudflare, Baserow, EBP, CDN) :
  // jamais interceptés ni mis en cache — données toujours à jour.
  if (url.origin !== self.location.origin) return;
  if (e.request.method !== 'GET') return;

  // Ouverture / rechargement de l'appli : réseau d'abord, cache en secours hors-ligne
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request, { cache: 'no-store' })
        .then(response => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put('/Chantier-APP/chantier-app.html', clone));
          }
          return response;
        })
        .catch(() => caches.match('/Chantier-APP/chantier-app.html'))
    );
    return;
  }
  // Fichiers de l'appli (logo, plan, icônes, manifeste) : cache d'abord, réseau en secours
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then(cached => cached || fetch(e.request).then(response => {
      if (response && response.ok) {
        const clone = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone));
      }
      return response;
    })).catch(() => caches.match('/Chantier-APP/chantier-app.html'))
  );
});
