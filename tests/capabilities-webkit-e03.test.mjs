// cia E-03: Safari / iPad / iPhone (WebKit, the OPFS storage tier) get their own
// conservative triangle budget; desktop and Chromium web keep theirs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { detectCapabilities, detectEngine } from '../src/core/storage/capabilities.js';

const iPad = 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

test('WebKit warns at 1,000,000 triangles and refuses above 3,000,000', () => {
  const c = detectCapabilities({ engine: detectEngine(iPad), hasOPFS: true, hasIDB: true });
  assert.equal(c.triangleBudget, 1_000_000);
  assert.equal(c.triangleLimit, 3_000_000);
});

test('Chromium web and desktop budgets are unchanged', () => {
  const web = detectCapabilities({ engine: 'chromium', hasFSA: true, hasIDB: true });
  assert.equal(web.triangleBudget, 2_500_000);
  assert.equal(web.triangleLimit, 10_000_000);
  const desktop = detectCapabilities({ desktop: true, engine: 'chromium' });
  assert.equal(desktop.triangleBudget, 6_000_000);
  assert.equal(desktop.triangleLimit, 24_000_000);
});
