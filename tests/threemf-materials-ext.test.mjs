// 3MF Materials Extension (Mimaki) round-trip tests. Run:
//   node --import ./tests/register-hooks.mjs tests/threemf-materials-ext.test.mjs
//
// Mimaki UV-inkjet workflow lands continuous-tone color into
// the package via <m:texture2d>+<m:texture2dgroup>+per-triangle p1/p2/p3,
// not the filament colorgroup. The writer is the exact inverse of the
// loader — verifying the writer's XML against a known UV/index input
// proves the loader will reconstruct UVs correctly because the loader
// just reads back the same attribute layout.

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

/**
 * Textured-mesh fixture. UVs are real (UV count = vertex count). The texture
 * stub satisfies _textureToBlob (width/height + readPixels) so the writer
 * actually emits the PNG part rather than catching and falling through.
 */
function texMesh(name, { positions, indices, uvs, textureName = 'paint' }) {
  const tex = {
    name: textureName,
    getBaseSize() { return { width: 2, height: 2 }; },
    readPixels() { return new Uint8Array([255,0,0,255, 0,255,0,255, 0,0,255,255, 255,255,0,255]); },
  };
  return {
    name,
    material: { id: 'mat-' + name, diffuseColor: { r: 1, g: 1, b: 1 }, diffuseTexture: tex },
    _uvs: uvs,
    getTotalVertices() { return positions.length / 3; },
    getVerticesData(kind) {
      if (kind === 'uv') return new Float32Array(this._uvs);
      return new Float32Array(positions);
    },
    getIndices() { return indices.slice(); },
    getBoundingInfo() {
      let mnx=Infinity,mny=Infinity,mnz=Infinity,mxx=-Infinity,mxy=-Infinity,mxz=-Infinity;
      for (let i=0;i<positions.length;i+=3) {
        mnx=Math.min(mnx,positions[i]); mxx=Math.max(mxx,positions[i]);
        mny=Math.min(mny,positions[i+1]); mxy=Math.max(mxy,positions[i+1]);
        mnz=Math.min(mnz,positions[i+2]); mxz=Math.max(mxz,positions[i+2]);
      }
      return { boundingBox: { minimumWorld: v(mnx,mny,mnz), maximumWorld: v(mxx,mxy,mxz) } };
    },
    parent: null,
    scaling: { x: 1, y: 1, z: 1, set() {}, clone() { return { x:1, y:1, z:1 }; }, scaleInPlace() {} },
    position: { set() {} },
    rotation: { set() {} },
    rotationQuaternion: null,
    getScene() { return {}; },
    computeWorldMatrix() {},
    getWorldMatrix() { return window.BABYLON.Matrix.Translation(0, 0, 0); },
    bakeTransformIntoVertices() { this.__worldBaked = true; },
    setParent() {},
    optimizeIndices() { this.__optimized = true; },
    createNormals() { this.__normals = true; },
    makeGeometryUnique() { this.__unique = true; },
    bakeCurrentTransformIntoVertices() {},
    refreshBoundingInfo() {},
    dispose() { this.__disposed = true; },
    clone(cloneName) {
      const c = texMesh(cloneName || (name + '__c'), { positions, indices, uvs, textureName });
      c.material = this.material;
      c.__isClone = true;
      _clones.push(c);
      return c;
    },
  };
}

/** Plain solid-colour mesh — same fixture as export.test.mjs in shape. */
function solidMesh(name, { color = { r: 0.5, g: 0.5, b: 0.5 } } = {}) {
  return {
    name,
    material: { id: 'mat-' + name, diffuseColor: color },
    getTotalVertices() { return 3; },
    getVerticesData(kind) {
      if (kind === 'uv') return null;          // no UVs on solid meshes
      return new Float32Array([0,0,0, 1,0,0, 0,1,0]);
    },
    getIndices() { return [0,1,2]; },
    getBoundingInfo() {
      return { boundingBox: { minimumWorld: v(0,0,0), maximumWorld: v(1,1,0) } };
    },
    parent: null,
    scaling: { x:1, y:1, z:1, set() {}, clone() { return { x:1, y:1, z:1 }; }, scaleInPlace() {} },
    position: { set() {} }, rotation: { set() {} }, rotationQuaternion: null,
    getScene() { return {}; },
    computeWorldMatrix() {}, getWorldMatrix() { return window.BABYLON.Matrix.Translation(0, 0, 0); },
    bakeTransformIntoVertices() {}, setParent() {},
    optimizeIndices() {}, createNormals() {}, makeGeometryUnique() {},
    bakeCurrentTransformIntoVertices() {}, refreshBoundingInfo() {},
    dispose() {},
    clone(cloneName) {
      const c = solidMesh(cloneName || (name + '__c'), { color });
      c.material = this.material;
      _clones.push(c);
      return c;
    },
  };
}

