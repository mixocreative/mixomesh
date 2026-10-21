// Electron main process (ADR 0001 Phase 2). Loads the built web app (or the Vite
// dev server via MIXO_DEV_URL) in a hardened BrowserWindow, and backs the
// DesktopStorageAdapter with real Node fs over IPC.
//
// Run (after `npm i -D electron`): `MIXO_DEV_URL=http://localhost:5173 npx electron electron/main.cjs`
// (dev, with `npm run dev` running) or `npm run build` then `npx electron electron/main.cjs` (built).
// See docs/handoff/electron.md.

const { app, BrowserWindow, ipcMain, dialog, session, safeStorage } = require('electron');
const path = require('node:path');
const {
  createOpaqueFileRegistry, sanitizeSuggestedName, exportDialogOptions, withExtension, publicSaveError,
} = require('./OpaqueFileRegistry.cjs');
const { createKvStore } = require('./KvStore.cjs');
const { parseLaunchArgv, validateLaunchPath } = require('./LaunchArgs.cjs');
const { buildLaunchBatch, createLaunchQueue } = require('./LaunchQueue.cjs');
const { createApiServer, apiError: makeApiError, METHOD_NAMES: API_METHOD_NAMES, readSessionFile: readApiSession } = require('./ApiServer.cjs');
const { createJobRunner, LIMITS: JOB_LIMITS } = require('./JobRunner.cjs');
const { registerListbridgeIpc, loadListbridgeCore } = require('./listbridge/index.cjs');
const { fakePlatformAdapters } = require('./listbridge/fakePlatform.cjs');
const {
  SECURE_WEB_PREFERENCES, appEntryUrl, guardWebContents, denyAllPermissions, isTrustedSender,
} = require('./WindowSecurity.cjs');

const { applyHeapFlags } = require('./HeapFlags.cjs');

// Before app ready: room for heavy (2M-10M+ triangle) print meshes in the renderer.
applyHeapFlags(app);

const DEV_URL = process.env.MIXO_DEV_URL || '';
const INDEX_PATH = path.join(__dirname, '..', 'dist', 'index.html');
// The ONE document the renderer may show (task 6.1): navigation, window.open
// and IPC senders are all checked against it.
const ENTRY_URL = appEntryUrl({ devUrl: DEV_URL, indexPath: INDEX_PATH });
// MIXO_SMOKE=save (unpackaged only): isolated temp userData, the project save
// dialog is answered with a temp file, and the smoke drives Ctrl+Shift+S then
// checks the written .mixo + that the renderer-readable KV holds no OS path.
const SMOKE_SAVE = process.env.MIXO_SMOKE === 'save';
// MIXO_SMOKE=launch (unpackaged only, LI.6): the test pre-creates the temp root and passes
// MIXO_SMOKE_USERDATA so a SECOND process can share the single-instance lock; _runLaunchSmoke
// observes the renderer, spawns that second process and checks the result.
const SMOKE_LAUNCH = process.env.MIXO_SMOKE === 'launch';
// MIXO_SMOKE=api (unpackaged only, API.5): temp (or MIXO_SMOKE_USERDATA) userData; the API server
// starts as in a real run and the external end-to-end smoke (API.8) drives it over the pipe.
const SMOKE_API = process.env.MIXO_SMOKE === 'api';
const PROJECT_FILTERS = [{ name: 'MIXOMESH project', extensions: ['mixo'] }];
let _smokeDir = null;
let _smokeRoot = null;
// Every unpackaged smoke mode gets a temp userData (also scopes the single-instance
// lock, so a smoke run never collides with a running dev/real app); only `save`
// keeps the dir for its own checks.
if (process.env.MIXO_SMOKE && !app.isPackaged) {
  const os = require('node:os');
  const fsSync = require('node:fs');
  const sharedUserData = SMOKE_LAUNCH || SMOKE_API ? process.env.MIXO_SMOKE_USERDATA : '';
  const smokeRoot = sharedUserData
    ? path.dirname(sharedUserData)
    : fsSync.mkdtempSync(path.join(os.tmpdir(), 'mixo-smoke-'));
  app.setPath('userData', sharedUserData || path.join(smokeRoot, 'userData'));
  _smokeRoot = smokeRoot;
  if (SMOKE_SAVE) _smokeDir = smokeRoot;
}

