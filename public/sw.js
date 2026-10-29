// MIXOMESH service worker (tasks 8.7, PW.2). Hosted web build only (see src/app/pwa.js).
// Strategy:
//  - app shell (index.html, hashed ./assets/*, fonts, icons, env, manifest): PRECACHED at
//    install. vite.config.ts (serviceWorkerVersion) rewrites BUILD_ID and BUILD_ASSETS at build time, so the
//    cache name changes whenever the shipped file list changes (hashed names make that every
//    content change) and the previous cache is deleted on activate.
//  - navigations: network-first, cached shell when offline.
//  - ./vendor/* (large WASM) and everything else same-origin GET: cache-first, filled on first use.
//  - 'prefetch-vendor' message (PW.2b, sent by src/app/pwa.js when idle): fills the SAME cache with
//    every engine file in VENDOR, so repair/Boolean/Draco/supports work offline before first use.
//  - cross-origin requests are never touched.
//  - a new worker WAITS; the page asks it to take over (SKIP_WAITING) from the update toast.

const BUILD_ID = '__BUILD_ID__';
const BUILD_ASSETS = /*__BUILD_ASSETS__*/ [];
const VENDOR = /*__VENDOR_FILES__*/ [];
const CACHE = `mixomesh-${BUILD_ID}`;

// Precache entries are added without an Origin header; module scripts request WITH one, so a
// server's `Vary: Origin` (vite preview, CORS middleware) would otherwise miss every hit.
const MATCH = { ignoreVary: true };

const PRECACHE = ['./', './manifest.webmanifest', ...BUILD_ASSETS];

// One file at a time: the engines are large WASM and this must not compete with the page's own loads.
async function prefetchVendor() {
  const cache = await caches.open(CACHE);
  for (const url of VENDOR) {
    if (await cache.match(url, MATCH)) continue;
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const blob = await res.blob();
      await cache.put(url, new Response(blob, { headers: res.headers }));
    } catch {
      // Offline or failed: the file stays uncached and cache-first fetches it on first use.
    }
  }
}

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE)
      // Tolerate a missing optional file: one 404 must not block install.
      .then(cache => Promise.allSettled(PRECACHE.map(url => cache.add(url)))),
  );
});

self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
  if (event.data && event.data.type === 'prefetch-vendor') event.waitUntil(prefetchVendor());
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys
        .filter(k => k.startsWith('mixomesh-') && k !== CACHE)
        .map(k => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch (err) {
    const hit = (await cache.match(request, MATCH)) || (await cache.match('./', MATCH));
    if (hit) return hit;
    throw err;
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(request, MATCH);
  if (hit) return hit;
  const response = await fetch(request);
  if (response.ok && response.status === 200) cache.put(request, response.clone());
  return response;
}

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (request.headers.has('range')) return; // partial responses are not cacheable
  if (request.mode === 'navigate' || url.pathname.endsWith('/index.html')) {
    event.respondWith(networkFirst(request));
    return;
  }
  event.respondWith(cacheFirst(request));
});