function setScene({ objects = {}, registry = {}, targetPrinterId = 'mimaki-3duj-553' }) {
  _registry = registry;
  StateManager.setState(s => ({
    ...s,
    project: { ...s.project, name: 'MimakiTest' },
    print: { ...s.print, exportRatios: [1], targetPrinterId },
    selection: { ...s.selection, selectedIds: [] },
    scene: { ...s.scene, objects },
  }), { silent: true });
}

function obj(id) {
  return {
    id, name: id, assetId: 'a1', collectionId: null, parentId: null,
    shaderId: null, visible: true, locked: false,
    isGhost: false, isUnlinked: false, isPrintPart: true,
  };
}

MeshValidator.validateMesh = async () => [];

// ── Tiny runner ──────────────────────────────────────────

let passed = 0, failed = 0;
const out = [];
async function test(name, fn) {
  resetCalls(); toasts.length = 0; _clones = []; zipInstances.length = 0;
  try { await fn(); out.push(`PASS  ${name}`); passed++; }
  catch (err) { out.push(`FAIL  ${name}\n      ${err.stack || err.message}`); failed++; }
}

// ── Content-driven 3MF flavour ────────────────────────────

await test('default Mimaki target + textured mesh → Materials Extension layout', async () => {
  const positions = [0,0,0, 1,0,0, 0,1,0];
  const indices   = [0,1,2];
  const uvs       = [0.1,0.2, 0.3,0.4, 0.5,0.6];
  setScene({
    objects:  { p: obj('p') },
    registry: { p: texMesh('p', { positions, indices, uvs }) },
  });
  await PrintManager.exportThreeMF();

  const files = zipInstances.at(-1).files;
  // Content types must declare PNG so OPC consumers accept the texture parts.
  assert.match(files['[Content_Types].xml'], /Extension="png" ContentType="image\/png"/);
  // Texture binary is in the package on the contractual path.
  assert.ok(files['3D/Textures/paint.png'], 'PNG texture entry present');
  // Per-part relationships file links model → texture.
  assert.ok(files['3D/_rels/3dmodel.model.rels'], 'per-part rels present');
  assert.match(files['3D/_rels/3dmodel.model.rels'], /Target="\/3D\/Textures\/paint\.png"/);
  assert.match(files['3D/_rels/3dmodel.model.rels'], /Type="http:\/\/schemas\.microsoft\.com\/3dmanufacturing\/2013\/01\/3dtexture"/);

  const model = files['3D/3dmodel.model'];
  // texture2d + texture2dgroup resources.
  assert.match(model, /<m:texture2d id="1" path="\/3D\/Textures\/paint\.png" contenttype="image\/png"\/>/);
  assert.match(model, /<m:texture2dgroup id="2" texid="1">/);
  // One <m:tex2coord> per vertex, in vertex order.
  assert.match(model, /<m:tex2coord u="0\.1" v="0\.2"\/>/);
  assert.match(model, /<m:tex2coord u="0\.3" v="0\.4"\/>/);
  assert.match(model, /<m:tex2coord u="0\.5" v="0\.6"\/>/);
  // Object pid points at the texture2dgroup, NOT a colorgroup.
  assert.match(model, /<object id="3" type="model" pid="2">/);
  // Triangle carries p1/p2/p3 mirroring v1/v2/v3 (writer/loader contract).
  // Winding flip means v1,v2,v3 = a,c,b — p triple flips identically.
  assert.match(model, /<triangle v1="0" v2="2" v3="1" p1="0" p2="2" p3="1"\/>/);
  // No colorgroup since every mesh is textured.
  assert.ok(!/<m:colorgroup/.test(model), 'no colorgroup when every mesh is textured');
});

