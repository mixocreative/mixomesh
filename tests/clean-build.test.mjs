import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanBuildOutputs, pruneOldInstallers, CLEAN_DIRS, isPortListening } from '../scripts/clean.mjs';
import { createServer } from 'node:net';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'mx-clean-'));
  for (const d of ['dist/assets', 'release/win-unpacked', 'node_modules/.vite/deps', 'node_modules/keep-me', 'src']) mkdirSync(join(root, d), { recursive: true });
  writeFileSync(join(root, 'dist/assets/old-abc.js'), 'x');
  writeFileSync(join(root, 'src/app.js'), 'x');
  return root;
}

test('cleans dist, release and the Vite dep cache; never touches sources or other packages', () => {
  const root = fixture();
  const removed = cleanBuildOutputs(root);
  assert.deepEqual(CLEAN_DIRS, ['dist', 'release', 'node_modules/.vite']);
  assert.deepEqual(removed.sort(), ['dist', 'node_modules/.vite', 'release']);
  for (const d of CLEAN_DIRS) assert.equal(existsSync(join(root, d)), false, d);
  assert.equal(existsSync(join(root, 'src/app.js')), true);
  assert.equal(existsSync(join(root, 'node_modules/keep-me')), true);
  assert.deepEqual(cleanBuildOutputs(root), [], 'idempotent');
});

test('prunes older installer versions, keeping only the one just built (+ its checksum)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mx-inst-'));
  for (const f of ['MIXOMESH-Setup-0.0.9.exe', 'MIXOMESH-Setup-0.0.9.exe.sha256', 'MIXOMESH-Setup-0.1.0.exe',
    'MIXOMESH-Setup-0.1.0.exe.sha256', 'notes.txt']) writeFileSync(join(dir, f), 'x');
  const removed = pruneOldInstallers(dir, 'MIXOMESH-Setup-0.1.0.exe');
  assert.deepEqual(removed.sort(), ['MIXOMESH-Setup-0.0.9.exe', 'MIXOMESH-Setup-0.0.9.exe.sha256']);
  assert.deepEqual(readdirSync(dir).sort(), ['MIXOMESH-Setup-0.1.0.exe', 'MIXOMESH-Setup-0.1.0.exe.sha256', 'notes.txt']);
  assert.deepEqual(pruneOldInstallers(join(dir, 'missing'), 'x.exe'), [], 'missing folder is fine');
});

test('keepViteCache leaves the dev cache for a running dev server', () => {
  const root = fixture();
  const removed = cleanBuildOutputs(root, { keepViteCache: true });
  assert.deepEqual(removed.sort(), ['dist', 'release']);
  assert.equal(existsSync(join(root, 'node_modules/.vite')), true);
});

test('isPortListening detects a live dev-server port', async () => {
  const server = createServer().listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  const { port } = server.address();
  assert.equal(await isPortListening(port), true);
  await new Promise(r => server.close(r));
  assert.equal(await isPortListening(port), false);
});
