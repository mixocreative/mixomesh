// L2-04: the displayed size of a rotated object was the world box of its
// rotated LOCAL box (sashimi at 30° read 176×132 mm, true extents 157×97 mm),
// and the status bar listed the axes in a different order from Properties.
//   node --import ./tests/register-hooks.mjs --test tests/world-size-l2f.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installEnv } from './env.mjs';

installEnv();
const BABYLON = { ...await import('@babylonjs/core') };
globalThis.window.BABYLON = BABYLON;
const { StateManager, setState } = await import('../src/core/StateManager.js');
const { SceneManager } = await import('../src/core/SceneManager.js');
const { StatusBar } = await import('../src/ui/StatusBar.js');
const { MeshStats } = await import('../src/ui/MeshStats.js');
const { registerMesh } = await import('../src/core/assets/MeshRegistry.js');
const { EVENTS } = await import('../src/core/events.js');
const { dispatch } = await import('../src/core/StateManager.js');

let hud = '';
StatusBar.setCenter = (text) => { hud = text; };

const engine = new BABYLON.NullEngine({ renderWidth: 64, renderHeight: 64, textureSize: 16 });
const scene = new BABYLON.Scene(engine);
SceneManager.getScene = () => scene;

// A 20 mm tall wall running diagonally across a 100×100 mm footprint. Turned
// 45° about Y it lies along X: 141 mm long, 20 mm tall, 0 mm deep. Its local
// box turned 45° is 141×141 mm, which is what the loose measure reports.
const wall = new BABYLON.Mesh('wall', scene);
const vd = new BABYLON.VertexData();
vd.positions = [-0.05, 0, -0.05, 0.05, 0, 0.05, 0.05, 0.02, 0.05, -0.05, 0.02, -0.05];
vd.indices = [0, 1, 2, 0, 2, 3];
vd.applyToMesh(wall);
wall.metadata = { meshId: 'wall_1' };
wall.rotation.y = Math.PI / 4;
registerMesh('wall_1', wall);

StateManager.replaceState(StateManager.freshState());
setState(s => ({
  ...s,
  scene: { ...s.scene, objects: { wall_1: { id: 'wall_1', name: 'wall' } } },
  selection: { ...s.selection, selectedIds: ['wall_1'], activeId: 'wall_1' },
}), { silent: true });
MeshStats.init();

test('status bar shows the rotated object\'s true size in X × Y × Z order', () => {
  dispatch(EVENTS.SELECTION_CHANGED, {});
  const size = hud.match(/(\d+)×(\d+)×(\d+) mm/);
  assert.ok(size, `size in "${hud}"`);
  assert.deepEqual(size.slice(1).map(Number), [141, 20, 0], 'X 141, Y (height) 20, Z 0, like Properties');
});
