// Offline-first service worker for the app shell. Bump VERSION to refresh caches.
const VERSION = 'v2';
const CACHE = `pdf2epub-${VERSION}`;
const ASSETS = [
  './', './index.html', './styles.css', './app.js', './converter.js', './book.js',
  './manifest.webmanifest',
  './lib/pdf.min.mjs', './lib/pdf.worker.min.mjs', './lib/jszip.min.js',
  './icons/icon-192.png', './icons/icon-512.png', './icons/icon-maskable-512.png', './icons/apple-touch-icon.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then((hit) => {
      const net = fetch(req).then((res) => {
        if (res.ok) caches.open(CACHE).then((c) => c.put(req, res.clone()));
        return res;
      });
      return hit || net.catch(() => caches.match('./index.html'));
    })
  );
});
