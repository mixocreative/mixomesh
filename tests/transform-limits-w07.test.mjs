// cia W-07: a typed Scale or Size that would give a zero-size, mirrored or
// kilometre-long print part is refused with a reason the panel can show.
//   node --import ./tests/register-hooks.mjs --test tests/transform-limits-w07.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installEnv } from './env.mjs';

installEnv();
const { sizeEntryProblem, MAX_SIDE_MM } = await import('../src/core/commands/TransformCommands.js');

test('zero and negative entries are refused with a reason', () => {
  assert.ok(sizeEntryProblem(0, 0));
  assert.ok(sizeEntryProblem(-1, 30));
});

test('an entry that makes the longest side exceed the ceiling is refused', () => {
  assert.ok(sizeEntryProblem(1e9, 30 * 1e9));
  assert.ok(sizeEntryProblem(5000, MAX_SIDE_MM + 1));
});

test('non-numbers are refused, ordinary values pass', () => {
  assert.ok(sizeEntryProblem(NaN, 0));
  assert.equal(sizeEntryProblem(2, 60), null);
  assert.equal(sizeEntryProblem(0.001, 0.03), null);
  assert.equal(sizeEntryProblem(1000, MAX_SIDE_MM), null);
});

test('each refusal names a distinct reason', () => {
  const reasons = new Set([sizeEntryProblem(NaN, 0), sizeEntryProblem(0, 0), sizeEntryProblem(2, MAX_SIDE_MM * 2)]);
  assert.equal(reasons.size, 3);
});
