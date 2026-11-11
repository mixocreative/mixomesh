/*
 * THE BOOT GATE: a boot that cannot continue must be TOLD, never shown a half-painted app.
 *
 *   npm run test:boot-gate
 *
 * Ported from mixodental's `scripts/no-webgl-gate.mjs` (the three-repo plan §5.1 and §5.2,
 * audit MX-13). Two faults, one surface:
 *
 *   1. `engineGate` asked "which browser is this" and never "can this device draw", so a machine
 *      with WebGL blocked walked into `bootstrap()` and `new BABYLON.Engine` threw
 *      "WebGL not supported" into the catch below.
 *   2. That catch appended an overlay to #viewport and returned, leaving the header, outliner and
 *      right panel mounted, live and clickable, with autosave never started (MX-13).
 *
 * THREE PASSES, AND THE CONTROL IS NOT OPTIONAL. Without a pass where boot succeeds, a blocked
 * page proves the gate broke rather than that the app guards itself. So the control must reach a
 * real #renderCanvas with a real engine on it, and this gate FAILS when it does not: a green line
 * from a probe that never loaded the app is worth nothing.
 *
 * Both faults are injected from OUTSIDE the app — a patched `getContext` and a patched
 * `getElementById` — so nothing in src/ exists for the sake of this test.
 *
 * Needs Vite + a real Chrome, so it is not part of `npm test` (node, no browser). It runs beside
 * the other browser smokes in `test:all` and in the installer gate.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  findBrowser, freePort, waitForHttp, waitForBrowserWs, openTarget,
  Cdp, evaluate, waitFor, sleep, removeTempDir, stopProcess,
} from './cdp-harness.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const VITE_BIN = join(ROOT, 'node_modules/vite/bin/vite.js');

/** Runs before any app code: every WebGL context request answers null, as a device without it does. */
const BLOCK_WEBGL = `{
  const real = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (kind, ...rest) {
    if (/webgl/i.test(String(kind))) return null;
    return real.call(this, kind, ...rest);
  };
  delete window.WebGL2RenderingContext;
  delete window.WebGLRenderingContext;
}`;

/*
 * Makes ONE real `.init()` throw, from outside the app: #viewport goes missing, which
 * `bootstrap()` needs near its end (`if (!viewport) throw new Error('Viewport root missing')`) and
 * CursorPanel.init() mounts into just before that. Both sit AFTER the outliner, the shell and the
 * workspace have mounted and BEFORE PersistenceManager.startAutosave() — the exact window MX-13
 * describes, so this is the mid-boot throw and not a convenient early one.
 */
const BREAK_ONE_INIT = `{
  const real = document.getElementById.bind(document);
  document.getElementById = id => (id === 'viewport' ? null : real(id));
}`;

// No Vite HMR socket: another session editing src/ must not reload the page mid-check.
const NO_HMR = `{
  const Real = WebSocket;
  window.WebSocket = function (url, protocols) {
    if (String(protocols).includes('vite-hmr')) return { readyState: 0, addEventListener() {}, send() {}, close() {} };
    return new Real(url, protocols);
  };
}`;

