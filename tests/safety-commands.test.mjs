// Bundle-3 command safety (review M12 + M14).
// M12: source-unit changes bake vertex data — must be a HistoryManager
// command (undoable), not a raw panel mutation.
// M14: shader delete/duplicate must reuse their original ids on undo/redo so
// older undo-stack entries (assigns) don't go stale.
//   node --import ./tests/register-hooks.mjs tests/safety-commands.test.mjs

import assert from 'node:assert/strict';
import { installEnv } from './env.mjs';

installEnv();
console.error = () => {};
const { SourceUnitCommand, RescaleObjectCommand, ShaderDeleteCommand, ShaderDuplicateCommand } =
  await import('../src/core/HistoryManager.js');
const { ShaderLibrary } = await import('../src/core/ShaderLibrary.js');
const { AssetLoader } = await import('../src/core/AssetLoader.js');
const { SceneManager } = await import('../src/core/SceneManager.js');
const { Selection } = await import('../src/core/Selection.js');
const { EVENTS } = await import('../src/core/events.js');
const { setState, getState, subscribe } = await import('../src/core/StateManager.js');

// Pivot/selection stubs — _withDetachedPivot runs inside the command.
SceneManager.attachToSelection = () => {};
SceneManager.setActive = () => {};
SceneManager.setSelected = () => {};
Selection.refresh = () => {};

const meshes = new Map();
AssetLoader.getBabylonMesh = (id) => meshes.get(id) ?? null;

let passed = 0, failed = 0;
const out = [];
async function test(name, fn) {
  try { await fn(); out.push(`PASS  ${name}`); passed++; }
  catch (e) { out.push(`FAIL  ${name}\n      ${e.stack || e.message}`); failed++; }
}

// ── M12: SourceUnitCommand ───────────────────────────────────────────────

await test('M12: source-unit change is undoable — parented position + entry round-trip', () => {
  const pos = { x: 1, y: 2, z: 3, scaleInPlace(f) { this.x *= f; this.y *= f; this.z *= f; return this; } };
  const m = {
    name: 'p1', metadata: { meshId: 'p1' }, parent: { name: 'root' },
    position: pos, geometry: true,
    bakeTransformIntoVertices() { this.__bakes = (this.__bakes ?? 0) + 1; },
    refreshBoundingInfo() {},
  };
  meshes.set('p1', m);
  setState(s => ({
    ...s,
    scene: {
      ...s.scene,
      objects: { p1: { id: 'p1', name: 'p1', assetId: 'a9', isGhost: false, isPrintPart: true } },
      assetLibrary: { a9: { id: 'a9', name: 'A9', filename: 'a9.glb', extension: '.glb',
        kind: 'mesh', sourceUnit: 'millimeters', unitConfirmed: true, modelRatio: 1 } },
    },
  }), { silent: true });

  const cmd = new SourceUnitCommand('a9', 'millimeters', 'meters');
  cmd.execute();
  let a = getState().scene.assetLibrary.a9;
  assert.equal(a.sourceUnit, 'meters');
  assert.equal(a.unitConfirmed, false, 'changed unit needs re-confirmation');
  assert.ok(Math.abs(pos.x - 1000) < 1e-9, `mm→m delta ×1000 scales parented position, got ${pos.x}`);
  assert.ok(m.__bakes >= 1, 'vertex bake ran');

  cmd.undo();
  a = getState().scene.assetLibrary.a9;
  assert.equal(a.sourceUnit, 'millimeters');
  assert.equal(a.unitConfirmed, true, 'undo restores the prior confirmation state');
  assert.ok(Math.abs(pos.x - 1) < 1e-9, `undo scales back, got ${pos.x}`);
});

await test('ratio command updates state before OBJECT_UPDATED listeners run', () => {
  const pos = { x: 2, y: 0, z: 0, scaleInPlace(f) { this.x *= f; this.y *= f; this.z *= f; return this; } };
  const m = {
    name: 'r1', metadata: { meshId: 'r1' }, parent: null,
    position: pos, geometry: true,
    bakeTransformIntoVertices() { this.__bakes = (this.__bakes ?? 0) + 1; },
    refreshBoundingInfo() {},
  };
  meshes.set('r1', m);
  setState(s => ({
    ...s,
    scene: {
      ...s.scene,
      objects: { r1: { id: 'r1', name: 'r1', assetId: 'a9', ratio: 2, isGhost: false, isPrintPart: true } },
    },
  }), { silent: true });

  const seen = [];
  const off = subscribe(EVENTS.OBJECT_UPDATED, ({ meshId }) => {
    if (meshId === 'r1') seen.push(getState().scene.objects.r1.ratio);
  });
  try {
    const cmd = new RescaleObjectCommand(['r1'], 4);
    cmd.execute();
    cmd.undo();
  } finally {
    off();
  }

  assert.deepEqual(seen, [4, 2]);
});

// ── M14: shader id stability across undo/redo ────────────────────────────

await test('M14: ShaderDeleteCommand undo recreates the shader under its ORIGINAL id', () => {
  const id = ShaderLibrary.createShader({ name: 'KeepId', type: 'standard' });
  const cmd = new ShaderDeleteCommand(id);
  cmd.execute();
  assert.equal(getState().scene.shaders[id], undefined, 'deleted');
  cmd.undo();
  assert.ok(getState().scene.shaders[id],
    'undo must restore the SAME id — stack entries referencing it go stale otherwise');
});

await test('M14: ShaderDuplicateCommand redo reuses the id minted on first execute', () => {
  const src = ShaderLibrary.createShader({ name: 'DupSrc', type: 'standard' });
  const cmd = new ShaderDuplicateCommand(src);
  cmd.execute();
  const firstId = cmd.getNewId();
  assert.ok(firstId, 'duplicate minted an id');
  cmd.undo();
  assert.equal(getState().scene.shaders[firstId], undefined, 'undo removed it');
  cmd.execute();                                  // redo path
  assert.equal(cmd.getNewId(), firstId, 'redo reuses the original id');
  assert.ok(getState().scene.shaders[firstId], 'shader lives under the original id');
});

console.log('\n' + out.join('\n'));
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
