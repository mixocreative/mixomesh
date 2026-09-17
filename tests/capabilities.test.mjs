import assert from 'node:assert/strict';
import {
  detectCapabilities, WEB_TRIANGLE_BUDGET, DESKTOP_TRIANGLE_BUDGET,
} from '../src/core/storage/capabilities.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`# PASS  ${name}`); passed++; }
  catch (err) { console.log(`# FAIL  ${name}\n      ${err.stack || err.message}`); failed++; }
}

test('web with FSA + IDB → all filesystem caps true, watch false', () => {
  const c = detectCapabilities({ hasFSA: true, hasIDB: true });
  assert.equal(c.mountDirectory, true);
  assert.equal(c.relinkByPath, true);
  assert.equal(c.writeFiles, true);
  assert.equal(c.persistAssets, true);
  assert.equal(c.watchFiles, false, 'watch is desktop-only');
  assert.equal(c.triangleBudget, WEB_TRIANGLE_BUDGET, 'web tier gets the smaller triangle budget');
});

test('web without FSA → pickers/mount/relink/write false; persist follows IDB', () => {
  const c = detectCapabilities({ hasFSA: false, hasIDB: true });
  assert.equal(c.mountDirectory, false);
  assert.equal(c.relinkByPath, false);
  assert.equal(c.writeFiles, false);
  assert.equal(c.persistAssets, true, 'IDB still gives cross-session persistence');
  assert.equal(c.watchFiles, false);
});

test('web without IDB → persistAssets false', () => {
  const c = detectCapabilities({ hasFSA: true, hasIDB: false });
  assert.equal(c.persistAssets, false);
});

test('desktop → trusts injected shell capabilities verbatim (all true incl. watch)', () => {
  const c = detectCapabilities({
    desktop: true,
    desktopCaps: { persistAssets: true, mountDirectory: true, relinkByPath: true, watchFiles: true, writeFiles: true },
  });
  assert.deepEqual(c, {
    persistAssets: true, mountDirectory: true, relinkByPath: true, watchFiles: true, writeFiles: true,
    triangleBudget: DESKTOP_TRIANGLE_BUDGET,
  });
});

test('desktop flag without desktopCaps falls back to feature detection', () => {
  const c = detectCapabilities({ desktop: true, hasFSA: false, hasIDB: false });
  assert.equal(c.writeFiles, false);
  assert.equal(c.persistAssets, false);
  assert.equal(c.triangleBudget, DESKTOP_TRIANGLE_BUDGET,
    'triangle budget is a runtime tier, not a shell-reported capability — desktop keeps its budget');
});

test('watertight-repair-and-cost task 7: desktop triangle budget is 4x the web budget', () => {
  assert.equal(DESKTOP_TRIANGLE_BUDGET, WEB_TRIANGLE_BUDGET * 4);
  assert.equal(WEB_TRIANGLE_BUDGET, 1_500_000);
  assert.equal(DESKTOP_TRIANGLE_BUDGET, 6_000_000);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
