// Regression tests for review C3 + H5: commands constructed while the gizmo
// selection-pivot is attached must restore CANONICAL parents on undo, never
// the temporary (disposed) pivot node.
//   node --import ./tests/register-hooks.mjs tests/history-pivot.test.mjs

import assert from 'node:assert/strict';
import { installEnv } from './env.mjs';

installEnv();
// Real Babylon (NullEngine) so the group-pivot tests (overhaul 2.2) exercise
// genuine parent/world-matrix math; the C3/H5 tests below keep plain fakes.
const BABYLON = await import('@babylonjs/core');
globalThis.window.BABYLON = BABYLON;
globalThis.window.removeEventListener = () => {};
globalThis.document.addEventListener = () => {};
globalThis.document.removeEventListener = () => {};
const { DeleteCommand, SmartReplaceCommand, TransformCommand, push, undo, redo, clear: clearHistory } =
  await import('../src/core/HistoryManager.js');
const Pivot = await import('../src/core/scene/PivotSession.js');
const { EVENTS } = await import('../src/core/events.js');
const { subscribe } = await import('../src/core/StateManager.js');
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

// ── Overhaul 2.2: group nodes under the pivot move rigidly ─────────────────
const engine = new BABYLON.NullEngine({ renderWidth: 64, renderHeight: 64, textureSize: 64 });
const scene = new BABYLON.Scene(engine);
SceneManager.getScene = () => scene;
Pivot.setTransformCommitHandler(({ prev, next, alreadyApplied }) => {
  push(new TransformCommand(prev, next, { alreadyApplied }));
});

const V = (x, y, z) => new BABYLON.Vector3(x, y, z);
function near(a, b, msg, eps = 1e-6) {
  for (const k of ['x', 'y', 'z']) {
    assert.ok(Math.abs(a[k] - b[k]) < eps, `${msg}: ${k} ${a[k]} != ${b[k]}`);
  }
}
function worldPos(n) { n.computeWorldMatrix(true); return n.getAbsolutePosition().clone(); }

/** Group g1 at (10,0,0) holding box a (local (1,0,0)) + box b (local (-1,0,2)); loose box c at (0,0,-5). */
function buildGroupScene() {
  meshes.clear();
  clearHistory();
  for (const m of [...scene.meshes]) m.dispose();
  for (const t of [...scene.transformNodes]) t.dispose();
  const g = new BABYLON.TransformNode('G', scene);
  g.metadata = { groupId: 'g1' };
  g.position = V(10, 0, 0);
  const box = (id, pos, parent) => {
    const m = BABYLON.MeshBuilder.CreateBox(id, { size: 2 }, scene);
    m.metadata = { meshId: id };
    m.parent = parent;
    m.position = pos;
    meshes.set(id, m);
    return m;
  };
  const a = box('a', V(1, 0, 0), g);
  const b = box('b', V(-1, 0, 2), g);
  const c = box('c', V(0, 0, -5), null);
  setState(s => ({
    ...s,
    scene: {
      ...s.scene,
      objects: Object.fromEntries(['a', 'b', 'c'].map(id => [id, {
        id, name: id, assetId: 'a1', parentId: id === 'c' ? null : 'g1', shaderId: null,
        visible: true, locked: false, isGhost: false, isPrintPart: true,
        collectionId: null, sourceGroupId: null,
      }])),
      groups: { g1: { id: 'g1', name: 'G', parentId: null, childIds: ['a', 'b'], origin: 'user' } },
    },
  }), { silent: true });
  for (const n of [g, a, b, c]) n.computeWorldMatrix(true);
  return { g, a, b, c };
}

await test('2.2 group + its own child selected → only the group node goes under the pivot', async () => {
  const { g, a, b } = buildGroupScene();
  Pivot.attachToSelection([a, g, b], 'median', g, [g]);
  const pivot = Pivot.getPivotNode();
  assert.ok(pivot, 'pivot attached');
  assert.equal(g.parent, pivot, 'group node parented to the pivot');
  assert.equal(a.parent, g, 'child a stays under its group (not double-parented)');
  assert.equal(b.parent, g, 'child b stays under its group');
  Pivot.attachToSelection([], 'median', null);
  assert.equal(g.parent, null, 'detach restores the group canonical (root) parent');
});

