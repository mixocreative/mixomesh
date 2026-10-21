// Boolean core: the pure array path the Boolean worker runs, exercised here
// against the REAL vendored manifold-3d (loads under Node).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const { booleanArrays, worldOperand } = await import('../src/core/geometry/booleanCore.js');
const manifoldUrl = pathToFileURL(resolve('public/vendor/manifold-3d/manifold.js')).href;
const { default: Module } = await import(manifoldUrl);
const wasm = await Module();
wasm.setup();

const IDENTITY = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];
const translate = (x, y, z) => [1,0,0,0, 0,1,0,0, 0,0,1,0, x,y,z,1];

/** A unit cube as a Babylon mesh would hold it: split per-face vertices (24), Babylon winding. */
function babylonCube() {
  const m = wasm.Manifold.cube([1, 1, 1]).getMesh();
  // Unweld: every triangle corner gets its own vertex (like per-face normals on import).
  const tri = m.triVerts;
  const positions = new Float32Array(tri.length * 3);
  const indices = new Uint32Array(tri.length);
  for (let i = 0; i < tri.length; i += 3) {
    // Manifold is CCW; Babylon data reaching CSG2 is the reverse order.
    const order = [tri[i + 2], tri[i + 1], tri[i]];
    for (let c = 0; c < 3; c++) {
      const v = order[c];
      positions.set([m.vertProperties[v * 3], m.vertProperties[v * 3 + 1], m.vertProperties[v * 3 + 2]], (i + c) * 3);
      indices[i + c] = i + c;
    }
  }
  return { positions, indices };
}

function signedVolumeBabylon({ positions, indices }) {
  // Babylon winding is reversed vs Manifold: positive Manifold volume = negative here.
  let v = 0;
  for (let i = 0; i < indices.length; i += 3) {
    const [a, b, c] = [indices[i], indices[i + 2], indices[i + 1]].map(k => [positions[k * 3], positions[k * 3 + 1], positions[k * 3 + 2]]);
    v += a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0]);
  }
  return v / 6;
}

test('worldOperand applies translation to positions and the 3x3 to normals', () => {
  const op = worldOperand({
    positions: new Float32Array([1, 2, 3]), normals: new Float32Array([0, 0, 1]),
    indices: new Uint32Array([0, 0, 0]), matrix: [2,0,0,0, 0,2,0,0, 0,0,2,0, 10,20,30,1],
  });
  assert.deepEqual([...op.positions], [12, 24, 36]);
  assert.deepEqual([...op.normals], [0, 0, 2]);
});

test('union of two overlapping cubes matches Manifold directly', () => {
  const a = { ...babylonCube(), matrix: IDENTITY };
  const b = { ...babylonCube(), matrix: translate(0.5, 0.5, 0.5) };
  const out = booleanArrays(wasm, 'union', [a, b]);
  const direct = wasm.Manifold.cube([1, 1, 1]).add(wasm.Manifold.cube([1, 1, 1]).translate([0.5, 0.5, 0.5])).getMesh();
  assert.equal(out.indices.length / 3, direct.triVerts.length / 3);
  assert.ok(Math.abs(signedVolumeBabylon(out) - (2 - 0.125)) < 1e-4, `volume ${signedVolumeBabylon(out)}`);
  assert.ok(out.positions instanceof Float32Array && out.indices instanceof Uint32Array);
});

test('subtract and intersect use operand order (base = first)', () => {
  const a = { ...babylonCube(), matrix: IDENTITY };
  const b = { ...babylonCube(), matrix: translate(0.5, 0, 0) };
  assert.ok(Math.abs(signedVolumeBabylon(booleanArrays(wasm, 'subtract', [a, b])) - 0.5) < 1e-4);
  assert.ok(Math.abs(signedVolumeBabylon(booleanArrays(wasm, 'intersect', [a, b])) - 0.5) < 1e-4);
});

test('normals travel through when every operand has them', () => {
  const withNormals = cube => ({ ...cube, normals: new Float32Array(cube.positions.length).fill(0.5), matrix: IDENTITY });
  const out = booleanArrays(wasm, 'union', [withNormals(babylonCube()), { ...withNormals(babylonCube()), matrix: translate(2, 0, 0) }]);
  assert.ok(out.normals instanceof Float32Array);
  assert.equal(out.normals.length, out.positions.length);
  const mixed = booleanArrays(wasm, 'union', [withNormals(babylonCube()), { ...babylonCube(), matrix: translate(2, 0, 0) }]);
  assert.equal(mixed.normals, null, 'normals dropped when an operand lacks them');
});

test('an open (non-manifold) operand fails with a clear error', () => {
  const open = babylonCube();
  const holed = { positions: open.positions, indices: open.indices.slice(3), matrix: IDENTITY };
  assert.throws(() => booleanArrays(wasm, 'union', [holed, { ...babylonCube(), matrix: translate(0.5, 0, 0) }]), /Boolean|manifold/i);
});

test('rejects a bad op or fewer than two operands', () => {
  const a = { ...babylonCube(), matrix: IDENTITY };
  assert.throws(() => booleanArrays(wasm, 'xor', [a, a]), /bad op/);
  assert.throws(() => booleanArrays(wasm, 'union', [a]), /two/);
});
