// The pure typed-array steps extracted from ThreeMFLoader (thermo 02/F6),
// run under Node with no Babylon.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  withoutTriangleRanges, placeVertices, groupTriangles, soupIndices, compactGroup,
} from '../src/core/import/threeMFGeometry.js';

const IDENTITY_BASIS = [1, 0, 0, 0, 1, 0, 0, 0, 1];
// A quad as two triangles over four vertices; fields: v1 v2 v3 pid p1 p2 p3.
const quad = () => ({
  positions: new Float64Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]),
  triangles: new Int32Array([0, 1, 2, -1, -1, -1, -1, 0, 2, 3, -1, -1, -1, -1]),
});

test('placeVertices: unit scale, then placement, then basis; a NaN names the vertex', () => {
  const out = placeVertices(new Float64Array([1, 2, 3]), 10, null, [0, 1, 0, 0, 0, 1, 1, 0, 0], 'o');
  assert.deepEqual([...out], [20, 30, 10]);
  const translate = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 6, 7, 1];
  assert.deepEqual([...placeVertices(new Float64Array([1, 1, 1]), 1, translate, IDENTITY_BASIS, 'o')], [6, 7, 8]);
  assert.throws(() => placeVertices(new Float64Array([0, NaN, 0]), 1, null, IDENTITY_BASIS, '7'), /vertex 0 of object 7 has a non-numeric coordinate/);
});

test('withoutTriangleRanges drops helper triangles and compacts the pool', () => {
  const g = withoutTriangleRanges(quad(), [[1, 1]]);
  assert.equal(g.triangles.length, 7);
  assert.deepEqual([...g.triangles.subarray(0, 3)], [0, 1, 2]);
  assert.equal(g.positions.length, 9, 'vertex 3 left with the dropped triangle');
});

test('groupTriangles: object defaults, first-seen groups, and the single-solid shortcut', () => {
  const keyOf = (pid, p1) => ({ str: pid == null ? '' : `c:${pid}:${p1}`, tg: null });
  const solid = groupTriangles(quad().triangles, 4, { pid: null, pindex: 0 }, keyOf, 'o');
  assert.equal(solid.singleSolid, true);
  assert.deepEqual([...soupIndices(quad().triangles)], [0, 1, 2, 0, 2, 3]);

  const tri = quad().triangles;
  tri[3] = 1; tri[4] = 0;              // first triangle: pid 1 p1 0
  tri[10] = 1; tri[11] = 1; tri[12] = 1; tri[13] = 1;
  const two = groupTriangles(tri, 4, { pid: '9', pindex: 0 }, keyOf, 'o');
  assert.equal(two.singleSolid, false);
  assert.deepEqual(two.groups.map(g => g.key.str), ['c:1:0', 'c:1:1']);
  assert.deepEqual([...two.groups[0].tris], [0, 1, 2, 0, 0, 0], 'p2/p3 default to p1');
  assert.deepEqual([...two.groups[1].tris], [0, 2, 3, 1, 1, 1]);
  const bad = quad().triangles; bad[2] = 4;
  assert.throws(() => groupTriangles(bad, 4, { pid: null, pindex: 0 }, keyOf, 'x'), /triangle 0 of object x references a vertex outside 0\.\.3/);
});

test('compactGroup: solid groups key on the vertex, textured groups on (vertex, UV)', () => {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]);
  const tris = new Int32Array([0, 1, 2, 0, 0, 0, 0, 2, 3, 0, 0, 0]);
  const solid = compactGroup(tris, positions, null);
  assert.equal(solid.positions.length / 3, 4);
  assert.equal(solid.uvs, null);
  assert.deepEqual([...solid.indices], [0, 1, 2, 0, 2, 3]);

  const seam = new Int32Array([0, 1, 2, 0, 0, 0, 0, 2, 3, 1, 1, 1]);
  const textured = compactGroup(seam, positions, [{ u: 0, v: 0 }, { u: 1, v: 1 }]);
  assert.equal(textured.positions.length / 3, 6, 'vertices 0 and 2 split at the UV seam');
  assert.deepEqual([...textured.uvs.slice(0, 2)], [0, 0]);
  assert.deepEqual([...textured.indices], [0, 1, 2, 3, 4, 5]);
});
