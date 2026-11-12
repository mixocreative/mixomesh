// The live support workers (analysis worker: placement + check; mesh worker: build) in every shape
// the app ships in (plan 2026-10-29 P3.5 gap a / P3.6): the vite dev server, the production build
// over http (the GitHub Pages shape) and the built app in Electron over file://. Each loads the
// cube-overhang fixture, enters Support Mode with Shift+S, presses the panel's Generate button and
// waits for the real job (placement -> rekey -> build -> check) to land, then asserts that placement
// produced the golden's point count, that every point became a tip or a recorded drop, that the
// verdict is clear, and that there were no console errors and no CSP violations. Nothing is imported from the page: only
// window.__mxSupportLive (installed in every build) is read.
//
//   node tests/browser-support-worker-shapes-smoke.mjs              dev server + headless Chrome
//   node tests/browser-support-worker-shapes-smoke.mjs --preview    production build (npm run build first)
//   node tests/browser-support-worker-shapes-smoke.mjs --electron   built app in the Electron shell

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
let finished = false;

const BOOTED = `document.readyState === 'complete' && document.querySelector('#boot-status') === null
  && !!window.BABYLON?.SceneLoader && !!document.querySelector('#renderCanvas') && !!window.__mxSupportLive`;

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

const IMPORTED = `(() => {
  const modal = document.querySelector('.import-error');
  if (modal) return 'ERR:' + modal.textContent.replace(/\\s+/g, ' ').trim();
  const engine = BABYLON.Engine.Instances.find(e => e.getRenderingCanvas()?.id === 'renderCanvas');
  return engine.scenes[0].meshes.some(m => m.metadata?.meshId && m.getTotalIndices?.() > 0);
})()`;

// Electron intermittently logs its own sandboxed-renderer bootstrap failure to the attached debugger.
const ELECTRON_ATTACH_RACE = /sandboxed_renderer.bundle.js script failed to run|binding.startupData/;

function watchProblems(cdp, problems) {
  cdp.onEvent = (msg) => {
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
  const userDataDir = mkdtempSync(join(tmpdir(), 'mixomesh-shapes-'));
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
  const root = mkdtempSync(join(tmpdir(), 'mixomesh-shapes-electron-'));
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

async function key(cdp, k, { shift = false } = {}) {
  const base = { key: k, code: `Key${k.toUpperCase()}`, modifiers: shift ? 8 : 0, windowsVirtualKeyCode: k.toUpperCase().charCodeAt(0) };
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
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
    await waitFor(() => evaluate(cdp, BOOTED), 60000, 'app boot');
    await evaluate(cdp, DROP(readFileSync(FILE).toString('base64'), basename(FILE)));
    let state;
    await waitFor(async () => { state = await evaluate(cdp, IMPORTED); return state; }, 30000, 'fixture import');
    assert(!String(state).startsWith('ERR:'), `import failed: ${state}`);
    await sleep(1200);
    // Support Mode through its key, the job through the panel's own button.
    await key(cdp, 's', { shift: true });
    await waitFor(() => evaluate(cdp, `document.querySelector('#app')?.dataset.mode === 'supports'`), 15000, 'Support Mode open (Shift+S)');
    await waitFor(() => evaluate(cdp, `!![...document.querySelectorAll('.sp-generate button')].find(b => !b.disabled)`), 20000, 'Generate button enabled');
    await evaluate(cdp, `[...document.querySelectorAll('.sp-generate button')].find(b => !b.disabled).click(); true`);
    await waitFor(() => evaluate(cdp, `window.__mxSupportLive.stats.rendered >= 1 && !!window.__mxSupportLive.stats.last && !window.__mxSupportLive.busy(window.__mxSupportLive.stats.last.objectId)`), 90000, 'placement + build + check');
    const stats = await evaluate(cdp, `JSON.parse(JSON.stringify(window.__mxSupportLive.stats))`);
    const inert = await evaluate(cdp, `typeof window.__mxSupportLive.test === 'object' && window.__mxSupportLive.test.slowMs === 0`);
    await sleep(300);
    await cdp.close();
    console.log(JSON.stringify({ mode: MODE, stats, problems }, null, 1));
    assert(stats.placements >= 1, 'the analysis worker did not place');
    // CONSERVATION, not an absolute tip count (Fable's decision, 2026-11-12; HANDOFF.md).
    // This smoke drives the PANEL, which runs preset MIDDLE with repairBudget 3, while
    // browser-support-engine-smoke drives the probe, which runs LIGHT with no budget. Measured
    // in-process at every engine: MIDDLE places 70 and the safety repair drops the two contacts at
    // the overhang edge, so 68 tips is the repair DOING ITS JOB. Asserting 68 would take the number
    // from the writer and break at the next re-vendor with nobody able to tell a regression from a
    // change; asserting 70 tips was only ever true because engine 10's repair budget did nothing.
    // So: the one absolute number is geocore's own `placement.points`, and the rest is arithmetic.
    assert(stats.last.points === GOLDEN.placementPoints, `${stats.last.points} placed, golden ${GOLDEN.placementPoints}`);
    assert(stats.last.tips + stats.last.dropped === stats.last.points,
      `${stats.last.tips} tips + ${stats.last.dropped} dropped != ${stats.last.points} placed`);
    // Only reachable if the repair ran inside the worker: without it MIDDLE returns `blocked`.
    assert(stats.last.verdict === 'clear', `verdict ${stats.last.verdict}, expected clear`);
    assert(stats.last.ms.build > 0 && stats.last.ms.placement > 0, 'placement and build both ran in a worker');
    assert(stats.last.verdict !== 'none', 'no verdict');
    assert(inert, 'the slow-job test hook is not inert');
    assert(problems.length === 0, `console/CSP problems: ${problems.join(' | ')}`);
    console.log(`PASS ${MODE}: placement ${stats.last.ms.placement} ms, build ${stats.last.ms.build} ms, check ${stats.last.ms.check} ms, ${stats.last.points} placed = ${stats.last.tips} tips + ${stats.last.dropped} dropped, verdict ${stats.last.verdict}, no console errors or CSP violations`);
  } finally {
    finished = true;
    for (const p of processes.reverse()) await stopProcess(p);
    await sleep(200);
    for (const dir of tempDirs) removeTempDir(dir);
  }
}

main().catch((err) => { console.error(`FAIL ${err?.message ?? err}`); process.exitCode = 1; });
