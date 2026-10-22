import test from 'node:test';
import assert from 'node:assert/strict';
import { installEnv } from './env.mjs';
import { binaryStlChunks } from '../scripts/heavy-mesh/generate.mjs';

installEnv();

const B = window.BABYLON;
const { ProgressOverlay } = await import('../src/ui/ProgressOverlay.js');
ProgressOverlay.open = () => ({ update() {}, close() {} });
const { StateManager, getState } = await import('../src/core/StateManager.js');
const { AssetLoader } = await import('../src/core/AssetLoader.js');
const { importWithDedupe } = await import('../src/core/assets/AssetImport.js');
const { setCapabilities, caps } = await import('../src/core/storage/capabilities.js');
const { Toast } = await import('../src/ui/Toast.js');

const stl = new Blob([Buffer.concat([...binaryStlChunks(4)])]);   // 64 triangles, exact

test('over 4× budget: refused before the loader runs, nothing registered', async (t) => {
  StateManager.replaceState(StateManager.freshState());
  const before = { triangleBudget: caps.triangleBudget, triangleLimit: caps.triangleLimit };
  t.after(() => setCapabilities(before));
  setCapabilities({ triangleBudget: 10, triangleLimit: 40 });
  let loads = 0;
  B.SceneLoader = { LoadAssetContainerAsync: async () => { loads++; throw new Error('should not parse'); } };
  await assert.rejects(AssetLoader.loadFromBlob(stl, 'big.stl'),
    /"big\.stl" has 64 triangles; this web build handles up to 40\. Simplify or split the model, or use the desktop app\./);
  await assert.rejects(importWithDedupe(stl, 'big.stl'), /handles up to 40/);
  assert.equal(loads, 0);
  assert.equal(Object.keys(getState().scene.assetLibrary ?? {}).length, 0);
  assert.equal(AssetLoader.isImporting?.() ?? false, false);
});

test('over 1× budget: one warning toast before parsing, import proceeds to the loader', async (t) => {
  StateManager.replaceState(StateManager.freshState());
  const before = { triangleBudget: caps.triangleBudget, triangleLimit: caps.triangleLimit };
  const show = Toast.show;
  const toasts = [];
  t.after(() => { setCapabilities(before); Toast.show = show; });
  Toast.show = (msg, kind) => toasts.push([msg, kind]);
  setCapabilities({ triangleBudget: 50, triangleLimit: 200 });
  let loads = 0;
  B.SceneLoader = { LoadAssetContainerAsync: async () => { loads++; throw new Error('stop after the check'); } };
  await assert.rejects(AssetLoader.loadFromBlob(stl, 'warn.stl'), /stop after the check/);
  assert.equal(toasts.filter(([, kind]) => kind === 'warning').length, 1);
  assert.equal(loads, 1);
});
