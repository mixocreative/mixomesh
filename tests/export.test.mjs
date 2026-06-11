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

function mesh(name, { verts = 100, size = [10, 20, 30], color = null } = {}) {
  return {
    name,
    material: color ? { id: 'mat-' + name, diffuseColor: color } : { id: 'mat-' + name },
    _verts: verts, _size: size, _color: color,
    getTotalVertices() { return this._verts; },
    getVerticesData() { return new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]); },
    getIndices() { return [0, 1, 2]; },
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
    getWorldMatrix() { return { multiply() { return this; } }; },
    bakeTransformIntoVertices() { this.__worldBaked = true; },
    setParent() {},
    optimizeIndices() { this.__optimized = true; },
    createNormals() { this.__normals = true; },
    makeGeometryUnique() { this.__unique = true; },
    bakeCurrentTransformIntoVertices() { this.__baked = true; },
    refreshBoundingInfo() {},
    dispose() { this.__disposed = true; },
    clone(cloneName) {
      const c = mesh(cloneName || (name + '__c'), { verts, size, color });
      c.material = this.material;
      c.__isClone = true;
      _clones.push(c);
      return c;
    },
  };
}

function setScene({ objects = {}, registry = {}, selectedIds = [], workingRatio = 1, targetRatio = 1 }) {
  _registry = registry;
  StateManager.setState(s => ({
    ...s,
    project: { ...s.project, name: 'Test' },
    print: { ...s.print, workingRatio, targetRatio },
    selection: { ...s.selection, selectedIds },
    scene: { ...s.scene, objects },
  }), { silent: true });
}

function obj(id, over = {}) {
  return {
    id, name: id, assetId: 'a1', collectionId: null, parentId: null,
    shaderId: null, visible: true, locked: false,
    isGhost: false, isUnlinked: false, isPrintPart: true, ...over,
  };
}

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
  assert.equal(calls.objExportOBJ.length, 1);
  assert.equal(calls.objExportMTL.length, 1);
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
  assert.equal(calls.objExportOBJ.length, 0, 'no OBJ written');
  assert.equal(calls.downloads.length, 0, 'no download');
});

await test('OBJ: error the auto-fix RESOLVES → exports, no error list', async () => {
  setScene({ objects: { m1: obj('m1') }, registry: { m1: mesh('m1') } });
  MeshValidator.validateMesh = valErrUnlessFixed;   // cleared once createNormals runs
  await PrintManager.exportOBJ();
  assert.equal(calls.objExportOBJ.length, 1, 'exported because fix cleared the error');
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
  assert.equal(calls.objExportOBJ.length, 1);
  assert.equal(calls.objExportMTL.length, 1);
  assert.ok(_clones[0].material, 'fallback material assigned to clone');
});

await test('OBJ: warnings only → still exports', async () => {
  setScene({ objects: { m1: obj('m1') }, registry: { m1: mesh('m1') } });
  MeshValidator.validateMesh = valWarnOnly;
  await PrintManager.exportOBJ();
  assert.equal(calls.objExportOBJ.length, 1);
  assert.equal(calls.downloads.length, 1);
});

await test('OBJ: selectedOnly exports just the selected mesh', async () => {
  setScene({
    objects: { m1: obj('m1'), m2: obj('m2') },
    registry: { m1: mesh('m1'), m2: mesh('m2') }, selectedIds: ['m2'],
  });
  MeshValidator.validateMesh = valOK;
  await PrintManager.exportOBJ({ selectedOnly: true });
  assert.equal(calls.objExportOBJ.length, 1);
  assert.equal(calls.objExportOBJ[0].count, 1);
});

await test('OBJ: individually → one OBJ call per mesh', async () => {
  setScene({ objects: { m1: obj('m1'), m2: obj('m2') }, registry: { m1: mesh('m1'), m2: mesh('m2') } });
  MeshValidator.validateMesh = valOK;
  await PrintManager.exportOBJ({ individually: true });
  assert.equal(calls.objExportOBJ.length, 2);
});

