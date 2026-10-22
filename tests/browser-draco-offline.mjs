// Draco glTF import with no network (audit L2-01). Every real customer scan is
// KHR_draco_mesh_compression; Babylon fetches its decoder from
// cdn.babylonjs.com unless told otherwise, the CSP blocks that, and offline
// machines cannot reach it. This drops a Draco GLB onto the viewport (the
// real user path) with every non-local request failed, then asserts the
// import landed with the right triangle count and the decoder came from the
// app's own vendor/draco/. Not part of `npm test` (needs Chrome / Electron):
//
//   node tests/browser-draco-offline.mjs              vite dev server + headless Chrome
//   node tests/browser-draco-offline.mjs --preview    production build (npm run build first)
//   node tests/browser-draco-offline.mjs --electron   built app in the Electron shell
//
// DRACO_FILE=<path> DRACO_TRIS=<n> imports another file instead of
// tests/fixtures/draco-torus.glb (576 triangles), e.g. a real scan.

import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  findBrowser, freePort, waitForHttp, waitForBrowserWs, openTarget,
  Cdp, evaluate, waitFor, assert, removeTempDir, stopProcess, sleep,
} from './cdp-harness.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const MODE = process.argv.includes('--electron') ? 'electron' : process.argv.includes('--preview') ? 'preview' : 'dev';
const FILE = resolve(process.env.DRACO_FILE ?? join(ROOT, 'tests/fixtures/draco-torus.glb'));
const EXPECTED_TRIS = Number(process.env.DRACO_TRIS ?? 576);
const LOCAL = /^(?:https?:\/\/(?:127\.0\.0\.1|localhost)[:/]|file:|data:|blob:|devtools:|chrome)/;

const BOOTED = `document.readyState === 'complete' && document.querySelector('#boot-status') === null
  && !!window.BABYLON?.SceneLoader && !!document.querySelector('#renderCanvas')`;

// Drops the file on #viewport and resolves once the new meshes' triangle
// count holds still for a second, or with the import-error modal's text.
const DROP_AND_COUNT = (b64, name) => `(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const bin = atob(${JSON.stringify(b64)});
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const engine = BABYLON.Engine.Instances.find(e => e.getRenderingCanvas()?.id === 'renderCanvas');
  const scene = engine.scenes[0];
  const before = new Set(scene.meshes);
  const dt = new DataTransfer();
  dt.items.add(new File([bytes], ${JSON.stringify(name)}, { type: 'model/gltf-binary' }));
  const vp = document.querySelector('#viewport');
  const r = vp.getBoundingClientRect();
  const init = { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 };
  const t0 = performance.now();
  for (const type of ['dragenter', 'dragover', 'drop']) vp.dispatchEvent(new DragEvent(type, init));
  let last = -1, stableSince = 0;
  while (performance.now() - t0 < 90000) {
    const modal = document.querySelector('.import-error');
    if (modal) return { error: modal.textContent.replace(/\s+/g, ' ').trim() };
    const tris = scene.meshes.filter(m => !before.has(m)).reduce((n, m) => n + (m.getTotalIndices?.() ?? 0) / 3, 0);
    if (tris > 0 && tris === last) {
      if (performance.now() - stableSince > 1000) return { tris, ms: Math.round(stableSince - t0) };
    } else { last = tris; stableSince = performance.now(); }
    await sleep(100);
  }
  return { error: 'timed out: no import and no error modal' };
})()`;

async function blockNonLocal(cdp, blocked, requested) {
  const previous = cdp.onEvent;
  cdp.onEvent = (msg) => {
    previous?.(msg);
    if (msg.method === 'Network.requestWillBeSent') requested.push(msg.params.request.url);
    if (msg.method !== 'Fetch.requestPaused') return;
    const { requestId, request } = msg.params;
    if (LOCAL.test(request.url)) {
      cdp.send('Fetch.continueRequest', { requestId }).catch(() => {});
    } else {
      blocked.push(request.url);
      cdp.send('Fetch.failRequest', { requestId, errorReason: 'InternetDisconnected' }).catch(() => {});
    }
  };
  await cdp.send('Network.enable');
  await cdp.send('Network.setBlockedURLs', { urls: ['*cdn.babylonjs.com*'] });
  await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
}

