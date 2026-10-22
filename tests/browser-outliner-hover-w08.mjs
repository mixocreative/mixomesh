// cia W-08: hovering an Outliner row must not move its Repair pill. The row's
// eye / lock toggles are hover-revealed; if revealing them reflows the row, a
// click aimed at the pill's resting centre lands on Hide or Lock instead.
//   node tests/browser-outliner-hover-w08.mjs
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  findBrowser, freePort, waitForHttp, waitForBrowserWs, openTarget,
  Cdp, evaluate, waitFor, removeTempDir, stopProcess, sleep,
} from './cdp-harness.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const VITE_BIN = join(ROOT, 'node_modules/vite/bin/vite.js');
const BOOTED = `document.readyState === 'complete' && document.querySelector('#boot-status') === null && !!document.querySelector('#ol-list')`;
const PILL = `#ol-list .ol-row [data-action="repair"]`;

const IMPORT_OPEN_TRIANGLE = `(async () => {
  const { AssetLoader } = await import('/src/core/AssetLoader.js');
  const obj = 'o OpenTri\\nv 0 0 0\\nv 0.02 0 0\\nv 0 0.02 0\\nf 1 2 3\\n';
  const ids = await AssetLoader.loadFromBlob(new Blob([obj]), 'opentri.obj');
  return ids.length;
})()`;

const PROBE = `(() => {
  const pill = document.querySelector('${PILL}');
  const b = pill.getBoundingClientRect();
  const x = b.left + b.width / 2, y = b.top + b.height / 2;
  const hit = document.elementFromPoint(x, y)?.closest('[data-action]')?.dataset.action ?? null;
  return JSON.stringify({ left: Math.round(b.left), right: Math.round(b.right), x: Math.round(x), y: Math.round(y), hit });
})()`;

async function main() {
  const browserPath = findBrowser();
  if (!browserPath || !existsSync(VITE_BIN)) throw new Error('browser or vite missing');
  const appPort = await freePort(); const debugPort = await freePort();
  const userDataDir = mkdtempSync(join(tmpdir(), 'mixomesh-w08-'));
  const vite = spawn(process.execPath, [VITE_BIN, '--host', '127.0.0.1', '--port', String(appPort), '--strictPort'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  const viteOutput = []; vite.stdout.on('data', c => viteOutput.push(String(c))); vite.stderr.on('data', c => viteOutput.push(String(c)));
  const browser = spawn(browserPath, ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--use-angle=swiftshader', '--use-gl=angle', '--enable-unsafe-swiftshader', '--window-size=1600,950', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${userDataDir}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const be = []; browser.stderr.on('data', c => be.push(String(c)));
  try {
    await waitForHttp(`http://127.0.0.1:${appPort}/index.html`, 20000, viteOutput);
    await waitForBrowserWs(debugPort, be);
    const target = await openTarget(debugPort, `http://127.0.0.1:${appPort}/index.html`);
    const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
    await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
    await waitFor(() => evaluate(cdp, BOOTED), 40000, 'boot');

    assert.equal(await evaluate(cdp, IMPORT_OPEN_TRIANGLE), 1, 'open triangle imported');
    await waitFor(() => evaluate(cdp, `!!document.querySelector('${PILL}')`), 30000, 'Repair pill on the open mesh');

    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 500 });
    await sleep(300);
    const cold = JSON.parse(await evaluate(cdp, PROBE));
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cold.x, y: cold.y });
    await sleep(300);
    const hovered = JSON.parse(await evaluate(cdp, PROBE));
    const hoverReveal = await evaluate(cdp, `getComputedStyle(document.querySelector('${PILL}').closest('.ol-row').querySelector('.ol-vis')).visibility`);

    assert.equal(hoverReveal, 'visible', 'hovering the row reveals its eye toggle');
    assert.deepEqual([hovered.left, hovered.right], [cold.left, cold.right], `the Repair pill stays put on hover (cold ${cold.left}-${cold.right}, hovered ${hovered.left}-${hovered.right})`);
    assert.equal(hovered.hit, 'repair', `a click at the pill's resting centre hits Repair, not ${hovered.hit}`);
    console.log(`PASS browser-outliner-hover-w08 (pill ${cold.left}-${cold.right} cold and hovered, centre hits ${hovered.hit})`);
    cdp.close?.();
  } finally { await stopProcess(browser); await stopProcess(vite); removeTempDir(userDataDir); }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