await test('OBJ: all-meshes mode → single OBJ call with every mesh', async () => {
  setScene({ objects: { m1: obj('m1'), m2: obj('m2'), m3: obj('m3') },
    registry: { m1: mesh('m1'), m2: mesh('m2'), m3: mesh('m3') } });
  MeshValidator.validateMesh = valOK;
  await PrintManager.exportOBJ();
  assert.equal(calls.objExportOBJ.length, 1);
  assert.equal(calls.objExportOBJ[0].count, 3);
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

// ── STL ──────────────────────────────────────────────────

await test('STL: CSG2 unavailable → exports without re-bake, warns', async () => {
  const B = globalThis.window.BABYLON;
  const savedCSG = B.CSG2, savedInit = B.InitializeCSG2Async;
  B.CSG2 = undefined; B.InitializeCSG2Async = undefined;
  try {
    setScene({ objects: { m1: obj('m1') }, registry: { m1: mesh('m1') } });
    MeshValidator.validateMesh = valOK;
    await PrintManager.exportSTL();
    assert.equal(calls.stlCreate.length, 1, 'STL still produced');
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
  assert.equal(calls.stlCreate.length, 1);
  assert.equal(calls.stlCreate[0].count, 2);
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
    assert.equal(calls.stlCreate.length, 1, 'export still produced');
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
  assert.equal(calls.stlCreate.length, 0);
});

await test('STL: individually → one STL call per mesh + outer zip of N parts', async () => {
  setScene({ objects: { m1: obj('m1'), m2: obj('m2'), m3: obj('m3') },
    registry: { m1: mesh('m1'), m2: mesh('m2'), m3: mesh('m3') } });
  MeshValidator.validateMesh = valOK;
  await PrintManager.exportSTL({ individually: true });
  // One CreateSTL call per mesh, each with a single-mesh list and download=false
  assert.equal(calls.stlCreate.length, 3, 'one STL call per mesh');
  for (const c of calls.stlCreate) {
    assert.equal(c.count, 1);
    assert.equal(c.rest[0], false, 'download=false so bytes return for zipping');
  }
  // Outer zip contains the three .stl entries named `${project}_${mesh}_r{w}to{t}.stl`
  const outer = zipInstances.at(-1).files;
  assert.ok(outer['Test_m1_r1to1.stl'], 'project+mesh+ratio in name');
  assert.ok(outer['Test_m2_r1to1.stl']);
  assert.ok(outer['Test_m3_r1to1.stl']);
  assert.equal(calls.downloads.at(-1), 'Test_r1to1.zip',
    'outer zip uses project+ratio default filename');
});

await test('STL: individually + selectedOnly → only selected mesh in outer zip', async () => {
  setScene({ objects: { m1: obj('m1'), m2: obj('m2') },
    registry: { m1: mesh('m1'), m2: mesh('m2') }, selectedIds: ['m2'] });
  MeshValidator.validateMesh = valOK;
  await PrintManager.exportSTL({ individually: true, selectedOnly: true });
  assert.equal(calls.stlCreate.length, 1, 'only the selected mesh exported');
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
  assert.match(model, /<triangle v1="0" v2="2" v3="1"\/>/, 'winding flipped for RH 3MF');
  assert.match(model, /<build><item objectid="2" transform="1 0 0 0 1 0 0 0 1 0 0 0"\/><\/build>/,
    'build item carries explicit identity — placement is fully baked');
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
  textured.material = { id: 'm', diffuseColor: { r: 0, g: 1, b: 0 }, diffuseTexture: { name: 't' } };
  const origClone = textured.clone;
  textured.clone = (n) => { const c = origClone.call(textured, n); c.material = textured.material; return c; };
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
  // Default printer target = Mimaki materials-ext; force the colorgroup path
  // by overriding `state.print.targetPrinterId` to a filament printer entry.
  setScene({ objects: { m1: obj('m1'), m2: obj('m2') },
    registry: { m1: mesh('m1', { color: { r: 1, g: 0, b: 0 } }),
                m2: mesh('m2', { color: { r: 0, g: 0, b: 1 } }) } });
  StateManager.setState(s => ({ ...s, print: { ...s.print, targetPrinterId: 'bambu-x1c' } }), { silent: true });
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

await test('3MF materials-ext: individually → per-mesh 3MF carries only its own texture', async () => {
  // Reset to Mimaki materials-ext target.
  StateManager.setState(s => ({ ...s, print: { ...s.print, targetPrinterId: 'mimaki-3duj-553' } }), { silent: true });
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
  assert.equal(calls.stlCreate.length, 1);
  assert.equal(calls.stlCreate[0].rest[0], false,
    'STL combined now goes through _triggerDownload (download=false)');
  assert.equal(calls.downloads.at(-1), 'Test_r12to35.stl');
});

await test('filename: combined 3MF colorgroup → `${project}${suffix}.3mf`', async () => {
  setScene({ objects: { m1: obj('m1') }, registry: { m1: mesh('m1', { color: { r: 1, g: 0, b: 0 } }) },
    workingRatio: 1, targetRatio: 144 });
  StateManager.setState(s => ({ ...s, print: { ...s.print, targetPrinterId: 'bambu-x1c' } }), { silent: true });
  MeshValidator.validateMesh = valOK;
  await PrintManager.exportThreeMF();
  assert.equal(calls.downloads.at(-1), 'Test_r1to144.3mf');
});

await test('filename: combined 3MF materials-ext → `${project}${suffix}.3mf`', async () => {
  StateManager.setState(s => ({ ...s, print: { ...s.print, targetPrinterId: 'mimaki-3duj-553' } }), { silent: true });
  setScene({ objects: { m1: obj('m1') }, registry: { m1: mesh('m1', { color: { r: 1, g: 0, b: 0 } }) },
    workingRatio: 1, targetRatio: 1 });
  MeshValidator.validateMesh = valOK;
  await PrintManager.exportThreeMF();
  assert.equal(calls.downloads.at(-1), 'Test_r1to1.3mf');
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
  const objCall = calls.objExportOBJ[0];
  assert.equal(objCall.rest[1], 'Test_m1_r1to144.mtl', 'OBJ mtllib points at per-mesh MTL');
  assert.equal(calls.downloads.at(-1), 'Test_r1to144.zip');
});

// ── OBJ solid-colour PNG synthesis ───────────────────────
//
// Mimaki UV-inkjet slicers are texture-first. When a shader is a flat diffuse
// colour with no map, OBJ export synthesises a 4×4 RGBA PNG per unique
// `${RRGGBBAA}` (alpha = material.alpha) and injects `map_Kd` into the MTL.
// Toggle: `state.print.objBakeSolidTextures` (default ON), exposed as a
// checkbox on the Export tab.

await test('OBJ synthesis: solid mesh → PNG in zip + map_Kd in MTL', async () => {
  setScene({ objects: { m1: obj('m1') },
    registry: { m1: mesh('m1', { color: { r: 1, g: 0, b: 0 } }) } });
  MeshValidator.validateMesh = valOK;
  await PrintManager.exportOBJ();
  const files = zipInstances.at(-1).files;
  assert.ok(files['textures/solid_FF0000FF.png'], 'synth PNG embedded');
  assert.match(files['Test_r1to1.mtl'], /map_Kd textures\/solid_FF0000FF\.png/);
});

await test('OBJ synthesis: toggle off → no PNG, no map_Kd', async () => {
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
    StateManager.setState(s => ({ ...s, print: { ...s.print, objBakeSolidTextures: true } }), { silent: true });
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
  MeshValidator.validateMesh = valOK;
  await PrintManager.exportOBJ();
  const files = zipInstances.at(-1).files;
  // 0.5 × 255 = 127.5 → rounds to 128 (0x80)
  assert.ok(files['textures/solid_FFFFFF80.png'], 'alpha 0.5 baked into filename hex');
  assert.match(files['Test_r1to1.mtl'], /map_Kd textures\/solid_FFFFFF80\.png/);
});

await test('OBJ synthesis: textured shader is NOT synthesised (real PNG path owns it)', async () => {
  const tex = { name: 'paint', getBaseSize: () => ({ width: 2, height: 2 }), readPixels: () => new Uint8Array(16) };
  const m = mesh('m1', { color: { r: 1, g: 0, b: 0 } });
  m.material = { id: 'mat-m1', diffuseColor: { r: 1, g: 0, b: 0 }, diffuseTexture: tex };
  const origClone = m.clone;
  m.clone = (n) => { const c = origClone.call(m, n); c.material = m.material; return c; };
  setScene({ objects: { m1: obj('m1') }, registry: { m1: m } });
  MeshValidator.validateMesh = valOK;
  await PrintManager.exportOBJ();
  const files = zipInstances.at(-1).files;
  assert.ok(!Object.keys(files).some(k => k.startsWith('textures/solid_')),
    'textured shader has no synth PNG');
  assert.ok(!/map_Kd textures\/solid_/.test(files['Test_r1to1.mtl']),
    'no synth map_Kd line for textured material');
});

await test('OBJ synthesis: individually → each per-mesh MTL gets its own map_Kd', async () => {
  setScene({
    objects: { m1: obj('m1'), m2: obj('m2') },
    registry: {
      m1: mesh('m1', { color: { r: 1, g: 0, b: 0 } }),
      m2: mesh('m2', { color: { r: 0, g: 1, b: 0 } }),
    },
  });
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

// ── Report ───────────────────────────────────────────────

console.log('\n' + out.join('\n'));
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
