import assert from 'node:assert/strict';
import { computeAlignDeltas } from '../src/core/placement/AlignMath.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`# PASS  ${name}`); passed++; }
  catch (err) { console.log(`# FAIL  ${name}\n      ${err.stack || err.message}`); failed++; }
}

// Three objects along an axis: A [0,2], B [5,7], C [10,14].
const items = [
  { id: 'A', min: 0, max: 2 },
  { id: 'B', min: 5, max: 7 },
  { id: 'C', min: 10, max: 14 },
];

test('align min → every low edge moves to the selection minimum (0)', () => {
  const d = computeAlignDeltas(items, 'min');
  assert.equal(d.A, 0);        // A already at min
  assert.equal(d.B, -5);       // 0 - 5
  assert.equal(d.C, -10);      // 0 - 10
});

test('align max → every high edge moves to the selection maximum (14)', () => {
  const d = computeAlignDeltas(items, 'max');
  assert.equal(d.A, 12);       // 14 - 2
  assert.equal(d.B, 7);        // 14 - 7
  assert.equal(d.C, 0);        // C already at max
});

test('align center → every centre moves to the selection centre (7)', () => {
  // selection lo=0 hi=14 → centre 7. centres: A=1, B=6, C=12.
  const d = computeAlignDeltas(items, 'center');
  assert.equal(d.A, 6);        // 7 - 1
  assert.equal(d.B, 1);        // 7 - 6
  assert.equal(d.C, -5);       // 7 - 12
});

test('single object → zero delta (already aligned to itself)', () => {
  assert.deepEqual(computeAlignDeltas([{ id: 'A', min: 3, max: 5 }], 'center'), { A: 0 });
  assert.deepEqual(computeAlignDeltas([{ id: 'A', min: 3, max: 5 }], 'min'), { A: 0 });
});

test('empty / malformed input → empty result', () => {
  assert.deepEqual(computeAlignDeltas([], 'min'), {});
  assert.deepEqual(computeAlignDeltas(null, 'min'), {});
  assert.deepEqual(computeAlignDeltas([{ id: 'X', min: NaN, max: 1 }], 'min'), {});
});

test('unknown mode falls back to center behaviour', () => {
  const d = computeAlignDeltas(items, 'whatever');
  assert.equal(d.A, 6);  // same as center
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
