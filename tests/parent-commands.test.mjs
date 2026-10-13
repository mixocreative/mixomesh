// ParentCommands (overhaul 6.6b): reparent/unparent world preservation,
// hierarchy refusal, group create/ungroup undo/redo.
//   node --import ./tests/register-hooks.mjs tests/parent-commands.test.mjs

import assert from 'node:assert/strict';
import test from 'node:test';
import { installEnv } from './env.mjs';

installEnv();
const BABYLON = await import('@babylonjs/core');
globalThis.window.BABYLON = BABYLON;
globalThis.window.removeEventListener = () => {};
globalThis.document.addEventListener = () => {};
globalThis.document.removeEventListener = () => {};
const { ReparentCommand, UnparentCommand, CreateGroupCommand, UngroupCommand, uniqueGroupName } =
  await import('../src/core/commands/ParentCommands.js');
const { SceneManager } = await import('../src/core/SceneManager.js');
const { AssetLoader } = await import('../src/core/AssetLoader.js');
const { Selection } = await import('../src/core/Selection.js');
const { setState, getState, subscribe } = await import('../src/core/StateManager.js');
const { EVENTS } = await import('../src/core/events.js');

const engine = new BABYLON.NullEngine({ renderWidth: 64, renderHeight: 64, textureSize: 64 });
const scene = new BABYLON.Scene(engine);
const meshes = new Map();
SceneManager.getScene = () => scene;
SceneManager.attachToSelection = () => {};
AssetLoader.getBabylonMesh = id => meshes.get(id) ?? null;
Selection.refresh = () => {};
Selection.set = () => {};
Selection.clear = () => {};

const V = (x, y, z) => new BABYLON.Vector3(x, y, z);
function near(a, b, msg, eps = 1e-4) {
  for (const k of ['x', 'y', 'z']) assert.ok(Math.abs(a[k] - b[k]) < eps, `${msg}: ${k} ${a[k]} != ${b[k]}`);
}
const world = n => { n.computeWorldMatrix(true); return n.getAbsolutePosition().clone(); };
const groupNode = id => scene.transformNodes.find(t => t.metadata?.groupId === id);

/**
 * g1 at (10,0,0) rotated 90deg about Y, scale 2, holds a (local (1,0,0)).
 * g2 (empty-ish) at (0,0,20). Loose boxes b (3,0,0) and c (0,0,-5).
 * g3 is a child of g1 (local (0,5,0)).
 */
function build() {
  meshes.clear();
  for (const m of [...scene.meshes]) m.dispose();
  for (const t of [...scene.transformNodes]) t.dispose();
  const mkGroup = (id, pos, parent = null) => {
    const g = new BABYLON.TransformNode(id, scene);
    g.metadata = { groupId: id }; g.parent = parent; g.position = pos; return g;
  };
  const g1 = mkGroup('g1', V(10, 0, 0));
  g1.rotationQuaternion = BABYLON.Quaternion.RotationAxis(V(0, 1, 0), Math.PI / 2);
  g1.scaling = V(2, 2, 2);
  const g2 = mkGroup('g2', V(0, 0, 20));
  const g3 = mkGroup('g3', V(0, 5, 0), g1);
  const mk = (id, pos, parent) => {
    const m = BABYLON.MeshBuilder.CreateBox(id, { size: 2 }, scene);
    m.metadata = { meshId: id }; m.parent = parent; m.position = pos; meshes.set(id, m); return m;
  };
  const a = mk('a', V(1, 0, 0), g1);
  const b = mk('b', V(3, 0, 0), null);
  const c = mk('c', V(0, 0, -5), null);
  const obj = (id, parentId) => ({
    id, name: id, assetId: 'a1', parentId, shaderId: null, visible: true, locked: false,
    isGhost: false, isPrintPart: true, collectionId: null, sourceGroupId: null,
  });
  setState(s => ({ ...s, scene: { ...s.scene,
    objects: { a: obj('a', 'g1'), b: obj('b', null), c: obj('c', null) },
    groups: {
      g1: { id: 'g1', name: 'G1', parentId: null, childIds: ['a'], origin: 'user' },
      g2: { id: 'g2', name: 'G2', parentId: null, childIds: [], origin: 'user' },
      g3: { id: 'g3', name: 'G3', parentId: 'g1', childIds: [], origin: 'user' },
    },
  } }), { silent: true });
  for (const n of [...scene.transformNodes, ...scene.meshes]) n.computeWorldMatrix(true);
  return { g1, g2, g3, a, b, c };
}
const parentOf = id => getState().scene.objects[id]?.parentId ?? getState().scene.groups[id]?.parentId ?? null;
const kids = id => [...getState().scene.groups[id].childIds];

