// Hierarchy command tests. Run:
//   node --import ./tests/register-hooks.mjs tests/hierarchy.test.mjs

import assert from 'node:assert/strict';
import { installEnv } from './env.mjs';

installEnv();

const BABYLON = await import('@babylonjs/core');
globalThis.window.BABYLON = BABYLON;
globalThis.window.removeEventListener = () => {};
globalThis.document.addEventListener = () => {};
globalThis.document.removeEventListener = () => {};
console.error = () => {};

const StateManager = await import('../src/core/StateManager.js');
const { AssetLoader } = await import('../src/core/AssetLoader.js');
const { SceneManager } = await import('../src/core/SceneManager.js');
const History = await import('../src/core/HistoryManager.js');
const Hierarchy = await import('../src/core/hierarchy/HierarchyIntegrity.js');
const Serializer = await import('../src/core/persist/ProjectSerializer.js');
const Loader = await import('../src/core/persist/ProjectLoader.js');
const findNode = (gid) => scene.transformNodes.find(n => n.metadata?.groupId === gid);

const { ReparentCommand, UnparentCommand, UngroupCommand, CreateGroupCommand } = History;

assert.equal(typeof Hierarchy.validateParentChange, 'function',
  'HierarchyIntegrity must expose shared parent validation');
assert.equal(typeof ReparentCommand, 'function', 'ReparentCommand must be exported');
assert.equal(typeof UnparentCommand, 'function', 'UnparentCommand must be exported');
assert.equal(typeof CreateGroupCommand, 'function', 'CreateGroupCommand must be exported');

let engine = null;
let scene = null;
let meshes = new Map();

AssetLoader.getBabylonMesh = (id) => meshes.get(id) ?? null;
SceneManager.getScene = () => scene;
SceneManager.attachToSelection = () => {};
SceneManager.setActive = () => {};
SceneManager.setSelected = () => {};

function resetScene() {
  scene?.dispose();
  engine?.dispose();
  engine = new BABYLON.NullEngine({ renderWidth: 64, renderHeight: 64, textureSize: 64 });
  scene = new BABYLON.Scene(engine);
  meshes = new Map();
  History.clear();
  StateManager.setState(s => ({
    ...s,
    selection: { ...s.selection, selectedIds: [], activeId: null },
    scene: {
      ...s.scene,
      objects: {},
      groups: {},
      collections: {},
      assetLibrary: {},
      shaders: {},
      validation: {},
    },
  }), { silent: true });
}

function sceneObject(id, extra = {}) {
  return {
    id,
    name: id,
    assetId: 'asset',
    collectionId: null,
    parentId: null,
    shaderId: null,
    visible: true,
    locked: false,
    isGhost: false,
    isUnlinked: false,
    isPrintPart: true,
    ...extra,
  };
}

function groupState(id, childIds = [], extra = {}) {
  return { id, name: id, parentId: null, childIds, origin: 'user', ...extra };
}

function setState({ objects = {}, groups = {}, collections = {} }) {
  StateManager.setState(s => ({
    ...s,
    scene: { ...s.scene, objects, groups, collections },
  }), { silent: true });
}

function makeMesh(id, position = [0, 0, 0]) {
  const mesh = new BABYLON.Mesh(id, scene);
  const vd = new BABYLON.VertexData();
  vd.positions = [0, 0, 0, 1, 0, 0, 0, 1, 0];
  vd.indices = [0, 1, 2];
  vd.applyToMesh(mesh);
  mesh.position.set(...position);
  mesh.metadata = { meshId: id };
  meshes.set(id, mesh);
  return mesh;
}

function makeGroup(id, position = [0, 0, 0]) {
  const node = new BABYLON.TransformNode(id, scene);
  node.position.set(...position);
  node.metadata = { groupId: id };
  return node;
}

function worldPos(node) {
  node.computeWorldMatrix(true);
  const p = node.getAbsolutePosition();
  return [p.x, p.y, p.z];
}

