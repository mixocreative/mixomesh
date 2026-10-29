// Single interface style smoke: the app boots in mixo-app-style (paper
// background, dense right panel), there is no style switch and no
// data-ui-style attribute, and a stale stored 'original' choice from an older
// build is ignored across a reload.
//   node tests/browser-ui-style-smoke.mjs

import { existsSync, mkdtempSync } from 'node:fs';
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
const PAPER = 'rgb(244, 242, 237)';

const BOOTED = `document.readyState === 'complete'
  && document.querySelector('#boot-status') === null
  && !!document.querySelector('#locale-switcher')`;

const SNAPSHOT = `JSON.stringify({
  attr: document.documentElement.dataset.uiStyle ?? null,
  bg: getComputedStyle(document.body).backgroundColor,
  switcher: !!document.querySelector('#ui-style-switcher, #ui-style-switcher-host'),
  right: Math.round(document.getElementById('right-panel').getBoundingClientRect().width),
})`;

async function snapshot(cdp) { return JSON.parse(await evaluate(cdp, SNAPSHOT)); }

async function main() {
  const browserPath = findBrowser();
  if (!browserPath) throw new Error('Chrome/Edge executable not found.');
  if (!existsSync(VITE_BIN)) throw new Error('Vite executable not found.');

  const appPort = await freePort();
  const debugPort = await freePort();
  const userDataDir = mkdtempSync(join(tmpdir(), 'mixomesh-ui-style-'));
  const vite = spawn(process.execPath, [VITE_BIN, '--host', '127.0.0.1', '--port', String(appPort), '--strictPort'],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  const viteOutput = [];
  vite.stdout.on('data', c => viteOutput.push(String(c)));
  vite.stderr.on('data', c => viteOutput.push(String(c)));
  const browser = spawn(browserPath, [
    '--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--use-angle=swiftshader', '--use-gl=angle',
    '--enable-unsafe-swiftshader', '--window-size=1600,950', '--hide-scrollbars', '--no-first-run',
    '--no-default-browser-check', '--disable-background-networking',
    `--remote-debugging-port=${debugPort}`, `--user-data-dir=${userDataDir}`, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  const browserStderr = [];
  browser.stderr.on('data', c => browserStderr.push(String(c)));

  try {
    await waitForHttp(`http://127.0.0.1:${appPort}/index.html`, 20000, viteOutput);
    await waitForBrowserWs(debugPort, browserStderr);
    const target = await openTarget(debugPort, `http://127.0.0.1:${appPort}/index.html`);
    const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
    const failures = [];
    cdp.onEvent = (msg) => {
      if (msg.method === 'Runtime.exceptionThrown') failures.push(msg.params.exceptionDetails?.exception?.description ?? 'exception');
    };
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 950, deviceScaleFactor: 1, mobile: false });
    await waitFor(() => evaluate(cdp, BOOTED), 30000, 'app boot');

    const fresh = await snapshot(cdp);
    assert(fresh.attr === null, `no data-ui-style attribute, got ${fresh.attr}`);
    assert(fresh.bg === PAPER, `body is paper, got ${fresh.bg}`);
    assert(!fresh.switcher, 'no interface-style switch');
    assert(fresh.right === 260, `dense right panel 260px, got ${fresh.right}`);

    // A stale choice written by an older build must not change anything.
    await evaluate(cdp, `localStorage.setItem('mx-ui-style-v1', JSON.stringify({ v: 1, style: 'original' }))`);
    await evaluate(cdp, 'window.__beforeReload = true');
    await cdp.send('Page.reload', {});
    await waitFor(() => evaluate(cdp, `!window.__beforeReload && ${BOOTED}`), 30000, 'reload boot');
    const reloaded = await snapshot(cdp);
    assert(reloaded.attr === null && reloaded.bg === PAPER && reloaded.right === 260,
      `stale 'original' ignored: ${JSON.stringify(reloaded)}`);

    assert(failures.length === 0, `page exceptions: ${failures.join(' | ')}`);
    console.log('PASS single UI style smoke');
    cdp.close?.();
  } finally {
    await stopProcess(browser);
    await stopProcess(vite);
    removeTempDir(userDataDir);
  }
}

main().catch(err => { console.error(err); process.exitCode = 1; });
