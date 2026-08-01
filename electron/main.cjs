// Electron main process (ADR 0001 Phase 2). Loads the built web app (or the Vite
// dev server via MIXO_DEV_URL) in a hardened BrowserWindow, and backs the
// DesktopStorageAdapter with real Node fs over IPC.
//
// Run (after `npm i -D electron`): `MIXO_DEV_URL=http://localhost:5173 npx electron electron/main.cjs`
// (dev, with `npm run dev` running) or `npm run build` then `npx electron electron/main.cjs` (built).
// See docs/handoff/electron.md.

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');

const DEV_URL = process.env.MIXO_DEV_URL || '';
let _kvPath = '';

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
}

// ── KV persistence (JSON file in userData) — backs DesktopStorageAdapter.kv* ──
async function _readKv() {
  try { return JSON.parse(await fs.readFile(_kvPath, 'utf8')); } catch { return {}; }
}
async function _writeKv(obj) { await fs.writeFile(_kvPath, JSON.stringify(obj)); }

ipcMain.handle('kv:set', async (_e, key, value) => { const o = await _readKv(); o[key] = value; await _writeKv(o); });
ipcMain.handle('kv:get', async (_e, key) => { const o = await _readKv(); return key in o ? o[key] : null; });
ipcMain.handle('kv:delete', async (_e, key) => { const o = await _readKv(); delete o[key]; await _writeKv(o); });
ipcMain.handle('kv:keys', async () => Object.keys(await _readKv()));

// ── Real filesystem (path refs) ──
ipcMain.handle('fs:readFile', async (_e, p) => {
  const b = await fs.readFile(p);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);   // ArrayBuffer
});
ipcMain.handle('fs:writeFile', async (_e, p, data) => fs.writeFile(p, Buffer.from(data)));
ipcMain.handle('dialog:open', async (_e, opts) => dialog.showOpenDialog(opts ?? {}));
ipcMain.handle('dialog:save', async (_e, opts) => dialog.showSaveDialog(opts ?? {}));

app.whenReady().then(() => {
  _kvPath = path.join(app.getPath('userData'), 'mixo-kv.json');
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
