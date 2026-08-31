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

console.log('\n' + out.join('\n'));
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
