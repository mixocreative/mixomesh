// cia F-08 residual: an API scene.import whose caller timed out or disconnected
// stops the import it already started, so re-running the job does not import
// the files twice. It cancels only that import, never the user's own drop.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installEnv } from './env.mjs';
import { binaryStlChunks } from '../scripts/heavy-mesh/generate.mjs';

installEnv();
const B = window.BABYLON;
const { ProgressOverlay } = await import('../src/ui/ProgressOverlay.js');
ProgressOverlay.open = () => ({ update() {}, close() {} });
const { StateManager } = await import('../src/core/StateManager.js');
const { AssetLoader } = await import('../src/core/AssetLoader.js');
const AI = await import('../src/core/assets/AssetImport.js');

const stl = new Blob([Buffer.concat([...binaryStlChunks(4)])]);
const sleep = ms => new Promise(r => setTimeout(r, ms));

test('aborting the caller signal stops a started import and adds nothing', async () => {
  StateManager.replaceState(StateManager.freshState());
  let disposed = 0;
  B.SceneLoader = { LoadAssetContainerAsync: async () => { await sleep(200); return { meshes: [], dispose() { disposed++; } }; } };
  const batch = AI.beginImportBatch();
  const caller = new AbortController();
  const run = AssetLoader.loadFromBlob(stl, 'api.stl', undefined, { signal: caller.signal });
  await sleep(20);
  caller.abort();
  await assert.rejects(run, { name: 'AbortError' });
  assert.equal(disposed, 1, 'nothing half-added');
  assert.equal(Object.keys(StateManager.getState().scene.objects).length, 0);
  assert.equal(batch.signal.aborted, false, "the user's own drop is not cancelled");
  batch.end();
  assert.equal(AssetLoader.isImporting(), false);
});

test('a signal already aborted imports nothing', async () => {
  StateManager.replaceState(StateManager.freshState());
  let loads = 0;
  B.SceneLoader = { LoadAssetContainerAsync: async () => { loads++; return { meshes: [], dispose() {} }; } };
  const caller = new AbortController();
  caller.abort();
  await assert.rejects(AssetLoader.loadFromBlob(stl, 'api.stl', undefined, { signal: caller.signal }), { name: 'AbortError' });
  assert.equal(loads, 0);
});
