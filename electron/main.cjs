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
const _fileRefs = createOpaqueFileRegistry();
const _approvedClose = new WeakSet();

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
    if (_approvedClose.has(win) || process.env.MIXO_SMOKE) return;
    event.preventDefault();
    win.webContents.send('app:close-requested');
  });

  // Headless smoke (MIXO_SMOKE=1): verify the built app boots in the desktop shell,
  // then quit — so CI/dev can assert the desktop path loads without a lingering window.
  if (process.env.MIXO_SMOKE) {
    win.webContents.once('did-finish-load', () => { console.log('MIXO_SMOKE: loaded'); setTimeout(() => app.exit(0), 400); });
    win.webContents.once('did-fail-load', (_e, code, desc) => { console.error('MIXO_SMOKE: fail', code, desc); app.exit(1); });
    setTimeout(() => { console.error('MIXO_SMOKE: timeout'); app.exit(2); }, 20000);
  }
}

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
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
