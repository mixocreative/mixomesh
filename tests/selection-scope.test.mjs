// Click-depth scope (overhaul task 3.2, plan §4.5 Figma/Keynote model):
// click = top-most item within the scope, double-click = enter a group,
// Esc = step out, empty click / outside click = back to root, marquee is
// scope-aware, material parts map to their logical lead. Run:
//   node --import ./tests/register-hooks.mjs --test tests/selection-scope.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { installEnv } from './env.mjs';

installEnv();
globalThis.document.getElementById = () => null;
globalThis.document.querySelector = () => null;

const { StateManager } = await import('../src/core/StateManager.js');
const { AssetLoader } = await import('../src/core/AssetLoader.js');
const { SceneManager } = await import('../src/core/SceneManager.js');
const { Selection } = await import('../src/core/Selection.js');
const { BoxSelect, itemIdsInRect } = await import('../src/core/BoxSelect.js');
const { selectableAtDepth } = await import('../src/core/LogicalObjects.js');
const { InputManager } = await import('../src/core/InputManager.js');
const { EVENTS } = await import('../src/core/events.js');

const T = InputManager.__test;

SceneManager.setActive = () => {};
SceneManager.setSelected = () => {};
SceneManager.attachToSelection = () => {};
SceneManager.getBodyDragPlaneY = () => 0;
AssetLoader.getBabylonMesh = (id) => ({ name: id });
SceneManager.getScene = () => ({ transformNodes: [] });

// Fake scene for InputManager: no camera → no body-drag staging.
const fakeScene = { pointerX: 0, pointerY: 0, activeCamera: null, meshes: [] };
T.setScene(fakeScene);
BoxSelect.init({ getEngine: () => ({ getRenderingCanvas: () => null }) });

let picked = null;            // meshId the fake pick returns
SceneManager.pickMeshIdAt = () => picked;
let clock = 0;
T.setNow(() => clock);

function obj(id, over = {}) {
  return {
    id, name: id, assetId: 'a1', collectionId: null, parentId: null,
    shaderId: null, visible: true, locked: false,
    isGhost: false, isUnlinked: false, isPrintPart: true, ...over,
  };
}
function group(id, childIds, over = {}) {
  return { id, name: id, parentId: null, childIds, visible: true, locked: false, ...over };
}

// outer ⊃ { inner ⊃ { a, lead(+lead.part) }, b } ; loose ungrouped
function reset() {
  StateManager.replaceState(StateManager.freshState());
  const objects = {
    a: obj('a', { parentId: 'inner' }),
    lead: obj('lead', { parentId: 'inner', logicalObjectId: 'lead' }),
    'lead.part': obj('lead.part', { parentId: 'inner', logicalObjectId: 'lead', isInternalPart: true }),
    b: obj('b', { parentId: 'outer' }),
    loose: obj('loose'),
  };
  const groups = {
    outer: group('outer', ['inner', 'b']),
    inner: group('inner', ['a', 'lead', 'lead.part'], { parentId: 'outer' }),
  };
  StateManager.setState(s => ({
    ...s,
    selection: { ...s.selection, selectedIds: [], activeId: null },
    scene: { ...s.scene, objects, groups },
  }), { silent: true });
  Selection.setScope(null);
  T.resetClick();
  picked = null;
  clock = 0;
}

function press(meshId, { x = 10, y = 10, dt = 1000, shiftKey = false, ctrlKey = false } = {}) {
  picked = meshId;
  clock += dt;
  fakeScene.pointerX = x;
  fakeScene.pointerY = y;
  T.selectionPointerDown({ event: { button: 0, shiftKey, ctrlKey, metaKey: false } });
}
function esc() {
  T.keyDown({ key: 'Escape', preventDefault() {}, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false });
}

