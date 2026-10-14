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
// installed. Opens a window briefly (three times).
// Then MIXO_SMOKE=launch (LI.6): first instance gets `--open x.stl --open y.glb --library <dir>`
// plus one bad `--open`; main's probe waits for 2 objects + the Library listing + a
// basename-only error toast, spawns a SECOND instance on the same temp userData (single-
// instance lock -> exit 0, argv forwarded) and waits for the object count to grow by one.

import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { EOL, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

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

function run(mode, label, { args = [], env = {}, timeoutMs = 60000 } = {}) {
  return new Promise(resolve => {
    const child = spawn(bin, ['electron/main.cjs', ...args], {
      env: { ...process.env, MIXO_SMOKE: mode, ELECTRON_DISABLE_SECURITY_WARNINGS: '1', ...env },
      stdio: 'inherit',
      shell: isWin,
    });
    const timer = setTimeout(() => { child.kill(); console.error(`FAIL electron smoke (${label}): timeout`); resolve(false); }, timeoutMs);
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) { console.log(`PASS electron desktop smoke — ${label}`); resolve(true); return; }
      console.error(`FAIL electron smoke (${label}): exit ${code}`);
      resolve(false);
    });
    child.on('error', (err) => { clearTimeout(timer); console.error(`FAIL electron smoke (${label}):`, err.message); resolve(false); });
  });
}

// Launch smoke fixtures: all inside one temp root (also main's leak token).
function runLaunch() {
  const root = mkdtempSync(join(tmpdir(), 'mixo-smoke-'));
  const fx = resolve('tests', 'fixtures');
  const stl = join(root, 'wedge.stl');
  writeFileSync(stl, [
    'solid wedge',
    ...[[[0, 0, 0], [10, 0, 0], [0, 10, 0]], [[0, 0, 0], [0, 0, 10], [10, 0, 0]],
      [[0, 0, 0], [0, 10, 0], [0, 0, 10]], [[10, 0, 0], [0, 0, 10], [0, 10, 0]]]
      .map(t => ['facet normal 0 0 0', ' outer loop', ...t.map(v => `  vertex ${v.join(' ')}`), ' endloop', 'endfacet'].join(EOL)),
    'endsolid wedge', '',
  ].join(EOL));
  const glb = join(root, 'tetra.glb');
  copyFileSync(join(fx, 'open-tetra.glb'), glb);
  const second = join(root, 'second.glb');
  copyFileSync(join(fx, 'textured-quad.glb'), second);
  const lib = join(root, 'launch-lib');
  mkdirSync(lib);
  copyFileSync(join(fx, 'open-tetra.glb'), join(lib, 'a.glb'));
  copyFileSync(stl, join(lib, 'b.stl'));
  return run('launch', 'launch args import + library, second instance forwards, bad arg is basename-only', {
    args: ['--open', stl, '--open', glb, '--open', join(root, 'missing.glb'), '--library', lib],
    env: {
      MIXO_SMOKE_USERDATA: join(root, 'userData'), MIXO_SMOKE_SECOND: second,
      MIXO_SMOKE_LIBNAME: 'launch-lib', MIXO_SMOKE_BADNAME: 'missing.glb',
    },
    timeoutMs: 90000,
  }).finally(() => { try { rmSync(root, { recursive: true, force: true }); } catch { /* temp */ } });
}

const booted = await run('1', 'built app boots in the Electron shell');
const saved = booted && await run('save', 'Save As writes a .mixo through the adapter, no OS path in KV');
const launched = saved && await runLaunch();
process.exit(booted && saved && launched ? 0 : 1);
