// Box (rubber-band / marquee) selection hit-test. The pure projection test
// — which content meshIds fall inside a screen-space rectangle — is the only
// part with real logic; the DOM overlay + pointer wiring are verified live.
//   node --import ./tests/register-hooks.mjs tests/box-select.test.mjs

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installEnv } from './env.mjs';

installEnv();
const { meshIdsInRect, normRect } = await import('../src/core/BoxSelect.js');

// ── Fakes ────────────────────────────────────────────────────────────────
// A content mesh: metadata.meshId on its own node, a bounding-box centre we
// treat (via the identity projector) as its screen coords.
function fakeMesh(meshId, cx, cy, opts = {}) {
  const center = { x: cx, y: cy, z: 0 };
  return {
    metadata: meshId ? { meshId } : {},
    parent: opts.parent ?? null,
    isPickable: opts.isPickable ?? true,
    _enabled: opts.enabled ?? true,
    isEnabled() { return this._enabled; },
    computeWorldMatrix() {},
    getBoundingInfo() { return { boundingBox: { centerWorld: center } }; },
  };
}

// Identity projector: world centre (x,y) IS the screen point.
const project = (v) => ({ x: v.x, y: v.y });

test('normRect orders corners regardless of drag direction', () => {
  assert.deepEqual(normRect({ sx: 100, sy: 80, ex: 20, ey: 10 }),
                   { x0: 20, y0: 10, x1: 100, y1: 80 });
  assert.deepEqual(normRect({ sx: 5, sy: 5, ex: 50, ey: 60 }),
                   { x0: 5, y0: 5, x1: 50, y1: 60 });
});

test('selects only meshes whose centre is inside the rect', () => {
  const meshes = [
    fakeMesh('a', 30, 30),   // inside
    fakeMesh('b', 90, 90),   // outside
    fakeMesh('c', 50, 50),   // inside (on no edge)
  ];
  const ids = meshIdsInRect(meshes, { sx: 10, sy: 10, ex: 60, ey: 60 }, project);
  assert.deepEqual(ids.sort(), ['a', 'c']);
});

test('rectangle is direction-agnostic (drag up-left works)', () => {
  const meshes = [fakeMesh('a', 30, 30)];
  const ids = meshIdsInRect(meshes, { sx: 60, sy: 60, ex: 10, ey: 10 }, project);
  assert.deepEqual(ids, ['a']);
});

test('skips helper meshes with no meshId in the parent chain', () => {
  const meshes = [
    fakeMesh(null, 30, 30),   // grid/label/preview — no meshId
    fakeMesh('a', 30, 30),
  ];
  const ids = meshIdsInRect(meshes, { sx: 10, sy: 10, ex: 60, ey: 60 }, project);
  assert.deepEqual(ids, ['a']);
});

test('inherits meshId from an ancestor node', () => {
  const parent = { metadata: { meshId: 'grp' }, parent: null };
  const child = fakeMesh(null, 30, 30, { parent });
  const ids = meshIdsInRect([child], { sx: 10, sy: 10, ex: 60, ey: 60 }, project);
  assert.deepEqual(ids, ['grp']);
});

test('skips non-pickable and disabled (hidden) meshes', () => {
  const meshes = [
    fakeMesh('a', 30, 30, { isPickable: false }),
    fakeMesh('b', 30, 30, { enabled: false }),
    fakeMesh('c', 30, 30),
  ];
  const ids = meshIdsInRect(meshes, { sx: 10, sy: 10, ex: 60, ey: 60 }, project);
  assert.deepEqual(ids, ['c']);
});

test('dedupes a meshId split across multiple sub-meshes', () => {
  const meshes = [
    fakeMesh('split', 90, 90),   // one submesh outside
    fakeMesh('split', 30, 30),   // another submesh inside → id still selected once
  ];
  const ids = meshIdsInRect(meshes, { sx: 10, sy: 10, ex: 60, ey: 60 }, project);
  assert.deepEqual(ids, ['split']);
});

