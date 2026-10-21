import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { applyHeapFlags, JS_FLAGS } = createRequire(import.meta.url)('../electron/HeapFlags.cjs');

function fakeApp(existing = '') {
  const switches = new Map(existing ? [['js-flags', existing]] : []);
  return { switches, commandLine: { appendSwitch: (k, v) => switches.set(k, v), getSwitchValue: (k) => switches.get(k) ?? '' } };
}

test('desktop renderer gets a 4 GiB V8 old space', () => {
  const app = fakeApp();
  applyHeapFlags(app);
  assert.equal(app.switches.get('js-flags'), '--max-old-space-size=4096');
  assert.equal(JS_FLAGS, '--max-old-space-size=4096');
});

test('existing js-flags are kept; an explicit heap size is never overridden', () => {
  const app = fakeApp('--expose-gc');
  applyHeapFlags(app);
  assert.equal(app.switches.get('js-flags'), '--expose-gc --max-old-space-size=4096');
  const own = fakeApp('--max-old-space-size=2048');
  applyHeapFlags(own);
  assert.equal(own.switches.get('js-flags'), '--max-old-space-size=2048');
  assert.equal(applyHeapFlags({}), null);
});
