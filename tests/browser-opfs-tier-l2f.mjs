// WebKit-tier UI (L2-11): Safari has no folder access, so the Asset panel must
// not offer a Folders tab or tell the user to "mount a directory". Chromium
// is made to boot the same OPFS tier WebKit gets: no File System Access
// pickers, a Safari user agent.
//   node tests/browser-opfs-tier-l2f.mjs
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
const SAFARI_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
const AS_WEBKIT = `for (const k of ['showOpenFilePicker', 'showSaveFilePicker', 'showDirectoryPicker']) { delete Window.prototype[k]; delete window[k]; }`;
const visibleText = re => `[...document.querySelectorAll('#asset-panel *')].filter(e => e.offsetParent && [...e.childNodes].some(n => n.nodeType === 3 && ${re}.test(n.textContent))).map(e => e.textContent.trim())`;

async function main() {
  const browserPath = findBrowser();
  if (!browserPath || !existsSync(VITE_BIN)) throw new Error('browser or vite missing');
  const appPort = await freePort(); const debugPort = await freePort();
  const userDataDir = mkdtempSync(join(tmpdir(), 'mixomesh-l2f-opfs-'));
  const vite = spawn(process.execPath, [VITE_BIN, '--host', '127.0.0.1', '--port', String(appPort), '--strictPort'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  const viteOutput = []; vite.stdout.on('data', c => viteOutput.push(String(c))); vite.stderr.on('data', c => viteOutput.push(String(c)));
  const browser = spawn(browserPath, ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--use-angle=swiftshader', '--use-gl=angle', '--enable-unsafe-swiftshader', '--window-size=1440,900', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${userDataDir}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const be = []; browser.stderr.on('data', c => be.push(String(c)));
  try {
    await waitForHttp(`http://127.0.0.1:${appPort}/index.html`, 20000, viteOutput);
    await waitForBrowserWs(debugPort, be);
    const target = await openTarget(debugPort, 'about:blank');
    const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
    await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setUserAgentOverride', { userAgent: SAFARI_UA });
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: AS_WEBKIT });
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${appPort}/index.html` });
    await waitFor(() => evaluate(cdp, BOOTED), 40000, 'boot');

    const tier = await evaluate(cdp, `(async () => (await import('/src/core/storage/StorageAdapter.js')).storage.kind)()`);
    assert.equal(tier, 'opfs', 'Chromium booted the WebKit storage tier');
    await evaluate(cdp, `document.querySelector('#asset-panel [data-tab="session"]')?.click()`);
    const folderTabs = await evaluate(cdp, `[...document.querySelectorAll('#asset-panel .ap-tab')].filter(e => e.offsetParent).map(e => e.dataset.tab)`);
    assert.deepEqual(folderTabs.filter(t => t === 'library'), [], 'no Folders tab on a tier that cannot open folders');
    const mountHints = await evaluate(cdp, visibleText('/mount/i'));
    assert.deepEqual(mountHints, [], 'no visible text tells the user to mount a folder');
    console.log(`PASS browser-opfs-tier-l2f (tier ${tier}; tabs ${JSON.stringify(folderTabs)})`);
    cdp.close?.();
  } finally { await stopProcess(browser); await stopProcess(vite); removeTempDir(userDataDir); }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
