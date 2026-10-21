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

test('INITIAL_STATE is wired to default-settings.json (no hardcoded divergence)', () => {
  // Locks the contract: editing default-settings.json must change the boot
  // state. Catches a regression that reintroduces a literal in StateManager.
  const s = freshState();
  assert.deepEqual(s.scene.render, DS.render);
  assert.deepEqual(s.scene.grid, DS.grid);
  assert.deepEqual(s.print, DS.print);
  assert.equal(s.selection.pivotMode, DS.pivotMode);
  assert.equal(s.gizmo.space, DS.gizmo.space);
  assert.deepEqual(s.gizmo.snap, DS.gizmo.snap);
  // renderOut adds session-only pose:null on top of the config fields.
  assert.deepEqual(s.scene.renderOut, { ...DS.renderOut, pose: null });
  // overlays add session-only inspection toggles on top of the display prefs.
  for (const k of Object.keys(DS.overlays)) {
    assert.equal(s.scene.overlays[k], DS.overlays[k], `overlay ${k} should match config`);
  }
});

test('pickSettings keeps only the persisted slices, drops content + pose', () => {
  const s = freshState();
  s.scene.objects = { a: { id: 'a' } };       // content — must be dropped
  s.scene.shaders = { x: {} };                // content — must be dropped
  s.scene.renderOut.pose = { alpha: 1 };      // session — must be dropped
  s.selection.selectedIds = ['a'];            // content — only pivotMode persists
  const picked = pickSettings(s);

  assert.deepEqual(Object.keys(picked).sort(),
    ['cost', 'gizmo', 'grid', 'overlays', 'pivotMode', 'print', 'render', 'renderOut'].sort());
  assert.equal('pose' in picked.renderOut, false);
  assert.equal(picked.pivotMode, 'active');
  // overlays narrowed to display prefs only
  assert.deepEqual(Object.keys(picked.overlays).sort(), ['axes', 'grid', 'printPreview', 'smoothShading', 'stats']);
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

test('stale localStorage with removed print keys (printMode/chordTolerance/minWallThickness) loads clean', () => {
  const base = freshState();
  const merged = mergeSettings(base, { print: { strictExport: true, printMode: 'fdm', chordTolerance: 0.05, minWallThickness: 1.2 } });
  assert.equal(merged.print.strictExport, true);
  for (const k of ['printMode', 'chordTolerance', 'minWallThickness']) {
    assert.equal(k in merged.print, false, `${k} is ignored`);
  }
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

test('print reset restores printer SETTINGS but leaves exportTargets (per-project content) untouched', () => {
  // exportTargets is .mixo content, not a per-user setting — it is excluded from
  // the print SCHEMA allow-list, so a settings reset must NOT touch it.
  const s = freshState();
  s.scene.objects = { m: { id: 'm' } };       // scene loaded
  s.print.exportTargets = [{ kind: 'ratio', value: 4 }, { kind: 'factor', value: 2 }];
  s.print.strictExport = true;
  const sec = applySectionToState(s, 'print');
  assert.deepEqual(sec.print.exportTargets, s.print.exportTargets, 'exportTargets is content — preserved through reset');
  assert.equal(sec.print.strictExport, DS.print.strictExport, 'printer setting resets');

  const all = factoryState(s);
  assert.deepEqual(all.print.exportTargets, s.print.exportTargets, 'exportTargets preserved by factoryState');
  assert.equal(all.print.strictExport, DS.print.strictExport);
});

test('exportTargets is never persisted to localStorage (per-project content)', () => {
  const s = freshState();
  s.print.exportTargets = [{ kind: 'ratio', value: 72 }, { kind: 'height', mm: 120 }];
  assert.equal('exportTargets' in pickSettings(s).print, false,
    'exportTargets must not leak into per-user settings');
});

test('print.strictExport persists per-user through pickSettings + mergeSettings', () => {
  const s = freshState();
  assert.equal(s.print.strictExport, false, 'factory default is off');
  s.print.strictExport = true;
  const picked = pickSettings(s);
  assert.equal(picked.print.strictExport, true, 'picked into the persisted print slice');
  const merged = mergeSettings(freshState(), picked);
  assert.equal(merged.print.strictExport, true, 'restored onto a fresh base');
});

test('print.repairOnImport persists per-user through pickSettings + mergeSettings', () => {
  const s = freshState();
  assert.equal(s.print.repairOnImport, false, 'factory default is off');
  s.print.repairOnImport = true;
  const picked = pickSettings(s);
  assert.equal(picked.print.repairOnImport, true, 'picked into the persisted print slice');
  const merged = mergeSettings(freshState(), picked);
  assert.equal(merged.print.repairOnImport, true, 'restored onto a fresh base');
});

// I8: `repairOnImport` is per-USER (this file's concern) and must therefore
// NOT travel in the .mixo, where the load path merges `print` wholesale and
// "file wins on open" would flip the opener's own setting.
test('print.repairOnImport never enters the .mixo document and a doc carrying it cannot flip the setting', async () => {
  const { __test } = await import('../src/core/PersistenceManager.js');
  const { SceneManager } = await import('../src/core/SceneManager.js');
  const { AssetLoader } = await import('../src/core/AssetLoader.js');
  const { setState, getState } = await import('../src/core/StateManager.js');
  const { __test: loaderTest } = await import('../src/core/persist/ProjectLoader.js');

  SceneManager.saveCameraState = () => ({
    alpha: 0, beta: 0, radius: 1, target: { x: 0, y: 0, z: 0 }, isOrthographic: false,
  });
  AssetLoader.getAssetBytes = async () => null;
  AssetLoader.getBabylonMesh = () => null;

  setState(s => ({ ...s, print: { ...s.print, repairOnImport: true, strictExport: true, objBakeSolidTextures: true } }), { silent: true });
  const doc = await __test._buildDocument({ skipEmbed: true });
  assert.equal('repairOnImport' in doc.print, false,
    `repairOnImport must not be serialised: ${JSON.stringify(doc.print)}`);
  assert.equal('strictExport' in doc.print, false, 'strictExport is per-user too (Decision 15) — not serialised');
  assert.equal(doc.print.objBakeSolidTextures, true, 'the rest of the print slice still travels');
  assert.equal(getState().print.repairOnImport, true, 'the live per-user setting is untouched by saving');

  // A document that DOES carry it (hand-written, or an older save) must be
  // stripped on load rather than overriding the user's choice.
  assert.equal(
    'repairOnImport' in loaderTest._printWithoutLegacyScale({ repairOnImport: false, strictExport: true }),
    false,
    'the load merge strips repairOnImport from the incoming print slice',
  );
  const stale = loaderTest._printWithoutLegacyScale({ printMode: 'fdm', chordTolerance: 0.05, minWallThickness: 1.2, strictExport: true, objBakeSolidTextures: true });
  assert.equal(stale.objBakeSolidTextures, true, 'project fields survive');
  for (const k of ['printMode', 'chordTolerance', 'minWallThickness', 'strictExport']) assert.equal(k in stale, false, `${k} dropped on load`);
  assert.equal(stale.exportFormat, null, '1.3: a missing profile field follows the printer profile');
  assert.equal(stale.individually, false);
});

test('factoryState resets every persisted slice but leaves content', () => {
  const s = freshState();
  s.scene.render.exposure = 9;
  s.print.strictExport = true;
  s.gizmo.snap.translate = 5;
  s.selection.pivotMode = 'world';
  const out = factoryState(s);
  assert.equal(out.scene.render.exposure, DS.render.exposure);
  assert.equal(out.print.strictExport, DS.print.strictExport);
  assert.equal(out.gizmo.snap.translate, DS.gizmo.snap.translate);
  assert.equal(out.selection.pivotMode, DS.pivotMode);
});

test('cost: INITIAL_STATE seeds from default-settings.json', () => {
  const s = freshState();
  assert.deepEqual(s.cost, DS.cost);
});

test('cost: never persisted in .mixo (per-user setting only) but round-trips through pickSettings/mergeSettings', () => {
  const s = freshState();
  s.cost = { ...s.cost, materialId: 'pla', pricePerGram: 0.04, supportPricePerGram: 0.02, supportPercent: 20, currency: 'EUR' };
  const picked = pickSettings(s);
  assert.ok('cost' in picked, 'cost slice picked into per-user settings');
  assert.deepEqual(picked.cost, s.cost);
  const merged = mergeSettings(freshState(), picked);
  assert.deepEqual(merged.cost, s.cost, 'restored onto a fresh base');
});

test('cost: mergeSettings rejects unknown fields on a corrupt blob', () => {
  const merged = mergeSettings(freshState(), { cost: { materialId: 'pla', bogusField: 99 } });
  assert.equal(merged.cost.materialId, 'pla');
  assert.equal('bogusField' in merged.cost, false);
});

test('cost: resetSection(cost) restores factory values via applySectionToState', () => {
  const s = freshState();
  s.cost.pricePerGram = 9;
  const out = applySectionToState(s, 'cost');
  assert.equal(out.cost.pricePerGram, DS.cost.pricePerGram);
});

test('bg-controls: factory carries darkIntensity + lightIntensity at 1.0', () => {
  assert.equal(DEFAULTS.render.darkIntensity, 1);
  assert.equal(DEFAULTS.render.lightIntensity, 1);
});

// ── 1.3 / Decision 15: print settings scope split ──────────────────────
test('1.3: print scope — per-project and per-user field sets are disjoint and match Decision 15', async () => {
  const { PRINT_PROJECT_FIELDS, PRINT_USER_FIELDS } = await import('../src/core/SettingsStore.js');
  assert.deepEqual([...PRINT_PROJECT_FIELDS].sort(), [
    'bedDimensions', 'exportFormat', 'exportTargets', 'individually', 'objAxis', 'objBakeSolidTextures',
    'referenceObjectId', 'splitByMaterial', 'targetPrinterId', 'threeMFFlavour',
  ]);
  assert.deepEqual([...PRINT_USER_FIELDS].sort(), ['repairOnImport', 'strictExport']);
  assert.equal(PRINT_PROJECT_FIELDS.some(f => PRINT_USER_FIELDS.includes(f)), false, 'scopes are disjoint');
  for (const f of [...PRINT_PROJECT_FIELDS, ...PRINT_USER_FIELDS]) {
    assert.ok(f in DS.print, `default-settings.json print carries ${f}`);
  }
});

test('1.3: profile-driven overrides + print sizes are never seeded from localStorage (per-project)', () => {
  const s = freshState();
  Object.assign(s.print, {
    exportFormat: 'stl', splitByMaterial: true, objAxis: 'z-up', threeMFFlavour: 'bambu', individually: true,
    referenceObjectId: 'x', exportTargets: [{ kind: 'factor', value: 2 }], strictExport: true,
  });
  const picked = pickSettings(s).print;
  for (const k of ['exportFormat', 'splitByMaterial', 'objAxis', 'threeMFFlavour', 'individually', 'referenceObjectId', 'exportTargets']) {
    assert.equal(k in picked, false, `${k} is per-project — not in per-user settings`);
  }
  assert.equal(picked.strictExport, true, 'per-user strictExport still persists');
  // A stale/hand-edited blob cannot inject a per-project override either.
  const merged = mergeSettings(freshState(), { print: { exportFormat: 'stl', strictExport: true } });
  assert.equal(merged.print.exportFormat, DS.print.exportFormat, 'override not injected from localStorage');
  assert.equal(merged.print.strictExport, true);
});

test('1.3: factory profile-driven fields are null (= follow the printer profile)', () => {
  for (const k of ['exportFormat', 'splitByMaterial', 'objAxis', 'threeMFFlavour']) {
    assert.equal(DS.print[k], null, `${k} defaults to null`);
  }
  assert.equal(DS.print.individually, false);
});

test('1.3: Print ↺ reset returns profile overrides to factory but keeps print sizes + reference', () => {
  const s = freshState();
  s.scene.objects = { m: { id: 'm' } };
  Object.assign(s.print, {
    exportFormat: 'stl', splitByMaterial: true, objAxis: 'z-up', threeMFFlavour: 'prusa', individually: true,
    referenceObjectId: 'm', exportTargets: [{ kind: 'ratio', value: 144 }],
  });
  const out = applySectionToState(s, 'print');
  for (const k of ['exportFormat', 'splitByMaterial', 'objAxis', 'threeMFFlavour', 'individually']) {
    assert.deepEqual(out.print[k], DS.print[k], `${k} reset to factory`);
  }
  assert.equal(out.print.referenceObjectId, 'm', 'reference is project content — kept');
  assert.deepEqual(out.print.exportTargets, [{ kind: 'ratio', value: 144 }], 'print sizes kept');
});
