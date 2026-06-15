const CACHE_NAME = 'chantier-app-v97';
const ASSETS = ['/Chantier-APP/chantier-app.html', '/Chantier-APP/manifest.json'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(ASSETS))); self.skipWaiting(); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))); self.clients.claim(); });
self.addEventListener('fetch', e => { if (e.request.url.includes('api.baserow.io')) return; e.respondWith(caches.match(e.request).then(cached => { if (cached) return cached; return fetch(e.request).then(r => { if (!r || r.status !== 200 || r.type !== 'basic') return r; const c = r.clone(); caches.open(CACHE_NAME).then(cache => cache.put(e.request, c)); return r; }); }).catch(() => caches.match('/Chantier-APP/chantier-app.html'))); });
