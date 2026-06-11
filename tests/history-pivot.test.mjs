// Regression tests for review C3 + H5: commands constructed while the gizmo
// selection-pivot is attached must restore CANONICAL parents on undo, never
// the temporary (disposed) pivot node.
//   node --import ./tests/register-hooks.mjs tests/history-pivot.test.mjs

import assert from 'node:assert/strict';
import { installEnv } from './env.mjs';

installEnv();
const { DeleteCommand, SmartReplaceCommand } = await import('../src/core/HistoryManager.js');
const { AssetLoader }  = await import('../src/core/AssetLoader.js');
const { SceneManager } = await import('../src/core/SceneManager.js');
const { Selection }    = await import('../src/core/Selection.js');
const { setState, getState } = await import('../src/core/StateManager.js');

// ── Fakes ────────────────────────────────────────────────────────────────
function fakeVec(x = 0, y = 0, z = 0) {
  return { x, y, z,
    set(a, b, c) { this.x = a; this.y = b; this.z = c; return this; },
    clone() { return fakeVec(this.x, this.y, this.z); },
  };
}
function fakeMesh(meshId, name, parent = null) {
  return {
    name,
    metadata: { meshId },
    parent,
    enabled: true,
    position: fakeVec(),
    scaling: fakeVec(1, 1, 1),
    rotationQuaternion: { x: 0, y: 0, z: 0, w: 1 },
    absoluteScaling: fakeVec(1, 1, 1),
    absoluteRotationQuaternion: { x: 0, y: 0, z: 0, w: 1 },
    setParent(p) { this.parent = p; },
    setEnabled(v) { this.enabled = v; },
    computeWorldMatrix() {},
    getAbsolutePosition() { return this.position.clone(); },
    clone(cloneName) { const c = fakeMesh(null, cloneName, this.parent); return c; },
  };
}

const meshes = new Map();
AssetLoader.getBabylonMesh = (id) => meshes.get(id) ?? null;

// The pivot lifecycle stub: while "attached", meshes are parented to
// pivotNode. Detaching ([] selection) restores canonical parents and
// disposes the pivot — exactly what SceneManager._detachPivot does.
let pivotNode = null;
let canonicalParents = new Map();   // mesh → canonical parent
SceneManager.attachToSelection = (list) => {
  if (!list || !list.length) {
    if (pivotNode) {
      for (const [m, p] of canonicalParents) m.parent = p;
      pivotNode.disposed = true;
      pivotNode = null;
      canonicalParents = new Map();
    }
  }
};
SceneManager.setActive = () => {};
SceneManager.setSelected = () => {};
Selection.refresh = () => {};
Selection.clear = () => {};
Selection.set = () => {};

function attachPivot(list) {
  pivotNode = { name: 'selectionPivot', disposed: false };
  for (const m of list) { canonicalParents.set(m, m.parent); m.parent = pivotNode; }
  return pivotNode;
}

function seedObjects(objs) {
  meshes.clear();
  for (const o of objs) if (o.mesh) meshes.set(o.id, o.mesh);
  setState(s => ({
    ...s,
    scene: {
      ...s.scene,
      objects: Object.fromEntries(objs.map(o => [o.id, {
        id: o.id, name: o.id, assetId: 'a1', parentId: null, shaderId: null,
        visible: true, locked: false, isGhost: false, isPrintPart: true,
        collectionId: null, sourceGroupId: null,
      }])),
    },
  }), { silent: true });
}

let passed = 0, failed = 0;
const out = [];
async function test(name, fn) {
  try { await fn(); out.push(`PASS  ${name}`); passed++; }
  catch (e) { out.push(`FAIL  ${name}\n      ${e.stack || e.message}`); failed++; }
}

await test('Delete → Undo restores canonical parent, not the disposed pivot', async () => {
  const groupNode = { name: 'GroupA' };
  const m = fakeMesh('m1', 'PartA', groupNode);
  seedObjects([{ id: 'm1', mesh: m }]);
  const pivot = attachPivot([m]);          // selection active → mesh under pivot

  const cmd = new DeleteCommand(['m1']);   // constructed WHILE pivot attached
  cmd.execute();
  assert.equal(m.enabled, false, 'execute soft-disables the mesh');

  cmd.undo();
  assert.equal(m.enabled, true, 'undo re-enables the mesh');
  assert.notEqual(m.parent, pivot, 'undo must NOT re-parent to the disposed pivot');
  assert.equal(m.parent, groupNode, 'undo restores the canonical parent');
  assert.ok(getState().scene.objects.m1, 'undo restores the state entry');
});

await test('SmartReplace → Undo restores the target\'s canonical parent', async () => {
  const groupNode = { name: 'GroupB' };
  const active = fakeMesh('act', 'ActivePart', null);
  const target = fakeMesh('tgt', 'TargetPart', groupNode);
  seedObjects([{ id: 'act', mesh: active }, { id: 'tgt', mesh: target }]);

  // cloneMeshAsNewObject seam: mint a fake clone + state entry like the real one.
  let cloneCount = 0;
  AssetLoader.cloneMeshAsNewObject = (sourceId) => {
    const newId = `clone_${++cloneCount}`;
    const c = fakeMesh(newId, `${sourceId}.dup`, null);
    meshes.set(newId, c);
    setState(s => ({
      ...s,
      scene: { ...s.scene, objects: { ...s.scene.objects, [newId]: {
        ...s.scene.objects[sourceId], id: newId, name: `${sourceId}.dup`,
      } } },
    }), { silent: true });
    return newId;
  };
  AssetLoader.restoreCloneToScene = () => {};

  attachPivot([active, target]);           // both selected → both under pivot

  const cmd = new SmartReplaceCommand(['act', 'tgt'], 'act');
  cmd.execute();
  assert.equal(target.enabled, false, 'execute soft-disables the replaced target');

  cmd.undo();
  assert.equal(target.enabled, true, 'undo re-enables the original');
  assert.equal(target.parent, groupNode,
    `undo must restore the canonical parent, got ${target.parent?.name ?? target.parent}`);
});

console.log('\n' + out.join('\n'));
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
