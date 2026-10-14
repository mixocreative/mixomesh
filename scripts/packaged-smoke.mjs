#!/usr/bin/env node
// Packaged-app smoke (plan PB.14). After `npm run dist`, launches the UNPACKED build with
// MIXO_SMOKE=1: main.cjs then runs the same security probe as `npm run test:electron`, from
// inside app.asar, and exits 0 only when
//   * the page booted under the hardened shell, and
//   * publish:describe lists the cults3d platform AND the default `tunnel` file host --
//     which proves defaultLoadCore()'s import() of src/listbridge/index.js (ESM) resolved
//     from app.asar (the one packaging risk).
// Usage: node scripts/packaged-smoke.mjs [path/to/MIXOMESH.exe]
//   default: release/win-unpacked/MIXOMESH.exe
// Needs a real desktop session (it opens a window briefly). Owner: run once on a clean
// Windows user profile; SmartScreen only appears for the installer, not this unpacked exe.

import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const exe = resolve(process.argv[2] ?? join('release', 'win-unpacked', 'MIXOMESH.exe'));
if (!existsSync(exe)) {
  console.error(`packaged smoke: ${exe} not found. Run \`npm run build && npm run dist\` first.`);
  process.exit(1);
}
const asar = join(dirname(exe), 'resources', 'app.asar');
const cloudflared = join(dirname(exe), 'resources', 'listbridge', 'cloudflared.exe');
console.log(`packaged smoke: ${exe}`);
console.log(`  app.asar present: ${existsSync(asar)}${existsSync(asar) ? ` (${(statSync(asar).size / 1048576).toFixed(1)} MB)` : ''}`);
console.log(`  bundled cloudflared: ${existsSync(cloudflared)}`);

const out = [];
const child = spawn(exe, [], { env: { ...process.env, MIXO_SMOKE: '1', ELECTRON_DISABLE_SECURITY_WARNINGS: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.on('data', c => out.push(String(c)));
child.stderr.on('data', c => out.push(String(c)));
const timer = setTimeout(() => { child.kill(); console.error('FAIL packaged smoke: timeout'); process.exit(1); }, 90000);
child.on('error', err => { clearTimeout(timer); console.error('FAIL packaged smoke:', err.message); process.exit(1); });
child.on('exit', code => {
  clearTimeout(timer);
  const log = out.join('');
  const line = log.split(/\r?\n/).find(l => l.includes('MIXO_SMOKE: security')) ?? '';
  if (line) console.log(line);
  if (code === 0) {
    console.log('PASS packaged smoke: booted from app.asar; publish:describe lists cults3d + tunnel');
    process.exit(0);
  }
  console.error(`FAIL packaged smoke: exit ${code}${line ? '' : ' (no probe line captured; exit code is authoritative)'}\n${log.slice(-1500)}`);
  process.exit(1);
});
