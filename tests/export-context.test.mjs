// ExportContext + façade parity tests.
//
// These pin the structural rules added 2026-06-18:
//   1. PrintManager namespace object and named exports stay in sync.
//   2. buildExportContext returns a frozen object with the right factor math.
//   3. PrintPrep.flattenWorld throws on missing required fields (no silent
//      world-origin fallback).

import test from 'node:test';
import assert from 'node:assert/strict';
import { installEnv } from './env.mjs';

installEnv();

const PrintManagerModule = await import('../src/core/PrintManager.js');
const { PrintManager } = PrintManagerModule;
const ExportContext = await import('../src/core/print/ExportContext.js');
const { createPrepSteps } = await import('../src/core/print/PrintPrep.js');

// ── namespace ↔ named export parity ─────────────────────

await test('PrintManager namespace contains every named export', () => {
  const named = Object.keys(PrintManagerModule).filter(k => k !== 'PrintManager' && k !== 'default');
  for (const key of named) {
    assert.ok(key in PrintManager, `PrintManager.${key} must exist (named export ${key} is missing from namespace)`);
    assert.equal(PrintManager[key], PrintManagerModule[key],
      `PrintManager.${key} must reference the same value as the named export`);
  }
});

await test('PrintManager namespace is frozen — adding/removing surfaces requires editing the façade', () => {
  assert.ok(Object.isFrozen(PrintManager),
    'PrintManager namespace should be frozen so accidental mutation throws in strict mode');
});

await test('previewExportContext is callable on the namespace', () => {
  assert.equal(typeof PrintManager.previewExportContext, 'function');
});

await test('getExportReference is callable on the namespace (regression for 2026-06-18 🔴)', () => {
  // The bug: getExportReference was named-exported but missing from the
  // namespace object → PrintPanel.getExportReference() → undefined → TypeError.
  assert.equal(typeof PrintManager.getExportReference, 'function');
});

// ── buildExportContext shape + math ─────────────────────

const FAKE_STATE = {
  project: { name: 'Test' },
  selection: { activeId: 'a', selectedIds: ['a'] },
  scene: { objects: { a: { id: 'a', ratio: 72 } } },
};

function unit(id, ratio, originX = 0) {
  return {
    logicalId: id, name: id,
    obj: { id, ratio },
    parts: [{ meshId: id, obj: { id, ratio }, mesh: {
      computeWorldMatrix() {},
      getWorldMatrix() { return window.BABYLON.Matrix.Translation(originX, 0, 0); },
    } }],
  };
}

await test('buildExportContext: "as shown" → factor === BU_TO_MM (1000)', () => {
  const ctx = ExportContext.buildExportContext({
    state: FAKE_STATE,
    units: [unit('a', 72)],
    target: null,
  });
  assert.equal(ctx.referenceRatio, 72);
  assert.equal(ctx.targetRatio, 72);
  assert.equal(ctx.ratioFactor, 1);
  assert.equal(ctx.unitFactor, ExportContext.BU_TO_MM);
  assert.equal(ctx.factor, ExportContext.BU_TO_MM);
});

await test('buildExportContext: target 1:144 on 1:72 → factor === 500 (half size)', () => {
  const ctx = ExportContext.buildExportContext({
    state: FAKE_STATE,
    units: [unit('a', 72)],
    target: 144,
  });
  assert.equal(ctx.ratioFactor, 0.5);
  assert.equal(ctx.factor, 500);
});

await test('buildExportContext: returned object is frozen', () => {
  const ctx = ExportContext.buildExportContext({
    state: FAKE_STATE,
    units: [unit('a', 72)],
    target: null,
  });
  assert.ok(Object.isFrozen(ctx), 'ctx must be frozen');
  assert.throws(() => { ctx.factor = 0; },
    /Cannot assign to read only property|Cannot add property/);
});

await test('buildExportContext: csgSkipped + meshes + cloneGroups arrays stay mutable inside frozen ctx', () => {
  const ctx = ExportContext.buildExportContext({
    state: FAKE_STATE,
    units: [unit('a', 72)],
    target: null,
  });
  ctx.csgSkipped.push('x');
  ctx.meshes.push({ id: 1 });
  ctx.cloneGroups.push({ id: 1 });
  assert.equal(ctx.csgSkipped.length, 1);
  assert.equal(ctx.meshes.length, 1);
  assert.equal(ctx.cloneGroups.length, 1);
});

await test('buildExportContext: pivot defaults to reference unit origin', () => {
  const ctx = ExportContext.buildExportContext({
    state: { ...FAKE_STATE, selection: { activeId: 'a', selectedIds: ['a'] } },
    units: [unit('a', 72, 10)],
    target: null,
  });
  assert.equal(ctx.pivot.x, 10);
  assert.equal(ctx.pivot.y, 0);
  assert.equal(ctx.pivot.z, 0);
});

await test('buildExportContext: throws on empty units list', () => {
  assert.throws(() => ExportContext.buildExportContext({
    state: FAKE_STATE, units: [], target: null,
  }), /units required/);
});

// ── PrintPrep strict requirements ───────────────────────

const stubBabylon = {
  Matrix: {
    Translation: () => ({ multiply() { return this; } }),
    Scaling:     () => ({ multiply() { return this; } }),
  },
  Quaternion: { Identity: () => ({}) },
};
const stubMesh = () => ({
  computeWorldMatrix() {},
  getWorldMatrix() { return { multiply() { return this; } }; },
  bakeTransformIntoVertices() {},
  setParent() {}, refreshBoundingInfo() {},
  position: { set() {} }, rotation: { set() {} },
  scaling: { set() {} }, rotationQuaternion: null,
});

const steps = createPrepSteps({
  BABYLON: stubBabylon,
  weld: () => {},
  isSolidColor: () => true,
  tryCsg: () => {},
});

await test('PrintPrep.flattenWorld throws when ctx.pivot missing', () => {
  assert.throws(() => steps.flattenWorld(stubMesh(), { ratioFactor: 1, unitFactor: 1000 }),
    /pivot required/);
});

await test('PrintPrep.flattenWorld throws when ctx.ratioFactor missing or <= 0', () => {
  const m = stubMesh();
  const p = { x: 0, y: 0, z: 0 };
  assert.throws(() => steps.flattenWorld(m, { pivot: p, unitFactor: 1000 }),
    /ratioFactor must be positive/);
  assert.throws(() => steps.flattenWorld(m, { pivot: p, ratioFactor: 0, unitFactor: 1000 }),
    /ratioFactor must be positive/);
  assert.throws(() => steps.flattenWorld(m, { pivot: p, ratioFactor: -1, unitFactor: 1000 }),
    /ratioFactor must be positive/);
});

await test('PrintPrep.flattenWorld throws when ctx.unitFactor missing or <= 0', () => {
  const m = stubMesh();
  const p = { x: 0, y: 0, z: 0 };
  assert.throws(() => steps.flattenWorld(m, { pivot: p, ratioFactor: 1 }),
    /unitFactor must be positive/);
  assert.throws(() => steps.flattenWorld(m, { pivot: p, ratioFactor: 1, unitFactor: 0 }),
    /unitFactor must be positive/);
});

await test('PrintPrep.flattenWorld accepts a complete ctx', () => {
  const m = stubMesh();
  steps.flattenWorld(m, {
    pivot: { x: 0, y: 0, z: 0 },
    ratioFactor: 1,
    unitFactor: 1000,
  });
  // No throw = pass.
});
