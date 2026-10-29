// P4.2 support export: the pure pieces of the export seam (node). The full path (engine build,
// writers, independent readers) is covered by tests/consumers.mjs and
// tests/browser-supports-export-smoke.mjs.
//   node --import ./tests/register-hooks.mjs --test tests/supports-export.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { installEnv } from './env.mjs';

installEnv();
const BABYLON = { ...await import('@babylonjs/core') };
globalThis.window.BABYLON = BABYLON;

const { resolveIncludeSupports, hasBuiltSupports, INCLUDE_SUPPORTS } = await import('../src/core/print/ExportContext.js');
const { createPrepSteps } = await import('../src/core/print/PrintPrep.js');
const { buildReadiness } = await import('../src/core/print/PrintReadiness.js');

const engine = new BABYLON.NullEngine();
const scene = new BABYLON.Scene(engine);

function tri(name, positions) {
  const mesh = new BABYLON.Mesh(name, scene);
  const vd = new BABYLON.VertexData();
  vd.positions = positions;
  vd.indices = [0, 1, 2];
  vd.applyToMesh(mesh, true);
  return mesh;
}

test('includeSupports: explicit choice wins; absent = model + supports only when an object has built supports', () => {
  assert.deepEqual([...INCLUDE_SUPPORTS], ['none', 'printable', 'supportsOnly']);
  assert.equal(resolveIncludeSupports(undefined, true), 'printable');
  assert.equal(resolveIncludeSupports(null, false), 'none');
  assert.equal(resolveIncludeSupports('none', true), 'none');
  assert.equal(resolveIncludeSupports('printable', false), 'none');
  assert.equal(resolveIncludeSupports('supportsOnly', false), 'supportsOnly', 'kept, so the pipeline refuses instead of shipping the model');
  assert.equal(hasBuiltSupports({ supports: { sourceHash: 'h', pose: { rotation: [0, 0, 0, 1], scale: [1, 1, 1] } } }), true);
  assert.equal(hasBuiltSupports({ supports: { sourceHash: null, pose: null } }), false);
  assert.equal(hasBuiltSupports({}), false);
});

test('readiness: stale supports and a supports-only export without supports are errors (block export)', () => {
  const parts = [{ objectId: 'a', objectIds: ['a'], sourceAvailable: true, unitConfirmed: true, textureAvailable: true, validationResults: [], validationPending: false }];
  const base = buildReadiness({ parts, supports: { include: 'printable', stale: [], missing: false } });
  assert.equal(base.canExport, true);
  const stale = buildReadiness({ parts, supports: { include: 'printable', stale: ['a'], missing: false } });
  assert.equal(stale.canExport, false);
  assert.deepEqual(stale.issues.find(i => i.code === 'supports-stale')?.objectIds, ['a']);
  const missing = buildReadiness({ parts, supports: { include: 'supportsOnly', stale: [], missing: true } });
  assert.equal(missing.canExport, false);
  assert.ok(missing.issues.some(i => i.code === 'supports-missing' && i.severity === 'error'));
});

const steps = createPrepSteps({ BABYLON, weld: () => {}, isSolidColor: m => !m.material?.diffuseTexture, tryCsg: () => {}, tryRepair: () => {} });

test('flattenPhysical: the origin follows the pivot-anchored ratio, the vertices keep their size (tips never scaled)', () => {
  const mesh = tri('sup', [0, 0, 0, 0.001, 0, 0, 0, 0.002, 0]);   // 1 mm / 2 mm legs (scene units are metres)
  mesh.position.set(0.010, 0.020, 0.030);
  steps.flattenPhysical(mesh, { pivot: { x: 0.010, y: 0, z: 0 }, ratioFactor: 2, unitFactor: 1000 });
  const p = [...mesh.getVerticesData(BABYLON.VertexBuffer.PositionKind)].map(v => +v.toFixed(4));
  // origin: pivot + 2 x (origin - pivot) = (10, 40, 60) mm; legs stay 1 mm and 2 mm
  assert.deepEqual(p, [10, 40, 60, 11, 40, 60, 10, 42, 60]);
  assert.deepEqual(mesh.position.asArray(), [0, 0, 0]);
  assert.throws(() => steps.flattenPhysical(tri('x', [0, 0, 0, 1, 0, 0, 0, 1, 0]), { ratioFactor: 1, unitFactor: 1000 }), /pivot required/);
});

test('optimizeIndices: awaited (its late index write once tore the CSG re-bake), skipped on a textured part', async () => {
  const solid = tri('solid', [0, 0, 0, 1, 0, 0, 0, 1, 0]);
  let done = false;
  solid.optimizeIndices = (cb) => { setTimeout(() => { done = true; cb(); }, 5); return solid; };
  await steps.optimizeIndices(solid);
  assert.equal(done, true, 'the step resolves only after Babylon finished');
  const textured = tri('textured', [0, 0, 0, 1, 0, 0, 0, 1, 0]);
  textured.material = new BABYLON.StandardMaterial('m', scene);
  textured.material.diffuseTexture = { name: 'paint' };
  let called = false;
  textured.optimizeIndices = () => { called = true; return textured; };
  await steps.optimizeIndices(textured);
  assert.equal(called, false, 'a position-only merge would fold the UV seams');
});
