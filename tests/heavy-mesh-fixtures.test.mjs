import test from 'node:test';
import assert from 'node:assert/strict';
import {
  gridForTriangles, pillowTriangles, binaryStlChunks, asciiStlChunks, threeMFModelChunks,
} from '../scripts/heavy-mesh/generate.mjs';

test('gridForTriangles: 4·n² lands near the requested count', () => {
  for (const target of [2e6, 5e6, 1e7]) {
    const n = gridForTriangles(target);
    assert.ok(Math.abs(4 * n * n - target) / target < 0.001, `${target} → ${4 * n * n}`);
  }
});

test('binary STL: 84-byte header with the triangle count, 50 bytes per facet', () => {
  const n = 7;
  const bytes = Buffer.concat([...binaryStlChunks(n)]);
  assert.equal(bytes.length, 84 + 50 * 4 * n * n);
  assert.equal(bytes.readUInt32LE(80), 4 * n * n);
});

test('pillow is closed: every undirected edge is used exactly twice', () => {
  const n = 5;
  const key = (t, a) => `${t[a * 3]},${t[a * 3 + 1]},${t[a * 3 + 2]}`;
  const edges = new Map();
  for (const t of pillowTriangles(n)) {
    for (const [a, b] of [[0, 1], [1, 2], [2, 0]]) {
      const ka = key(t, a), kb = key(t, b);
      const k = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
      edges.set(k, (edges.get(k) ?? 0) + 1);
    }
  }
  assert.ok([...edges.values()].every(c => c === 2));
});

test('ASCII STL and 3MF XML carry the same triangle count', () => {
  const n = 4;
  const ascii = [...asciiStlChunks(n)].join('');
  assert.equal(ascii.match(/endfacet/g).length, 4 * n * n);
  const xml = [...threeMFModelChunks(n)].join('');
  assert.equal(xml.match(/<triangle /g).length, 4 * n * n);
  assert.match(xml, /<build><item objectid="1"\/><\/build>/);
});
