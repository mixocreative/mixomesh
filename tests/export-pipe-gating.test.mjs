// Export: collection gating, auto-fix and the warning gate
//
// Cut out of tests/export.test.mjs on 2026-11-14; the harness is
// ./export-kit.mjs. `report()` below asserts this file's case count -- see that file
// for why, and change the number in the same commit as any case you add or remove.

import assert from 'node:assert/strict';
import {
  MeshRepair, MeshValidator, PrintManager, StateManager, _clones, _registry, calls, mesh, obj,
  objBlocks, objTexts, rejects, report, setScene, test, valErrAlways, valErrUnlessFixed, valOK,
  valWarnOnly, zipInstances,
} from './export-kit.mjs';

// ── Collection gating (pre-auto-fix) ─────────────────────

await test('requested refined preview blocks a batch when one logical unit is stale', async () => {
  setScene({
    objects: {
      m1: obj('m1'),
      m2: obj('m2', { printRefinement: { requestedLevel: 1, preview: 'refined', status: 'stale' } }),
    },
    registry: { m1: mesh('m1'), m2: mesh('m2') },
  });
  MeshValidator.validateMesh = valOK;
  const readiness = PrintManager.getPrintReadiness();
  assert.equal(readiness.canExport, false);
  assert.ok(readiness.issues.some(issue => issue.code === 'refinement-unavailable'
    && issue.objectIds.includes('m2')));
  await assert.rejects(PrintManager.exportSTL(), err =>
    err.readinessIssues?.some(issue => issue.code === 'refinement-unavailable'));
  assert.equal(_clones.length, 0, 'preflight must block before creating export clones');
});

await test('explicit original preview exports despite failed refinement request', async () => {
  const original = mesh('m1');
  setScene({
    objects: { m1: obj('m1', { printRefinement: { requestedLevel: 1, preview: 'original', status: 'failed' } }) },
    registry: { m1: original },
  });
  MeshValidator.validateMesh = valOK;
  assert.equal(PrintManager.getPrintReadiness().canExport, true);
  await PrintManager.exportOBJ();
  assert.ok(_clones.length > 0);
  assert.equal(_clones[0].name, 'm1__export');
  assert.equal(original.__worldBaked, undefined, 'source mesh must not be prepared in place');
});

await test('ready refined preview sends derived clones through OBJ, STL and 3MF without changing sources', async () => {
  const original = mesh('original');
  const derived = mesh('refined', { size: [20, 30, 40] });
  derived.metadata = { level: 1, sourceMeshId: 'original' };
  setScene({
    objects: { m1: obj('m1', { printRefinement: { requestedLevel: 1, preview: 'refined', status: 'ready' } }) },
    registry: { m1: original },
  });
  MeshValidator.validateMesh = valOK;
  for (const writer of [PrintManager.exportOBJ, PrintManager.exportSTL, PrintManager.exportThreeMF]) {
    _clones.length = 0;
    await writer({ derivedMeshesFor: () => [derived], repair: false, acknowledgeWarnings: true });
    assert.ok(_clones.some(clone => clone.name === 'refined__export'), 'writer must clone the selected derived mesh');
    assert.ok(!_clones.some(clone => clone.name === 'original__export'), 'writer must not clone original mesh');
    assert.equal(original.__worldBaked, undefined);
    assert.equal(derived.__worldBaked, undefined);
  }
});

await test('OBJ: empty scene → throws "No printable meshes"', async () => {
  setScene({});
  MeshValidator.validateMesh = valOK;
  await rejects(PrintManager.exportOBJ(), /No printable meshes to export/);
});

for (const [label, over] of [
  ['isPrintPart=false', { isPrintPart: false }],
  ['ghost', { isGhost: true }],
]) {
  await test(`OBJ: ${label} excluded → throws`, async () => {
    setScene({ objects: { m1: obj('m1', over) }, registry: { m1: mesh('m1') } });
    MeshValidator.validateMesh = valOK;
    await rejects(PrintManager.exportOBJ(), /No printable meshes/);
  });
}

