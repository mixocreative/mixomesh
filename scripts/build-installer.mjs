#!/usr/bin/env node
// One-click clean Windows installer build.
//   node scripts/build-installer.mjs [--skip-tests] [--skip-smoke] [--keep-build]
//   (or double-click build-installer.cmd at the repo root)
//
// 1 wipe release/ + dist/   2 warn on uncommitted changes   3 npm test   4 npm run build,
// test:electron (needs dist/), electron-builder --win, smoke:packaged (needs release/win-unpacked)
// 5 copy ONLY the installer to installers/MIXOMESH-Setup-<v>.exe (+ .sha256)
// 6 wipe release/ + dist/ again (unless --keep-build). The smokes open a window, so they need a
// desktop session; --skip-smoke bypasses them (the installer is then NOT release-verified).
// Exit 0 = ok; non-zero names the failing step.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pruneOldInstallers } from './clean.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const skipTests = args.has('--skip-tests');
const skipSmoke = args.has('--skip-smoke');
const keepBuild = args.has('--keep-build');
let step = 'startup';

function die(msg) {
  console.error(`\nBUILD FAILED at step "${step}": ${msg}`);
  process.exit(1);
}
function begin(name) { step = name; console.log(`\n=== ${name} ===`); }
function run(cmd, cmdArgs, opts = {}) {
  const r = spawnSync(cmd, cmdArgs, { cwd: ROOT, stdio: 'inherit', shell: true, ...opts });
  if (r.status !== 0) die(`\`${cmd} ${cmdArgs.join(' ')}\` exited with ${r.status ?? r.signal}`);
}
function wipe() {
  for (const d of ['release', 'dist']) fs.rmSync(path.join(ROOT, d), { recursive: true, force: true });
}

// Guard: only ever delete generated folders of THIS repo.
begin('check repo root');
if (path.resolve(process.cwd()) !== ROOT) process.chdir(ROOT);
let pkg;
try { pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')); } catch { die('package.json not found next to scripts/'); }
if (pkg.name !== 'mixomesh') die(`package.json name is "${pkg.name}", expected "mixomesh"; refusing to delete anything`);
console.log(`MIXOMESH ${pkg.version} in ${ROOT}`);

begin('wipe release/ and dist/');
wipe();

begin('git status');
{
  const head = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' });
  const st = spawnSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' });
  if (head.status === 0) console.log(`HEAD: ${head.stdout.trim()}`);
  else console.warn('warning: git HEAD unavailable');
  if (st.status === 0 && st.stdout.trim()) {
    console.warn(`WARNING: uncommitted changes (${st.stdout.trim().split(/\r?\n/).length} paths) — the installer will contain them:`);
    console.warn(st.stdout.trimEnd().split(/\r?\n/).slice(0, 15).join('\n'));
  } else if (st.status === 0) console.log('working tree clean');
}

if (skipTests) { begin('npm test'); console.log('skipped (--skip-tests)'); } else { begin('npm test'); run('npm', ['test']); }

begin('npm run build'); run('npm', ['run', 'build']);
if (skipSmoke) { begin('npm run test:electron'); console.log('skipped (--skip-smoke)'); }
else { begin('npm run test:electron'); run('npm', ['run', 'test:electron']); }
begin('electron-builder --win'); run('npx', ['electron-builder', '--win']);
if (skipSmoke) { begin('npm run smoke:packaged'); console.log('skipped (--skip-smoke)'); }
else { begin('npm run smoke:packaged'); run('npm', ['run', 'smoke:packaged']); }

begin('collect installer');
const name = `MIXOMESH-Setup-${pkg.version}.exe`;
const src = path.join(ROOT, 'release', name);
if (!fs.existsSync(src)) die(`${path.join('release', name)} was not produced (check artifactName in electron-builder.yml)`);
const outDir = path.join(ROOT, 'installers');
fs.mkdirSync(outDir, { recursive: true });
const dest = path.join(outDir, name);
fs.copyFileSync(src, dest);
const hash = createHash('sha256');
hash.update(fs.readFileSync(dest));
const sha = hash.digest('hex');
fs.writeFileSync(`${dest}.sha256`, `${sha} *${name}\n`);
const pruned = pruneOldInstallers(outDir, name);
if (pruned.length) console.log(`removed older installers: ${pruned.join(', ')}`);
const mb = (fs.statSync(dest).size / 1048576).toFixed(1);

if (keepBuild) { begin('cleanup'); console.log('kept release/ and dist/ (--keep-build)'); }
else { begin('wipe release/ and dist/'); wipe(); }

console.log(`\nOK  ${path.relative(ROOT, dest)}  ${mb} MB\nSHA-256 ${sha}`);
