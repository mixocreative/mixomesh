import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { createApiThrottleGuard } = createRequire(import.meta.url)('../electron/ApiThrottle.cjs');
const fakeWc = () => ({ calls: [], destroyed: false, isDestroyed() { return this.destroyed; }, setBackgroundThrottling(on) { this.calls.push(on); } });

test('throttling is off while any automation request is pending, back on after the last', () => {
  const g = createApiThrottleGuard();
  const wc = fakeWc();
  g.begin(wc); g.begin(wc);
  assert.deepEqual(wc.calls, [false]);
  g.end(wc);
  assert.deepEqual(wc.calls, [false], 'still one pending');
  g.end(wc);
  assert.deepEqual(wc.calls, [false, true]);
  assert.equal(g.pendingFor(wc), 0);
});

test('job mode keeps throttling off; destroyed windows are left alone', () => {
  const g = createApiThrottleGuard({ keepOff: true });
  const wc = fakeWc();
  g.begin(wc); g.end(wc);
  assert.deepEqual(wc.calls, [false]);
  const gone = fakeWc(); gone.destroyed = true;
  const g2 = createApiThrottleGuard();
  g2.begin(gone); g2.end(gone);
  assert.deepEqual(gone.calls, []);
});

test('main.cjs wires the guard around every API dispatch', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../electron/main.cjs', import.meta.url), 'utf8');
  assert.match(src, /_apiThrottle\.begin\(wc\)/);
  assert.match(src, /job\.then\(\(\) => _apiThrottle\.end\(wc\), \(\) => _apiThrottle\.end\(wc\)\)/);
});
