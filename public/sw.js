// MIXOMESH service worker (task 8.7). Hosted web build only (see src/app/pwa.js).
// Strategy:
//  - index.html / navigations: network-first, cached copy when offline.
//  - everything else same-origin GET (hashed ./assets/*, vendored WASM, HDRI
//    env, icons, manifest): cache-first, filled on first use. Hashed build
//    names are immutable, so cache-first is safe; vendor/env change only with
//    a CACHE_VERSION bump.
// Bump CACHE_VERSION whenever vendored files change; old caches are deleted.

const CACHE_VERSION = 'v2';
const CACHE = `mixomesh-${CACHE_VERSION}`;

const PRECACHE = [
  './',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
  './vendor/manifold-3d/manifold.js',
  './vendor/manifold-3d/manifold.wasm',
  './vendor/draco/draco_wasm_wrapper_gltf.js',
  './vendor/draco/draco_decoder_gltf.wasm',
  './vendor/meshfix/mesh-fix-core.js',
  './vendor/meshfix/mesh-fix-core.wasm',
  './vendor/meshfix/mesh-fix-lib.js',
  './env/neutral.env',
  './env/outdoor.env',
  './env/studio.env',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE)
      // Tolerate a missing optional file: one 404 must not block install.
      .then(cache => Promise.allSettled(PRECACHE.map(url => cache.add(url))))
      .then(() => self.skipWaiting()),
  );
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
    const hit = (await cache.match(request)) || (await cache.match('./'));
    if (hit) return hit;
    throw err;
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(request);
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