function closeVec(actual, expected, msg = 'world position') {
  for (let i = 0; i < 3; i++) {
    assert.ok(Math.abs(actual[i] - expected[i]) < 1e-5,
      `${msg}[${i}] expected ${expected[i]}, got ${actual[i]}`);
  }
}

let passed = 0, failed = 0;
const out = [];
async function test(name, fn) {
  resetScene();
  try { await fn(); out.push(`PASS  ${name}`); passed++; }
  catch (err) { out.push(`FAIL  ${name}\n      ${err.stack || err.message}`); failed++; }
}

await test('reparent to a group preserves world transform and keeps collection membership', () => {
  const robot = makeGroup('robot', [10, 0, 0]);
  const mesh = makeMesh('arm', [2, 3, 4]);
  setState({
    collections: { import_a: { id: 'import_a', name: 'Import A' } },
    objects: { arm: sceneObject('arm', { collectionId: 'import_a' }) },
    groups: { robot: groupState('robot') },
  });

  const before = worldPos(mesh);
  new ReparentCommand('arm', 'robot').execute();

  closeVec(worldPos(mesh), before, 'reparent preserves world');
  assert.equal(mesh.parent, robot);
  assert.equal(StateManager.getState().scene.objects.arm.parentId, 'robot');
  assert.equal(StateManager.getState().scene.objects.arm.collectionId, 'import_a');
  assert.deepEqual(StateManager.getState().scene.groups.robot.childIds, ['arm']);

  robot.position.x += 5;
  closeVec(worldPos(mesh), [before[0] + 5, before[1], before[2]], 'parent translate affects child');
});

await test('unparent preserves world transform and undo restores the original parent', () => {
  const robot = makeGroup('robot', [10, 0, 0]);
  const mesh = makeMesh('hand', [1, 2, 3]);
  mesh.setParent(robot);
  setState({
    objects: { hand: sceneObject('hand', { parentId: 'robot' }) },
    groups: { robot: groupState('robot', ['hand']) },
  });

  const before = worldPos(mesh);
  const cmd = new UnparentCommand('hand');
  cmd.execute();
  closeVec(worldPos(mesh), before, 'unparent preserves world');
  assert.equal(mesh.parent, null);
  assert.equal(StateManager.getState().scene.objects.hand.parentId, null);
  assert.deepEqual(StateManager.getState().scene.groups.robot.childIds, []);

  cmd.undo();
  closeVec(worldPos(mesh), before, 'undo preserves world');
  assert.equal(mesh.parent, robot);
  assert.equal(StateManager.getState().scene.objects.hand.parentId, 'robot');
  assert.deepEqual(StateManager.getState().scene.groups.robot.childIds, ['hand']);
});

await test('reparent rejects self-parent, descendant-parent cycles, and missing parents', () => {
  makeGroup('root', [0, 0, 0]);
  makeGroup('child', [1, 0, 0]).setParent(scene.transformNodes.find(n => n.metadata?.groupId === 'root'));
  makeMesh('part', [0, 0, 0]);
  setState({
    objects: { part: sceneObject('part') },
    groups: {
      root: groupState('root', [], { parentId: null }),
      child: groupState('child', [], { parentId: 'root' }),
    },
  });

  assert.throws(() => new ReparentCommand('root', 'root').execute(), /self-parent/i);
  assert.throws(() => new ReparentCommand('root', 'child').execute(), /cycle/i);
  assert.throws(() => new ReparentCommand('part', 'missing').execute(), /missing parent/i);
});