await test('OBJ: zero-vertex mesh excluded → throws', async () => {
  setScene({ objects: { m1: obj('m1') }, registry: { m1: mesh('m1', { verts: 0 }) } });
  MeshValidator.validateMesh = valOK;
  await rejects(PrintManager.exportOBJ(), /No printable meshes/);
});

await test('OBJ: missing registry mesh → throws', async () => {
  setScene({ objects: { m1: obj('m1') }, registry: {} });
  MeshValidator.validateMesh = valOK;
  await rejects(PrintManager.exportOBJ(), /No printable meshes/);
});

await test('all formats stay available but a missing referenced texture blocks the pipeline', async () => {
  setScene({
    objects: { m1: obj('m1', { shaderId: 'shader_missing_tex' }) },
    registry: { m1: mesh('m1') },
  });
  StateManager.setState(s => ({
    ...s,
    scene: {
      ...s.scene,
      assetLibrary: {},
      shaders: {
        shader_missing_tex: {
          id: 'shader_missing_tex',
          diffuseTextureAssetId: 'texture_not_loaded',
        },
      },
    },
  }), { silent: true });
  const readiness = PrintManager.getPrintReadiness();
  assert.deepEqual(readiness.formats, ['obj', '3mf', 'stl', 'ply', 'wrl']);
  assert.equal(readiness.issues.some(issue => issue.code === 'missing-texture'), true);
  await assert.rejects(PrintManager.exportOBJ(), err =>
    err.readinessIssues?.some(issue => issue.code === 'missing-texture'));
});

// ── Auto-fix + post-fix validation ───────────────────────

await test('OBJ: valid mesh → auto-fix runs on a clone, exports, downloads', async () => {
  setScene({ objects: { m1: obj('m1') }, registry: { m1: mesh('m1') } });
  MeshValidator.validateMesh = valOK;
  await PrintManager.exportOBJ();
  assert.equal(_clones.length, 1, 'one export clone made');
  assert.equal(_clones[0].__optimized, true, 'optimizeIndices ran on clone');
  assert.equal(_clones[0].__normals, true, 'createNormals ran on clone');
  assert.equal(_clones[0].__disposed, true, 'clone disposed after export');
  assert.equal(_clones[0].__unique, true, 'clone got its own geometry before any prep (non-destructive)');
  assert.equal(_clones[0].__worldBaked, true, 'world matrix baked into the clone, not the scene');
  assert.equal(_registry.m1.__optimized, undefined, 'live scene mesh untouched');
  assert.equal(_registry.m1.__worldBaked, undefined, 'live scene geometry untouched');
  assert.equal(objTexts().length, 1);
  assert.equal(calls.objExportOBJ.length, 0, 'ObjWriter owns OBJ text, not Babylon OBJExport.OBJ');
  assert.equal(calls.objExportMTL.length, 0, 'PrintManager owns MTL generation, not Babylon OBJExport.MTL');
  const files = zipInstances.at(-1).files;
  assert.match(files['Test_r1to1.obj'], /^mtllib Test_r1to1\.mtl/m);
  assert.match(files['Test_r1to1.obj'], /^usemtl mat-m1/m);
  assert.match(files['Test_r1to1.mtl'], /^newmtl mat-m1/m);
  assert.equal(calls.downloads.length, 1);
});

await test('OBJ: error that survives auto-fix → blocks with err.validationErrors', async () => {
  setScene({ objects: { m1: obj('m1') }, registry: { m1: mesh('m1') } });
  MeshValidator.validateMesh = valErrAlways;
  await assert.rejects(PrintManager.exportOBJ(), (err) => {
    assert.ok(Array.isArray(err.validationErrors), 'has validationErrors');
    assert.equal(err.validationErrors.length, 1);
    assert.match(err.validationErrors[0].message, /non-manifold/);
    return true;
  });
  assert.equal(objTexts().length, 0, 'no OBJ written');
  assert.equal(calls.downloads.length, 0, 'no download');
});

