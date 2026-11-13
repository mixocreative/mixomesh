// Split to parts / Join (owner decision 2026-09-18): separating a
// multi-material import into independently movable objects — and merging
// objects back into one logical object — is explicit, undoable, and never
// touches geometry or shaders.
//   node --import ./tests/register-hooks.mjs tests/split-join.test.mjs

import assert from 'node:assert/strict';
import { installEnv } from './env.mjs';

installEnv();
console.error = () => {};
const { setState, getState, subscribe } = await import('../src/core/StateManager.js');
const { EVENTS } = await import('../src/core/events.js');
const { SplitToPartsCommand, JoinCommand, SeparateSelectionCommand } = await import('../src/core/HistoryManager.js');
const { AssetLoader } = await import('../src/core/AssetLoader.js');
const { SceneManager } = await import('../src/core/SceneManager.js');
const { Selection } = await import('../src/core/Selection.js');
const History = await import('../src/core/HistoryManager.js');
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
  assert.equal(s.objects.part.name, 'Bowl.001', 'part named after the lead, readable and unique');
  assert.equal(logicalObjectPartIds('lead', s.objects).length, 1, 'lead is single-part now');
  const groups = Object.values(s.groups);
  assert.equal(groups.length, 1, 'one new group');
  assert.equal(groups[0].name, 'Bowl parts');
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
  assert.equal(getState().scene.objects.part.name, 'Bowl.001');
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
  const inner = Object.values(s.groups).find(g => g.name === 'Bowl parts');
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

await test('split: three parts -> .001/.002 names, group "<lead> parts", unique on collision, undo/redo', () => {
  const o = twoPartObject();
  o.third = base('third', 'Bowl_primitive2', { logicalObjectId: 'lead', isInternalPart: true, _tris: [[1, 2, 3]] });
  o.other = base('other', 'Bowl.001', { _tris: [[0, 2, 1]] });   // collides with first generated name
  seed(o, { gOld: { id: 'gOld', name: 'Bowl parts', parentId: null, childIds: [], origin: 'user' } });
  const cmd = new SplitToPartsCommand('lead');
  cmd.execute();
  const s = getState().scene;
  assert.equal(s.objects.lead.name, 'Bowl');
  const names = [s.objects.part.name, s.objects.third.name];
  assert.deepEqual(names, ['Bowl.002', 'Bowl.003'], 'unique against existing Bowl.001');
  assert.equal(new Set(Object.values(s.objects).map(x => x.name)).size, 4, 'all names unique');
  const grp = Object.values(s.groups).find(g => g.id !== 'gOld');
  assert.equal(grp.name, 'Bowl parts.001', 'group name unique among groups');
  cmd.undo();
  assert.equal(getState().scene.objects.part.name, 'Bowl_primitive1');
  assert.equal(Object.keys(getState().scene.groups).length, 1);
  cmd.execute();
  assert.equal(Object.keys(getState().scene.groups).length, 2);
});

await test('join after split: parts return to the lead, emptied "<lead> parts" group removed; undo restores', () => {
  seed(twoPartObject());
  const split = new SplitToPartsCommand('lead');
  split.execute();
  const afterSplit = structuredClone(getState().scene);
  const join = new JoinCommand(['lead', 'part'], { leadId: 'lead' });
  join.execute();
  let s = getState().scene;
  assert.equal(join.applied, true);
  assert.equal(Object.keys(s.groups).length, 0, 'no orphan group left behind');
  assert.equal(s.objects.part.parentId, null);
  assert.equal(s.objects.lead.parentId, null);
  assert.deepEqual(logicalObjectPartIds('lead', s.objects), ['lead', 'part']);
  assert.equal(meshes.get('part').parent, null);
  join.undo();
  s = getState().scene;
  assert.deepEqual(s.groups, afterSplit.groups, 'group restored');
  assert.deepEqual(s.objects, afterSplit.objects, 'objects restored');
  join.execute();
  assert.equal(Object.keys(getState().scene.groups).length, 0, 'redo removes the group again');
});

