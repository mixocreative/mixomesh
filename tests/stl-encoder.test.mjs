// Lean STL encoder: byte-identical to the original per-facet-object encoder
// (kept below as the oracle), without building one JS array per triangle.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installEnv } from './env.mjs';
installEnv();
const { encodeBinarySTL, encodeBinarySTLFromArrays, shouldEncodeStlInWorker, STL_WORKER_TRIANGLES } =
  await import('../src/core/print/StlWriter.js');
const { positionsToPrintSpace, printIndices } = await import('../src/core/print/PrintSpace.js');

/** The pre-refactor encoder, verbatim in behaviour: the oracle. */
function oracle(meshEntries, solidName = 'mixomesh') {
  const facets = [];
  for (const { mesh } of meshEntries) {
    const raw = mesh.getVerticesData?.('position');
    const idx = printIndices(mesh);
    if (!raw || !idx.length) continue;
    const pos = positionsToPrintSpace(raw);
    for (let i = 0; i + 2 < idx.length; i += 3) {
      const a = idx[i] * 3, b = idx[i + 1] * 3, c = idx[i + 2] * 3;
      facets.push([pos[a], pos[a + 1], pos[a + 2], pos[b], pos[b + 1], pos[b + 2], pos[c], pos[c + 1], pos[c + 2]]);
    }
  }
  const bytes = new Uint8Array(84 + facets.length * 50);
  const view = new DataView(bytes.buffer);
  const header = `mixomesh binary STL ${solidName}`.slice(0, 79);
  for (let i = 0; i < header.length; i++) bytes[i] = header.charCodeAt(i) & 0x7f;
  view.setUint32(80, facets.length, true);
  let o = 84;
  for (const f of facets) {
    const ux = f[3] - f[0], uy = f[4] - f[1], uz = f[5] - f[2];
    const vx = f[6] - f[0], vy = f[7] - f[1], vz = f[8] - f[2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    const n = len > 0 ? [nx / len, ny / len, nz / len] : [0, 0, 0];
    view.setFloat32(o, n[0], true); view.setFloat32(o + 4, n[1], true); view.setFloat32(o + 8, n[2], true);
    for (let k = 0; k < 9; k++) view.setFloat32(o + 12 + k * 4, f[k], true);
    view.setUint16(o + 48, 0, true);
    o += 50;
  }
  return bytes;
}

function mesh(name, positions, indices, sideOrientation) {
  return {
    name, sideOrientation,
    getVerticesData: kind => (kind === 'position' ? Float32Array.from(positions) : null),
    getIndices: () => indices,
  };
}

// Pseudo-random but deterministic geometry, including a degenerate triangle.
function noisyMesh(name, triangles, seed, side) {
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648) * 20 - 10;
  const positions = Array.from({ length: triangles * 3 * 3 }, rnd);
  positions.splice(0, 9, 1, 1, 1, 1, 1, 1, 1, 1, 1);   // zero-area first facet
  return mesh(name, positions, Array.from({ length: triangles * 3 }, (_, i) => i), side);
}

test('byte-identical to the original encoder across meshes, windings and a degenerate facet', () => {
  const entries = [
    { mesh: noisyMesh('a', 40, 7) },
    { mesh: noisyMesh('b', 25, 99, 1) },               // ClockWise flag → reversed winding
    { mesh: mesh('empty', [], []) },
  ];
  const got = encodeBinarySTL(entries, 'part');
  const want = oracle(entries, 'part');
  assert.equal(got.length, want.length);
  assert.deepEqual(Buffer.from(got), Buffer.from(want));
});

test('long solid names are truncated in the header exactly as before', () => {
  const entries = [{ mesh: noisyMesh('a', 3, 1) }];
  const name = 'x'.repeat(200);
  assert.deepEqual(Buffer.from(encodeBinarySTL(entries, name)), Buffer.from(oracle(entries, name)));
});

test('an out-of-range index still throws with the mesh name', () => {
  assert.throws(() => encodeBinarySTL([{ mesh: mesh('broken', [0,0,0, 1,0,0, 0,1,0], [0, 1, 9]) }]), /triangle index out of range in "broken"/);
});

test('array core produces the same bytes from prepared print-space parts', () => {
  const m = noisyMesh('c', 12, 5);
  const parts = [{ name: 'c', positions: positionsToPrintSpace(m.getVerticesData('position')), indices: Uint32Array.from(printIndices(m)) }];
  assert.deepEqual(Buffer.from(encodeBinarySTLFromArrays(parts, 'c')), Buffer.from(oracle([{ mesh: m }], 'c')));
});

test('worker encode only for large jobs with a Worker available', () => {
  assert.equal(STL_WORKER_TRIANGLES, 200_000);
  assert.equal(shouldEncodeStlInWorker(STL_WORKER_TRIANGLES, true), true);
  assert.equal(shouldEncodeStlInWorker(STL_WORKER_TRIANGLES - 1, true), false);
  assert.equal(shouldEncodeStlInWorker(10_000_000, false), false);
});
