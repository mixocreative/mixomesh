// PW.2: installable web app proof against `vite preview` of the production build.
//   manifest valid + linked, service worker registered AND controlling, the page reloads and
//   boots with the server gone (offline), and a file handed to a simulated launchQueue opens.
//   Run `npm run build` first (the npm script does).
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  findBrowser, freePort, waitForHttp, waitForBrowserWs, openTarget,
  Cdp, evaluate, waitFor, assert, removeTempDir, stopProcess,
} from './cdp-harness.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const VITE_BIN = join(ROOT, 'node_modules/vite/bin/vite.js');
const BOOTED = `document.readyState === 'complete' && document.querySelector('#boot-status') === null
  && !!document.querySelector('#ol-list') && !!document.querySelector('#renderCanvas')`;
const STL = [
  'solid t',
  'facet normal 0 0 -1', 'outer loop', 'vertex 0 0 0', 'vertex 0 10 0', 'vertex 10 0 0', 'endloop', 'endfacet',
  'facet normal 0 -1 0', 'outer loop', 'vertex 0 0 0', 'vertex 10 0 0', 'vertex 0 0 10', 'endloop', 'endfacet',
  'facet normal -1 0 0', 'outer loop', 'vertex 0 0 0', 'vertex 0 0 10', 'vertex 0 10 0', 'endloop', 'endfacet',
  'facet normal 1 1 1', 'outer loop', 'vertex 10 0 0', 'vertex 0 10 0', 'vertex 0 0 10', 'endloop', 'endfacet',
  'endsolid t', '',
].join('\n');

