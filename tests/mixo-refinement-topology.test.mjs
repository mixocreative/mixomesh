import test from 'node:test';
import assert from 'node:assert/strict';
import { refineTopology, refineTopologyParts } from '../src/core/refinement/Topology.js';

const TRI = { positions: new Float32Array([0,0,0, 2,0,0, 0,2,0]), indices: new Uint32Array([0,1,2]), uvs: new Float32Array([0,0, 1,0, 0,1]) };
const bits = weight => new Uint32Array(new Float32Array([weight]).buffer)[0];
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-5, `${actual} != ${expected}`);

test('level zero preserves input geometry by value without aliasing', () => {
  const result = refineTopology(TRI, 0);
  assert.deepEqual([...result.positions], [...TRI.positions]);
  assert.deepEqual([...result.indices], [...TRI.indices]);
  assert.notEqual(result.positions, TRI.positions);
});

test('one Loop step gives boundary vertex and edge rules with valid winding', () => {
  const result = refineTopology(TRI, 1);
  assert.equal(result.indices.length, 12);
  assert.equal(result.uvs.length, result.positions.length / 3 * 2);
  assert.equal(result.normals.length, result.positions.length);
  near(result.positions[0], 0.25);
  near(result.positions[1], 0.25);
  for (const index of result.indices) assert.ok(index < result.positions.length / 3);
});

test('coincident UV seam corners share subdivided positions without sharing UVs', () => {
  const input = {
    positions: new Float32Array([0,0,0, 1,0,0, 0,1,0, 1,0,0, 1,1,0, 0,1,0]),
    indices: new Uint32Array([0,1,2, 3,4,5]),
    uvs: new Float32Array([0,0, 1,0, 0,1, 0,0, 1,1, 0,1]),
  };
  const result = refineTopology(input, 1);
  const matches = [];
  for (let i = 0; i < result.positions.length / 3; i++) {
    const p = result.positions.subarray(i * 3, i * 3 + 3);
    if (Math.abs(p[0] - 0.875) < 1e-5 && Math.abs(p[1] - 0.125) < 1e-5) matches.push(i);
  }
  assert.ok(matches.length >= 2, 'seam positions coincide after smoothing');
  assert.ok(new Set(matches.map(i => result.uvs[i * 2])).size > 1, 'UV chart split is retained');
});

test('explicit hard edge overrides smooth interior rule; fractional weight blends', () => {
  const input = { positions: new Float32Array([0,0,0, 2,0,0, 0,2,0, 2,2,2]), indices: new Uint32Array([0,1,2, 1,3,2]) };
  const smooth = refineTopology(input, 1);
  const hard = refineTopology({ ...input, sharpEdges: new Uint32Array([1,2,bits(1)]) }, 1);
  const half = refineTopology({ ...input, sharpEdges: new Uint32Array([1,2,bits(0.5)]) }, 1);
  const maxZ = result => {
    for (let i = 0; i < result.positions.length; i += 3) {
      if (Math.abs(result.positions[i] - 1) < 1e-5 && Math.abs(result.positions[i + 1] - 1) < 1e-5) return result.positions[i + 2];
    }
    throw new Error('missing interior edge point');
  };
  assert.ok(maxZ(hard) !== maxZ(smooth));
  assert.ok(maxZ(half) > Math.min(maxZ(hard), maxZ(smooth)));
  assert.ok(maxZ(half) < Math.max(maxZ(hard), maxZ(smooth)));
});

test('rejects empty, nonfinite, nonmanifold, and oversized input', () => {
  assert.throws(() => refineTopology({ positions: new Float32Array(), indices: new Uint32Array() }, 1), /empty/);
  assert.throws(() => refineTopology({ ...TRI, positions: new Float32Array([NaN,0,0, 2,0,0, 0,2,0]) }, 1), /finite/);
  assert.throws(() => refineTopology({ positions: new Float32Array([0,0,0, 1,0,0, 0,1,0, 0,-1,0, 0,0,1]), indices: new Uint32Array([0,1,2, 1,0,3, 0,1,4]) }, 1), /non-manifold/);
  assert.throws(() => refineTopology(TRI, 2, { maxOutputTriangles: 10 }), /limit/);
  assert.equal(refineTopology({ positions: new Float32Array([...TRI.positions, 9,9,9]), indices: TRI.indices }, 1).indices.length, 12, 'unused split-mesh vertices do not enter topology');
});

test('default output cap rejects a dense request before allocating topology', () => {
  const indices = new Uint32Array(300_000);
  for (let i = 0; i < indices.length; i += 3) indices.set([0, 1, 2], i);
  assert.throws(() => refineTopology({ positions: TRI.positions, indices }, 1), /size limit/);
});

test('material parts share one topological refinement but stay separate outputs', () => {
  const positions = new Float32Array([0,0,0, 2,0,0, 0,2,0, 2,2,2]);
  const parts = [
    { positions, indices: new Uint32Array([0,1,2]), uvs: new Float32Array([0,0, 1,0, 0,1, 1,1]) },
    { positions, indices: new Uint32Array([1,3,2]), uvs: new Float32Array([0,0, 1,0, 0,1, 1,1]) },
  ];
  const [a, b] = refineTopologyParts(parts, 1);
  assert.equal(a.indices.length, 12);
  assert.equal(b.indices.length, 12);
  const edgePoints = part => {
    const found = [];
    for (let i = 0; i < part.positions.length; i += 3) if (Math.abs(part.positions[i] - 1) < 1e-5 && Math.abs(part.positions[i+1] - 1) < 1e-5) found.push(part.positions[i+2]);
    return found;
  };
  assert.deepEqual(edgePoints(a), edgePoints(b));
  assert.ok(edgePoints(a)[0] > 0, 'shared edge used both opposite vertices');
});
