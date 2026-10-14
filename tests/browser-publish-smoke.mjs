// Desktop-style Publish tab smoke (PB.9). The normal browser smoke runs with
// caps.publish false and only proves the tab is ABSENT there. This one boots the
// same plain-browser build, then flips caps.publish on and installs a FAKE
// window.electronAPI.listbridge (no network, no Electron), and drives the tab
// through its three states: not connected -> ready -> publishing / failed /
// retry / done. Set SHOTS=<dir> to also save screenshots of each state.
//   node tests/browser-publish-smoke.mjs

import { existsSync, mkdtempSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  findBrowser, freePort, waitForHttp, waitForBrowserWs, openTarget,
  Cdp, evaluate, waitFor, assert, sleep, removeTempDir, stopProcess,
} from './cdp-harness.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const VITE_BIN = join(ROOT, 'node_modules/vite/bin/vite.js');
const SHOTS = process.env.SHOTS ? resolve(process.env.SHOTS) : null;
const PENDING_FILES = ['publish-tab.json', 'publish-pb14.json'].map(f => join(ROOT, '.tmp/locale-pending', f));
const SECRET = 'sk_test_SUPER_SECRET_KEY_12345';

// The fake runner. Mirrors electron/listbridge/index.cjs channel shapes.
const FAKE = `(() => {
  const creds = new Set();
  const listeners = new Set();
  const w = window;
  w.__lb = { calls: [], failFirst: true, delay: 250, setCredentialsArgs: [], hold: true, holdRelease: false, holdRemaining: 600000, extendCalls: [] };
  const emit = e => listeners.forEach(cb => cb(e));
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const STEPS = ['validate', 'bundle', 'host', 'create', 'confirm', 'cleanup'];
  async function run(from, update) {
    for (let i = from; i < STEPS.length; i++) {
      const step = STEPS[i] === 'create' && update ? 'update' : STEPS[i];
      emit({ jobId: 'job1', step, status: 'running', message: step + '...' });
      await sleep(w.__lb.delay);
      // Temporary-link hold (PB.12/PB.14): structured progress until the test releases it.
      if (STEPS[i] === 'confirm' && w.__lb.hold) {
        while (!w.__lb.holdRelease && !w.__lb.cancel) {
          emit({ jobId: 'job1', step, status: 'running', message: 'Keep MIXOMESH open', hold: true, served: 1, total: 3, holdRemainingMs: w.__lb.holdRemaining });
          await sleep(300);
        }
      }
      if (STEPS[i] === 'create' && w.__lb.failFirst) {
        w.__lb.failFirst = false;
        emit({ jobId: 'job1', step, status: 'failed', message: 'category is required' });
        return { ok: false, jobId: 'job1', status: 'failed', failedStep: step, error: 'Cults3D answered: category is required' };
      }
      if (w.__lb.cancel) { return { ok: false, jobId: 'job1', status: 'cancelled', error: 'Publish cancelled' }; }
      emit({ jobId: 'job1', step, status: 'done', message: 'ok', ...(STEPS[i] === 'host' ? { skipped: true } : {}),
        ...(STEPS[i] === 'create' ? { remoteId: 'remote-1', url: 'https://cults3d.com/en/3d-model/art/ceramic-owl' } : {}) });
    }
    return { ok: true, jobId: 'job1', status: 'done', result: { remoteId: 'remote-1', url: 'https://cults3d.com/en/3d-model/art/ceramic-owl', status: 'published' } };
  }
  w.electronAPI = Object.assign(w.electronAPI || {}, { listbridge: {
    describe: async () => ({
      platforms: [{ id: 'cults3d', label: 'Cults3D', transfer: 'url', maxFiles: 10, maxImages: 10, currencies: ['EUR', 'USD'], fields: [], credentials: ['nickname', 'apiKey'], testConnection: true }],
      fileHosts: [{ type: 's3', label: 'S3', credentials: ['endpoint', 'region', 'bucket', 'accessKeyId', 'secretAccessKey'], optional: ['prefix', 'style'] }],
    }),
    hasCredentials: async id => creds.has(id),
    setCredentials: async (id, secret) => { w.__lb.setCredentialsArgs.push([id, Object.keys(secret)]); creds.add(id); return { ok: true }; },
    clearCredentials: async id => ({ ok: true, removed: creds.delete(id) }),
    testConnection: async id => { w.__lb.calls.push('test:' + id); return { ok: true, message: 'Connected to Cults3D.' }; },
    start: async req => { w.__lb.calls.push('start'); w.__lb.lastRequest = { platform: req.platform, accountId: req.accountId, fileHostId: req.fileHostId, remoteId: req.remoteId, title: req.manifest.title, price: req.manifest.price, files: req.files.length, images: req.images.length }; return run(0, !!req.remoteId); },
    retry: async id => { w.__lb.calls.push('retry:' + id); return run(3, false); },
    cancel: async () => { w.__lb.cancel = true; return { ok: false, status: 'cancelled' }; },
    extendHold: async (id, ms) => { w.__lb.extendCalls.push([id, ms]); w.__lb.holdRemaining += ms; return { ok: true, holdRemainingMs: w.__lb.holdRemaining }; },
    onProgress: cb => { listeners.add(cb); return () => listeners.delete(cb); },
  } });
})()`;