test('selectableAtDepth: root → top-most ancestor; scope → child of scope; outside → null', () => {
  reset();
  const scene = StateManager.getState().scene;
  assert.equal(selectableAtDepth('a', scene, null), 'outer');
  assert.equal(selectableAtDepth('loose', scene, null), 'loose');
  assert.equal(selectableAtDepth('a', scene, 'outer'), 'inner');
  assert.equal(selectableAtDepth('b', scene, 'outer'), 'b');
  assert.equal(selectableAtDepth('a', scene, 'inner'), 'a');
  assert.equal(selectableAtDepth('loose', scene, 'outer'), null);
  assert.equal(selectableAtDepth('nope', scene, null), null);
});

test('part → lead mapping at every depth', () => {
  reset();
  const scene = StateManager.getState().scene;
  assert.equal(selectableAtDepth('lead.part', scene, null), 'outer');
  assert.equal(selectableAtDepth('lead.part', scene, 'outer'), 'inner');
  assert.equal(selectableAtDepth('lead.part', scene, 'inner'), 'lead');
});

test('click at root selects the top-level group; bare object selects itself', () => {
  reset();
  press('a');
  assert.deepEqual(Selection.getSelectedIds(), ['outer']);
  assert.equal(Selection.getScope(), null);
  press('loose');
  assert.deepEqual(Selection.getSelectedIds(), ['loose']);
});

test('double-click enters the group and selects the child under the cursor', () => {
  reset();
  const seen = [];
  const off = StateManager.subscribe(EVENTS.SCOPE_CHANGED, p => seen.push(p));
  try {
    press('a');
    press('a', { dt: 200 });
    assert.equal(Selection.getScope(), 'outer');
    assert.deepEqual(Selection.getSelectedIds(), ['inner']);
    assert.deepEqual(seen, [{ scopeId: 'outer' }]);
    // Second double-click goes one more level down.
    press('a', { dt: 1000 });
    press('a', { dt: 100 });
    assert.equal(Selection.getScope(), 'inner');
    assert.deepEqual(Selection.getSelectedIds(), ['a']);
  } finally { off?.(); }
});

test('slow or far second press is not a double-click', () => {
  reset();
  press('a');
  press('a', { dt: 400 });
  assert.equal(Selection.getScope(), null);
  press('a', { dt: 100, x: 30 });
  assert.equal(Selection.getScope(), null);
  assert.equal(T.isDoubleClick({ t: 0, x: 0, y: 0, target: 'g' }, { t: 349, x: 3, y: 0, target: 'g' }), true);
  assert.equal(T.isDoubleClick({ t: 0, x: 0, y: 0, target: 'g' }, { t: 350, x: 0, y: 0, target: 'g' }), false);
  assert.equal(T.isDoubleClick({ t: 0, x: 0, y: 0, target: 'g' }, { t: 10, x: 0, y: 4, target: 'g' }), false);
  assert.equal(T.isDoubleClick({ t: 0, x: 0, y: 0, target: 'g' }, { t: 10, x: 0, y: 0, target: 'h' }), false);
});

test('double-click on an object is just a click', () => {
  reset();
  press('loose');
  press('loose', { dt: 100 });
  assert.equal(Selection.getScope(), null);
  assert.deepEqual(Selection.getSelectedIds(), ['loose']);
});

test('second-level click inside the scope selects the scope child', () => {
  reset();
  Selection.setScope('outer');
  press('b');
  assert.deepEqual(Selection.getSelectedIds(), ['b']);
  press('lead.part');
  assert.deepEqual(Selection.getSelectedIds(), ['inner']);
  assert.equal(Selection.getScope(), 'outer');
});

test('click outside the scope exits to root, then selects normally', () => {
  reset();
  Selection.setScope('inner');
  press('b');
  assert.equal(Selection.getScope(), null);
  assert.deepEqual(Selection.getSelectedIds(), ['outer']);
  Selection.setScope('outer');
  press('loose');
  assert.equal(Selection.getScope(), null);
  assert.deepEqual(Selection.getSelectedIds(), ['loose']);
});

