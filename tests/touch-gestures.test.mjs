// Touch camera + selection (overhaul 8.4). Pure recogniser
// (src/core/TouchGestures.js) + its InputManager wiring: one finger on empty
// = orbit (never a marquee), on a selected movable item = body drag, two
// fingers = pan + pinch, tap = click depth, double-tap = enter group,
// long-press = context menu. Run:
//   node --import ./tests/register-hooks.mjs --test tests/touch-gestures.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { installEnv } from './env.mjs';

installEnv();
globalThis.document.getElementById = () => null;
globalThis.document.querySelector = () => null;
window.BABYLON.PointerEventTypes = { POINTERDOWN: 1, POINTERUP: 2, POINTERMOVE: 4 };
const PET = window.BABYLON.PointerEventTypes;

const {
  createTouchGestures, zoomAboutPoint,
  TOUCH_SLOP_PX, TOUCH_LONG_PRESS_MS, TOUCH_DOUBLE_TAP_MS, TOUCH_DOUBLE_TAP_PX,
} = await import('../src/core/TouchGestures.js');
const { StateManager } = await import('../src/core/StateManager.js');
const { AssetLoader } = await import('../src/core/AssetLoader.js');
const { SceneManager } = await import('../src/core/SceneManager.js');
const { Selection } = await import('../src/core/Selection.js');
const { BoxSelect } = await import('../src/core/BoxSelect.js');
const { InputManager } = await import('../src/core/InputManager.js');

// ── Pure recogniser ──────────────────────────────────────

function rec() {
  let clock = 0;
  const g = createTouchGestures({ now: () => clock });
  return { g, at: (t) => { clock = t; } };
}
const types = (list) => list.map(x => x.phase ? `${x.type}:${x.phase}` : x.type);

test('thresholds match the 8.4 spec', () => {
  assert.equal(TOUCH_SLOP_PX, 8);
  assert.equal(TOUCH_LONG_PRESS_MS, 500);
  assert.equal(TOUCH_DOUBLE_TAP_MS, 350);
  assert.equal(TOUCH_DOUBLE_TAP_PX, 12);
});

test('quick press without movement → press then tap', () => {
  const { g } = rec();
  assert.deepEqual(types(g.down({ id: 1, x: 10, y: 10, t: 0 })), ['press']);
  assert.deepEqual(g.move({ id: 1, x: 13, y: 14, t: 50 }), []);   // 5 px < slop
  const out = g.up({ id: 1, x: 13, y: 14, t: 100 });
  assert.deepEqual(out, [{ type: 'tap', x: 10, y: 10 }]);
  assert.equal(g.mode(), 'idle');
});

test('one-finger drag past slop → orbit start/move/end with full deltas', () => {
  const { g } = rec();
  g.down({ id: 1, x: 0, y: 0, t: 0 });
  const s = g.move({ id: 1, x: 10, y: 0, t: 10 });
  assert.deepEqual(s, [{ type: 'orbit', phase: 'start', dx: 10, dy: 0, x: 10, y: 0, startX: 0, startY: 0 }]);
  assert.deepEqual(g.move({ id: 1, x: 15, y: -3, t: 20 }), [{ type: 'orbit', phase: 'move', dx: 5, dy: -3, x: 15, y: -3 }]);
  assert.deepEqual(types(g.up({ id: 1, x: 15, y: -3, t: 30 })), ['orbit:end']);
  assert.equal(g.mode(), 'idle');
});

test('double-tap: second tap < 350 ms and < 12 px; slow / far ones are plain taps', () => {
  const { g } = rec();
  g.down({ id: 1, x: 50, y: 50, t: 0 });   g.up({ id: 1, x: 50, y: 50, t: 60 });
  g.down({ id: 2, x: 58, y: 55, t: 200 });
  assert.deepEqual(g.up({ id: 2, x: 58, y: 55, t: 260 }), [{ type: 'doubletap', x: 58, y: 55 }]);
  // A third tap right after starts a new pair (doubletap consumed the first).
  g.down({ id: 3, x: 58, y: 55, t: 300 });
  assert.deepEqual(types(g.up({ id: 3, x: 58, y: 55, t: 320 })), ['tap']);
  // Too slow.
  g.down({ id: 4, x: 58, y: 55, t: 700 });
  assert.deepEqual(types(g.up({ id: 4, x: 58, y: 55, t: 720 })), ['tap']);
  // Too far (12 px).
  g.down({ id: 5, x: 70, y: 55, t: 800 });
  assert.deepEqual(types(g.up({ id: 5, x: 70, y: 55, t: 820 })), ['tap']);
});