await test('ungroup reparents direct children and subgroups without world jumps, then undo/redo is deterministic', () => {
  const parent = makeGroup('parent', [10, 0, 0]);
  const robot = makeGroup('robot', [2, 0, 0]);
  robot.setParent(parent);
  const arm = makeGroup('arm', [3, 0, 0]);
  arm.setParent(robot);
  const body = makeMesh('body', [1, 0, 0]);
  body.setParent(robot);
  const hand = makeMesh('hand', [4, 0, 0]);
  hand.setParent(arm);

  setState({
    objects: {
      body: sceneObject('body', { parentId: 'robot' }),
      hand: sceneObject('hand', { parentId: 'arm' }),
    },
    groups: {
      parent: groupState('parent', [], { parentId: null }),
      robot: groupState('robot', ['body'], { parentId: 'parent' }),
      arm: groupState('arm', ['hand'], { parentId: 'robot' }),
    },
  });

  const beforeBody = worldPos(body);
  const beforeHand = worldPos(hand);
  const cmd = new UngroupCommand('robot');

  cmd.execute();
  assert.equal(StateManager.getState().scene.groups.robot, undefined);
  assert.equal(StateManager.getState().scene.objects.body.parentId, 'parent');
  assert.equal(StateManager.getState().scene.groups.arm.parentId, 'parent');
  assert.deepEqual(StateManager.getState().scene.groups.parent.childIds, ['body']);
  closeVec(worldPos(body), beforeBody, 'body after ungroup');
  closeVec(worldPos(hand), beforeHand, 'hand after ungroup');

  cmd.undo();
  assert.equal(StateManager.getState().scene.objects.body.parentId, 'robot');
  assert.equal(StateManager.getState().scene.groups.arm.parentId, 'robot');
  closeVec(worldPos(body), beforeBody, 'body after undo');
  closeVec(worldPos(hand), beforeHand, 'hand after undo');

  cmd.execute();
  assert.equal(StateManager.getState().scene.objects.body.parentId, 'parent');
  assert.equal(StateManager.getState().scene.groups.arm.parentId, 'parent');
  closeVec(worldPos(body), beforeBody, 'body after redo');
  closeVec(worldPos(hand), beforeHand, 'hand after redo');
});

function s() { return StateManager.getState().scene; }

await test('grouping two children of group A nests the new group inside A (lowest common ancestor)', () => {
  const a = makeGroup('A', [10, 0, 0]);
  const m1 = makeMesh('m1', [1, 0, 0]); m1.setParent(a);
  const m2 = makeMesh('m2', [3, 0, 0]); m2.setParent(a);
  makeMesh('m3', [5, 0, 0]);
  setState({
    objects: { m1: sceneObject('m1', { parentId: 'A' }), m2: sceneObject('m2', { parentId: 'A' }), m3: sceneObject('m3') },
    groups: { A: groupState('A', ['m1', 'm2']) },
  });
  const w1 = worldPos(m1), w2 = worldPos(m2);
  const cmd = new CreateGroupCommand(['m1', 'm2']);
  cmd.execute();
  const g = s().groups[cmd.groupId];
  assert.equal(g.parentId, 'A');
  assert.equal(s().objects.m1.parentId, cmd.groupId);
  assert.deepEqual(s().groups.A.childIds, []);
  closeVec(worldPos(m1), w1, 'm1 world'); closeVec(worldPos(m2), w2, 'm2 world');
  // spanning branches -> root
  const cmd2 = new CreateGroupCommand(['m3', 'm1']);
  cmd2.execute();
  assert.equal(s().groups[cmd2.groupId].parentId, null);
});

await test('group names are uniquified (Group, Group.001, Group.002)', () => {
  for (const id of ['a', 'b', 'c']) makeMesh(id);
  setState({ objects: { a: sceneObject('a'), b: sceneObject('b'), c: sceneObject('c') } });
  const c1 = new CreateGroupCommand(['a']); c1.execute();
  const c2 = new CreateGroupCommand(['b']); c2.execute();
  const c3 = new CreateGroupCommand(['c']); c3.execute();
  assert.deepEqual([c1, c2, c3].map(c => s().groups[c.groupId].name), ['Group', 'Group.001', 'Group.002']);
  assert.equal(findNode(c2.groupId).name, 'Group.001');
});

