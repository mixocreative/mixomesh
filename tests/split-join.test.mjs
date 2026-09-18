// Split to parts / Join (owner decision 2026-09-18): separating a
// multi-material import into independently movable objects — and merging
// objects back into one logical object — is explicit, undoable, and never
// touches geometry or shaders.
//   node --import ./tests/register-hooks.mjs tests/split-join.test.mjs

import assert from 'node:assert/strict';
import { installEnv } from './env.mjs';

installEnv();
console.error = () => {};
const { setState, getState } = await import('../src/core/StateManager.js');
const { SplitToPartsCommand, JoinCommand } = await import('../src/core/HistoryManager.js');
const { AssetLoader } = await import('../src/core/AssetLoader.js');
const { SceneManager } = await import('../src/core/SceneManager.js');
const { Selection } = await import('../src/core/Selection.js');
const { logicalObjectPartIds, canonicalObjectId, shouldDisplayObject } = await import('../src/core/LogicalObjects.js');
const { MeshValidator } = await import('../src/core/MeshValidator.js');
const R = await import('../src/core/repair/MeshRepair.js');

SceneManager.attachToSelection = () => {};
SceneManager.setActive = () => {};
SceneManager.setSelected = () => {};
Selection.refresh = () => {};

const meshes = new Map();
AssetLoader.getBabylonMesh = (id) => meshes.get(id) ?? null;
const fakeScene = { transformNodes: [], meshes: [] };
SceneManager.getScene = () => fakeScene;
// The scene shim: CreateGroupCommand instantiates a TransformNode.
const B = globalThis.window.BABYLON;
class FakeNode {
  constructor(name) { this.name = name; this.parent = null; this.metadata = {}; this.position = new B.Vector3(0, 0, 0); this.rotationQuaternion = null; this.rotation = new B.Vector3(0, 0, 0); this.scaling = new B.Vector3(1, 1, 1); fakeScene.transformNodes.push(this); }
  setParent(p) { this.parent = p; }
  getAbsolutePosition() { return this.position; }
  computeWorldMatrix() {}
  dispose() { const i = fakeScene.transformNodes.indexOf(this); if (i >= 0) fakeScene.transformNodes.splice(i, 1); }
}
B.TransformNode = FakeNode;

let passed = 0, failed = 0; const out = [];
async function test(name, fn) { try { await fn(); out.push(`PASS  ${name}`); passed++; } catch (e) { out.push(`FAIL  ${name}\n      ${e.stack || e.message}`); failed++; } }

// A tetra with one face missing, split across two "material" parts.
const C = [[0, 0, 0], [10, 0, 0], [0, 20, 0], [0, 0, 30]];
function fakeMesh(id, tris) {
  let positions = [], indices = [], n = 0;
  for (const [a, b, c] of tris) for (const i of [a, b, c]) { positions.push(...C[i]); indices.push(n++); }
  return {
    name: id, metadata: { meshId: id }, parent: null, geometry: {},
    position: new B.Vector3(0, 0, 0), rotationQuaternion: null, rotation: new B.Vector3(0, 0, 0), scaling: new B.Vector3(1, 1, 1),
    getVerticesData: (k = 'position') => (k === 'position' ? new Float32Array(positions) : undefined),
    getIndices: () => indices,
    setVerticesData: (k, d) => { if (k === 'position') positions = Array.from(d); },
    setIndices: (d) => { indices = Array.from(d); },
    getTotalVertices: () => positions.length / 3,
    getWorldMatrix: () => B.Matrix.Identity(),
    computeWorldMatrix() {},
    getAbsolutePosition() { return this.position; },
    setParent(p) { this.parent = p; },
    sideOrientation: 1, material: null,
  };
}

