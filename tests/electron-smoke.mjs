// Desktop smoke: launch the built app in the Electron shell (MIXO_SMOKE makes
// main.cjs quit once the window loads) and assert it boots without crashing —
// i.e. the desktop path (preload → window.electronAPI → DesktopStorageAdapter)
// loads. Needs `npm run build` first + electron installed. Opens a window briefly.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
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

const child = spawn(bin, ['electron/main.cjs'], {
  env: { ...process.env, MIXO_SMOKE: '1', ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
  stdio: 'inherit',
  shell: isWin,
});
const timer = setTimeout(() => { child.kill(); console.error('FAIL electron smoke: timeout'); process.exit(2); }, 45000);
child.on('exit', (code) => {
  clearTimeout(timer);
  if (code === 0) { console.log('PASS electron desktop smoke — built app boots in the Electron shell'); process.exit(0); }
  console.error(`FAIL electron smoke: exit ${code}`);
  process.exit(1);
});
child.on('error', (err) => { clearTimeout(timer); console.error('FAIL electron smoke:', err.message); process.exit(1); });
