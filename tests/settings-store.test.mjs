// Per-user settings persistence. The pure schema logic (which slices persist,
// merge precedence, section reset, stored-blob parsing) is unit-tested here;
// the localStorage I/O + scene re-apply + DOM listeners are verified live.
//   node --import ./tests/register-hooks.mjs tests/settings-store.test.mjs

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installEnv } from './env.mjs';

installEnv();
const {
  DEFAULTS, pickSettings, mergeSettings, parseStored,
  applySectionToState, factoryState,
} = await import('../src/core/SettingsStore.js');
const { freshState } = await import('../src/core/StateManager.js');
import DS from '../src/config/default-settings.json' with { type: 'json' };

test('DEFAULTS is the editable config file verbatim', () => {
  assert.deepEqual(DEFAULTS, DS);
});

test('pickSettings keeps only the persisted slices, drops content + pose', () => {
  const s = freshState();
  s.scene.objects = { a: { id: 'a' } };       // content — must be dropped
  s.scene.shaders = { x: {} };                // content — must be dropped
  s.scene.renderOut.pose = { alpha: 1 };      // session — must be dropped
  s.selection.selectedIds = ['a'];            // content — only pivotMode persists
  const picked = pickSettings(s);

  assert.deepEqual(Object.keys(picked).sort(),
    ['gizmo', 'grid', 'overlays', 'pivotMode', 'print', 'render', 'renderOut'].sort());
  assert.equal('pose' in picked.renderOut, false);
  assert.equal(picked.pivotMode, 'active');
  // overlays narrowed to display prefs only
  assert.deepEqual(Object.keys(picked.overlays).sort(), ['axes', 'grid', 'printPreview']);
  // gizmo narrowed to space + snap (mode excluded)
  assert.deepEqual(Object.keys(picked.gizmo).sort(), ['snap', 'space']);
});

test('mergeSettings overlays persisted values onto a base, untouched fields survive', () => {
  const base = freshState();
  const merged = mergeSettings(base, { render: { exposure: 2.5 }, pivotMode: 'cursor' });
  assert.equal(merged.scene.render.exposure, 2.5);
  assert.equal(merged.scene.render.contrast, DS.render.contrast);   // untouched
  assert.equal(merged.selection.pivotMode, 'cursor');
  assert.equal(base.scene.render.exposure, DS.render.exposure);     // base not mutated
});

test('mergeSettings rejects unknown / out-of-schema keys (corrupt blob safety)', () => {
  const base = freshState();
  const merged = mergeSettings(base, {
    render: { exposure: 2, bogusField: 99 },
    overlays: { grid: false, wireframe: true },   // wireframe not a persisted field
    hackerSlice: { evil: true },
  });
  assert.equal(merged.scene.render.exposure, 2);
  assert.equal('bogusField' in merged.scene.render, false);
  assert.equal(merged.scene.overlays.grid, false);
  assert.equal(merged.scene.overlays.wireframe, false);   // ignored, stays factory
  assert.equal('hackerSlice' in merged, false);
});

test('mergeSettings preserves session-only renderOut.pose from the base', () => {
  const base = freshState();
  base.scene.renderOut.pose = { alpha: 1.2 };
  const merged = mergeSettings(base, { renderOut: { width: 800, pose: { alpha: 9 } } });
  assert.equal(merged.scene.renderOut.width, 800);
  assert.deepEqual(merged.scene.renderOut.pose, { alpha: 1.2 });   // persisted pose ignored
});

test('parseStored: good blob round-trips, junk returns null', () => {
  assert.equal(parseStored(null), null);
  assert.equal(parseStored('not json'), null);
  assert.equal(parseStored('{}'), null);                  // no settings key
  const ok = parseStored(JSON.stringify({ v: 1, settings: { render: { exposure: 3 } } }));
  assert.deepEqual(ok.settings, { render: { exposure: 3 } });
});

test('applySectionToState(environment) restores render look but NOT camera optics or grid', () => {
  const s = freshState();
  s.scene.render.exposure = 9;       // env field — should reset
  s.scene.render.fovDeg = 12;        // camera field — should NOT reset
  s.scene.grid.cellMM = 99;          // grid — should NOT reset
  const out = applySectionToState(s, 'environment');
  assert.equal(out.scene.render.exposure, DS.render.exposure);
  assert.equal(out.scene.render.fovDeg, 12);
  assert.equal(out.scene.grid.cellMM, 99);
});

test('applySectionToState(camera) resets only fov/clip', () => {
  const s = freshState();
  s.scene.render.fovDeg = 12;
  s.scene.render.exposure = 9;
  const out = applySectionToState(s, 'camera');
  assert.equal(out.scene.render.fovDeg, DS.render.fovDeg);
  assert.equal(out.scene.render.exposure, 9);
});

test('applySectionToState(grid) resets grid + grid/axes overlays only', () => {
  const s = freshState();
  s.scene.grid.cellMM = 99;
  s.scene.overlays.grid = false;
  s.scene.overlays.printPreview = false;   // not in the grid section
  const out = applySectionToState(s, 'grid');
  assert.equal(out.scene.grid.cellMM, DS.grid.cellMM);
  assert.equal(out.scene.overlays.grid, DS.overlays.grid);
  assert.equal(out.scene.overlays.printPreview, false);   // untouched
});

test('reset PRESERVES ratio fields when a scene is loaded (no silent rescale)', () => {
  const s = freshState();
  s.scene.objects = { m: { id: 'm' } };       // scene loaded
  s.print.workingRatio = 4;
  s.print.targetRatio = 35;
  s.print.minWallThickness = 9;               // non-ratio — should still reset
  const sec = applySectionToState(s, 'print');
  assert.equal(sec.print.workingRatio, 4, 'workingRatio must survive reset under a loaded scene');
  assert.equal(sec.print.targetRatio, 35, 'targetRatio must survive reset under a loaded scene');
  assert.equal(sec.print.minWallThickness, DS.print.minWallThickness, 'non-ratio print field still resets');

  const all = factoryState(s);
  assert.equal(all.print.workingRatio, 4);
  assert.equal(all.print.targetRatio, 35);
  assert.equal(all.print.minWallThickness, DS.print.minWallThickness);
});

test('reset DOES reset ratios on an empty scene (New / no objects)', () => {
  const s = freshState();                      // no objects
  s.print.workingRatio = 4;
  s.print.targetRatio = 35;
  const out = applySectionToState(s, 'print');
  assert.equal(out.print.workingRatio, DS.print.workingRatio);
  assert.equal(out.print.targetRatio, DS.print.targetRatio);
});

test('factoryState resets every persisted slice but leaves content', () => {
  const s = freshState();                       // empty scene → ratios reset too
  s.scene.render.exposure = 9;
  s.print.workingRatio = 7;
  s.print.minWallThickness = 9;
  s.gizmo.snap.translate = 5;
  s.selection.pivotMode = 'world';
  const out = factoryState(s);
  assert.equal(out.scene.render.exposure, DS.render.exposure);
  assert.equal(out.print.workingRatio, DS.print.workingRatio);   // no objects → resets
  assert.equal(out.print.minWallThickness, DS.print.minWallThickness);
  assert.equal(out.gizmo.snap.translate, DS.gizmo.snap.translate);
  assert.equal(out.selection.pivotMode, DS.pivotMode);
});