await test('join: a part outside the lead\'s group is reparented next to the lead; non-parts groups untouched', () => {
  const o = {
    a: base('a', 'Cup', { parentId: 'gKeep', _tris: [[0, 2, 1]] }),
    b: base('b', 'Handle', { parentId: 'gUser', _tris: [[0, 3, 2]] }),
  };
  seed(o, {
    gKeep: { id: 'gKeep', name: 'Keep', parentId: null, childIds: ['a'], origin: 'user' },
    gUser: { id: 'gUser', name: 'Mine', parentId: null, childIds: ['b'], origin: 'user' },
  });
  const k = new FakeNode('Keep'); k.metadata = { groupId: 'gKeep' };
  const u = new FakeNode('Mine'); u.metadata = { groupId: 'gUser' };
  meshes.get('a').parent = k; meshes.get('b').parent = u;
  const cmd = new JoinCommand(['a', 'b'], { leadId: 'a' });
  cmd.execute();
  const s = getState().scene;
  assert.equal(s.objects.b.parentId, 'gKeep');
  assert.ok(s.groups.gUser, 'emptied user group is NOT a parts group, so it stays');
  cmd.undo();
  assert.equal(getState().scene.objects.b.parentId, 'gUser');
  assert.deepEqual(getState().scene.groups.gKeep.childIds, ['a']);
});

await test('PrintPartCommand on any part toggles every part of the logical object; one undo restores', async () => {
  seed(twoPartObject());
  setState(s => ({ ...s, scene: { ...s.scene, objects: { ...s.scene.objects, part: { ...s.scene.objects.part, isPrintPart: false } } } }), { silent: true });
  const { PrintPartCommand } = await import('../src/core/HistoryManager.js');
  const cmd = new PrintPartCommand('part', false, true);
  cmd.execute();
  assert.equal(getState().scene.objects.lead.isPrintPart, true);
  assert.equal(getState().scene.objects.part.isPrintPart, true);
  cmd.undo();
  assert.equal(getState().scene.objects.lead.isPrintPart, true, 'lead flag prior value restored');
  assert.equal(getState().scene.objects.part.isPrintPart, false);
  const off = new PrintPartCommand('part', true, false);
  off.execute();
  assert.equal(getState().scene.objects.lead.isPrintPart, false);
});

await test('a part keeps a name the operator chose through merge and separate; a derived one is replaced', () => {
  // The owner's case: "hook" merged into "denture" must come back as "hook".
  // A name the APP derived (the import's `<lead>_primitive1`, or a previous
  // split's `<lead>.001`) is not the operator's and still gets a fresh one --
  // which is what the 2-part import test above pins.
  seed({
    denture: base('denture', 'denture', { _tris: [[0, 2, 1]] }),
    hook: base('hook', 'hook', { _tris: [[0, 1, 3]] }),
  });
  new JoinCommand(['denture', 'hook'], { leadId: 'denture' }).execute();
  assert.equal(getState().scene.objects.hook.name, 'hook', 'the merge never renamed it');
  const split = new SplitToPartsCommand('denture');
  split.execute();
  assert.equal(getState().scene.objects.hook.name, 'hook', 'and the separate gives it back, not "denture.001"');
  split.undo();
  assert.equal(getState().scene.objects.hook.name, 'hook');
  // Derived names, each replaced: the lead's name itself, the import form, an earlier split's form.
  for (const [id, name] of [['a', 'denture'], ['b', 'denture_primitive1'], ['c', 'denture.007']]) {
    seed({
      denture: base('denture', 'denture', { logicalObjectId: 'denture', _tris: [[0, 2, 1]] }),
      [id]: base(id, name, { logicalObjectId: 'denture', isInternalPart: true, _tris: [[0, 1, 3]] }),
    });
    new SplitToPartsCommand('denture').execute();
    assert.equal(getState().scene.objects[id].name, 'denture.001', `${name} is a derived name`);
  }
});

