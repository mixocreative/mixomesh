// Support engine + mesh worker loading and generation in all three shapes the app ships in
// (plan 2026-10-29 P2.2): the vite dev server, the production build served over http with
// base './' (the GitHub Pages shape) and the built app in Electron over file://. Each mode loads
// the cube-overhang fixture by dropping it on the viewport, runs the generation path through
// window.__mxSupportEngineProbe (a lazy hook present in the production build, see src/app/main.ts),
// and asserts engine_version 10, 70 tips (62 before P5.14), no console errors / exceptions and no CSP violations.
//
//   node tests/browser-support-engine-smoke.mjs              vite dev server + headless Chrome
//   node tests/browser-support-engine-smoke.mjs --preview    production build (npm run build first)
//   node tests/browser-support-engine-smoke.mjs --electron   built app in the Electron shell

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
const FILE = join(ROOT, 'tests/fixtures/support-cube-overhang.glb');
const GOLDEN = JSON.parse(readFileSync(join(ROOT, 'tests/fixtures/support-golden-cube-overhang.json'), 'utf8'));
const EXPECTED_ENGINE = 10;
let finished = false;

const BOOTED = `document.readyState === 'complete' && document.querySelector('#boot-status') === null
  && !!window.BABYLON?.SceneLoader && !!document.querySelector('#renderCanvas')
  && typeof window.__mxSupportEngineProbe === 'function'`;

const DROP = (b64, name) => `(async () => {
  const bin = atob(${JSON.stringify(b64)});
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const dt = new DataTransfer();
  dt.items.add(new File([bytes], ${JSON.stringify(name)}, { type: 'model/gltf-binary' }));
  const vp = document.querySelector('#viewport');
  const r = vp.getBoundingClientRect();
  const init = { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 };
  for (const type of ['dragenter', 'dragover', 'drop']) vp.dispatchEvent(new DragEvent(type, init));
})()`;

// Resolves once an imported mesh exists and the scene has settled, or with the import-error text.
const IMPORTED = `(() => {
  const modal = document.querySelector('.import-error');
  if (modal) return 'ERR:' + modal.textContent.replace(/\\s+/g, ' ').trim();
  const engine = BABYLON.Engine.Instances.find(e => e.getRenderingCanvas()?.id === 'renderCanvas');
  return engine.scenes[0].meshes.some(m => m.metadata?.meshId && m.getTotalIndices?.() > 0);
})()`;

/** Collects console errors, uncaught exceptions, log-domain errors and CSP violations. */
// Electron intermittently (about 1 run in 6) logs its own sandboxed-renderer bootstrap failure to the
// attached debugger while the page target is still being created; the preload bridge is asserted
// separately (window.electronAPI) so a real preload failure is still caught.
const ELECTRON_ATTACH_RACE = /sandboxed_renderer.bundle.js script failed to run|binding.startupData/;

function watchProblems(cdp, problems) {
  const previous = cdp.onEvent;
  cdp.onEvent = (msg) => {
    previous?.(msg);
    const p = msg.params;
    if (MODE === 'electron' && ELECTRON_ATTACH_RACE.test(JSON.stringify(p ?? {}))) return;
    if (msg.method === 'Runtime.exceptionThrown') problems.push(`exception: ${p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text}`);
    else if (msg.method === 'Runtime.consoleAPICalled' && p.type === 'error') problems.push(`console.error: ${p.args.map(a => a.value ?? a.description).join(' ')}`);
    else if (msg.method === 'Log.entryAdded' && p.entry.level === 'error') problems.push(`log: ${p.entry.text} ${p.entry.url ?? ''}`);
    else if (/Content Security Policy|Refused to/i.test(JSON.stringify(p ?? {}))) problems.push(`csp: ${JSON.stringify(p).slice(0, 300)}`);
  };
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
  const userDataDir = mkdtempSync(join(tmpdir(), 'mixomesh-supports-'));
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
  const root = mkdtempSync(join(tmpdir(), 'mixomesh-supports-electron-'));
  tempDirs.push(root);
  const electron = spawn(bin, ['electron/main.cjs', `--remote-debugging-port=${debugPort}`], {
    cwd: ROOT, shell: isWin, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, MIXO_SMOKE: 'api', MIXO_SMOKE_USERDATA: join(root, 'userData'), ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
  });
  processes.push(electron);
  const output = [];
  electron.stdout.on('data', c => output.push(String(c)));
  electron.stderr.on('data', c => output.push(String(c)));
  electron.on('exit', code => { if (code && !finished) console.error(`electron exited ${code}:\n${output.join('').slice(-2000)}`); });
  let page = null;
  await waitFor(async () => {
    const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
    page = targets.find(t => t.type === 'page' && /index\.html/.test(t.url));
    return !!page;
  }, 30000, 'Electron page target');
  return Cdp.connect(page.webSocketDebuggerUrl);
}

async function main() {
  assert(existsSync(FILE), `${FILE} is missing`);
  if (MODE !== 'dev') assert(existsSync(join(ROOT, 'dist/index.html')), 'run `npm run build` first (no dist/index.html)');
  const processes = [];
  const tempDirs = [];
  const problems = [];
  try {
    let cdp;
    if (MODE === 'electron') {
      cdp = await startElectron(processes, tempDirs);
      watchProblems(cdp, problems);
      await cdp.send('Runtime.enable');
      await cdp.send('Log.enable');
    } else {
      const url = await startServer(processes);
      cdp = await startChrome(processes, tempDirs);
      watchProblems(cdp, problems);
      await cdp.send('Runtime.enable');
      await cdp.send('Log.enable');
      await cdp.send('Page.navigate', { url });
    }
    await waitFor(() => evaluate(cdp, BOOTED), 45000, 'app boot');
    await evaluate(cdp, DROP(readFileSync(FILE).toString('base64'), basename(FILE)));
    let state;
    await waitFor(async () => { state = await evaluate(cdp, IMPORTED); return state; }, 30000, 'fixture import');
    assert(!String(state).startsWith('ERR:'), `import failed: ${state}`);
    if (MODE === 'electron') assert(await evaluate(cdp, `typeof window.electronAPI === 'object'`), 'preload bridge (window.electronAPI) missing');
    await sleep(800);
    const res = await evaluate(cdp, `window.__mxSupportEngineProbe().then(r => r, e => ({ error: String(e?.stack ?? e) }))`);
    await sleep(300);
    await cdp.close();
    console.log(JSON.stringify({ mode: MODE, ...res, problems }, null, 1));
    assert(!res.error, `generation failed: ${res.error}`);
    assert(res.engineVersion === EXPECTED_ENGINE, `engine_version ${res.engineVersion}, expected ${EXPECTED_ENGINE}`);
    assert(res.tips === GOLDEN.tips, `${res.tips} tips, expected ${GOLDEN.tips}`);
    assert(res.supportTriangles > 0, 'no support triangles');
    assert(problems.length === 0, `console/CSP problems: ${problems.join(' | ')}`);
    console.log(`PASS ${MODE}: engine_version ${res.engineVersion}, ${res.tips} tips, ${res.supportTriangles} support triangles, no console errors or CSP violations`);
  } finally {
    finished = true;
    for (const p of processes.reverse()) await stopProcess(p);
    await sleep(200);
    for (const dir of tempDirs) removeTempDir(dir);
  }
}

main().catch((err) => { console.error(`FAIL ${err?.message ?? err}`); process.exitCode = 1; });
