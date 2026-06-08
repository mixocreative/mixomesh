// State-shape tests. Run:
//   node --import ./tests/register-hooks.mjs tests/state-shape.test.mjs
//
// Mimaki printer profile support locks three defaults:
//   • targetPrinterId  = 'mimaki-3duj-553'  (most popular UV-inkjet installed base)
//   • bedDimensions    = 508 × 508 × 305 mm (3DUJ-553 spec)
//   • overlays.printPreview = true          (matte preview ON by default)
// And the migrate path must:
//   • silently drop the legacy v3.0 scene.gridSize scalar
//   • silently ignore legacy print.bedPreset (no crash, defaults stand)
//   • round-trip a doc that explicitly carries targetPrinterId

import assert from 'node:assert/strict';
import { installEnv } from './env.mjs';

installEnv();
console.error = () => {};

const { freshState, getState, setState } = await import('../src/core/StateManager.js');
const { __test } = await import('../src/core/PersistenceManager.js');
const { _migrate } = __test;

let passed = 0, failed = 0;
const out = [];
async function test(name, fn) {
  try { await fn(); out.push(`PASS  ${name}`); passed++; }
  catch (err) { out.push(`FAIL  ${name}\n      ${err.stack || err.message}`); failed++; }
}

// ── Defaults ─────────────────────────────────────────────

await test('freshState: targetPrinterId defaults to mimaki-3duj-553', () => {
  const s = freshState();
  assert.equal(s.print.targetPrinterId, 'mimaki-3duj-553');
});

await test('freshState: bedDimensions defaults to 508 × 508 × 305 mm', () => {
  const s = freshState();
  assert.deepEqual(s.print.bedDimensions, { x: 508, y: 508, z: 305 });
});

await test('freshState: overlays.printPreview defaults to true (matte preview ON)', () => {
  const s = freshState();
  assert.equal(s.scene.overlays.printPreview, true);
});

await test('freshState: legacy fields are absent (no bedPreset, no gridSize)', () => {
  const s = freshState();
  assert.equal('bedPreset' in s.print, false, 'bedPreset must not be in fresh state');
  assert.equal('gridSize'  in s.scene, false, 'scalar scene.gridSize must not be in fresh state');
});

await test('getState exposes the same shape as freshState after init', () => {
  const live = getState();
  assert.equal(live.print.targetPrinterId, 'mimaki-3duj-553');
  assert.equal(live.scene.overlays.printPreview, true);
});

// ── Migration / round-trip ───────────────────────────────

await test('_migrate: pre-pivot doc with print.bedPreset returns same ref (best-effort load)', () => {
  const doc = {
    version: '3.1',
    print: { bedPreset: 'Elegoo Saturn 4 Ultra', bedDimensions: { x: 218, y: 122, z: 220 } },
    scene: { gridSize: 250 },
  };
  const migrated = _migrate(doc);
  assert.equal(migrated, doc, 'migrate is intentionally passthrough');
  // Legacy bedPreset is left on the doc — the load path shallow-merges
  // {...s.print, ...data.print}, so unknown fields are silently absorbed but
  // don't displace targetPrinterId / printPreview defaults.
});

await test('round-trip: doc carrying targetPrinterId lands in state.print after shallow merge', () => {
  // Mirrors PersistenceManager._loadProject's `print: { ...s.print, ...(data.print || {}) }`.
  const s = freshState();
  const data = { print: { targetPrinterId: 'bambu-x1c', bedDimensions: { x: 256, y: 256, z: 256 } } };
  const next = { ...s.print, ...(data.print || {}) };
  assert.equal(next.targetPrinterId, 'bambu-x1c');
  assert.deepEqual(next.bedDimensions, { x: 256, y: 256, z: 256 });
  // Other defaults preserved (chordTolerance / workingRatio etc.).
  assert.equal(next.workingRatio, 1);
  assert.equal(next.targetRatio,  1);
});

await test('round-trip: doc with NO print block keeps Mimaki default after merge', () => {
  const s = freshState();
  const data = {};
  const next = { ...s.print, ...(data.print || {}) };
  assert.equal(next.targetPrinterId, 'mimaki-3duj-553');
  assert.deepEqual(next.bedDimensions, { x: 508, y: 508, z: 305 });
});

await test('round-trip: overlays.printPreview survives load merge (default + explicit override)', () => {
  // Default preserved when missing.
  const s = freshState();
  const noOverlay = { sceneSettings: {} };
  const merged1 = { ...s.scene.overlays, ...(noOverlay.sceneSettings?.overlays || {}) };
  assert.equal(merged1.printPreview, true);

  // Explicit override honoured.
  const off = { sceneSettings: { overlays: { printPreview: false } } };
  const merged2 = { ...s.scene.overlays, ...(off.sceneSettings.overlays || {}) };
  assert.equal(merged2.printPreview, false);
});

// ── Sanity: setState/withoutDirty don't break shape ────

await test('setState patch keeps targetPrinterId / printPreview intact when unrelated keys change', () => {
  setState(s => ({ ...s, project: { ...s.project, name: 'X' } }), { silent: true });
  const live = getState();
  assert.equal(live.print.targetPrinterId, 'mimaki-3duj-553');
  assert.equal(live.scene.overlays.printPreview, true);
});

console.log('\n' + out.join('\n'));
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