// ── Single instance + launch requests (LI.2, plan D1/D4/D5) ──
// A second `MIXOMESH.exe --open x.glb` exits at once; its argv is forwarded to this
// instance via 'second-instance' and shown in the running window.
// Batch jobs (API.7): `--job job.json --result r.json [--hidden] [--quit]`. A job always runs hidden
// and quits when done. The instance that LOSES the lock must not quit at once: it is the job
// client (reads the API session file via ApiServer.readSessionFile, talks to the running app's pipe) and exits itself.
const _launchArgs = parseLaunchArgv(process.argv, { isPackaged: app.isPackaged });
const _jobMode = !!_launchArgs.job;
const _jobNoResult = _jobMode && !_launchArgs.result;
if (_jobNoResult) {
  console.error('--job requires --result <file.json> (the result is written there)');
  app.exit(3);
}
const _gotLock = _jobNoResult ? false : app.requestSingleInstanceLock();
if (!_gotLock && !_jobMode) app.quit();
let _kv = null;
// Opaque file registry; its persisted ref store (`mixo-refs.json`, absolute paths)
// is a SEPARATE file from the renderer-readable KV so kv:get/kv:keys can never
// expose an OS path. Created on app ready (needs userData).
let _fileRefs = null;
const _approvedClose = new WeakSet();
const _launchQueues = new WeakMap();   // webContents → launch queue
let _launchServiceUp = false;          // registry exists + window created
const _deferredLaunches = [];          // {argv, cwd} seen before the service was up
// Windows whose user already accepted "quit anyway" for a running publish (PB.14); the
// publish is cancelled only once the close is really approved (save/discard answered).
const _publishQuitAck = new WeakSet();
let _publishPromptOpen = false;
// MIXO_SMOKE bypasses the unload/close/crash guards ONLY in unpackaged builds.
const smokeBypass = () => !!process.env.MIXO_SMOKE && !app.isPackaged;

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    backgroundColor: '#efe7d8',
    show: !_jobMode,   // a job never shows a window
    // Hardened (task 6.1): contextIsolation + no nodeIntegration + sandbox. A hidden job window must
    // keep rendering (renders/thumbnails), so background throttling is off for jobs.
    webPreferences: {
      ...SECURE_WEB_PREFERENCES, preload: path.join(__dirname, 'preload.cjs'),
      ...(_jobMode ? { backgroundThrottling: false } : {}),
    },
  });
  // Launch queue (D5): per window; ready only after the renderer's launch:pull, and
  // reset on every (re)load so a reloading renderer never loses a batch.
  const launchQueue = createLaunchQueue();
  _launchQueues.set(win.webContents, launchQueue);
  win.webContents.on('did-start-loading', () => launchQueue.reset());
  // A reloading renderer can never answer what it was asked: fail in-flight API requests.
  win.webContents.on('did-start-loading', () => _failApiRequests('reload'));
  if (DEV_URL) win.loadURL(DEV_URL);
  else win.loadFile(INDEX_PATH);

  win.on('close', event => {
    if (_approvedClose.has(win) || smokeBypass()) return;
    event.preventDefault();
    const running = _listbridge?.runningJobs() ?? [];
    if (running.length && !_publishQuitAck.has(win)) {
      _askQuitDuringPublish(win, running);
      return;
    }
    win.webContents.send('app:close-requested');
  });

  // The renderer cancels `beforeunload` when the project is dirty (Ctrl+R, navigation).
  // Electron swallows that silently unless we answer will-prevent-unload ourselves.
  win.webContents.on('will-prevent-unload', event => {
    // ignore the prevention = leave. An approved close already went through the
    // renderer's save/discard dialog — don't ask twice.
    if (smokeBypass() || _approvedClose.has(win)) { event.preventDefault(); return; }
    const publishing = !!_listbridge?.hasRunningJobs();
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      buttons: ['Leave', 'Stay'],
      defaultId: 1,
      cancelId: 1,
      title: publishing ? 'Reload during a publish?' : 'Leave without saving?',
      message: publishing ? 'A publish is still running.' : 'Leave without saving?',
      detail: publishing
        ? 'Reloading hides its progress. The publish keeps running, but you cannot cancel or retry it from the reloaded window.'
        : 'This project has unsaved changes that will be lost.',
    });
    if (choice === 0) event.preventDefault(); // preventDefault here = proceed with unload
  });

  // Closing the window while a publish is transferring files: ask first (PB.14). "Quit anyway"
// continues into the normal save/discard flow; the publish is cancelled when the close is approved.
function _askQuitDuringPublish(win, running) {
  if (_publishPromptOpen) return;
  _publishPromptOpen = true;
  const names = [...new Set(running.map(j => j.label))].join(', ');
  dialog.showMessageBox(win, {
    type: 'warning',
    buttons: ['Keep waiting', 'Quit anyway'],
    defaultId: 0,
    cancelId: 0,
    title: 'Publish in progress',
    message: `A publish to ${names} is still transferring files — quitting will break it.`,
    detail: 'Quitting cancels the publish and removes its temporary download links. The listing may be left incomplete on the platform.',
  }).then(({ response }) => {
    if (response !== 1 || win.isDestroyed()) return;
    _publishQuitAck.add(win);
    win.close();   // re-enters 'close': now goes on to the renderer's save/discard dialog
  }).catch(() => {}).finally(() => { _publishPromptOpen = false; });
}

// Renderer crash / kill / OOM: offer a reload instead of leaving a dead window.
  win.webContents.on('render-process-gone', (_event, details) => {
    if (smokeBypass()) { console.error('MIXO_SMOKE: render-process-gone', details?.reason); app.exit(3); return; }
    // A job has nobody to answer a dialog: fail it (the runner writes the result and exits).
    if (_jobMode && _jobRunner) { _jobRunner.abort('the app window crashed'); return; }
    if (details?.reason === 'clean-exit' || win.isDestroyed()) return;
    const choice = dialog.showMessageBoxSync(win, {
      type: 'error',
      buttons: ['Reload', 'Close window'],
      defaultId: 0,
      cancelId: 1,
      title: 'MIXOMESH stopped responding',
      message: 'The window crashed (' + (details?.reason ?? 'unknown') + ').',
      detail: 'Reload to reopen the app. Unsaved changes may be recovered from autosave.',
    });
    if (choice === 0) win.webContents.reload();
    else { _approvedClose.add(win); win.close(); }
  });

  // Headless smoke (MIXO_SMOKE=1): verify the built app boots in the desktop shell
  // under the hardened settings (task 6.1 probe), then quit — so CI/dev can assert
  // the desktop path loads without a lingering window. Any CSP violation the page
  // logs fails either smoke mode.
  if (process.env.MIXO_SMOKE && !app.isPackaged) {
    win.webContents.on('console-message', details => {
      const text = String(details?.message ?? '');
      if (/Content Security Policy/i.test(text)) { console.error('MIXO_SMOKE: CSP violation', text); app.exit(5); }
    });
  }
  if (SMOKE_API && !app.isPackaged) {
    // Nothing to probe in-process: the external smoke (API.8) talks to the pipe. Just fail
    // loudly if the page never loads, and never outlive a stuck test.
    win.webContents.once('did-finish-load', () => console.log('MIXO_SMOKE: loaded'));
    win.webContents.once('did-fail-load', (_e, code, desc) => { console.error('MIXO_SMOKE: fail', code, desc); app.exit(1); });
    const failsafe = setTimeout(() => { console.error('MIXO_SMOKE: api timeout'); app.exit(2); }, 300000);
    failsafe.unref();
  } else if (SMOKE_LAUNCH && !app.isPackaged) {
    win.webContents.once('did-finish-load', () => { console.log('MIXO_SMOKE: loaded'); _runLaunchSmoke(win); });
    win.webContents.once('did-fail-load', (_e, code, desc) => { console.error('MIXO_SMOKE: fail', code, desc); app.exit(1); });
    setTimeout(() => { console.error('MIXO_SMOKE: launch timeout'); app.exit(2); }, 50000);
  } else if (_smokeDir) {
    win.webContents.once('did-finish-load', () => { console.log('MIXO_SMOKE: loaded'); _runSaveSmoke(win); });
    win.webContents.once('did-fail-load', (_e, code, desc) => { console.error('MIXO_SMOKE: fail', code, desc); app.exit(1); });
    setTimeout(() => { console.error('MIXO_SMOKE: save timeout'); app.exit(2); }, 40000);
  } else if (process.env.MIXO_SMOKE) {
    win.webContents.once('did-finish-load', () => { console.log('MIXO_SMOKE: loaded'); _runSecuritySmoke(win); });
    win.webContents.once('did-fail-load', (_e, code, desc) => { console.error('MIXO_SMOKE: fail', code, desc); app.exit(1); });
    setTimeout(() => { console.error('MIXO_SMOKE: timeout'); app.exit(2); }, 40000);
  }
}

