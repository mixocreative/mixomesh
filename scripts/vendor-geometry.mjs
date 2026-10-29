// Vendor (or verify) the mixo geometry engine under public/vendor/mixo-geometry/.
//
// The engine (Rust compiled to WebAssembly) is built in the mixosupports repo
// and reused here AS BUILT: mixomesh never edits it (docs/support-generation-port.md
// section 8). This script copies `crates/geometry-wasm/pkg-browser` from a
// mixosupports checkout, records where it came from in SOURCE.json (commit,
// engine version, SHA-256 per file) and writes VERSION. The runtime refuses an
// engine whose engine_version() differs from HOST_GEOMETRY_VERSION
// (vendor/mixo-geocore/host/geometryVersion.js); bump both together on upgrade.
//
//   node scripts/vendor-geometry.mjs [--from <mixosupports dir>]   copy, record, verify
//   node scripts/vendor-geometry.mjs --from <mixo-geocore dir> --packages-only   copy only vendor/mixo-geocore/{host,editing}
//   node scripts/vendor-geometry.mjs --check                       verify the committed files (no source repo)
//
// Rebuild the engine in mixosupports first (`npm run wasm:build` there): its
// pkg-browser is git-ignored and can be older than its last engine commit.

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT_DIR = join(ROOT, 'public', 'vendor', 'mixo-geometry');
const PKG = join('crates', 'geometry-wasm', 'pkg-browser');
const ENGINE_SRC = join('crates', 'geometry-core', 'src');
const PACKAGES = ['host', 'editing'];
const PACKAGES_OUT = join(ROOT, 'vendor', 'mixo-geocore');
const FILES = ['mixo_geometry_wasm.js', 'mixo_geometry_wasm_bg.wasm', 'mixo_geometry_wasm.d.ts'];

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
// Text files are LF from wasm-bindgen; a Windows checkout with core.autocrlf turns them CRLF.
const asBuilt = (name, bytes) => (name.endsWith('.wasm') ? bytes
  : Buffer.from(bytes.toString('latin1').replace(/\r\n/g, '\n'), 'latin1'));

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();

/** engine_version() of the glue + wasm in `dir`, loaded the way a worker would (no fetch). */
async function engineVersion(dir) {
  const glue = await import(`${pathToFileURL(join(dir, FILES[0])).href}?v=${Date.now()}`);
  glue.initSync({ module: readFileSync(join(dir, FILES[1])) });
  return glue.engine_version();
}

/** Package sources worth vendoring: no tests, no test fixtures. */
const isVendored = name => /\.(ts|js)$/.test(name) && !/\.test\.ts$/.test(name) && name !== 'uiFixture.ts';

function copyTree(from, to) {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    if (entry.isDirectory()) copyTree(join(from, entry.name), join(to, entry.name));
    else if (isVendored(entry.name)) writeFileSync(join(to, entry.name), asBuilt(entry.name, readFileSync(join(from, entry.name))));
  }
}

/** vendor/mixo-geocore/{host,editing} from a committed checkout (PE.4 adds release pinning), LF line endings. */
function copyPackages(source) {
  if (git(source, 'status', '--porcelain', '--', ...PACKAGES) !== '') throw new Error(`${source}/host or editing has uncommitted changes: vendor from a committed checkout only`);
  for (const name of PACKAGES) {
    rmSync(join(PACKAGES_OUT, name), { recursive: true, force: true });
    copyTree(join(source, name), join(PACKAGES_OUT, name));
  }
  console.log(`vendored host/ and editing/ from ${git(source, 'rev-parse', '--short', 'HEAD')} into vendor/mixo-geocore`);
}

function copyFrom(source) {
  const pkg = join(source, PKG);
  for (const name of FILES) {
    if (!existsSync(join(pkg, name))) throw new Error(`${join(pkg, name)} is missing (run \`npm run wasm:build\` in ${source})`);
  }
  // A pkg-browser older than the engine's last commit was built from older source.
  const builtAt = statSync(join(pkg, FILES[1])).mtimeMs;
  const committedAt = Number(git(source, 'log', '-1', '--format=%ct', '--', 'crates')) * 1000;
  if (builtAt < committedAt) throw new Error(`${pkg} is older than the last engine commit: run \`npm run wasm:build\` in ${source}`);
  const dirty = git(source, 'status', '--porcelain', '--', 'crates') !== '';
  if (dirty) throw new Error(`${source}/crates has uncommitted changes: vendor from a committed engine only`);
  mkdirSync(OUT_DIR, { recursive: true });
  for (const name of FILES) copyFileSync(join(pkg, name), join(OUT_DIR, name));
  return { commit: git(source, 'rev-parse', 'HEAD'), committed: git(source, 'log', '-1', '--format=%cI', '--', ENGINE_SRC) };
}

async function main() {
  if (process.argv.includes('--packages-only')) {
    copyPackages(resolve(argValue('--from') ?? join(ROOT, '..', 'mixo-geocore')));
    return;
  }
  const checkOnly = process.argv.includes('--check');
  const sourceFile = join(OUT_DIR, 'SOURCE.json');
  let source;
  if (checkOnly) {
    if (!existsSync(sourceFile)) throw new Error('public/vendor/mixo-geometry/SOURCE.json is missing (run: node scripts/vendor-geometry.mjs)');
    source = JSON.parse(readFileSync(sourceFile, 'utf8'));
  } else {
    const from = resolve(argValue('--from') ?? join(ROOT, '..', 'mixosupports'));
    source = { repo: 'mixocreative/mixosupports', ...copyFrom(from) };
    if (existsSync(join(from, PACKAGES[0]))) copyPackages(from);
  }

  // Imported late: --packages-only creates this file on a fresh checkout.
  const { HOST_GEOMETRY_VERSION } = await import(pathToFileURL(join(PACKAGES_OUT, 'host', 'geometryVersion.js')).href);
  const version = await engineVersion(OUT_DIR);
  if (version !== HOST_GEOMETRY_VERSION) {
    throw new Error(`vendored engine_version() is ${version}, host expects ${HOST_GEOMETRY_VERSION}: `
      + 'port the ABI change, then bump HOST_GEOMETRY_VERSION in vendor/mixo-geocore/host/geometryVersion.js');
  }

  const hashes = Object.fromEntries(FILES.map(name => [name, sha256(asBuilt(name, readFileSync(join(OUT_DIR, name))))]));
  if (checkOnly) {
    if (source.engineVersion !== version) throw new Error(`SOURCE.json records engine ${source.engineVersion}, the wasm reports ${version}`);
    const versionFile = readFileSync(join(OUT_DIR, 'VERSION'), 'utf8').trim();
    if (versionFile !== String(version)) throw new Error(`VERSION says ${versionFile}, the wasm reports ${version}`);
    for (const name of FILES) {
      if (hashes[name] !== source.sha256[name]) throw new Error(`public/vendor/mixo-geometry/${name} does not match SOURCE.json: sha256 ${hashes[name]}`);
    }
  } else {
    writeFileSync(sourceFile, `${JSON.stringify({ ...source, engineVersion: version, sha256: hashes }, null, 2)}\n`);
    writeFileSync(join(OUT_DIR, 'VERSION'), `${version}\n`);
  }
  console.log(`mixo geometry engine ${version} (mixosupports ${source.commit.slice(0, 7)}) verified in public/vendor/mixo-geometry`);
}

main().catch(err => {
  console.error(`vendor-geometry: ${err.message}`);
  process.exit(1);
});