await test('separating drops the union repair record, warns, and undo restores it (gap 2)', () => {
  // THE DEFECT. A multi-part object is repaired as ONE solid on the welded union of its parts, and
  // `groupRepair` is recorded on EVERY part so a reload replays it once for the whole object.
  // Separate them and the reload walks each object, finds the record, and replays it on THAT OBJECT
  // ALONE — a per-part repair of a union that no longer exists, which is the internal-wall result
  // GroupRepair was written to avoid. The project would reload as different geometry from the one
  // on screen, and nothing said so.
  const fixes = ['holes', 'groupRepair'];
  seed({
    lead: base('lead', 'Bowl', { logicalObjectId: 'lead', geometryFixes: [...fixes], _tris: [[0, 2, 1]] }),
    part: base('part', 'Handle', { logicalObjectId: 'lead', isInternalPart: true, geometryFixes: [...fixes], _tris: [[0, 1, 3]] }),
  });
  const toasts = [];
  const off = subscribe(EVENTS.TOAST, (p) => toasts.push(p));
  const cmd = new SplitToPartsCommand('lead');
  cmd.execute();
  let s = getState().scene.objects;
  // Only the union-specific entry goes: every other fix type replays correctly per object.
  assert.deepEqual(s.lead.geometryFixes, ['holes'], 'lead keeps its per-mesh fixes');
  assert.deepEqual(s.part.geometryFixes, ['holes'], 'and so does the part');
  assert.equal(toasts.length, 1, 'the operator is told the repair cannot be reproduced');
  assert.equal(toasts[0].type, 'warning');
  cmd.undo();
  s = getState().scene.objects;
  assert.deepEqual(s.lead.geometryFixes, fixes, 'undo restores the record');
  assert.deepEqual(s.part.geometryFixes, fixes);
  // Separate selection takes BOTH sides: the object left behind is a different union too.
  seed({
    lead: base('lead', 'Bowl', { logicalObjectId: 'lead', geometryFixes: [...fixes], _tris: [[0, 2, 1]] }),
    a: base('a', 'A', { logicalObjectId: 'lead', isInternalPart: true, geometryFixes: [...fixes], _tris: [[0, 1, 3]] }),
    b: base('b', 'B', { logicalObjectId: 'lead', isInternalPart: true, geometryFixes: [...fixes], _tris: [[0, 3, 2]] }),
  });
  toasts.length = 0;
  new SeparateSelectionCommand(['a']).execute();
  s = getState().scene.objects;
  for (const id of ['lead', 'a', 'b']) assert.deepEqual(s[id].geometryFixes, ['holes'], `${id} lost only the union fix`);
  assert.equal(toasts.length, 1);
  // An object with no union repair says nothing: this must not warn on every separate.
  seed({
    lead: base('lead', 'Bowl', { logicalObjectId: 'lead', geometryFixes: ['holes'], _tris: [[0, 2, 1]] }),
    part: base('part', 'Handle', { logicalObjectId: 'lead', isInternalPart: true, _tris: [[0, 1, 3]] }),
  });
  toasts.length = 0;
  new SplitToPartsCommand('lead').execute();
  assert.equal(toasts.length, 0, 'nothing to invalidate, nothing said');
  off();
});

