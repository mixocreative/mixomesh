// Headless export-pipeline tests. Run:
//   node --import ./tests/register-hooks.mjs tests/export.test.mjs
//
// Drives the REAL PrintManager with stubbed Babylon / JSZip / DOM. Covers the
// post-auto-fix flow: collect → clone+auto-fix → validate fixed clones →
// only block if errors remain.

import assert from 'node:assert/strict';
import { installEnv, calls, resetCalls } from './env.mjs';
import { instances as zipInstances } from './jszip-stub.mjs';

installEnv();

const { StateManager } = await import('../src/core/StateManager.js');
const { AssetLoader }  = await import('../src/core/AssetLoader.js');
const { MeshValidator } = await import('../src/core/MeshValidator.js');
const { PrintManager } = await import('../src/core/PrintManager.js');
const MeshRepair = await import('../src/core/repair/MeshRepair.js');
const { t } = await import('../src/i18n/index.js');
const { Toast } = await import('../src/ui/Toast.js');
const toasts = [];
Toast.show = (msg, type) => { toasts.push({ msg, type }); };
Toast.dismiss = () => {};
console.error = () => {};

// ── Helpers ──────────────────────────────────────────────

function v(x = 0, y = 0, z = 0) {
  return { x, y, z, subtract: o => v(x - o.x, y - o.y, z - o.z) };
}

let _registry = {};
let _clones = [];
AssetLoader.getBabylonMesh = (id) => _registry[id] ?? null;

function mesh(name, { verts = 100, size = [10, 20, 30], color = null, origin = [0, 0, 0], side = 1 } = {}) {
  return {
    name,
    sideOrientation: side,   // 1 = CounterClockWise (Babylon default), 0 = ClockWise (glTF imports)
    material: color ? { id: 'mat-' + name, diffuseColor: color } : { id: 'mat-' + name },
    _verts: verts, _size: size, _color: color, _origin: origin,
    getTotalVertices() { return this._verts; },
    getVerticesData() { return new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]); },
    getIndices() { return [0, 1, 2]; },
    // MeshRepair.arraysToMesh write-back (repair prep step) — a real repair
    // that CHANGES geometry calls these; a fake mesh must observably record
    // it so tests can prove repair only touched the export clone.
    setVerticesData() { this.__repaired = true; },
    setIndices() { this.__repaired = true; },
    getBoundingInfo() {
      return { boundingBox: { minimumWorld: v(0, 0, 0), maximumWorld: v(this._size[0], this._size[1], this._size[2]) } };
    },
    parent: null,
    scaling: { x: 1, y: 1, z: 1, set() { return this; }, clone() { return { ...this, set: this.set, clone: this.clone, scaleInPlace: this.scaleInPlace }; }, scaleInPlace() { return this; } },
    position: { set() {} },
    rotation: { set() {} },
    rotationQuaternion: null,
    getScene() { return {}; },
    computeWorldMatrix() {},
    getWorldMatrix() { return window.BABYLON.Matrix.Translation(this._origin[0], this._origin[1], this._origin[2]); },
    bakeTransformIntoVertices(M) { this.__worldBaked = true; this.__bakedMatrix = M; },
    setParent() {},
    optimizeIndices() { this.__optimized = true; },
    createNormals() { this.__normals = true; },
    makeGeometryUnique() { this.__unique = true; },
    bakeCurrentTransformIntoVertices() { this.__baked = true; },
    refreshBoundingInfo() {},
    dispose() { this.__disposed = true; },
    clone(cloneName) {
      const c = mesh(cloneName || (name + '__c'), { verts, size, color, origin, side });
      c.material = this.material;
      c.__isClone = true;
      _clones.push(c);
      return c;
    },
  };
}

function setScene({ objects = {}, registry = {}, selectedIds = [], workingRatio = 1, targetRatio = 1 }) {
  _registry = registry;
  // Per-object ratio redesign (2026-06-16): export "scene ratio" is the ACTIVE
  // object's own `ratio`, and the print target is `print.exportTargets[0]`.
  // Mirror the legacy global workingRatio onto each object so the export
  // factor/suffix expectations hold under the new semantics.
  const objectsWithRatio = {};
  for (const [id, o] of Object.entries(objects)) {
    objectsWithRatio[id] = { ratio: workingRatio, ...o };
  }
  const activeId = selectedIds[0] ?? Object.keys(objectsWithRatio)[0] ?? null;
  StateManager.setState(s => ({
    ...s,
    project: { ...s.project, name: 'Test' },
    print: { ...s.print, exportTargets: [{ kind: 'ratio', value: targetRatio }] },
    selection: { ...s.selection, selectedIds, activeId },
    scene: { ...s.scene, objects: objectsWithRatio },
  }), { silent: true });
}

function obj(id, over = {}) {
  return {
    id, name: id, assetId: 'a1', collectionId: null, parentId: null,
    shaderId: null, visible: true, locked: false,
    isGhost: false, isUnlinked: false, isPrintPart: true, ...over,
  };
}

// OBJ is written by ObjWriter.encodeOBJ (no Babylon OBJExport since task
// 1.7): count the OBJ files / `o` blocks the export actually zipped.
const objTexts = () => zipInstances.flatMap(z => Object.entries(z.files))
  .filter(([n]) => n.endsWith('.obj')).map(([, d]) => String(d));
const objBlocks = (text) => (text.match(/^o /gm) || []).length;

const stlInfo = (bytes) => {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  return { bytes: u8.length, tris: view.getUint32(80, true), trisBE: view.getUint32(80, false) };
};

const valOK         = async () => [];
const valErrAlways  = async () => [{ severity: 'error', message: 'non-manifold' }];
const valWarnOnly   = async () => [{ severity: 'warning', message: 'thin wall' }];
// Error unless the auto-fix recomputed normals on the export clone — proves
// the "only report what survives the fix" rule.
const valErrUnlessFixed = async (m) => (m.__normals ? [] : [{ severity: 'error', message: 'inverted normals' }]);

// ── Tiny runner ──────────────────────────────────────────

let passed = 0, failed = 0;
const out = [];
async function test(name, fn) {
  resetCalls(); toasts.length = 0; _clones = []; zipInstances.length = 0;
  try { await fn(); out.push(`PASS  ${name}`); passed++; }
  catch (err) { out.push(`FAIL  ${name}\n      ${err.stack || err.message}`); failed++; }
}
const rejects = (p, re) => assert.rejects(p, re);

// ── Collection gating (pre-auto-fix) ─────────────────────

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

// ── Repair (export gate: watertight clones) ──────────────

// T6: fake engines return the FULL vendored diagnose contract
// ({boundary, nonManifold, components, isWatertight}) — a partial fake let
// the pipeline's C1 skip-check read `undefined === 0` and pass by accident.
const DIAG_OPEN   = { boundary: 3, nonManifold: 0, components: 1, isWatertight: false };
const DIAG_CLOSED = { boundary: 0, nonManifold: 0, components: 1, isWatertight: true };

/** Engine that reports an open mesh, then a closed one once repaired. */
function openThenFixedEngine({ onRepair } = {}) {
  let repaired = false;
  return {
    diagnose: () => (repaired ? { ...DIAG_CLOSED } : { ...DIAG_OPEN }),
    repairObject: async (V, T) => {
      repaired = true;
      onRepair?.();
      // Appending a triangle makes the output "changed" → forces write-back.
      return { V, T: [...T, [0, 1, 2]], report: { holesFilled: 1, nmFixed: 0, normalsFlipped: 0, merged: 0 } };
    },
  };
}

/** Engine whose repair leaves the mesh open (confirmed not watertight). */
function stillOpenEngine({ onRepair } = {}) {
  return {
    diagnose: () => ({ ...DIAG_OPEN }),
    repairObject: async (V, T) => { onRepair?.(); return { V, T, report: { holesFilled: 0, nmFixed: 0, merged: 0 } }; },
  };
}

// C1: MeshFixLib stage 1 merges duplicate positions — which is what a UV seam
// is made of — so running it on a part that is ALREADY closed could only cost
// texture fidelity. The pipeline must diagnose first and leave it alone.
await test('C1 repair: a clone that already diagnoses closed is SKIPPED, never rewritten', async () => {
  let repairCalls = 0, diagnoseCalls = 0;
  MeshRepair.__test.setEngine({
    diagnose: () => { diagnoseCalls++; return { ...DIAG_CLOSED }; },
    repairObject: async (V, T) => { repairCalls++; return { V, T, report: {} }; },
  });
  try {
    setScene({ objects: { m1: obj('m1') }, registry: { m1: mesh('m1') } });
    MeshValidator.validateMesh = valOK;
    await PrintManager.exportOBJ();
    assert.ok(diagnoseCalls >= 1, 'the clone WAS diagnosed');
    assert.equal(repairCalls, 0, 'a healthy clone is never handed to the repair engine');
    assert.equal(_clones[0].__repaired, undefined, 'clone geometry never rewritten — UVs cannot be touched');
    assert.equal(calls.downloads.length, 1, 'export still produced');
    assert.equal(toasts.filter(toast => toast.type === 'warning').length, 0,
      'a skipped healthy clone is not a warning');
  } finally {
    MeshRepair.__test.setEngine(null);
  }
});

await test('repair: runs on the export clone only — registry mesh untouched', async () => {
  MeshRepair.__test.setEngine(openThenFixedEngine());
  try {
    setScene({ objects: { m1: obj('m1') }, registry: { m1: mesh('m1') } });
    MeshValidator.validateMesh = valOK;
    await PrintManager.exportOBJ();
    assert.equal(_clones.length, 1);
    assert.match(_clones[0].name, /__export$/, 'repair ran on the export clone');
    assert.equal(_clones[0].__repaired, true, 'clone geometry rewritten by repair');
    assert.equal(_registry.m1.__repaired, undefined, 'live scene mesh untouched');
  } finally {
    MeshRepair.__test.setEngine(null);
  }
});

await test('repair: options.repair === false skips the step (engine never invoked)', async () => {
  let calledCount = 0;
  MeshRepair.__test.setEngine(openThenFixedEngine({ onRepair: () => { calledCount++; } }));
  try {
    setScene({ objects: { m1: obj('m1') }, registry: { m1: mesh('m1') } });
    MeshValidator.validateMesh = valOK;
    await PrintManager.exportOBJ({ repair: false });
    assert.equal(calledCount, 0, 'repair engine never invoked when repair:false');
    assert.ok(!toasts.some(t => /repair/i.test(t.msg)), 'no repair-related toast when explicitly disabled');
  } finally {
    MeshRepair.__test.setEngine(null);
  }
});

await test('repair: engine unavailable → one warning toast, never throws, still exports', async () => {
  MeshRepair.__test.setEngine(null);
  setScene({ objects: { m1: obj('m1') }, registry: { m1: mesh('m1') } });
  MeshValidator.validateMesh = valOK;
  await PrintManager.exportOBJ();
  assert.equal(calls.downloads.length, 1, 'export still produced');
  const repairToasts = toasts.filter(t => t.type === 'warning' && /repair/i.test(t.msg));
  assert.equal(repairToasts.length, 1, 'exactly one repair-unavailable warning for the whole batch');
});

