// Offline support: the app shell is cached so it opens instantly, even with
// no signal. Same-origin files are network-first (so updates arrive quickly)
// with a short timeout; CDN files (on-device OCR engine) are cache-first.
const VERSION = 'v9';
const SHELL = `shell-${VERSION}`;
const CDN = 'cdn-v1';
const ASSETS = [
  './',
  './index.html',
  './css/styles.css',
  './js/app.js',
  './js/split.js',
  './js/parser.js',
  './js/ocr.js',
  './js/gemini.js',
  './js/config.js',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  // cache: 'reload' skips the browser's HTTP cache so a new version never
  // precaches stale files (GitHub Pages sends max-age=600).
  e.waitUntil(
    caches
      .open(SHELL)
      .then((c) => c.addAll(ASSETS.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL && k !== CDN).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

function timeout(ms) {
  return new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms));
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Big, versioned OCR files: cache-first.
  if (url.origin === self.location.origin && url.pathname.includes('/vendor/')) {
    e.respondWith(
      caches.open(CDN).then(async (cache) => {
        const hit = await cache.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok) cache.put(req, res.clone());
        return res;
      }),
    );
    return;
  }

  if (url.origin === self.location.origin) {
    e.respondWith(
      (async () => {
        const cache = await caches.open(SHELL);
        try {
          // Always revalidate with GitHub so updates show up straight away.
          const fresh =
            req.mode === 'navigate'
              ? fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' })
              : fetch(req, { cache: 'no-cache' });
          const res = await Promise.race([fresh, timeout(3500)]);
          if (res.ok) cache.put(req, res.clone());
          return res;
        } catch {
          const hit = (await cache.match(req, { ignoreSearch: true })) || (req.mode === 'navigate' && (await cache.match('./index.html')));
          return hit || Response.error();
        }
      })(),
    );
    return;
  }

  if (url.hostname === 'cdn.jsdelivr.net' || url.hostname.endsWith('projectnaptha.com')) {
    e.respondWith(
      caches.open(CDN).then(async (cache) => {
        const hit = await cache.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok || res.type === 'opaque') cache.put(req, res.clone());
        return res;
      }),
    );
  }
});
