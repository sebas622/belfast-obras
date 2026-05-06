// Service Worker — Belfast Obras v5 — sin caché
const CACHE_NAME = 'belfast-obras-v5';

self.addEventListener('install', e => { self.skipWaiting(); });

self.addEventListener('activate', e => {
    e.waitUntil(
        caches.keys().then(keys =>
            Promise.all(keys.map(k => caches.delete(k)))
        ).then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', e => {
    if (e.request.method !== 'GET') return;
    e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
});