// Security smoke (task 6.1): once the app has booted, check from inside the page
// that the sandboxed, isolated renderer has the bridge but no Node, that popups
// and foreign navigation are refused, and that what the CSP must still allow
// works from file:// — the vendored Manifold WASM + Embind init (CSG2), a bundled
// module worker and a blob: worker.
function _runSecuritySmoke(win) {
  const assets = path.join(__dirname, '..', 'dist', 'assets');
  const assetFiles = require('node:fs').readdirSync(assets);
  const workerFile = assetFiles.find(f => /^MeshValidate\.worker-.*\.js$/.test(f)) ?? '';
  const booleanFile = assetFiles.find(f => /^Boolean\.worker-.*\.js$/.test(f)) ?? '';
  const probe = `(async () => {
    const until = async (fn, ms) => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) return false; await new Promise(r => setTimeout(r, 100)); } return true; };
    const workerOk = w => new Promise(resolve => {
      const timer = setTimeout(() => { w.terminate(); resolve(true); }, 1500);
      w.onerror = () => { clearTimeout(timer); w.terminate(); resolve(false); };
      w.onmessage = () => { clearTimeout(timer); w.terminate(); resolve(true); };
    });
    const r = {};
    r.booted = await until(() => !document.getElementById('boot-status'), 20000);
    r.noNode = typeof require === 'undefined' && typeof process === 'undefined';
    r.bridge = typeof window.electronAPI?.storageReady === 'function';
    r.csp = !!document.querySelector('meta[http-equiv="Content-Security-Policy"]');
    r.popupDenied = window.open('https://example.com/') === null;
    // Heavy-mesh review M14: the renderer's V8 heap limit reflects HeapFlags (4 GiB old space).
    r.heapLimitMB = Math.round((performance.memory?.jsHeapSizeLimit ?? 0) / 1048576);
    try {
      const mod = await import(new URL('vendor/manifold-3d/manifold.js', document.baseURI).href);
      const wasm = await mod.default(); wasm.setup();
      r.manifold = typeof wasm.Manifold === 'function';
    } catch (err) { r.manifold = String(err); }
    r.moduleWorker = ${JSON.stringify(workerFile)} !== ''
      && await workerOk(new Worker(new URL('assets/' + ${JSON.stringify(workerFile)}, document.baseURI), { type: 'module' }));
    try {
      const d = await window.electronAPI?.listbridge?.describe();
      r.listbridge = Array.isArray(d?.platforms) && Array.isArray(d?.fileHosts) && d.platforms.some(p => p.id === 'cults3d') && d.fileHosts.some(h => h.type === 'tunnel' && h.default);
    } catch (err) { r.listbridge = String(err?.message ?? err); }
    r.blobWorker = await workerOk(new Worker(URL.createObjectURL(new Blob(['postMessage(1)'], { type: 'text/javascript' }))));
    // A real Boolean through the bundled worker: module worker + dynamic import
    // of the vendored manifold.js from file:// + WASM, end to end.
    r.booleanWorker = await (async () => {
      const file = ${JSON.stringify(booleanFile)};
      if (!file) return 'no Boolean worker bundle';
      const cube = dx => {
        const P = [0,0,0, 1,0,0, 1,1,0, 0,1,0, 0,0,1, 1,0,1, 1,1,1, 0,1,1].map((v, i) => (i % 3 === 0 ? v + dx : v));
        const T = [0,3,2, 0,2,1, 4,5,6, 4,6,7, 0,1,5, 0,5,4, 1,2,6, 1,6,5, 2,3,7, 2,7,6, 3,0,4, 3,4,7];   // CCW outward
        const I = [];
        for (let i = 0; i < T.length; i += 3) I.push(T[i + 2], T[i + 1], T[i]);   // Babylon winding
        return { positions: new Float32Array(P), indices: new Uint32Array(I), normals: null, matrix: [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1] };
      };
      return new Promise(resolve => {
        const w = new Worker(new URL('assets/' + file, document.baseURI), { type: 'module' });
        const timer = setTimeout(() => { w.terminate(); resolve('timeout'); }, 15000);
        w.onerror = e => { clearTimeout(timer); w.terminate(); resolve('error: ' + (e.message || '')); };
        w.onmessage = e => {
          const m = e.data;
          if (m?.type === 'progress') return;
          clearTimeout(timer); w.terminate();
          resolve(m?.type === 'done' && m.result?.indices?.length > 0 ? true : 'bad reply: ' + JSON.stringify(m).slice(0, 200));
        };
        w.postMessage({ id: 1, type: 'run', payload: { op: 'union', operands: [cube(0), cube(0.5)],
          manifoldUrl: new URL('vendor/manifold-3d/manifold.js', document.baseURI).href } });
      });
    })();
    return r;
  })()`;
  win.webContents.executeJavaScript(probe).then(async r => {
    // The window can be gone already (another smoke path exited the app):
    // touching a destroyed webContents throws in main and pops an error dialog.
    if (win.isDestroyed()) return;
    const before = win.webContents.getURL();
    await win.webContents.executeJavaScript(`location.href = 'https://example.com/'; true`).catch(() => {});
    await new Promise(res => setTimeout(res, 800));
    if (win.isDestroyed()) return;
    r.navigationDenied = win.webContents.getURL() === before;
    r.jsFlags = app.commandLine.getSwitchValue('js-flags');
    const heapOk = /--max-old-space-size=4096/.test(r.jsFlags) && r.heapLimitMB >= 3500;
    const ok = heapOk && r.booted && r.noNode && r.bridge && r.csp && r.popupDenied && r.manifold === true
      && r.moduleWorker && r.blobWorker && r.navigationDenied && r.listbridge === true
      && r.booleanWorker === true;
    console.log(`MIXO_SMOKE: security ${ok ? 'ok' : 'FAIL'}`, JSON.stringify(r));
    setTimeout(() => app.exit(ok ? 0 : 6), 200);
  }, err => { console.error('MIXO_SMOKE: security probe threw', err?.message ?? err); app.exit(6); });
}