await test('repair: strictExport true + still-not-watertight after repair → rejects listing the part, nothing downloaded', async () => {
  MeshRepair.__test.setEngine(stillOpenEngine());
  try {
    setScene({ objects: { m1: obj('m1') }, registry: { m1: mesh('m1') } });
    StateManager.setState(s => ({ ...s, print: { ...s.print, strictExport: true } }), { silent: true });
    MeshValidator.validateMesh = valOK;
    await assert.rejects(PrintManager.exportOBJ(), /not watertight/i);
    assert.equal(calls.downloads.length, 0, 'nothing downloaded');
  } finally {
    MeshRepair.__test.setEngine(null);
    StateManager.setState(s => ({ ...s, print: { ...s.print, strictExport: false } }), { silent: true });
  }
});

await test('repair: strictExport false + still-not-watertight after repair → exports, warning toast names the part', async () => {
  MeshRepair.__test.setEngine(stillOpenEngine());
  try {
    setScene({ objects: { m1: obj('m1') }, registry: { m1: mesh('m1') } });
    MeshValidator.validateMesh = valOK;
    await PrintManager.exportOBJ();
    assert.equal(calls.downloads.length, 1, 'export still produced');
    assert.ok(toasts.some(t => t.type === 'warning' && /m1/.test(t.msg)), 'warning toast mentions the part');
  } finally {
    MeshRepair.__test.setEngine(null);
  }
});

await test('repair: non-strict export with a confirmed not-watertight clone → exactly ONE warning toast, matching toast.exportedWithWarnings', async () => {
  MeshRepair.__test.setEngine(stillOpenEngine());
  try {
    setScene({ objects: { m1: obj('m1') }, registry: { m1: mesh('m1') } });
    MeshValidator.validateMesh = valOK;
    await PrintManager.exportOBJ();
    const warningToasts = toasts.filter(toast => toast.type === 'warning');
    assert.equal(warningToasts.length, 1, 'exactly one warning toast for the whole export (no duplicate from the panel — there is no panel here — and none doubled by the pipeline itself)');
    assert.equal(warningToasts[0].msg, t('toast.exportedWithWarnings', { names: 'm1__export' }),
      'message text matches toast.exportedWithWarnings');
  } finally {
    MeshRepair.__test.setEngine(null);
  }
});

await test('repair: a repair write-back never re-tags the side flag; registry mesh untouched', async () => {
  // CSG2 disabled so only the repair step's own winding rule (repairMesh
  // _conformWinding: flag kept, INDICES reversed when the geometry disagrees)
  // is exercised — not CSG's _csgRebake re-tag. A ClockWise glTF clone must
  // come out of a repair still ClockWise (the old CounterClockWise re-tag
  // shipped repaired glTF parts inside-out — measured 2026-09-18).
  const B = globalThis.window.BABYLON;
  const savedCSG = B.CSG2, savedInit = B.InitializeCSG2Async;
  B.CSG2 = undefined; B.InitializeCSG2Async = undefined;
  MeshRepair.__test.setEngine(openThenFixedEngine());
  try {
    setScene({ objects: { m1: obj('m1') }, registry: { m1: mesh('m1', { side: 0 }) } });
    MeshValidator.validateMesh = valOK;
    await PrintManager.exportOBJ();
    assert.equal(_clones[0].sideOrientation, 0, 'repaired clone keeps its ClockWise flag');
    assert.equal(_registry.m1.sideOrientation, 0, 'live scene mesh keeps its original ClockWise flag');
    assert.ok(_clones[0].__repaired, 'repair wrote back to the clone');
    assert.ok(!_registry.m1.__repaired, 'repair never wrote to the live mesh');
  } finally {
    MeshRepair.__test.setEngine(null);
    B.CSG2 = savedCSG; B.InitializeCSG2Async = savedInit;
  }
});

await test('F10 repair: after a CSG re-bake the verdict describes the SHIPPED geometry', async () => {
  // The repair step leaves this clone open, so the pre-CSG verdict is
  // "not watertight". CSG2 then re-bakes it (Manifold output is watertight by
  // construction) — the pipeline must RE-DIAGNOSE the re-baked clone, so
  // strict mode does not block and no not-watertight warning fires.
  const B = globalThis.window.BABYLON;
  const realFromMesh = B.CSG2.FromMesh;
  let csgDone = false;
  B.CSG2.FromMesh = (m) => { csgDone = true; return realFromMesh(m); };
  MeshRepair.__test.setEngine({
    diagnose: () => (csgDone ? { ...DIAG_CLOSED } : { ...DIAG_OPEN }),
    repairObject: async (V, T) => ({ V, T, report: { holesFilled: 0 } }),   // still open
  });
  try {
    setScene({ objects: { m1: obj('m1') }, registry: { m1: mesh('m1') } });
    StateManager.setState(s => ({ ...s, print: { ...s.print, strictExport: true } }), { silent: true });
    MeshValidator.validateMesh = valOK;
    await PrintManager.exportSTL();
    assert.equal(calls.csgFrom.length, 1, 'the CSG re-bake ran');
    assert.equal(calls.downloads.length, 1, 'strict mode did NOT block: the shipped geometry is watertight');
    assert.equal(toasts.filter(toast => toast.type === 'warning').length, 0,
      'no stale "not watertight" warning from the pre-CSG verdict');
  } finally {
    MeshRepair.__test.setEngine(null);
    B.CSG2.FromMesh = realFromMesh;
    StateManager.setState(s => ({ ...s, print: { ...s.print, strictExport: false } }), { silent: true });
  }
});

// ── STL ──────────────────────────────────────────────────

await test('STL: CSG2 unavailable → exports without re-bake, warns', async () => {
  const B = globalThis.window.BABYLON;
  const savedCSG = B.CSG2, savedInit = B.InitializeCSG2Async;
  B.CSG2 = undefined; B.InitializeCSG2Async = undefined;
  try {
    setScene({ objects: { m1: obj('m1') }, registry: { m1: mesh('m1') } });
    MeshValidator.validateMesh = valOK;
    await PrintManager.exportSTL();
    assert.equal(calls.downloads.length, 1, 'STL still produced');
    assert.equal(calls.csgFrom.length, 0, 'no CSG2 re-bake');
    assert.ok(toasts.some(t => t.type === 'warning' && /CSG2 unavailable/.test(t.msg)), 'warned');
  } finally {
    B.CSG2 = savedCSG; B.InitializeCSG2Async = savedInit;
  }
});

await test('STL: CSG2 available → re-bakes every mesh then exports', async () => {
  setScene({ objects: { m1: obj('m1'), m2: obj('m2') }, registry: { m1: mesh('m1'), m2: mesh('m2') } });
  MeshValidator.validateMesh = valOK;
  await PrintManager.exportSTL();
  assert.equal(calls.csgFrom.length, 2, 'CSG2 re-bake per mesh');
  assert.equal(calls.vdApply.length, 2, 'baked geometry applied back');
  assert.equal(calls.downloads.length, 1, 'one combined STL');
  assert.ok(_clones.every(c => c.__optimized && c.__normals), 'optimize + normals on clones');
});

await test('STL: non-watertight mesh (CSG2 rejects) → skips quietly, still exports + info toast', async () => {
  const B = globalThis.window.BABYLON;
  const savedFrom = B.CSG2.FromMesh;
  B.CSG2.FromMesh = () => { throw new Error('Error while creating the CSG: Not manifold'); };
  try {
    setScene({ objects: { m1: obj('m1'), m2: obj('m2') },
      registry: { m1: mesh('m1'), m2: mesh('m2') } });
    MeshValidator.validateMesh = valOK;
    await PrintManager.exportSTL();                 // must NOT throw
    assert.equal(calls.downloads.length, 1, 'export still produced');
    assert.ok(toasts.some(t => t.type === 'info' && /not watertight/.test(t.msg)),
      'one summarized info toast');
  } finally {
    B.CSG2.FromMesh = savedFrom;
  }
});

await test('STL: empty scene → throws', async () => {
  setScene({});
  MeshValidator.validateMesh = valOK;
  await rejects(PrintManager.exportSTL(), /No printable meshes/);
});

await test('STL: error surviving auto-fix → blocks with list', async () => {
  setScene({ objects: { m1: obj('m1') }, registry: { m1: mesh('m1') } });
  MeshValidator.validateMesh = valErrAlways;
  await assert.rejects(PrintManager.exportSTL(), (err) => {
    assert.ok(err.validationErrors?.length === 1);
    return true;
  });
  assert.equal(calls.downloads.length, 0);
});

await test('STL: individually → one STL call per mesh + outer zip of N parts', async () => {
  setScene({ objects: { m1: obj('m1'), m2: obj('m2'), m3: obj('m3') },
    registry: { m1: mesh('m1'), m2: mesh('m2'), m3: mesh('m3') } });
  MeshValidator.validateMesh = valOK;
  await PrintManager.exportSTL({ individually: true });
  // Outer zip contains the three .stl entries named `${project}_${mesh}_r{w}to{t}.stl`,
  // each a real little-endian binary STL (StlWriter, not the Babylon serializer).
  const outer = zipInstances.at(-1).files;
  assert.ok(outer['Test_m1_r1to1.stl'], 'project+mesh+ratio in name');
  assert.ok(outer['Test_m2_r1to1.stl']);
  assert.ok(outer['Test_m3_r1to1.stl']);
  for (const key of ['Test_m1_r1to1.stl', 'Test_m2_r1to1.stl', 'Test_m3_r1to1.stl']) {
    const info = stlInfo(outer[key]);
    assert.equal(info.tris, 1, `${key}: one triangle, little-endian count`);
    assert.notEqual(info.trisBE, 1, `${key}: count is NOT big-endian (regression: Babylon CreateSTL isLittleEndian=false)`);
    assert.equal(info.bytes, 84 + 50, `${key}: 80-byte header + count + 50 bytes/facet`);
  }
  assert.equal(calls.downloads.at(-1), 'Test_r1to1.zip',
    'outer zip uses project+ratio default filename');
});

await test('STL: individually + selectedOnly → only selected mesh in outer zip', async () => {
  setScene({ objects: { m1: obj('m1'), m2: obj('m2') },
    registry: { m1: mesh('m1'), m2: mesh('m2') }, selectedIds: ['m2'] });
  MeshValidator.validateMesh = valOK;
  await PrintManager.exportSTL({ individually: true, selectedOnly: true });
  assert.equal(Object.keys(zipInstances.at(-1).files).length, 1, 'only the selected mesh exported');
  const outer = zipInstances.at(-1).files;
  assert.ok(outer['Test_m2_r1to1.stl']);
  assert.ok(!outer['Test_m1_r1to1.stl'], 'unselected mesh excluded');
});

// ── 3MF ──────────────────────────────────────────────────