await test('separating moves nothing in world space and mints no geometry (gaps 4 and 5)', () => {
  // THIS IS THE ENFORCEMENT of U5 gaps 4 and 5 — see "If a topological split is ever proposed" at the
  // end of docs/plans/2026-11-12-parts-and-focus-mode.md.
  //
  // What is assertable now is that this separate is not a topological split: it moves link fields
  // only. So there is no origin to choose (gap 4 — and "nothing may move in world space" is asserted
  // below) and no owned geometry to mint, which is why it needs no derived asset with
  // `retainedTriangles`/`release` and cannot evict undo history (gap 5). **A topological split added
  // to these commands fails these assertions**, which is the point: it must bring its own answers to
  // both rather than inherit a silence from code that never needed them.
  seed({
    lead: base('lead', 'Bowl', { logicalObjectId: 'lead', _tris: [[0, 2, 1]] }),
    part: base('part', 'Handle', { logicalObjectId: 'lead', isInternalPart: true, _tris: [[0, 1, 3]] }),
  });
  const posOf = () => Object.fromEntries(['lead', 'part'].map((id) => {
    const mesh = meshes.get(id);
    return [id, [mesh.position.x, mesh.position.y, mesh.position.z, ...(mesh.positions ?? [])]];
  }));
  const before = JSON.stringify(posOf());
  const assets = new Set(Object.values(getState().scene.objects).map((o) => o.assetId));
  const cmd = new SeparateSelectionCommand(['part']);
  cmd.execute();
  assert.equal(JSON.stringify(posOf()), before, 'no vertex and no node moved');
  assert.deepEqual(new Set(Object.values(getState().scene.objects).map((o) => o.assetId)), assets, 'no new asset minted');
  assert.equal(typeof cmd.retainedTriangles, 'undefined', 'nothing retained, so the undo cap is untouched');
  assert.equal(typeof cmd.release, 'undefined');
  cmd.undo();
  assert.equal(JSON.stringify(posOf()), before, 'and the undo moves nothing either');
});

await test('a Join warns when it swallows an object built at another print scale', () => {
  // Each object's `ratio` is baked into its vertices, so the merge resizes nothing — but the export
  // reads the LEAD's ratio as the reference for a target size, and the swallowed object's own
  // becomes a field nothing reads. Ask for 1:1 afterwards and the factor comes from the lead's
  // provenance. Reported rather than corrected: re-baking vertices is what Join must never do.
  seed({
    a: base('a', 'Body', { ratio: 1, _tris: [[0, 2, 1]] }),
    b: base('b', 'Arm', { ratio: 2, _tris: [[0, 1, 3]] }),
  });
  const toasts = [];
  const off = subscribe(EVENTS.TOAST, (p) => toasts.push(p));
  new JoinCommand(['a', 'b'], { leadId: 'a' }).execute();
  assert.equal(toasts.length, 1, 'the operator is told');
  assert.equal(toasts[0].type, 'warning');
  assert.ok(toasts[0].message.includes('Arm') && toasts[0].message.includes('Body'), `names both: ${toasts[0].message}`);
  // Matching ratios say nothing, and a missing field reads as 1 the way `objectRatio` does.
  for (const pair of [{ a: 2, b: 2 }, { a: undefined, b: 1 }, { a: 1, b: undefined }]) {
    seed({ a: base('a', 'Body', { ratio: pair.a, _tris: [[0, 2, 1]] }), b: base('b', 'Arm', { ratio: pair.b, _tris: [[0, 1, 3]] }) });
    toasts.length = 0;
    new JoinCommand(['a', 'b'], { leadId: 'a' }).execute();
    assert.equal(toasts.length, 0, `no warning for ${JSON.stringify(pair)}`);
  }
  off();
});

