const CACHE_NAME = 'chantier-app-v94';
const ASSETS = ['/Chantier-APP/chantier-app.html','/Chantier-APP/manifest.json'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(ASSETS))); self.skipWaiting(); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))); self.clients.claim(); });
self.addEventListener('fetch', e => { if (e.request.url.includes('api.baserow.io')) return; e.respondWith(caches.match(e.request).then(cached => cached || fetch(e.request).then(r => { caches.open(CACHE_NAME).then(c => c.put(e.request, r.clone())); return r; })).catch(() => caches.match('/Chantier-APP/chantier-app.html'))); });