test('Reparent object into a group preserves world (incl. rotated/scaled parent); undo/redo exact', () => {
  const { g2, b } = build();
  const w0 = world(b);
  const cmd = new ReparentCommand('b', 'g2');
  cmd.execute();
  assert.ok(b.parent === g2, 'runtime parent set');
  assert.equal(parentOf('b'), 'g2', 'state parentId set');
  assert.deepEqual(kids('g2'), ['b'], 'group childIds updated');
  near(world(b), w0, 'world preserved on execute');
  cmd.undo();
  assert.ok(b.parent === null);
  assert.equal(parentOf('b'), null);
  assert.deepEqual(kids('g2'), []);
  near(world(b), w0, 'world preserved on undo');
  cmd.execute();
  assert.ok(b.parent === g2, 'redo reparents again');
  near(world(b), w0, 'world preserved on redo');
});

test('Reparent into a ROTATED+SCALED group keeps world and rewrites the local transform', () => {
  const { g1, b } = build();
  const w0 = world(b);
  new ReparentCommand('b', 'g1').execute();
  assert.ok(b.parent === g1);
  near(world(b), w0, 'world kept');
  assert.ok(Math.abs(b.scaling.x - 0.5) < 1e-4, `local scale compensates the parent's x2 (got ${b.scaling.x})`);
});

test('Unparent moves a grouped object to the root, preserving world; undo re-nests', () => {
  const { g1, a } = build();
  const w0 = world(a);
  const cmd = new UnparentCommand('a');
  assert.equal(cmd.label, 'Unparent');
  cmd.execute();
  assert.ok(a.parent === null);
  assert.equal(parentOf('a'), null);
  assert.deepEqual(kids('g1'), []);
  near(world(a), w0, 'world preserved');
  assert.ok(Math.abs(a.scaling.x - 2) < 1e-4, 'parent scale baked into the node');
  cmd.undo();
  assert.ok(a.parent === g1);
  assert.deepEqual(kids('g1'), ['a']);
  near(world(a), w0, 'world preserved after undo');
});

test('Reparent refuses self, descendant (cycle), missing parent and missing node — state untouched', () => {
  const { g1, g3 } = build();
  assert.throws(() => new ReparentCommand('g1', 'g1').execute(), /self-parent/);
  assert.throws(() => new ReparentCommand('g1', 'g3').execute(), /cycle/, 'group into its own child');
  assert.throws(() => new ReparentCommand('g1', 'nope').execute(), /missing parent/);
  assert.throws(() => new ReparentCommand('ghost', 'g1').execute(), /missing node/);
  assert.throws(() => new ReparentCommand('b', 'a').execute(), /missing parent/, 'a mesh object is not a legal parent');
  assert.equal(parentOf('g1'), null, 'g1 still at root');
  assert.ok(g1.parent === null);
  assert.ok(g3.parent === g1);
});

test('Reparent a subgroup between groups keeps its world and fires PARENT_CHANGED', () => {
  const { g2, g3 } = build();
  const w0 = world(g3);
  const seen = [];
  const off = subscribe(EVENTS.PARENT_CHANGED, p => seen.push(p));
  const cmd = new ReparentCommand('g3', 'g2');
  cmd.execute();
  if (typeof off === 'function') off();
  assert.ok(g3.parent === g2);
  assert.equal(parentOf('g3'), 'g2');
  near(world(g3), w0, 'subgroup world kept');
  assert.deepEqual(seen.map(p => [p.id, p.parentId, p.prevParentId]), [['g3', 'g2', 'g1']]);
  cmd.undo();
  assert.equal(parentOf('g3'), 'g1');
  near(world(g3), w0, 'world kept after undo');
});

test('CreateGroup: lowest common ancestor parent, bottom-centre origin, members keep world, undo/redo', () => {
  const { b, c } = build();
  const wb = world(b), wc = world(c);
  const cmd = new CreateGroupCommand(['b', 'c'], 'Group');
  cmd.execute();
  const gid = cmd.groupId;
  const node = groupNode(gid);
  assert.ok(node, 'group TransformNode created');
  assert.equal(getState().scene.groups[gid].parentId, null, 'loose members -> root group');
  assert.deepEqual(kids(gid).sort(), ['b', 'c']);
  assert.equal(parentOf('b'), gid);
  assert.ok(b.parent === node);
  // b spans x[2,4], c spans x[-1,1]; z[-6,-4]/[-1,1]; y[-1,1] -> bottom centre (1.5, -1, -2.5)
  near(world(node), V(1.5, -1, -2.5), 'origin at bottom-centre of the combined AABB');
  near(world(b), wb, 'b world kept'); near(world(c), wc, 'c world kept');
  cmd.undo();
  assert.equal(groupNode(gid), undefined, 'group node disposed on undo');
  assert.equal(getState().scene.groups[gid], undefined, 'group state removed');
  assert.equal(parentOf('b'), null);
  near(world(b), wb, 'b world kept after undo');
  cmd.execute();
  assert.equal(cmd.groupId, gid, 'id stable across redo');
  assert.ok(groupNode(gid)); assert.equal(parentOf('c'), gid);
  near(world(c), wc, 'c world kept after redo');
});

