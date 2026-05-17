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

const { StateManager } = await import('../core/StateManager.js');
const { AssetLoader }  = await import('../core/AssetLoader.js');
const { MeshValidator } = await import('../core/MeshValidator.js');
const { PrintManager } = await import('../core/PrintManager.js');
const { Toast } = await import('../ui/Toast.js');
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
    isGhost: false, isUnlinked: false, isPrintPart: true,
    partLabel: '', partTolerance: 0, ...over,
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
