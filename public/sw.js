const CACHE_NAME = 'nyanbook-v6';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/playground.html',
  '/login.html',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png',
  '/css/dashboard.css',
  '/css/auth.css',
  '/css/components/cat-animation.css',
  '/css/components/enhancements.css',
  '/css/components/media-modal.css',
  '/css/components/tooltips.css',
  '/css/components/analytics.css',
  '/js/dashboard.js',
  '/js/sw-register.js',
  '/js/modules/auth.js',
  '/js/modules/books.js',
  '/js/modules/state.js',
  '/js/modules/messages.js',
  '/js/modules/data-sync.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => {
        console.log('🐱 Nyanbook: Caching static assets');
        return cache.addAll(STATIC_ASSETS);
      })
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter((name) => name !== CACHE_NAME)
          .map((name) => {
            console.log('🐱 Nyanbook: Removing old cache:', name);
            return caches.delete(name);
          })
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  
  const url = new URL(event.request.url);
  if (url.pathname.startsWith('/api/')) return;
  
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.status === 200) {
          const responseClone = response.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseClone);
          });
        }
        return response;
      })
      .catch(() => {
        return caches.match(event.request);
      })
  );
});
