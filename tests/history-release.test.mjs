// History never pins a big mesh forever (heavy-mesh spec §4, task g).
import test from 'node:test';
import assert from 'node:assert/strict';
import { installEnv } from './env.mjs';

installEnv();
const BABYLON = { ...await import('@babylonjs/core') };
globalThis.window.BABYLON = { ...globalThis.window.BABYLON, ...BABYLON };
const HM = await import('../src/core/HistoryManager.js');
const Registry = await import('../src/core/assets/MeshRegistry.js');
const { revisionOf, bump, extract } = await import('../src/core/geometry/GeometryStore.js');

function cmd(label, retained = 0, side = 'undo') {
  const c = { label, released: [], execute() {}, undo() {} };
  c.retainedTriangles = (s) => (s === side ? retained : 0);
  c.release = (s) => c.released.push(s);
  return c;
}

test('an entry leaving the 200-step window is released (undo side)', () => {
  HM.clear(); HM.setRetainCap(Infinity);
  const first = cmd('first', 10);
  HM.push(first);
  for (let i = 0; i < 200; i++) HM.push(cmd(`n${i}`));
  assert.deepEqual(first.released, ['undo']);
});

test('a dropped redo branch is released (redo side)', () => {
  HM.clear(); HM.setRetainCap(Infinity);
  const a = cmd('a');
  HM.push(a);
  HM.undo();
  HM.push(cmd('b'));
  assert.deepEqual(a.released, ['redo']);
});

test('retained triangles over the cap trim the oldest entries; the newest always stays', () => {
  HM.clear(); HM.setRetainCap(100);
  const a = cmd('a', 80), mid = cmd('mid', 0), b = cmd('b', 80);
  HM.push(a); HM.push(mid); HM.push(b);
  assert.deepEqual(a.released, ['undo']);
  assert.deepEqual(mid.released, [], 'trimming stops as soon as the total fits');
  assert.deepEqual(b.released, []);
  assert.equal(HM.getUndoLabel(), 'b');
  const huge = cmd('huge', 10_000);
  HM.push(huge);
  assert.deepEqual(mid.released, ['undo'], 'oldest first, in stack order');
  assert.deepEqual(b.released, ['undo']);
  assert.deepEqual(huge.released, [], 'the newest entry stays undoable even over the cap');
  HM.setRetainCap(null);
});

test('batches forward retainedTriangles and release to their children', () => {
  HM.clear(); HM.setRetainCap(50);
  const inner = cmd('inner', 60);
  HM.beginBatch('batch'); HM.push(inner); HM.endBatch();
  HM.push(cmd('next', 0));
  assert.deepEqual(inner.released, ['undo']);
  HM.setRetainCap(null);
  HM.clear();
});

const engine = new BABYLON.NullEngine({ renderWidth: 32, renderHeight: 32, textureSize: 32 });
const scene = new BABYLON.Scene(engine);

test('releaseMesh disposes, unregisters, forgets the revision and keeps container slots stable', () => {
  const a = BABYLON.MeshBuilder.CreateBox('a', {}, scene);
  const b = BABYLON.MeshBuilder.CreateBox('b', {}, scene);
  a.metadata = { meshId: 'mesh_a' }; b.metadata = { meshId: 'mesh_b' };
  Registry.registerContainer('asset_x', { meshes: [a, b] });
  Registry.registerMesh('mesh_a', a); Registry.registerMesh('mesh_b', b);
  bump('mesh_a');
  assert.equal(revisionOf('mesh_a'), 1);
  assert.equal(Registry.releaseMesh('mesh_a', a), true);
  assert.equal(a.isDisposed(), true);
  assert.equal(Registry.getBabylonMesh('mesh_a'), null);
  assert.equal(revisionOf('mesh_a'), 0);
  // The serializer finds b at index 1 still — a reload maps it to the same mesh.
  assert.equal(Registry.getContainerGeomMeshes('asset_x').findIndex(m => m.metadata?.meshId === 'mesh_b'), 1);
  assert.equal(Registry.releaseMesh('mesh_a', a), false, 'idempotent');
  Registry.resetRegistry();
});

test('DeleteCommand / BooleanCommand release only meshes that are still hidden', async () => {
  const { DeleteCommand } = await import('../src/core/commands/HierarchyCommands.js');
  const { BooleanCommand } = await import('../src/core/commands/BooleanCommands.js');
  for (const Cmd of [DeleteCommand, BooleanCommand]) {
    const hidden = BABYLON.MeshBuilder.CreateBox('h', {}, scene);
    const live = BABYLON.MeshBuilder.CreateBox('l', {}, scene);
    hidden.setEnabled(false);
    const c = Object.create(Cmd.prototype);
    c._snapshots = [{ id: 'mesh_h', mesh: hidden }, { id: 'mesh_l', mesh: live }];
    assert.equal(c.retainedTriangles('undo'), 24);
    assert.equal(c.retainedTriangles('redo'), 0);
    c.release('redo');
    assert.equal(hidden.isDisposed(), false, 'redo side holds nothing');
    c.release('undo');
    assert.equal(hidden.isDisposed(), true);
    assert.equal(live.isDisposed(), false, 'a mesh back in the scene is never freed');
    assert.equal(c.retainedTriangles('undo'), 12);
  }
});

test('extract copies typed arrays and builds the 0..n index without a callback', () => {
  const m = { getVerticesData: () => new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), getIndices: () => null, metadata: {} };
  const out = extract(m);
  assert.deepEqual([...out.indices], [0, 1, 2]);
  const src = new Uint32Array([2, 1, 0]);
  const m2 = { ...m, getIndices: () => src };
  const out2 = extract(m2);
  assert.notEqual(out2.indices, src);
  assert.deepEqual([...out2.indices], [2, 1, 0]);
});

test('cap trimming tells the user once; shared geometry counts as nothing retained (review M5)', async () => {
  const { EVENTS } = await import('../src/core/events.js');
  const { subscribe } = await import('../src/core/StateManager.js');
  const toasts = [];
  const off = subscribe(EVENTS.TOAST, (e) => toasts.push(e));
  HM.clear(); HM.setRetainCap(100);
  HM.push(cmd('a', 80)); HM.push(cmd('b', 80));
  assert.equal(toasts.length, 1);
  assert.match(toasts[0].message, /undo/i);
  HM.push(cmd('c', 0));
  assert.equal(toasts.length, 1, 'no toast when nothing held was dropped');
  off?.(); HM.setRetainCap(null); HM.clear();
  const { retainedTrianglesOf } = await import('../src/core/commands/HierarchyCommands.js');
  const src = BABYLON.MeshBuilder.CreateBox('src', {}, scene);
  const dup = src.clone('dup');
  src.setEnabled(false);
  assert.equal(retainedTrianglesOf(src), 0, 'a live duplicate shares the geometry');
  dup.dispose();
  assert.equal(retainedTrianglesOf(src), 12);
});

test('releaseMesh keeps live content children, disposes helper children (review M6)', () => {
  const parent = BABYLON.MeshBuilder.CreateBox('p', {}, scene);
  const content = BABYLON.MeshBuilder.CreateBox('c', {}, scene);
  const helper = BABYLON.MeshBuilder.CreateBox('h', {}, scene);
  content.metadata = { meshId: 'mesh_c' }; Registry.registerMesh('mesh_c', content);
  content.parent = parent; helper.parent = parent;
  Registry.releaseMesh('mesh_p', parent);
  assert.equal(parent.isDisposed(), true);
  assert.equal(content.isDisposed(), false);
  assert.equal(content.parent, null);
  assert.equal(helper.isDisposed(), true);
});
