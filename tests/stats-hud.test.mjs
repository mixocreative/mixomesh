// Viewport statistics: pure count/format/diff logic + live update after a Subdivide-style change.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installEnv } from './env.mjs';

installEnv();
const BABYLON = { ...await import('@babylonjs/core') };
globalThis.window.BABYLON = { ...globalThis.window.BABYLON, ...BABYLON };
globalThis.queueMicrotask ??= (fn) => Promise.resolve().then(fn);

// Minimal DOM for the HUD: #viewport plus the HUD's own children.
function fakeEl() {
  const children = new Map();
  const el = {
    hidden: false, id: '', className: '', textContent: '', title: '', attrs: {},
    classes: new Set(),
    classList: { toggle(c, on) { if (on) el.classes.add(c); else el.classes.delete(c); } },
    setAttribute(k, v) { el.attrs[k] = v; },
    addEventListener() {},
    appendChild(child) { el.__hud = child; },
    set innerHTML(_) { for (const c of ['.sh-scope', '.sh-tris', '.sh-verts', '.sh-hide']) children.set(c, fakeEl()); },
    querySelector(sel) { return children.get(sel) ?? null; },
  };
  return el;
}
const viewport = fakeEl();
globalThis.document = { ...globalThis.document, createElement: () => fakeEl(), getElementById: (id) => (id === 'viewport' ? viewport : null), addEventListener() {} };

const Stats = await import('../src/core/scene/SceneStats.js');
const { bump } = await import('../src/core/geometry/GeometryStore.js');

const engine = new BABYLON.NullEngine({ renderWidth: 32, renderHeight: 32, textureSize: 32 });
const scene = new BABYLON.Scene(engine);
const tt = (key, p = {}) => ({
  'stats.selected': `Selected ${p.n} / ${p.total}`, 'stats.scene': `Scene · Objects ${p.total}`,
  'stats.triangles': 'Triangles', 'stats.vertices': 'Vertices',
}[key] ?? key);

function grid(n, name = 'g') {
  const m = BABYLON.MeshBuilder.CreateGround(name, { width: 1, height: 1, subdivisions: n }, scene);
  return m;
}

test('counts come from buffer lengths, are cached, and refresh on a revision bump', () => {
  const m = grid(10);
  m.metadata = { meshId: 'mesh_g1' };
  const a = Stats.meshCounts(m);
  assert.deepEqual([a.tris, a.verts], [200, 121]);
  assert.equal(Stats.meshCounts(m), a, 'cached object reused');
  bump('mesh_g1');
  assert.notEqual(Stats.meshCounts(m), a, 'revision change invalidates');
  const flat = new BABYLON.Mesh('soup', scene);
  flat.setVerticesData('position', new Float32Array(18));
  assert.equal(Stats.meshCounts(flat).tris, 2, 'unindexed: vertices / 3');
  assert.deepEqual(Stats.sumCounts([m, m, flat]), { tris: 202, verts: 127 }, 'each mesh once');
});

test('locale number formatting', () => {
  assert.equal(Stats.formatCount(1234567, 'en'), '1,234,567');
  assert.equal(Stats.formatCount(1234567, 'ja'), '1,234,567');
  assert.equal(Stats.formatCount(1234567, 'zh-Hant'), '1,234,567');
  assert.equal(Stats.formatCount(NaN, 'en'), '0');
});

test('highlight: geometry change within the same scope shows before → after for 3 s', () => {
  const sel = (tris, verts, key = 'a') => ({ kind: 'selection', key, tris, verts });
  let h = Stats.nextHighlight(sel(12000, 6002), sel(48000, 24002), null, 1000, true);
  assert.deepEqual(h, { from: { tris: 12000, verts: 6002 }, until: 1000 + Stats.HIGHLIGHT_MS });
  // A second operation inside the window keeps the original "before".
  h = Stats.nextHighlight(sel(48000, 24002), sel(192000, 96002), h, 2000, true);
  assert.equal(h.from.tris, 12000);
  // Boolean: selection changes to the result in the same geometry batch → still highlighted.
  assert.ok(Stats.nextHighlight(sel(24, 16, 'a|b'), sel(36, 20, 'r'), null, 0, true));
  // Selection-only change ends it; delete (selection → scene) never highlights.
  assert.equal(Stats.nextHighlight(sel(1, 1), sel(1, 1, 'b'), h, 2100, false), null);
  assert.equal(Stats.nextHighlight(sel(10, 5), { kind: 'scene', key: 'scene', tris: 3, verts: 2 }, null, 0, true), null);
  // Expired windows drop.
  assert.equal(Stats.nextHighlight(sel(1, 1), sel(1, 1), { from: {}, until: 5 }, 10, false), null);
});

test('view text: selection vs scene labels, arrows only on changed counts', () => {
  const v = Stats.statsView({ selected: 2, total: 5, tris: 48000, verts: 24002, highlight: { from: { tris: 12000, verts: 24002 }, until: 100 }, now: 50, locale: 'en', t: tt });
  assert.equal(v.label, 'Selected 2 / 5 · Triangles 12,000 → 48,000 · Vertices 24,002');
  assert.deepEqual(v.changed, { tris: true, verts: false });
  const s = Stats.statsView({ selected: 0, total: 5, tris: 1234567, verts: 617890, locale: 'en', t: tt });
  assert.equal(s.label, 'Scene · Objects 5 · Triangles 1,234,567 · Vertices 617,890');
});

test('HUD updates after a Subdivide-style geometry change on the selection, then settles', async () => {
  const { StateManager, setState } = await import('../src/core/StateManager.js');
  const Registry = await import('../src/core/assets/MeshRegistry.js');
  const HUD = await import('../src/ui/StatsHud.js');
  StateManager.replaceState(StateManager.freshState());
  const mesh = grid(10, 'sub');
  mesh.metadata = { meshId: 'mesh_sub' };
  Registry.registerMesh('mesh_sub', mesh);
  setState(s => ({
    ...s,
    scene: { ...s.scene, objects: { mesh_sub: { id: 'mesh_sub', name: 'sub', visible: true } } },
    selection: { ...s.selection, selectedIds: ['mesh_sub'], activeId: 'mesh_sub' },
  }), { silent: true });
  let now = 10_000;
  HUD.setClock(() => now);
  HUD.init();
  const tris = () => viewport.__hud?.querySelector('.sh-tris')?.textContent;
  // The HUD root is the first element appended to #viewport.
  assert.match(HUD.snapshot().kind, /selection/);
  HUD.refresh(false);
  const before = HUD.snapshot();
  assert.equal(before.tris, 200);
  // "Subdivide": 4x the triangles, in place, with a revision bump (GEOMETRY_CHANGED).
  const sub = BABYLON.MeshBuilder.CreateGround('tmp', { width: 1, height: 1, subdivisions: 20 }, scene);
  mesh.setVerticesData('position', sub.getVerticesData('position'));
  mesh.setIndices(sub.getIndices());
  sub.dispose();
  bump('mesh_sub');
  await new Promise(r => setTimeout(r, 0));
  const after = HUD.snapshot();
  assert.equal(after.tris, 800);
  assert.equal(tris(), 'Triangles 200 → 800', 'before → after while highlighted');
  now += 3100;
  HUD.refresh(false);
  assert.equal(tris(), 'Triangles 800', 'settles to the new value');
  HUD.setClock(null);
});
