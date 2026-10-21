import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTriangleBvh, raycastBvh } from '../src/core/geometry/triangleBvh.js';

function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }

function blob(seg = 60, rings = 40, seed = 7) {
  const r = rng(seed);
  const pos = [];
  for (let j = 0; j <= rings; j++) for (let i = 0; i <= seg; i++) {
    const th = (i / seg) * 2 * Math.PI, ph = (j / rings) * Math.PI, rad = 1 + 0.2 * r();
    pos.push(rad * Math.sin(ph) * Math.cos(th), rad * Math.cos(ph), rad * Math.sin(ph) * Math.sin(th));
  }
  const idx = [];
  const v = (i, j) => j * (seg + 1) + i;
  for (let j = 0; j < rings; j++) for (let i = 0; i < seg; i++) idx.push(v(i, j), v(i + 1, j + 1), v(i + 1, j), v(i, j), v(i, j + 1), v(i + 1, j + 1));
  return { positions: new Float32Array(pos), indices: new Uint32Array(idx) };
}

function brute(positions, indices, o, d, length = Infinity) {
  let best = null;
  const bvh = { bounds: new Float32Array([-1e9, -1e9, -1e9, 1e9, 1e9, 1e9]), data: new Uint32Array([0, indices.length / 3]), tris: Uint32Array.from({ length: indices.length / 3 }, (_, i) => i) };
  best = raycastBvh(bvh, positions, indices, o, d, { length });
  return best;
}

test('BVH covers every triangle exactly once and nests child bounds', () => {
  const { positions, indices } = blob();
  const bvh = buildTriangleBvh(positions, indices);
  const seen = new Uint8Array(indices.length / 3);
  for (let n = 0; n < bvh.nodeCount; n++) {
    const count = bvh.data[n * 2 + 1];
    if (count) { for (let s = bvh.data[n * 2]; s < bvh.data[n * 2] + count; s++) seen[bvh.tris[s]]++; continue; }
    const c = bvh.data[n * 2];
    for (const child of [c, c + 1]) for (let k = 0; k < 3; k++) {
      assert.ok(bvh.bounds[child * 6 + k] >= bvh.bounds[n * 6 + k] - 1e-6);
      assert.ok(bvh.bounds[child * 6 + 3 + k] <= bvh.bounds[n * 6 + 3 + k] + 1e-6);
    }
  }
  assert.ok(seen.every(x => x === 1));
});

test('raycast = brute force (face, distance, barycentrics) on 500 random rays', () => {
  const { positions, indices } = blob();
  const bvh = buildTriangleBvh(positions, indices);
  const r = rng(3);
  let hits = 0;
  for (let q = 0; q < 500; q++) {
    const o = { x: (r() - 0.5) * 6, y: (r() - 0.5) * 6, z: (r() - 0.5) * 6 };
    const t = { x: (r() - 0.5) * 0.5, y: (r() - 0.5) * 0.5, z: (r() - 0.5) * 0.5 };
    const len = Math.hypot(t.x - o.x, t.y - o.y, t.z - o.z);
    const d = { x: (t.x - o.x) / len, y: (t.y - o.y) / len, z: (t.z - o.z) / len };
    const a = raycastBvh(bvh, positions, indices, o, d);
    const b = brute(positions, indices, o, d);
    assert.equal(!!a, !!b);
    if (!a) continue;
    hits++;
    assert.equal(a.faceId, b.faceId);
    assert.equal(a.distance, b.distance);
    assert.equal(a.bu, b.bu);
    assert.equal(a.bv, b.bv);
  }
  assert.ok(hits > 400);
});

test('ray length and backwards hits are rejected like Babylon', () => {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const indices = new Uint32Array([0, 1, 2]);
  const bvh = buildTriangleBvh(positions, indices);
  const o = { x: 0.2, y: 0.2, z: -1 };
  assert.equal(raycastBvh(bvh, positions, indices, o, { x: 0, y: 0, z: 1 }).distance, 1);
  assert.equal(raycastBvh(bvh, positions, indices, o, { x: 0, y: 0, z: 1 }, { length: 0.5 }), null);
  assert.equal(raycastBvh(bvh, positions, indices, o, { x: 0, y: 0, z: -1 }), null);
  const back = raycastBvh(bvh, positions, indices, { x: 0.2, y: 0.2, z: 1 }, { x: 0, y: 0, z: -1 });
  assert.ok(back, 'two-sided');
});

test('builds a 1M-triangle mesh in well under the worker budget', () => {
  const { positions, indices } = blob(710, 704, 11);
  const t0 = performance.now();
  const bvh = buildTriangleBvh(positions, indices);
  const ms = performance.now() - t0;
  assert.ok(indices.length / 3 > 990_000);
  assert.ok(ms < 6000, `${Math.round(ms)} ms`);
  const t1 = performance.now();
  for (let i = 0; i < 1000; i++) raycastBvh(bvh, positions, indices, { x: 5, y: 0.01 * i - 5, z: 0.3 }, { x: -1, y: 0, z: 0 });
  assert.ok(performance.now() - t1 < 1000);
});
