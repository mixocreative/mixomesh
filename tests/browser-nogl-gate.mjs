/*
 * THE NO-WebGL GATE: a device that cannot draw must be TOLD, never shown a half-painted app.
 *
 *   npm run test:nogl
 *
 * Ported from mixodental's `scripts/no-webgl-gate.mjs` (audit MX-13 / the three-repo plan §5.1).
 * `engineGate` asks "which browser is this"; it never asked "can this device draw", so a machine
 * with WebGL blocked walked straight into `bootstrap()` and `new BABYLON.Engine` threw
 * "WebGL not supported" into a catch that paints an overlay on the viewport — a device limit
 * reported as a crash, with the header and panels still live behind it.
 *
 * TWO PASSES, AND THE CONTROL IS NOT OPTIONAL. Without a pass where WebGL works, a blocked page
 * proves the gate broke rather than that the app guards itself. So the control must reach a real
 * #renderCanvas with a real engine on it, and this gate FAILS when it does not: a green line from
 * a probe that never loaded the app is worth nothing.
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
    engine: window.__MX_ENGINE ?? null,
    text: document.body.innerText.replace(/\\s+/g, ' ').trim().slice(0, 300),
  });
})()`;

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` | ${detail}` : ''}`);
}

/** One page load with WebGL either working or absent; returns what is on screen afterwards. */
async function pass(debugPort, url, { nogl }) {
  const target = await openTarget(debugPort, 'about:blank');
  const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
  try {
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: NO_HMR });
    if (nogl) await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: BLOCK_WEBGL });
    await cdp.send('Page.navigate', { url });
    // Either outcome settles quickly; the control needs a cold Vite dep optimise plus engine init.
    await waitFor(() => evaluate(cdp, `document.readyState === 'complete'`), 90000, 'page load');
    await waitFor(
      () => evaluate(cdp, `!!document.querySelector('[data-ui="boot-blocked"]') || !!document.getElementById('renderCanvas')`),
      90000, nogl ? 'blocking screen or shell' : 'app shell',
    );
    await sleep(3000);   // let SceneManager.init finish (control) / nothing more happen (nogl)
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
    const control = await pass(debugPort, url, { nogl: false });
    check('control: WebGL works, so the viewport mounts a real canvas', control.renderCanvas && control.canvases > 0,
      `renderCanvas ${control.renderCanvas}, canvases ${control.canvases}`);
    check('control: a render backend actually came up', control.engine === 'webgl' || control.engine === 'webgpu',
      `__MX_ENGINE ${control.engine ?? 'none'}`);
    check('control: the blocking screen never appears', control.reason === null, `reason ${control.reason ?? 'none'}`);

    const blocked = await pass(debugPort, url, { nogl: true });
    check('no WebGL: the blocking screen says WHY', blocked.reason === 'no-webgl', `reason ${blocked.reason ?? 'none'}`);
    check('no WebGL: a heading', blocked.title.length > 0, blocked.title);
    // A sentence, not a word: this line has to explain the situation to its reader.
    check('no WebGL: a sentence that explains it', blocked.sentence.split(/\s+/).length > 4, blocked.sentence);
    check('no WebGL: there are words on the page', blocked.text.length > 20, `${blocked.text.length} chars`);
    // The invariant: no route reaches bootstrap() without a drawing context.
    check('no WebGL: the shell is not left behind it', !blocked.renderCanvas && !blocked.outliner,
      `renderCanvas ${blocked.renderCanvas}, outliner ${blocked.outliner}`);
    check('no WebGL: it never silently tries to draw', blocked.canvases === 0, `canvases ${blocked.canvases}`);
  } finally {
    await stopProcess(browser);
    await stopProcess(vite);
    removeTempDir(userDataDir);
  }

  const failed = results.filter(r => !r.ok);
  console.log(`\nno-webgl gate: ${results.length - failed.length}/${results.length} PASS`);
  if (failed.length) {
    console.error(`FAILED: ${failed.map(r => r.name).join('; ')}`);
    process.exitCode = 1;
  }
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
