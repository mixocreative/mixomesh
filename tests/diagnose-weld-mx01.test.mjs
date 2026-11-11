// cia MX-01: a UV seam is not a hole.
//
// Imported geometry is unwelded by construction — a textured cube carries four
// vertices per face so each corner can hold its own UV. The validator's own
// topology pass has welded by position since 2026-09-17 and the group diagnose
// since 2026-09-18, but the single-mesh engine diagnose did not: it counted
// every seam edge as open, so `midtone-cube.glb` (which PrusaSlicer and trimesh
// both call watertight) was reported as "24 open edges (holes)", Repair filled
// 0 of them, and strict export refused the file.
//
// The engine is faked here by a REAL boundary-edge counter over the triangles
// it is handed — an independent reader of the same bytes, which is the
// invariant: the verdict the app prints agrees with one.
//   node --import ./tests/register-hooks.mjs --test tests/diagnose-weld-mx01.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installEnv } from './env.mjs';
import { buildGeometry } from './fixtures/make-midtone-cube.mjs';

installEnv();

const R = await import('../src/core/repair/MeshRepair.js');
const { engineDiagnose } = await import('../src/core/repair/Diagnose.js');

// The fixture `midtone-cube.glb` is built from exactly this: a closed 20 mm
// cube, 24 vertices (four per face), 12 triangles, every cube edge a UV seam.
const CUBE = buildGeometry();

/** Count edges used by exactly one triangle — what an open boundary is. */
function countEdges(T) {
  const used = new Map();
  for (const [a, b, c] of T) {
    for (const [x, y] of [[a, b], [b, c], [c, a]]) {
      const k = x < y ? `${x}:${y}` : `${y}:${x}`;
      used.set(k, (used.get(k) ?? 0) + 1);
    }
  }
  let boundary = 0, nonManifold = 0;
  for (const n of used.values()) { if (n === 1) boundary++; else if (n > 2) nonManifold++; }
  return { boundary, nonManifold };
}

R.__test.setEngine({
  diagnose: (V, T) => {
    const { boundary, nonManifold } = countEdges(T);
    return { boundary, nonManifold, components: 1, isWatertight: boundary === 0 && nonManifold === 0 };
  },
  repairObject: async (V, T) => ({ V, T, report: {} }),
});

function cubeMesh(faces = [0, 1, 2, 3, 4, 5]) {
  const indices = faces.flatMap(f => [...CUBE.idx.slice(f * 6, f * 6 + 6)]);
  return {
    name: 'midtone-cube',
    getVerticesData: (kind) => (kind === 'position' ? CUBE.pos : kind === 'uv' ? CUBE.uv : null),
    getIndices: () => indices,
  };
}

test('the fixture really is seam-split: 24 vertices, 12 triangles, no index shared across faces', () => {
  assert.equal(CUBE.pos.length / 3, 24);
  assert.equal(CUBE.idx.length / 3, 12);
  assert.equal(countEdges([...Array(12)].map((_, i) => [...CUBE.idx.slice(i * 3, i * 3 + 3)])).boundary, 24,
    'read raw, every one of the 24 seam edges looks open — that is the bug, verbatim');
});

test('diagnoseMesh answers the WELDED topology: a seam-split closed cube is watertight', async () => {
  const d = await R.diagnoseMesh(cubeMesh());
  assert.equal(d.boundaryEdges, 0, 'a UV seam is not an open edge');
  assert.equal(d.nonManifoldEdges, 0);
  assert.equal(d.isWatertight, true);
});

test('a real hole still reports: the weld hides seams, not defects', async () => {
  const d = await R.diagnoseMesh(cubeMesh([0, 1, 2, 3, 4]));   // one face removed
  assert.equal(d.boundaryEdges, 4, 'the missing face leaves exactly its 4 edges open');
  assert.equal(d.isWatertight, false);
});

test('engineDiagnose (the validator seam) agrees — one mesh, one verdict', async () => {
  const { diag, reason } = await engineDiagnose(cubeMesh());
  assert.equal(reason, null);
  assert.equal(diag.boundaryEdges, 0,
    'MeshValidator reads diag.boundaryEdges straight into its `holes` result');
});