// Save smoke: press Ctrl+Shift+S in the renderer until the (stubbed) save
// dialog's temp file holds a .mixo, then check the recents entry in the
// renderer-readable KV is a stable key and no OS path leaked into it.
function _runSaveSmoke(win) {
  const fsSync = require('node:fs');
  const target = path.join(_smokeDir, 'smoke.mixo');
  const kvFile = path.join(app.getPath('userData'), 'mixo-kv.json');
  let pressed = 0;
  const tick = async () => {
    if (win.isDestroyed()) return;
    if (!fsSync.existsSync(target)) {
      if (pressed++ < 20) {
        await win.webContents.executeJavaScript(`document.dispatchEvent(new KeyboardEvent('keydown',
          { key: 'S', code: 'KeyS', ctrlKey: true, shiftKey: true, bubbles: true })); true`).catch(() => {});
      }
      setTimeout(tick, 1000);
      return;
    }
    let doc;
    try { doc = JSON.parse(fsSync.readFileSync(target, 'utf8')); } catch { setTimeout(tick, 500); return; }
    const kvText = fsSync.existsSync(kvFile) ? fsSync.readFileSync(kvFile, 'utf8') : '';
    let recents = [];
    try { recents = JSON.parse(kvText || '{}').recent_projects ?? []; } catch { recents = []; }
    if (!recents.length) { setTimeout(tick, 500); return; }
    // Any absolute path under the smoke dir carries this unique folder name.
    const leaked = kvText.includes(path.basename(_smokeDir));
    const keyOk = /^file_[0-9a-f]{32}$/.test(recents[0]?.handleKey ?? '');
    if (doc?.project?.name !== 'smoke' || !keyOk || leaked) {
      console.error('MIXO_SMOKE: save FAIL', JSON.stringify({ name: doc?.project?.name, handleKey: recents[0]?.handleKey, leaked }));
      app.exit(4);
      return;
    }
    console.log('MIXO_SMOKE: saved', JSON.stringify({ name: doc.project.name, handleKey: recents[0].handleKey }));
    setTimeout(() => app.exit(0), 200);
  };
  setTimeout(tick, 1500);
}

// Launch smoke (LI.6): first instance was started with --open/--library args (+ one bad
// --open). Wait until the renderer shows >=2 objects, the Library tab lists the temp
// folder and ONE toast names only the bad file's basename; then start a SECOND process
// on the same userData (hits the single-instance lock, must exit 0 fast) and wait for
// the object count to grow by one. Finally: no OS path in renderer-visible state.
function _runLaunchSmoke(win) {
  const fsSync = require('node:fs');
  const { spawn } = require('node:child_process');
  const libName = process.env.MIXO_SMOKE_LIBNAME ?? '';
  const badName = process.env.MIXO_SMOKE_BADNAME ?? '';
  const second = process.env.MIXO_SMOKE_SECOND ?? '';
  const token = path.basename(_smokeRoot);       // present in every absolute path the test made
  const fail = (msg, extra) => { console.error('MIXO_SMOKE: launch FAIL', msg, extra ? JSON.stringify(extra) : ''); app.exit(4); };
  const probe = () => win.webContents.executeJavaScript(`(() => ({
    objects: document.querySelectorAll('#outliner .ol-row[data-kind="object"]').length,
    library: document.getElementById('ap-tree-list')?.textContent ?? '',
    toasts: [...document.querySelectorAll('.toast .toast-msg')].map(e => e.textContent),
  }))()`).catch(() => null);
  const until = async (pred, ms, what) => {
    const end = Date.now() + ms;
    for (;;) {
      if (win.isDestroyed()) return null;
      const r = await probe();
      if (r && pred(r)) return r;
      if (Date.now() > end) { fail(`timeout waiting for ${what}`, r && { objects: r.objects, toasts: r.toasts }); return null; }
      await new Promise(res => setTimeout(res, 300));
    }
  };
  (async () => {
    const t0 = Date.now();
    const first = await until(r => r.objects >= 2 && r.library.includes(libName)
      && r.toasts.some(m => m.includes(badName)), 25000, 'objects>=2 + library + bad-arg toast');
    if (!first) return;
    const t1 = Date.now();
    const badToasts = first.toasts.filter(m => m.includes(badName));
    if (badToasts.length !== 1 || badToasts[0].includes(token) || /[\\/]/.test(badToasts[0])) {
      return fail('bad-arg toast must be exactly one and basename-only', badToasts);
    }
    const before = first.objects;
    const ts = Date.now();
    const child = spawn(process.execPath, [path.join(__dirname, 'main.cjs'), '--open', second], {
      env: { ...process.env }, stdio: 'ignore',
    });
    const code = await new Promise(res => {
      const timer = setTimeout(() => { child.kill(); res('timeout'); }, 10000);
      child.on('exit', c => { clearTimeout(timer); res(c); });
      child.on('error', () => { clearTimeout(timer); res('error'); });
    });
    const secondMs = Date.now() - ts;
    if (code !== 0) return fail('second instance did not exit 0 within 10s', { code });
    const after = await until(r => r.objects === before + 1, 15000, 'object count +1 after second instance');
    if (!after) return;
    // Leak check: nothing renderer-visible may carry the temp path (main-side refs may).
    const visible = await win.webContents.executeJavaScript(
      `JSON.stringify({ls: {...localStorage}, text: document.body.innerText})`);
    const kvFile = path.join(app.getPath('userData'), 'mixo-kv.json');
    const kvText = fsSync.existsSync(kvFile) ? fsSync.readFileSync(kvFile, 'utf8') : '';
    const refsFile = path.join(app.getPath('userData'), 'mixo-refs.json');
    const refsHasPaths = fsSync.existsSync(refsFile) && fsSync.readFileSync(refsFile, 'utf8').includes(token);
    const leaked = visible.includes(token) || kvText.includes(token);
    if (leaked) return fail('OS path leaked into renderer-visible state / mixo-kv.json', { visible: visible.includes(token), kv: kvText.includes(token) });
    console.log('MIXO_SMOKE: launched', JSON.stringify({
      objects: before, afterSecond: after.objects, firstMs: t1 - t0, secondExitMs: secondMs, secondExit: code, refsHoldPaths: refsHasPaths,
    }));
    setTimeout(() => app.exit(0), 200);
  })().catch(err => fail('probe threw', { message: err?.message ?? String(err) }));
}

