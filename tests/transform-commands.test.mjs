// TransformCommands (overhaul 6.6c): TransformCommand + TransformSwabCommand
// execute/undo/redo exactness for meshes and group nodes, alreadyApplied
// semantics, event payloads.
//   node --import ./tests/register-hooks.mjs tests/transform-commands.test.mjs

import assert from 'node:assert/strict';
import test from 'node:test';
import { installEnv } from './env.mjs';

installEnv();
const BABYLON = await import('@babylonjs/core');
globalThis.window.BABYLON = BABYLON;
globalThis.window.removeEventListener = () => {};
globalThis.document.addEventListener = () => {};
globalThis.document.removeEventListener = () => {};
const { TransformCommand, TransformSwabCommand } = await import('../src/core/commands/TransformCommands.js');
const { SceneManager } = await import('../src/core/SceneManager.js');
const { AssetLoader } = await import('../src/core/AssetLoader.js');
const { Selection } = await import('../src/core/Selection.js');
const { subscribe } = await import('../src/core/StateManager.js');
const { EVENTS } = await import('../src/core/events.js');

const engine = new BABYLON.NullEngine({ renderWidth: 64, renderHeight: 64, textureSize: 64 });
const scene = new BABYLON.Scene(engine);
const meshes = new Map();
SceneManager.getScene = () => scene;
SceneManager.attachToSelection = () => {};
AssetLoader.getBabylonMesh = id => meshes.get(id) ?? null;
Selection.refresh = () => {};

const V = (x, y, z) => new BABYLON.Vector3(x, y, z);
function near(a, b, msg, eps = 1e-5) {
  for (const k of ['x', 'y', 'z']) assert.ok(Math.abs(a[k] - b[k]) < eps, `${msg}: ${k} ${a[k]} != ${b[k]}`);
}
const world = n => { n.computeWorldMatrix(true); return n.getAbsolutePosition().clone(); };
const T = (p, q = [0, 0, 0, 1], s = [1, 1, 1]) => ({
  position: { x: p[0], y: p[1], z: p[2] },
  rotation: { x: q[0], y: q[1], z: q[2], w: q[3] },
  scaling: { x: s[0], y: s[1], z: s[2] },
});
const rotY = a => { const q = BABYLON.Quaternion.RotationAxis(V(0, 1, 0), a); return [q.x, q.y, q.z, q.w]; };

function build() {
  meshes.clear();
  for (const m of [...scene.meshes]) m.dispose();
  for (const t of [...scene.transformNodes]) t.dispose();
  const g = new BABYLON.TransformNode('G', scene);
  g.metadata = { groupId: 'g1' }; g.position = V(10, 0, 0);
  const mk = (id, pos, parent) => {
    const m = BABYLON.MeshBuilder.CreateBox(id, { size: 2 }, scene);
    m.metadata = { meshId: id }; m.parent = parent; m.position = pos; meshes.set(id, m);
    m.computeWorldMatrix(true); return m;
  };
  const a = mk('a', V(1, 0, 0), g);
  const b = mk('b', V(0, 0, 0), null);
  const c = mk('c', V(5, 5, 5), null);
  g.computeWorldMatrix(true);
  return { g, a, b, c };
}
function capture() {
  const events = [];
  const off = subscribe(EVENTS.TRANSFORM_COMMITTED, p => events.push(p));
  return { events, stop: () => { if (typeof off === 'function') off(); } };
}

test('TransformCommand execute/undo/redo restores meshes exactly (position, rotation, scale)', () => {
  const { b } = build();
  const prev = T([0, 0, 0]);
  const next = T([3, 4, 5], rotY(Math.PI / 2), [2, 3, 4]);
  const cmd = new TransformCommand({ b: prev }, { b: next });
  cmd.execute();
  near(world(b), V(3, 4, 5), 'execute position');
  near(b.scaling, V(2, 3, 4), 'execute scale');
  assert.ok(Math.abs(b.rotationQuaternion.y - Math.sin(Math.PI / 4)) < 1e-5, 'execute rotation');
  cmd.undo();
  near(world(b), V(0, 0, 0), 'undo position');
  near(b.scaling, V(1, 1, 1), 'undo scale');
  assert.ok(Math.abs(b.rotationQuaternion.w - 1) < 1e-5, 'undo rotation identity');
  cmd.execute();
  near(world(b), V(3, 4, 5), 'redo position');
  near(b.scaling, V(2, 3, 4), 'redo scale');
});

test('alreadyApplied: first execute is a no-op (scene untouched), redo after undo applies', () => {
  const { b } = build();
  b.position = V(9, 9, 9); b.computeWorldMatrix(true);   // the gizmo already moved it
  const cmd = new TransformCommand({ b: T([0, 0, 0]) }, { b: T([9, 9, 9]) }, { alreadyApplied: true });
  const cap = capture();
  cmd.execute();
  near(world(b), V(9, 9, 9), 'untouched by the first execute');
  assert.equal(cap.events.length, 1, 'still announces the commit');
  cmd.undo();
  near(world(b), V(0, 0, 0), 'undo reverts to prev');
  cmd.execute();
  near(world(b), V(9, 9, 9), 'second execute (redo) DOES apply next');
  cap.stop();
});

