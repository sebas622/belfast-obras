// Service Worker — Belfast Obras v6
const CACHE_NAME = 'belfast-obras-v6';
self.addEventListener('install', e => { self.skipWaiting(); });
self.addEventListener('activate', e => {
    e.waitUntil(
        caches.keys()
            .then(keys => Promise.all(keys.map(k => caches.delete(k))))
            .then(() => self.clients.claim())
            .catch(err => console.error('[sw] fallo al activar el service worker:', err))
    );
});
self.addEventListener('fetch', e => {
    if (e.request.method !== 'GET') return;
    // Sin este fallback explícito, un cache miss resuelve con undefined y el
    // navegador muestra un error de red sin explicación.
    e.respondWith(fetch(e.request).catch(async err => {
        const cached = await caches.match(e.request);
        if (cached) return cached;
        console.warn('[sw] sin red y sin caché para', e.request.url, err);
        return new Response('Sin conexión y sin copia en caché.', {
            status: 503,
            statusText: 'Offline',
            headers: { 'Content-Type': 'text/plain; charset=utf-8' }
        });
    }));
});
