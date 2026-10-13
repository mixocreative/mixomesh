// Snap + nudge units (overhaul 5.6, plan §4.7 "Transform"): snap steps are
// persisted in MILLIMETRES (translate, default 1 mm), degrees (rotate) and ×
// (scale); the scene works in BU (1 BU = 1 m). Covers the mm→BU conversion,
// the gizmo Ctrl-snap distances, the arrow-key nudge step/direction, the
// factory default, and the stagger / Array-dialog pure helpers.
//   node --import ./tests/register-hooks.mjs tests/snap-units.test.mjs

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installEnv } from './env.mjs';

installEnv();
const {
  NUDGE_MM, translateSnapBU, rotateSnapRad, scaleSnapStep, snapToStep,
  gizmoSnapDistances, nudgeStepMM, nudgeDirection,
} = await import('../src/core/SnapUnits.js');
const DS = (await import('../src/config/default-settings.json', { with: { type: 'json' } })).default;
const { staggerNextX } = await import('../src/ui/ViewportDrop.js');
const { parseArrayInput } = await import('../src/ui/CursorPanel.js');

const near = (a, b, eps = 1e-12) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);

test('factory translate snap is 1 mm (not 1 BU = 1 m)', () => {
  assert.equal(DS.gizmo.snap.translate, 1);
  near(translateSnapBU(DS.gizmo.snap), 0.001);
});

test('translate snap converts mm → BU; bad / missing values fall back to 1 mm', () => {
  near(translateSnapBU({ translate: 5 }), 0.005);
  near(translateSnapBU({ translate: 0.1 }), 0.0001);
  near(translateSnapBU({ translate: 0 }), 0.001);
  near(translateSnapBU({ translate: -3 }), 0.001);
  near(translateSnapBU(undefined), 0.001);
});

test('rotate snap is degrees → radians; scale snap is a plain step', () => {
  near(rotateSnapRad({ rotate: 15 }), Math.PI / 12);
  near(rotateSnapRad({}), Math.PI / 12);
  near(scaleSnapStep({ scale: 0.25 }), 0.25);
  near(scaleSnapStep({}), 0.1);
});

test('snapToStep rounds to the nearest multiple; step ≤ 0 is identity', () => {
  near(snapToStep(0.0123, 0.001), 0.012);
  near(snapToStep(0.0127, 0.001), 0.013);
  near(snapToStep(-0.0127, 0.001), -0.013);
  assert.equal(snapToStep(0.0127, 0), 0.0127);
});

test('modal snap of a 12.6 mm drag lands on 13 mm with the default step', () => {
  const dragBU = 0.0126;
  near(snapToStep(dragBU, translateSnapBU(DS.gizmo.snap)) * 1000, 13, 1e-9);
});

test('gizmo Ctrl-snap distances: held → mm/deg/× in gizmo units, released → all 0', () => {
  const on = gizmoSnapDistances({ translate: 2, rotate: 45, scale: 0.5 }, true);
  near(on.translate, 0.002);
  near(on.rotate, Math.PI / 4);
  near(on.scale, 0.5);
  assert.deepEqual(gizmoSnapDistances({ translate: 2, rotate: 45, scale: 0.5 }, false),
    { translate: 0, rotate: 0, scale: 0 });
});

test('nudge step: 1 mm plain, Shift 10 mm, Alt 0.1 mm (Alt wins over Shift)', () => {
  assert.equal(nudgeStepMM({}), NUDGE_MM.base);
  assert.equal(nudgeStepMM({}), 1);
  assert.equal(nudgeStepMM({ shiftKey: true }), 10);
  assert.equal(nudgeStepMM({ altKey: true }), 0.1);
  assert.equal(nudgeStepMM({ altKey: true, shiftKey: true }), 0.1);
});

// Camera looking from +Z toward the origin (Babylon "front"): screen right is
// world −X (LH), forward is world −Z.
const FRONT = { right: { x: -1, y: 0, z: 0 }, forward: { x: 0, y: 0, z: -1 }, up: { x: 0, y: 1, z: 0 } };
// Oblique orbit: right mostly +Z, forward mostly +X and downward.
const OBLIQUE = { right: { x: 0.3, y: 0, z: 0.95 }, forward: { x: 0.8, y: -0.5, z: -0.2 }, up: { x: 0.4, y: 0.8, z: -0.1 } };
// Straight-down top view: forward has no horizontal part → camera up is used.
const TOP = { right: { x: 1, y: 0, z: 0 }, forward: { x: 0, y: -1, z: 0 }, up: { x: 0, y: 0, z: 1 } };

test('nudge direction follows the view, snapped to the dominant world axis', () => {
  assert.deepEqual(nudgeDirection('ArrowRight', false, FRONT), { x: -1, y: 0, z: 0 });
  assert.deepEqual(nudgeDirection('ArrowLeft', false, FRONT), { x: 1, y: 0, z: 0 });
  assert.deepEqual(nudgeDirection('ArrowUp', false, FRONT), { x: 0, y: 0, z: -1 });
  assert.deepEqual(nudgeDirection('ArrowDown', false, FRONT), { x: 0, y: 0, z: 1 });
  assert.deepEqual(nudgeDirection('ArrowRight', false, OBLIQUE), { x: 0, y: 0, z: 1 });
  assert.deepEqual(nudgeDirection('ArrowUp', false, OBLIQUE), { x: 1, y: 0, z: 0 });
});

test('nudge in a top view uses camera up for Up/Down', () => {
  assert.deepEqual(nudgeDirection('ArrowUp', false, TOP), { x: 0, y: 0, z: 1 });
  assert.deepEqual(nudgeDirection('ArrowDown', false, TOP), { x: 0, y: 0, z: -1 });
});

test('Ctrl+Up/Down nudges vertically; Ctrl+Left/Right and other keys do nothing', () => {
  assert.deepEqual(nudgeDirection('ArrowUp', true, OBLIQUE), { x: 0, y: 1, z: 0 });
  assert.deepEqual(nudgeDirection('ArrowDown', true, OBLIQUE), { x: 0, y: -1, z: 0 });
  assert.equal(nudgeDirection('ArrowLeft', true, OBLIQUE), null);
  assert.equal(nudgeDirection('KeyA', false, OBLIQUE), null);
});

test('drop stagger: next centre = placed max X + gap + half the placed width', () => {
  near(staggerNextX(-0.02, 0.02, 0.01), 0.05);   // 40 mm wide → 20 + 10 + 20 mm
  near(staggerNextX(0.1, 0.1, 0.01), 0.11);      // zero-width → just the gap
});

test('Array dialog input: integer count 2..100, non-zero finite spacing (mm)', () => {
  assert.deepEqual(parseArrayInput('3', '12.5'), { count: 3, spacingMM: 12.5 });
  assert.deepEqual(parseArrayInput(5, -4), { count: 5, spacingMM: -4 });
  assert.equal(parseArrayInput('1', '10'), null);
  assert.equal(parseArrayInput('101', '10'), null);
  assert.equal(parseArrayInput('2.5', '10'), null);
  assert.equal(parseArrayInput('3', '0'), null);
  assert.equal(parseArrayInput('3', 'abc'), null);
});
