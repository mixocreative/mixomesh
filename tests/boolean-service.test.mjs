import assert from 'node:assert/strict';
import { evaluateBooleanEligibility, DEFAULT_BOOLEAN_TRIANGLE_CAP } from '../src/core/BooleanService.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`# PASS  ${name}`); passed++; }
  catch (err) { console.log(`# FAIL  ${name}\n      ${err.stack || err.message}`); failed++; }
}

const solid = (id, triangles = 100) => ({ id, triangles, solidColor: true, partCount: 1 });

test('fewer than two operands → needs-two (hard block)', () => {
  assert.equal(evaluateBooleanEligibility([]).reason, 'needs-two');
  assert.equal(evaluateBooleanEligibility([solid('a')]).ok, false);
});

test('two solid single-part operands → ready', () => {
  const r = evaluateBooleanEligibility([solid('a'), solid('b')]);
  assert.equal(r.ok, true);
  assert.equal(r.reason, 'ready');
  assert.equal(r.totalTriangles, 200);
});

test('a multi-part logical object is refused (hard block) — SmartReplace parity', () => {
  const r = evaluateBooleanEligibility([solid('a'), { id: 'b', triangles: 100, solidColor: true, partCount: 3 }]);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'multi-part');
  assert.equal(r.offender, 'b');
});

test('over the triangle cap → too-large (hard block)', () => {
  const r = evaluateBooleanEligibility(
    [solid('a', 40_000), solid('b', 20_000)],
    { triangleCap: 50_000 },
  );
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'too-large');
  assert.equal(r.totalTriangles, 60_000);
  assert.equal(r.triangleCap, 50_000);
});

test('a desktop-style larger cap admits what the web cap rejected', () => {
  const operands = [solid('a', 40_000), solid('b', 20_000)];
  assert.equal(evaluateBooleanEligibility(operands, { triangleCap: 50_000 }).ok, false);
  assert.equal(evaluateBooleanEligibility(operands, { triangleCap: 200_000 }).reason, 'ready');
});

test('a textured operand → ok but needs-texture-bake (soft gate), lists the ids', () => {
  const r = evaluateBooleanEligibility([solid('a'), { id: 'b', triangles: 100, solidColor: false, partCount: 1 }]);
  assert.equal(r.ok, true, 'not a hard block — the caller confirms a bake');
  assert.equal(r.reason, 'needs-texture-bake');
  assert.deepEqual(r.texturedIds, ['b']);
});

test('hard blocks take precedence over the texture gate', () => {
  // multi-part AND textured → the multi-part hard block wins.
  const r = evaluateBooleanEligibility([solid('a'), { id: 'b', triangles: 100, solidColor: false, partCount: 2 }]);
  assert.equal(r.reason, 'multi-part');
});

test('default cap constant is exported and applied when no cap passed', () => {
  assert.equal(DEFAULT_BOOLEAN_TRIANGLE_CAP, 50_000);
  const r = evaluateBooleanEligibility([solid('a', 30_000), solid('b', 30_000)]);
  assert.equal(r.reason, 'too-large');
  assert.equal(r.triangleCap, 50_000);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