await test('a Join drops the swallowed object supports, warns, and undo brings them back', async () => {
  // THE DEFECT: supports live on the LEAD and every read redirects there
  // (src/supports/store.ts). Merge an unsupported object INTO a supported one
  // and the record is unreachable while still in the save file: the operator is
  // told nothing, export is not blocked, and the print goes out unsupported.
  const record = { revision: 3, settings: { preset: 'MIDDLE' }, manual: [], deleted: [], stamps: [], overrides: {}, sourceHash: 'h' };
  seed({
    a: base('a', 'Body', { _tris: [[0, 2, 1]] }),
    b: base('b', 'Arm', { _tris: [[0, 1, 3]], supports: record }),
  });
  const toasts = [];
  const updated = [];
  const off = subscribe(EVENTS.TOAST, (p) => toasts.push(p));
  const offUpdated = subscribe(EVENTS.OBJECT_UPDATED, (p) => updated.push(p?.meshId));
  const join = new JoinCommand(['a', 'b'], { leadId: 'a' });
  join.execute();
  assert.equal(getState().scene.objects.b.supports, undefined, 'the swallowed record is gone, not left unreachable');
  assert.ok('supports' in getState().scene.objects.b === false, 'the field is removed, not set to undefined');
  assert.equal(getState().scene.objects.a.supports, undefined, 'the lead had none and still has none');
  assert.equal(toasts.length, 1, 'the operator is told');
  assert.equal(toasts[0].type, 'warning');
  assert.ok(toasts[0].message.includes('Arm'), `names the object: ${toasts[0].message}`);
  // And the LEAD's own supports must be re-judged, because the logical object's geometry union just
  // changed: `_applyLinkPatches` dispatches OBJECT_UPDATED per patched id, which is what the stale
  // watch listens to (src/supports/stale.ts). Without it, supports built for A alone would still
  // read as current on A+B -- and supports that clear A can cross B.
  assert.ok(updated.includes('a'), `the lead is reported updated: ${updated.join(',')}`);
  join.undo();
  assert.deepEqual(getState().scene.objects.b.supports, record, 'undo brings the record back whole');
  // A lead that HAS supports keeps them: they are the merged object's own.
  seed({ a: base('a', 'Body', { _tris: [[0, 2, 1]], supports: record }), b: base('b', 'Arm', { _tris: [[0, 1, 3]] }) });
  toasts.length = 0;
  new JoinCommand(['a', 'b'], { leadId: 'a' }).execute();
  assert.deepEqual(getState().scene.objects.a.supports, record, 'the lead keeps its own');
  assert.equal(toasts.length, 0, 'nothing was lost, so nothing is said');
  off();
  offUpdated();
});

await test('separate selection: the picked parts become ONE new object, the rest stay', () => {
  // The owner's ask: enter an object, pick meshes, separate them.
  const three = () => ({
    body: base('body', 'body', { logicalObjectId: 'body', _tris: [[0, 2, 1]] }),
    armA: base('armA', 'armA', { logicalObjectId: 'body', isInternalPart: true, _tris: [[0, 1, 3]] }),
    armB: base('armB', 'armB', { logicalObjectId: 'body', isInternalPart: true, _tris: [[0, 3, 2]] }),
  });
  seed(three());
  const cmd = new SeparateSelectionCommand(['armA']);
  cmd.execute();
  assert.equal(cmd.applied, true);
  let s = getState().scene.objects;
  assert.equal(s.armA.isInternalPart, false, 'the picked part leads a new object');
  assert.equal(s.armA.logicalObjectId, 'armA');
  assert.equal(s.armA.name, 'armA', 'it keeps the name the operator chose');
  assert.deepEqual(logicalObjectPartIds('body', s).sort(), ['armB', 'body'], 'the rest stay together');
  assert.equal(canonicalObjectId('armA', s), 'armA', 'and are no longer part of it');
  cmd.undo();
  s = getState().scene.objects;
  assert.equal(s.armA.isInternalPart, true, 'undo puts it back');
  assert.deepEqual(logicalObjectPartIds('body', s).sort(), ['armA', 'armB', 'body']);
});