test('empty click clears the selection and exits the scope', () => {
  reset();
  Selection.setScope('inner');
  Selection.set(['a']);
  press(null);
  assert.equal(BoxSelect.isActive(), true);
  BoxSelect.end();   // zero-size marquee == empty click
  assert.equal(Selection.getScope(), null);
  assert.deepEqual(Selection.getSelectedIds(), []);
});

test('Esc order: marquee cancel > exit one level (selects exited group) > root no-op', () => {
  reset();
  Selection.setScope('inner');
  Selection.set(['a']);
  press(null);                       // start a marquee
  esc();
  assert.equal(BoxSelect.isActive(), false);
  assert.equal(Selection.getScope(), 'inner', 'first Esc only cancels the marquee');
  esc();
  assert.equal(Selection.getScope(), 'outer');
  assert.deepEqual(Selection.getSelectedIds(), ['inner']);
  esc();
  assert.equal(Selection.getScope(), null);
  assert.deepEqual(Selection.getSelectedIds(), ['outer']);
  esc();                              // at root: selection unchanged (Esc never cleared it)
  assert.deepEqual(Selection.getSelectedIds(), ['outer']);
});

test('modifier clicks use the same depth mapping', () => {
  reset();
  press('loose');
  press('a', { shiftKey: true });
  assert.deepEqual(Selection.getSelectedIds(), ['loose', 'outer']);
  press('b', { ctrlKey: true });
  assert.deepEqual(Selection.getSelectedIds(), ['loose']);
});

test('marquee: top-most items within the scope by combined AABB centre', () => {
  reset();
  // Each mesh: screen == world xy (identity projector), unit boxes.
  const mesh = (meshId, x, y) => ({
    metadata: { meshId }, parent: null, isPickable: true, isEnabled: () => true,
    _b: { min: { x: x - 1, y: y - 1, z: 0 }, max: { x: x + 1, y: y + 1, z: 0 } },
  });
  const meshes = [mesh('a', 10, 10), mesh('lead', 30, 10), mesh('lead.part', 50, 10), mesh('b', 100, 100), mesh('loose', 200, 200)];
  const project = (v) => ({ x: v.x, y: v.y });
  const boundsOf = (m) => m._b;
  const map = (id) => Selection.targetAtScope(id);

  // Root: outer's combined AABB spans (9..101, 9..101) → centre (55,55).
  assert.deepEqual(itemIdsInRect(meshes, { sx: 50, sy: 50, ex: 60, ey: 60 }, project, map, boundsOf), ['outer']);
  // Inside outer: inner = (9..51, 9..11) → centre (30,10); b at (100,100); loose excluded.
  Selection.setScope('outer');
  assert.deepEqual(itemIdsInRect(meshes, { sx: 0, sy: 0, ex: 300, ey: 300 }, project, map, boundsOf), ['inner', 'b']);
  // Inside inner: lead + its part merge to centre (40,10).
  Selection.setScope('inner');
  assert.deepEqual(itemIdsInRect(meshes, { sx: 35, sy: 5, ex: 45, ey: 15 }, project, map, boundsOf), ['lead']);
});

test('stale scope (group removed) reads as root; Outliner rule scopes to parent', () => {
  reset();
  Selection.scopeToParentOf('a');
  assert.equal(Selection.getScope(), 'inner');
  Selection.scopeToParentOf('lead.part');
  assert.equal(Selection.getScope(), 'inner');
  Selection.scopeToParentOf('loose');
  assert.equal(Selection.getScope(), null);
  Selection.setScope('inner');
  StateManager.setState(s => {
    const groups = { ...s.scene.groups };
    delete groups.inner;
    return { ...s, scene: { ...s.scene, groups } };
  }, { silent: true });
  assert.equal(Selection.getScope(), null);
  Selection.setScope('not-a-group');
  assert.equal(Selection.getScope(), null);
});