await test('OBJ: error the auto-fix RESOLVES → exports, no error list', async () => {
  setScene({ objects: { m1: obj('m1') }, registry: { m1: mesh('m1') } });
  MeshValidator.validateMesh = valErrUnlessFixed;   // cleared once createNormals runs
  await PrintManager.exportOBJ();
  assert.equal(objTexts().length, 1, 'exported because fix cleared the error');
  assert.equal(calls.downloads.length, 1);
});

await test('OBJ: mesh with no material → gets fallback, still exports', async () => {
  const m = mesh('m1');
  m.material = null;                       // untextured import
  const origClone = m.clone;
  m.clone = (n) => { const c = origClone.call(m, n); c.material = null; return c; };
  setScene({ objects: { m1: obj('m1') }, registry: { m1: m } });
  MeshValidator.validateMesh = valOK;
  await PrintManager.exportOBJ();
  assert.equal(objTexts().length, 1);
  assert.equal(calls.objExportMTL.length, 0);
  assert.ok(_clones[0].material, 'fallback material assigned to clone');
});

await test('OBJ: generated MTL supports PBR/albedo materials without Babylon StandardMaterial fields', async () => {
  const m = mesh('m1');
  m.material = {
    id: 'pbr-mat',
    name: 'PBR Mat',
    // PBR albedo is LINEAR; MTL Kd is sRGB → 0.2159 linear encodes to 0.5020 (#80).
    albedoColor: { r: 0.2159, g: 0.2159, b: 0.2159 },
    alpha: 0.6,
  };
  const origClone = m.clone;
  m.clone = (n) => { const c = origClone.call(m, n); c.material = m.material; return c; };
  setScene({ objects: { m1: obj('m1') }, registry: { m1: m } });
  MeshValidator.validateMesh = valOK;
  await PrintManager.exportOBJ();
  const mtl = zipInstances.at(-1).files['Test_r1to1.mtl'];
  assert.match(mtl, /^newmtl pbr-mat/m);
  assert.match(mtl, /^Kd 0\.5020 0\.5020 0\.5020/m, 'PBR albedo gamma-encoded once for Kd');
  assert.match(mtl, /^d 0\.6000/m);
});

await test('OBJ: warnings only → still exports', async () => {
  setScene({ objects: { m1: obj('m1') }, registry: { m1: mesh('m1') } });
  MeshValidator.validateMesh = valWarnOnly;
  await PrintManager.exportOBJ();
  assert.equal(objTexts().length, 1);
  assert.equal(calls.downloads.length, 1);
});

// ── Gate (task 1.8, Decision 18): acknowledgement enforced IN the pipeline ──

const withCache = (id, results) => StateManager.setState(
  s => ({ ...s, scene: { ...s.scene, validation: { [id]: { results, stale: false } } } }), { silent: true });
const geoWarn = [{ type: 'holes', severity: 'warning', message: 'open edges' }];

await test('gate: readiness warning + no acknowledgement → rejected needsAcknowledgement, no download, no clone', async () => {
  setScene({ objects: { m1: obj('m1') }, registry: { m1: mesh('m1') } });
  withCache('m1', geoWarn);
  MeshValidator.validateMesh = valOK;
  await assert.rejects(PrintManager.exportOBJ(), err =>
    err.needsAcknowledgement === true && err.code === 'EXPORT_NEEDS_ACKNOWLEDGEMENT'
    && err.readinessIssues.some(i => i.code === 'geometry-warning'));
  assert.equal(calls.downloads.length, 0, 'nothing downloaded');
  assert.equal(_clones.length, 0, 'rejected before any export clone was made');
});

