// vendor-geometry.mjs --release path (PE.4), proven offline with a fake release folder:
// a good release installs and passes --check, a tampered asset fails SHA256SUMS, and an
// engine/host version mismatch is refused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCRIPT = join(ROOT, 'scripts', 'vendor-geometry.mjs');

const tar = (cwd, args) => {
  const run = spawnSync('tar', args, { cwd, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
};

/** A release folder shaped like scripts/assemble-release.mjs output, from the committed vendored files. */
function fakeRelease(base, { hostVersionSource } = {}) {
  const work = mkdtempSync(join(base, 'src-'));
  const out = mkdtempSync(join(base, 'release-'));
  cpSync(join(ROOT, 'public', 'vendor', 'mixo-geocore'), join(work, 'pkg-browser'), { recursive: true });
  for (const f of ['SOURCE.json', 'VERSION']) rmSync(join(work, 'pkg-browser', f));
  for (const name of ['host', 'editing']) cpSync(join(ROOT, 'vendor', 'mixo-geocore', name), join(work, name), { recursive: true });
  if (hostVersionSource) writeFileSync(join(work, 'host', 'geometryVersion.js'), hostVersionSource);
  for (const name of ['pkg-browser', 'host', 'editing']) tar(out, ['-czf', `mixo-geocore-v9-${name}.tgz`, '-C', work, name]);
  writeFileSync(join(out, 'mixo-geocore-v9-pkg-node.tgz'), 'node package placeholder');
  const sums = readdirSync(out).filter(f => f.endsWith('.tgz')).sort()
    .map(f => `${createHash('sha256').update(readFileSync(join(out, f))).digest('hex')}  ${f}\n`);
  writeFileSync(join(out, 'SHA256SUMS'), sums.join(''));
  return out;
}

function vendor(base, releaseDir, extra = []) {
  const outRoot = mkdtempSync(join(base, 'root-'));
  const run = spawnSync(process.execPath, [SCRIPT, '--release', 'v9', '--release-dir', releaseDir, '--out-root', outRoot, ...extra], { encoding: 'utf8' });
  return { run, outRoot };
}

test('release path: good release installs and verifies, tampering and version mismatch fail', () => {
  const base = mkdtempSync(join(tmpdir(), 'vendor-release-'));
  try {
    const good = fakeRelease(base);
    const { run, outRoot } = vendor(base, good);
    assert.equal(run.status, 0, run.stderr);
    const source = JSON.parse(readFileSync(join(outRoot, 'public', 'vendor', 'mixo-geocore', 'SOURCE.json'), 'utf8'));
    assert.equal(source.tag, 'v9');
    assert.equal(source.repo, 'mixocreative/mixo-geocore');
    assert.equal(source.engineVersion, 9);
    const check = spawnSync(process.execPath, [SCRIPT, '--check', '--out-root', outRoot], { encoding: 'utf8' });
    assert.equal(check.status, 0, check.stderr);

    // --check also catches a hand edit of a vendored package file.
    writeFileSync(join(outRoot, 'vendor', 'mixo-geocore', 'editing', 'types.ts'), '// edited\n', { flag: 'a' });
    assert.notEqual(spawnSync(process.execPath, [SCRIPT, '--check', '--out-root', outRoot], { encoding: 'utf8' }).status, 0);

    const tampered = fakeRelease(base);
    writeFileSync(join(tampered, 'mixo-geocore-v9-host.tgz'), 'tampered', { flag: 'a' });
    const bad = vendor(base, tampered);
    assert.notEqual(bad.run.status, 0);
    assert.match(bad.run.stderr, /does not match SHA256SUMS/);

    const mismatch = fakeRelease(base, {
      hostVersionSource: readFileSync(join(ROOT, 'vendor', 'mixo-geocore', 'host', 'geometryVersion.js'), 'utf8')
        .replace(/HOST_GEOMETRY_VERSION\s*=\s*\d+/, 'HOST_GEOMETRY_VERSION = 8'),
    });
    const wrong = vendor(base, mismatch);
    assert.notEqual(wrong.run.status, 0);
    assert.match(wrong.run.stderr, /engine_version\(\) is 9, host expects 8/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