test('long-press: poll after 500 ms fires once; the release is not a tap', () => {
  const { g } = rec();
  g.down({ id: 1, x: 20, y: 30, t: 0 });
  assert.deepEqual(g.poll(499), []);
  g.move({ id: 1, x: 24, y: 33, t: 300 });                   // 5 px wobble keeps it alive
  assert.deepEqual(g.poll(500), [{ type: 'longpress', x: 24, y: 33 }]);
  assert.deepEqual(g.poll(900), []);
  assert.deepEqual(g.move({ id: 1, x: 80, y: 80, t: 950 }), []);   // no orbit after a long-press
  assert.deepEqual(g.up({ id: 1, x: 80, y: 80, t: 1000 }), []);
  assert.equal(g.mode(), 'idle');
});

test('long-press without a poll is still reported on release; moving ≥ 8 px cancels it', () => {
  const { g } = rec();
  g.down({ id: 1, x: 0, y: 0, t: 0 });
  assert.deepEqual(types(g.up({ id: 1, x: 0, y: 0, t: 600 })), ['longpress']);
  g.down({ id: 2, x: 0, y: 0, t: 1000 });
  g.move({ id: 2, x: 8, y: 0, t: 1100 });
  assert.deepEqual(g.poll(1600), []);
});

test('two fingers: pan by centroid delta, pinch by distance ratio about the centre', () => {
  const { g } = rec();
  g.down({ id: 1, x: 0, y: 0, t: 0 });
  assert.deepEqual(g.down({ id: 2, x: 100, y: 0, t: 5 }), []);
  assert.equal(g.mode(), 'multi');
  // Both move right by 10 (one event each): centroid pans 10 px in total
  // and the two spread changes cancel out (100 → 90 → 100).
  const step = [...g.move({ id: 1, x: 10, y: 0, t: 10 }), ...g.move({ id: 2, x: 110, y: 0, t: 11 })];
  const panDx = step.filter(x => x.type === 'pan').reduce((a, x) => a + x.dx, 0);
  const zoom = step.filter(x => x.type === 'pinch').reduce((a, x) => a * x.scale, 1);
  assert.equal(panDx, 10);
  assert.ok(Math.abs(zoom - 1) < 1e-9);
  // Spread finger 2 by 100 px: distance 100 → 200 = pinch ×2 (+ centroid shift).
  const out = g.move({ id: 2, x: 210, y: 0, t: 20 });
  const pinch = out.find(x => x.type === 'pinch');
  assert.ok(pinch);
  assert.ok(Math.abs(pinch.scale - 2) < 1e-9);
  assert.equal(pinch.x, 110);
  // Lifting fingers never yields a tap.
  assert.deepEqual(g.up({ id: 1, x: 10, y: 0, t: 30 }), []);
  assert.deepEqual(g.move({ id: 2, x: 300, y: 0, t: 31 }), []);   // one finger left: inert
  assert.deepEqual(g.up({ id: 2, x: 300, y: 0, t: 40 }), []);
  assert.equal(g.mode(), 'idle');
});

test('second finger during a one-finger drag ends the orbit as interrupted; third finger ignored', () => {
  const { g } = rec();
  g.down({ id: 1, x: 0, y: 0, t: 0 });
  g.move({ id: 1, x: 20, y: 0, t: 10 });
  const out = g.down({ id: 2, x: 50, y: 50, t: 20 });
  assert.equal(out.length, 1);
  assert.equal(out[0].type, 'orbit');
  assert.equal(out[0].phase, 'end');
  assert.equal(out[0].interrupted, true);
  assert.deepEqual(g.down({ id: 3, x: 90, y: 90, t: 25 }), []);
  assert.equal(g.count(), 2);
});

test('cancel ends a drag as cancelled and resets', () => {
  const { g } = rec();
  g.down({ id: 1, x: 0, y: 0, t: 0 });
  g.move({ id: 1, x: 30, y: 0, t: 10 });
  const out = g.cancel(1);
  assert.equal(out[0].cancelled, true);
  assert.equal(g.mode(), 'idle');
  assert.deepEqual(g.cancel(42), []);
});

test('zoomAboutPoint: homothety about the point, clamped, no-op at the limit', () => {
  const r = zoomAboutPoint({ x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }, 4, 2);
  assert.equal(r.radius, 2);
  assert.deepEqual(r.target, { x: 5, y: 0, z: 0 });   // halfway toward the point
  const c = zoomAboutPoint({ x: 0, y: 0, z: 0 }, null, 4, 100, 1, 10);
  assert.equal(c.radius, 1);
  assert.equal(c.moved, false);
  assert.equal(zoomAboutPoint({ x: 0, y: 0, z: 0 }, null, 1, 2, 1, 10), null);
  assert.equal(zoomAboutPoint({ x: 0, y: 0, z: 0 }, null, 1, 0), null);
  assert.equal(zoomAboutPoint({ x: 0, y: 0, z: 0 }, null, 1, NaN), null);
});