await test('gate: every format rejects an unacknowledged warning', async () => {
  setScene({ objects: { m1: obj('m1') }, registry: { m1: mesh('m1') } });
  withCache('m1', geoWarn);
  MeshValidator.validateMesh = valOK;
  for (const fn of ['exportOBJ', 'exportSTL', 'exportThreeMF', 'exportPLY', 'exportWRL']) {
    await assert.rejects(PrintManager[fn](), err => err.needsAcknowledgement === true, fn);
  }
  assert.equal(calls.downloads.length, 0);
});

await test('gate: acknowledgeWarnings only counts when strictly true', async () => {
  setScene({ objects: { m1: obj('m1') }, registry: { m1: mesh('m1') } });
  withCache('m1', geoWarn);
  MeshValidator.validateMesh = valOK;
  await assert.rejects(PrintManager.exportOBJ({ acknowledgeWarnings: 'yes' }), err => err.needsAcknowledgement === true);
  assert.equal(calls.downloads.length, 0);
});

await test('gate: readiness warning + acknowledgeWarnings:true → exports', async () => {
  setScene({ objects: { m1: obj('m1') }, registry: { m1: mesh('m1') } });
  withCache('m1', geoWarn);
  MeshValidator.validateMesh = valOK;
  await PrintManager.exportOBJ({ acknowledgeWarnings: true });
  assert.equal(calls.downloads.length, 1);
});

await test('gate: readiness error blocks even WITH acknowledgement', async () => {
  setScene({ objects: { m1: obj('m1') }, registry: { m1: mesh('m1') } });
  withCache('m1', [{ type: 'x', severity: 'error', message: 'broken' }, ...geoWarn]);
  MeshValidator.validateMesh = valOK;
  await assert.rejects(PrintManager.exportOBJ({ acknowledgeWarnings: true }), err =>
    !err.needsAcknowledgement && err.readinessIssues?.some(i => i.code === 'geometry-error'));
  assert.equal(calls.downloads.length, 0);
});

await test('gate: info-only readiness (mixed-scales) exports without acknowledgement', async () => {
  setScene({ objects: { m1: obj('m1', { ratio: 1 }), m2: obj('m2', { ratio: 2 }) },
    registry: { m1: mesh('m1'), m2: mesh('m2') } });
  withCache('m1', []);
  StateManager.setState(s => ({ ...s, scene: { ...s.scene, validation: {
    m1: { results: [], stale: false }, m2: { results: [], stale: false } } } }), { silent: true });
  MeshValidator.validateMesh = valOK;
  const r = PrintManager.getPrintReadiness();
  assert.ok(r.issues.some(i => i.code === 'mixed-scales' && i.severity === 'info'), 'precondition: info issue present');
  assert.equal(r.requiresAcknowledgement, false);
  await PrintManager.exportOBJ();
  assert.equal(calls.downloads.length, 1);
});

await test('gate (strict): UNKNOWN watertight verdict (repair engine unavailable) blocks', async () => {
  MeshRepair.__test.setEngine(null);
  setScene({ objects: { m1: obj('m1') }, registry: { m1: mesh('m1') } });
  StateManager.setState(s => ({ ...s, print: { ...s.print, strictExport: true } }), { silent: true });
  MeshValidator.validateMesh = valOK;
  try {
    await assert.rejects(PrintManager.exportOBJ(), err =>
      /could not verify/i.test(err.message) && err.validationErrors?.[0]?.meshName === 'm1');
    assert.equal(calls.downloads.length, 0);
  } finally {
    StateManager.setState(s => ({ ...s, print: { ...s.print, strictExport: false } }), { silent: true });
  }
});