test('CreateGroup from members inside one group nests under that group; names are unique', () => {
  const { g1 } = build();
  const cmd = new CreateGroupCommand(['a'], 'G1');
  cmd.execute();
  const g = getState().scene.groups[cmd.groupId];
  assert.equal(g.parentId, 'g1', 'LCA of a single child = its group');
  assert.equal(g.name, 'G1.001', 'name made unique against existing G1');
  assert.equal(uniqueGroupName('G1', getState()), 'G1.002');
  assert.equal(uniqueGroupName('Fresh', getState()), 'Fresh');
  assert.ok(groupNode(cmd.groupId).parent === g1);
  cmd.undo();
  assert.equal(parentOf('a'), 'g1', 'a back in g1');
});

test('CreateGroup drops members covered by another selected group (state level)', () => {
  const { g1 } = build();
  const cmd = new CreateGroupCommand(['a', 'g1', 'b'], 'Wrap');
  cmd.execute();
  const gid = cmd.groupId;
  assert.deepEqual(kids(gid), ['b'], 'only b is a direct object child; a rides inside g1');
  assert.equal(parentOf('g1'), gid, 'g1 nested under the new group');
  assert.equal(parentOf('a'), 'g1', 'state: a keeps its own parent');
  assert.ok(g1.parent === groupNode(gid));
  cmd.undo();
  assert.equal(parentOf('g1'), null);
  assert.ok(g1.parent === null);
});

// KNOWN BUG (reported, not fixed): CreateGroupCommand.execute() builds `members`
// (FIXED) from this._ids BEFORE _ensureSnapshots() filtered out covered members, so a
// child already inside a selected group is re-parented at runtime to the new
// wrapper node (state still says parentId 'g1'), and undo never restores it.
test('CreateGroup keeps a covered child inside its own group at RUNTIME and after undo', () => {
  const { g1, a } = build();
  const wa = world(a);
  const cmd = new CreateGroupCommand(['a', 'g1', 'b'], 'Wrap');
  cmd.execute();
  assert.ok(a.parent === g1, 'runtime parent of a must stay g1');
  near(world(a), wa, 'a world unchanged');
  cmd.undo();
  assert.ok(a.parent === g1, 'a still under g1 after undo');
  near(world(a), wa, 'a world unchanged after undo');
});

test('CreateGroup with no resolvable members is a no-op; undo before execute is safe', () => {
  build();
  const before = JSON.stringify(Object.keys(getState().scene.groups));
  const cmd = new CreateGroupCommand(['missing'], 'X');
  cmd.execute();
  cmd.undo();
  assert.equal(JSON.stringify(Object.keys(getState().scene.groups)), before);
});

test('Ungroup: children move to the group parent keeping world; undo restores group exactly; redo again', () => {
  const { g1, a } = build();
  const wa = world(a);
  const g3w = world(scene.transformNodes.find(t => t.name === 'g3'));
  const cmd = new UngroupCommand('g1');
  cmd.execute();
  assert.equal(getState().scene.groups.g1, undefined, 'g1 gone');
  assert.equal(groupNode('g1'), undefined, 'g1 node disposed');
  assert.equal(parentOf('a'), null, 'a promoted to root');
  assert.equal(parentOf('g3'), null, 'subgroup promoted to root');
  near(world(a), wa, 'a world kept');
  near(world(groupNode('g3')), g3w, 'g3 world kept');
  cmd.undo();
  const g1n = groupNode('g1');
  assert.ok(g1n, 'g1 node recreated');
  assert.equal(parentOf('a'), 'g1'); assert.equal(parentOf('g3'), 'g1');
  assert.deepEqual(kids('g1'), ['a']);
  assert.ok(a.parent === g1n);
  near(world(g1n), V(10, 0, 0), 'g1 world position restored');
  near(world(a), wa, 'a world kept after undo');
  cmd.execute();
  assert.equal(getState().scene.groups.g1, undefined, 'redo dissolves again');
  near(world(a), wa, 'a world kept after redo');
  assert.ok(g1);
});

test('Ungroup.targetsFor resolves groups + parent groups of selected objects; unknown group is a no-op', () => {
  build();
  assert.deepEqual(UngroupCommand.targetsFor(['g2']).sort(), ['g2']);
  assert.deepEqual(UngroupCommand.targetsFor(['a']), ['g1'], 'object -> its parent group');
  assert.deepEqual(UngroupCommand.targetsFor(['b']), [], 'loose object -> nothing');
  assert.deepEqual(UngroupCommand.targetsFor(['a', 'g1', 'g2']).sort(), ['g1', 'g2'], 'deduped');
  const before = Object.keys(getState().scene.groups).sort();
  const cmd = new UngroupCommand(['nope']);
  cmd.execute(); cmd.undo();
  assert.deepEqual(Object.keys(getState().scene.groups).sort(), before);
});
