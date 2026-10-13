// Unit gaps for AssetResolver (overhaul 6.6d) — complements asset-resolve.test.mjs:
// embedded hash verification, status bookkeeping, scanDirForHash, applyFoundSource
// edge cases, findMovedForAsset guards.
//   node --import ./tests/register-hooks.mjs tests/asset-resolver-unit.test.mjs

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { installEnv } from './env.mjs';

installEnv();
const R = await import('../src/core/persist/AssetResolver.js');
const { setState, getState, subscribe } = await import('../src/core/StateManager.js');

const sha = bytes => createHash('sha256').update(Uint8Array.from(bytes)).digest('hex');
const b64 = bytes => Buffer.from(Uint8Array.from(bytes)).toString('base64');
const bytesOf = async blob => [...new Uint8Array(await blob.arrayBuffer())];
const quietly = async fn => {
  const prev = console.error; const logged = [];
  console.error = (...a) => logged.push(a.map(String).join(' '));
  try { return { value: await fn(), logged }; } finally { console.error = prev; }
};
const seed = (id, extra) => setState(s => ({ ...s, scene: { ...s.scene, assetLibrary: { ...s.scene.assetLibrary,
  [id]: { id, filename: 'p.glb', extension: '.glb', ...extra } } } }), { silent: true });

test('embedded copy whose bytes do not match contentHash -> null (ghost) + logged, no throw', async () => {
  const e = { id: 'u1', filename: 'p.glb', contentHash: sha([9, 9, 9]), fileData: b64([1, 2, 3]) };
  const { value, logged } = await quietly(() => R.resolveAssetBlob(e, { adapter: {} }));
  assert.equal(value, null);
  assert.ok(logged.some(l => l.includes('do not match contentHash')), 'mismatch is logged');
});

test('legacy embedded copy without contentHash is trusted', async () => {
  const r = await R.resolveAssetBlob({ id: 'u2', filename: 'p.glb', fileData: b64([5, 6]) }, { adapter: {} });
  assert.equal(r.status, 'embedded');
  assert.deepEqual(await bytesOf(r.blob), [5, 6]);
});

test('status bookkeeping: getAssetStatus / canFindMoved / clearAssetStatuses', async () => {
  R.clearAssetStatuses();
  assert.equal(R.getAssetStatus('nope'), null);
  assert.equal(R.canFindMoved('nope'), false);
  const link = { kind: 'folder', refKey: 'D', path: 'p.glb', label: 'p.glb' };
  const miss = { resolveAsset: async () => ({ status: 'missing', blob: null }) };
  await R.resolveAssetBlob({ id: 'u3', filename: 'p.glb', source: link, fileData: b64([1]) }, { adapter: miss });
  assert.equal(R.getAssetStatus('u3'), 'missing');
  assert.equal(R.canFindMoved('u3'), true, 'missing link offers Find moved');
  const ok = { resolveAsset: async () => ({ status: 'linked', blob: new Blob([new Uint8Array([1])]) }) };
  await R.resolveAssetBlob({ id: 'u4', filename: 'p.glb', source: link }, { adapter: ok });
  assert.equal(R.canFindMoved('u4'), false, 'linked does not');
  await R.resolveAssetBlob({ id: 'u5', filename: 'p.glb', fileData: b64([1]) }, { adapter: {} });
  assert.equal(R.getAssetStatus('u5'), 'embedded');
  assert.equal(R.canFindMoved('u5'), false);
  R.clearAssetStatuses();
  assert.equal(R.getAssetStatus('u3'), null, 'cleared');
});

test('first linked source short-circuits: later sources are never queried', async () => {
  const calls = [];
  const adapter = { resolveAsset: async (s) => { calls.push(s.refKey); return { status: 'linked', blob: new Blob([new Uint8Array([7])]) }; } };
  const e = { id: 'u6', filename: 'p.glb', directoryHandleKey: 'D', originalPath: 'x/p.glb', fileHandleKey: 'F' };
  const r = await R.resolveAssetBlob(e, { adapter });
  assert.deepEqual(calls, ['D']);
  assert.equal(r.live, true);
  assert.equal(r.status, 'linked');
});

test('entry without id still resolves (status not recorded)', async () => {
  const r = await R.resolveAssetBlob({ filename: 'p.glb', fileData: b64([3]) }, { adapter: {} });
  assert.equal(r.status, 'embedded');
});

test('scanDirForHash finds a nested match, honours the extension filter and the budget', async () => {
  const mkFile = (name, bytes) => ({ kind: 'file', name, getFile: async () => ({ name, arrayBuffer: async () => Uint8Array.from(bytes).buffer }) });
  const mkDir = (entries) => ({ kind: 'directory', entries: async function* () { for (const e of entries) yield [e.name, e]; } });
  const target = [4, 4, 4];
  const root = mkDir([
    mkFile('a.txt', target),                     // wrong ext, skipped
    { ...mkDir([mkFile('deep.glb', target)]), name: 'sub' },
  ]);
  const f = await R.scanDirForHash(root, sha(target), '.glb');
  assert.equal(f?.name, 'deep.glb');
  assert.equal(await R.scanDirForHash(root, sha([0]), '.glb'), null, 'no match -> null');
  const budget = { n: 100000 };
  assert.equal(await R.scanDirForHash(root, sha(target), '.glb', budget), null, 'exhausted budget stops the walk');
});

test('applyFoundSource: file-kind leaves legacy folder keys; unknown asset / empty result is a no-op', () => {
  seed('f1', { directoryHandleKey: 'OLD', originalPath: 'old/p.glb' });
  let n = 0;
  const off = subscribe('asset:relinked', () => { n++; });
  const found = { kind: 'file', refKey: 'file_9', path: 'p.glb', label: 'p.glb' };
  assert.equal(R.applyFoundSource('f1', { source: found }), true);
  const e = getState().scene.assetLibrary.f1;
  assert.deepEqual(e.source, found);
  assert.equal(e.directoryHandleKey, 'OLD', 'legacy folder key untouched for file links');
  assert.equal(n, 1);
  assert.equal(R.applyFoundSource('ghost-id', { source: found }), false);
  assert.equal(R.applyFoundSource('f1', null), false);
  assert.equal(n, 1, 'no event for no-ops');
  if (typeof off === 'function') off();
});

test('findMovedForAsset: no hash / no link / unknown asset -> empty result and adapter untouched', async () => {
  const adapter = { findMoved: async () => { throw new Error('must not be called'); } };
  seed('m1', { source: { kind: 'file', refKey: 'k', path: 'p', label: 'p' } });          // no contentHash
  seed('m2', { contentHash: 'H' });                                                      // no link
  const empty = { source: null, blob: null, scanned: 0 };
  assert.deepEqual(await R.findMovedForAsset('m1', { adapter }), empty);
  assert.deepEqual(await R.findMovedForAsset('m2', { adapter }), empty);
  assert.deepEqual(await R.findMovedForAsset('zzz', { adapter }), empty);
});

test('findMovedForAsset prefers the folder source over a file source', async () => {
  seed('m3', { contentHash: 'H', fileHandleKey: 'F', directoryHandleKey: 'D', originalPath: 'a/p.glb' });
  let used = null;
  const adapter = { findMoved: async (src, o) => { used = [src.kind, o.refKey]; return { source: null, blob: null, scanned: 0 }; } };
  await R.findMovedForAsset('m3', { adapter });
  assert.deepEqual(used, ['folder', 'D']);
});
