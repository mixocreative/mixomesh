// Responsive tiers + phone viewer logic (overhaul 8.3 / 8.6): the layout
// decision, the read-only shortcut allow-list, the object list, the info-sheet
// data and InputManager's read-only gate. Run:
//   node --import ./tests/register-hooks.mjs --test tests/viewer-model.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { installEnv } from './env.mjs';

installEnv();
globalThis.document.getElementById = () => null;
globalThis.document.querySelector = () => null;

const M = await import('../src/core/ViewerModel.js');
const { StateManager } = await import('../src/core/StateManager.js');
const { AssetLoader } = await import('../src/core/AssetLoader.js');
const { SceneManager } = await import('../src/core/SceneManager.js');
const { Selection } = await import('../src/core/Selection.js');
const { InputManager } = await import('../src/core/InputManager.js');

test('layoutModeForWidth: tier boundaries', () => {
  assert.equal(M.layoutModeForWidth(390), 'viewer');
  assert.equal(M.layoutModeForWidth(767), 'viewer');
  assert.equal(M.layoutModeForWidth(768), 'portrait');
  assert.equal(M.layoutModeForWidth(1023), 'portrait');
  assert.equal(M.layoutModeForWidth(1024), 'narrow');
  assert.equal(M.layoutModeForWidth(1279), 'narrow');
  assert.equal(M.layoutModeForWidth(1280), 'full');
  assert.equal(M.layoutModeForWidth(1920), 'full');
  assert.equal(M.layoutModeForWidth(NaN), 'full', 'unknown width never traps the user in the viewer');
  assert.equal(M.isViewerWidth(767), true);
  assert.equal(M.isViewerWidth(768), false);
});

test('breakpoint constants match the CSS media queries', async () => {
  const { readFileSync } = await import('node:fs');
  const viewerCss = readFileSync(new URL('../src/styles/components/viewer.css', import.meta.url), 'utf8');
  const respCss = readFileSync(new URL('../src/styles/responsive.css', import.meta.url), 'utf8');
  assert.ok(viewerCss.includes(`max-width: ${M.VIEWER_MAX_WIDTH - 1}px`));
  assert.ok(respCss.includes(`max-width: ${M.SHEET_MAX_WIDTH - 1}px`));
  assert.ok(respCss.includes(`min-width: ${M.VIEWER_MAX_WIDTH}px) and (max-width: ${M.PORTRAIT_MAX_WIDTH - 1}px`));
});

test('isReadOnlyShortcut: camera / select stay, every edit verb goes', () => {
  for (const k of ['F', 'Home', 'Numpad7', 'Numpad5', 'Ctrl+Numpad1', 'Alt+7', 'Ctrl+Alt+3', 'A', 'Alt+A', '.']) {
    assert.equal(M.isReadOnlyShortcut(k), true, k);
  }
  for (const k of ['G', 'R', 'S', 'X', 'Delete', 'H', 'L', 'F2', 'Shift+D', 'Ctrl+G', 'Ctrl+Z', 'Ctrl+Y', 'Ctrl+S',
    'Ctrl+Shift+S', 'Ctrl+O', 'Ctrl+N', 'Ctrl+I', 'Ctrl+C', 'Ctrl+V', 'Shift+N', 'ArrowLeft', '`', '', undefined]) {
    assert.equal(M.isReadOnlyShortcut(k), false, String(k));
  }
});

const obj = (id, over = {}) => ({ id, name: id, parentId: null, ratio: 1, ...over });
const scene = {
  objects: {
    a: obj('a', { parentId: 'g', ratio: 72 }),
    b: obj('b', { parentId: 'g', ratio: 72 }),
    c: obj('c', { parentId: 'h', ratio: 35 }),
    lead: obj('lead', { logicalObjectId: 'lead', ratio: 72 }),
    'lead.part': obj('lead.part', { logicalObjectId: 'lead', isInternalPart: true }),
    loose: obj('loose', { name: 'Loose bit', ratio: 1 }),
  },
  groups: {
    g: { id: 'g', name: 'Kit', parentId: null, childIds: ['a', 'b', 'h'] },
    h: { id: 'h', name: 'Sub', parentId: 'g', childIds: ['c'] },
  },
};

test('topLevelItems: top-level groups first, then top-level objects; parts folded, children excluded', () => {
  const items = M.topLevelItems(scene);
  assert.deepEqual(items.map(i => [i.id, i.kind]), [['g', 'group'], ['lead', 'object'], ['loose', 'object']]);
  assert.equal(items[0].count, 3, 'two objects + one subgroup');
  assert.equal(items[2].name, 'Loose bit');
  assert.deepEqual(M.topLevelItems({}), []);
});

