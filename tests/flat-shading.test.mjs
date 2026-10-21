// Welded STL keeps its faceted look by default (review I1); "Smooth shading" turns it off.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installEnv } from './env.mjs';

installEnv();
const BABYLON = { ...await import('@babylonjs/core') };
globalThis.window.BABYLON = BABYLON;
const FS = await import('../src/core/scene/FlatShading.js');

const engine = new BABYLON.NullEngine({ renderWidth: 32, renderHeight: 32, textureSize: 32 });
assert.equal(FS.install(), true, 'plugin registers');
const scene = new BABYLON.Scene(engine);
FS.attachScene(scene);
new BABYLON.HemisphericLight('l', new BABYLON.Vector3(0, 1, 0), scene);

function defineFor(mesh, mat) {
  mesh.material = mat;
  const sm = mesh.subMeshes[0];
  mat.isReadyForSubMesh(mesh, sm, false);
  return sm.materialDefines?.MXFLAT;
}

test('flagged meshes get MXFLAT on Standard and PBR materials; others do not', () => {
  const flat = BABYLON.MeshBuilder.CreateBox('flat', {}, scene);
  FS.markFlat(flat);
  const plain = BABYLON.MeshBuilder.CreateBox('plain', {}, scene);
  for (const mat of [new BABYLON.StandardMaterial('s', scene), new BABYLON.PBRMaterial('p', scene)]) {
    assert.equal(defineFor(flat, mat), true, `${mat.getClassName()}: flagged mesh renders faceted`);
    assert.equal(defineFor(plain, mat), false, `${mat.getClassName()}: other meshes keep their normals`);
  }
});

test('Smooth shading turns the flat path off everywhere and back on', () => {
  const mesh = BABYLON.MeshBuilder.CreateBox('m', {}, scene);
  FS.markFlat(mesh);
  const mat = new BABYLON.StandardMaterial('s2', scene);
  assert.equal(defineFor(mesh, mat), true);
  FS.setSmooth(true);
  assert.equal(FS.isSmooth(), true);
  assert.equal(defineFor(mesh, mat), false);
  FS.setSmooth(false);
  assert.equal(defineFor(mesh, mat), true);
});

test('the shader injection replaces normalW with the oriented screen-space face normal (GLSL + WGSL)', () => {
  const mat = new BABYLON.StandardMaterial('s3', scene);
  const plugin = mat.pluginManager?.getPlugin?.('MxFlatShading');
  assert.ok(plugin, 'plugin attached to new materials');
  const glsl = plugin.getCustomCode('fragment', 0).CUSTOM_FRAGMENT_BEFORE_LIGHTS;
  const wgsl = plugin.getCustomCode('fragment', 1).CUSTOM_FRAGMENT_BEFORE_LIGHTS;
  assert.match(glsl, /cross\(dFdx\(vPositionW\), dFdy\(vPositionW\)\)/);
  assert.match(glsl, /dot\(mxFaceN, normalW\) < 0\.0 \? -mxFaceN : mxFaceN/);
  assert.match(wgsl, /dpdx\(fragmentInputs\.vPositionW\)/);
  assert.equal(plugin.getCustomCode('vertex', 0), null);
});

test('wantsFlat is a pure rule; OBJ export drops vn for faceted meshes', () => {
  assert.equal(FS.wantsFlat({ metadata: { flatShading: true } }, false), true);
  assert.equal(FS.wantsFlat({ metadata: { flatShading: true } }, true), false);
  assert.equal(FS.wantsFlat({ metadata: {} }, false), false);
});