await test('2.2 median/active pivot = AABB centre of selected geometry; individual = group origin', async () => {
  const { g } = buildGroupScene();
  // a spans x[10,12], b spans x[8,10] z[1,3]; union x[8,12] y[-1,1] z[-1,3].
  Pivot.attachToSelection([g], 'median', g, [g]);
  near(worldPos(Pivot.getPivotNode()), V(10, 0, 1), 'median pivot');
  Pivot.attachToSelection([g], 'active', g, [g]);
  near(worldPos(Pivot.getPivotNode()), V(10, 0, 1), 'active pivot (group active)');
  Pivot.attachToSelection([g], 'individual', g, [g]);
  near(worldPos(Pivot.getPivotNode()), V(10, 0, 0), 'individual pivot = group node origin');
  Pivot.attachToSelection([], 'median', null);
});

await test('2.2 drag a group → children world shift once, locals unchanged, undo/redo exact', async () => {
  const { g, a, b, c } = buildGroupScene();
  const events = [];
  const off = subscribe(EVENTS.TRANSFORM_COMMITTED, p => events.push(p));
  // Mixed selection: loose object c + group g1 + g1's own child a.
  Pivot.attachToSelection([c, g, a], 'median', g, [g]);
  assert.ok(Pivot.beginBodyDrag(), 'body drag starts');
  Pivot.setBodyDragOffset(V(5, 0, 0));
  Pivot.endBodyDrag();
  if (typeof off === 'function') off();

  near(worldPos(a), V(16, 0, 0), 'a moved by exactly +5 (not twice)');
  near(worldPos(b), V(14, 0, 2), 'b moved rigidly with its group');
  near(worldPos(c), V(5, 0, -5), 'loose object moved too');
  near(a.position, V(1, 0, 0), 'a local unchanged');
  near(b.position, V(-1, 0, 2), 'b local unchanged');
  assert.equal(a.parent, g, 'a still parented to its group');

  const ev = events.at(-1);
  assert.deepEqual([...ev.nodeIds].sort(), ['c', 'g1'], 'snapshot keyed by node id (group id, no child ids)');
  assert.deepEqual([...ev.meshIds].sort(), ['a', 'b', 'c'], 'meshIds expand the group to its member meshes');

  undo();
  near(worldPos(g), V(10, 0, 0), 'undo restores the group node');
  near(worldPos(a), V(11, 0, 0), 'undo restores child a world');
  near(worldPos(b), V(9, 0, 2), 'undo restores child b world');
  near(worldPos(c), V(0, 0, -5), 'undo restores loose object');
  near(a.position, V(1, 0, 0), 'a local still unchanged after undo');

  redo();
  near(worldPos(a), V(16, 0, 0), 'redo re-applies the group move');
  near(worldPos(c), V(5, 0, -5), 'redo re-applies the object move');
  Pivot.attachToSelection([], 'median', null);
  near(worldPos(g), V(15, 0, 0), 'group world survives pivot detach');
  assert.equal(g.parent, null, 'group back in its canonical parent');
});

await test('2.2 TransformCommand keyed by group id rotates/scales the group rigidly', async () => {
  const { g, a } = buildGroupScene();
  const prev = { g1: { position: { x: 10, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, scaling: { x: 1, y: 1, z: 1 } } };
  const q = BABYLON.Quaternion.RotationAxis(V(0, 1, 0), Math.PI / 2);
  const next = { g1: { position: { x: 10, y: 0, z: 0 }, rotation: { x: q.x, y: q.y, z: q.z, w: q.w }, scaling: { x: 2, y: 2, z: 2 } } };
  push(new TransformCommand(prev, next));
  // a local (1,0,0) → 90° about Y → (0,0,-1), ×2 → (0,0,-2), + (10,0,0).
  near(worldPos(a), V(10, 0, -2), 'child follows group rotation + scale', 1e-5);
  near(a.position, V(1, 0, 0), 'child local untouched');
  undo();
  near(worldPos(a), V(11, 0, 0), 'undo restores child world', 1e-5);
  near(g.scaling, V(1, 1, 1), 'undo restores group scale', 1e-6);
});

console.log('\n' + out.join('\n'));
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