await test('separate selection: taking the LEAD hands the rest a new lead', () => {
  seed({
    body: base('body', 'body', { logicalObjectId: 'body', _tris: [[0, 2, 1]] }),
    armA: base('armA', 'armA', { logicalObjectId: 'body', isInternalPart: true, _tris: [[0, 1, 3]] }),
    armB: base('armB', 'armB', { logicalObjectId: 'body', isInternalPart: true, _tris: [[0, 3, 2]] }),
  });
  const cmd = new SeparateSelectionCommand(['body']);
  cmd.execute();
  const s = getState().scene.objects;
  assert.equal(s.body.logicalObjectId, 'body', 'the taken lead leads its own new object');
  assert.equal(s.body.isInternalPart, false);
  // The object left behind cannot be led by a part that has gone.
  const keptLead = canonicalObjectId('armA', s);
  assert.equal(keptLead, 'armA', 'the first remaining part takes over');
  assert.equal(s.armA.isInternalPart, false);
  assert.equal(s.armB.logicalObjectId, 'armA');
  assert.deepEqual(logicalObjectPartIds('armA', s).sort(), ['armA', 'armB']);
  cmd.undo();
  assert.equal(canonicalObjectId('armA', getState().scene.objects), 'body', 'undo restores the old lead');
});

await test('separate selection: refuses nothing, everything, and parts of two objects', () => {
  seed({
    body: base('body', 'body', { logicalObjectId: 'body', _tris: [[0, 2, 1]] }),
    armA: base('armA', 'armA', { logicalObjectId: 'body', isInternalPart: true, _tris: [[0, 1, 3]] }),
    other: base('other', 'other', { _tris: [[0, 3, 2]] }),
  });
  for (const picked of [[], ['body', 'armA'], ['armA', 'other'], ['missing']]) {
    const cmd = new SeparateSelectionCommand(picked);
    cmd.execute();
    assert.equal(cmd.applied, false, `refused: ${JSON.stringify(picked)}`);
  }
  // Every part picked is SplitToParts work, not this; the object is untouched.
  assert.deepEqual(logicalObjectPartIds('body', getState().scene.objects).sort(), ['armA', 'body']);
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

await test('a structural edit never leaves a selected id the outliner cannot show', () => {
  // The invariant: `Selection.set` canonicalises, so everything downstream may assume
  // `selectedIds` holds DISPLAYABLE ids -- the outliner compares them against its row ids
  // directly (`Outliner.js:705`), and only a lead has a row.
  //
  // Two edits used to break it, and both LOOKED fine: reads resolve through
  // `logicalObjectPartIds`, which canonicalises, so the gizmo and the outline covered the right
  // object while the list alone showed nothing selected.
  const three = () => ({
    body: base('body', 'body', { logicalObjectId: 'body', _tris: [[0, 2, 1]] }),
    armA: base('armA', 'armA', { logicalObjectId: 'body', isInternalPart: true, _tris: [[0, 1, 3]] }),
    armB: base('armB', 'armB', { logicalObjectId: 'body', isInternalPart: true, _tris: [[0, 3, 2]] }),
  });
  const everySelectedIdHasARow = (where) => {
    const objects = getState().scene.objects;
    for (const id of Selection.getSelectedIds()) {
      assert.ok(shouldDisplayObject(objects[id]), `${where}: ${id} is not a row the outliner draws`);
    }
  };
  const freshSelection = () => setState(
    st => ({ ...st, selection: { selectedIds: [], activeId: null, pivotMode: 'active' } }), { silent: true });

  // 1. Separate, then undo. The new object is selected (what `PartScopeMode.separate` does), and
  //    undo makes that id an internal part again.
  seed(three());
  freshSelection();
  const sep = new SeparateSelectionCommand(['armA']);
  History.push(sep);
  Selection.set([sep.newObjectId], sep.newObjectId);
  assert.deepEqual(Selection.getSelectedIds(), ['armA'], 'the new object is selected after the edit');
  History.undo();
  everySelectedIdHasARow('after undo of a separate');
  assert.deepEqual(Selection.getSelectedIds(), ['body'], 'it follows the part back into the object it rejoined');

  // 2. Join, on the DO. The swallowed object is selected and becomes an internal part -- the same
  //    defect without an undo in sight, which is why the repair is on every structural change.
  seed({ a: base('a', 'Body', { _tris: [[0, 2, 1]] }), b: base('b', 'Arm', { _tris: [[0, 1, 3]] }) });
  freshSelection();
  Selection.set(['b'], 'b');
  History.push(new JoinCommand(['a', 'b'], { leadId: 'a' }));
  everySelectedIdHasARow('after a join');
  assert.deepEqual(Selection.getSelectedIds(), ['a'], 'the selection follows the object into its new lead');

  // 3. And redo, the third way through: it re-runs `execute`, so it needs the same repair.
  History.undo();
  Selection.set(['b'], 'b');
  History.redo();
  everySelectedIdHasARow('after redo of a join');
});

await test('a split never changes the print scale an object was being printed at', async () => {
  /*
   * Found 2026-11-13 by walking merge-then-separate, which is two documented operations.
   *
   * `objectRatio` reads the LEAD's `ratio` -- the scale term for an object at import, display and
   * export. A part that is not the lead keeps a `ratio` field nothing reads, and a merge
   * deliberately leaves it there while WARNING that the lead's scale now applies (gap 6).
   * Separating it out again made it a lead, promoting that stale field back into the reference: an
   * object merged in at 1:2 and separated out came back declaring 1:2, silently, with the geometry
   * untouched the whole time.
   *
   * Both commands that promote a part to an object are covered, because both had it.
   */
  const ratioOf = (id) => getState().scene.objects[id].ratio;

  // 1. Separate, after a merge that crossed scales.
  seed({ a: base('a', 'Body', { ratio: 1, _tris: [[0, 2, 1]] }), b: base('b', 'Arm', { ratio: 0.5, _tris: [[0, 1, 3]] }) });
  new JoinCommand(['a', 'b'], { leadId: 'a' }).execute();
  assert.equal(ratioOf('b'), 0.5, 'the merge leaves the swallowed scale in place (it only warns)');
  const sep = new SeparateSelectionCommand(['b']);
  sep.execute();
  assert.equal(ratioOf('b'), 1, 'separated, it keeps the scale it was being PRINTED at, not the stale field');
  assert.equal(ratioOf('a'), 1, 'and the object left behind is untouched');
  sep.undo();
  assert.equal(ratioOf('b'), 0.5, 'undo restores the field exactly -- a patch undo cannot reverse is worse than the defect');

  // 2. The lead itself taken: the object LEFT BEHIND gets a new lead, whose ratio becomes the
  //    reference too. This is the side a one-sided fix would have missed.
  seed({
    body: base('body', 'body', { logicalObjectId: 'body', ratio: 1, _tris: [[0, 2, 1]] }),
    armA: base('armA', 'armA', { logicalObjectId: 'body', isInternalPart: true, ratio: 0.25, _tris: [[0, 1, 3]] }),
    armB: base('armB', 'armB', { logicalObjectId: 'body', isInternalPart: true, ratio: 0.1, _tris: [[0, 3, 2]] }),
  });
  new SeparateSelectionCommand(['body']).execute();
  assert.equal(ratioOf('body'), 1, 'the part that left keeps the object scale');
  assert.equal(ratioOf('armA'), 1, 'and so does the new lead of what remains');

  // 3. Split to parts: every id becomes its own object, so every one needs it.
  seed({
    lead: base('lead', 'Bowl', { logicalObjectId: 'lead', ratio: 2, _tris: [[0, 2, 1]] }),
    p1: base('p1', 'Bowl_primitive1', { logicalObjectId: 'lead', isInternalPart: true, ratio: 0.5, _tris: [[0, 1, 3]] }),
  });
  const split = new SplitToPartsCommand('lead');
  split.execute();
  assert.equal(ratioOf('p1'), 2, 'a split part is printed at the scale its object was');
  assert.equal(ratioOf('lead'), 2);
  split.undo();
  assert.equal(ratioOf('p1'), 0.5, 'and undo puts the field back');
});

console.log('\n' + out.join('\n'));
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
