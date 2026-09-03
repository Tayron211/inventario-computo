// Service Worker para soporte de instalación nativa PWA (Android / iOS / PC)
const CACHE_NAME = 'sysinventory-cache-v1';

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  // Manejo de peticiones de red estándar
  event.respondWith(
    fetch(event.request).catch(() => {
      return caches.match(event.request);
    })
  );
});