await test('group origin is the bottom-centre of the combined world AABB; children keep world', () => {
  const a = makeMesh('a', [0, 2, 0]);   // x 0..1, y 2..3, z 0
  const b = makeMesh('b', [4, 5, 6]);   // x 4..5, y 5..6, z 6
  setState({ objects: { a: sceneObject('a'), b: sceneObject('b') } });
  const wa = worldPos(a), wb = worldPos(b);
  const cmd = new CreateGroupCommand(['a', 'b']);
  cmd.execute();
  closeVec(worldPos(findNode(cmd.groupId)), [2.5, 2, 3], 'group origin');
  closeVec(worldPos(a), wa, 'a world'); closeVec(worldPos(b), wb, 'b world');
});

await test('undo/redo of grouping restores parents, names and world transforms', () => {
  const a = makeGroup('A', [10, 0, 0]);
  const m1 = makeMesh('m1', [1, 0, 0]); m1.setParent(a);
  const m2 = makeMesh('m2', [3, 4, 0]);
  setState({
    objects: { m1: sceneObject('m1', { parentId: 'A' }), m2: sceneObject('m2') },
    groups: { A: groupState('A', ['m1']) },
  });
  const w1 = worldPos(m1), w2 = worldPos(m2);
  const before = structuredClone(s().groups);
  const cmd = new CreateGroupCommand(['m1', 'm2']);
  cmd.execute();
  const gid = cmd.groupId, nameAfter = s().groups[gid].name;
  cmd.undo();
  assert.deepEqual(s().groups, before);
  assert.equal(s().objects.m1.parentId, 'A');
  assert.equal(s().objects.m2.parentId, null);
  assert.equal(findNode(gid), undefined);
  assert.equal(m1.parent, a);
  closeVec(worldPos(m1), w1, 'm1 undo'); closeVec(worldPos(m2), w2, 'm2 undo');
  cmd.execute();
  assert.equal(s().groups[gid].name, nameAfter);
  assert.equal(s().objects.m1.parentId, gid);
  closeVec(worldPos(m1), w1, 'm1 redo'); closeVec(worldPos(m2), w2, 'm2 redo');
});

await test('grouping an existing group nests it; undo restores its parent', () => {
  const g1 = makeGroup('g1', [2, 0, 0]);
  const m = makeMesh('m', [1, 0, 0]); m.setParent(g1);
  makeMesh('o', [7, 0, 0]);
  setState({
    objects: { m: sceneObject('m', { parentId: 'g1' }), o: sceneObject('o') },
    groups: { g1: groupState('g1', ['m']) },
  });
  const wm = worldPos(m);
  const cmd = new CreateGroupCommand(['g1', 'o']);
  cmd.execute();
  assert.equal(s().groups.g1.parentId, cmd.groupId);
  assert.equal(s().objects.o.parentId, cmd.groupId);
  closeVec(worldPos(m), wm, 'm world');
  cmd.undo();
  assert.equal(s().groups.g1.parentId, null);
  closeVec(worldPos(m), wm, 'm after undo');
});

