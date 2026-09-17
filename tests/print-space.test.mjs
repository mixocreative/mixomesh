// PrintSpace — the Babylon ↔ print-space axis/winding seam. Run:
//   node --import ./tests/register-hooks.mjs tests/print-space.test.mjs
//
// Authority for the expected vectors: tests/fixtures/prusa-tetra.3mf, written
// by PrusaSlicer 2.9.3 (`prusa-slicer-console --export-3mf`) from a
// tetrahedron whose glTF-space vertices are (0,0,0) (10,0,0) (0,20,0) (0,0,30).
// PrusaSlicer stores it in 3MF space as (x, -z, y) of the glTF coordinates
// (Z-up, right-handed), so the Babylon→3MF map must undo Babylon's glTF
// x-reflection and rotate Y-up to Z-up without mirroring.

import assert from 'node:assert/strict';
import { installEnv } from './env.mjs';

installEnv();

const {
  toPrintSpace, fromPrintSpace, printIndices, signedVolume,
  positionsToPrintSpace, PRINT_MAP_DET, frontFaceIsClockwise,
} = await import('../src/core/print/PrintSpace.js');
const { encodeBinarySTL } = await import('../src/core/print/StlWriter.js');

let passed = 0, failed = 0;
const out = [];
async function test(name, fn) {
  try { await fn(); out.push(`PASS  ${name}`); passed++; }
  catch (err) { out.push(`FAIL  ${name}\n      ${err.stack || err.message}`); failed++; }
}

// Babylon copy of the tetra as the app holds it after a correct import:
// glTF x negated by the loader's root reflection, indices reversed by
// Babylon's bakeTransformIntoVertices (det<0 → flipFaces), mesh flagged
// ClockWise by Babylon's glTF loader. Source glTF indices were
// [0,2,1, 0,1,3, 0,3,2, 1,2,3] (counter-clockwise-outward, right-handed).
const GLTF_TETRA_BABYLON_POS = [0, 0, 0, -10, 0, 0, 0, 20, 0, 0, 0, 30];
const GLTF_TETRA_IDX = [0, 1, 2, 0, 3, 1, 0, 2, 3, 1, 3, 2];
// glTF-space source of the same solid; PrusaSlicer stores (x, -z, y) of it.
const GLTF_TETRA_SOURCE_POS = [0, 0, 0, 10, 0, 0, 0, 20, 0, 0, 0, 30];

const det3 = (m) =>
  m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
const matrixOf = (fn) => {
  const ex = fn(1, 0, 0), ey = fn(0, 1, 0), ez = fn(0, 0, 1);
  return [ex[0], ey[0], ez[0], ex[1], ey[1], ez[1], ex[2], ey[2], ez[2]];
};

await test('toPrintSpace is a reflection (det -1), fromPrintSpace is its exact inverse', () => {
  assert.equal(det3(matrixOf(toPrintSpace)), -1);
  assert.equal(PRINT_MAP_DET, -1);
  for (const v of [[1, 2, 3], [-4, 0.5, 9], [0, 0, 0]]) {
    assert.deepEqual(fromPrintSpace(...toPrintSpace(...v)), v);
    assert.deepEqual(toPrintSpace(...fromPrintSpace(...v)), v);
  }
});

await test('Babylon copy of a glTF solid maps onto the PrusaSlicer-authored 3MF coordinates (up stays up, chirality preserved)', () => {
  const got = Array.from(positionsToPrintSpace(GLTF_TETRA_BABYLON_POS));
  const expected = [];
  for (let i = 0; i < GLTF_TETRA_SOURCE_POS.length; i += 3) {
    const x = GLTF_TETRA_SOURCE_POS[i], y = GLTF_TETRA_SOURCE_POS[i + 1], z = GLTF_TETRA_SOURCE_POS[i + 2];
    expected.push(x, 0 - z, y);
  }
  assert.deepEqual(got, expected);
});

await test('a PrusaSlicer 3MF vertex lands in Babylon with +Z (up) mapped to +Y and x reflected like a glTF import', () => {
  // 3MF (0,0,30) is the apex 30 mm above the bed → Babylon (0, 30, 0).
  assert.deepEqual(fromPrintSpace(0, 0, 30), [0, 30, 0]);
  // 3MF (10,0,0) → Babylon (-10, 0, 0): same reflection Babylon's glTF loader bakes.
  assert.deepEqual(fromPrintSpace(10, 0, 0), [-10, 0, 0]);
});