// ── User-editable config files (materials.json) ──
// Lives OUTSIDE the app bundle so the user can edit it with any text editor:
// <userData>/config/<name>. Seeded from the shipped copy (dist/config in a
// packaged build, public/config in dev) the first time it is asked for. Only
// a fixed allowlist of names can be read — never an arbitrary path.
const USER_CONFIG_FILES = new Set(['materials.json']);

const _winOf = event => BrowserWindow.fromWebContents(event.sender) ?? undefined;

// Every IPC channel goes through `handle`: the sender must be the app's own
// top-level frame (task 6.1) — a foreign or child frame gets an error.
function handle(channel, fn) {
  ipcMain.handle(channel, (event, ...args) => {
    if (!isTrustedSender(event, ENTRY_URL)) throw new Error(`${channel}: untrusted sender`);
    return fn(event, ...args);
  });
}

handle('config:read', async (_e, name) => {
  if (!USER_CONFIG_FILES.has(name)) return { error: `config "${name}" is not a user-editable file` };
  const fs = require('node:fs/promises');
  const dir = path.join(app.getPath('userData'), 'config');
  const target = path.join(dir, name);
  try {
    await fs.mkdir(dir, { recursive: true });
    try {
      return { text: await fs.readFile(target, 'utf8'), path: target };
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err;
    }
    const shipped = [
      path.join(__dirname, '..', 'dist', 'config', name),
      path.join(__dirname, '..', 'public', 'config', name),
    ];
    for (const src of shipped) {
      try {
        const text = await fs.readFile(src, 'utf8');
        await fs.writeFile(target, text, 'utf8');
        return { text, path: target };
      } catch (err) {
        if (err?.code !== 'ENOENT') throw err;
      }
    }
    return { error: `${name}: no shipped copy found to seed ${target}`, path: target };
  } catch (err) {
    return { error: `${name}: ${err?.message ?? err}`, path: target };
  }
});

// ── KV persistence (JSON file in userData) — backs DesktopStorageAdapter.kv* ──
// Atomic temp+rename writes, serialised mutations, corrupt-file quarantine: KvStore.cjs.
handle('kv:set', (_e, key, value) => _kv.set(key, value));
handle('kv:get', (_e, key) => _kv.get(key));
handle('kv:delete', (_e, key) => _kv.delete(key));
handle('kv:keys', () => _kv.keys());

// ── Mounted asset directories (opaque renderer refs) ──
handle('dialog:mountDirectory', async event => {
  const result = await dialog.showOpenDialog(_winOf(event), { properties: ['openDirectory'] });
  if (result.canceled || !result.filePaths[0]) return null;
  const absolutePath = result.filePaths[0];
  return _fileRefs.registerMount(absolutePath, path.basename(absolutePath));
});
handle('fs:listDirectoryRef', (_e, ref, parentPath) => _fileRefs.listDirectory(ref, parentPath));
handle('fs:readFileRef', (_e, ref) => _fileRefs.readFile(ref));

// ── Persisted asset refs (task 4.2) — stable keys in, opaque tokens / bytes out ──
// Every argument is type-checked here; the registry re-validates keys, files and
// relative paths (no escaping the folder). Absolute paths never leave main.
const _str = v => (typeof v === 'string' && v.length > 0 && v.length < 4096 ? v : null);
handle('refs:persist', (_e, ref) => {
  if (!_str(ref)) throw new Error('refs:persist expects an opaque ref');
  return _fileRefs.persistRef(ref);
});
handle('refs:restore', (_e, key) => (_str(key) ? _fileRefs.restoreRef(key) : null));
handle('refs:delete', (_e, key) => (_str(key) ? _fileRefs.deleteRef(key) : undefined));
handle('refs:read', (_e, key, relPath) => {
  if (!_str(key)) return null;
  return _fileRefs.readStoredFile(key, relPath == null ? null : _str(relPath) ?? '');
});
// Explicit, user-invoked only (Decision 3: load never scans). Progress is pushed
// back on 'refs:find-progress' tagged with the caller's request id.
handle('refs:findMoved', (event, requestId, args) => {
  const id = _str(requestId);
  const a = args && typeof args === 'object' ? args : {};
  return _fileRefs.findMoved({
    refKey: _str(a.refKey),
    contentHash: _str(a.contentHash),
    ext: _str(a.ext) ?? '',
    limit: Number(a.limit) || undefined,
  }, progress => {
    if (id && !event.sender.isDestroyed()) event.sender.send('refs:find-progress', id, progress);
  });
});

