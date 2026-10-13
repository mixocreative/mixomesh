// Task 8.7: PWA manifest, service worker and registration predicate.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import { shouldRegisterServiceWorker } from '../src/app/pwa.js';

const root = new URL('../', import.meta.url);
const read = p => readFileSync(new URL(p, root), 'utf8');

test('manifest has required installable fields', () => {
  const m = JSON.parse(read('public/manifest.webmanifest'));
  assert.equal(m.name, 'MIXOMESH');
  assert.ok(m.short_name);
  assert.equal(m.start_url, './');
  assert.equal(m.scope, './');
  assert.equal(m.display, 'standalone');
  assert.match(m.theme_color, /^#[0-9a-f]{6}$/i);
  assert.match(m.background_color, /^#[0-9a-f]{6}$/i);
  const sizes = m.icons.map(i => `${i.sizes}/${i.purpose}`);
  for (const need of ['192x192/any', '512x512/any', '512x512/maskable']) assert.ok(sizes.includes(need), need);
  for (const icon of m.icons) assert.ok(existsSync(new URL(`public/${icon.src}`, root)), icon.src);
});

test('index.html links manifest, touch icon and standalone meta', () => {
  const html = read('index.html');
  assert.match(html, /<link rel="manifest"/);
  assert.match(html, /<link rel="apple-touch-icon"/);
  assert.match(html, /name="apple-mobile-web-app-capable" content="yes"/);
  assert.ok(existsSync(new URL('public/icons/apple-touch-icon.png', root)));
});

test('sw.js parses and precaches vendor + env files that exist', () => {
  const src = read('public/sw.js');
  const listeners = {};
  const ctx = {
    self: { addEventListener: (t, f) => { listeners[t] = f; }, location: { origin: 'https://x' } },
    caches: {}, fetch() {}, URL,
  };
  vm.runInNewContext(src, ctx); // parses + registers handlers without throwing
  assert.deepEqual(Object.keys(listeners).sort(), ['activate', 'fetch', 'install']);
  const list = /const PRECACHE = \[([\s\S]*?)\];/.exec(src)[1].match(/'([^']+)'/g).map(s => s.slice(1, -1));
  for (const need of ['./vendor/manifold-3d/manifold.wasm', './vendor/meshfix/mesh-fix-core.wasm',
    './vendor/meshfix/mesh-fix-lib.js', './env/studio.env', './env/neutral.env', './env/outdoor.env']) {
    assert.ok(list.includes(need), need);
  }
  for (const u of list.filter(u => u !== './')) {
    assert.ok(existsSync(new URL(`public/${u.slice(2)}`, root)), `precache file missing: ${u}`);
  }
  assert.match(src, /CACHE_VERSION/);
  assert.match(src, /caches\.delete/);
});

test('registration predicate: hosted prod only, never Electron/file/dev', () => {
  const base = { protocol: 'https:', isElectron: false, isProd: true, hasServiceWorker: true };
  assert.equal(shouldRegisterServiceWorker(base), true);
  assert.equal(shouldRegisterServiceWorker({ ...base, protocol: 'http:' }), true);
  assert.equal(shouldRegisterServiceWorker({ ...base, protocol: 'file:' }), false);
  assert.equal(shouldRegisterServiceWorker({ ...base, isElectron: true }), false);
  assert.equal(shouldRegisterServiceWorker({ ...base, isProd: false }), false);
  assert.equal(shouldRegisterServiceWorker({ ...base, hasServiceWorker: false }), false);
  assert.equal(shouldRegisterServiceWorker(), false);
});