await test('3MF: empty scene → throws', async () => {
  setScene({});
  MeshValidator.validateMesh = valOK;
  await rejects(PrintManager.exportThreeMF(), /No printable meshes/);
});

await test('prep step throws → export ABORTS (no raw-BU file with a success toast)', async () => {
  const m = mesh('m1');
  const origClone = m.clone;
  m.clone = (...a) => {
    const c = origClone.apply(m, a);
    c.optimizeIndices = () => { throw new Error('buffer not updatable'); };
    return c;
  };
  setScene({ objects: { m1: obj('m1') }, registry: { m1: m } });
  MeshValidator.validateMesh = valOK;
  await rejects(PrintManager.exportOBJ(), /Export prep "optimizeIndices" failed for "m1__export"/);
  assert.equal(calls.downloads.length, 0, 'nothing downloaded');
  assert.ok(!toasts.some(t => t.type === 'success'), 'no success toast');
  assert.equal(_clones[0].__disposed, true, 'clone disposed after abort');
});

await test('save picker cancelled → "cancelled" info toast, NO success toast, batch stops', async () => {
  setScene({ objects: { m1: obj('m1') }, registry: { m1: mesh('m1') } });
  StateManager.setState(s => ({ ...s, print: { ...s.print, exportTargets: [{ kind: 'ratio', value: 1 }, { kind: 'ratio', value: 2 }] } }), { silent: true });
  MeshValidator.validateMesh = valOK;
  let pickerCalls = 0;
  window.showSaveFilePicker = async () => { pickerCalls++; throw Object.assign(new Error('cancel'), { name: 'AbortError' }); };
  try {
    await PrintManager.exportOBJ();
  } finally {
    window.showSaveFilePicker = undefined;
  }
  assert.equal(pickerCalls, 1, 'second ratio target not re-prompted after a cancel');
  assert.equal(calls.downloads.length, 0, 'no anchor fallback on cancel');
  assert.ok(!toasts.some(t => t.type === 'success'), 'cancel must not read as "✓ Exported"');
  assert.ok(toasts.some(t => t.type === 'info' && /cancel/i.test(t.msg)), 'cancel is surfaced');
});

await test('zip entries whose paths collide (case-insensitive) are suffixed, never overwritten', async () => {
  setScene({ objects: { a: obj('a', { name: 'Cube' }), b: obj('b', { name: 'cube' }) },
    registry: { a: mesh('Cube'), b: mesh('cube') } });
  MeshValidator.validateMesh = valOK;
  await PrintManager.exportOBJ({ individually: true });
  const files = zipInstances.at(-1).files;
  assert.ok(files['Test_Cube_r1to1.obj'] && files['Test_Cube_r1to1.mtl'], 'first part kept');
  assert.ok(files['Test_cube_r1to1_2.obj'] && files['Test_cube_r1to1_2.mtl'], 'second part suffixed, not dropped');
  assert.equal(Object.keys(files).length, 4, 'both parts present');
});


await test('OBJ/MTL: material ids with spaces become single tokens in BOTH files; no Tr line; Kd clamped', async () => {
  const m = mesh('m1', { color: { r: 1.5, g: -0.2, b: 0.5 } });
  m.material = { id: 'Base Color 01', diffuseColor: { r: 1.5, g: -0.2, b: 0.5 } };
  setScene({ objects: { m1: obj('m1') }, registry: { m1: m } });
  MeshValidator.validateMesh = valOK;
  await PrintManager.exportOBJ();
  const files = zipInstances.at(-1).files;
  assert.match(files['Test_r1to1.obj'], /^usemtl Base_Color_01$/m, 'usemtl is one token');
  assert.match(files['Test_r1to1.mtl'], /^newmtl Base_Color_01$/m, 'newmtl matches usemtl');
  assert.match(files['Test_r1to1.mtl'], /^Kd 1\.0000 0\.0000 0\.5000$/m, 'Kd clamped to [0,1]');
  assert.match(files['Test_r1to1.mtl'], /^d 1\.0000$/m);
  assert.ok(!/^Tr /m.test(files['Test_r1to1.mtl']), 'no ambiguous Tr line');
});


await test('prep leaves a part with zero triangles → export ABORTS (M4), not a silent drop', async () => {
  const m = mesh('m1');
  const origClone = m.clone;
  m.clone = (...a) => { const c = origClone.apply(m, a); c.getIndices = () => []; return c; };
  setScene({ objects: { m1: obj('m1') }, registry: { m1: m } });
  MeshValidator.validateMesh = valOK;
  await rejects(PrintManager.exportOBJ(), /Part "m1" has no triangles after preparation/);
  assert.equal(calls.downloads.length, 0);
});

await test('readiness: missing or stale validation cache → validation-pending warning (M3), fresh cache → none', async () => {
  setScene({ objects: { m1: obj('m1') }, registry: { m1: mesh('m1') } });
  let r = PrintManager.getPrintReadiness();
  assert.ok(r.issues.some(i => i.code === 'validation-pending'), 'no cache = pending');
  StateManager.setState(s => ({ ...s, scene: { ...s.scene, validation: { m1: { results: [], stale: true, validatedAt: 1 } } } }), { silent: true });
  r = PrintManager.getPrintReadiness();
  assert.ok(r.issues.some(i => i.code === 'validation-pending'), 'stale cache = pending');
  StateManager.setState(s => ({ ...s, scene: { ...s.scene, validation: { m1: { results: [], stale: false, validatedAt: 1 } } } }), { silent: true });
  r = PrintManager.getPrintReadiness();
  assert.ok(!r.issues.some(i => i.code === 'validation-pending'), 'fresh cache = not pending');
  assert.equal(r.canExport, true, 'pending is a warning, not a block');
});

await test('batch export uses ONE state snapshot (M8): a rename between pickers does not change file 2', async () => {
  setScene({ objects: { m1: obj('m1') }, registry: { m1: mesh('m1') } });
  StateManager.setState(s => ({ ...s, print: { ...s.print, exportTargets: [{ kind: 'ratio', value: 1 }, { kind: 'ratio', value: 2 }] } }), { silent: true });
  MeshValidator.validateMesh = valOK;
  let n = 0;
  window.showSaveFilePicker = async () => {
    n++;
    if (n === 1) StateManager.setState(s => ({ ...s, project: { ...s.project, name: 'Renamed' } }), { silent: true });
    return { createWritable: async () => ({ write: async () => {}, close: async () => {} }) };
  };
  const names = [];
  const origShow = Toast.show;
  Toast.show = (msg, type) => { toasts.push({ msg, type }); if (type === 'success') names.push(msg); };
  try { await PrintManager.exportOBJ(); } finally { window.showSaveFilePicker = undefined; Toast.show = origShow; }
  assert.equal(names.length, 2, 'two files written');
  assert.ok(names.every(m => /Test_/.test(m) && !/Renamed/.test(m)), `both files keep the snapshot name: ${names.join(' | ')}`);
});

await test('3MF: valid mesh → OPC package with model XML + colour, downloads', async () => {
  setScene({ objects: { m1: obj('m1') },
    registry: { m1: mesh('m1', { color: { r: 1, g: 0, b: 0 } }) } });
  MeshValidator.validateMesh = valOK;
  await PrintManager.exportThreeMF();

  assert.equal(calls.downloads.length, 1, 'download triggered');
  assert.equal(calls.csgFrom.length, 1, 'solid-colour 3MF re-baked watertight');
  assert.equal(_clones[0].__worldBaked, true, 'full world matrix baked into vertices');
  assert.equal(_clones[0].__unique, true, 'geometry made unique');

  const files = zipInstances.at(-1).files;
  assert.ok(files['[Content_Types].xml'], 'has [Content_Types].xml');
  assert.ok(files['_rels/.rels'], 'has _rels/.rels');
  const model = files['3D/3dmodel.model'];
  assert.ok(model, 'has 3D/3dmodel.model');
  assert.match(model, /unit="millimeter"/);
  assert.match(model, /x="-0\.5"/, 'build centred on origin');
  assert.match(model, /<m:colorgroup id="1">/);
  assert.match(model, /<m:color color="#FF0000FF"\/>/);
  assert.match(model, /<object id="2" type="model" pid="1" pindex="0">/);
  assert.match(model, /<vertex /);
  // CounterClockWise-flagged (default) mesh: PrintSpace keeps the buffer
  // order — the reflection in toPrintSpace already makes it outward for the
  // right-handed 3MF reader. (A ClockWise-flagged glTF mesh is reversed; see
  // the dedicated test below and tests/print-space.test.mjs.)
  assert.match(model, /<triangle v1="0" v2="1" v3="2"\/>/, 'CounterClockWise mesh written as-is');
  assert.match(model, /<build><item objectid="2" transform="1 0 0 0 1 0 0 0 1 0 0 0"\/><\/build>/,
    'build item carries explicit identity — placement is fully baked');
});

await test('3MF: ClockWise-flagged (glTF-imported) mesh → triangle reversed so the right-handed reader sees it outward', async () => {
  // CSG2 off: the CSG re-bake replaces geometry with Babylon-native winding
  // and resets the flag (covered by the next test); without it the clone
  // keeps the glTF loader's ClockWise flag and must be reversed on write.
  const B = globalThis.window.BABYLON;
  const savedCSG = B.CSG2, savedInit = B.InitializeCSG2Async;
  B.CSG2 = undefined; B.InitializeCSG2Async = undefined;
  try {
    setScene({ objects: { m1: obj('m1') },
      registry: { m1: mesh('m1', { color: { r: 1, g: 0, b: 0 }, side: 0 }) } });
    MeshValidator.validateMesh = valOK;
    await PrintManager.exportThreeMF();
  } finally {
    B.CSG2 = savedCSG; B.InitializeCSG2Async = savedInit;
  }
  assert.equal(_clones[0].sideOrientation, 0, 'clone carries the ClockWise flag');
  const model = zipInstances.at(-1).files['3D/3dmodel.model'];
  assert.match(model, /<triangle v1="0" v2="2" v3="1"\/>/, 'ClockWise mesh reversed (PrintSpace.printIndices)');
  // Axis map: Babylon (1,0,0) → 3MF (-1,0,0); Babylon (0,1,0) (up) → 3MF (0,0,1) (up).
  // Then centred in X/Y (cx = -0.5) and rested on the bed (min z → 0).
  assert.match(model, /<vertex x="0\.5" y="0" z="0"\/>/);
  assert.match(model, /<vertex x="-0\.5" y="0" z="0"\/>/, 'Babylon +X lands on 3MF -X (glTF reflection undone)');
  assert.match(model, /<vertex x="0\.5" y="0" z="1"\/>/, 'Babylon +Y lands on 3MF +Z (up stays up), build rests on z=0');
});

