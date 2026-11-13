// The shared harness for the export tests: a stubbed Babylon/JSZip/DOM world, the fake meshes and
// scenes every case builds on, and a tiny runner that reports its own case count.
//
// Cut out of the 2,003-line tests/export.test.mjs on 2026-11-14, following this folder's own
// support-browser-kit.mjs pattern. The five export-*.test.mjs files are its only callers.
//
// WHY THE RUNNER COUNTS ITS CASES. `node --test` counts each of these files as ONE test, so the
// suite's own totals say nothing about how many cases inside it ran: a case that stops running
// changes nothing anyone sees. Each caller ends with `report(n, label)` and n is checked, which is
// also what made splitting the original file safe -- the five counts must still sum to 113.
//
// THE TRAP IN HERE. `mesh()` is a fake, and several of its methods only RECORD that they were
// called (`__repaired`, `__baked`, `__optimized`, `__normals`). That is deliberate: it is how a
// case proves repair touched the export CLONE and not the user's mesh. A fake that silently
// returns something neutral is how a probe reports OK without measuring anything, so read what a
// stub actually does before trusting a green case built on it.

// Headless export-pipeline tests. Run:
//   node --import ./tests/register-hooks.mjs tests/export.test.mjs
//
// Drives the REAL PrintManager with stubbed Babylon / JSZip / DOM. Covers the
// post-auto-fix flow: collect → clone+auto-fix → validate fixed clones →
// only block if errors remain.

import assert from 'node:assert/strict';
import { installEnv, calls, resetCalls } from './env.mjs';
export { calls, resetCalls };
import { instances as zipInstances } from './jszip-stub.mjs';
export { zipInstances };

installEnv();

export const { StateManager } = await import('../src/core/StateManager.js');
export const { AssetLoader }  = await import('../src/core/AssetLoader.js');
export const { MeshValidator } = await import('../src/core/MeshValidator.js');
export const { PrintManager } = await import('../src/core/PrintManager.js');
export const MeshRepair = await import('../src/core/repair/MeshRepair.js');
export const { t } = await import('../src/i18n/index.js');
export const { Toast } = await import('../src/ui/Toast.js');
export const toasts = [];
Toast.show = (msg, type) => { toasts.push({ msg, type }); };
Toast.dismiss = () => {};
console.error = () => {};

// ── Helpers ──────────────────────────────────────────────

export function v(x = 0, y = 0, z = 0) {
  return { x, y, z, subtract: o => v(x - o.x, y - o.y, z - o.z) };
}

export let _registry = {};
export let _clones = [];
AssetLoader.getBabylonMesh = (id) => _registry[id] ?? null;

export function mesh(name, { verts = 100, size = [10, 20, 30], color = null, origin = [0, 0, 0], side = 1 } = {}) {
  return {
    name,
    id: name,
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
    optimizeIndices(done) { this.__optimized = true; done?.(this); },   // Babylon calls back when finished
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

export function setScene({ objects = {}, registry = {}, selectedIds = [], workingRatio = 1, targetRatio = 1 }) {
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
    // Huge bed: the fake meshes are 10-30 BU (= metres of mm), and a
    // bed-overflow WARNING would demand acknowledgement (task 1.8).
    print: { ...s.print, exportTargets: [{ kind: 'ratio', value: targetRatio }], bedDimensions: { x: 1e6, y: 1e6, z: 1e6 } },
    selection: { ...s.selection, selectedIds, activeId },
    // Fresh, clean validation cache: an unvalidated object is a
    // `validation-pending` WARNING, which (task 1.8) needs acknowledgement.
    scene: {
      ...s.scene, objects: objectsWithRatio,
      validation: Object.fromEntries(Object.keys(objectsWithRatio).map(id => [id, { results: [], stale: false }])),
    },
  }), { silent: true });
}

export function obj(id, over = {}) {
  return {
    id, name: id, assetId: 'a1', collectionId: null, parentId: null,
    shaderId: null, visible: true, locked: false,
    isGhost: false, isUnlinked: false, isPrintPart: true, ...over,
  };
}

// OBJ is written by ObjWriter.encodeOBJ (no Babylon OBJExport since task
// 1.7): count the OBJ files / `o` blocks the export actually zipped.
export const objTexts = () => zipInstances.flatMap(z => Object.entries(z.files))
  .filter(([n]) => n.endsWith('.obj')).map(([, d]) => String(d));
export const objBlocks = (text) => (text.match(/^o /gm) || []).length;

export const stlInfo = (bytes) => {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  return { bytes: u8.length, tris: view.getUint32(80, true), trisBE: view.getUint32(80, false) };
};

export const valOK         = async () => [];
export const valErrAlways  = async () => [{ severity: 'error', message: 'non-manifold' }];
export const valWarnOnly   = async () => [{ severity: 'warning', message: 'thin wall' }];
// Error unless the auto-fix recomputed normals on the export clone — proves
// the "only report what survives the fix" rule.
export const valErrUnlessFixed = async (m) => (m.__normals ? [] : [{ severity: 'error', message: 'inverted normals' }]);

// ── Tiny runner ──────────────────────────────────────────

let passed = 0, failed = 0;
const out = [];
export async function test(name, fn) {
  resetCalls(); toasts.length = 0; _clones = []; zipInstances.length = 0;
  try { await fn(); out.push(`PASS  ${name}`); passed++; }
  catch (err) { out.push(`FAIL  ${name}\n      ${err.stack || err.message}`); failed++; }
}
export const rejects = (p, re) => assert.rejects(p, re);

/**
 * Print this file's cases and exit. `expected` is asserted: see the note at the top.
 * @param {number} expected the number of cases this file is supposed to run
 * @param {string} label what to call this file in the output
 */
export function report(expected, label) {
  // expected < 0 is the bootstrap used when a file is first created: report, assert nothing. No
  // file in the repo may keep it -- the count is the whole point of this function.
  if (expected >= 0 && passed + failed !== expected) {
    out.push(`FAIL  case count\n      ${passed + failed} cases ran, ${expected} expected.`
      + ' If you added or removed one on purpose, update the number in the same commit.');
    failed++;
  }
  console.log(`\n${label}\n` + out.join('\n'));
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}
