// Overhaul 8.5: numeric Transform sheet parsing/maths + touch gizmo sizing.
//   node --import ./tests/register-hooks.mjs tests/transform-sheet.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { installEnv } from './env.mjs';

installEnv();
const BABYLON = await import('@babylonjs/core');
globalThis.window.BABYLON = BABYLON;
globalThis.window.removeEventListener = () => {};
globalThis.document.addEventListener = () => {};
globalThis.document.removeEventListener = () => {};

const { parseSheetValues, planSheetTransform, isNoopValues, SHEET_DEFAULTS } =
  await import('../src/ui/TransformSheet.js');
const { gizmoScaleRatioFor, TOUCH_GIZMO_SCALE } = await import('../src/core/scene/PivotSession.js');

const near = (a, b, e = 1e-6) => assert.ok(Math.abs(a - b) < e, `${a} != ${b}`);
const ident = { x: 0, y: 0, z: 0, w: 1 };
const snap = (x, y, z, s = 1) => ({ position: { x, y, z }, rotation: { ...ident }, scaling: { x: s, y: s, z: s } });

test('parse: blank fields give defaults (no-op)', () => {
  const r = parseSheetValues({});
  assert.equal(r.ok, true);
  assert.deepEqual(r.values, SHEET_DEFAULTS);
  assert.equal(isNoopValues(r.values), true);
});

test('parse: numbers, comma decimals, signs', () => {
  const r = parseSheetValues({ moveX: ' 12,5 ', moveY: '-3', rotZ: '+90', scalePct: '150' });
  assert.equal(r.ok, true);
  assert.equal(r.values.moveX, 12.5);
  assert.equal(r.values.moveY, -3);
  assert.equal(r.values.rotZ, 90);
  assert.equal(r.values.scalePct, 150);
});

test('parse: rejects junk, hex, Infinity', () => {
  for (const bad of ['abc', '0x10', 'Infinity', '1..2', '--1', '5mm']) {
    const r = parseSheetValues({ moveX: bad });
    assert.equal(r.ok, false, bad);
    assert.equal(r.field, 'moveX');
    assert.equal(r.reason, 'number');
  }
});

test('parse: scale must be a positive percentage', () => {
  for (const bad of ['0', '-50', '0.001', '1e9']) {
    const r = parseSheetValues({ scalePct: bad });
    assert.equal(r.ok, false, bad);
    assert.equal(r.reason, 'scale');
  }
});

test('plan: move converts mm to BU and offsets every node', () => {
  const { prev, next, noop } = planSheetTransform(
    [{ id: 'a', snap: snap(0, 0, 0) }, { id: 'b', snap: snap(1, 2, 3) }],
    { x: 0, y: 0, z: 0 }, { ...SHEET_DEFAULTS, moveX: 10, moveY: -5 }, 1000);
  assert.equal(noop, false);
  assert.equal(prev.a.position.x, 0);
  near(next.a.position.x, 0.01);
  near(next.a.position.y, -0.005);
  near(next.b.position.x, 1.01);
  near(next.b.position.z, 3);
});

test('plan: rotate 90 deg about Y around the pivot', () => {
  const { next } = planSheetTransform(
    [{ id: 'a', snap: snap(2, 0, 0) }], { x: 1, y: 0, z: 0 }, { ...SHEET_DEFAULTS, rotY: 90 }, 1000);
  // rel (1,0,0) rotated 90 about Y -> (0,0,-1) in Babylon's left-handed frame.
  near(next.a.position.x, 1);
  near(next.a.position.z, -1);
  const q = new BABYLON.Quaternion(next.a.rotation.x, next.a.rotation.y, next.a.rotation.z, next.a.rotation.w);
  near(q.length(), 1);
  near(Math.abs(q.y), Math.SQRT1_2);
});

test('plan: scale % is uniform about the pivot and multiplies scaling', () => {
  const { next } = planSheetTransform(
    [{ id: 'a', snap: snap(3, 0, 0, 2) }], { x: 1, y: 0, z: 0 }, { ...SHEET_DEFAULTS, scalePct: 50 }, 1000);
  near(next.a.position.x, 2);
  near(next.a.scaling.x, 1);
  near(next.a.scaling.y, 1);
});

test('plan: group node and child object are separate entries with their own ids', () => {
  const { prev, next } = planSheetTransform(
    [{ id: 'grp-1', snap: snap(0, 0, 0) }], { x: 0, y: 0, z: 0 }, { ...SHEET_DEFAULTS, moveZ: 1 }, 1000);
  assert.deepEqual(Object.keys(prev), ['grp-1']);
  assert.deepEqual(Object.keys(next), ['grp-1']);
});

test('gizmo scale ratio: mouse stays at Babylon default, touch is larger', () => {
  assert.equal(gizmoScaleRatioFor(false), 1);
  assert.equal(gizmoScaleRatioFor(true), TOUCH_GIZMO_SCALE);
  assert.ok(TOUCH_GIZMO_SCALE > 1);
});
