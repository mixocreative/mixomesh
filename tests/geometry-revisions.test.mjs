// Every in-place geometry mutation bumps the mesh's GeometryStore revision,
// so a worker result computed from older geometry is recognised as stale.
import assert from 'node:assert/strict';
import { installEnv } from './env.mjs';

installEnv();
console.error = () => {};
const { revisionOf } = await import('../src/core/geometry/GeometryStore.js');
const { weldMesh: weld } = await import('../src/core/repair/Weld.js');
const { arraysToMesh, conformWinding } = await import('../src/core/repair/MeshRepair.js');
const { applyGeometryFix } = await import('../src/core/repair/RepairSession.js');
const { applyPersistedRatioBake } = await import('../src/core/assets/AssetRestore.js');
const { SourceUnitCommand, RescaleObjectCommand } = await import('../src/core/HistoryManager.js');
const { AssetLoader } = await import('../src/core/AssetLoader.js');
const { SceneManager } = await import('../src/core/SceneManager.js');
const { Selection } = await import('../src/core/Selection.js');
const { setState } = await import('../src/core/StateManager.js');

SceneManager.attachToSelection = () => {};
SceneManager.setActive = () => {};
SceneManager.setSelected = () => {};
Selection.refresh = () => {};
const meshes = new Map();
AssetLoader.getBabylonMesh = id => meshes.get(id) ?? null;
window.BABYLON.VertexData.ComputeNormals = () => {};

let passed = 0, failed = 0;
const out = [];
async function test(name, fn) {
  try { await fn(); out.push(`PASS  ${name}`); passed++; }
  catch (e) { out.push(`FAIL  ${name}\n      ${e.stack || e.message}`); failed++; }
}

/** Duck-typed mesh with live get/set arrays (a closed tetrahedron). */
function tetra(id) {
  const data = {
    position: Float32Array.from([0,0,0, 1,0,0, 0,1,0, 0,0,1, 0,0,0]),   // duplicate vertex 4 for weld
    normal: new Float32Array(15),
  };
  let indices = Uint32Array.from([0,2,1, 4,1,3, 1,2,3, 0,3,2]);
  return {
    name: id, metadata: { meshId: id }, geometry: true,
    getVerticesData: kind => data[kind] ?? null,
    setVerticesData: (kind, arr) => { data[kind] = Float32Array.from(arr); },
    isVerticesDataPresent: kind => !!data[kind],
    removeVerticesData: kind => { delete data[kind]; },
    getIndices: () => indices,
    setIndices: arr => { indices = Uint32Array.from(arr); },
    getTotalVertices: () => data.position.length / 3,
    createNormals() {}, refreshBoundingInfo() {},
    bakeTransformIntoVertices() { this.__bakes = (this.__bakes ?? 0) + 1; },
  };
}

await test('weld bumps the revision when it changes the mesh', () => {
  const m = tetra('rev_weld');
  const before = revisionOf(m);
  weld(m);
  assert.equal(revisionOf(m), before + 1);
});

await test('arraysToMesh bumps the revision', () => {
  const m = tetra('rev_arrays');
  arraysToMesh(m, [[0,0,0],[1,0,0],[0,1,0],[0,0,1]], [[0,2,1],[0,1,3],[1,2,3],[0,3,2]]);
  assert.equal(revisionOf(m), 1);
});

await test('conformWinding bumps only when it reverses the indices', () => {
  const m = tetra('rev_conform');
  const changed = conformWinding(m);
  assert.equal(revisionOf(m), changed ? 1 : 0);
  m.setIndices([0,1,2, 4,3,1, 1,3,2, 0,2,3]);   // flip every face
  const changed2 = conformWinding(m);
  assert.equal(revisionOf(m), (changed ? 1 : 0) + (changed2 ? 1 : 0));
  assert.ok(changed || changed2, 'one of the two orientations is reversed');
});

await test('mirror and invertedNormals fixes bump the revision', async () => {
  const m = tetra('rev_fix');
  await applyGeometryFix(m, 'mirror-x');
  assert.equal(revisionOf(m), 1);
  await applyGeometryFix(m, 'invertedNormals');
  assert.equal(revisionOf(m), 2);
});

await test('persisted ratio bake bumps the revision when it bakes', () => {
  const m = tetra('rev_ratio');
  applyPersistedRatioBake(m, { modelRatio: 1 }, 1);
  assert.equal(revisionOf(m), 0, 'no delta, no bake, no bump');
  applyPersistedRatioBake(m, { modelRatio: 1 }, 2);
  assert.equal(revisionOf(m), 1);
});

await test('source-unit and rescale commands bump the revision of every baked mesh', () => {
  const m = tetra('rev_cmd');
  m.position = { x: 1, y: 0, z: 0, scaleInPlace(f) { this.x *= f; return this; } };
  m.parent = null;
  meshes.set('rev_cmd', m);
  setState(s => ({
    ...s,
    scene: {
      ...s.scene,
      objects: { rev_cmd: { id: 'rev_cmd', name: 'rev_cmd', assetId: 'aR', ratio: 1, isGhost: false, isPrintPart: true } },
      assetLibrary: { aR: { id: 'aR', name: 'AR', filename: 'a.glb', extension: '.glb', kind: 'mesh', sourceUnit: 'millimeters', unitConfirmed: true, modelRatio: 1 } },
    },
  }), { silent: true });
  const unit = new SourceUnitCommand('aR', 'millimeters', 'meters');
  unit.execute();
  const afterUnit = revisionOf(m);
  assert.ok(afterUnit >= 1, 'source-unit bake bumped');
  unit.undo();
  assert.ok(revisionOf(m) > afterUnit, 'undo bake bumped again');
  const rescale = new RescaleObjectCommand(['rev_cmd'], 3);
  const beforeRescale = revisionOf(m);
  rescale.execute();
  assert.ok(revisionOf(m) > beforeRescale, 'rescale bake bumped');
});

await test('meshes marked as detached export clones never bump the original', () => {
  const m = tetra('rev_clone');
  m.__geometryDetached = true;
  weld(m);
  assert.equal(revisionOf('rev_clone'), 0);
});

console.log('\n' + out.join('\n'));
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