test('without alreadyApplied the first execute applies immediately', () => {
  const { b } = build();
  new TransformCommand({ b: T([0, 0, 0]) }, { b: T([1, 2, 3]) }).execute();
  near(world(b), V(1, 2, 3), 'applied');
});

test('group-keyed TransformCommand moves the group rigidly: children locals unchanged, world follows', () => {
  const { g, a } = build();
  const prev = T([10, 0, 0]);
  const next = T([10, 0, 0], rotY(Math.PI / 2), [2, 2, 2]);
  const cmd = new TransformCommand({ g1: prev }, { g1: next });
  cmd.execute();
  near(world(a), V(10, 0, -2), 'child world: rotated 90deg about Y and scaled x2', 1e-4);
  near(a.position, V(1, 0, 0), 'child local untouched');
  cmd.undo();
  near(world(a), V(11, 0, 0), 'undo restores child world', 1e-4);
  near(g.scaling, V(1, 1, 1), 'undo restores group scale');
});

test('a mixed snapshot (group + loose mesh) applies both and undo restores both', () => {
  const { a, c } = build();
  const cmd = new TransformCommand(
    { g1: T([10, 0, 0]), c: T([5, 5, 5]) },
    { g1: T([20, 0, 0]), c: T([-1, -2, -3]) });
  cmd.execute();
  near(world(a), V(21, 0, 0), 'group child moved with group');
  near(world(c), V(-1, -2, -3), 'loose mesh moved');
  cmd.undo();
  near(world(a), V(11, 0, 0), 'group child restored');
  near(world(c), V(5, 5, 5), 'loose mesh restored');
});

test('event payloads: nodeIds are the snapshot keys, meshIds expand a group to member meshes', () => {
  build();
  const cap = capture();
  const cmd = new TransformCommand({ g1: T([10, 0, 0]), c: T([5, 5, 5]) }, { g1: T([11, 0, 0]), c: T([6, 5, 5]) });
  cmd.execute();
  cmd.undo();
  cap.stop();
  assert.equal(cap.events.length, 2, 'one event per execute/undo');
  for (const ev of cap.events) {
    assert.deepEqual([...ev.nodeIds].sort(), ['c', 'g1']);
    assert.deepEqual([...ev.meshIds].sort(), ['a', 'c'], 'g1 expanded to its member a, plus loose c');
  }
});

test('unknown ids in a snapshot are skipped without throwing', () => {
  const { b } = build();
  const cmd = new TransformCommand({ ghost: T([0, 0, 0]), b: T([0, 0, 0]) }, { ghost: T([1, 1, 1]), b: T([2, 2, 2]) });
  cmd.execute();
  near(world(b), V(2, 2, 2), 'known id still applied');
  cmd.undo();
  near(world(b), V(0, 0, 0), 'and restored');
});

test('TransformSwabCommand copies the active world transform onto others; undo restores each', () => {
  const { a, b, c } = build();
  c.position = V(5, 5, 5);
  c.rotationQuaternion = new BABYLON.Quaternion(...rotY(Math.PI / 2));
  c.scaling = V(2, 2, 2); c.computeWorldMatrix(true);
  const wa = world(a), wb = world(b);
  const cmd = new TransformSwabCommand(['a', 'b', 'c'], 'c');
  assert.equal(cmd.label, 'Copy placement from active (2)');
  cmd.execute();
  near(world(a), V(5, 5, 5), 'a (child of a group) lands at active world position');
  near(world(b), V(5, 5, 5), 'b lands at active world position');
  near(b.scaling, V(2, 2, 2), 'scale copied');
  assert.ok(Math.abs(b.rotationQuaternion.y - Math.sin(Math.PI / 4)) < 1e-5, 'rotation copied');
  near(world(c), V(5, 5, 5), 'active itself untouched');
  cmd.undo();
  near(world(a), wa, 'a restored'); near(world(b), wb, 'b restored');
  near(b.scaling, V(1, 1, 1), 'b scale restored');
  cmd.execute();
  near(world(b), V(5, 5, 5), 'redo re-applies');
});

test('TransformSwabCommand: single target label, active excluded, missing active -> empty snapshots', () => {
  build();
  assert.equal(new TransformSwabCommand(['b', 'c'], 'c').label, 'Copy placement from active');
  const cmd = new TransformSwabCommand(['b', 'c'], 'nope');
  assert.deepEqual(Object.keys(cmd._next), [], 'no source -> nothing to apply');
  const cap = capture();
  cmd.execute(); cmd.undo();
  cap.stop();
  assert.deepEqual(cap.events.map(e => e.meshIds), [[], []], 'empty commit announced, scene untouched');
  const only = new TransformSwabCommand(['c'], 'c');
  assert.deepEqual(only._targets, [], 'active-only selection has no targets');
});