// ── InputManager wiring ──────────────────────────────────

const T = InputManager.__test;
SceneManager.setActive = () => {};
SceneManager.setSelected = () => {};
SceneManager.attachToSelection = () => {};
SceneManager.getBodyDragPlaneY = () => 0;
AssetLoader.getBabylonMesh = (id) => ({ name: id });
SceneManager.getScene = () => ({ transformNodes: [] });
BoxSelect.init({ getEngine: () => ({ getRenderingCanvas: () => null }) });

const calls = [];
SceneManager.beginBodyDrag = () => { calls.push('beginBodyDrag'); return bodyDragOk; };
SceneManager.setBodyDragOffset = (d) => calls.push(`offset:${d.x}`);
SceneManager.endBodyDrag = () => calls.push('endBodyDrag');
SceneManager.cancelBodyDrag = () => calls.push('cancelBodyDrag');
let bodyDragOk = true;

// Pick: x < 100 hits mesh 'a' (inside group 'outer'), x in [100,200) hits
// 'loose', anything else is empty. Ray: straight down from (x/100, 10, 0).
function pickAt(x) { return x < 100 ? 'a' : x < 200 ? 'loose' : null; }
SceneManager.pickMeshIdAt = (x) => pickAt(x);
// The context menu picks ONCE through pickAt (id + PickingInfo), heavy-mesh task e.
SceneManager.pickAt = (x) => ({ meshId: pickAt(x), pick: null });
const fakeScene = {
  pointerX: 0, pointerY: 0, meshes: [],
  activeCamera: {},
  createPickingRay: (x) => ({
    origin: window.BABYLON.Vector3(x / 100, 10, 0),
    direction: window.BABYLON.Vector3(0, -1, 0),
  }),
};
T.setScene(fakeScene);
let clock = 0;
T.setNow(() => clock);

const cam = [];
T.setTouchCamera({
  orbit: (dx, dy) => cam.push(['orbit', dx, dy]),
  pan: (dx, dy) => cam.push(['pan', dx, dy]),
  pinch: (s, x, y) => cam.push(['pinch', s, x, y]),
});
const menus = [];
InputManager.setContextMenuHandler?.((p) => menus.push(p));

function obj(id, over = {}) {
  return {
    id, name: id, assetId: 'a1', collectionId: null, parentId: null,
    shaderId: null, visible: true, locked: false,
    isGhost: false, isUnlinked: false, isPrintPart: true, ...over,
  };
}
function reset({ lockedLoose = false } = {}) {
  StateManager.replaceState(StateManager.freshState());
  StateManager.setState(s => ({
    ...s,
    selection: { ...s.selection, selectedIds: [], activeId: null },
    scene: {
      ...s.scene,
      objects: { a: obj('a', { parentId: 'outer' }), loose: obj('loose', { locked: lockedLoose }) },
      groups: { outer: { id: 'outer', name: 'outer', parentId: null, childIds: ['a'], visible: true, locked: false } },
    },
  }), { silent: true });
  Selection.setScope(null);
  T.resetTouch();
  T.resetClick();
  calls.length = 0; cam.length = 0; menus.length = 0;
  bodyDragOk = true;
  clock = 0;
}

function ptr(type, id, x, y = 10) {
  T.touchPointer({ type, event: { pointerType: 'touch', pointerId: id, clientX: x, clientY: y } });
}
function tap(x, dt = 1000) {
  clock += dt; ptr(PET.POINTERDOWN, 1, x);
  clock += 30; ptr(PET.POINTERUP, 1, x);
}

test('tap selects with click-depth mapping; empty tap clears', () => {
  reset();
  tap(10);
  assert.deepEqual(Selection.getSelectedIds(), ['outer']);   // root: top-level group
  tap(150);
  assert.deepEqual(Selection.getSelectedIds(), ['loose']);
  tap(500);
  assert.deepEqual(Selection.getSelectedIds(), []);
});

test('double-tap enters the group and selects the child under the finger', () => {
  reset();
  tap(10);
  tap(18, 200);   // 8 px away — within the 12 px touch tolerance
  assert.equal(Selection.getScope(), 'outer');
  assert.deepEqual(Selection.getSelectedIds(), ['a']);
});

