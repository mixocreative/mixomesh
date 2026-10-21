import assert from 'node:assert/strict';
import {
  detectCapabilities, detectEngine, engineGate, detectStorageTier, WEB_TRIANGLE_BUDGET, DESKTOP_TRIANGLE_BUDGET, DESKTOP_BOOLEAN_TRIANGLE_CAP,
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
    persistAssets: true, mountDirectory: true, relinkByPath: true, watchFiles: true, writeFiles: true, publish: false,
    triangleBudget: DESKTOP_TRIANGLE_BUDGET, booleanTriangleCap: DESKTOP_BOOLEAN_TRIANGLE_CAP,
  });
});

test('desktop flag without desktopCaps falls back to feature detection', () => {
  const c = detectCapabilities({ desktop: true, hasFSA: false, hasIDB: false });
  assert.equal(c.writeFiles, false);
  assert.equal(c.persistAssets, false);
  assert.equal(c.triangleBudget, DESKTOP_TRIANGLE_BUDGET,
    'triangle budget is a runtime tier, not a shell-reported capability — desktop keeps its budget');
});

test('measured triangle budgets (heavy-mesh spec §2): web 2.5M, desktop 6M, desktop above web', () => {
  assert.equal(WEB_TRIANGLE_BUDGET, 2_500_000);
  assert.equal(DESKTOP_TRIANGLE_BUDGET, 6_000_000);
  assert.ok(DESKTOP_TRIANGLE_BUDGET > WEB_TRIANGLE_BUDGET);
});

const UA = {
  chrome: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
  edge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36 Edg/149.0.0.0',
  electron: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) mixomesh/1.0 Chrome/140.0.0.0 Electron/38.0.0 Safari/537.36',
  ipad: 'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  ipadDesktop: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  iosChrome: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.6478.153 Mobile/15E148 Safari/604.1',
  macSafari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  firefox: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0',
  iosFirefox: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/128.0 Mobile/15E148 Safari/605.1.15',
};

test('detectEngine UA matrix', () => {
  assert.equal(detectEngine(UA.chrome), 'chromium');
  assert.equal(detectEngine(UA.edge), 'chromium');
  assert.equal(detectEngine(UA.electron), 'chromium');
  assert.equal(detectEngine('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/149.0.0.0 Safari/537.36'),
    'chromium', 'headless Chrome (automation / smokes) is chromium');
  assert.equal(detectEngine('anything', { desktop: true }), 'chromium');
  assert.equal(detectEngine(UA.ipad, { maxTouchPoints: 5 }), 'webkit');
  assert.equal(detectEngine(UA.ipadDesktop, { maxTouchPoints: 5 }), 'webkit', 'iPadOS 13+ Macintosh UA + touch');
  assert.equal(detectEngine(UA.iphone), 'webkit');
  assert.equal(detectEngine(UA.iosChrome), 'webkit', 'CriOS is WebKit');
  assert.equal(detectEngine(UA.macSafari, { maxTouchPoints: 0 }), 'webkit');
  assert.equal(detectEngine(UA.macSafari), 'webkit');
  assert.equal(detectEngine(UA.firefox), 'gecko');
  assert.equal(detectEngine(UA.iosFirefox), 'webkit', 'FxiOS is WebKit');
  assert.equal(detectEngine(''), 'other');
  assert.equal(detectEngine('curl/8.0'), 'other');
  assert.equal(detectEngine(undefined), 'other');
});

test('engineGate: chromium + webkit pass; gecko/other blocked naming supported browsers', () => {
  assert.equal(engineGate('chromium'), null);
  assert.equal(engineGate('webkit'), null);
  for (const e of ['gecko', 'other']) {
    const g = engineGate(e);
    assert.ok(g && g.title && /Chrome/.test(g.message) && /Edge/.test(g.message) && /Safari/.test(g.message), e);
  }
  assert.match(engineGate('gecko').message, /Firefox/);
});

test('detectStorageTier is engine-aware: gecko/other never pick opfs', () => {
  const base = { hasOPFS: true, hasIDB: true };
  assert.equal(detectStorageTier({ ...base, engine: 'webkit' }), 'opfs');
  assert.equal(detectStorageTier({ ...base, engine: 'gecko' }), 'browser');
  assert.equal(detectStorageTier({ ...base, engine: 'other' }), 'browser');
  assert.equal(detectStorageTier({ ...base, hasFSA: true, engine: 'chromium' }), 'browser');
  assert.equal(detectStorageTier({ ...base, desktop: true, engine: 'chromium' }), 'desktop');
  assert.equal(detectStorageTier(base), 'opfs', 'no engine given keeps the 8.2 behaviour');
});

test('publish cap: desktop shell with listbridge only', () => {
  const dc = { persistAssets: true, mountDirectory: true, relinkByPath: true, watchFiles: true, writeFiles: true };
  assert.equal(detectCapabilities({ desktop: true, desktopCaps: dc, hasListbridge: true }).publish, true);
  assert.equal(detectCapabilities({ desktop: true, desktopCaps: dc }).publish, false);
  assert.equal(detectCapabilities({ hasFSA: true, hasIDB: true, hasListbridge: true }).publish, false);
  assert.equal(detectCapabilities({ hasOPFS: true, hasIDB: true, hasListbridge: true }).publish, false);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