async function main() {
  assert(existsSync(join(ROOT, 'dist/index.html')), 'dist/ missing: run npm run build first');
  // PW.2b: the engine list the build stamped into sw.js (vite.config.ts serviceWorkerVersion).
  const VENDOR = JSON.parse(readFileSync(join(ROOT, 'dist/sw.js'), 'utf8').match(/const VENDOR = (\[[\s\S]*?\]);/)[1]);
  assert(VENDOR.length >= 8, `vendor engine list too short: ${VENDOR.length}`);
  for (const f of VENDOR) {
    assert(existsSync(join(ROOT, 'dist', f.slice(2))), `vendor file missing from dist: ${f}`);
    assert(!/NOTICE\.md|LICENSE|\.d\.ts$|SOURCE\.json$/.test(f), `non-engine file listed for prefetch: ${f}`);
  }
  for (const dir of ['meshfix', 'manifold-3d', 'draco', 'mixo-geocore']) {
    assert(VENDOR.some(f => f.startsWith(`./vendor/${dir}/`)), `no ${dir} engine in prefetch list`);
  }
  const browserPath = findBrowser();
  assert(browserPath, 'Chrome/Edge executable not found.');
  const appPort = await freePort();
  const debugPort = await freePort();
  const userDataDir = mkdtempSync(join(tmpdir(), 'mixomesh-pwa-'));
  const preview = spawn(process.execPath, [VITE_BIN, 'preview', '--host', '127.0.0.1', '--port', String(appPort), '--strictPort'],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  const previewOut = [];
  preview.stdout.on('data', c => previewOut.push(String(c)));
  preview.stderr.on('data', c => previewOut.push(String(c)));
  const browser = spawn(browserPath, [
    '--headless=new', '--no-sandbox', '--disable-dev-shm-usage',
    '--use-angle=swiftshader', '--use-gl=angle', '--enable-unsafe-swiftshader',
    '--window-size=1600,950', '--no-first-run', '--no-default-browser-check',
    `--remote-debugging-port=${debugPort}`, `--user-data-dir=${userDataDir}`, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  const browserStderr = [];
  browser.stderr.on('data', c => browserStderr.push(String(c)));
  let previewStopped = false;
  try {
    const url = `http://127.0.0.1:${appPort}/`;
    await waitForHttp(`${url}index.html`, 30000, previewOut);
    await waitForBrowserWs(debugPort, browserStderr);
    const target = await openTarget(debugPort, 'about:blank');
    const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('Network.enable');
    const netFails = [];
    const reqUrls = new Map();
    cdp.onEvent = (msg) => {
      if (msg.method === 'Network.requestWillBeSent') reqUrls.set(msg.params.requestId, msg.params.request.url);
      if (msg.method === 'Network.loadingFailed') netFails.push(`${reqUrls.get(msg.params.requestId)} ${msg.params.errorText}`);
      if (msg.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(msg.params.type)) netFails.push(`console.${msg.params.type} ${msg.params.args.map(a => a.value ?? a.description ?? '').join(' ').slice(0, 200)}`);
      if (msg.method === 'Runtime.exceptionThrown') netFails.push(`exception ${msg.params.exceptionDetails?.exception?.description ?? msg.params.exceptionDetails?.text}`);
    };
    // Simulated launch queue: capture the consumer the app registers.
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      // Chrome ships a real window.launchQueue accessor: a plain assignment would not replace it.
      source: "Object.defineProperty(window, 'launchQueue', { configurable: true, value: { setConsumer(fn) { window.__lqConsumer = fn; } } });",
    });

    await cdp.send('Page.navigate', { url });
    await waitFor(() => evaluate(cdp, BOOTED), 90000, 'first boot');

    // 1. Manifest linked + valid.
    const mani = await evaluate(cdp, `(async () => {
      const link = document.querySelector('link[rel="manifest"]');
      const res = await fetch(link.href);
      return { href: link.href, ok: res.ok, json: await res.json() };
    })()`);
    assert(mani.ok && mani.href.endsWith('/manifest.webmanifest'), 'manifest not linked or not served');
    const m = mani.json;
    assert(m.name === 'MIXOMESH' && m.display === 'standalone' && m.start_url === './' && m.scope === './', 'manifest core fields');
    const sizes = m.icons.map(i => `${i.sizes}/${i.purpose}`);
    for (const need of ['192x192/any', '512x512/any', '512x512/maskable']) assert(sizes.includes(need), `icon ${need}`);
    const exts = m.file_handlers?.[0]?.accept ? Object.values(m.file_handlers[0].accept).flat() : [];
    for (const e of ['.stl', '.3mf', '.obj', '.glb', '.gltf', '.mixo']) assert(exts.includes(e), `file handler ${e}`);
    for (const icon of m.icons) {
      const ok = await evaluate(cdp, `fetch(new URL(${JSON.stringify(icon.src)}, document.baseURI)).then(r => r.ok)`);
      assert(ok, `icon not served: ${icon.src}`);
    }
    console.log('manifest ok');

    // 2. Service worker registered, controlling, precache filled under a versioned name.
    await waitFor(() => evaluate(cdp, 'navigator.serviceWorker.getRegistration().then(r => !!r?.active)'), 60000, 'SW active');
    await waitFor(() => evaluate(cdp, '!!navigator.serviceWorker.controller'), 30000, 'SW controlling');
    let cacheInfo = null;
    await waitFor(async () => {
      cacheInfo = await evaluate(cdp, `(async () => {
        const names = (await caches.keys()).filter(k => k.startsWith('mixomesh-'));
        if (names.length !== 1) return null;
        const keys = await (await caches.open(names[0])).keys();
        return { name: names[0], count: keys.length };
      })()`);
      return !!cacheInfo && cacheInfo.count > 500;
    }, 120000, 'precache filled');
    assert(/^mixomesh-[0-9a-f]{12}$/.test(cacheInfo.name), `versioned cache name: ${cacheInfo.name}`);
    console.log(`service worker ok (${cacheInfo.name}, ${cacheInfo.count} entries)`);

    // 2b. Idle vendor prefetch (PW.2b): every engine lands in the SAME versioned cache, unasked.
    const wantVendor = VENDOR.map(f => new URL(f, url).pathname);
    let missingVendor = wantVendor;
    await waitFor(async () => {
      missingVendor = await evaluate(cdp, `(async () => {
        const have = new Set((await (await caches.open(${JSON.stringify(cacheInfo.name)})).keys()).map(r => new URL(r.url).pathname));
        return ${JSON.stringify(wantVendor)}.filter(p => !have.has(p));
      })()`);
      return missingVendor.length === 0;
    }, 120000, 'vendor prefetch');
    console.log(`vendor prefetch ok (${VENDOR.length} engine files)`);

    // 3. Offline reload: stop the server, reload, the app boots from the cache.
    await stopProcess(preview);
    previewStopped = true;
    let dead = false;
    try { await fetch(`${url}index.html`, { signal: AbortSignal.timeout(2000) }); } catch { dead = true; }
    assert(dead, 'preview server still answering');
    await cdp.send('Page.reload');
    try {
      await waitFor(() => evaluate(cdp, BOOTED), 90000, 'offline boot');
    } catch (err) {
      const info = await evaluate(cdp, `JSON.stringify({ href: location.href, text: document.body.innerText.slice(0, 300), ctl: !!navigator.serviceWorker.controller })`).catch(e => String(e));
      throw new Error(`${err.message}: ${info} ${netFails.slice(-15).join(' | ')}`);
    }
    assert(await evaluate(cdp, '!!navigator.serviceWorker.controller'), 'offline page not SW-controlled');
    console.log('offline reload ok');

    // 3b. Engines were prefetched, so with the server dead each one is still served (from cache).
    const offlineVendor = await evaluate(cdp, `(async () => {
      const bad = [];
      for (const f of ${JSON.stringify(VENDOR)}) {
        const status = await fetch(new URL(f, document.baseURI)).then(r => r.status, e => 'ERR ' + e.message);
        if (status !== 200) bad.push(f + ' ' + status);
      }
      return bad;
    })()`);
    assert(offlineVendor.length === 0, `vendor engines not served offline: ${offlineVendor.join(' | ')}`);
    console.log(`offline vendor ok (${VENDOR.length} engine files from cache)`);

    // 4. launchQueue: a real OPFS file handle (the kind the OS hands over) opens like a drop.
    try {
      await waitFor(() => evaluate(cdp, "typeof window.__lqConsumer === 'function'"), 30000, 'launchQueue consumer registered');
    } catch (err) {
      throw new Error(`${err.message}: lq=${await evaluate(cdp, 'typeof window.launchQueue')} ${netFails.slice(-10).join(' | ')}`);
    }
    const rowsBefore = await evaluate(cdp, "document.querySelectorAll('#ol-list .ol-row').length");
    await evaluate(cdp, `(async () => {
      const root = await navigator.storage.getDirectory();
      const h = await root.getFileHandle('lq-tetra.stl', { create: true });
      const w = await h.createWritable();
      await w.write(${JSON.stringify(STL)});
      await w.close();
      window.__lqConsumer({ files: [h] });
    })()`);
    await waitFor(() => evaluate(cdp, "document.querySelectorAll('#ol-list .ol-row').length").then(n => n > rowsBefore),
      60000, 'launchQueue file opened');
    console.log('launchQueue open ok');
    await cdp.close();
    console.log('PWA SMOKE PASS');
  } finally {
    await stopProcess(browser);
    if (!previewStopped) await stopProcess(preview);
    removeTempDir(userDataDir);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