await test('group rotation+scale+position and child world positions round-trip serialise -> load', () => {
  const m = makeMesh('m', [1, 2, 3]);
  const o = makeMesh('o', [-2, 0, 5]);
  setState({ objects: { m: sceneObject('m'), o: sceneObject('o') } });
  const cmd = new CreateGroupCommand(['m', 'o']);
  cmd.execute();
  const gid = cmd.groupId;
  const node = findNode(gid);
  node.rotationQuaternion = BABYLON.Quaternion.FromEulerAngles(0.3, 1.1, -0.4);
  node.scaling.set(2, 2, 2);
  node.position.set(7, 1, -3);
  const wm = worldPos(m), wo = worldPos(o), wg = worldPos(node);
  const gq = node.rotationQuaternion.clone();

  StateManager.setState(st => ({ ...st, scene: { ...st.scene, groups: { ...st.scene.groups, [gid]: { ...st.scene.groups[gid], locked: true } } } }), { silent: true });
  const saved = JSON.parse(JSON.stringify(Serializer.__test._serialiseGroups()));
  assert.equal(saved.find(g => g.id === gid)?.locked, true, '2.5: group lock is saved');
  const savedObjs = Object.fromEntries([m, o].map(x => [x.metadata.meshId, JSON.parse(JSON.stringify(Serializer.decompose(x)))]));
  const groupsState = structuredClone(s().groups);

  // wipe runtime hierarchy, then restore as the loader does
  for (const x of [m, o]) { x.setParent(null); x.position.set(0, 0, 0); }
  node.dispose();
  for (const id of ['m', 'o']) Serializer.applyWorld(meshes.get(id), savedObjs[id]);
  Loader.__test._restoreGroups(saved, s().objects);

  assert.equal(s().groups[gid]?.locked, true, '2.5: group lock restored');
  const node2 = findNode(gid);
  assert.ok(node2, 'group node restored');
  closeVec(worldPos(node2), wg, 'group position');
  closeVec([node2.scaling.x, node2.scaling.y, node2.scaling.z], [2, 2, 2], 'group scale');
  const q2 = node2.rotationQuaternion;
  assert.ok(Math.abs(Math.abs(q2.x * gq.x + q2.y * gq.y + q2.z * gq.z + q2.w * gq.w) - 1) < 1e-5, 'group rotation');
  closeVec(worldPos(m), wm, 'm world'); closeVec(worldPos(o), wo, 'o world');
  assert.equal(m.parent, node2);
  assert.deepEqual(s().groups[gid].childIds, groupsState[gid].childIds);
});


// ── Task 2.4: Ungroup / Delete / Duplicate accept groups ─────────────────
const { DeleteCommand, DuplicateCommand } = History;
const sel = () => [...StateManager.getState().selection.selectedIds];
let cloneN = 0;
AssetLoader.cloneMeshAsNewObject = (srcId, off) => {
  const src = meshes.get(srcId);
  const obj = s().objects[srcId];
  if (!src || !obj) return null;
  const id = `${srcId}_c${++cloneN}`;
  const c = src.clone(id, src.parent ?? null);
  c.metadata = { meshId: id };
  if (off) c.position.x += off.x ?? 0;
  meshes.set(id, c);
  StateManager.setState(st => {
    const groups = { ...st.scene.groups };
    if (obj.parentId && groups[obj.parentId]) {
      groups[obj.parentId] = { ...groups[obj.parentId], childIds: [...groups[obj.parentId].childIds, id] };
    }
    return { ...st, scene: { ...st.scene, groups, objects: { ...st.scene.objects, [id]: { ...obj, id, name: `${obj.name}.dup` } } } };
  }, { silent: true });
  return id;
};
AssetLoader.restoreCloneToScene = (id, obj, mesh) => {
  meshes.set(id, mesh);
  StateManager.setState(st => ({ ...st, scene: { ...st.scene, objects: { ...st.scene.objects, [id]: obj } } }), { silent: true });
};

/** outer(5,0,0) > [ a(1,0,0) , inner(2,0,0) > [ b(3,0,0) ] ] ; loose c at (9,0,0) */
function nestedFixture() {
  const outer = makeGroup('outer', [5, 0, 0]);
  const inner = makeGroup('inner', [2, 0, 0]); inner.setParent(outer);
  const a = makeMesh('a', [1, 0, 0]); a.setParent(outer);
  const b = makeMesh('b', [3, 0, 0]); b.setParent(inner);
  const c = makeMesh('c', [9, 0, 0]);
  setState({
    objects: {
      a: sceneObject('a', { parentId: 'outer' }),
      b: sceneObject('b', { parentId: 'inner' }),
      c: sceneObject('c'),
    },
    groups: {
      outer: groupState('outer', ['a']),
      inner: groupState('inner', ['b'], { parentId: 'outer' }),
    },
  });
  return { outer, inner, a, b, c };
}

