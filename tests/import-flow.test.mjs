// Import flow fixes from the heavy-mesh branch review (I4, I5, M2, M12).
import test from 'node:test';
import assert from 'node:assert/strict';
import { installEnv } from './env.mjs';
import { binaryStlChunks } from '../scripts/heavy-mesh/generate.mjs';

installEnv();
const B = window.BABYLON;
const { ProgressOverlay } = await import('../src/ui/ProgressOverlay.js');
const overlay = { shows: 0, onCancel: null, hides: 0 };
ProgressOverlay.show = (_title, opts) => { overlay.shows++; overlay.onCancel = opts?.onCancel ?? null; };
ProgressOverlay.update = () => {};
ProgressOverlay.hide = () => { overlay.hides++; };
const { StateManager, setState } = await import('../src/core/StateManager.js');
const { AssetLoader } = await import('../src/core/AssetLoader.js');
const AI = await import('../src/core/assets/AssetImport.js');
const { setBlobUrl } = await import('../src/core/assets/BlobUrls.js');
const { setCapabilities, caps } = await import('../src/core/storage/capabilities.js');
const { Toast } = await import('../src/ui/Toast.js');
const { sha256Hex } = await import('../src/core/hash.js');

const stlBytes = Buffer.concat([...binaryStlChunks(4)]);   // 64 triangles, exact count
const stl = new Blob([stlBytes]);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const fresh = () => { StateManager.replaceState(StateManager.freshState()); overlay.shows = 0; overlay.onCancel = null; };

function libraryAsset(id, extra = {}) {
  setState(s => ({ ...s, scene: { ...s.scene, assetLibrary: { ...s.scene.assetLibrary, [id]: {
    id, name: id, filename: `${id}.stl`, extension: '.stl', kind: 'mesh', sourceUnit: 'mm', modelRatio: 1, ...extra,
  } } } }), { silent: true });
}

test('I4: Add another copy runs the pre-parse budget check on the cached source blob', async (t) => {
  fresh();
  const before = caps.triangleBudget;
  t.after(() => setCapabilities({ triangleBudget: before }));
  setCapabilities({ triangleBudget: 10 });
  let loads = 0;
  B.SceneLoader = { LoadAssetContainerAsync: async () => { loads++; throw new Error('should not parse'); } };
  libraryAsset('asset_heavy');
  setBlobUrl('asset_heavy', 'blob:heavy', stl);
  await assert.rejects(AssetLoader.instantiateAsset('asset_heavy', new B.Vector3(0, 0, 0)), /handles up to 40/);
  assert.equal(loads, 0, 'refused before any parse');
});

test('I4: a failed worker parse of a big cached source is not retried on the main thread', async (t) => {
  fresh();
  const big = new Blob([new Uint8Array(AI.MAIN_THREAD_FALLBACK_MAX_BYTES + 1024)]);
  let loads = 0;
  B.SceneLoader = { LoadAssetContainerAsync: async () => { loads++; return { meshes: [], dispose() {} }; } };
  class CrashingWorker {
    postMessage() { setTimeout(() => this.onerror?.({ message: 'worker out of memory' }), 0); }
    terminate() {}
  }
  const prev = globalThis.Worker;
  globalThis.Worker = CrashingWorker;
  t.after(() => { globalThis.Worker = prev; });
  libraryAsset('asset_big');
  setBlobUrl('asset_big', 'blob:big', big);
  await assert.rejects(AssetLoader.instantiateAsset('asset_big', new B.Vector3(0, 0, 0)), /out of memory/);
  assert.equal(loads, 0, 'no main-thread fallback for a file over 32 MiB');
});

test('M2: a fast (refused) import never flashes the overlay', async (t) => {
  fresh();
  const before = caps.triangleBudget;
  t.after(() => setCapabilities({ triangleBudget: before }));
  setCapabilities({ triangleBudget: 10 });
  await assert.rejects(AssetLoader.loadFromBlob(stl, 'fast.stl'));
  await sleep(450);
  assert.equal(overlay.shows, 0);
});

test('I5: Cancel aborts the running import, disposes its result and bumps the drop generation', async () => {
  fresh();
  let disposed = 0;
  B.SceneLoader = { LoadAssetContainerAsync: async () => { await sleep(700); return { meshes: [], dispose() { disposed++; } }; } };
  const gen = AI.importCancelGeneration();
  const run = AssetLoader.loadFromBlob(stl, 'slow.stl');
  await sleep(450);
  assert.equal(overlay.shows, 1, 'overlay appears after the 400 ms delay');
  overlay.onCancel();
  await assert.rejects(run, { name: 'AbortError' });
  assert.equal(disposed, 1, 'nothing half-added');
  assert.equal(AI.importCancelGeneration(), gen + 1, 'drop loops see the cancel and stop');
});

test('M12: the over-budget warning waits for the duplicate prompt; a dismissed prompt warns about nothing', async (t) => {
  fresh();
  const before = caps.triangleBudget;
  const show = Toast.show;
  const toasts = [];
  t.after(() => { setCapabilities({ triangleBudget: before }); Toast.show = show; });
  Toast.show = (msg, kind) => toasts.push(kind);
  setCapabilities({ triangleBudget: 50 });   // 64 triangles → warn, not refuse
  const hash = await sha256Hex(stlBytes.buffer.slice(stlBytes.byteOffset, stlBytes.byteOffset + stlBytes.length));
  libraryAsset('asset_dupe', { contentHash: hash });
  setBlobUrl('asset_dupe', 'blob:dupe', stl);
  const ids = await AI.importWithDedupe(stl, 'dupe.stl', undefined, {}, { ask: async () => null });
  assert.deepEqual(ids, []);
  assert.equal(toasts.filter(k => k === 'warning').length, 0);
});