await test('printIndices: ClockWise-flagged (glTF) mesh is reversed, CounterClockWise (native) is kept; buffer untouched', () => {
  const idx = [0, 2, 1, 0, 1, 3];
  const gltfMesh = { sideOrientation: 0, material: { sideOrientation: null }, getIndices: () => idx };
  const nativeMesh = { sideOrientation: 1, material: { sideOrientation: null }, getIndices: () => idx };
  assert.equal(frontFaceIsClockwise(gltfMesh), true);
  assert.equal(frontFaceIsClockwise(nativeMesh), false);
  assert.deepEqual(printIndices(gltfMesh), [0, 1, 2, 0, 3, 1]);
  assert.deepEqual(printIndices(nativeMesh), [0, 2, 1, 0, 1, 3]);
  assert.deepEqual(idx, [0, 2, 1, 0, 1, 3], 'source buffer not mutated');
  // material.sideOrientation wins over the mesh flag (Babylon _getEffectiveOrientation).
  const matWins = { sideOrientation: 1, material: { sideOrientation: 0 }, getIndices: () => idx };
  assert.deepEqual(printIndices(matWins), [0, 1, 2, 0, 3, 1]);
});

await test('glTF-imported solid: print-space output is counter-clockwise-outward (signed volume +1000 mm³)', () => {
  const m = { name: 'tet', sideOrientation: 0, material: {}, getIndices: () => GLTF_TETRA_IDX,
    getVerticesData: () => GLTF_TETRA_BABYLON_POS };
  assert.ok(signedVolume(GLTF_TETRA_BABYLON_POS, GLTF_TETRA_IDX) > 0,
    'a ClockWise-flagged outward mesh has POSITIVE raw signed volume (opposite of a native CCW mesh)');
  const vol = signedVolume(positionsToPrintSpace(GLTF_TETRA_BABYLON_POS), printIndices(m));
  assert.ok(Math.abs(vol - 1000) < 1e-6, `expected +1000, got ${vol}`);
});

await test('native-style solid (CounterClockWise flag, negative raw volume) also exports outward', () => {
  // Babylon-native outward meshes have NEGATIVE raw signed volume in the
  // right-handed formula (measured on MeshBuilder.CreateBox); the reflection
  // flips it positive with no index change.
  const pos = [0, 0, 0, -10, 0, 0, 0, 20, 0, 0, 0, 30];
  const idx = [0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3];
  assert.ok(signedVolume(pos, idx) < 0, 'fixture is Babylon-native-outward (raw volume negative)');
  const m = { name: 'n', sideOrientation: 1, material: {}, getIndices: () => idx, getVerticesData: () => pos };
  const vol = signedVolume(positionsToPrintSpace(pos), printIndices(m));
  assert.ok(vol > 0, `expected outward (+), got ${vol}`);
});

await test('encodeBinarySTL: little-endian layout, 50 bytes per facet, print-space coordinates, outward normals', () => {
  const m = { name: 'tet', sideOrientation: 0, material: {}, getIndices: () => GLTF_TETRA_IDX,
    getVerticesData: () => GLTF_TETRA_BABYLON_POS };
  const bytes = encodeBinarySTL([{ mesh: m }], 'tet');
  assert.equal(bytes.length, 84 + 4 * 50);
  const view = new DataView(bytes.buffer);
  assert.equal(view.getUint32(80, true), 4, 'triangle count is little-endian');
  assert.notEqual(view.getUint32(80, false), 4, 'big-endian read must NOT also be 4 (regression guard)');
  const pos = [], idx = [];
  for (let t = 0; t < 4; t++) {
    const o = 84 + t * 50;
    const n = [view.getFloat32(o, true), view.getFloat32(o + 4, true), view.getFloat32(o + 8, true)];
    for (let k = 0; k < 3; k++) {
      pos.push(view.getFloat32(o + 12 + k * 12, true), view.getFloat32(o + 16 + k * 12, true), view.getFloat32(o + 20 + k * 12, true));
      idx.push(t * 3 + k);
    }
    assert.ok(Math.abs(Math.hypot(...n) - 1) < 1e-5, 'unit normal');
    assert.equal(view.getUint16(o + 48, true), 0, 'attribute byte count 0');
  }
  assert.ok(signedVolume(pos, idx) > 999, 'STL facets are outward in a right-handed reader');
  const xs = pos.filter((_, i) => i % 3 === 0), zs = pos.filter((_, i) => i % 3 === 2);
  assert.equal(Math.max(...xs), 10, 'x extent matches the Prusa fixture (not mirrored)');
  assert.equal(Math.max(...zs), 20, 'glTF +Y (20 mm) is STL +Z (up), not -Z');
});

console.log('\n' + out.join('\n'));
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