await test('ungroup works on a SELECTED group: world preserved, freed children selected, undo/redo exact', () => {
  const { a, b } = nestedFixture();
  const wa = worldPos(a), wb = worldPos(b);
  assert.deepEqual(UngroupCommand.targetsFor(['inner']), ['inner']);
  const cmd = new UngroupCommand(['inner']);
  cmd.execute();
  assert.equal(s().groups.inner, undefined);
  assert.equal(s().objects.b.parentId, 'outer');
  assert.deepEqual(sel(), ['b']);
  closeVec(worldPos(b), wb, 'b after ungroup');
  cmd.undo();
  assert.equal(s().objects.b.parentId, 'inner');
  assert.equal(s().groups.inner.parentId, 'outer');
  assert.deepEqual(sel(), ['inner']);
  closeVec(worldPos(b), wb, 'b after undo'); closeVec(worldPos(a), wa, 'a after undo');
  cmd.execute();
  assert.equal(s().objects.b.parentId, 'outer');
  closeVec(worldPos(b), wb, 'b after redo');
});

await test('ungroup of nested selected groups (outer + inner) frees everything to root; object selection maps to its parent', () => {
  const { a, b } = nestedFixture();
  const wa = worldPos(a), wb = worldPos(b);
  const targets = UngroupCommand.targetsFor(['outer', 'inner', 'a']);
  assert.deepEqual([...targets].sort(), ['inner', 'outer']);
  const cmd = new UngroupCommand(targets);
  cmd.execute();
  assert.deepEqual(s().groups, {});
  assert.equal(s().objects.a.parentId, null);
  assert.equal(s().objects.b.parentId, null);
  assert.deepEqual([...sel()].sort(), ['a', 'b']);
  closeVec(worldPos(a), wa, 'a'); closeVec(worldPos(b), wb, 'b');
  cmd.undo();
  assert.equal(s().objects.b.parentId, 'inner');
  assert.equal(s().groups.inner.parentId, 'outer');
  assert.equal(s().objects.a.parentId, 'outer');
  closeVec(worldPos(a), wa, 'a undo'); closeVec(worldPos(b), wb, 'b undo');
  cmd.execute();
  assert.deepEqual(s().groups, {});
  closeVec(worldPos(b), wb, 'b redo');
});

await test('delete a selected group removes its whole subtree in one step; undo/redo restore everything', () => {
  const { a, b, c } = nestedFixture();
  const wa = worldPos(a), wb = worldPos(b), wc = worldPos(c);
  // 'a' is inside the selected group: must not be processed twice.
  const cmd = new DeleteCommand(['outer', 'a']);
  cmd.execute();
  assert.deepEqual(Object.keys(s().objects), ['c']);
  assert.deepEqual(s().groups, {});
  assert.equal(a.isEnabled(false), false);
  assert.equal(findNode('outer').isEnabled(false), false);
  cmd.undo();
  assert.deepEqual(Object.keys(s().objects).sort(), ['a', 'b', 'c']);
  assert.equal(s().objects.a.parentId, 'outer');
  assert.equal(s().objects.b.parentId, 'inner');
  assert.equal(s().groups.inner.parentId, 'outer');
  assert.deepEqual(s().groups.outer.childIds, ['a']);
  assert.equal(a.parent, findNode('outer'));
  assert.equal(b.parent, findNode('inner'));
  closeVec(worldPos(a), wa, 'a'); closeVec(worldPos(b), wb, 'b'); closeVec(worldPos(c), wc, 'c');
  cmd.execute();
  assert.deepEqual(Object.keys(s().objects), ['c']);
  cmd.undo();
  assert.equal(s().objects.b.parentId, 'inner');
  closeVec(worldPos(b), wb, 'b after 2nd undo');
});

