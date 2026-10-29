// Overhaul 8.5: touch gizmo sizing. The Transform sheet maths/panel tests live in
// src/panels/TransformSheet/TransformSheet.test.tsx.
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

const { gizmoScaleRatioFor, TOUCH_GIZMO_SCALE } = await import('../src/core/scene/PivotSession.js');

test('gizmo scale ratio: mouse stays at Babylon default, touch is larger', () => {
  assert.equal(gizmoScaleRatioFor(false), 1);
  assert.equal(gizmoScaleRatioFor(true), TOUCH_GIZMO_SCALE);
  assert.ok(TOUCH_GIZMO_SCALE > 1);
});