function seed(objects, groups = {}) {
  meshes.clear();
  fakeScene.transformNodes.length = 0;
  for (const o of Object.values(objects)) meshes.set(o.id, fakeMesh(o.id, o._tris));
  const clean = Object.fromEntries(Object.values(objects).map(o => { const { _tris, ...rest } = o; return [o.id, rest]; }));
  setState(s => ({ ...s, scene: { ...s.scene, objects: clean, groups, validation: {} } }), { silent: true });
}
const base = (id, name, extra = {}) => ({
  id, name, assetId: 'a1', collectionId: null, parentId: null, shaderId: null,
  visible: true, locked: false, isGhost: false, isUnlinked: false, isPrintPart: true,
  sourceGroupId: null, logicalObjectId: null, isInternalPart: false, ratio: 1, ...extra,
});
const twoPartObject = () => ({
  lead: base('lead', 'Bowl', { logicalObjectId: 'lead', _tris: [[0, 2, 1], [0, 1, 3]] }),
  part: base('part', 'Bowl_primitive1', { logicalObjectId: 'lead', isInternalPart: true, _tris: [[0, 3, 2]] }),
});

await test('split: a 2-part object becomes two objects in a new group; undo restores exactly; redo works', () => {
  seed(twoPartObject());
  const objectsBefore = structuredClone(getState().scene.objects);
  const groupsBefore = structuredClone(getState().scene.groups);
  const cmd = new SplitToPartsCommand('lead');
  cmd.execute();
  assert.equal(cmd.applied, true);
  const s = getState().scene;
  assert.ok(shouldDisplayObject(s.objects.part), 'the part is now a displayable object');
  assert.equal(s.objects.part.logicalObjectId, null);
  assert.equal(s.objects.part.isInternalPart, false);
  assert.equal(s.objects.lead.logicalObjectId, null);
  assert.equal(s.objects.part.name, 'Bowl.2', 'part named after the lead, readable and unique');
  assert.equal(logicalObjectPartIds('lead', s.objects).length, 1, 'lead is single-part now');
  const groups = Object.values(s.groups);
  assert.equal(groups.length, 1, 'one new group');
  assert.equal(groups[0].name, 'Bowl');
  assert.deepEqual([...groups[0].childIds].sort(), ['lead', 'part']);
  assert.equal(s.objects.lead.parentId, groups[0].id);
  assert.equal(s.objects.part.parentId, groups[0].id);
  assert.ok(fakeScene.transformNodes.some(n => n.metadata.groupId === groups[0].id), 'runtime TransformNode created');
  assert.equal(meshes.get('part').parent?.metadata?.groupId, groups[0].id, 'mesh reparented under the group node');

  cmd.undo();
  assert.equal(cmd.applied, false);
  assert.deepEqual(getState().scene.objects, objectsBefore, 'objects restored exactly');
  assert.deepEqual(getState().scene.groups, groupsBefore, 'groups restored exactly');
  assert.equal(meshes.get('part').parent, null, 'mesh parent restored');

  cmd.execute();
  assert.equal(cmd.applied, true);
  assert.equal(Object.keys(getState().scene.groups).length, 1, 'redo recreates the group');
  assert.equal(getState().scene.objects.part.name, 'Bowl.2');
});

await test('split: no-op on a single-part object', () => {
  seed({ solo: base('solo', 'Solo', { _tris: [[0, 2, 1]] }) });
  const before = structuredClone(getState().scene);
  const cmd = new SplitToPartsCommand('solo');
  cmd.execute();
  assert.equal(cmd.applied, false);
  assert.deepEqual(getState().scene.objects, before.objects);
  assert.deepEqual(getState().scene.groups, before.groups);
});

await test('split: the new group goes under the lead\'s previous parent group', () => {
  const o = twoPartObject();
  o.lead.parentId = 'gOuter'; o.part.parentId = 'gOuter';
  seed(o, { gOuter: { id: 'gOuter', name: 'Outer', parentId: null, childIds: ['lead', 'part'], origin: 'user' } });
  const outer = new FakeNode('Outer'); outer.metadata = { groupId: 'gOuter' };
  meshes.get('lead').parent = outer; meshes.get('part').parent = outer;
  const cmd = new SplitToPartsCommand('lead');
  cmd.execute();
  const s = getState().scene;
  const inner = Object.values(s.groups).find(g => g.name === 'Bowl');
  assert.ok(inner);
  assert.equal(inner.parentId, 'gOuter', 'split group nested under the old parent');
  assert.deepEqual(s.groups.gOuter.childIds, [], 'objects left the outer group for the inner one');
  cmd.undo();
  assert.deepEqual([...getState().scene.groups.gOuter.childIds].sort(), ['lead', 'part']);
  assert.equal(getState().scene.objects.lead.parentId, 'gOuter');
});