// ── Bridge handshake (task 4.4 boot gate) ──
// The renderer refuses to boot until this answers: KV + ref store are created
// and the KV file is loaded (a corrupt file is quarantined here, not mid-save).
handle('storage:ready', async () => {
  if (!_kv || !_fileRefs) return { ok: false, reason: 'storage not initialised' };
  await _kv.keys();
  return { ok: true };
});

// ── Project / import / export dialogs via opaque tokens (task 4.4 / 6.2) ──
// Main shows the dialog and registers the chosen file; the renderer only ever
// receives `{ref, name}` (or a boolean for exports). The renderer passes only a
// DESCRIPTOR (`{suggestedName}` / `{suggestedName, ext, description}`), which
// main sanitises: bare file name (no folders / drive / reserved chars), export
// extension on the whitelist, plain capped description. Project open/save
// tokens are WRITABLE (Ctrl+S writes back, 1 GiB cap); import / mount / drop
// tokens are read-only; an export writes the chosen file and mints no token.
handle('project:pickOpen', async event => {
  const result = await dialog.showOpenDialog(_winOf(event), { properties: ['openFile'], filters: PROJECT_FILTERS });
  if (result.canceled || !result.filePaths[0]) return null;
  return _fileRefs.registerFile(result.filePaths[0], path.basename(result.filePaths[0]), { writable: true });
});
handle('project:pickSave', async (event, opts) => {
  let target;
  if (_smokeDir) {
    target = path.join(_smokeDir, 'smoke.mixo');
  } else {
    const result = await dialog.showSaveDialog(_winOf(event), {
      defaultPath: withExtension(sanitizeSuggestedName(opts?.suggestedName, 'Untitled'), 'mixo'),
      filters: PROJECT_FILTERS,
    });
    if (result.canceled || !result.filePath) return null;
    target = result.filePath;
  }
  target = withExtension(target, 'mixo');
  return _fileRefs.registerFile(target, path.basename(target), { writable: true });
});
handle('fs:writeFileRef', (_e, ref, data) => {
  if (!_str(ref)) throw new Error('fs:writeFileRef expects an opaque ref');
  return _fileRefs.writeFile(ref, data);
});
handle('dialog:pickImport', async (event, opts) => {
  const properties = opts?.multiple === false ? ['openFile'] : ['openFile', 'multiSelections'];
  const result = await dialog.showOpenDialog(_winOf(event), { properties });
  if (result.canceled) return [];
  return result.filePaths.map(p => _fileRefs.registerFile(p, path.basename(p)));
});
// Called only by the preload's refForDroppedFile (the page cannot reach ipcRenderer);
// the path comes from webUtils.getPathForFile on a File the user dropped.
handle('fs:registerDropped', async (_e, filePath) => {
  if (!_str(filePath) || !path.isAbsolute(filePath)) return null;
  try {
    if (!(await require('node:fs/promises').stat(filePath)).isFile()) return null;
  } catch { return null; }
  return _fileRefs.registerFile(filePath, path.basename(filePath));
});

// Save handlers: fs errors carry absolute paths; send the renderer a path-free one.
const pathless = fn => async (...args) => {
  try { return await fn(...args); } catch (err) { throw publicSaveError(err); }
};

handle('export:save', pathless(async (event, opts, data) => {
  const { ext, defaultName, filters } = exportDialogOptions(opts); // throws on a non-whitelisted type
  const result = await dialog.showSaveDialog(_winOf(event), { defaultPath: defaultName, filters });
  if (result.canceled || !result.filePath) return false;
  await _fileRefs.writeDialogTarget(withExtension(result.filePath, ext), data);
  return true;
}));

// Streamed export save for big files: the renderer sends ≤16 MiB chunks instead
// of one whole-file buffer (no 2-3x peak from Blob → ArrayBuffer → IPC clone).
// Same whitelisted dialog as export:save; the session id is opaque and bound to
// the sender, the temp file is renamed into place only on commit.
handle('export:beginSave', pathless(async (event, opts) => {
  const { ext, defaultName, filters } = exportDialogOptions(opts); // throws on a non-whitelisted type
  const result = await dialog.showSaveDialog(_winOf(event), { defaultPath: defaultName, filters });
  if (result.canceled || !result.filePath) return null;
  return _fileRefs.beginDialogWrite(withExtension(result.filePath, ext), event.sender.id);
}));
handle('export:writeChunk', pathless((event, id, data) => _fileRefs.appendWrite(id, data, event.sender.id)));
handle('export:commitSave', pathless((event, id) => _fileRefs.commitWrite(id, event.sender.id)));
handle('export:abortSave', pathless((event, id) => _fileRefs.abortWrite(id, event.sender.id)));

