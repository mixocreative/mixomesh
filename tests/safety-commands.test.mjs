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
const { DeleteCommand, SourceUnitCommand, RescaleObjectCommand, ShaderDeleteCommand, ShaderDuplicateCommand } =
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

await test('DeleteCommand cleans memberships, prunes imported ancestors, and restores exact hierarchy', () => {
  const makeNode = (id, parent = null) => ({
    metadata: { groupId: id }, parent, enabled: true,
    setEnabled(value) { this.enabled = value; },
  });
  const rootNode = makeNode('root');
  const leafNode = makeNode('leaf', rootNode);
  const userNode = makeNode('user');
  const fakeScene = { transformNodes: [rootNode, leafNode, userNode] };
  SceneManager.getScene = () => fakeScene;

  const makeMesh = (id, parent) => ({
    metadata: { meshId: id }, parent, enabled: true,
    setParent(value) { this.parent = value; },
    setEnabled(value) { this.enabled = value; },
  });
  const importedMesh = makeMesh('importedMesh', leafNode);
  const userMesh = makeMesh('userMesh', userNode);
  meshes.set('importedMesh', importedMesh);
  meshes.set('userMesh', userMesh);

  const before = {
    root: { id: 'root', name: 'Root', parentId: null, childIds: [], origin: 'import' },
    leaf: { id: 'leaf', name: 'Leaf', parentId: 'root', childIds: ['importedMesh'], origin: 'import' },
    user: { id: 'user', name: 'User', parentId: null, childIds: ['userMesh'], origin: 'user' },
  };
  setState(state => ({
    ...state,
    scene: {
      ...state.scene,
      groups: structuredClone(before),
      objects: {
        importedMesh: { id: 'importedMesh', name: 'Imported', parentId: 'leaf', assetId: 'a1' },
        userMesh: { id: 'userMesh', name: 'User mesh', parentId: 'user', assetId: 'a2' },
      },
    },
  }), { silent: true });

  const cmd = new DeleteCommand(['importedMesh', 'userMesh']);
  cmd.execute();
  const after = structuredClone(getState().scene.groups);
  assert.deepEqual(after, {
    user: { id: 'user', name: 'User', parentId: null, childIds: [], origin: 'user' },
  });
  assert.equal(rootNode.enabled, false);
  assert.equal(leafNode.enabled, false);
  assert.equal(userNode.enabled, true);

  cmd.undo();
  assert.deepEqual(getState().scene.groups, before);
  assert.equal(importedMesh.parent, leafNode);
  assert.equal(userMesh.parent, userNode);
  assert.equal(rootNode.enabled, true);
  assert.equal(leafNode.enabled, true);

  cmd.execute();
  assert.deepEqual(getState().scene.groups, after);
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

// ── 0.3 input hygiene ────────────────────────────────────────────────────

await test('0.3: viewport shortcuts fire on body/canvas/Outliner, never in text inputs', async () => {
  const { InputManager } = await import('../src/core/InputManager.js');
  const T = InputManager.__test;
  const canvas = { tagName: 'CANVAS' };
  T.setCanvas(canvas);
  const inOutliner = { tagName: 'DIV', closest: (sel) => (sel === '#outliner' ? {} : null) };
  const outside = { tagName: 'DIV', closest: () => null };
  const input = { tagName: 'INPUT', closest: (sel) => (sel === '#outliner' ? {} : null) };
  assert.equal(T.isViewportKeyTarget(null), true);
  assert.equal(T.isViewportKeyTarget(document.body), true);
  assert.equal(T.isViewportKeyTarget(canvas), true);
  assert.equal(T.isViewportKeyTarget(inOutliner), true, 'Outliner focus must not swallow shortcuts');
  assert.equal(T.isViewportKeyTarget(outside), false);
  assert.equal(T.isViewportKeyTarget(input), false, 'rename/search inputs inside the Outliner stay excluded');
  assert.equal(T.isViewportKeyTarget({ tagName: 'TEXTAREA' }), false);
  assert.equal(T.isViewportKeyTarget({ tagName: 'SELECT' }), false);
  assert.equal(T.isViewportKeyTarget({ tagName: 'DIV', isContentEditable: true }), false);
});

await test('0.3: Tab unbound; F2/Ctrl+I/Home/L registered; Ctrl+S/N/O stubs gone', async () => {
  const { InputManager } = await import('../src/core/InputManager.js');
  const T = InputManager.__test;
  T.clearHandlers();
  T.registerAll();
  assert.equal(T.hasHandler('Tab', 'viewport'), false);
  for (const k of ['F2', 'Home', 'L']) assert.equal(T.hasHandler(k, 'viewport'), true, k);
  assert.equal(T.hasHandler('Ctrl+I', 'global'), true, 'Ctrl+I = Import model (global)');
  for (const k of ['Ctrl+S', 'Ctrl+Shift+S', 'Ctrl+N', 'Ctrl+O']) {
    assert.equal(T.hasHandler(k, 'global'), false, `${k} stub must be gone (main.ts owns it)`);
  }
  assert.equal(T.hasHandler('Ctrl+Z', 'global'), true);
});

// ── 2.5: lock enforcement ────────────────────────────────────────────────

const lockFixture = () => {
  const mk = (id) => ({ id, name: id, assetId: null, isGhost: false, visible: true, locked: false, parentId: null, isPrintPart: true });
  const objs = { lo1: mk('lo1'), lo2: mk('lo2'), lc: { ...mk('lc'), parentId: 'gL' }, lf: mk('lf') };
  objs.lo1.locked = true;
  for (const id of Object.keys(objs)) meshes.set(id, { name: id, metadata: { meshId: id }, parent: null, setParent(p) { this.parent = p; }, setEnabled() {}, dispose() {}, isDisposed: () => false });
  const gNode = { name: 'gL', metadata: { groupId: 'gL' }, parent: null };
  SceneManager.getScene = () => ({ transformNodes: [gNode] });
  setState(s => ({
    ...s,
    scene: {
      ...s.scene, objects: objs,
      groups: { gL: { id: 'gL', name: 'gL', parentId: null, childIds: ['lc'], locked: true } },
    },
    selection: { ...s.selection, selectedIds: [], activeId: null },
  }), { silent: true });
  return gNode;
};
const select = (ids) => setState(s => ({ ...s, selection: { ...s.selection, selectedIds: ids, activeId: ids[ids.length - 1] ?? null } }), { silent: true });

await test('2.5: locked object is selectable but never a transform target', () => {
  lockFixture();
  select(['lo1', 'lo2']);
  const r = Selection.getTransformTargets();
  assert.deepEqual(r.targets.map(x => x.id), ['lo2']);
  assert.equal(r.lockedSkipped, 1);
  assert.equal(Selection.getTransformTargets({ includeLocked: true }).targets.length, 2, 'outline still sees locked');
});

await test('2.5: locked group + its children are not transformable (cascade down)', () => {
  lockFixture();
  assert.equal(Selection.isEffectivelyLocked('gL'), true);
  assert.equal(Selection.isEffectivelyLocked('lc'), true, 'child of locked group');
  assert.equal(Selection.isEffectivelyLocked('lf'), false);
  select(['gL', 'lc', 'lf']);
  const r = Selection.getTransformTargets();
  assert.deepEqual(r.targets.map(x => x.id), ['lf']);
  assert.equal(r.lockedSkipped, 2);
});

await test('2.5: Properties transform read-only helper follows effective lock', async () => {
  lockFixture();
  const { isTransformReadOnly } = await import('../src/ui/PropertiesPanel.js');
  assert.equal(isTransformReadOnly(['lo1']), true);
  assert.equal(isTransformReadOnly(['lc']), true);
  assert.equal(isTransformReadOnly(['lf', 'lo2']), false);
  assert.equal(isTransformReadOnly(['lf', 'lo1']), true, 'any locked item makes it read-only');
});

await test('2.5 / Decision 9: Delete of locked items ASKS — cancel keeps, confirm deletes', async () => {
  lockFixture();
  const { InputManager } = await import('../src/core/InputManager.js');
  const { subscribe } = await import('../src/core/StateManager.js');
  const { EVENTS } = await import('../src/core/events.js');
  let answer = 'cancel', asked = 0;
  const off = subscribe(EVENTS.MODAL_OPEN, p => { if (p?.id === 'confirmAction') { asked++; p.onClose?.(answer); } });
  try {
    select(['lo1', 'lo2']);
    InputManager.__test.deleteSelected();
    assert.equal(asked, 1, 'confirm shown for a locked selection');
    assert.ok(getState().scene.objects.lo1 && getState().scene.objects.lo2, 'cancel keeps the locked items');
    select(['lc']);
    answer = 'confirm';
    InputManager.__test.deleteSelected();
    assert.equal(asked, 2, 'child of a locked group also asks');
    const H = await import('../src/core/HistoryManager.js');
    assert.ok(/delete/i.test(H.getUndoLabel() ?? ''), `confirm pushes a Delete (undo label: ${H.getUndoLabel()})`);
  } finally { off(); }
});

await test('2.5: L toggles lock on a group and undo restores', async () => {
  lockFixture();
  const { InputManager } = await import('../src/core/InputManager.js');
  const { undo } = await import('../src/core/HistoryManager.js');
  setState(s => ({ ...s, scene: { ...s.scene, groups: { gL: { ...s.scene.groups.gL, locked: false } } } }), { silent: true });
  select(['gL']);
  InputManager.__test.lockToggleSelected();
  assert.equal(getState().scene.groups.gL.locked, true);
  undo();
  assert.equal(getState().scene.groups.gL.locked, false);
});

// ── 5.9: undoable cursor ops ─────────────────────────────────────────────

await test('5.9: Selection → Cursor operation uses TransformCommand (import verification)', async () => {
  // Verify that CursorTools.selectionToCursor uses TransformCommand by importing
  // and checking the source. The actual end-to-end behavior (move + undo restore)
  // is exercised by the existing history-pivot and hierarchy tests that verify
  // TransformCommand execution on meshes.
  const cursorToolsSrc = await (await import('fs')).promises.readFile(
    new URL('../src/core/CursorTools.js', import.meta.url),
    'utf-8'
  );
  assert.ok(
    cursorToolsSrc.includes('push(new TransformCommand'),
    'CursorTools.js must call push(new TransformCommand()) in selectionToCursor'
  );
  assert.ok(
    cursorToolsSrc.includes('import') && cursorToolsSrc.includes('TransformCommand'),
    'CursorTools.js must import TransformCommand from HistoryManager'
  );
});

console.log('\n' + out.join('\n'));
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