test('drops meshes the projector rejects (behind camera → null)', () => {
  const meshes = [fakeMesh('a', 30, 30), fakeMesh('b', 30, 30)];
  const cull = (v) => (v === meshes[1].getBoundingInfo().boundingBox.centerWorld ? null : { x: v.x, y: v.y });
  const ids = meshIdsInRect(meshes, { sx: 10, sy: 10, ex: 60, ey: 60 }, cull);
  assert.deepEqual(ids, ['a']);
});

// ── Hover highlight (overhaul 5.6, Decision 22) ──────────────────────────
// Hover follows the SAME click-depth rule as LMB / marquee: the item a click
// would select. Pure helpers only; the pick throttle + outline are live.
const { hoverTarget, hoverMeshes, hoverCursor } = await import('../src/core/Hover.js');
const { outlineEntries } = await import('../src/core/scene/SelectionOutline.js');

// Scene state: group G holds object a (parts a, a2) and subgroup S holding b;
// c is a bare root object.
const HOVER_SCENE = {
  objects: {
    a:  { id: 'a',  parentId: 'G', logicalObjectId: 'a' },
    a2: { id: 'a2', parentId: 'G', logicalObjectId: 'a' },
    b:  { id: 'b',  parentId: 'S' },
    c:  { id: 'c',  parentId: null },
  },
  groups: {
    G: { id: 'G', parentId: null, childIds: ['a', 'a2'] },
    S: { id: 'S', parentId: 'G', childIds: ['b'] },
  },
};

test('hover at root targets the top-level group / bare object', () => {
  assert.equal(hoverTarget('a2', HOVER_SCENE, null), 'G');
  assert.equal(hoverTarget('b', HOVER_SCENE, null), 'G');
  assert.equal(hoverTarget('c', HOVER_SCENE, null), 'c');
  assert.equal(hoverTarget(null, HOVER_SCENE, null), null);
});

test('hover inside a scope targets one level deeper; outside the scope → root item', () => {
  assert.equal(hoverTarget('a2', HOVER_SCENE, 'G'), 'a');   // part → lead
  assert.equal(hoverTarget('b', HOVER_SCENE, 'G'), 'S');
  assert.equal(hoverTarget('c', HOVER_SCENE, 'G'), 'c');    // click there exits to root
});

test('hoverMeshes collects every part / member of the item, skipping hidden + unpickable', () => {
  const meshes = [
    fakeMesh('a', 0, 0), fakeMesh('a2', 0, 0), fakeMesh('b', 0, 0), fakeMesh('c', 0, 0),
    fakeMesh('b', 0, 0, { enabled: false }), fakeMesh('a', 0, 0, { isPickable: false }),
    fakeMesh(null, 0, 0),
  ];
  const at = (scope) => (id) => hoverTarget(id, HOVER_SCENE, scope);
  assert.equal(hoverMeshes('G', meshes, at(null)).length, 3);          // a, a2, b
  assert.deepEqual(hoverMeshes('a', meshes, at('G')).map(m => m.metadata.meshId), ['a', 'a2']);
  assert.deepEqual(hoverMeshes('c', meshes, at(null)).map(m => m.metadata.meshId), ['c']);
  assert.deepEqual(hoverMeshes(null, meshes, at(null)), []);
});

test('hover cursor: move over a draggable body, pointer over a locked one, none off content', () => {
  const locked = new Set(['c']);
  assert.equal(hoverCursor('G', id => locked.has(id)), 'move');
  assert.equal(hoverCursor('c', id => locked.has(id)), 'pointer');
  assert.equal(hoverCursor(null, () => false), '');
});

test('outline mask entries: each mesh once, strongest role wins (active > selected > hover)', () => {
  const m1 = {}, m2 = {}, m3 = {};
  const entries = outlineEntries([m1], [m1, m2], [m2, m3, null]);
  assert.deepEqual(entries.map(e => e.kind), ['active', 'selected', 'hover']);
  assert.equal(entries[2].mesh, m3);
  assert.deepEqual(outlineEntries([], [], []), []);
});