await test('delete mixed selection (group + loose object) is the union', () => {
  nestedFixture();
  const cmd = new DeleteCommand(['inner', 'c']);
  cmd.execute();
  assert.deepEqual(Object.keys(s().objects), ['a']);
  assert.deepEqual(Object.keys(s().groups), ['outer']);
  cmd.undo();
  assert.deepEqual(Object.keys(s().objects).sort(), ['a', 'b', 'c']);
  assert.deepEqual(Object.keys(s().groups).sort(), ['inner', 'outer']);
});

await test('duplicate a selected group clones the subtree as a uniquely named group; selection, undo, redo', () => {
  const { b } = nestedFixture();
  // multi-part logical object inside the group: b2 is a part of b.
  const b2 = makeMesh('b2', [3, 1, 0]); b2.setParent(findNode('inner'));
  StateManager.setState(st => ({
    ...st,
    scene: {
      ...st.scene,
      objects: {
        ...st.scene.objects,
        b: { ...st.scene.objects.b, logicalObjectId: 'b' },
        b2: sceneObject('b2', { parentId: 'inner', logicalObjectId: 'b', isInternalPart: true }),
      },
      groups: { ...st.scene.groups, inner: { ...st.scene.groups.inner, childIds: ['b', 'b2'] } },
    },
  }), { silent: true });
  const wb = worldPos(b);
  const cmd = new DuplicateCommand(['outer', 'a']);   // 'a' lives inside the selected group
  cmd.execute();
  const names = Object.values(s().groups).map(g => g.name).sort();
  assert.deepEqual(names, ['inner', 'inner.001', 'outer', 'outer.001']);
  const newOuter = Object.values(s().groups).find(g => g.name === 'outer.001');
  const newInner = Object.values(s().groups).find(g => g.name === 'inner.001');
  assert.equal(newInner.parentId, newOuter.id);
  assert.equal(newOuter.parentId, null);
  assert.equal(Object.keys(s().objects).length, 7);   // a b b2 c + clones of a b b2
  assert.deepEqual(sel(), [newOuter.id]);
  const cb = Object.values(s().objects).find(o => o.name === 'b.dup');
  const cb2 = Object.values(s().objects).find(o => o.name === 'b2.dup');
  assert.equal(cb.parentId, newInner.id);
  assert.equal(cb2.logicalObjectId, cb.id, 'logical part link remapped to new lead');
  assert.deepEqual(s().groups.outer.childIds, ['a'], 'original group untouched');
  assert.deepEqual([...newInner.childIds].sort(), [cb.id, cb2.id].sort());
  closeVec(worldPos(b), wb, 'original b unmoved');
  // New copy sits at the original position plus the standard duplicate nudge (+10 mm on X).
  const cbWorld = worldPos(meshes.get(cb.id));
  closeVec(cbWorld, [wb[0] + 0.01, wb[1], wb[2]], 'clone b world');
  cmd.undo();
  assert.deepEqual(Object.keys(s().groups).sort(), ['inner', 'outer']);
  assert.equal(Object.keys(s().objects).length, 4);
  cmd.execute();
  assert.equal(Object.keys(s().groups).length, 4);
  assert.equal(Object.keys(s().objects).length, 7);
  assert.equal(meshes.get(cb.id).parent, findNode(newInner.id));
  closeVec(worldPos(meshes.get(cb.id)), cbWorld, 'clone b after redo');
  assert.deepEqual(sel(), [newOuter.id]);
});

