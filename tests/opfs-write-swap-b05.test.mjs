// cia B-05: on WebKit without createWritable the project is written through a
// sync access handle in a worker. A failure or timeout mid-write must leave
// the previous good save intact, and the error must say which copy survived.
// Drives the REAL worker module against a fake OPFS whose access handle can
// fault after the first chunk.
//   node --import ./tests/register-hooks.mjs --test tests/opfs-write-swap-b05.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installEnv } from './env.mjs';

installEnv();
console.error = () => {};

// ── Fake OPFS: one directory of files, sync access handles, optional move() ──
function makeOpfs({ withMove = false, chunk = 4, faultAfterChunks = Infinity } = {}) {
  const files = new Map();   // name → Uint8Array
  let faultsLeft = faultAfterChunks;
  const fileHandle = (name) => ({
    kind: 'file', name,
    async createSyncAccessHandle() {
      let open = true;
      return {
        truncate(n) { files.set(name, files.get(name).slice(0, n)); },
        write(view, { at = 0 } = {}) {
          if (!open) throw new Error('closed');
          if (faultsLeft-- <= 0) throw Object.assign(new Error('QuotaExceededError'), { name: 'QuotaExceededError' });
          const n = Math.min(chunk, view.byteLength);
          const cur = files.get(name);
          const next = new Uint8Array(Math.max(cur.length, at + n));
          next.set(cur); next.set(view.subarray(0, n), at);
          files.set(name, next);
          return n;
        },
        flush() {},
        close() { open = false; },
      };
    },
    ...(withMove ? { async move(newName) { files.set(newName, files.get(name)); files.delete(name); } } : {}),
  });
  const dir = {
    kind: 'directory',
    async getDirectoryHandle() { return dir; },
    async getFileHandle(name, { create = false } = {}) {
      if (!files.has(name)) { if (!create) throw new Error('NotFoundError'); files.set(name, new Uint8Array(0)); }
      return fileHandle(name);
    },
    async removeEntry(name) { if (!files.delete(name)) throw new Error('NotFoundError'); },
  };
  return { files, dir };
}

const setNavigator = (nav) => Object.defineProperty(globalThis, 'navigator', { value: nav, configurable: true, writable: true });
const replies = [];
globalThis.self = { postMessage(m) { replies.push(m); } };
await import('../src/core/workers/OpfsWrite.worker.js');

async function runWorker(payload) {
  replies.length = 0;
  const id = Math.random();
  await globalThis.self.onmessage({ data: { id, type: 'run', payload } });
  return replies.filter(r => r.id === id);
}
const text = u8 => new TextDecoder().decode(u8);
const bytes = s => new TextEncoder().encode(s);
const OLD = '{"v":"previous good save"}';
const NEW = '{"v":"new document, longer than the old one"}';

for (const withMove of [false, true]) {
  const tier = withMove ? 'with move()' : 'without move()';

  test(`${tier}: a fault after the first chunk leaves the previous save intact and reports it`, async () => {
    const { files, dir } = makeOpfs({ withMove, faultAfterChunks: 1 });
    files.set('p.mixo', bytes(OLD));
    setNavigator({ storage: { async getDirectory() { return dir; } } });
    const out = await runWorker({ path: ['Projects', 'p.mixo'], tempName: 'p (recovered).mixo', bytes: bytes(NEW) });
    assert.equal(out.at(-1).type, 'error', 'the write is refused loudly');
    assert.equal(text(files.get('p.mixo')), OLD, 'the previous good save is untouched');
    assert.deepEqual([...files.keys()], ['p.mixo'], 'no half-written temp file left behind');
  });

  test(`${tier}: a healthy write replaces the file and leaves no temp`, async () => {
    const { files, dir } = makeOpfs({ withMove });
    files.set('p.mixo', bytes(OLD));
    setNavigator({ storage: { async getDirectory() { return dir; } } });
    const out = await runWorker({ path: ['Projects', 'p.mixo'], tempName: 'p (recovered).mixo', bytes: bytes(NEW) });
    assert.equal(out.at(-1).type, 'done');
    assert.equal(text(files.get('p.mixo')), NEW);
    assert.deepEqual([...files.keys()], ['p.mixo']);
  });
}

test('the adapter says which copy survived: temp-phase failure keeps the previous file', async () => {
  const { OpfsStorageAdapter } = await import('../src/core/storage/OpfsStorageAdapter.js');
  const { files, dir } = makeOpfs({ faultAfterChunks: 1 });
  files.set('p.mixo', bytes(OLD));
  const root = { ...dir, async resolve() { return ['Projects', 'p.mixo']; }, async isSameEntry() { return false; } };
  setNavigator({ storage: { async getDirectory() { return root; } } });
  const prevWorker = globalThis.Worker;
  // The worker module under test, hosted in-process: route postMessage to it.
  globalThis.Worker = class {
    constructor() { globalThis.self.postMessage = (m) => queueMicrotask(() => this.onmessage({ data: m })); }
    postMessage(msg) { globalThis.self.onmessage({ data: msg }); }
    terminate() {}
  };
  try {
    const ref = { kind: 'file', name: 'p.mixo' };
    await assert.rejects(OpfsStorageAdapter.writeFile(ref, NEW), (err) => {
      assert.equal(err.previousKept, true, 'the caller can tell the previous copy survived');
      assert.equal(typeof err.recoveryName, 'string');
      assert.match(String(err.cause?.message ?? err.message), /Quota/, 'the underlying reason is kept');
      return true;
    });
    assert.equal(text(files.get('p.mixo')), OLD);
  } finally {
    globalThis.Worker = prevWorker;
  }
});

test('the save façade turns the adapter verdict into the user message and keeps the cause', async () => {
  const { PersistenceManager } = await import('../src/core/PersistenceManager.js');
  const { SceneManager } = await import('../src/core/SceneManager.js');
  const { AssetLoader } = await import('../src/core/AssetLoader.js');
  const { storage } = await import('../src/core/storage/StorageAdapter.js');
  const { Toast } = await import('../src/ui/Toast.js');
  Toast.show = () => {};
  SceneManager.saveCameraState = () => ({ alpha: 0, beta: 0, radius: 1, target: { x: 0, y: 0, z: 0 }, isOrthographic: false });
  SceneManager.getScene = () => ({ transformNodes: [], meshes: [], defaultMaterial: { name: 'grey' } });
  AssetLoader.getBabylonMesh = () => null;
  AssetLoader.getAssetBytes = async () => null;
  PersistenceManager.init();
  storage.pickSaveProject = async () => ({ ref: { name: 'p.mixo' }, name: 'p.mixo' });
  storage.writeFile = async () => {
    throw Object.assign(new Error('Could not replace p.mixo'), { previousKept: false, recoveryName: 'p (recovered).mixo', cause: new Error('QuotaExceededError') });
  };
  await assert.rejects(PersistenceManager.saveAs(), (err) => {
    assert.equal(err.cause?.previousKept, false, 'the verdict travels with the error');
    assert.equal(err.cause?.recoveryName, 'p (recovered).mixo');
    assert.notEqual(err.message, 'Could not replace p.mixo', 'the user gets the translated sentence, not the adapter diagnostic');
    return true;
  });
  assert.equal(PersistenceManager.hasSaveTarget(), false, 'a failed Save As binds nothing');
});