await test('Bambu target + textured mesh → Materials Extension layout (printer does not choose format)', async () => {
  const positions = [0,0,0, 1,0,0, 0,1,0];
  const indices   = [0,1,2];
  const uvs       = [0.1,0.2, 0.3,0.4, 0.5,0.6];
  setScene({
    objects:  { p: obj('p') },
    registry: { p: texMesh('p', { positions, indices, uvs }) },
    targetPrinterId: 'bambu-x1c',
  });
  await PrintManager.exportThreeMF();

  const files = zipInstances.at(-1).files;
  assert.match(files['[Content_Types].xml'], /Extension="png" ContentType="image\/png"/);
  assert.ok(files['3D/Textures/paint.png'], 'PNG texture entry present');
  assert.ok(files['3D/_rels/3dmodel.model.rels'], 'per-part rels present');
  const model = files['3D/3dmodel.model'];
  assert.match(model, /<m:texture2d id="1" path="\/3D\/Textures\/paint\.png" contenttype="image\/png"\/>/);
  assert.match(model, /<object id="3" type="model" pid="2">/);
  assert.ok(!/<m:colorgroup/.test(model), 'no colorgroup when every mesh is textured');
});

await test('solid-only 3MF uses colorgroup regardless of printer target', async () => {
  setScene({
    objects:  { m: obj('m') },
    registry: { m: solidMesh('m', { color: { r: 0, g: 1, b: 0 } }) },
    targetPrinterId: 'mimaki-3duj-553',
  });
  await PrintManager.exportThreeMF();
  const files = zipInstances.at(-1).files;
  assert.equal(files['[Content_Types].xml'].includes('png'), false,
    'no png content-type on solid-only colorgroup path');
  assert.equal(files['3D/_rels/3dmodel.model.rels'], undefined,
    'no rels file when no textures landed');
  const model = files['3D/3dmodel.model'];
  assert.match(model, /<m:colorgroup id="1">/);
  assert.match(model, /<m:color color="#00FF00FF"\/>/);
  assert.match(model, /<object id="2" type="model" pid="1" pindex="0">/);
  assert.ok(!/<m:texture2d/.test(model), 'no texture2d resources');
});

await test('Mimaki target + mixed (textured + solid) → both resources, distinct pids', async () => {
  const positions = [0,0,0, 1,0,0, 0,1,0];
  const indices   = [0,1,2];
  const uvs       = [0.0,0.0, 1.0,0.0, 0.0,1.0];
  setScene({
    objects:  { t: obj('t'), s: obj('s') },
    registry: {
      t: texMesh('t', { positions, indices, uvs, textureName: 'wood' }),
      s: solidMesh('s', { color: { r: 0, g: 0, b: 1 } }),
    },
    targetPrinterId: 'mimaki-3duj-553',
  });
  await PrintManager.exportThreeMF();
  const files = zipInstances.at(-1).files;
  assert.ok(files['3D/Textures/wood.png']);
  const model = files['3D/3dmodel.model'];
  // Resource ids: tex2d=1, tex2dgroup=2, colorgroup=3, objects=4,5.
  assert.match(model, /<m:texture2d id="1"/);
  assert.match(model, /<m:texture2dgroup id="2" texid="1">/);
  assert.match(model, /<m:colorgroup id="3">/);
  // Textured object points at tex2dgroup id (no pindex).
  assert.match(model, /<object id="4" type="model" pid="2">/);
  // Solid object points at colorgroup id + pindex.
  assert.match(model, /<object id="5" type="model" pid="3" pindex="0">/);
});

// ── Round-trip integrity (writer contract) ───────────────