await test('gate (strict): repair:false (unverified) blocks; non-strict still exports', async () => {
  setScene({ objects: { m1: obj('m1') }, registry: { m1: mesh('m1') } });
  MeshValidator.validateMesh = valOK;
  StateManager.setState(s => ({ ...s, print: { ...s.print, strictExport: true } }), { silent: true });
  try {
    await assert.rejects(PrintManager.exportOBJ({ repair: false }), /could not verify/i);
    assert.equal(calls.downloads.length, 0);
  } finally {
    StateManager.setState(s => ({ ...s, print: { ...s.print, strictExport: false } }), { silent: true });
  }
  await PrintManager.exportOBJ({ repair: false });
  assert.equal(calls.downloads.length, 1);
});

await test('OBJ: selectedOnly exports just the selected mesh', async () => {
  setScene({
    objects: { m1: obj('m1'), m2: obj('m2') },
    registry: { m1: mesh('m1'), m2: mesh('m2') }, selectedIds: ['m2'],
  });
  MeshValidator.validateMesh = valOK;
  await PrintManager.exportOBJ({ selectedOnly: true });
  assert.equal(objTexts().length, 1);
  assert.equal(objBlocks(objTexts()[0]), 1);
});

await test('OBJ: individually → one OBJ call per mesh', async () => {
  setScene({ objects: { m1: obj('m1'), m2: obj('m2') }, registry: { m1: mesh('m1'), m2: mesh('m2') } });
  MeshValidator.validateMesh = valOK;
  await PrintManager.exportOBJ({ individually: true });
  assert.equal(objTexts().length, 2);
});

await test('OBJ: all-meshes mode → single OBJ call with every mesh', async () => {
  setScene({ objects: { m1: obj('m1'), m2: obj('m2'), m3: obj('m3') },
    registry: { m1: mesh('m1'), m2: mesh('m2'), m3: mesh('m3') } });
  MeshValidator.validateMesh = valOK;
  await PrintManager.exportOBJ();
  assert.equal(objTexts().length, 1);
  assert.equal(objBlocks(objTexts()[0]), 3);
});

await test('OBJ: split logical object exports once in individual mode', async () => {
  setScene({
    objects: {
      partA: obj('partA', { name: 'Mug', sourceGroupId: 'sg_mug', logicalObjectId: 'partA' }),
      partB: obj('partB', { name: 'Mug__part1', sourceGroupId: 'sg_mug', logicalObjectId: 'partA', isInternalPart: true }),
    },
    registry: { partA: mesh('Mug'), partB: mesh('Mug__part1') },
  });
  MeshValidator.validateMesh = valOK;

  await PrintManager.exportOBJ({ individually: true });

  assert.equal(objTexts().length, 1, 'one OBJ entry for the logical Blender object');
  assert.equal(objBlocks(objTexts()[0]), 2, 'entry contains every internal material split');
  const files = zipInstances.at(-1).files;
  assert.ok(files['Test_Mug_r1to1.obj'], 'per-object OBJ uses the visible object name');
  assert.ok(!files['Test_Mug__part1_r1to1.obj'], 'internal split name must not leak as its own OBJ');
});

await test('export aborts when a mesh cannot be cloned — live mesh untouched (M10)', async () => {
  const m = mesh('m1');
  m.clone = () => null;                       // simulate Babylon clone failure
  setScene({ objects: { m1: obj('m1') }, registry: { m1: m } });
  MeshValidator.validateMesh = valOK;
  await rejects(PrintManager.exportOBJ(), /clone/i);
  assert.notEqual(m.__worldBaked, true, 'live mesh must not be flattened to mm');
  assert.notEqual(m.__disposed, true, 'live mesh must not be disposed by cleanup');
  assert.equal(calls.downloads.length, 0, 'nothing downloads');
});

await test('OBJ: never runs CSG2 (colour-safe — STL-only)', async () => {
  setScene({ objects: { m1: obj('m1') }, registry: { m1: mesh('m1') } });
  MeshValidator.validateMesh = valOK;
  await PrintManager.exportOBJ();
  assert.equal(calls.csgFrom.length, 0, 'no CSG2 on OBJ');
});

report(29, 'export: collection gating, auto-fix and the warning gate');