const READ = `(() => {
  const blocked = document.querySelector('[data-ui="boot-blocked"]');
  return JSON.stringify({
    reason: blocked?.getAttribute('data-reason') ?? null,
    title: document.querySelector('[data-ui="boot-blocked-title"]')?.textContent?.trim() ?? '',
    sentence: document.querySelector('[data-ui="boot-blocked-message"]')?.textContent?.trim() ?? '',
    canvases: document.querySelectorAll('canvas').length,
    renderCanvas: !!document.getElementById('renderCanvas'),
    outliner: !!document.getElementById('outliner'),
    // "Not interactive" measured as nothing left to press, anywhere on the page.
    controls: document.querySelectorAll('button, input, select, textarea, a[href], [role="button"], [tabindex]').length,
    engine: window.__MX_ENGINE ?? null,
    text: document.body.innerText.replace(/\\s+/g, ' ').trim().slice(0, 300),
  });
})()`;

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` | ${detail}` : ''}`);
}

/** One page load, optionally with a fault injected before any app code runs. */
async function pass(debugPort, url, { fault = null } = {}) {
  const target = await openTarget(debugPort, 'about:blank');
  const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
  try {
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: NO_HMR });
    if (fault) await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: fault });
    await cdp.send('Page.navigate', { url });
    // Either outcome settles quickly; the control needs a cold Vite dep optimise plus engine init.
    await waitFor(() => evaluate(cdp, `document.readyState === 'complete'`), 90000, 'page load');
    await waitFor(
      () => evaluate(cdp, `!!document.querySelector('[data-ui="boot-blocked"]') || !!document.getElementById('renderCanvas')`),
      90000, fault ? 'blocking screen or shell' : 'app shell',
    );
    await sleep(3000);   // let SceneManager.init finish (control) / the throw land (faults)
    return JSON.parse(await evaluate(cdp, READ));
  } finally {
    await cdp.close();
  }
}

async function main() {
  const browserPath = findBrowser();
  if (!browserPath) throw new Error('Chrome/Edge executable not found.');
  const appPort = await freePort();
  const debugPort = await freePort();
  const userDataDir = mkdtempSync(join(tmpdir(), 'mixomesh-nogl-'));
  const vite = spawn(process.execPath, [VITE_BIN, '--host', '127.0.0.1', '--port', String(appPort), '--strictPort'],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  const viteOutput = [];
  vite.stdout.on('data', c => viteOutput.push(String(c)));
  vite.stderr.on('data', c => viteOutput.push(String(c)));
  const browser = spawn(browserPath, [
    '--headless=new', '--no-sandbox', '--disable-dev-shm-usage',
    '--use-angle=swiftshader', '--use-gl=angle', '--enable-unsafe-swiftshader',
    '--window-size=1600,950', '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
    `--remote-debugging-port=${debugPort}`, `--user-data-dir=${userDataDir}`, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  const browserStderr = [];
  browser.stderr.on('data', c => browserStderr.push(String(c)));

  const url = `http://127.0.0.1:${appPort}/index.html`;
  try {
    await waitForHttp(url, 20000, viteOutput);
    await waitForBrowserWs(debugPort, browserStderr);

    // THE CONTROL FIRST. If this fails, nothing below means anything.
    const control = await pass(debugPort, url);
    check('control: WebGL works, so the viewport mounts a real canvas', control.renderCanvas && control.canvases > 0,
      `renderCanvas ${control.renderCanvas}, canvases ${control.canvases}`);
    check('control: a render backend actually came up', control.engine === 'webgl' || control.engine === 'webgpu',
      `__MX_ENGINE ${control.engine ?? 'none'}`);
    check('control: the blocking screen never appears', control.reason === null, `reason ${control.reason ?? 'none'}`);
    // The app the other two passes must NOT leave behind: it has controls to press.
    check('control: a booted app has controls', control.controls > 0, `controls ${control.controls}`);

    const blocked = await pass(debugPort, url, { fault: BLOCK_WEBGL });
    check('no WebGL: the blocking screen says WHY', blocked.reason === 'no-webgl', `reason ${blocked.reason ?? 'none'}`);
    check('no WebGL: a heading', blocked.title.length > 0, blocked.title);
    // A sentence, not a word: this line has to explain the situation to its reader.
    check('no WebGL: a sentence that explains it', blocked.sentence.split(/\s+/).length > 4, blocked.sentence);
    check('no WebGL: there are words on the page', blocked.text.length > 20, `${blocked.text.length} chars`);
    // The invariant: no route reaches bootstrap() without a drawing context.
    check('no WebGL: the shell is not left behind it', !blocked.renderCanvas && !blocked.outliner,
      `renderCanvas ${blocked.renderCanvas}, outliner ${blocked.outliner}`);
    check('no WebGL: it never silently tries to draw', blocked.canvases === 0, `canvases ${blocked.canvases}`);

    // MX-13: a throw mid-bootstrap, after the panels mounted and before autosave starts.
    const broken = await pass(debugPort, url, { fault: BREAK_ONE_INIT });
    check('boot throw: the same blocking screen, not a viewport overlay', broken.reason === 'bootstrap',
      `reason ${broken.reason ?? 'none'}`);
    check('boot throw: a heading and a sentence', broken.title.length > 0 && broken.sentence.split(/\s+/).length > 4,
      `${broken.title} | ${broken.sentence}`);
    // THE INVARIANT: a boot failure leaves nothing interactive behind it.
    check('boot throw: the outliner is gone, not live behind an overlay', !broken.outliner, `outliner ${broken.outliner}`);
    check('boot throw: nothing is left to press', broken.controls === 0, `controls ${broken.controls}`);
  } finally {
    await stopProcess(browser);
    await stopProcess(vite);
    removeTempDir(userDataDir);
  }

  const failed = results.filter(r => !r.ok);
  console.log(`\nboot gate: ${results.length - failed.length}/${results.length} PASS`);
  if (failed.length) {
    console.error(`FAILED: ${failed.map(r => r.name).join('; ')}`);
    process.exitCode = 1;
  }
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