test('unionExtents: merges boxes, reads Babylon-style accessor vectors, null when empty', () => {
  class V { constructor(x, y, z) { this._x = x; this._y = y; this._z = z; } get x() { return this._x; } get y() { return this._y; } get z() { return this._z; } }
  const ext = M.unionExtents([
    { min: new V(0, 0, 0), max: new V(0.1, 0.02, 0.05) },
    { min: new V(0.05, -0.01, 0.02), max: new V(0.2, 0.03, 0.06) },
  ]);
  assert.ok(Math.abs(ext.x - 0.2) < 1e-12 && Math.abs(ext.y - 0.04) < 1e-12 && Math.abs(ext.z - 0.06) < 1e-12);
  assert.equal(M.unionExtents([]), null);
  assert.equal(M.unionExtents([{ min: new V(NaN, 0, 0), max: new V(1, 1, 1) }]), null);
});

test('formatSizeMM: W x D x H in mm (print X = BU x, depth = z, height = y), one decimal', () => {
  assert.equal(M.formatSizeMM({ x: 0.1842, y: 0.0384, z: 0.142 }, 1000), '184.2 × 142.0 × 38.4 mm');
  assert.equal(M.formatSizeMM(null, 1000), '');
  assert.equal(M.formatSizeMM({ x: 1, y: 1, z: 1 }, NaN), '');
});

test('scaleLabelFor: shared ratio label, null when mixed or empty', () => {
  assert.equal(M.scaleLabelFor([scene.objects.a, scene.objects.b]), '1:72');
  assert.equal(M.scaleLabelFor([scene.objects.a, scene.objects.c]), null);
  assert.equal(M.scaleLabelFor([scene.objects.loose]), '1:1');
  assert.equal(M.scaleLabelFor([]), null);
});

test('describeItem: object and group info-sheet data', () => {
  const measured = { extentsBU: { x: 0.05, y: 0.01, z: 0.03 }, buToMm: 1000 };
  const o = M.describeItem(scene, 'a', measured);
  assert.deepEqual(o, { id: 'a', kind: 'object', name: 'a', size: '50.0 × 30.0 × 10.0 mm', scale: '1:72', count: 0 });
  const g = M.describeItem(scene, 'g', measured);
  assert.equal(g.kind, 'group');
  assert.equal(g.count, 3, 'a, b and c inside the nested subgroup');
  assert.equal(g.scale, null, 'mixed 1:72 / 1:35');
  assert.equal(M.describeItem(scene, 'nope', measured), null);
});

test('openKindFor: project vs model vs unsupported', () => {
  assert.equal(M.openKindFor('kit.MIXO'), 'project');
  for (const n of ['a.glb', 'a.gltf', 'a.3mf', 'a.obj', 'a.STL']) assert.equal(M.openKindFor(n), 'model', n);
  for (const n of ['a.txt', 'noext', '', null]) assert.equal(M.openKindFor(n), null, String(n));
});

test('recencyBucket: today / yesterday / earlier', () => {
  const now = new Date(2026, 9, 14, 15, 0, 0).getTime();
  assert.equal(M.recencyBucket(new Date(2026, 9, 14, 1, 0, 0).getTime(), now), 'today');
  assert.equal(M.recencyBucket(new Date(2026, 9, 13, 23, 0, 0).getTime(), now), 'yesterday');
  assert.equal(M.recencyBucket(new Date(2026, 9, 1, 12, 0, 0).getTime(), now), 'earlier');
});

// ── InputManager read-only gate ──────────────────────────

test('InputManager read-only: edit shortcuts blocked, camera shortcuts live, writable again after', () => {
  AssetLoader.getBabylonMesh = (id) => ({ name: id });
  SceneManager.getScene = () => ({ transformNodes: [] });
  SceneManager.attachToSelection = () => {};
  SceneManager.setActive = () => {};
  SceneManager.setSelected = () => {};
  Selection.refresh = () => {};
  StateManager.replaceState(StateManager.freshState());
  const T = InputManager.__test;
  T.clearHandlers();
  const calls = [];
  InputManager.register('Delete', 'global', () => calls.push('Delete'));
  InputManager.register('Ctrl+Z', 'global', () => calls.push('Ctrl+Z'));
  InputManager.register('Numpad7', 'global', () => calls.push('Numpad7'));
  const press = (key, extra = {}) => T.keyDown({
    key, code: extra.code ?? '', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false,
    preventDefault() {}, ...extra,
  });

  assert.equal(InputManager.isReadOnly(), false);
  press('Delete'); press('z', { ctrlKey: true });
  assert.deepEqual(calls, ['Delete', 'Ctrl+Z'], 'normal mode: handlers fire');

  calls.length = 0;
  InputManager.setReadOnly(true);
  assert.equal(InputManager.isReadOnly(), true);
  press('Delete'); press('z', { ctrlKey: true }); press('7', { code: 'Numpad7' });
  assert.deepEqual(calls, ['Numpad7'], 'read-only: only the camera shortcut fires');

  InputManager.setReadOnly(false);
  calls.length = 0;
  press('Delete');
  assert.deepEqual(calls, ['Delete'], 'leaving read-only restores editing');
  T.clearHandlers();
});
