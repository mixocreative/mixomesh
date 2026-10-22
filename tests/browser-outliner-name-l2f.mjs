// L2-07: an Outliner row with Repair and Parts pills squeezed the object's
// name to nothing. The name keeps a readable width (ellipsis beyond it) and
// its full text is in the tooltip.
//   node tests/browser-outliner-name-l2f.mjs
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  findBrowser, freePort, waitForHttp, waitForBrowserWs, openTarget,
  Cdp, evaluate, waitFor, removeTempDir, stopProcess,
} from './cdp-harness.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const VITE_BIN = join(ROOT, 'node_modules/vite/bin/vite.js');
const BOOTED = `document.readyState === 'complete' && document.querySelector('#boot-status') === null && !!document.querySelector('#ol-list')`;
const NAME = 'sashimi-platter-scan-final';

// Two materials → Parts pill; a cached fixable result → Repair pill.
const IMPORT = `(async () => {
  const { AssetLoader } = await import('/src/core/AssetLoader.js');
  const { getState, setState, dispatch } = await import('/src/core/StateManager.js');
  const { EVENTS } = await import('/src/core/events.js');
  const obj = 'o ${NAME}\\nv 0 0 0\\nv 0.02 0 0\\nv 0 0.02 0\\nv 0.02 0.02 0\\n'
    + 'usemtl a\\nf 1 2 3\\nusemtl b\\nf 2 4 3\\n';
  const ids = await AssetLoader.loadFromBlob(new Blob([obj]), '${NAME}.obj');
  const lead = Object.values(getState().scene.objects).find(o => !o.isInternalPart).id;
  const results = [{ type: 'holes', severity: 'warning', autoFixAvailable: true, fixed: false, message: '2 open edges' }];
  setState(st => ({ ...st, scene: { ...st.scene, validation: { ...st.scene.validation, [lead]: { results, stale: false, validatedAt: Date.now() } } } }), { silent: true });
  dispatch(EVENTS.VALIDATION_COMPLETE, { meshId: lead });
  return ids.length;
})()`;

const PROBE = `(() => {
  const row = [...document.querySelectorAll('#ol-list .ol-row')].find(r => r.querySelector('[data-action="parts"]'));
  if (!row) return null;
  const name = row.querySelector('.ol-name');
  return JSON.stringify({
    nameWidth: Math.round(name.getBoundingClientRect().width),
    title: name.getAttribute('title'),
    pills: [...row.querySelectorAll('.ol-pill')].map(p => p.dataset.action ?? p.className),
    rowWidth: Math.round(row.getBoundingClientRect().width),
  });
})()`;

async function main() {
  const browserPath = findBrowser();
  if (!browserPath || !existsSync(VITE_BIN)) throw new Error('browser or vite missing');
  const appPort = await freePort(); const debugPort = await freePort();
  const userDataDir = mkdtempSync(join(tmpdir(), 'mixomesh-l2f-ol-'));
  const vite = spawn(process.execPath, [VITE_BIN, '--host', '127.0.0.1', '--port', String(appPort), '--strictPort'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  const viteOutput = []; vite.stdout.on('data', c => viteOutput.push(String(c))); vite.stderr.on('data', c => viteOutput.push(String(c)));
  const browser = spawn(browserPath, ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--use-angle=swiftshader', '--use-gl=angle', '--enable-unsafe-swiftshader', '--window-size=1440,900', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${userDataDir}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const be = []; browser.stderr.on('data', c => be.push(String(c)));
  try {
    await waitForHttp(`http://127.0.0.1:${appPort}/index.html`, 20000, viteOutput);
    await waitForBrowserWs(debugPort, be);
    const target = await openTarget(debugPort, `http://127.0.0.1:${appPort}/index.html`);
    const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
    await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
    await waitFor(() => evaluate(cdp, BOOTED), 40000, 'boot');

    assert.ok(await evaluate(cdp, IMPORT) >= 1, 'two-material open mesh imported');
    await waitFor(() => evaluate(cdp, `!!document.querySelector('#ol-list [data-action="repair"]') && !!document.querySelector('#ol-list [data-action="parts"]')`), 30000, 'Repair and Parts pills');
    const row = JSON.parse(await evaluate(cdp, PROBE));
    assert.ok(row.nameWidth >= 48, `the name keeps a readable width beside the pills (${row.nameWidth}px of a ${row.rowWidth}px row)`);
    assert.equal(row.title, NAME, 'the full name is in the tooltip');
    console.log(`PASS browser-outliner-name-l2f (name ${row.nameWidth}px of ${row.rowWidth}px, title "${row.title}")`);
    cdp.close?.();
  } finally { await stopProcess(browser); await stopProcess(vite); removeTempDir(userDataDir); }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
