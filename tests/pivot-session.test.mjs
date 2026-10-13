// PivotSession (overhaul 6.6a): attach/detach world preservation, topmost
// filtering, computePivotPosition per pivot mode.
//   node --import ./tests/register-hooks.mjs tests/pivot-session.test.mjs

import assert from 'node:assert/strict';
import test from 'node:test';
import { installEnv } from './env.mjs';

installEnv();
const BABYLON = await import('@babylonjs/core');
globalThis.window.BABYLON = BABYLON;
globalThis.window.removeEventListener = () => {};
globalThis.document.addEventListener = () => {};
globalThis.document.removeEventListener = () => {};
const Pivot = await import('../src/core/scene/PivotSession.js');

const engine = new BABYLON.NullEngine({ renderWidth: 64, renderHeight: 64, textureSize: 64 });
const scene = new BABYLON.Scene(engine);
const V = (x, y, z) => new BABYLON.Vector3(x, y, z);
let cursor = V(7, 8, 9);
Pivot.initPivotSession(scene, { getCursorPosition: () => cursor });

function near(a, b, msg, eps = 1e-5) {
  for (const k of ['x', 'y', 'z']) assert.ok(Math.abs(a[k] - b[k]) < eps, `${msg}: ${k} ${a[k]} != ${b[k]}`);
}
const world = n => { n.computeWorldMatrix(true); return n.getAbsolutePosition().clone(); };
function box(id, pos, parent = null, size = 2) {
  const m = BABYLON.MeshBuilder.CreateBox(id, { size }, scene);
  m.metadata = { meshId: id }; m.parent = parent; m.position = pos; m.computeWorldMatrix(true);
  return m;
}
function reset() {
  Pivot.attachToSelection([], 'median', null);
  for (const m of [...scene.meshes]) m.dispose();
  for (const t of [...scene.transformNodes]) t.dispose();
}

test('topmostTransformTargets drops descendants, keeps order, dedupes', () => {
  reset();
  const g = new BABYLON.TransformNode('g', scene);
  const sub = new BABYLON.TransformNode('sub', scene); sub.parent = g;
  const a = box('a', V(0, 0, 0), sub);
  const c = box('c', V(5, 0, 0));
  const out = Pivot.topmostTransformTargets([a, c, g, sub, c]);
  assert.deepEqual(out, [c, g], 'a and sub are covered by g; duplicate c removed');
  assert.deepEqual(Pivot.topmostTransformTargets([a, sub]), [sub], 'object under selected subgroup dropped');
  assert.deepEqual(Pivot.topmostTransformTargets([]), []);
  assert.deepEqual(Pivot.topmostTransformTargets(null), []);
  assert.deepEqual(Pivot.topmostTransformTargets([a, null, c]), [a, c], 'falsy entries ignored');
});

test('topmostTransformTargets honours a nodeOf mapper and keeps the original entries', () => {
  reset();
  const g = new BABYLON.TransformNode('g', scene);
  const a = box('a', V(0, 0, 0), g);
  const entries = [{ id: 'a', n: a }, { id: 'g', n: g }];
  const out = Pivot.topmostTransformTargets(entries, e => e.n);
  assert.deepEqual(out.map(e => e.id), ['g']);
});

test('attach parents nodes under the pivot preserving world; detach restores parents + world', () => {
  reset();
  const g = new BABYLON.TransformNode('g', scene); g.position = V(10, 0, 0);
  const a = box('a', V(1, 0, 0), g);
  const c = box('c', V(0, 0, -5));
  const wa = world(a), wc = world(c);
  Pivot.attachToSelection([a, c], 'median', a);
  const pivot = Pivot.getPivotNode();
  assert.ok(pivot, 'pivot exists');
  assert.equal(a.parent, pivot); assert.equal(c.parent, pivot);
  near(world(a), wa, 'a world preserved while attached');
  near(world(c), wc, 'c world preserved while attached');
  Pivot.attachToSelection([], 'median', null);
  assert.equal(Pivot.getPivotNode(), null, 'pivot disposed');
  assert.equal(a.parent, g, 'canonical parent restored');
  assert.equal(c.parent, null);
  near(world(a), wa, 'a world preserved after detach');
  near(world(c), wc, 'c world preserved after detach');
});

test('moving the pivot moves every attached node; re-attach after a move does not drift', () => {
  reset();
  const a = box('a', V(0, 0, 0)); const b = box('b', V(4, 0, 0));
  Pivot.attachToSelection([a, b], 'median', a);
  Pivot.getPivotNode().position.addInPlace(V(0, 3, 0));
  near(world(a), V(0, 3, 0), 'a followed pivot');
  near(world(b), V(4, 3, 0), 'b followed pivot');
  Pivot.attachToSelection([a, b], 'median', a);   // rebuild
  near(world(a), V(0, 3, 0), 'a stable across rebuild');
  Pivot.attachToSelection([], 'median', null);
  near(world(b), V(4, 3, 0), 'b stable after detach');
});

