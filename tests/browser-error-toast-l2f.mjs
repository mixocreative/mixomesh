// L2-13: a failed open ("Not a .mixo file or the file is corrupt") left an
// error toast that stayed over the workspace for minutes with no way to
// close it. An error toast can be dismissed.
//   node tests/browser-error-toast-l2f.mjs
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
const REPORT = `(async () => {
  const { reportError } = await import('/src/ui/Status.js');
  reportError(new Error('Not a .mixo file or the file is corrupt'), { title: 'Error' });
  const toast = [...document.querySelectorAll('#toast-container .toast.error')].at(-1);
  const close = toast?.querySelector('[data-action="dismiss"]');
  if (!close) return JSON.stringify({ toast: !!toast, close: false });
  close.click();
  await new Promise(r => setTimeout(r, 1000));
  return JSON.stringify({ toast: true, close: true, label: close.getAttribute('aria-label'), gone: !toast.isConnected || toast.classList.contains('toast-out') });
})()`;

async function main() {
  const browserPath = findBrowser();
  if (!browserPath || !existsSync(VITE_BIN)) throw new Error('browser or vite missing');
  const appPort = await freePort(); const debugPort = await freePort();
  const userDataDir = mkdtempSync(join(tmpdir(), 'mixomesh-l2f-toast-'));
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

    const out = JSON.parse(await evaluate(cdp, REPORT));
    assert.ok(out.toast, 'the error toast is shown');
    assert.ok(out.close, 'the error toast has a close button');
    assert.ok(out.label, 'the close button is labelled');
    assert.ok(out.gone, 'clicking it removes the toast');
    console.log(`PASS browser-error-toast-l2f (close "${out.label}" dismisses the error toast)`);
    cdp.close?.();
  } finally { await stopProcess(browser); await stopProcess(vite); removeTempDir(userDataDir); }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
