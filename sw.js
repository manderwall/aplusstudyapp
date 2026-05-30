// Service worker — cache shell + content for offline use
const CACHE = 'aplus-study-v83';
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './lib.mjs',
  './crypto.mjs',
  './manifest.json',
  './data/core2/questions.json',
  './data/core2/concept-fixes.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/share-qr.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  // Only cache same-origin GETs. Cross-origin opaque responses (e.g. the
  // pdf.js CDN) used to be persisted forever in the versioned cache —
  // poisoning vector if a CDN response was ever tampered with, and
  // unbounded cache growth. Pass them through to the network/browser
  // cache without storing them ourselves.
  const sameOrigin = new URL(event.request.url).origin === self.location.origin;
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((res) => {
        // Skip caching for opaque, non-OK, and cross-origin responses.
        if (sameOrigin && res && res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(event.request, copy).catch(() => {}));
        }
        return res;
      }).catch(() => cached);
    })
  );
});

// Tell open clients when a new service worker has taken over so they can
// reload without waiting for the user to delete + reinstall the icon.
// Pairs with the registration code in app.js that listens for 'waiting'
// or 'controllerchange'.
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});
