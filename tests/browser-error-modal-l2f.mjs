// L2-05: a WebKit save that failed its size check opened the import-error
// modal ("Import failed ... could not be imported") and hid the real reason
// in Technical details. A failed save, export or publish shows its own title
// and message; only imports get the import wording.
//   node tests/browser-error-modal-l2f.mjs
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
  const { t } = await import('/src/i18n/index.js');
  const msg = t('storage.saveFailedPreviousKept', { name: 'wk-quad', reason: 'only 0 of 3168 bytes reached the file' });
  reportError(new Error(msg, { cause: new Error('x') }), { title: t('toast.errorTitle'), modal: true });
  await new Promise(r => setTimeout(r, 300));
  const dlg = [...document.querySelectorAll('.modal-content')].at(-1);
  return JSON.stringify({ msg, heading: dlg?.querySelector('h3')?.textContent ?? null, text: dlg?.innerText.replace(/\\s+/g, ' ') ?? '' });
})()`;

async function main() {
  const browserPath = findBrowser();
  if (!browserPath || !existsSync(VITE_BIN)) throw new Error('browser or vite missing');
  const appPort = await freePort(); const debugPort = await freePort();
  const userDataDir = mkdtempSync(join(tmpdir(), 'mixomesh-l2f-modal-'));
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
    assert.doesNotMatch(out.text, /could not be imported|Import failed/i, `a save failure is not called an import failure: "${out.text}"`);
    const visible = out.text.split('Technical details')[0];
    assert.ok(visible.includes(out.msg), `the reason is shown, not hidden in Technical details: "${out.text}"`);
    console.log(`PASS browser-error-modal-l2f ("${out.heading}": ${out.msg})`);
    cdp.close?.();
  } finally { await stopProcess(browser); await stopProcess(vite); removeTempDir(userDataDir); }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