// ── Listbridge marketplace publishing (ADR 0004, plan PB.4) ──
// `publish:*` channels, registered through `handle` (trusted sender) once the app is
// ready. Credentials: safeStorage-encrypted <userData>/listbridge-credentials.bin, never
// returned to the renderer. Platform adapters come from the portable core's ADAPTERS
// registry (src/listbridge/index.js), loaded once at startup.
async function _loadListbridgeAdapters() {
  try {
    const real = [...(await loadListbridgeCore()).ADAPTERS];
    // PB.15 dress rehearsal: a fake Cults may replace the real adapter (UNPACKAGED builds only; see fakePlatform.cjs).
    return fakePlatformAdapters({ isPackaged: app.isPackaged, env: process.env, realAdapters: real }) ?? real;
  } catch (err) {
    // Publishing unavailable is not a reason to keep the app from starting.
    console.error('Listbridge adapters failed to load:', err?.message ?? err);
    return [];
  }
}
// ── Launch requests: argv → validated → opaque tokens → queue/push to the window ──
// Paths never leave main: the renderer gets only {kind, ref, name} + basename-only errors.
function _launchPrimaryWindow() {
  return BrowserWindow.getAllWindows().find(w => !w.isDestroyed()) ?? null;
}
async function _processLaunch(argv, cwd) {
  const fsp = require('node:fs/promises');
  const win = _launchPrimaryWindow();
  const queue = win ? _launchQueues.get(win.webContents) : null;
  if (!win || !queue) return;
  const parsed = parseLaunchArgv(argv, { isPackaged: app.isPackaged });
  if (!parsed.opens.length && !parsed.library && !parsed.ignored.some(a => !a.startsWith('-'))) return;
  const batch = await buildLaunchBatch(parsed, {
    id: queue.nextId(),
    validate: (raw, kind) => validateLaunchPath(raw, {
      kind, cwd, realpath: p => fsp.realpath(p), stat: p => fsp.stat(p),
    }),
    registerFile: (p, name, opts) => _fileRefs.registerFile(p, name, opts),
    registerMount: (p, name) => _fileRefs.registerMount(p, name),
  });
  if (win.isDestroyed()) return;
  const push = queue.enqueue(batch);
  if (push) win.webContents.send('launch:requests', push);
}
function _handleLaunch(argv, cwd) {
  if (!_launchServiceUp) { _deferredLaunches.push({ argv, cwd }); return; }
  _processLaunch(argv, cwd).catch(err => console.error('launch request failed:', err?.message ?? err));
}
// Renderer marks itself ready by pulling after bootstrap; the reply is every queued
// batch merged into one (or null). Later batches arrive via 'launch:requests'.
handle('launch:pull', event => _launchQueues.get(event.sender)?.pull() ?? null);

app.on('second-instance', (_event, argv, workingDirectory) => {
  // A --job client talks to the pipe, not to the window: never raise or retarget the running app for it.
  if (parseLaunchArgv(argv, { isPackaged: app.isPackaged }).job) return;
  const win = _launchPrimaryWindow();
  if (win) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
  _handleLaunch(argv, workingDirectory);
});

// ── Automation API (API.5, ADR 0005) ──
// ApiServer (named pipe, session token) forwards every authenticated request here; main sends
// it to the renderer ('api:request') and resolves it when the renderer answers 'api:response'.
// The renderer never sees a path (ApiServer rewrites them to opaque tokens first). Enabled by
// default; the Preferences toggle persists KV key 'api_enabled' (absent = enabled, false = off).
const API_KV_KEY = 'api_enabled';
const API_MAX_NOTIFY_BYTES = 64 * 1024;
const API_PENDING_MAX_MS = 10 * 60 * 1000 + 30000;   // ApiServer times out at 10 min; this only reaps
let _apiServer = null;
let _apiEnabled = true;
let _apiChain = Promise.resolve();                    // serialises start/stop
let _apiSeq = 0;
const _apiPending = new Map();                        // id -> {resolve, reject, sender, timer}

function _failApiRequests(message) {
  for (const [id, p] of _apiPending) {
    clearTimeout(p.timer);
    _apiPending.delete(id);
    p.reject(makeApiError('E_INTERNAL', message));
  }
}

function _apiDispatch(method, params) {
  const win = _launchPrimaryWindow();
  if (!win || win.webContents.isDestroyed()) return Promise.reject(makeApiError('E_BUSY', 'no window is open'));
  if (win.webContents.isLoading()) return Promise.reject(makeApiError('E_BUSY', 'the app is still loading'));
  // The renderer's ApiBridge subscribes during bootstrap, right after LaunchRequests pulls
  // its queue (launch:pull) — until then a request would sit unanswered: say "starting".
  if (!_launchQueues.get(win.webContents)?.isReady()) return Promise.reject(makeApiError('E_BUSY', 'the app is still starting'));
  return new Promise((resolve, reject) => {
    const id = 'r' + (++_apiSeq);
    const timer = setTimeout(() => {
      if (_apiPending.delete(id)) reject(makeApiError('E_TIMEOUT', method + ': timed out'));
    }, API_PENDING_MAX_MS);
    timer.unref();
    _apiPending.set(id, { resolve, reject, sender: win.webContents, timer });
    try { win.webContents.send('api:request', { id, method, params }); } catch {
      clearTimeout(timer);
      _apiPending.delete(id);
      reject(makeApiError('E_INTERNAL', 'could not reach the app'));
    }
  });
}

function _createApiServer() {
  const os = require('node:os');
  let username = 'user';
  try { username = os.userInfo().username || username; } catch { /* keep default */ }
  return createApiServer({
    net: require('node:net'),
    fs: require('node:fs/promises'),
    crypto: require('node:crypto'),
    dispatch: _apiDispatch,
    registerFile: (p, name, opts) => _fileRefs.registerFile(p, name, opts),
    registerMount: (p, name) => _fileRefs.registerMount(p, name),
    userDataDir: app.getPath('userData'),
    username,
    mainInfo: () => ({ appVersion: app.getVersion(), platform: process.platform, pid: process.pid }),
  });
}

function _apiStatus() {
  return { enabled: _apiEnabled, running: !!_apiServer };
}

function _apiApply(enabled) {
  const run = _apiChain.then(async () => {
    if (enabled && !_apiServer) {
      const server = _createApiServer();
      await server.start();
      _apiServer = server;
    } else if (!enabled && _apiServer) {
      const server = _apiServer;
      _apiServer = null;
      _failApiRequests('api stopped');
      await server.stop();
    }
  });
  _apiChain = run.catch(() => {});
  return run;
}

// The session file holds the pipe token and must not outlive the process. Sync on purpose:
// will-quit / exit handlers cannot await. A hard app.exit() skips will-quit, so 'exit' too.
function _removeApiSessionFile() {
  const server = _apiServer;
  if (!server) return;
  try { require('node:fs').unlinkSync(server.sessionFile); } catch { /* already gone */ }
}
process.on('exit', _removeApiSessionFile);