await test('join: two objects become one logical object (lead + internal part); undo restores; redo works', () => {
  seed({
    a: base('a', 'Cup', { _tris: [[0, 2, 1], [0, 1, 3]] }),
    b: base('b', 'Handle', { isPrintPart: false, _tris: [[0, 3, 2]] }),
  });
  const before = structuredClone(getState().scene.objects);
  const cmd = new JoinCommand(['b', 'a'], { leadId: 'a' });
  cmd.execute();
  assert.equal(cmd.applied, true);
  const s = getState().scene.objects;
  assert.equal(canonicalObjectId('b', s), 'a', 'b resolves to the lead');
  assert.equal(s.b.isInternalPart, true);
  assert.equal(s.b.logicalObjectId, 'a');
  assert.equal(s.b.isPrintPart, true, 'parts follow the lead\'s print flag');
  assert.equal(s.b.name, 'Handle', 'names untouched');
  assert.deepEqual(logicalObjectPartIds('a', s), ['a', 'b']);
  assert.equal(meshes.get('b').parent, null, 'meshes are not reparented by Join');

  cmd.undo();
  assert.deepEqual(getState().scene.objects, before, 'undo restores every flag');
  cmd.execute();
  assert.deepEqual(logicalObjectPartIds('a', getState().scene.objects), ['a', 'b'], 'redo re-joins');
});

await test('join: no-op with a single object (or the same object twice)', () => {
  seed({ a: base('a', 'Cup', { _tris: [[0, 2, 1]] }) });
  const before = structuredClone(getState().scene.objects);
  const cmd = new JoinCommand(['a', 'a']);
  cmd.execute();
  assert.equal(cmd.applied, false);
  assert.deepEqual(getState().scene.objects, before);
});

await test('join: an object that already has parts brings them along under the new lead', () => {
  const o = twoPartObject();   // lead + part
  seed({ ...o, c: base('c', 'Spoon', { _tris: [[0, 3, 2]] }) });
  const cmd = new JoinCommand(['c', 'lead'], { leadId: 'c' });
  cmd.execute();
  const s = getState().scene.objects;
  assert.deepEqual([...logicalObjectPartIds('c', s)].sort(), ['c', 'lead', 'part']);
  assert.equal(s.lead.isInternalPart, true);
  assert.equal(s.lead.logicalObjectId, 'c');
  cmd.undo();
  assert.deepEqual([...logicalObjectPartIds('lead', getState().scene.objects)].sort(), ['lead', 'part']);
  assert.equal(getState().scene.objects.c.logicalObjectId, null);
});

await test('validation of a joined object goes through the welded-union (group) path', async () => {
  seed({
    a: base('a', 'Cup', { _tris: [[0, 2, 1], [0, 1, 3]] }),
    b: base('b', 'Handle', { _tris: [[0, 3, 2]] }),
  });
  R.__test.setEngine({ diagnose: (_V, T) => {
    const use = new Map();
    for (const [x, y, z] of T) for (const [p, q] of [[x, y], [y, z], [z, x]]) { const k = p < q ? `${p}-${q}` : `${q}-${p}`; use.set(k, (use.get(k) ?? 0) + 1); }
    const boundary = [...use.values()].filter(n => n === 1).length;
    return { boundary, nonManifold: 0, components: 1, isWatertight: boundary === 0 };
  } });
  new JoinCommand(['a', 'b'], { leadId: 'a' }).execute();
  const results = await MeshValidator.validateMesh(meshes.get('a'));
  const holes = results.find(r => r.type === 'holes');
  assert.ok(holes, 'the open union reports holes');
  assert.equal(holes.scope, 'group', 'reported on the union, not the lead alone');
  assert.equal(holes.count, 3, 'three boundary edges of the missing face — seams between the joined parts are not holes');
  assert.equal(holes.autoFixAvailable, true, 'repairable as one solid');
});

console.log('\n' + out.join('\n'));
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
