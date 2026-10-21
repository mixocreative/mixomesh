// cia W-03: the status-bar mesh stats follow the project after Open/Recover
// (PROJECT_LOADED) and New (PROJECT_NEW), not the previous scene.
import assert from 'node:assert/strict';
import test from 'node:test';
import { installEnv } from './env.mjs';

installEnv();

const { StateManager, dispatch, setState } = await import('../src/core/StateManager.js');
const { EVENTS } = await import('../src/core/events.js');
const { SceneManager } = await import('../src/core/SceneManager.js');
const { StatusBar } = await import('../src/ui/StatusBar.js');
const { MeshStats } = await import('../src/ui/MeshStats.js');
const { AssetLoader } = await import('../src/core/AssetLoader.js');

let hudText = '';
StatusBar.setCenter = (text) => { hudText = text; };
const scene = { meshes: [] };
SceneManager.getScene = () => scene;
MeshStats.init();

const flush = () => Promise.resolve().then(() => Promise.resolve());

function openedMesh() {
  const B = window.BABYLON;
  const mesh = {
    metadata: { meshId: 'opened' }, geometry: {}, getTotalIndices: () => 30,
    computeWorldMatrix() {},
    getBoundingInfo: () => ({ boundingBox: {
      minimumWorld: new B.Vector3(0, 0, 0), maximumWorld: new B.Vector3(0.01, 0.02, 0.03),
    } }),
  };
  AssetLoader.bindRestoredMesh('opened', mesh, 'asset1');
  return mesh;
}

test('after Open the HUD shows the opened scene and its restored selection', async () => {
  StateManager.replaceState(StateManager.freshState());
  scene.meshes = [openedMesh()];
  setState(s => ({
    ...s,
    scene: { ...s.scene, objects: { opened: { id: 'opened', name: 'opened', assetId: 'asset1' } } },
    selection: { ...s.selection, selectedIds: ['opened'], activeId: 'opened' },
  }), { silent: true });
  hudText = '';
  dispatch(EVENTS.PROJECT_LOADED, {});
  await flush();
  assert.match(hudText, /^\S+ 10 \//, `scene total is the opened mesh's 10 triangles: "${hudText}"`);
  assert.match(hudText, /10×30×20 mm/, `selection dims shown: "${hudText}"`);
});

test('after New the HUD drops the previous project numbers', async () => {
  scene.meshes = [];
  StateManager.replaceState(StateManager.freshState());
  dispatch(EVENTS.PROJECT_NEW, {});
  await flush();
  assert.match(hudText, /^\S+ 0 \//, `empty scene reads 0 triangles: "${hudText}"`);
});
