// Service worker — cache shell + content for offline use
const CACHE = 'aplus-study-v22';
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './lib.mjs',
  './crypto.mjs',
  './manifest.json',
  './data/questions.json',         // Core 1 questions
  './data/concept-fixes.json',     // Core 1 concept fixes
  './data/core2/questions.json',   // Core 2 questions (empty scaffold)
  './data/core2/concept-fixes.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
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
  event.respondWith(
    caches.match(event.request).then((cached) => {
      return cached || fetch(event.request).then((res) => {
        // Cache new responses for next time
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(event.request, copy).catch(() => {}));
        return res;
      }).catch(() => cached);
    })
  );
});
