// Desktop smoke: launch the built app in the Electron shell (MIXO_SMOKE makes
// main.cjs quit once the window loads) and assert it boots without crashing —
// i.e. the desktop path (preload → window.electronAPI → DesktopStorageAdapter)
// loads under the hardened shell (task 6.1: sandbox + contextIsolation + CSP);
// mode 1 also runs main's security probe — no Node in the page, bridge present,
// window.open / foreign navigation refused, and the CSP still lets the vendored
// Manifold WASM (+ Embind eval), a bundled module worker and a blob: worker run
// from file://. Any CSP violation logged by the page fails either mode (exit 5).
// Then MIXO_SMOKE=save (task 4.4): isolated temp userData, Ctrl+Shift+S
// through the routed adapter (save dialog answered with a temp file by main),
// the written .mixo is checked, and the renderer-readable KV must hold a stable
// `file_` recents key and no OS path. Needs `npm run build` first + electron
// installed. Opens a window briefly (twice).

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

if (!existsSync('dist/index.html')) {
  console.error('electron smoke: run `npm run build` first (no dist/index.html)');
  process.exit(1);
}
const isWin = process.platform === 'win32';
const bin = join('node_modules', '.bin', isWin ? 'electron.cmd' : 'electron');
if (!existsSync(bin)) {
  console.error('electron smoke: electron not installed (npm i)');
  process.exit(1);
}

const mainSource = readFileSync('electron/main.cjs', 'utf8');
if (!mainSource.includes("'render-process-gone'") || !mainSource.includes("'will-prevent-unload'")) {
  console.error('electron smoke: main.cjs must handle render-process-gone and will-prevent-unload');
  process.exit(1);
}
const preloadSource = readFileSync('electron/preload.cjs', 'utf8');
if (!mainSource.includes("ipcMain.on('app:close-response'")
    || !mainSource.includes("win.webContents.send('app:close-requested'")
    || !preloadSource.includes('onCloseRequested')
    || !preloadSource.includes('respondToClose')) {
  console.error('electron smoke: save/discard/cancel close bridge is incomplete');
  process.exit(1);
}

function run(mode, label) {
  return new Promise(resolve => {
    const child = spawn(bin, ['electron/main.cjs'], {
      env: { ...process.env, MIXO_SMOKE: mode, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
      stdio: 'inherit',
      shell: isWin,
    });
    const timer = setTimeout(() => { child.kill(); console.error(`FAIL electron smoke (${label}): timeout`); resolve(false); }, 60000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) { console.log(`PASS electron desktop smoke — ${label}`); resolve(true); return; }
      console.error(`FAIL electron smoke (${label}): exit ${code}`);
      resolve(false);
    });
    child.on('error', (err) => { clearTimeout(timer); console.error(`FAIL electron smoke (${label}):`, err.message); resolve(false); });
  });
}

const booted = await run('1', 'built app boots in the Electron shell');
const saved = booted && await run('save', 'Save As writes a .mixo through the adapter, no OS path in KV');
process.exit(booted && saved ? 0 : 1);
