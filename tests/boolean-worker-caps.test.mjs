import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installEnv } from './env.mjs';
installEnv();
const { detectCapabilities } = await import('../src/core/storage/capabilities.js');
const { booleanTriangleCap, DEFAULT_BOOLEAN_TRIANGLE_CAP, isBooleanInfraFailure } = await import('../src/core/BooleanService.js');

test('capabilities carry a Boolean triangle cap: 250k web, 1M desktop', () => {
  assert.equal(detectCapabilities({ hasFSA: true, hasIDB: true }).booleanTriangleCap, 250_000);
  assert.equal(detectCapabilities({ desktop: true, desktopCaps: { writeFiles: true } }).booleanTriangleCap, 1_000_000);
  assert.equal(detectCapabilities({ hasOPFS: true, hasIDB: true }).booleanTriangleCap, 250_000);
});

test('the worker path uses the capability cap; inline keeps the 50k main-thread cap', () => {
  assert.equal(booleanTriangleCap({ workerAvailable: true, caps: { booleanTriangleCap: 1_000_000 } }), 1_000_000);
  assert.equal(booleanTriangleCap({ workerAvailable: false, caps: { booleanTriangleCap: 1_000_000 } }), DEFAULT_BOOLEAN_TRIANGLE_CAP);
  assert.equal(booleanTriangleCap({ workerAvailable: true, caps: {} }), DEFAULT_BOOLEAN_TRIANGLE_CAP);
});

test('only worker infrastructure failures may fall back to the inline path', () => {
  const coded = (message, code) => Object.assign(new Error(message), { code });
  for (const e of [coded('x', 'unavailable'), coded('x', 'restarted'), coded('Uncaught RuntimeError: Aborted()', 'crashed'),
    new Error('manifold-unavailable: Failed to fetch dynamically imported module')]) {
    assert.equal(isBooleanInfraFailure(e), true, e.message);
  }
  for (const e of [new Error('Boolean: operand is not a closed solid (manifold) — x'), coded('slow', 'timeout'),
    new DOMException('aborted', 'AbortError'), null]) {
    assert.equal(isBooleanInfraFailure(e), false, String(e?.message));
  }
});