await test('round-trip: UVs survive the writer in vertex order + per-tri p_i==v_i', async () => {
  // Independent UV values so we can detect any swap/permutation in the
  // tex2coord list, and per-triangle p_i mirroring v_i.
  const positions = [0,0,0, 1,0,0, 0,1,0, 1,1,0];     // 4 vertices
  const indices   = [0,1,2,  1,3,2];                  // 2 triangles
  const uvs       = [0.11,0.22, 0.33,0.44, 0.55,0.66, 0.77,0.88];
  setScene({
    objects:  { p: obj('p') },
    registry: { p: texMesh('p', { positions, indices, uvs, textureName: 'paint' }) },
    targetPrinterId: 'mimaki-3duj-553',
  });
  await PrintManager.exportThreeMF();
  const model = zipInstances.at(-1).files['3D/3dmodel.model'];

  // Recover tex2coord ordering from XML — confirms vertex-order indexing.
  const tcRe = /<m:tex2coord u="([0-9.]+)" v="([0-9.]+)"\/>/g;
  const got = [...model.matchAll(tcRe)].map(m => [parseFloat(m[1]), parseFloat(m[2])]);
  assert.deepEqual(got, [[0.11,0.22],[0.33,0.44],[0.55,0.66],[0.77,0.88]]);

  // For every triangle, p1/p2/p3 must equal v1/v2/v3 (writer/loader contract).
  const triRe = /<triangle v1="(\d+)" v2="(\d+)" v3="(\d+)" p1="(\d+)" p2="(\d+)" p3="(\d+)"\/>/g;
  let triCount = 0;
  for (const m of model.matchAll(triRe)) {
    assert.equal(m[1], m[4], 'p1 mirrors v1');
    assert.equal(m[2], m[5], 'p2 mirrors v2');
    assert.equal(m[3], m[6], 'p3 mirrors v3');
    triCount++;
  }
  assert.equal(triCount, 2, 'both triangles emitted with p attributes');

  // Pseudo-loader: rebuild per-vertex UVs the way ThreeMFLoader does — walk
  // triangles, write coords[p_i] into uvs[v_i*2]. Compare to input UVs.
  const reconstructed = new Array(4 * 2).fill(0);
  for (const m of model.matchAll(triRe)) {
    const v1 = +m[1], v2 = +m[2], v3 = +m[3];
    const p1 = +m[4], p2 = +m[5], p3 = +m[6];
    reconstructed[v1*2]   = got[p1][0]; reconstructed[v1*2+1] = got[p1][1];
    reconstructed[v2*2]   = got[p2][0]; reconstructed[v2*2+1] = got[p2][1];
    reconstructed[v3*2]   = got[p3][0]; reconstructed[v3*2+1] = got[p3][1];
  }
  assert.deepEqual(reconstructed.map(n => +n.toFixed(6)), uvs);
});

await test('texture dedup: two meshes referencing the same texture asset share one m:texture2d', async () => {
  const positions = [0,0,0, 1,0,0, 0,1,0];
  const indices   = [0,1,2];
  const uvs       = [0,0, 1,0, 0,1];
  // Both meshes use the SAME texture object (same name + same bytes path).
  const shared = texMesh('shared', { positions, indices, uvs, textureName: 'shared' });
  const m1 = texMesh('m1', { positions, indices, uvs, textureName: 'shared' });
  // Force the same texture instance so _getAssetIdForTexture dedups.
  m1.material = { ...m1.material, diffuseTexture: shared.material.diffuseTexture };
  const m2 = texMesh('m2', { positions, indices, uvs, textureName: 'shared' });
  m2.material = { ...m2.material, diffuseTexture: shared.material.diffuseTexture };

  setScene({
    objects:  { a: obj('a'), b: obj('b') },
    registry: { a: m1, b: m2 },
    targetPrinterId: 'mimaki-3duj-553',
  });
  await PrintManager.exportThreeMF();
  const model = zipInstances.at(-1).files['3D/3dmodel.model'];

  // Exactly one m:texture2d, exactly two m:texture2dgroups, both texid="1".
  const tex2dCount   = (model.match(/<m:texture2d /g) || []).length;
  const tex2dGroups  = (model.match(/<m:texture2dgroup /g) || []).length;
  assert.equal(tex2dCount, 1, `expected 1 m:texture2d, got ${tex2dCount}`);
  assert.equal(tex2dGroups, 2, `expected 2 m:texture2dgroup, got ${tex2dGroups}`);
  assert.equal((model.match(/texid="1"/g) || []).length, 2, 'both groups bind to tex id 1');
});

// ── Report ───────────────────────────────────────────────

console.log('\n' + out.join('\n'));
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
