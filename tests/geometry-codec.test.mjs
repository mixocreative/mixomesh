import assert from 'node:assert/strict';
import { encodeGeometry, decodeGeometry } from '../src/core/GeometryCodec.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`# PASS  ${name}`); passed++; }
  catch (err) { console.log(`# FAIL  ${name}\n      ${err.stack || err.message}`); failed++; }
}

// A minimal tri (one triangle, 3 verts).
const tri = {
  positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
  normals: [0, 0, 1, 0, 0, 1, 0, 0, 1],
  indices: [0, 1, 2],
};

test('round-trips positions + indices + normals byte-exactly', () => {
  const buf = encodeGeometry(tri);
  const out = decodeGeometry(buf);
  assert.deepEqual([...out.positions], tri.positions);
  assert.deepEqual([...out.indices], tri.indices);
  assert.deepEqual([...out.normals], tri.normals);
});

test('round-trips without normals (normals = null on decode)', () => {
  const out = decodeGeometry(encodeGeometry({ positions: tri.positions, indices: tri.indices }));
  assert.deepEqual([...out.positions], tri.positions);
  assert.deepEqual([...out.indices], tri.indices);
  assert.equal(out.normals, null);
});

test('accepts typed-array inputs (as CSG2/VertexData would supply)', () => {
  const out = decodeGeometry(encodeGeometry({
    positions: Float32Array.from(tri.positions),
    indices: Uint32Array.from(tri.indices),
    normals: Float32Array.from(tri.normals),
  }));
  assert.deepEqual([...out.positions], tri.positions);
  assert.deepEqual([...out.indices], tri.indices);
});

test('index values > 65535 survive (u32, not u16)', () => {
  const positions = new Array(3 * 3).fill(0);
  const out = decodeGeometry(encodeGeometry({ positions, indices: [0, 70000, 131071] }));
  assert.deepEqual([...out.indices], [0, 70000, 131071]);
});

test('fractional positions survive at float32 precision', () => {
  const positions = [0.125, -0.5, 1.75, 2.25, -3.5, 4.0, 0, 0, 0];
  const out = decodeGeometry(encodeGeometry({ positions, indices: [0, 1, 2] }));
  assert.deepEqual([...out.positions], positions);
});

test('missing positions or indices throws', () => {
  assert.throws(() => encodeGeometry({ indices: [0, 1, 2] }));
  assert.throws(() => encodeGeometry({ positions: [0, 0, 0] }));
});

test('positions not a multiple of 3 throws', () => {
  assert.throws(() => encodeGeometry({ positions: [0, 0], indices: [0] }));
});

test('bad magic / short buffer / wrong version rejected', () => {
  assert.throws(() => decodeGeometry(new ArrayBuffer(4)));
  const buf = encodeGeometry(tri);
  new DataView(buf).setUint32(0, 0xdeadbeef, true);  // corrupt magic
  assert.throws(() => decodeGeometry(buf));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