test('one-finger drag on empty space orbits — no marquee on touch', () => {
  reset();
  clock = 1000;
  ptr(PET.POINTERDOWN, 1, 500);
  ptr(PET.POINTERMOVE, 1, 520);
  ptr(PET.POINTERMOVE, 1, 530, 15);
  ptr(PET.POINTERUP, 1, 530, 15);
  assert.deepEqual(cam, [['orbit', 20, 0], ['orbit', 10, 5]]);
  assert.equal(BoxSelect.isActive(), false);
  assert.deepEqual(calls, []);
});

test('one-finger drag on an UNSELECTED object orbits too', () => {
  reset();
  clock = 1000;
  ptr(PET.POINTERDOWN, 1, 150);
  ptr(PET.POINTERMOVE, 1, 170);
  ptr(PET.POINTERUP, 1, 170);
  assert.deepEqual(cam, [['orbit', 20, 0]]);
  assert.deepEqual(Selection.getSelectedIds(), []);
});

test('one-finger drag on a selected movable object is a body drag', () => {
  reset();
  tap(150);   // select 'loose'
  clock += 1000;
  ptr(PET.POINTERDOWN, 1, 150);
  ptr(PET.POINTERMOVE, 1, 170);
  ptr(PET.POINTERMOVE, 1, 180);
  ptr(PET.POINTERUP, 1, 180);
  assert.deepEqual(cam, []);
  assert.equal(calls[0], 'beginBodyDrag');
  assert.equal(calls.at(-1), 'endBodyDrag');
  assert.ok(calls.some(c => c.startsWith('offset:')));
});

test('body drag: a second finger cancels it (like RMB during a mouse drag)', () => {
  reset();
  tap(150);
  clock += 1000;
  ptr(PET.POINTERDOWN, 1, 150);
  ptr(PET.POINTERMOVE, 1, 170);
  ptr(PET.POINTERDOWN, 2, 300);
  assert.equal(calls.at(-1), 'cancelBodyDrag');
});

test('drag on a selected LOCKED object orbits (lock-aware)', () => {
  reset({ lockedLoose: true });
  tap(150);
  assert.deepEqual(Selection.getSelectedIds(), ['loose']);
  clock += 1000;
  ptr(PET.POINTERDOWN, 1, 150);
  ptr(PET.POINTERMOVE, 1, 170);
  ptr(PET.POINTERUP, 1, 170);
  assert.deepEqual(calls, []);
  assert.deepEqual(cam, [['orbit', 20, 0]]);
});

test('beginBodyDrag refusing (nothing movable) falls back to orbit', () => {
  reset();
  tap(150);
  bodyDragOk = false;
  clock += 1000;
  ptr(PET.POINTERDOWN, 1, 150);
  ptr(PET.POINTERMOVE, 1, 170);
  ptr(PET.POINTERUP, 1, 170);
  assert.deepEqual(cam, [['orbit', 20, 0]]);
  assert.ok(!calls.includes('endBodyDrag'));
});

test('two fingers pan + pinch the camera towards the centre', () => {
  reset();
  clock = 1000;
  ptr(PET.POINTERDOWN, 1, 300, 100);
  ptr(PET.POINTERDOWN, 2, 400, 100);
  ptr(PET.POINTERMOVE, 2, 500, 100);   // distance 100 → 200, centroid 350 → 400
  ptr(PET.POINTERUP, 1, 300, 100);
  ptr(PET.POINTERUP, 2, 500, 100);
  assert.deepEqual(cam, [['pan', 50, 0], ['pinch', 2, 400, 100]]);
  assert.deepEqual(Selection.getSelectedIds(), []);   // no tap
});

test('long-press opens the context menu at that point (selecting the hit item)', () => {
  reset();
  clock = 1000;
  ptr(PET.POINTERDOWN, 1, 150, 40);
  clock += TOUCH_LONG_PRESS_MS;
  T.touchPoll();
  ptr(PET.POINTERUP, 1, 150, 40);
  assert.equal(menus.length, 1);
  assert.equal(menus[0].x, 150);
  assert.equal(menus[0].y, 40);
  assert.equal(menus[0].hit, true);
  assert.deepEqual(Selection.getSelectedIds(), ['loose']);
  // Empty-space long-press → scene menu.
  clock += 1000;
  ptr(PET.POINTERDOWN, 1, 600, 40);
  clock += 600;
  ptr(PET.POINTERUP, 1, 600, 40);
  assert.equal(menus.length, 2);
  assert.equal(menus[1].hit, false);
});
