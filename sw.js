const CACHE_NAME = 'chantier-app-V3';
const ASSETS = [
  '/Chantier-APP/chantier-app.html',
  '/Chantier-APP/manifest.json',
];
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache =>
      Promise.all(ASSETS.map(url =>
        fetch(url + '?v=' + CACHE_NAME, { cache: 'reload' })
          .then(response => cache.put(url, response))
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
  if (e.request.url.includes('api.baserow.io')) return;

  // Navigation (ouverture/rechargement de l'appli) : toujours réseau en priorité,
  // pour ne jamais servir une version obsolète depuis le cache. Le cache ne sert
  // que de secours hors-ligne.
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request, { cache: 'no-store' })
        .then(response => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put('/Chantier-APP/chantier-app.html', clone));
          return response;
        })
        .catch(() => caches.match('/Chantier-APP/chantier-app.html'))
    );
    return;
  }

  // Autres ressources (manifest, images, etc.) : cache d'abord pour la vitesse et
  // le hors-ligne, réseau en secours.
  e.respondWith(
    caches.match(e.request).then(cached => {
      return cached || fetch(e.request).then(response => {
        const clone = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone));
        return response;
      });
    }).catch(() => caches.match('/Chantier-APP/chantier-app.html'))
  );
});