await test('duplicate mixed selection (group + loose object) = union; loose clone selected too', () => {
  nestedFixture();
  const cmd = new DuplicateCommand(['inner', 'c']);
  cmd.execute();
  assert.equal(Object.keys(s().groups).length, 3);
  assert.equal(Object.keys(s().objects).length, 5);
  assert.equal(sel().length, 2);
  const ng = Object.values(s().groups).find(g => g.name === 'inner.001');
  assert.equal(ng.parentId, 'outer', 'copy sits beside the original (same parent)');
  cmd.undo();
  assert.equal(Object.keys(s().groups).length, 2);
  assert.equal(Object.keys(s().objects).length, 3);
});

// ── Outliner group cascade (overhaul 3.4 / 2.5) ──────────────────────────
const Cascade = await import('../src/core/hierarchy/GroupCascade.js');
const { Selection: SelectionApi } = await import('../src/core/Selection.js');
const { VisibilityCommand: VisCmd, LockCommand: LockCmd } = History;

await test('cascade: group visibility reaches every descendant object (nested groups included), one undo step', () => {
  nestedFixture();
  const scene = () => StateManager.getState().scene;
  assert.deepEqual(Cascade.groupDescendantObjectIds('outer', scene()).sort(), ['a', 'b']);
  assert.deepEqual(Cascade.cascadeObjectIds(['outer'], scene()).sort(), ['a', 'b']);
  assert.deepEqual(Cascade.cascadeObjectIds(['inner', 'c'], scene()).sort(), ['b', 'c']);
  assert.equal(Cascade.groupAnyVisible('outer', scene()), true);
  const ids = Cascade.cascadeObjectIds(['outer'], scene());
  const cmd = new VisCmd(ids, { a: true, b: true }, false);
  cmd.execute();
  assert.equal(s().objects.a.visible, false);
  assert.equal(s().objects.b.visible, false);
  assert.equal(s().objects.c.visible, true, 'sibling outside the group is untouched');
  assert.equal(Cascade.groupAnyVisible('outer', scene()), false, 'all hidden -> group reads hidden');
  assert.equal(Cascade.groupAnyVisible('inner', scene()), false);
  cmd.undo();
  assert.equal(s().objects.a.visible, true);
  assert.equal(s().objects.b.visible, true);
  assert.equal(Cascade.groupAnyVisible('outer', scene()), true);
});

await test('cascade: group lock lives on the group node and reaches descendants by ancestry; undo restores', () => {
  nestedFixture();
  const scene = () => StateManager.getState().scene;
  assert.deepEqual(Cascade.cascadeLockIds(['outer', 'c'], scene()), ['outer', 'c']);
  const cmd = new LockCmd(['outer'], { outer: false }, true);
  cmd.execute();
  assert.equal(s().groups.outer.locked, true);
  assert.equal(SelectionApi.isEffectivelyLocked('a'), true, 'child of locked group');
  assert.equal(SelectionApi.isEffectivelyLocked('b'), true, 'grandchild via nested group');
  assert.equal(SelectionApi.isEffectivelyLocked('inner'), true);
  assert.equal(SelectionApi.isEffectivelyLocked('c'), false, 'outside the group');
  assert.equal(s().objects.a.locked, false, 'descendants keep their own flag (cascade is by ancestry)');
  cmd.undo();
  assert.equal(s().groups.outer.locked, false);
  assert.equal(SelectionApi.isEffectivelyLocked('b'), false);
});

await test('cascade: material parts of an object expand for visibility and lock', () => {
  makeMesh('lead'); makeMesh('part2');
  setState({
    objects: {
      lead: sceneObject('lead', { logicalObjectId: 'lead' }),
      part2: sceneObject('part2', { logicalObjectId: 'lead', isInternalPart: true }),
    },
  });
  const scene = StateManager.getState().scene;
  assert.deepEqual(Cascade.cascadeObjectIds(['lead'], scene).sort(), ['lead', 'part2']);
  assert.deepEqual(Cascade.cascadeLockIds(['lead'], scene).sort(), ['lead', 'part2']);
});

console.log('\n' + out.join('\n'));
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
