// Asset resolve tiers through the StorageAdapter (overhaul task 4.2). Run:
//   node --import ./tests/register-hooks.mjs tests/asset-resolve.test.mjs
//
// resolveAssetBlob must reach live bytes ONLY via adapter.resolveAsset /
// restoreRef (no FSA / idb in the resolver), report the plain status words,
// and never call the explicit findMoved walk during load (Decision 3).

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { installEnv } from './env.mjs';
import { putFileHandle as seedHandle, __reset as resetIdb } from './idb-stub.mjs';

installEnv();
const { resolveAssetBlob, sourcesOf } = await import('../src/core/persist/AssetResolver.js');
const { bufFromB64 } = await import('../src/core/persist/ProjectSerializer.js');
const { BrowserStorageAdapter } = await import('../src/core/storage/StorageAdapter.js');
const { DesktopStorageAdapter } = await import('../src/core/storage/DesktopStorageAdapter.js');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`# PASS  ${name}`); passed++; }
  catch (err) { console.log(`# FAIL  ${name}\n      ${err.stack || err.message}`); failed++; }
}

const sha = bytes => createHash('sha256').update(Uint8Array.from(bytes)).digest('hex');
const b64 = bytes => Buffer.from(Uint8Array.from(bytes)).toString('base64');
const bytesOf = async blob => [...new Uint8Array(await blob.arrayBuffer())];
const quietly = async fn => {
  const prev = console.error;
  const logged = [];
  console.error = (...a) => logged.push(a.map(String).join(' '));
  try { return { value: await fn(), logged }; } finally { console.error = prev; }
};

/** Scripted adapter: `sources` maps refKey → {status, bytes}; records every call. */
function stubAdapter(sources = {}, dirs = {}) {
  const calls = [];
  return {
    calls,
    async resolveAsset(source, opts) {
      calls.push(['resolveAsset', source.kind, source.refKey, source.path, opts?.contentHash ?? null]);
      const hit = sources[source.refKey];
      if (!hit) return { status: 'missing', blob: null };
      return { status: hit.status, blob: hit.bytes ? new Blob([Uint8Array.from(hit.bytes)]) : null };
    },
    async restoreRef(key) { calls.push(['restoreRef', key]); return dirs[key] ?? null; },
    async listDirectory(ref) { return dirs[ref] ?? []; },
    async readFile(ref) { return new Blob([Uint8Array.from(ref.bytes)]); },
    async findMoved() { throw new Error('findMoved must never run during load'); },
  };
}

const EMB = [42, 0, 255];
const entry = extra => ({ filename: 'hull.glb', extension: '.glb', contentHash: null, fileData: null, ...extra });

await test('sanity: base64 helper matches the serializer', () => {
  assert.deepEqual([...bufFromB64(b64(EMB))], EMB);
});

await test('sourcesOf maps legacy keys (folder first, then file) and prefers schema-3.4 source', () => {
  assert.deepEqual(sourcesOf(entry({ directoryHandleKey: 'D', originalPath: 'p/hull.glb', fileHandleKey: 'F' })), [
    { kind: 'folder', refKey: 'D', path: 'p/hull.glb', label: 'hull.glb' },
    { kind: 'file', refKey: 'F', path: 'hull.glb', label: 'hull.glb' },
  ]);
  const source = { kind: 'file', refKey: 'file_x', path: 'a.glb', label: 'a.glb' };
  assert.deepEqual(sourcesOf(entry({ source, directoryHandleKey: 'D', originalPath: 'x' })), [source]);
  assert.deepEqual(sourcesOf(entry({})), []);
});

await test('tier: no link + embedded → status embedded, not live', async () => {
  const adapter = stubAdapter();
  const r = await resolveAssetBlob(entry({ contentHash: sha(EMB), fileData: b64(EMB) }), { adapter });
  assert.equal(r.status, 'embedded');
  assert.equal(r.live, false);
  assert.deepEqual(await bytesOf(r.blob), EMB);
  assert.deepEqual(adapter.calls, [], 'no adapter traffic without a link');
});

await test('tier: linked folder source wins over embedded, contentHash forwarded', async () => {
  const adapter = stubAdapter({ D: { status: 'linked', bytes: [1, 2] } });
  const r = await resolveAssetBlob(entry({
    directoryHandleKey: 'D', originalPath: 'p/hull.glb', contentHash: 'h1', fileData: b64(EMB),
  }), { adapter });
  assert.equal(r.status, 'linked');
  assert.equal(r.live, true);
  assert.deepEqual(await bytesOf(r.blob), [1, 2]);
  assert.deepEqual(adapter.calls[0], ['resolveAsset', 'folder', 'D', 'p/hull.glb', 'h1']);
});