handle('api:response', (event, res) => {
  const id = res && typeof res === 'object' && typeof res.id === 'string' ? res.id : null;
  const p = id ? _apiPending.get(id) : null;
  if (!p || p.sender !== event.sender) return false;   // unknown / stale / foreign id: ignore
  clearTimeout(p.timer);
  _apiPending.delete(id);
  if (res.error !== undefined && res.error !== null) p.reject(res.error);
  else p.resolve(res.result);
  return true;
});
handle('api:notify', (_e, evt) => {
  if (!_apiServer || !evt || typeof evt !== 'object') return 0;
  let size = Infinity;
  try { size = JSON.stringify(evt).length; } catch { /* unserialisable */ }
  if (size > API_MAX_NOTIFY_BYTES) return 0;
  return _apiServer.notify(evt);
});
handle('api:setEnabled', async (_e, enabled) => {
  if (typeof enabled !== 'boolean') throw new Error('api:setEnabled expects a boolean');
  _apiEnabled = enabled;
  await _kv.set(API_KV_KEY, enabled);
  try { await _apiApply(enabled); } catch (err) {
    console.error('api server toggle failed:', err?.message ?? err);
  }
  return _apiStatus();
});
handle('api:status', () => _apiStatus());

// -- Batch jobs (API.7) --
let _jobRunner = null;
let _jobFinished = false;
async function _waitRendererReady() {
  while (!_jobFinished) {
    const win = _launchPrimaryWindow();
    if (win && !win.webContents.isDestroyed() && !win.webContents.isLoading()
        && _launchQueues.get(win.webContents)?.isReady()) return true;
    await new Promise(r => setTimeout(r, 100));
  }
  return false;
}
function _runJob(mode) {
  const fsp = require('node:fs/promises');
  const cwd = process.cwd();
  _jobRunner = createJobRunner({
    fs: fsp,
    net: require('node:net'),
    dispatchLocal: (method, params) => _apiServer.dispatchLocal(method, params),
    localAvailable: () => !!_apiServer,
    readSession: () => readApiSession(fsp, app.getPath('userData')),
    validatePath: (raw, kind) => validateLaunchPath(raw, {
      kind, cwd, maxBytes: JOB_LIMITS.maxJobBytes,
      realpath: p => fsp.realpath(p), stat: p => fsp.stat(p), access: (p, m) => fsp.access(p, m),
    }),
    clock: { now: () => Date.now(), setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: t => clearTimeout(t) },
    waitReady: _waitRendererReady,
    methodNames: API_METHOD_NAMES,
    stderr: line => console.error(line),
  });
  return _jobRunner.run({ job: _launchArgs.job, result: _launchArgs.result, mode })
    .then(({ exitCode }) => exitCode, err => { console.error('--job failed:', err?.message ?? err); return 2; })
    .then(code => { _jobFinished = true; app.exit(code); });
}
// Lock lost + job: this process is only a pipe client of the running app (no window, no quit()).
if (!_gotLock && _jobMode && !_jobNoResult) app.whenReady().then(() => _runJob('remote'));

let _listbridge = null;
let _tunnelsClosed = false;

// Temporary-link hosts (cloudflared quick tunnels) must not outlive the app: close them
// before quitting (bounded wait), then let the quit continue.
app.on('will-quit', event => {
  _removeApiSessionFile();
  if (_apiServer) _apiServer.stop().catch(() => {});
  if (_tunnelsClosed || !_listbridge) return;
  event.preventDefault();
  _tunnelsClosed = true;
  Promise.race([_listbridge.closeAll(), new Promise(r => setTimeout(r, 5000))])
    .catch(() => {})
    .finally(() => app.quit());
});

ipcMain.on('app:close-response', (event, result) => {
  if (!isTrustedSender(event, ENTRY_URL)) return;
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;
  const approved = result?.action === 'discard'
    || result?.action === 'save' && result?.saved === true;
  if (!approved) { _publishQuitAck.delete(win); return; }
  // Discard = quit for real: cancel any running publish first (bounded wait), then close.
  Promise.race([_listbridge?.cancelAll() ?? null, new Promise(r => setTimeout(r, 4000))])
    .catch(() => {})
    .finally(() => {
      if (win.isDestroyed()) return;
      _approvedClose.add(win);
      win.close();
    });
});

// Every webContents (the window, and anything a bug might create) gets the
// navigation / window-open / webview guards (task 6.1).
app.on('web-contents-created', (_event, contents) => {
  guardWebContents(contents, ENTRY_URL, {
    onBlocked: (kind, url) => console.error(`blocked ${kind}${url ? `: ${url}` : ''}`),
  });
  // A streamed export save left open by a crashed renderer or a closed window
  // would keep its temp file (and an open handle) beside the user's file.
  const owner = contents.id;
  const abortSaves = () => { _fileRefs?.abortAllFor(owner).catch(() => {}); };
  contents.on('render-process-gone', abortSaves);
  contents.once('destroyed', abortSaves);
});

if (_gotLock) app.whenReady().then(async () => {
  denyAllPermissions(session.defaultSession);
  _kv = createKvStore(path.join(app.getPath('userData'), 'mixo-kv.json'));
  _fileRefs = createOpaqueFileRegistry({
    store: createKvStore(path.join(app.getPath('userData'), 'mixo-refs.json')),
  });
  _listbridge = registerListbridgeIpc(handle, {
    userDataDir: app.getPath('userData'), safeStorage, adapters: await _loadListbridgeAdapters(),
  });
  createWindow();
  // API server: after the window exists. Absent flag = enabled; only the explicit boolean false
  // disables. Other smoke modes keep their exact behaviour (no pipe); MIXO_SMOKE=api requires it.
  _apiEnabled = (await _kv.get(API_KV_KEY).catch(() => null)) !== false;
  if (_apiEnabled && (!process.env.MIXO_SMOKE || SMOKE_API)) {
    try {
      await _apiApply(true);
      if (SMOKE_API) console.log('MIXO_SMOKE: api started');
    } catch (err) {
      console.error('api server failed to start:', err?.message ?? err);
      if (SMOKE_API) app.exit(7);
    }
  }
  _launchServiceUp = true;
  _handleLaunch(process.argv, process.cwd());
  for (const { argv, cwd } of _deferredLaunches.splice(0)) _handleLaunch(argv, cwd);
  if (_jobMode) _runJob('local');
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
