// Task 8.7: PWA manifest, service worker and registration predicate.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import { shouldRegisterServiceWorker } from '../src/app/pwa.js';
import { batchFromLaunchFiles } from '../src/core/LaunchRequests.js';

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

test('sw.js parses; shell is stamped per build, vendor wasm is runtime-cached', () => {
  const src = read('public/sw.js');
  const listeners = {};
  const ctx = {
    self: { addEventListener: (t, f) => { listeners[t] = f; }, location: { origin: 'https://x' } },
    caches: {}, fetch() {}, URL,
  };
  vm.runInNewContext(src, ctx); // parses + registers handlers without throwing
  assert.deepEqual(Object.keys(listeners).sort(), ['activate', 'fetch', 'install', 'message']);
  assert.match(src, /__BUILD_ID__/);          // stamped by vite.config.ts serviceWorkerVersion()
  assert.match(src, /\/\*__BUILD_ASSETS__\*\/ \[\]/);
  assert.doesNotMatch(src.match(/const PRECACHE = [^;]*;/)[0], /vendor/); // runtime-cached
  assert.match(src, /SKIP_WAITING/);
  assert.doesNotMatch(src.match(/addEventListener\('install'[\s\S]*?\n\}\);/)[0], /skipWaiting/); // a new worker WAITS for the update toast
  assert.match(src, /caches\.delete/);
});

test('manifest declares file handlers for every importable type', () => {
  const m = JSON.parse(read('public/manifest.webmanifest'));
  const exts = Object.values(m.file_handlers[0].accept).flat();
  for (const e of ['.stl', '.3mf', '.obj', '.glb', '.gltf', '.mixo']) assert.ok(exts.includes(e), e);
});

test('launchQueue handles become a launch batch (.mixo = project, rest = import)', () => {
  const h = name => ({ kind: 'file', name });
  const batch = batchFromLaunchFiles([h('a.STL'), h('p.mixo'), { kind: 'directory', name: 'd' }]);
  assert.deepEqual(batch.items.map(i => [i.kind, i.name]), [['import', 'a.STL'], ['project', 'p.mixo']]);
  assert.equal(batchFromLaunchFiles([]), null);
  assert.equal(batchFromLaunchFiles(undefined), null);
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
