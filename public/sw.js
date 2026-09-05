// Service Worker para soporte de instalación nativa PWA (Android / iOS / PC)
const CACHE_NAME = 'sysinventory-cache-v100';

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((name) => {
          if (name !== CACHE_NAME) {
            return caches.delete(name);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  // Las peticiones a la API, eventos en tiempo real y descargas de APK siempre van directo a la red
  if (url.pathname.startsWith('/api') || url.pathname.startsWith('/download-apk') || url.pathname.includes('.apk')) {
    event.respondWith(fetch(event.request));
    return;
  }

  // Red primero para archivos estáticos con fallback a caché offline
  event.respondWith(
    fetch(event.request).catch(() => {
      return caches.match(event.request);
    })
  );
});
