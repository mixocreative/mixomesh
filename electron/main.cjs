// Electron main process (ADR 0001 Phase 2). Loads the built web app (or the Vite
// dev server via MIXO_DEV_URL) in a hardened BrowserWindow, and backs the
// DesktopStorageAdapter with real Node fs over IPC.
//
// Run (after `npm i -D electron`): `MIXO_DEV_URL=http://localhost:5173 npx electron electron/main.cjs`
// (dev, with `npm run dev` running) or `npm run build` then `npx electron electron/main.cjs` (built).
// See docs/handoff/electron.md.

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('node:path');
const { createOpaqueFileRegistry } = require('./OpaqueFileRegistry.cjs');
const { createKvStore } = require('./KvStore.cjs');

const DEV_URL = process.env.MIXO_DEV_URL || '';
let _kv = null;
// Opaque file registry; its persisted ref store (`mixo-refs.json`, absolute paths)
// is a SEPARATE file from the renderer-readable KV so kv:get/kv:keys can never
// expose an OS path. Created on app ready (needs userData).
let _fileRefs = null;
const _approvedClose = new WeakSet();
// MIXO_SMOKE bypasses the unload/close/crash guards ONLY in unpackaged builds.
const smokeBypass = () => !!process.env.MIXO_SMOKE && !app.isPackaged;

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    backgroundColor: '#efe7d8',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,   // hardening: renderer can't touch Node directly
      nodeIntegration: false,
      sandbox: false,
    },
  });
  if (DEV_URL) win.loadURL(DEV_URL);
  else win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));

  win.on('close', event => {
    if (_approvedClose.has(win) || smokeBypass()) return;
    event.preventDefault();
    win.webContents.send('app:close-requested');
  });

  // The renderer cancels `beforeunload` when the project is dirty (Ctrl+R, navigation).
  // Electron swallows that silently unless we answer will-prevent-unload ourselves.
  win.webContents.on('will-prevent-unload', event => {
    // ignore the prevention = leave. An approved close already went through the
    // renderer's save/discard dialog — don't ask twice.
    if (smokeBypass() || _approvedClose.has(win)) { event.preventDefault(); return; }
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      buttons: ['Leave', 'Stay'],
      defaultId: 1,
      cancelId: 1,
      title: 'Leave without saving?',
      message: 'Leave without saving?',
      detail: 'This project has unsaved changes that will be lost.',
    });
    if (choice === 0) event.preventDefault(); // preventDefault here = proceed with unload
  });

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

  // Headless smoke (MIXO_SMOKE=1): verify the built app boots in the desktop shell,
  // then quit — so CI/dev can assert the desktop path loads without a lingering window.
  if (process.env.MIXO_SMOKE) {
    win.webContents.once('did-finish-load', () => { console.log('MIXO_SMOKE: loaded'); setTimeout(() => app.exit(0), 400); });
    win.webContents.once('did-fail-load', (_e, code, desc) => { console.error('MIXO_SMOKE: fail', code, desc); app.exit(1); });
    setTimeout(() => { console.error('MIXO_SMOKE: timeout'); app.exit(2); }, 20000);
  }
}

// ── User-editable config files (materials.json) ──
// Lives OUTSIDE the app bundle so the user can edit it with any text editor:
// <userData>/config/<name>. Seeded from the shipped copy (dist/config in a
// packaged build, public/config in dev) the first time it is asked for. Only
// a fixed allowlist of names can be read — never an arbitrary path.
const USER_CONFIG_FILES = new Set(['materials.json']);
ipcMain.handle('config:read', async (_e, name) => {
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
ipcMain.handle('kv:set', (_e, key, value) => _kv.set(key, value));
ipcMain.handle('kv:get', (_e, key) => _kv.get(key));
ipcMain.handle('kv:delete', (_e, key) => _kv.delete(key));
ipcMain.handle('kv:keys', () => _kv.keys());

// ── Mounted asset directories (opaque renderer refs) ──
ipcMain.handle('dialog:mountDirectory', async () => {
  const result = await dialog.showOpenDialog({ properties: ['openDirectory'] });
  if (result.canceled || !result.filePaths[0]) return null;
  const absolutePath = result.filePaths[0];
  return _fileRefs.registerMount(absolutePath, path.basename(absolutePath));
});
ipcMain.handle('fs:listDirectoryRef', (_e, ref, parentPath) => _fileRefs.listDirectory(ref, parentPath));
ipcMain.handle('fs:readFileRef', (_e, ref) => _fileRefs.readFile(ref));

// ── Persisted asset refs (task 4.2) — stable keys in, opaque tokens / bytes out ──
// Every argument is type-checked here; the registry re-validates keys, files and
// relative paths (no escaping the folder). Absolute paths never leave main.
const _str = v => (typeof v === 'string' && v.length > 0 && v.length < 4096 ? v : null);
ipcMain.handle('refs:persist', (_e, ref) => {
  if (!_str(ref)) throw new Error('refs:persist expects an opaque ref');
  return _fileRefs.persistRef(ref);
});
ipcMain.handle('refs:restore', (_e, key) => (_str(key) ? _fileRefs.restoreRef(key) : null));
ipcMain.handle('refs:delete', (_e, key) => (_str(key) ? _fileRefs.deleteRef(key) : undefined));
ipcMain.handle('refs:read', (_e, key, relPath) => {
  if (!_str(key)) return null;
  return _fileRefs.readStoredFile(key, relPath == null ? null : _str(relPath) ?? '');
});
// Explicit, user-invoked only (Decision 3: load never scans). Progress is pushed
// back on 'refs:find-progress' tagged with the caller's request id.
ipcMain.handle('refs:findMoved', (event, requestId, args) => {
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

// ── Legacy project/export dialogs (path-based fs:readFile/writeFile IPC removed — no callers) ──
ipcMain.handle('dialog:open', async (_e, opts) => dialog.showOpenDialog(opts ?? {}));
ipcMain.handle('dialog:save', async (_e, opts) => dialog.showSaveDialog(opts ?? {}));
ipcMain.on('app:close-response', (event, result) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;
  const approved = result?.action === 'discard'
    || result?.action === 'save' && result?.saved === true;
  if (!approved) return;
  _approvedClose.add(win);
  win.close();
});

app.whenReady().then(() => {
  _kv = createKvStore(path.join(app.getPath('userData'), 'mixo-kv.json'));
  _fileRefs = createOpaqueFileRegistry({
    store: createKvStore(path.join(app.getPath('userData'), 'mixo-refs.json')),
  });
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
