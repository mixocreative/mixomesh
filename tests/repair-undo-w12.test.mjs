// cia W-12: one-click Repair is an undo step. Ctrl+Z after Repair puts the
// unrepaired mesh back and leaves the user's earlier steps alone; Ctrl+Y
// repairs again.
//   node --import ./tests/register-hooks.mjs --test tests/repair-undo-w12.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installEnv } from './env.mjs';

installEnv();
console.error = () => {};
const { repairObjects } = await import('../src/core/repair/RepairSession.js');
const R = await import('../src/core/repair/MeshRepair.js');
const { HistoryManager } = await import('../src/core/HistoryManager.js');
const { AssetLoader } = await import('../src/core/AssetLoader.js');
const { getState, setState } = await import('../src/core/StateManager.js');

const S = 0.1;
const C = [[0, 0, 0], [S, 0, 0], [0, S, 0], [0, 0, S]];

function openTetra(id) {
  let positions = [];
  let indices = [];
  for (const tri of [[0, 2, 1], [0, 1, 3], [0, 3, 2]]) {
    for (const i of tri) { positions.push(...C[i]); indices.push(indices.length); }
  }
  return {
    name: id, metadata: { meshId: id }, geometry: true,
    getVerticesData: (kind = 'position') => (kind === 'position' ? new Float32Array(positions) : undefined),
    isVerticesDataPresent: kind => kind === 'position',
    getIndices: () => indices,
    setVerticesData: (kind, data) => { if (kind === 'position') positions = Array.from(data); },
    removeVerticesData() {},
    setIndices: data => { indices = Array.from(data); },
    getWorldMatrix: () => ({}),
    getBoundingInfo: () => ({ boundingBox: {
      minimumWorld: { x: 0, y: 0, z: 0, subtract: o => ({ x: -o.x, y: -o.y, z: -o.z }) },
      maximumWorld: { x: S, y: S, z: S, subtract: () => ({ x: S, y: S, z: S }) },
    } }),
    intersects: () => ({ hit: false }),
    getTotalVertices: () => positions.length / 3,
    createNormals() {}, refreshBoundingInfo() {},
  };
}

test('Ctrl+Z after Repair restores the open mesh and keeps the earlier step', async () => {
  const mesh = openTetra('m1');
  AssetLoader.getBabylonMesh = id => (id === 'm1' ? mesh : null);
  R.__test.setEngine({
    diagnose: (V, T) => {
      const closed = T.length >= 4;
      return { boundary: closed ? 0 : 3, nonManifold: 0, components: 1, isWatertight: closed };
    },
    repairObject: async (V, T) => ({ V, T: [...T, [1, 2, 3]], report: { holesFilled: 1 } }),
  });
  setState(s => ({ ...s, scene: { ...s.scene, objects: {
    m1: { id: 'm1', name: 'm1', isPrintPart: true, isGhost: false },
  } } }), { silent: true });
  HistoryManager.clear();
  HistoryManager.push({ label: 'Export format 3MF', execute() {}, undo() {} });

  const res = await repairObjects(['m1']);
  assert.equal(res.repaired, 1);
  const repairedTris = mesh.getIndices().length / 3;
  assert.ok(repairedTris > 3, 'the repair closed the mesh');
  assert.ok(getState().scene.objects.m1.geometryFixes?.length, 'the fix is recorded for save');

  assert.notEqual(HistoryManager.getUndoLabel(), 'Export format 3MF', 'Repair is the newest undo step');
  HistoryManager.undo();
  assert.equal(mesh.getIndices().length / 3, 3, 'undo puts the open mesh back');
  assert.ok(!getState().scene.objects.m1.geometryFixes?.length, 'and drops the recorded fix, so a save does not replay it');
  assert.equal(HistoryManager.getUndoLabel(), 'Export format 3MF', 'the earlier step is still there, not undone');

  HistoryManager.redo();
  assert.equal(mesh.getIndices().length / 3, repairedTris, 'redo repairs again');
  assert.ok(getState().scene.objects.m1.geometryFixes?.length);
  R.__test.setEngine(null);
});

test('a Repair that changes nothing adds no undo step', async () => {
  HistoryManager.clear();
  HistoryManager.push({ label: 'earlier', execute() {}, undo() {} });
  await repairObjects(['missing']);
  assert.equal(HistoryManager.getUndoLabel(), 'earlier');
});