async function main() {
  const browserPath = findBrowser();
  if (!browserPath) throw new Error('Chrome/Edge executable not found.');
  if (!existsSync(VITE_BIN)) throw new Error('Vite executable not found.');
  if (SHOTS) mkdirSync(SHOTS, { recursive: true });

  const appPort = await freePort();
  const debugPort = await freePort();
  const userDataDir = mkdtempSync(join(tmpdir(), 'mixomesh-publish-'));
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
    // Locale strings still pending a merge into src/i18n/locales/*.json: serve the
    // merged tables to the page (idempotent once the real files already hold them).
    const pending = {};
    for (const file of PENDING_FILES) {
      if (!existsSync(file)) continue;
      const part = JSON.parse(readFileSync(file, 'utf8'));
      for (const lang of Object.keys(part)) pending[lang] = { ...(pending[lang] ?? {}), ...part[lang] };
    }
    const LOCALE_FILES = { 'en.json': 'en', 'ja.json': 'ja', 'zh-Hant.json': 'zh-Hant' };
    cdp.onEvent = (msg) => {
      if (msg.method === 'Fetch.requestPaused') {
        const { requestId, request } = msg.params;
        const file = Object.keys(LOCALE_FILES).find(f => new URL(request.url).pathname.endsWith(`/locales/${f}`));
        if (!file) { cdp.send('Fetch.continueRequest', { requestId }).catch(() => {}); return; }
        const base = JSON.parse(readFileSync(join(ROOT, 'src/i18n/locales', file), 'utf8'));
        const merged = JSON.stringify({ ...(pending[LOCALE_FILES[file]] ?? {}), ...base });
        // Vite serves JSON imported with an attribute either natively or as a JS module (?import).
        const asModule = new URL(request.url).searchParams.has('import');
        cdp.send('Fetch.fulfillRequest', {
          requestId, responseCode: 200,
          responseHeaders: [{ name: 'Content-Type', value: asModule ? 'text/javascript' : 'application/json' }, { name: 'Cache-Control', value: 'no-store' }],
          body: Buffer.from(asModule ? `export default ${merged}` : merged).toString('base64'),
        }).catch(() => {});
        return;
      }
      if (msg.method === 'Runtime.exceptionThrown') failures.push(`exception: ${msg.params.exceptionDetails?.exception?.description ?? 'unknown'}`);
      if (msg.method === 'Inspector.targetCrashed') failures.push('target crashed');
    };
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1500, deviceScaleFactor: 1, mobile: false });
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*/locales/*.json*', requestStage: 'Request' }] });
    await cdp.send('Page.reload', { ignoreCache: true });
    await sleep(500);
    await waitFor(() => evaluate(cdp, `document.readyState === 'complete' && document.querySelector('#boot-status') === null && !!window.BABYLON?.SceneLoader`), 30000, 'app boot');
    await evaluate(cdp, `(() => { try { localStorage.setItem('mx-onboard-v1', '1'); } catch { /* */ } document.querySelector('.ob-skip')?.click(); })()`);

    const snap = async (name) => {
      if (!SHOTS) return;
      const clip = await evaluate(cdp, `(() => { const r = document.querySelector('#rp-print-body').getBoundingClientRect(); return { x: Math.max(0, r.x - 4), y: 0, width: r.width + 8, height: Math.min(innerHeight, r.bottom + 40), scale: 1 }; })()`);
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png', clip });
      writeFileSync(join(SHOTS, `${name}.png`), Buffer.from(shot.data, 'base64'));
    };
    const click = sel => evaluate(cdp, `(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el || el.disabled) return false; el.click(); return true; })()`);
    const setValue = (sel, v) => evaluate(cdp, `(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.value = ${JSON.stringify(v)}; el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);

    // Desktop-style runtime: caps.publish + fake bridge + a model to export.
    const setup = await evaluate(cdp, `(async () => {
      try {
        ${FAKE};
        const { setCapabilities } = await import('/src/core/storage/capabilities.js');
        setCapabilities({ publish: true });
        const blob = await (await fetch('/tests/fixtures/textured-quad.glb')).blob();
        const { AssetLoader } = await import('/src/core/AssetLoader.js');
        const ids = await AssetLoader.loadFromBlob(blob, 'textured-quad.glb');
        const { Selection } = await import('/src/core/Selection.js');
        Selection.set([ids[0]], ids[0]);
        const { Workspace } = await import('/src/ui/Workspace.js');
        Workspace.setWorkspace('print');
        const { dispatch } = await import('/src/core/StateManager.js');
        const { EVENTS } = await import('/src/core/events.js');
        dispatch(EVENTS.LOCALE_CHANGED);
        return { ok: true };
      } catch (err) { return { error: String(err?.stack ?? err) }; }
    })()`);
    assert(!setup?.error, `setup failed: ${setup?.error}`);
    await sleep(1200);

    // 0. Tab present on a publish-capable runtime
    assert(await click('#rp-print-body [data-tab="publish"]'), 'Publish tab must exist when caps.publish is true');
    await waitFor(() => evaluate(cdp, `!!document.querySelector('#rp-print-body #pub-platform')`), 10000, 'platform select');

    // 1. Not connected
    const s1 = await evaluate(cdp, `(() => {
      const q = s => document.querySelector('#rp-print-body ' + s);
      return {
        acct: q('#pub-acct')?.textContent.trim(),
        apiKeyType: q('[data-cred="apiKey"]')?.type,
        nicknameType: q('[data-cred="nickname"]')?.type,
        tunnelChecked: !!q('input[name="pub-host"][value="tunnel"]')?.checked,
        s3Fields: document.querySelectorAll('#rp-print-body [data-cred^="host."]').length,
        hasEndpointPlaceholder: !!document.querySelector('#rp-print-body [placeholder*="r2.cloudflarestorage"]'),
        saveBtn: !!q('[data-act="save-package"]'),
        hasForm: !!q('#pub-title'),
      };
    })()`);
    assert(s1.acct.includes('Not connected'), `state 1 account row: ${JSON.stringify(s1)}`);
    assert(s1.apiKeyType === 'password' && s1.nicknameType === 'text', `secret fields must be password inputs: ${JSON.stringify(s1)}`);
    assert(s1.tunnelChecked && s1.s3Fields === 0 && !s1.hasEndpointPlaceholder, `default file delivery must be Automatic with no S3 fields: ${JSON.stringify(s1)}`);
    assert(s1.saveBtn && !s1.hasForm, 'not connected: only Connect form + Save listing package');
    await snap('1-not-connected');

    // advanced S3 reveals the fields, switching back hides them
    await click('input[name="pub-host"][value="s3"]');
    await sleep(150);
    const s3Open = await evaluate(cdp, `document.querySelectorAll('#rp-print-body [data-cred^="host."]').length`);
    assert(s3Open === 7, `Advanced S3 must reveal the 5 required + 2 optional fields, got ${s3Open}`);
    await snap('1b-not-connected-s3');
    await click('input[name="pub-host"][value="tunnel"]');
    await sleep(150);

    // Connect with the automatic host: no filehost credentials may be sent
    await setValue('[data-cred="nickname"]', 'mixoadrian');
    await setValue('[data-cred="apiKey"]', SECRET);
    assert(await click('[data-act="connect"]'), 'Connect button');
    await waitFor(() => evaluate(cdp, `!!document.querySelector('#rp-print-body #pub-title')`), 10000, 'ready form after connect');
    const afterConnect = await evaluate(cdp, `({ args: window.__lb.setCredentialsArgs, calls: window.__lb.calls,
      pw: [...document.querySelectorAll('input[type=password]')].map(i => i.value),
      leaked: document.body.innerHTML.includes(${JSON.stringify(SECRET)}) || JSON.stringify(localStorage).includes(${JSON.stringify(SECRET)}) })`);
    assert(JSON.stringify(afterConnect.args) === JSON.stringify([['cults3d:default', ['nickname', 'apiKey']]]),
      `automatic delivery must save only the platform credentials: ${JSON.stringify(afterConnect.args)}`);
    assert(afterConnect.calls.includes('test:cults3d:default'), 'Connect must test the connection');
    assert(!afterConnect.leaked, 'secret leaked into DOM or localStorage');

    // 2. Ready
    await waitFor(() => evaluate(cdp, `!!document.querySelector('#rp-print-body .pub-hero img')`), 30000, 'hero capture');
    await setValue('#pub-title', 'Ceramic owl');
    await setValue('#pub-desc', 'Full-colour figurine.');
    await evaluate(cdp, `(() => { const i = document.querySelector('#pub-tag-input'); i.value = 'owl'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
    await setValue('#pub-tag-input', 'figurine, full colour,');
    await setValue('#pub-price', '4');
    const s2 = await evaluate(cdp, `(() => {
      const b = document.querySelector('#pub-primary');
      return { label: b.textContent.trim(), disabled: b.disabled, blocker: document.querySelector('#pub-blocker').textContent.trim(),
        chips: [...document.querySelectorAll('.pub-chip')].map(c => c.firstChild.textContent),
        zip: document.querySelector('#rp-print-body')?.textContent.includes('Files over 10 are zipped'),
        strip: !!document.querySelector('#rp-print-body .pp-readiness-strip'),
        fmts: document.querySelectorAll('[data-fmt-pick]').length, aiOff: !document.querySelector('#pub-ai').checked };
    })()`);
    assert(s2.label === 'Publish live on Cults3D · €4.00' && !s2.disabled, `primary button: ${JSON.stringify(s2)}`);
    assert(JSON.stringify(s2.chips) === JSON.stringify(['owl', 'figurine', 'full colour']), `tag chips: ${JSON.stringify(s2.chips)}`);
    assert(s2.zip && s2.strip && s2.fmts === 5 && s2.aiOff, `ready-state details: ${JSON.stringify(s2)}`);
    // validation: clearing the title disables the button and says why
    await setValue('#pub-title', '');
    const blocked = await evaluate(cdp, `({ d: document.querySelector('#pub-primary').disabled, b: document.querySelector('#pub-blocker').textContent.trim() })`);
    assert(blocked.d && blocked.b === 'Add a title.', `blocked state: ${JSON.stringify(blocked)}`);
    await setValue('#pub-title', 'Ceramic owl');
    await snap('2-ready');

    // 3. Publish: first attempt fails at "create", Retry succeeds
    assert(await click('#pub-primary'), 'primary click');
    // The fixture exports with warnings: the gate must stop and offer "Publish anyway" (nothing sent yet).
    await waitFor(() => evaluate(cdp, `!!document.querySelector('[data-act="publish-anyway"]') || !!document.querySelector('.pub-step.run')`), 20000, 'gate or run');
    if (await evaluate(cdp, `!!document.querySelector('[data-act="publish-anyway"]')`)) {
      assert(!(await evaluate(cdp, `window.__lb.calls.includes('start')`)), 'nothing may be sent before the warnings are acknowledged');
      await snap('2b-gate');
      assert(await click('[data-act="publish-anyway"]'), 'publish anyway');
    }
    // The fake job can reach the failure before a poll sees the running step: accept either.
    await waitFor(() => evaluate(cdp, `!!document.querySelector('#rp-print-body .pub-step.run, #rp-print-body .pub-job-fail')`), 20000, 'running step or failure');
    if (await evaluate(cdp, `!!document.querySelector('#rp-print-body .pub-step.run')`)) await snap('3a-publishing');
    await waitFor(() => evaluate(cdp, `!!document.querySelector('#rp-print-body .pub-job-fail')`), 20000, 'failure box');
    const failed = await evaluate(cdp, `({ box: document.querySelector('.pub-job-fail').textContent, steps: [...document.querySelectorAll('.pub-step')].map(s => s.className.replace('pub-step ', '')),
      req: window.__lb.lastRequest, hostLabel: [...document.querySelectorAll('.pub-step')][3]?.textContent })`);
    assert(failed.box.includes('category is required') && failed.box.includes('Create listing failed'), `failure box: ${failed.box}`);
    assert(failed.req.fileHostId === 'tunnel' && failed.req.platform === 'cults3d' && failed.req.files >= 1 && failed.req.images === 1 && !failed.req.remoteId,
      `publish request: ${JSON.stringify(failed.req)}`);
    assert(failed.hostLabel.includes('Make temporary download links'), `host step label: ${failed.hostLabel}`);
    await snap('3b-failed');
    assert(await click('[data-act="retry"]'), 'retry');
    // Hold: Cults3D is downloading from the temporary link. Structured text, Keep waiting, early remoteId.
    await waitFor(() => evaluate(cdp, `!!document.querySelector('#rp-print-body .pub-hold')`), 20000, 'hold line');
    const hold = await evaluate(cdp, `(async () => { const { getState } = await import('/src/core/StateManager.js');
      return { text: document.querySelector('.pub-hold').textContent.trim(), btn: document.querySelector('[data-act="keep-waiting"]')?.textContent.trim(),
        early: getState().project.listings.map(l => ({ remoteId: l.remoteId, status: l.status })) }; })()`);
    assert(hold.text === 'Cults3D is downloading the files (1/3) · ~10 min left', `hold text: ${hold.text}`);
    assert(hold.btn === 'Keep waiting (+15 min)', `keep waiting button: ${hold.btn}`);
    assert(hold.early.length === 1 && hold.early[0].remoteId === 'remote-1' && hold.early[0].status === 'failed',
      `remoteId must be saved the moment create succeeds: ${JSON.stringify(hold.early)}`);
    await snap('3b2-hold');
    assert(await click('[data-act="keep-waiting"]'), 'keep waiting');
    await waitFor(() => evaluate(cdp, `document.querySelector('.pub-hold')?.textContent.includes('~25 min left')`), 10000, 'extended hold line');
    assert(await evaluate(cdp, `JSON.stringify(window.__lb.extendCalls) === '[["job1",900000]]'`), 'extendHold(jobId, 15 min) reached the bridge');
    await evaluate(cdp, `window.__lb.holdRelease = true`);
    await waitFor(() => evaluate(cdp, `!!document.querySelector('#rp-print-body .pub-ok')`), 20000, 'success box');
    const done = await evaluate(cdp, `(async () => { const { getState } = await import('/src/core/StateManager.js');
      return { ok: document.querySelector('.pub-ok').textContent, url: document.querySelector('#pub-url')?.value,
        listings: getState().project.listings.map(l => ({ remoteId: l.remoteId, status: l.status, url: l.url })), retryCalled: window.__lb.calls.includes('retry:job1') }; })()`);
    assert(done.url === 'https://cults3d.com/en/3d-model/art/ceramic-owl' && done.ok.includes('Live on Cults3D'), `success box: ${JSON.stringify(done)}`);
    assert(done.retryCalled && done.listings.length === 1 && done.listings[0].remoteId === 'remote-1' && done.listings[0].status === 'published',
      `retry must persist the listing: ${JSON.stringify(done.listings)}`);
    await snap('3c-done');

    // 4. Back to the form: now an Update, with the live link
    await click('[data-act="back"]');
    await waitFor(() => evaluate(cdp, `!!document.querySelector('#rp-print-body #pub-primary')`), 10000, 'form after done');
    const again = await evaluate(cdp, `({ label: document.querySelector('#pub-primary').textContent.trim(), live: !!document.querySelector('.pub-live'), liveText: document.querySelector('.pub-live')?.textContent })`);
    assert(again.label === 'Update listing on Cults3D' && again.live && again.liveText.includes('updates this listing'), `update state: ${JSON.stringify(again)}`);
    await snap('4-update');

    // 5. Save listing package is reachable from the Publish tab too
    assert(await evaluate(cdp, `!!document.querySelector('#rp-print-body [data-act="save-package"]')`), 'Save listing package on the Publish tab');

    // 6. Esc must not destroy anything: tab still there
    await evaluate(cdp, `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    assert(await evaluate(cdp, `!!document.querySelector('#rp-print-body #pub-primary')`), 'Esc must not tear down the Publish tab');

    assert(failures.length === 0, `page errors: ${failures.join(' | ')}`);
    console.log('browser publish smoke ok');
    await cdp.close();
  } finally {
    await stopProcess(browser);
    await stopProcess(vite);
    removeTempDir(userDataDir);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