await test('3MF: CSG re-bake resets a ClockWise clone to CounterClockWise (Manifold output is native winding)', async () => {
  setScene({ objects: { m1: obj('m1') },
    registry: { m1: mesh('m1', { color: { r: 1, g: 0, b: 0 }, side: 0 }) } });
  MeshValidator.validateMesh = valOK;
  await PrintManager.exportThreeMF();
  assert.equal(calls.csgFrom.length, 1, 'CSG re-bake ran');
  assert.equal(_clones[0].sideOrientation, 1, 'flag reset after CSG output replaced the geometry');
  const model = zipInstances.at(-1).files['3D/3dmodel.model'];
  assert.match(model, /<triangle v1="0" v2="1" v3="2"\/>/, 'fresh CSG geometry written as-is');
});

await test('3MF: distinct colours → one colorgroup entry each', async () => {
  setScene({
    objects: { m1: obj('m1'), m2: obj('m2') },
    registry: {
      m1: mesh('m1', { color: { r: 1, g: 0, b: 0 } }),
      m2: mesh('m2', { color: { r: 0, g: 0, b: 1 } }),
    },
  });
  MeshValidator.validateMesh = valOK;
  await PrintManager.exportThreeMF();
  const model = zipInstances.at(-1).files['3D/3dmodel.model'];
  assert.match(model, /#FF0000FF/);
  assert.match(model, /#0000FFFF/);
  assert.match(model, /pindex="0"/);
  assert.match(model, /pindex="1"/);
  assert.match(model, /objectid="2"/);
  assert.match(model, /objectid="3"/);
});

await test('3MF: split logical object writes one build item with per-triangle colours', async () => {
  setScene({
    objects: {
      partA: obj('partA', { name: 'Mug', sourceGroupId: 'sg_mug', logicalObjectId: 'partA' }),
      partB: obj('partB', { name: 'Mug__part1', sourceGroupId: 'sg_mug', logicalObjectId: 'partA', isInternalPart: true }),
    },
    registry: {
      partA: mesh('Mug', { color: { r: 1, g: 0, b: 0 } }),
      partB: mesh('Mug__part1', { color: { r: 0, g: 0, b: 1 } }),
    },
  });
  MeshValidator.validateMesh = valOK;

  await PrintManager.exportThreeMF();

  const model = zipInstances.at(-1).files['3D/3dmodel.model'];
  assert.equal((model.match(/<object id="/g) ?? []).length, 1, 'one 3MF object for the logical Blender object');
  assert.equal((model.match(/<item objectid="/g) ?? []).length, 1, 'one build item for the logical Blender object');
  assert.match(model, /<triangle[^>]+pid="1"[^>]+p1="0"[^>]+p2="0"[^>]+p3="0"/);
  assert.match(model, /<triangle[^>]+pid="1"[^>]+p1="1"[^>]+p2="1"[^>]+p3="1"/);
});

await test('3MF: no-material mesh → fallback colour, still valid package', async () => {
  setScene({ objects: { m1: obj('m1') }, registry: { m1: mesh('m1') } });
  MeshValidator.validateMesh = valOK;
  await PrintManager.exportThreeMF();
  const model = zipInstances.at(-1).files['3D/3dmodel.model'];
  assert.match(model, /<m:color color="#[0-9A-F]{8}"\/>/);
  assert.equal(calls.downloads.length, 1);
});

await test('3MF: textured mesh skips CSG2 (preserves UVs), solid mesh re-bakes', async () => {
  const textured = mesh('tex', { color: { r: 0, g: 1, b: 0 } });
  // Readable texture stub: texture failures now ABORT the export (fail closed).
  textured.material = { id: 'm', diffuseColor: { r: 0, g: 1, b: 0 }, diffuseTexture: {
    name: 't', getBaseSize() { return { width: 1, height: 1 }; },
    readPixels() { return new Uint8Array([0, 255, 0, 255]); },
  } };
  const uvData = (kind) => (kind === 'uv' ? new Float32Array([0, 0, 1, 0, 0, 1]) : new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]));
  textured.getVerticesData = uvData;
  const origClone = textured.clone;
  textured.clone = (n) => { const c = origClone.call(textured, n); c.material = textured.material; c.getVerticesData = uvData; return c; };
  setScene({
    objects: { t: obj('t'), s: obj('s') },
    registry: { t: textured, s: mesh('s', { color: { r: 0, g: 0, b: 1 } }) },
  });
  MeshValidator.validateMesh = valOK;
  await PrintManager.exportThreeMF();
  assert.equal(calls.csgFrom.length, 1, 'only the solid-colour mesh re-baked');
});

await test('3MF: error surviving auto-fix → blocks with list, no download', async () => {
  setScene({ objects: { m1: obj('m1') }, registry: { m1: mesh('m1') } });
  MeshValidator.validateMesh = valErrAlways;
  await assert.rejects(PrintManager.exportThreeMF(), (e) => e.validationErrors?.length === 1);
  assert.equal(calls.downloads.length, 0);
});

await test('3MF colorgroup: individually → one inner 3MF zip per mesh in outer zip', async () => {
  setScene({ objects: { m1: obj('m1'), m2: obj('m2') },
    registry: { m1: mesh('m1', { color: { r: 1, g: 0, b: 0 } }),
                m2: mesh('m2', { color: { r: 0, g: 0, b: 1 } }) } });
  MeshValidator.validateMesh = valOK;
  await PrintManager.exportThreeMF({ individually: true });
  // 2 inner zips (one per mesh) + 1 outer zip
  assert.equal(zipInstances.length, 3, '2 inner + 1 outer JSZip instances');
  const outer = zipInstances.at(-1).files;
  assert.ok(outer['Test_m1_r1to1.3mf'], 'project+mesh+ratio in inner 3MF name');
  assert.ok(outer['Test_m2_r1to1.3mf']);
  // Each inner zip has the full OPC skeleton for ONE object
  for (const inner of zipInstances.slice(0, 2)) {
    assert.ok(inner.files['[Content_Types].xml']);
    assert.ok(inner.files['_rels/.rels']);
    const model = inner.files['3D/3dmodel.model'];
    assert.ok(model);
    // exactly one <object> per inner 3MF
    assert.equal((model.match(/<object /g) || []).length, 1, 'one object per inner 3MF');
  }
});

await test('3MF individually: every inner 3MF carries metadata + the one batch thumbnail (captured once)', async () => {
  setScene({ objects: { m1: obj('m1'), m2: obj('m2') },
    registry: { m1: mesh('m1', { color: { r: 1, g: 0, b: 0 } }),
                m2: mesh('m2', { color: { r: 0, g: 0, b: 1 } }) } });
  MeshValidator.validateMesh = valOK;
  const png = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 7]);
  let captures = 0;
  await PrintManager.exportThreeMF({ individually: true, captureThumbnail: async () => { captures++; return png; } });
  assert.equal(captures, 1, 'one viewport capture per export batch');
  for (const inner of zipInstances.slice(0, 2)) {
    assert.equal(inner.files['Metadata/thumbnail.png'], png);
    assert.match(inner.files['_rels/.rels'], /relationships\/metadata\/thumbnail/);
    assert.match(inner.files['3D/3dmodel.model'], /<metadata name="Title">Test<\/metadata><metadata name="Application">MIXOMESH<\/metadata>/);
  }
});

await test('3MF: thumbnail capture is never attempted for non-3MF formats', async () => {
  setScene({ objects: { m1: obj('m1') }, registry: { m1: mesh('m1') } });
  MeshValidator.validateMesh = valOK;
  let captures = 0;
  await PrintManager.exportSTL({ captureThumbnail: async () => { captures++; return null; } });
  assert.equal(captures, 0);
});

await test('3MF materials-ext: individually → per-mesh 3MF carries only its own texture', async () => {
  const tex = { name: 'paint', getBaseSize: () => ({ width: 2, height: 2 }), readPixels: () => new Uint8Array(16) };
  const mt1 = mesh('mt1');
  mt1.material = { id: 'mat1', diffuseColor: { r: 1, g: 1, b: 1 }, diffuseTexture: tex };
  mt1.getVerticesData = (k) => k === 'uv' ? new Float32Array([0,0, 1,0, 0,1]) : new Float32Array([0,0,0, 1,0,0, 0,1,0]);
  const c1 = mt1.clone; mt1.clone = (n) => { const c = c1.call(mt1, n); c.material = mt1.material; c.getVerticesData = mt1.getVerticesData; return c; };
  const ms2 = mesh('ms2', { color: { r: 0, g: 1, b: 0 } });
  setScene({ objects: { mt1: obj('mt1'), ms2: obj('ms2') }, registry: { mt1, ms2 } });
  MeshValidator.validateMesh = valOK;
  await PrintManager.exportThreeMF({ individually: true });
  // 2 inner + 1 outer
  assert.equal(zipInstances.length, 3);
  const outer = zipInstances.at(-1).files;
  assert.ok(outer['Test_mt1_r1to1.3mf']);
  assert.ok(outer['Test_ms2_r1to1.3mf']);
  // Inner zip for the textured mesh has a PNG + rels; solid mesh has neither.
  const innerTex = zipInstances[0].files;
  const innerSol = zipInstances[1].files;
  assert.ok(Object.keys(innerTex).some(k => k.startsWith('3D/Textures/')), 'textured part embeds its PNG');
  assert.ok(innerTex['3D/_rels/3dmodel.model.rels'], 'textured part has texture rels');
  assert.ok(!Object.keys(innerSol).some(k => k.startsWith('3D/Textures/')), 'solid part has no PNG');
});

// ── Filename pattern (project + ratio suffix) ────────────
//
// Every export filename follows the same recipe (BLUEPRINT §12 PrintManager
// export filenames): combined → `${project}${suffix}.${ext}`, individually
// → outer zip `${project}${suffix}.zip` with inner entries
// `${project}_${mesh}${suffix}.${ext}`. Suffix is always present, even
// at 1:1, so a renamed file's scale is never ambiguous.

await test('filename: combined OBJ → `${project}${suffix}.zip` is the save default', async () => {
  setScene({ objects: { m1: obj('m1') }, registry: { m1: mesh('m1') } });
  MeshValidator.validateMesh = valOK;
  await PrintManager.exportOBJ();
  assert.equal(calls.downloads.at(-1), 'Test_r1to1.zip',
    'save default = project + ratio suffix even at 1:1');
});

await test('filename: combined OBJ at 1:144 → suffix `_r1to144`', async () => {
  setScene({ objects: { m1: obj('m1') }, registry: { m1: mesh('m1') },
    workingRatio: 1, targetRatio: 144 });
  MeshValidator.validateMesh = valOK;
  await PrintManager.exportOBJ();
  assert.equal(calls.downloads.at(-1), 'Test_r1to144.zip');
});

await test('filename: combined STL → `${project}${suffix}.stl` (single-blob path)', async () => {
  setScene({ objects: { m1: obj('m1') }, registry: { m1: mesh('m1') },
    workingRatio: 12, targetRatio: 35 });
  MeshValidator.validateMesh = valOK;
  await PrintManager.exportSTL();
  assert.equal(calls.downloads.length, 1, 'STL combined goes through packageAndDownload');
  // Export reference = active object's ratio (12 here) → target 35:
  // suffix _r{activeRatio}to{target}.
  assert.equal(calls.downloads.at(-1), 'Test_r12to35.stl');
});

await test('filename: combined 3MF solid-only → `${project}${suffix}.3mf`', async () => {
  setScene({ objects: { m1: obj('m1') }, registry: { m1: mesh('m1', { color: { r: 1, g: 0, b: 0 } }) },
    workingRatio: 1, targetRatio: 144 });
  MeshValidator.validateMesh = valOK;
  await PrintManager.exportThreeMF();
  assert.equal(calls.downloads.at(-1), 'Test_r1to144.3mf');
});

await test('filename: combined 3MF default ratio → `${project}${suffix}.3mf`', async () => {
  setScene({ objects: { m1: obj('m1') }, registry: { m1: mesh('m1', { color: { r: 1, g: 0, b: 0 } }) },
    workingRatio: 1, targetRatio: 1 });
  MeshValidator.validateMesh = valOK;
  await PrintManager.exportThreeMF();
  assert.equal(calls.downloads.at(-1), 'Test_r1to1.3mf');
});

await test('as-shown: empty exportTargets prints at the active object ratio (displayed size)', async () => {
  setScene({ objects: { m1: obj('m1') }, registry: { m1: mesh('m1', { size: [2, 2, 2] }) },
    workingRatio: 72, targetRatio: 72 });
  // Empty list ⇒ "as shown" ⇒ target = active object's ratio (72) ⇒ factor 1000.
  StateManager.setState(s => ({ ...s, print: { ...s.print, exportTargets: [] } }), { silent: true });
  const d = PrintManager.getExportedDimensions('m1');
  assert.ok(Math.abs(d.x - 2000) < 1e-6, `as-shown should be size×1000 (displayed mm), got ${d.x}`);
  MeshValidator.validateMesh = valOK;
  await PrintManager.exportOBJ();
  assert.equal(calls.downloads.at(-1), 'Test_r72to72.zip', `as-shown suffix should be _r72to72, got ${calls.downloads.at(-1)}`);
});

await test('batch: exportTargets list emits one file per target ratio', async () => {
  setScene({ objects: { m1: obj('m1') }, registry: { m1: mesh('m1') },
    workingRatio: 72, targetRatio: 72 });
  // Two export targets; active object ratio is 72.
  StateManager.setState(s => ({ ...s, print: { ...s.print, exportTargets: [{ kind: 'ratio', value: 72 }, { kind: 'ratio', value: 144 }] } }), { silent: true });
  MeshValidator.validateMesh = valOK;
  await PrintManager.exportOBJ();
  assert.ok(calls.downloads.includes('Test_r72to72.zip'), `missing 1:72 file, got ${calls.downloads.join()}`);
  assert.ok(calls.downloads.includes('Test_r72to144.zip'), `missing 1:144 file, got ${calls.downloads.join()}`);
  assert.equal(calls.downloads.filter(f => f.endsWith('.zip')).length, 2, 'exactly two zip outputs');
});

// ── Typed print sizes (task 1.17 / Decision 27) ─────────

await test('typed targets: ratio 144 / ×2 / 120 mm on a 60 mm-tall 1:72 reference → _r72to144, _x2, _h120mm', async () => {
  // Print-space Z (bed-up) = Babylon Y → a 0.06 BU-tall mesh is 60 mm tall as shown.
  setScene({ objects: { m1: obj('m1') }, registry: { m1: mesh('m1', { size: [0.1, 0.06, 0.2] }) },
    workingRatio: 72, targetRatio: 72 });
  const targets = [{ kind: 'ratio', value: 144 }, { kind: 'factor', value: 2 }, { kind: 'height', mm: 120 }];
  StateManager.setState(s => ({ ...s, print: { ...s.print, exportTargets: targets } }), { silent: true });
  const factors = [0, 1, 2].map(i => PrintManager.previewExportContext({ targetIndex: i }).ratioFactor);
  assert.deepEqual(factors.map(f => +f.toFixed(9)), [0.5, 2, 2]);
  const h = PrintManager.previewExportContext({ targetIndex: 2 });
  assert.ok(Math.abs(h.referenceHeightMM - 60) < 1e-9, `reference height 60 mm, got ${h.referenceHeightMM}`);
  assert.ok(Math.abs(h.targetRatio - 36) < 1e-9, 'height target reports its effective ratio (72 / 2)');
  MeshValidator.validateMesh = valOK;
  await PrintManager.exportOBJ();
  const zips = calls.downloads.filter(f => f.endsWith('.zip'));
  assert.deepEqual(zips, ['Test_r72to144.zip', 'Test_x2.zip', 'Test_h120mm.zip']);
});

await test('typed targets: as shown stays _r{ref}to{ref}; fractional tokens use p', async () => {
  setScene({ objects: { m1: obj('m1') }, registry: { m1: mesh('m1') }, workingRatio: 72, targetRatio: 72 });
  StateManager.setState(s => ({ ...s, print: { ...s.print,
    exportTargets: [{ kind: 'factor', value: 0.5 }, { kind: 'height', mm: 12.5 }] } }), { silent: true });
  MeshValidator.validateMesh = valOK;
  await PrintManager.exportSTL();
  assert.deepEqual(calls.downloads.filter(f => f.endsWith('.stl')), ['Test_x0p5.stl', 'Test_h12p5mm.stl']);
});

await test('typed targets: add / remove / replace are undoable commands', async () => {
  const { push, undo, redo, clear, AddExportTargetCommand, RemoveExportTargetCommand, ReplaceExportTargetCommand }
    = await import('../src/core/HistoryManager.js');
  clear();
  StateManager.setState(s => ({ ...s, print: { ...s.print, exportTargets: [] } }), { silent: true });
  const cur = () => StateManager.getState().print.exportTargets;
  push(new AddExportTargetCommand({ kind: 'ratio', value: 144 }));
  push(new AddExportTargetCommand({ kind: 'factor', value: 2 }));
  push(new AddExportTargetCommand({ kind: 'factor', value: 2 }));   // duplicate collapses
  assert.deepEqual(cur(), [{ kind: 'ratio', value: 144 }, { kind: 'factor', value: 2 }]);
  push(new ReplaceExportTargetCommand({ kind: 'factor', value: 2 }, { kind: 'height', mm: 120 }));
  assert.deepEqual(cur(), [{ kind: 'ratio', value: 144 }, { kind: 'height', mm: 120 }]);
  push(new RemoveExportTargetCommand({ kind: 'ratio', value: 144 }));
  assert.deepEqual(cur(), [{ kind: 'height', mm: 120 }]);
  undo();
  assert.deepEqual(cur(), [{ kind: 'ratio', value: 144 }, { kind: 'height', mm: 120 }]);
  undo();
  assert.deepEqual(cur(), [{ kind: 'ratio', value: 144 }, { kind: 'factor', value: 2 }]);
  undo(); undo(); undo();
  assert.deepEqual(cur(), [], 'back to as shown');
  redo();
  assert.deepEqual(cur(), [{ kind: 'ratio', value: 144 }]);
  clear();
});

await test('export ratio reference ignores active object when it is not exported', async () => {
  setScene({
    objects: {
      helper: obj('helper', { ratio: 72, isPrintPart: false }),
      m1: obj('m1', { ratio: 1 }),
    },
    registry: { helper: mesh('helper'), m1: mesh('m1') },
    targetRatio: 144,
  });
  StateManager.setState(s => ({
    ...s,
    selection: { ...s.selection, selectedIds: ['m1'], activeId: 'helper' },
    print: { ...s.print, exportTargets: [{ kind: 'ratio', value: 144 }] },
  }), { silent: true });
  const dims = PrintManager.getExportedDimensions('m1');
  assert.ok(Math.abs(dims.x - (10 * (1000 / 144))) < 1e-6,
    `dimension preview should use printable reference ratio 1, got ${dims.x}`);
  MeshValidator.validateMesh = valOK;
  await PrintManager.exportOBJ();
  assert.equal(calls.downloads.at(-1), 'Test_r1to144.zip',
    'non-exported active helper must not choose the export scale');
});

await test('export target ratio scales around active printable object origin', async () => {
  setScene({
    objects: {
      active: obj('active', { ratio: 72 }),
      other: obj('other', { ratio: 1 }),
    },
    registry: {
      active: mesh('active', { origin: [10, 0, 0] }),
      other: mesh('other', { origin: [20, 0, 0] }),
    },
    selectedIds: ['active', 'other'],
    targetRatio: 144,
  });
  StateManager.setState(s => ({
    ...s,
    selection: { ...s.selection, selectedIds: ['active', 'other'], activeId: 'active' },
    print: { ...s.print, exportTargets: [{ kind: 'ratio', value: 144 }] },
  }), { silent: true });
  MeshValidator.validateMesh = valOK;
  await PrintManager.exportOBJ();

  const activeClone = _clones.find(c => c.name === 'active__export');
  const otherClone = _clones.find(c => c.name === 'other__export');
  assert.ok(activeClone?.__bakedMatrix, 'active clone was baked');
  assert.ok(otherClone?.__bakedMatrix, 'other clone was baked');
  assert.equal(activeClone.__bakedMatrix.tx, 10000,
    'active origin stays at its as-shown millimetre coordinate');
  assert.equal(otherClone.__bakedMatrix.tx, 15000,
    'other origin scales proportionally around the active origin');
});

await test('filename: individually OBJ → outer zip + per-mesh entries carry project prefix', async () => {
  setScene({ objects: { m1: obj('m1'), m2: obj('m2') },
    registry: { m1: mesh('m1'), m2: mesh('m2') }, workingRatio: 1, targetRatio: 144 });
  MeshValidator.validateMesh = valOK;
  await PrintManager.exportOBJ({ individually: true });
  const outer = zipInstances.at(-1).files;
  assert.ok(outer['Test_m1_r1to144.obj']);
  assert.ok(outer['Test_m1_r1to144.mtl']);
  assert.ok(outer['Test_m2_r1to144.obj']);
  assert.ok(outer['Test_m2_r1to144.mtl']);
  // mtllib reference inside the OBJ payload must match the matching .mtl file
  assert.match(outer['Test_m1_r1to144.obj'], /^mtllib Test_m1_r1to144\.mtl/m,
    'OBJ mtllib points at per-mesh MTL');
  assert.equal(calls.downloads.at(-1), 'Test_r1to144.zip');
});

// ── OBJ solid-colour PNG synthesis ───────────────────────
//
// Mimaki UV-inkjet slicers are texture-first. When a shader is a flat diffuse
// colour with no map, OBJ export synthesises a 4×4 RGBA PNG per unique
// `${RRGGBBAA}` (alpha = material.alpha) and injects `map_Kd` into the MTL.
// Toggle: `state.print.objBakeSolidTextures` (default OFF), exposed as a
// checkbox on the Export tab.

await test('OBJ synthesis: default off → no PNG, no map_Kd', async () => {
  setScene({ objects: { m1: obj('m1') },
    registry: { m1: mesh('m1', { color: { r: 1, g: 0, b: 0 } }) } });
  MeshValidator.validateMesh = valOK;
  await PrintManager.exportOBJ();
  const files = zipInstances.at(-1).files;
  assert.ok(!Object.keys(files).some(k => k.startsWith('textures/solid_')),
    'no synthesised PNG by default');
  assert.ok(!/map_Kd/.test(files['Test_r1to1.mtl']), 'no map_Kd injected by default');
});

await test('OBJ synthesis: explicit toggle on → PNG in zip + map_Kd in MTL', async () => {
  setScene({ objects: { m1: obj('m1') },
    registry: { m1: mesh('m1', { color: { r: 1, g: 0, b: 0 } }) } });
  StateManager.setState(s => ({ ...s, print: { ...s.print, objBakeSolidTextures: true } }), { silent: true });
  MeshValidator.validateMesh = valOK;
  await PrintManager.exportOBJ();
  const files = zipInstances.at(-1).files;
  assert.ok(files['textures/solid_FF0000FF.png'], 'synth PNG embedded');
  assert.match(files['Test_r1to1.mtl'], /map_Kd textures\/solid_FF0000FF\.png/);
});

await test('OBJ synthesis: toggle off override → no PNG, no map_Kd', async () => {
  setScene({ objects: { m1: obj('m1') },
    registry: { m1: mesh('m1', { color: { r: 1, g: 0, b: 0 } }) } });
  StateManager.setState(s => ({ ...s, print: { ...s.print, objBakeSolidTextures: false } }), { silent: true });
  MeshValidator.validateMesh = valOK;
  try {
    await PrintManager.exportOBJ();
    const files = zipInstances.at(-1).files;
    assert.ok(!Object.keys(files).some(k => k.startsWith('textures/solid_')),
      'no synthesised PNG when toggle off');
    assert.ok(!/map_Kd/.test(files['Test_r1to1.mtl']), 'no map_Kd injected');
  } finally {
    StateManager.setState(s => ({ ...s, print: { ...s.print, objBakeSolidTextures: false } }), { silent: true });
  }
});

await test('OBJ synthesis: two meshes same colour → ONE PNG (dedup by RRGGBBAA)', async () => {
  setScene({
    objects: { m1: obj('m1'), m2: obj('m2') },
    registry: {
      m1: mesh('m1', { color: { r: 1, g: 0, b: 0 } }),
      m2: mesh('m2', { color: { r: 1, g: 0, b: 0 } }),
    },
  });
  StateManager.setState(s => ({ ...s, print: { ...s.print, objBakeSolidTextures: true } }), { silent: true });
  MeshValidator.validateMesh = valOK;
  await PrintManager.exportOBJ();
  const files = zipInstances.at(-1).files;
  const pngs = Object.keys(files).filter(k => k.startsWith('textures/solid_'));
  assert.equal(pngs.length, 1, 'one PNG for two identical-colour meshes');
  assert.equal(pngs[0], 'textures/solid_FF0000FF.png');
});

await test('OBJ synthesis: distinct colours → distinct PNGs', async () => {
  setScene({
    objects: { m1: obj('m1'), m2: obj('m2') },
    registry: {
      m1: mesh('m1', { color: { r: 1, g: 0, b: 0 } }),
      m2: mesh('m2', { color: { r: 0, g: 0, b: 1 } }),
    },
  });
  StateManager.setState(s => ({ ...s, print: { ...s.print, objBakeSolidTextures: true } }), { silent: true });
  MeshValidator.validateMesh = valOK;
  await PrintManager.exportOBJ();
  const files = zipInstances.at(-1).files;
  assert.ok(files['textures/solid_FF0000FF.png']);
  assert.ok(files['textures/solid_0000FFFF.png']);
});

await test('OBJ synthesis: opacity flows into α byte of filename', async () => {
  const m = mesh('m1', { color: { r: 1, g: 1, b: 1 } });
  m.material = { id: 'mat-m1', diffuseColor: { r: 1, g: 1, b: 1 }, alpha: 0.5 };
  const origClone = m.clone;
  m.clone = (n) => { const c = origClone.call(m, n); c.material = m.material; return c; };
  setScene({ objects: { m1: obj('m1') }, registry: { m1: m } });
  StateManager.setState(s => ({ ...s, print: { ...s.print, objBakeSolidTextures: true } }), { silent: true });
  MeshValidator.validateMesh = valOK;
  await PrintManager.exportOBJ();
  const files = zipInstances.at(-1).files;
  // 0.5 × 255 = 127.5 → rounds to 128 (0x80)
  assert.ok(files['textures/solid_FFFFFF80.png'], 'alpha 0.5 baked into filename hex');
  assert.match(files['Test_r1to1.mtl'], /map_Kd textures\/solid_FFFFFF80\.png/);
});

await test('OBJ synthesis: NaN alpha falls back to opaque in BOTH the PNG byte and MTL d (#10)', async () => {
  const m = mesh('m1', { color: { r: 1, g: 1, b: 1 } });
  m.material = { id: 'mat-m1', diffuseColor: { r: 1, g: 1, b: 1 }, alpha: NaN };
  const origClone = m.clone;
  m.clone = (n) => { const c = origClone.call(m, n); c.material = m.material; return c; };
  setScene({ objects: { m1: obj('m1') }, registry: { m1: m } });
  StateManager.setState(s => ({ ...s, print: { ...s.print, objBakeSolidTextures: true } }), { silent: true });
  MeshValidator.validateMesh = valOK;
  await PrintManager.exportOBJ();
  const files = zipInstances.at(-1).files;
  assert.ok(files['textures/solid_FFFFFFFF.png'], 'NaN alpha → opaque FF byte, never "NaN"');
  assert.match(files['Test_r1to1.mtl'], /\nd 1\.0000\n/, 'NaN alpha → d 1.0000, never "NaN"');
  assert.doesNotMatch(files['Test_r1to1.mtl'], /NaN/, 'no literal NaN leaks into the MTL');
});

await test('OBJ synthesis: textured shader is NOT synthesised (real PNG path owns it)', async () => {
  const tex = { name: 'paint', getBaseSize: () => ({ width: 2, height: 2 }), readPixels: () => new Uint8Array(16) };
  const m = mesh('m1', { color: { r: 1, g: 0, b: 0 } });
  m.material = { id: 'mat-m1', diffuseColor: { r: 1, g: 0, b: 0 }, diffuseTexture: tex };
  const origClone = m.clone;
  m.clone = (n) => { const c = origClone.call(m, n); c.material = m.material; return c; };
  setScene({ objects: { m1: obj('m1') }, registry: { m1: m } });
  StateManager.setState(s => ({ ...s, print: { ...s.print, objBakeSolidTextures: true } }), { silent: true });
  MeshValidator.validateMesh = valOK;
  await PrintManager.exportOBJ();
  const files = zipInstances.at(-1).files;
  assert.ok(!Object.keys(files).some(k => k.startsWith('textures/solid_')),
    'textured shader has no synth PNG');
  assert.ok(!/map_Kd textures\/solid_/.test(files['Test_r1to1.mtl']),
    'no synth map_Kd line for textured material');
});

await test('texture export names are unique case-insensitively; MTL + 3MF reference the final entries', async () => {
  const mkTex = (id) => ({ name: id, metadata: { mixoAssetId: id }, getBaseSize: () => ({ width: 2, height: 2 }), readPixels: () => new Uint8Array(16) });
  const mkTexMesh = (id, tex) => {
    const m = mesh(id);
    m.material = { id: `mat-${id}`, diffuseColor: { r: 1, g: 1, b: 1 }, diffuseTexture: tex };
    m.getVerticesData = (k) => k === 'uv' ? new Float32Array([0,0, 1,0, 0,1]) : new Float32Array([0,0,0, 1,0,0, 0,1,0]);
    const oc = m.clone;
    m.clone = (n) => { const c = oc.call(m, n); c.material = m.material; c.getVerticesData = m.getVerticesData; return c; };
    return m;
  };
  setScene({
    objects: { m1: obj('m1'), m2: obj('m2') },
    registry: { m1: mkTexMesh('m1', mkTex('tA')), m2: mkTexMesh('m2', mkTex('ta')) },
  });
  StateManager.setState(s => ({
    ...s,
    scene: { ...s.scene, assetLibrary: {
      tA: { kind: 'texture', filename: 'A.png' },
      ta: { kind: 'texture', filename: 'a.png' },
    } },
  }), { silent: true });
  MeshValidator.validateMesh = valOK;

  const { textureExportFilename } = await import('../src/core/print/ExportTextures.js');
  const used = new Set();
  const n1 = textureExportFilename({}, 'tA', used, StateManager.getState());
  const n2 = textureExportFilename({}, 'ta', used, StateManager.getState());
  assert.equal(n1, 'A.png', 'first keeps its casing');
  assert.notEqual(n1.toLowerCase(), n2.toLowerCase());

  await PrintManager.exportOBJ();
  const files = zipInstances.at(-1).files;
  const texEntries = Object.keys(files).filter(k => k.startsWith('textures/'));
  assert.equal(texEntries.length, 2, 'two texture entries');
  assert.equal(new Set(texEntries.map(k => k.toLowerCase())).size, 2, 'distinct case-insensitively');
  const mtl = files['Test_r1to1.mtl'];
  const refs = [...mtl.matchAll(/map_Kd (\S+)/g)].map(m => m[1]);
  assert.deepEqual([...refs].sort(), [...texEntries].sort(), 'MTL references exactly the packaged entries');

  await PrintManager.exportThreeMF();
  const tmf = zipInstances.at(-1).files;
  const tPaths = Object.keys(tmf).filter(k => k.startsWith('3D/Textures/'));
  assert.equal(tPaths.length, 2);
  assert.equal(new Set(tPaths.map(k => k.toLowerCase())).size, 2);
  const rels = tmf['3D/_rels/3dmodel.model.rels'] + tmf['3D/3dmodel.model'];
  for (const p of tPaths) assert.ok(rels.includes(p) || rels.includes('/' + p), `3MF references ${p}`);
});

await test('OBJ synthesis: individually → each per-mesh MTL gets its own map_Kd', async () => {
  setScene({
    objects: { m1: obj('m1'), m2: obj('m2') },
    registry: {
      m1: mesh('m1', { color: { r: 1, g: 0, b: 0 } }),
      m2: mesh('m2', { color: { r: 0, g: 1, b: 0 } }),
    },
  });
  StateManager.setState(s => ({ ...s, print: { ...s.print, objBakeSolidTextures: true } }), { silent: true });
  MeshValidator.validateMesh = valOK;
  await PrintManager.exportOBJ({ individually: true });
  const files = zipInstances.at(-1).files;
  assert.match(files['Test_m1_r1to1.mtl'], /map_Kd textures\/solid_FF0000FF\.png/);
  assert.match(files['Test_m2_r1to1.mtl'], /map_Kd textures\/solid_00FF00FF\.png/);
  assert.ok(files['textures/solid_FF0000FF.png']);
  assert.ok(files['textures/solid_00FF00FF.png']);
});

// ── Pipeline: progress reporting ─────────────────────────

await test('progress callback runs monotonically and reaches 1.0', async () => {
  setScene({ objects: { m1: obj('m1'), m2: obj('m2') },
    registry: { m1: mesh('m1'), m2: mesh('m2') } });
  MeshValidator.validateMesh = valOK;
  const seen = [];
  await PrintManager.exportOBJ({ onProgress: (f) => seen.push(f) });
  assert.ok(seen.length >= 3, `expected several ticks, got ${seen.length}`);
  for (let i = 1; i < seen.length; i++) {
    assert.ok(seen[i] >= seen[i - 1] - 1e-9, `non-monotonic at ${i}: ${seen[i - 1]}→${seen[i]}`);
  }
  assert.equal(seen.at(-1), 1, 'ends at 100%');
});

await test('progress is NOT advanced past collect when there are no meshes', async () => {
  setScene({});
  MeshValidator.validateMesh = valOK;
  const seen = [];
  await rejects(PrintManager.exportOBJ({ onProgress: (f) => seen.push(f) }), /No printable meshes/);
  assert.ok(seen.every(f => f < 0.1), 'no prep/serialize progress before the guard');
});

// ── getExportedDimensions ────────────────────────────────

await test('getExportedDimensions: factor = workingRatio/targetRatio*1000', async () => {
  setScene({ objects: { m1: obj('m1') }, registry: { m1: mesh('m1', { size: [2, 3, 4] }) },
    workingRatio: 12, targetRatio: 35 });
  const d = PrintManager.getExportedDimensions('m1');
  const f = (12 / 35) * 1000;
  assert.ok(Math.abs(d.x - 2 * f) < 1e-6 && Math.abs(d.y - 3 * f) < 1e-6 && Math.abs(d.z - 4 * f) < 1e-6);
});

await test('getExportedDimensions: 1:1 → raw size × 1000', async () => {
  setScene({ objects: { m1: obj('m1') }, registry: { m1: mesh('m1', { size: [1, 1, 1] }) } });
  const d = PrintManager.getExportedDimensions('m1');
  assert.deepEqual([d.x, d.y, d.z], [1000, 1000, 1000]);
});

await test('getExportedDimensions: missing mesh → null', async () => {
  setScene({ objects: { m1: obj('m1') }, registry: {} });
  assert.equal(PrintManager.getExportedDimensions('m1'), null);
  assert.equal(PrintManager.getExportedDimensions('nope'), null);
});

// ── Download.js FSA failure handling (task 0.2) ──────────

await test('triggerDownload: FSA write failure aborts the writable, toasts, falls back to anchor', async () => {
  const { triggerDownload } = await import('../src/core/print/Download.js');
  let aborted = 0;
  window.showSaveFilePicker = async () => ({
    createWritable: async () => ({
      write: async () => { throw new DOMException('denied', 'SecurityError'); },
      close: async () => {}, abort: async () => { aborted++; },
    }),
  });
  resetCalls(); toasts.length = 0;
  try { assert.equal(await triggerDownload({ type: 'text/plain' }, 'a.txt'), true); }
  finally { window.showSaveFilePicker = undefined; }
  assert.equal(aborted, 1, 'writable aborted');
  assert.equal(calls.downloads.length, 1, 'anchor fallback ran');
  assert.ok(toasts.some(x => x.type === 'warning' && /denied/.test(x.msg)), 'user told about the failure');
});

await test('triggerDownload: picker AbortError (user cancel) stays silent, returns false, no fallback', async () => {
  const { triggerDownload } = await import('../src/core/print/Download.js');
  window.showSaveFilePicker = async () => { throw new DOMException('cancelled', 'AbortError'); };
  resetCalls(); toasts.length = 0;
  try { assert.equal(await triggerDownload({ type: 'text/plain' }, 'a.txt'), false); }
  finally { window.showSaveFilePicker = undefined; }
  assert.equal(toasts.length, 0, 'no toast');
  assert.equal(calls.downloads.length, 0, 'no anchor download');
});

// ── PLY + WRL (task 1.6) ─────────────────────────────────

const { deflateSync } = await import('node:zlib');
const { setTextureSource } = await import('../src/core/assets/TextureSource.js');

// Minimal 8-bit RGBA PNG (filter 0 rows) — real bytes, decoded by PlyWriter.
function pngRGBA(w, h, rgba) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0;
  });
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0); out.write(type, 4, 'ascii'); Buffer.from(data).copy(out, 8);
    out.writeUInt32BE(crc(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc(h * (w * 4 + 1));
  for (let y = 0; y < h; y++) Buffer.from(rgba.slice(y * w * 4, (y + 1) * w * 4)).copy(raw, y * (w * 4 + 1) + 1);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// 2×2 texture, image order (top row first): red, green / blue, white.
const PLY_TEX_ID = 'ply-tex-asset';
setTextureSource(PLY_TEX_ID, new Blob([pngRGBA(2, 2, [255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255])]), 2, 2);

function texturedMesh(name, uv = [0.25, 0.75, 0.75, 0.25, 0.5, 0.5]) {
  const m = mesh(name);
  m.material = { id: `mat-${name}`, diffuseColor: { r: 1, g: 1, b: 1 },
    diffuseTexture: { name: 'chk', metadata: { mixoAssetId: PLY_TEX_ID } } };
  m.getVerticesData = (k) => k === 'uv' ? new Float32Array(uv) : new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const oc = m.clone;
  m.clone = (n) => { const c = oc.call(m, n); c.material = m.material; c.getVerticesData = m.getVerticesData; return c; };
  return m;
}

function parsePly(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const text = new TextDecoder('latin1').decode(u8);
  const end = text.indexOf('end_header\n') + 'end_header\n'.length;
  const header = text.slice(0, end);
  const nV = Number(/element vertex (\d+)/.exec(header)[1]);
  const nF = Number(/element face (\d+)/.exec(header)[1]);
  const textured = /property float s\n/.test(header);
  const stride = 28 + (textured ? 8 : 0);
  const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const verts = [];
  for (let i = 0; i < nV; i++) {
    const o = end + i * stride;
    verts.push({
      pos: [0, 1, 2].map(k => view.getFloat32(o + k * 4, true)),
      rgba: [u8[o + 24], u8[o + 25], u8[o + 26], u8[o + 27]],
      st: textured ? [view.getFloat32(o + 28, true), view.getFloat32(o + 32, true)] : null,
    });
  }
  const faces = [];
  let o = end + nV * stride;
  for (let i = 0; i < nF; i++) {
    const n = u8[o];
    faces.push(Array.from({ length: n }, (_, k) => view.getInt32(o + 1 + k * 4, true)));
    o += 1 + n * 4;
  }
  return { header, nV, nF, verts, faces, trailing: u8.length - o };
}

await test('PLY: combined export → `${project}${suffix}.ply`, no CSG re-bake', async () => {
  setScene({ objects: { m1: obj('m1') }, registry: { m1: mesh('m1', { color: { r: 1, g: 0, b: 0 } }) } });
  MeshValidator.validateMesh = valOK;
  await PrintManager.exportPLY();
  assert.equal(calls.downloads.at(-1), 'Test_r1to1.ply');
  assert.equal(calls.csgFrom.length, 0, 'PLY keeps colour/UVs — never CSG re-baked');
  assert.equal(_clones[0].__worldBaked, true, 'world + mm baked like every other writer');
});

await test('PLY: binary LE header, vertex count, PrintSpace position, solid sRGB colour', async () => {
  setScene({ objects: { m1: obj('m1') }, registry: { m1: mesh('m1', { color: { r: 1, g: 0, b: 0 } }) } });
  MeshValidator.validateMesh = valOK;
  await PrintManager.exportPLY({ individually: true });
  const ply = parsePly(zipInstances.at(-1).files['Test_m1_r1to1.ply']);
  assert.match(ply.header, /^ply\nformat binary_little_endian 1\.0\n/);
  assert.match(ply.header, /property float x\nproperty float y\nproperty float z\nproperty float nx\nproperty float ny\nproperty float nz\nproperty uchar red\nproperty uchar green\nproperty uchar blue\nproperty uchar alpha\n/);
  assert.match(ply.header, /property list uchar int vertex_indices\nend_header\n$/);
  assert.doesNotMatch(ply.header, /property float s/, 'solid-only file carries no s/t');
  assert.equal(ply.nV, 3);
  assert.equal(ply.nF, 1);
  assert.equal(ply.trailing, 0, 'byte length matches the header exactly');
  // Babylon (1,0,0) → print (-1,0,0); Babylon (0,1,0) → print (0,0,1) (Y-up → Z-up).
  assert.deepEqual(ply.verts[1].pos, [-1, 0, 0]);
  assert.deepEqual(ply.verts[2].pos, [0, 0, 1]);
  for (const v of ply.verts) assert.deepEqual(v.rgba, [255, 0, 0, 255]);
  assert.deepEqual(ply.faces[0], [0, 1, 2], 'CounterClockWise mesh written as-is (PrintSpace.printIndices)');
});

await test('PLY: ClockWise-flagged (glTF) mesh → face reversed, same as STL/3MF', async () => {
  setScene({ objects: { m1: obj('m1') }, registry: { m1: mesh('m1', { side: 0 }) } });
  MeshValidator.validateMesh = valOK;
  await PrintManager.exportPLY({ individually: true });
  const ply = parsePly(zipInstances.at(-1).files['Test_m1_r1to1.ply']);
  assert.deepEqual(ply.faces[0], [0, 2, 1]);
});

await test('PLY: textured mesh → s/t props + BILINEAR texture colour at each vertex UV', async () => {
  setScene({ objects: { t1: obj('t1') }, registry: { t1: texturedMesh('t1') } });
  MeshValidator.validateMesh = valOK;
  await PrintManager.exportPLY({ individually: true });
  const ply = parsePly(zipInstances.at(-1).files['Test_t1_r1to1.ply']);
  assert.match(ply.header, /property uchar alpha\nproperty float s\nproperty float t\n/);
  assert.equal(ply.trailing, 0);
  assert.deepEqual(ply.verts[0].rgba, [255, 0, 0, 255], 'uv (0.25,0.75) = top-left texel centre (bottom-left UV origin)');
  assert.deepEqual(ply.verts[1].rgba, [255, 255, 255, 255], 'uv (0.75,0.25) = bottom-right texel centre');
  assert.deepEqual(ply.verts[2].rgba, [128, 128, 128, 255], 'uv (0.5,0.5) = bilinear blend of all four texels');
  assert.deepEqual(ply.verts[0].st, [0.25, 0.75]);
});

await test('PLY: multi-object combined export merges into ONE file with offset indices', async () => {
  setScene({ objects: { a: obj('a'), b: obj('b') },
    registry: { a: mesh('a', { color: { r: 0, g: 0, b: 1 } }), b: texturedMesh('b') } });
  MeshValidator.validateMesh = valOK;
  let captured = null;
  window.showSaveFilePicker = async () => ({ createWritable: async () => ({ write: async (d) => { captured = d; }, close: async () => {} }) });
  try { await PrintManager.exportPLY(); } finally { window.showSaveFilePicker = undefined; }
  assert.ok(captured, 'PLY blob written');
  const ply = parsePly(new Uint8Array(await captured.arrayBuffer()));
  assert.equal(ply.nV, 6);
  assert.equal(ply.nF, 2);
  assert.deepEqual(ply.faces[1], [3, 4, 5], 'second mesh indices offset by the first mesh vertex count');
  assert.deepEqual(ply.verts[0].rgba, [0, 0, 255, 255], 'solid part keeps its material colour');
  assert.deepEqual(ply.verts[0].st, [0, 0], 'untextured vertex in a textured file gets s/t = 0');
  assert.deepEqual(ply.verts[3].rgba, [255, 0, 0, 255], 'textured part sampled');
});

await test('WRL: textured export → zip with .wrl + packaged PNG; ImageTexture url matches the entry', async () => {
  setScene({ objects: { t1: obj('t1') }, registry: { t1: texturedMesh('t1') } });
  MeshValidator.validateMesh = valOK;
  await PrintManager.exportWRL();
  assert.equal(calls.downloads.at(-1), 'Test_r1to1.zip');
  assert.equal(calls.csgFrom.length, 0, 'WRL keeps UVs — never CSG re-baked');
  const files = zipInstances.at(-1).files;
  const wrl = files['Test_r1to1.wrl'];
  assert.ok(wrl, 'combined .wrl entry');
  assert.match(wrl, /^#VRML V2\.0 utf8\n/);
  assert.match(wrl, /IndexedFaceSet \{/);
  assert.match(wrl, /coordIndex \[\s*0 1 2 -1\s*\]/);
  assert.match(wrl, /texCoordIndex \[\s*0 1 2 -1\s*\]/);
  assert.match(wrl, /TextureCoordinate \{ point \[\s*0\.25 0\.75,/);
  assert.match(wrl, /-1 0 0,\s*0 0 1\s*\]/, 'coords pass through PrintSpace (Z-up mm)');
  const url = /ImageTexture \{ url "([^"]+)" \}/.exec(wrl)?.[1];
  assert.equal(url, 'textures/chk.png');
  assert.ok(files[url], 'the referenced PNG is packaged at exactly that path');
});

await test('WRL: solid-only export → single .wrl with Material diffuseColor', async () => {
  setScene({ objects: { m1: obj('m1') }, registry: { m1: mesh('m1', { color: { r: 1, g: 0, b: 0 } }) } });
  MeshValidator.validateMesh = valOK;
  await PrintManager.exportWRL();
  assert.equal(calls.downloads.at(-1), 'Test_r1to1.wrl');
  await PrintManager.exportWRL({ individually: true });
  const wrl = zipInstances.at(-1).files['Test_m1_r1to1.wrl'];
  assert.match(wrl, /Material \{ diffuseColor 1 0 0 transparency 0 \}/);
  assert.doesNotMatch(wrl, /ImageTexture|texCoord/);
});

// ── OBJ axis (task 1.7: OBJ through PrintSpace + per-printer axis) ──────

const { encodeOBJ, resolveObjAxis } = await import('../src/core/print/ObjWriter.js');
const { signedVolume } = await import('../src/core/print/PrintSpace.js');

// Asymmetric tetra as the app holds it after a glTF import (see
// tests/print-space.test.mjs): Babylon xyz, ClockWise-flagged, outward.
// glTF source vertices (0,0,0) (10,0,0) (0,20,0) (0,0,30): +Y (20 mm) is up.
const TETRA_POS = [0, 0, 0, -10, 0, 0, 0, 20, 0, 0, 0, 30];
const TETRA_IDX = [0, 1, 2, 0, 3, 1, 0, 2, 3, 1, 3, 2];
const tetraMesh = (side = 0) => ({
  name: 'tet', sideOrientation: side, material: { id: 'm' },
  getIndices: () => TETRA_IDX,
  getVerticesData: (k) => (k === 'position' ? TETRA_POS : k === 'uv' ? [0, 0, 1, 0, 0, 1, 1, 1] : null),
});
const parseObj = (text) => {
  const pos = [], idx = [];
  for (const line of text.split('\n')) {
    const p = line.trim().split(/\s+/);
    if (p[0] === 'v') pos.push(+p[1], +p[2], +p[3]);
    if (p[0] === 'f') idx.push(...p.slice(1).map(c => parseInt(c, 10) - 1));
  }
  return { pos, idx };
};
// The map Babylon's OBJExport.OBJ applied before 1.7 (left-handed scene,
// node_modules/@babylonjs/serializers/OBJ/objSerializer.js): v = (-x, y, z);
// faces reversed when the effective side orientation is ClockWise.
const legacyBabylonObj = (pos, idx, side) => {
  const p = [];
  for (let i = 0; i < pos.length; i += 3) p.push(-pos[i], pos[i + 1], pos[i + 2]);
  const f = [];
  for (let i = 0; i < idx.length; i += 3) f.push(...(side === 0 ? [idx[i], idx[i + 2], idx[i + 1]] : [idx[i], idx[i + 1], idx[i + 2]]));
  return { pos: p, idx: f };
};

await test('OBJ axis: y-up output is geometrically identical to the pre-1.7 Babylon OBJExport output (positions + winding)', () => {
  for (const side of [0, 1]) {
    const got = parseObj(encodeOBJ([{ mesh: tetraMesh(side) }], { axis: 'y-up' }));
    const legacy = legacyBabylonObj(TETRA_POS, TETRA_IDX, side);
    assert.deepEqual(got.pos.map(v => v + 0), legacy.pos.map(v => v + 0), `positions side=${side}`);
    assert.deepEqual(got.idx, legacy.idx, `winding side=${side}`);
  }
});

await test('OBJ axis: known vertex — glTF apex (0,20,0) is +Y in y-up and +Z in z-up; x not mirrored', () => {
  const y = parseObj(encodeOBJ([{ mesh: tetraMesh() }], { axis: 'y-up' })).pos;
  const z = parseObj(encodeOBJ([{ mesh: tetraMesh() }], { axis: 'z-up' })).pos;
  assert.deepEqual(y.slice(6, 9).map(v => v + 0), [0, 20, 0], 'y-up apex');
  assert.deepEqual(z.slice(6, 9).map(v => v + 0), [0, 0, 20], 'z-up apex (matches STL/3MF/PLY)');
  assert.deepEqual(y.slice(3, 6).map(v => v + 0), [10, 0, 0], 'y-up x extent +10 (glTF source x)');
  assert.deepEqual(z.slice(3, 6).map(v => v + 0), [10, 0, 0], 'z-up x extent +10');
  assert.deepEqual(y.slice(9, 12).map(v => v + 0), [0, 0, 30], 'y-up: glTF +Z stays +Z');
  assert.deepEqual(z.slice(9, 12).map(v => v + 0), [0, -30, 0], 'z-up: glTF +Z → -Y (PrintSpace)');
});

await test('OBJ axis: both axis options are outward (signed volume +1000 mm³) for glTF- and native-flagged meshes', () => {
  for (const axis of ['y-up', 'z-up']) {
    const gltf = parseObj(encodeOBJ([{ mesh: tetraMesh(0) }], { axis }));
    const vol = signedVolume(gltf.pos, gltf.idx);
    assert.ok(Math.abs(vol - 1000) < 1e-6, `${axis} glTF: expected +1000, got ${vol}`);
    // Babylon-native outward fixture: negative raw volume, CounterClockWise flag.
    const nIdx = [0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3];
    const native = { name: 'n', sideOrientation: 1, material: { id: 'm' }, getIndices: () => nIdx,
      getVerticesData: (k) => (k === 'position' ? TETRA_POS : null) };
    const { pos, idx } = parseObj(encodeOBJ([{ mesh: native }], { axis }));
    assert.ok(signedVolume(pos, idx) > 0, `${axis} native: outward`);
  }
});

await test('OBJ axis: face corners reference v/vt and normals are rotated with positions', () => {
  const m = tetraMesh();
  m.getVerticesData = (k) => (k === 'position' ? TETRA_POS : k === 'normal' ? [0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]
    : k === 'uv' ? [0, 0, 1, 0, 0, 1, 1, 1] : null);
  const y = encodeOBJ([{ mesh: m }], { axis: 'y-up', mtllib: 'T' });
  const z = encodeOBJ([{ mesh: m }], { axis: 'z-up', mtllib: 'T' });
  assert.match(y, /^mtllib T\.mtl$/m);
  assert.match(y, /^usemtl m$/m);
  assert.match(y, /^vn 0 1 0$/m, 'Babylon +Y normal stays +Y in y-up');
  assert.match(z, /^vn 0 0 1$/m, 'Babylon +Y normal is +Z in z-up');
  assert.match(y, /^vt 1 1$/m, 'UVs written raw');
  assert.match(y, /^f 1\/1\/1 3\/3\/3 2\/2\/2$/m, 'v/vt/vn corners, ClockWise mesh reversed');
});

await test('OBJ axis: resolveObjAxis — ctx.prefs.objAxis wins, then printer profile, then y-up', () => {
  assert.equal(resolveObjAxis({ prefs: { objAxis: 'z-up' }, state: { print: { targetPrinterId: 'mimaki-3duj-553' } } }), 'z-up');
  assert.equal(resolveObjAxis({ prefs: {}, state: { print: { targetPrinterId: 'mimaki-3duj-553' } } }), 'y-up');
  assert.equal(resolveObjAxis({ prefs: {}, state: { print: { targetPrinterId: 'bambu-x1c' } } }), 'z-up');
  assert.equal(resolveObjAxis({ prefs: { objAxis: 'sideways' }, state: { print: { targetPrinterId: 'bambu-x1c' } } }), 'z-up');
  assert.equal(resolveObjAxis({ prefs: {}, state: { print: { targetPrinterId: 'no-such-printer' } } }), 'y-up', 'unknown printer → Mimaki default profile');
});

await test('OBJ axis: pipeline export for the default Mimaki target writes Y-up', async () => {
  setScene({ objects: { m1: obj('m1') }, registry: { m1: mesh('m1') } });
  StateManager.setState(s => ({ ...s, print: { ...s.print, targetPrinterId: 'mimaki-3duj-553' } }), { silent: true });
  MeshValidator.validateMesh = valOK;
  await PrintManager.exportOBJ();
  assert.match(objTexts()[0], /^# mixomesh export: millimetres, right-handed, Y-up$/m);
  StateManager.setState(s => ({ ...s, print: { ...s.print, targetPrinterId: 'bambu-x1c' } }), { silent: true });
  zipInstances.length = 0;
  await PrintManager.exportOBJ();
  assert.match(objTexts()[0], /^# mixomesh export: millimetres, right-handed, Z-up$/m);
  StateManager.setState(s => ({ ...s, print: { ...s.print, targetPrinterId: 'mimaki-3duj-553' } }), { silent: true });
});

// ── Report ───────────────────────────────────────────────

console.log('\n' + out.join('\n'));
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