await test('tier: changed on disk → live bytes used, status changed', async () => {
  const adapter = stubAdapter({ D: { status: 'changed', bytes: [3] } });
  const r = await resolveAssetBlob(entry({ directoryHandleKey: 'D', originalPath: 'hull.glb', contentHash: 'h' }), { adapter });
  assert.equal(r.status, 'changed');
  assert.equal(r.live, true);
});

await test('tier: link fails → embedded copy with status missing; findMoved never called', async () => {
  const adapter = stubAdapter();
  const r = await resolveAssetBlob(entry({
    directoryHandleKey: 'D', originalPath: 'hull.glb', fileHandleKey: 'F',
    contentHash: sha(EMB), fileData: b64(EMB),
  }), { adapter });
  assert.equal(r.status, 'missing');
  assert.equal(r.live, false);
  assert.deepEqual(await bytesOf(r.blob), EMB);
  assert.deepEqual(adapter.calls.map(c => c.slice(0, 3)), [
    ['resolveAsset', 'folder', 'D'], ['restoreRef', 'D'], ['resolveAsset', 'file', 'F'],
  ]);
});

await test('tier: folder miss → legacy hash scan of the SAME folder via adapter listDirectory/readFile', async () => {
  const live = [7, 7, 7];
  const dirs = {
    D: 'rootRef',
    rootRef: [
      { name: 'other.glb', path: 'other.glb', kind: 'file', ref: { bytes: [0] } },
      { name: 'renamed.glb', path: 'renamed.glb', kind: 'file', ref: { bytes: live } },
    ],
  };
  const adapter = stubAdapter({}, dirs);
  const r = await resolveAssetBlob(entry({
    directoryHandleKey: 'D', originalPath: 'gone/hull.glb', contentHash: sha(live), fileData: b64([0]),
  }), { adapter });
  assert.equal(r.status, 'linked');
  assert.equal(r.live, true);
  assert.deepEqual(await bytesOf(r.blob), live);
});

await test('tier: file source used when the folder source fails', async () => {
  const adapter = stubAdapter({ F: { status: 'linked', bytes: [8] } });
  const r = await resolveAssetBlob(entry({ directoryHandleKey: 'D', originalPath: 'x.glb', fileHandleKey: 'F' }), { adapter });
  assert.equal(r.status, 'linked');
  assert.deepEqual(await bytesOf(r.blob), [8]);
});

await test('adapter error → logged, falls through to embedded', async () => {
  const adapter = stubAdapter();
  adapter.resolveAsset = async () => { throw new Error('bridge down'); };
  const { value: r, logged } = await quietly(() => resolveAssetBlob(
    entry({ fileHandleKey: 'F', fileData: b64(EMB) }), { adapter }));
  assert.equal(r.status, 'missing');
  assert.deepEqual(await bytesOf(r.blob), EMB);
  assert.ok(logged.some(l => /bridge down/.test(l)));
});

await test('nothing live, nothing embedded → null (ghost)', async () => {
  assert.equal(await resolveAssetBlob(entry({ fileHandleKey: 'F' }), { adapter: stubAdapter() }), null);
});

await test('default adapter (browser) resolves a persisted file key from IndexedDB', async () => {
  resetIdb();
  await seedHandle('file_k', {
    kind: 'file',
    async requestPermission() { return 'granted'; },
    async getFile() { return new Blob([Uint8Array.from([5, 6])]); },
  });
  const r = await resolveAssetBlob(entry({ fileHandleKey: 'file_k', contentHash: sha([5, 6]) }));
  assert.equal(r.status, 'linked');
  const changed = await resolveAssetBlob(entry({ fileHandleKey: 'file_k', contentHash: sha([0]) }), { adapter: BrowserStorageAdapter });
  assert.equal(changed.status, 'changed');
  resetIdb();
});

await test('desktop adapter: resolve goes through readStoredFile with key + relative path only', async () => {
  const prevWindow = globalThis.window;
  const prevApi = prevWindow?.electronAPI;
  globalThis.window = prevWindow ?? {};
  const seen = [];
  window.electronAPI = {
    readStoredFile: async (key, rel) => { seen.push([key, rel]); return rel === 'p/hull.glb' ? { name: 'hull.glb', bytes: Uint8Array.from([1, 1]).buffer } : null; },
    restoreRef: async () => null,
  };
  try {
    const r = await resolveAssetBlob(entry({
      directoryHandleKey: 'dir_0123456789abcdef0123456789abcdef', originalPath: 'p/hull.glb', contentHash: sha([1, 1]),
    }), { adapter: DesktopStorageAdapter });
    assert.equal(r.status, 'linked');
    assert.deepEqual(await bytesOf(r.blob), [1, 1]);
    assert.deepEqual(seen, [['dir_0123456789abcdef0123456789abcdef', 'p/hull.glb']]);
  } finally {
    if (prevWindow === undefined) delete globalThis.window;
    else { globalThis.window = prevWindow; window.electronAPI = prevApi; }
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
