// Tiny Map service worker (#18): keeps the app usable offline.
// - App files (same origin): network first, cached copy when offline.
// - OpenFreeMap basemap: tiles, glyphs and sprites from any cache first (offline packages store
//   them in Cache Storage), style/TileJSON network first so builds update when online.
// Overture PMTiles use range requests and are cached in IndexedDB by the app instead.
const SHELL = 'tinymap-shell-v1';

// App files listed at build time (vite.config.ts → precache.json): JS, CSS, workers, ward lists.
self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(
    fetch('precache.json')
      .then((r) => r.json())
      .then(async (files) => {
        const cache = await caches.open(SHELL);
        await Promise.all(files.map((f) => cache.add(new URL(f, self.registration.scope)).catch(() => {})));
      })
      .catch(() => {}),
  );
});
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || req.headers.has('range')) return;
  const url = new URL(req.url);
  if (url.hostname === 'tiles.openfreemap.org') {
    const meta = url.pathname.startsWith('/styles/') || /^\/planet\/?$/.test(url.pathname);
    e.respondWith(meta ? networkFirst(req, null) : cacheFirst(req));
  } else if (url.origin === self.location.origin) {
    e.respondWith(networkFirst(req, SHELL));
  }
});

async function cacheFirst(req) {
  return (await caches.match(req, { ignoreVary: true })) ?? fetch(req);
}

async function networkFirst(req, store) {
  try {
    const res = await fetch(req);
    if (store && res.ok && res.type === 'basic') {
      const copy = res.clone();
      caches.open(store).then((c) => c.put(req, copy));
    }
    return res;
  } catch (err) {
    const hit = await caches.match(req, { ignoreSearch: req.mode === 'navigate', ignoreVary: true });
    if (hit) return hit;
    throw err;
  }
}
