// Bundle-4 hygiene regressions (review A8 + M13 + M17).
//   node --import ./tests/register-hooks.mjs tests/hygiene.test.mjs

import assert from 'node:assert/strict';
import { installEnv } from './env.mjs';
import printers from '../src/config/printers.json' with { type: 'json' };

installEnv();
console.error = () => {};
const { subscribe, setState, getState } = await import('../src/core/StateManager.js');
const { GroupCommand } = await import('../src/core/HistoryManager.js');
const { AssetLoader } = await import('../src/core/AssetLoader.js');
const { SceneManager } = await import('../src/core/SceneManager.js');
const { Selection } = await import('../src/core/Selection.js');

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

await test('A8: subscribe(undefined event) throws in dev instead of silently dying', () => {
  // EVENTS.TYPO_NAME is undefined — the PrintPanel OBJECT_ADDED bug shape.
  assert.throws(() => subscribe(undefined, () => {}), /unknown event/i);
});

await test('printer profiles contain build-volume reference data only', () => {
  for (const [id, profile] of Object.entries(printers)) {
    assert.deepEqual(Object.keys(profile).sort(), ['bed', 'displayName', 'vendor'], id);
    assert.equal(['format', 'pipeline', 'colorMode'].some(key => key in profile), false, id);
  }
});

// (M13 cursor-scaling-on-world-rescale test removed with RescaleWorldCommand in
// the per-object ratio redesign 2026-06-16 — there is no global scene rescale.)

await test('M17: undoing a nested group restores the Babylon parent, not scene root', () => {
  const fakeScene = { transformNodes: [] };
  SceneManager.getScene = () => fakeScene;

  // Outer group gOut already exists with a live TransformNode.
  const nOut = { name: 'Outer', parent: null, metadata: { groupId: 'gOut' },
                 setParent(p) { this.parent = p; }, dispose() { this._disposed = true; } };
  fakeScene.transformNodes.push(nOut);

  const m = {
    name: 'm1', metadata: { meshId: 'm1' }, parent: nOut,
    position: { x: 0, y: 0, z: 0 },
    getAbsolutePosition() { return { x: 0, y: 0, z: 0 }; },
    setParent(p) { this.parent = p; },
  };
  meshes.set('m1', m);
  setState(s => ({
    ...s,
    scene: {
      ...s.scene,
      objects: { m1: { id: 'm1', name: 'm1', assetId: 'a1', parentId: 'gOut',
        visible: true, locked: false, isGhost: false, isPrintPart: true } },
      groups: { gOut: { id: 'gOut', name: 'Outer', parentId: null, childIds: ['m1'] } },
    },
  }), { silent: true });

  const cmd = new GroupCommand(['m1'], 'Inner');
  cmd.execute();
  assert.notEqual(m.parent, nOut, 'execute parents the mesh under the new inner node');

  cmd.undo();
  assert.equal(getState().scene.objects.m1.parentId, 'gOut', 'state parent restored');
  assert.equal(m.parent, nOut,
    'Babylon parent must return to the OUTER group node, not scene root (M17)');
});

console.log('\n' + out.join('\n'));
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
