// Bundle-4 hygiene regressions (review A8 + M13 + M17).
//   node --import ./tests/register-hooks.mjs tests/hygiene.test.mjs

import assert from 'node:assert/strict';
import { installEnv } from './env.mjs';

installEnv();
console.error = () => {};
const { subscribe, setState, getState } = await import('../src/core/StateManager.js');
const { RescaleWorldCommand, GroupCommand } = await import('../src/core/HistoryManager.js');
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

await test('M13: world rescale moves the Babylon 3D cursor with the state cursor', () => {
  const setCursorCalls = [];
  SceneManager.setCursor = (v) => setCursorCalls.push({ x: v.x, y: v.y, z: v.z });
  setState(s => ({
    ...s,
    scene: { ...s.scene, objects: {}, cursor3d: { x: 0.1, y: 0.2, z: 0.3 } },
  }), { silent: true });

  const cmd = new RescaleWorldCommand(1, 2);   // factor prev/next = 0.5
  cmd.execute();
  assert.equal(setCursorCalls.length, 1, 'SceneManager.setCursor must be called');
  assert.ok(Math.abs(setCursorCalls[0].x - 0.05) < 1e-9,
    `cursor visual must scale with state, got ${setCursorCalls[0].x}`);
  cmd.undo();
  assert.equal(setCursorCalls.length, 2);
  assert.ok(Math.abs(setCursorCalls[1].x - 0.1) < 1e-9, 'undo moves it back');
});

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
