// Service Worker — Belfast Obras v3 — sin caché agresivo
const CACHE_NAME = 'belfast-obras-v3';

self.addEventListener('install', e => { self.skipWaiting(); });

self.addEventListener('activate', e => {
    e.waitUntil(
        caches.keys().then(keys =>
            Promise.all(keys.map(k => caches.delete(k)))
        ).then(() => self.clients.claim())
    );
});

// Sin caché — siempre red
self.addEventListener('fetch', e => {
    if (e.request.method !== 'GET') return;
    e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
});

self.addEventListener('push', e => {
    if (!e.data) return;
    const data = e.data.json();
    e.waitUntil(
        self.registration.showNotification(data.title || 'Belfast Obras', {
            body: data.body || '',
            icon: '/icons/belfast-logo.jpeg',
            badge: '/icons/icon-192.png',
            data: data,
            vibrate: [200, 100, 200],
            tag: data.tag || 'belfast-notif',
            renotify: true,
        })
    );
});

self.addEventListener('notificationclick', e => {
    e.notification.close();
    e.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
            if (list.length > 0) return list[0].focus();
            return clients.openWindow('/dashboard');
        })
    );
});
