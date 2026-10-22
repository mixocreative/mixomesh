// W-02 / B-10: the budget count, the status bar and the Stats HUD read one
// number: the triangles of the objects in the scene as the viewport shows them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installEnv } from './env.mjs';

installEnv();
globalThis.queueMicrotask ??= (fn) => Promise.resolve().then(fn);

const { StateManager, setState } = await import('../src/core/StateManager.js');
const Registry = await import('../src/core/assets/MeshRegistry.js');
const { countSceneTriangles } = await import('../src/core/scene/TriangleCount.js');
const HUD = await import('../src/ui/StatsHud.js');

const mesh = (meshId, tris) => ({
  metadata: { meshId }, geometry: {}, isVisible: true,
  getTotalIndices: () => tris * 3, getTotalVertices: () => tris,
  setEnabled(on) { this.enabled = on; }, isEnabled() { return this.enabled !== false; },
});

function scene(objects) {
  StateManager.replaceState(StateManager.freshState());
  for (const [id, m] of Object.entries(objects)) Registry.registerMesh(id, m);
  setState(s => ({ ...s, scene: { ...s.scene, objects: Object.fromEntries(Object.keys(objects).map(id => [id, { id, name: id, visible: true }])) } }), { silent: true });
}

test('a deleted object stops counting toward the budget, like the Stats HUD', () => {
  const heavy = mesh('mesh_heavy', 5_000_000);
  scene({ mesh_heavy: heavy, mesh_small: mesh('mesh_small', 8) });
  assert.equal(countSceneTriangles(), 5_000_008);
  heavy.setEnabled(false);   // DeleteCommand: soft-disable for undo, object leaves the scene
  setState(s => { const { mesh_heavy: _gone, ...objects } = s.scene.objects; return { ...s, scene: { ...s.scene, objects } }; }, { silent: true });
  assert.equal(countSceneTriangles(), 8);
  assert.equal(HUD.snapshot().tris, countSceneTriangles(), 'status bar / budget and HUD agree');
});

test('refined geometry the viewport shows counts toward the budget', () => {
  const source = mesh('mesh_src', 12_000);
  scene({ mesh_src: source });
  const refined = [{ ...mesh('', 192_000), metadata: { mixoDerivedPreview: true }, isVisible: true }];
  const derivedFor = (id) => (id === 'mesh_src' ? refined : null);
  assert.equal(countSceneTriangles(undefined, { derivedFor }), 192_000);
  refined[0].isVisible = false;   // preview off: the source is what is shown
  assert.equal(countSceneTriangles(undefined, { derivedFor }), 12_000);
});