async function startServer(processes) {
  const port = await freePort();
  const args = MODE === 'preview'
    ? ['preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort']
    : ['--host', '127.0.0.1', '--port', String(port), '--strictPort'];
  const vite = spawn(process.execPath, [join(ROOT, 'node_modules/vite/bin/vite.js'), ...args], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  processes.push(vite);
  const output = [];
  vite.stdout.on('data', c => output.push(String(c)));
  vite.stderr.on('data', c => output.push(String(c)));
  const url = `http://127.0.0.1:${port}/index.html`;
  await waitForHttp(url, 20000, output);
  return url;
}

async function startChrome(processes, tempDirs) {
  const browserPath = findBrowser();
  assert(browserPath, 'Chrome/Edge executable not found.');
  const debugPort = await freePort();
  const userDataDir = mkdtempSync(join(tmpdir(), 'mixomesh-draco-'));
  tempDirs.push(userDataDir);
  const browser = spawn(browserPath, [
    '--headless=new', '--no-sandbox', '--disable-dev-shm-usage',
    '--use-angle=swiftshader', '--use-gl=angle', '--enable-unsafe-swiftshader',
    '--window-size=1600,950', '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
    `--remote-debugging-port=${debugPort}`, `--user-data-dir=${userDataDir}`, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  processes.push(browser);
  const stderr = [];
  browser.stderr.on('data', c => stderr.push(String(c)));
  await waitForBrowserWs(debugPort, stderr);
  const target = await openTarget(debugPort, 'about:blank');
  return Cdp.connect(target.webSocketDebuggerUrl);
}

async function startElectron(processes, tempDirs) {
  assert(existsSync(join(ROOT, 'dist/index.html')), 'run `npm run build` first (no dist/index.html)');
  const isWin = process.platform === 'win32';
  const bin = join(ROOT, 'node_modules', '.bin', isWin ? 'electron.cmd' : 'electron');
  const debugPort = await freePort();
  const root = mkdtempSync(join(tmpdir(), 'mixomesh-draco-electron-'));
  tempDirs.push(root);
  const electron = spawn(bin, ['electron/main.cjs', `--remote-debugging-port=${debugPort}`], {
    cwd: ROOT, shell: isWin, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, MIXO_SMOKE: 'api', MIXO_SMOKE_USERDATA: join(root, 'userData'), ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
  });
  processes.push(electron);
  const output = [];
  electron.stdout.on('data', c => output.push(String(c)));
  electron.stderr.on('data', c => output.push(String(c)));
  electron.on('exit', code => { if (code) console.error(`electron exited ${code}:\n${output.join('').slice(-2000)}`); });
  let page = null;
  await waitFor(async () => {
    const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
    page = targets.find(t => t.type === 'page' && /index\.html/.test(t.url));
    return !!page;
  }, 30000, 'Electron page target');
  return Cdp.connect(page.webSocketDebuggerUrl);
}

async function main() {
  assert(existsSync(FILE), `${FILE} is missing (node tests/fixtures/make-draco-torus.mjs)`);
  if (MODE === 'preview') assert(existsSync(join(ROOT, 'dist/index.html')), 'run `npm run build` first (no dist/index.html)');
  const processes = [];
  const tempDirs = [];
  const blocked = [];
  const requested = [];
  try {
    let cdp;
    if (MODE === 'electron') {
      cdp = await startElectron(processes, tempDirs);
      await blockNonLocal(cdp, blocked, requested);
    } else {
      const url = await startServer(processes);
      cdp = await startChrome(processes, tempDirs);
      await blockNonLocal(cdp, blocked, requested);
      await cdp.send('Page.navigate', { url });
    }
    await waitFor(() => evaluate(cdp, BOOTED), 45000, 'app boot');
    const res = await evaluate(cdp, DROP_AND_COUNT(readFileSync(FILE).toString('base64'), basename(FILE)));
    await cdp.close();
    const decoder = requested.filter(u => /draco/i.test(u) && !/\.vite\/deps/.test(u));
    console.log(JSON.stringify({ mode: MODE, file: basename(FILE), ...res, decoder, blocked }, null, 1));
    assert(!res.error, `import failed: ${res.error}`);
    assert(res.tris === EXPECTED_TRIS, `imported ${res.tris} triangles, expected ${EXPECTED_TRIS}`);
    assert(decoder.some(u => /vendor\/draco\/draco_decoder_gltf\.wasm$/.test(u)), `decoder not loaded from vendor/draco: ${JSON.stringify(decoder)}`);
    assert(blocked.length === 0, `the app tried to reach the network: ${blocked.join(', ')}`);
    console.log(`PASS ${MODE}: ${basename(FILE)} imported offline, ${res.tris} triangles, decoder from vendor/draco`);
  } finally {
    for (const p of processes.reverse()) await stopProcess(p);
    await sleep(200);
    for (const dir of tempDirs) removeTempDir(dir);
  }
}

main().catch((err) => { console.error(`FAIL ${err?.message ?? err}`); process.exitCode = 1; });
