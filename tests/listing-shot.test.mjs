import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeListingOptions, withSuppressed } from '../src/core/render/ListingShot.js';

test('normalizeListingOptions defaults, clamps, validates', () => {
  assert.deepEqual(normalizeListingOptions(), { size: 1600, transparent: false });
  assert.deepEqual(normalizeListingOptions({ size: 512, background: 'transparent' }), { size: 512, transparent: true });
  assert.equal(normalizeListingOptions({ size: 99999 }).size, 4096);
  assert.equal(normalizeListingOptions({ size: 1 }).size, 64);
  assert.equal(normalizeListingOptions({ size: NaN }).size, 1600);
  assert.throws(() => normalizeListingOptions({ background: 'red' }));
});

test('withSuppressed restores in reverse order on success', async () => {
  const log = [];
  const mk = n => () => { log.push('off' + n); return () => log.push('on' + n); };
  const r = await withSuppressed([mk(1), mk(2)], async () => { log.push('run'); return 7; });
  assert.equal(r, 7);
  assert.deepEqual(log, ['off1', 'off2', 'run', 'on2', 'on1']);
});

test('withSuppressed restores when fn throws', async () => {
  const log = [];
  const mk = n => () => { log.push('off' + n); return () => log.push('on' + n); };
  await assert.rejects(withSuppressed([mk(1), mk(2)], () => { throw new Error('boom'); }), /boom/);
  assert.deepEqual(log, ['off1', 'off2', 'on2', 'on1']);
});

test('withSuppressed restores already-applied layers when a later suppress throws', async () => {
  const log = [];
  const ok = () => { log.push('off1'); return () => log.push('on1'); };
  const bad = () => { throw new Error('nope'); };
  await assert.rejects(withSuppressed([ok, bad], () => log.push('run')), /nope/);
  assert.deepEqual(log, ['off1', 'on1']);
});

test('withSuppressed: a throwing restore does not skip the others', async () => {
  const log = [];
  const a = () => () => log.push('on-a');
  const b = () => () => { throw new Error('restore-b'); };
  await assert.rejects(withSuppressed([a, b], () => 1), /restore-b/);
  assert.deepEqual(log, ['on-a']);
});
