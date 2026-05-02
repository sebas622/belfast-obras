// Service Worker — Belfast Obras
// Maneja notificaciones push y caché

const CACHE_NAME = 'belfast-obras-v2';

self.addEventListener('install', e => {
    self.skipWaiting();
});

self.addEventListener('activate', e => {
    e.waitUntil(
        caches.keys().then(keys =>
            Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
        ).then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', e => {
    if (e.request.method !== 'GET') return;
    e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
});

// Notificaciones push
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

// Al tocar la notificación, abrir la app
self.addEventListener('notificationclick', e => {
    e.notification.close();
    e.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
            if (clientList.length > 0) {
                return clientList[0].focus();
            }
            return clients.openWindow('/dashboard');
        })
    );
});
