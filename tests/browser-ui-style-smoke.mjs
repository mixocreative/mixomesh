// Interface style switch smoke: a fresh profile boots New (paper background,
// dense right panel); choosing Original in the header switch applies it live,
// persists it, survives a reload, and restores Original's panel width;
// switching back returns New.
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
  && !!document.querySelector('#ui-style-switcher')`;

const SNAPSHOT = `JSON.stringify({
  attr: document.documentElement.dataset.uiStyle ?? null,
  stored: localStorage.getItem('mx-ui-style-v1'),
  bg: getComputedStyle(document.body).backgroundColor,
  select: document.querySelector('#ui-style-switcher')?.value,
  options: [...document.querySelectorAll('#ui-style-switcher option')].map(o => o.value),
  right: Math.round(document.getElementById('right-panel').getBoundingClientRect().width),
})`;

async function snapshot(cdp) { return JSON.parse(await evaluate(cdp, SNAPSHOT)); }

async function choose(cdp, style) {
  await evaluate(cdp, `(() => {
    const sel = document.querySelector('#ui-style-switcher');
    sel.value = ${JSON.stringify(style)};
    sel.dispatchEvent(new Event('change'));
  })()`);
}

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
    assert(fresh.attr === 'new', `fresh profile boots New, got ${fresh.attr}`);
    assert(fresh.stored === null, 'nothing stored before a choice');
    assert(fresh.bg === PAPER, `New body is paper, got ${fresh.bg}`);
    assert(fresh.select === 'new', 'switch shows New');
    assert(fresh.options.join() === 'new,original', `options ${fresh.options}`);
    assert(fresh.right === 260, `New layout right panel 260px, got ${fresh.right}`);

    await choose(cdp, 'original');
    const orig = await snapshot(cdp);
    assert(orig.attr === 'original', 'Original applied live');
    assert(JSON.parse(orig.stored).style === 'original', `stored ${orig.stored}`);
    assert(orig.bg !== PAPER, 'Original body is not paper');
    assert(orig.right === 300, `Original layout right panel 300px, got ${orig.right}`);

    // Mark the old document so the wait can't pass before the reload lands.
    await evaluate(cdp, 'window.__beforeReload = true');
    await cdp.send('Page.reload', {});
    await waitFor(() => evaluate(cdp, `!window.__beforeReload && ${BOOTED}`), 30000, 'reload boot');
    const reloaded = await snapshot(cdp);
    assert(reloaded.attr === 'original', 'Original survives reload');
    assert(reloaded.select === 'original', 'switch shows Original after reload');
    assert(reloaded.right === 300, `reloaded Original right panel 300px, got ${reloaded.right}`);

    await choose(cdp, 'new');
    const back = await snapshot(cdp);
    assert(back.attr === 'new' && back.bg === PAPER, 'switching back restores New');
    assert(back.right === 260, `back to New right panel 260px, got ${back.right}`);

    assert(failures.length === 0, `page exceptions: ${failures.join(' | ')}`);
    console.log('PASS UI style switch smoke');
    cdp.close?.();
  } finally {
    await stopProcess(browser);
    await stopProcess(vite);
    removeTempDir(userDataDir);
  }
}

main().catch(err => { console.error(err); process.exitCode = 1; });