test('attach with an empty/null list leaves no pivot', () => {
  reset();
  const a = box('a', V(0, 0, 0));
  Pivot.attachToSelection([a], 'median', a);
  assert.ok(Pivot.getPivotNode());
  Pivot.attachToSelection([], 'median', null);
  assert.equal(Pivot.getPivotNode(), null);
  Pivot.attachToSelection(null, 'median', null);
  assert.equal(Pivot.getPivotNode(), null);
});

test('computePivotPosition: world / cursor / median / active / individual', () => {
  reset();
  const a = box('a', V(0, 0, 0)); const b = box('b', V(10, 4, 0));
  const nodes = [a, b];
  near(Pivot.computePivotPosition(nodes, 'world', a), V(0, 0, 0), 'world');
  near(Pivot.computePivotPosition(nodes, 'cursor', a), V(7, 8, 9), 'cursor');
  cursor = V(1, 1, 1);
  near(Pivot.computePivotPosition(nodes, 'cursor', a), V(1, 1, 1), 'cursor is read live');
  near(Pivot.computePivotPosition(nodes, 'median', a), V(5, 2, 0), 'median = union AABB centre');
  near(Pivot.computePivotPosition(nodes, 'active', b), V(10, 4, 0), 'active = active AABB centre');
  near(Pivot.computePivotPosition(nodes, 'individual', a), V(5, 2, 0), 'individual = origin centroid');
});

test('median differs from individual for asymmetric sizes; active honours activeGeometry', () => {
  reset();
  const big = box('big', V(0, 0, 0), null, 10);     // x[-5,5]
  const small = box('small', V(20, 0, 0), null, 2); // x[19,21]
  near(Pivot.computePivotPosition([big, small], 'median', big), V(8, 0, 0), 'AABB centre (-5..21)');
  near(Pivot.computePivotPosition([big, small], 'individual', big), V(10, 0, 0), 'origin centroid');
  near(Pivot.computePivotPosition([big, small], 'active', big, [small]), V(20, 0, 0), 'activeGeometry overrides active node');
});

test('geometry-less selections fall back to origin centroid / active origin', () => {
  reset();
  const t1 = new BABYLON.TransformNode('t1', scene); t1.position = V(2, 0, 0);
  const t2 = new BABYLON.TransformNode('t2', scene); t2.position = V(6, 0, 0);
  assert.equal(Pivot.geometryAABBCenter([t1, t2]), null);
  near(Pivot.computePivotPosition([t1, t2], 'median', t1), V(4, 0, 0), 'median fallback');
  near(Pivot.computePivotPosition([t1, t2], 'active', t2), V(6, 0, 0), 'active fallback = node origin');
  near(Pivot.computePivotPosition([], 'median', null), V(0, 0, 0), 'empty -> origin');
});

test('attach places the pivot at the mode position (group counts via its descendants)', () => {
  reset();
  const g = new BABYLON.TransformNode('g', scene); g.position = V(10, 0, 0);
  box('a', V(1, 0, 0), g); box('b', V(-1, 0, 2), g);
  Pivot.attachToSelection([g], 'median', g, [g]);
  near(world(Pivot.getPivotNode()), V(10, 0, 1), 'median');
  Pivot.attachToSelection([g], 'individual', g, [g]);
  near(world(Pivot.getPivotNode()), V(10, 0, 0), 'individual = group origin');
  Pivot.attachToSelection([g], 'world', g, [g]);
  near(world(Pivot.getPivotNode()), V(0, 0, 0), 'world');
  Pivot.attachToSelection([], 'median', null);
});

test('body drag: begin needs a pivot, offset moves nodes, cancel reverts, end commits prev/next', () => {
  reset();
  assert.equal(Pivot.beginBodyDrag(), false, 'no pivot -> refuses');
  const a = box('a', V(0, 0, 0));
  const commits = [];
  Pivot.setTransformCommitHandler(p => commits.push(p));
  Pivot.attachToSelection([a], 'median', a);
  assert.equal(Pivot.beginBodyDrag(), true);
  assert.equal(Pivot.beginBodyDrag(), false, 'second begin refused mid-drag');
  Pivot.setBodyDragOffset(V(3, 0, 0));
  near(world(a), V(3, 0, 0), 'moved');
  Pivot.cancelBodyDrag();
  near(world(a), V(0, 0, 0), 'cancel reverted');
  assert.equal(commits.length, 0, 'cancel emits nothing');
  assert.equal(Pivot.beginBodyDrag(), true);
  Pivot.setBodyDragOffset(V(0, 0, 2));
  Pivot.endBodyDrag();
  assert.equal(commits.length, 1);
  assert.equal(commits[0].alreadyApplied, true);
  near(commits[0].prev.a.position, V(0, 0, 0), 'prev snapshot');
  near(commits[0].next.a.position, V(0, 0, 2), 'next snapshot');
  Pivot.attachToSelection([], 'median', null);
});
