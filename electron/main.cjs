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
  createOpaqueFileRegistry, sanitizeSuggestedName, exportDialogOptions, withExtension,
} = require('./OpaqueFileRegistry.cjs');
const { createKvStore } = require('./KvStore.cjs');
const { registerListbridgeIpc, loadListbridgeCore } = require('./listbridge/index.cjs');
const { fakePlatformAdapters } = require('./listbridge/fakePlatform.cjs');
const {
  SECURE_WEB_PREFERENCES, appEntryUrl, guardWebContents, denyAllPermissions, isTrustedSender,
} = require('./WindowSecurity.cjs');

const DEV_URL = process.env.MIXO_DEV_URL || '';
const INDEX_PATH = path.join(__dirname, '..', 'dist', 'index.html');
// The ONE document the renderer may show (task 6.1): navigation, window.open
// and IPC senders are all checked against it.
const ENTRY_URL = appEntryUrl({ devUrl: DEV_URL, indexPath: INDEX_PATH });
// MIXO_SMOKE=save (unpackaged only): isolated temp userData, the project save
// dialog is answered with a temp file, and the smoke drives Ctrl+Shift+S then
// checks the written .mixo + that the renderer-readable KV holds no OS path.
const SMOKE_SAVE = process.env.MIXO_SMOKE === 'save';
const PROJECT_FILTERS = [{ name: 'MIXOMESH project', extensions: ['mixo'] }];
let _smokeDir = null;
if (SMOKE_SAVE && !app.isPackaged) {
  const os = require('node:os');
  const fsSync = require('node:fs');
  _smokeDir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'mixo-smoke-'));
  app.setPath('userData', path.join(_smokeDir, 'userData'));
}
let _kv = null;
// Opaque file registry; its persisted ref store (`mixo-refs.json`, absolute paths)
// is a SEPARATE file from the renderer-readable KV so kv:get/kv:keys can never
// expose an OS path. Created on app ready (needs userData).
let _fileRefs = null;
const _approvedClose = new WeakSet();
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
    // Hardened (task 6.1): contextIsolation + no nodeIntegration + sandbox.
    webPreferences: { ...SECURE_WEB_PREFERENCES, preload: path.join(__dirname, 'preload.cjs') },
  });
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
  if (_smokeDir) {
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
  const workerFile = require('node:fs').readdirSync(assets).find(f => /^MeshValidate\.worker-.*\.js$/.test(f)) ?? '';
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
    return r;
  })()`;
  win.webContents.executeJavaScript(probe).then(async r => {
    const before = win.webContents.getURL();
    await win.webContents.executeJavaScript(`location.href = 'https://example.com/'; true`).catch(() => {});
    await new Promise(res => setTimeout(res, 800));
    r.navigationDenied = win.webContents.getURL() === before;
    const ok = r.booted && r.noNode && r.bridge && r.csp && r.popupDenied && r.manifold === true
      && r.moduleWorker && r.blobWorker && r.navigationDenied && r.listbridge === true;
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
handle('export:save', async (event, opts, data) => {
  const { ext, defaultName, filters } = exportDialogOptions(opts); // throws on a non-whitelisted type
  const result = await dialog.showSaveDialog(_winOf(event), { defaultPath: defaultName, filters });
  if (result.canceled || !result.filePath) return false;
  await _fileRefs.writeDialogTarget(withExtension(result.filePath, ext), data);
  return true;
});

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
let _listbridge = null;
let _tunnelsClosed = false;

// Temporary-link hosts (cloudflared quick tunnels) must not outlive the app: close them
// before quitting (bounded wait), then let the quit continue.
app.on('will-quit', event => {
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
});

app.whenReady().then(async () => {
  denyAllPermissions(session.defaultSession);
  _kv = createKvStore(path.join(app.getPath('userData'), 'mixo-kv.json'));
  _fileRefs = createOpaqueFileRegistry({
    store: createKvStore(path.join(app.getPath('userData'), 'mixo-refs.json')),
  });
  _listbridge = registerListbridgeIpc(handle, {
    userDataDir: app.getPath('userData'), safeStorage, adapters: await _loadListbridgeAdapters(),
  });
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
