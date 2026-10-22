// cia B-14: a 3MF texture part that cannot be read never vanishes silently.
// A texture that a triangle group REFERENCES makes the import fail with the
// named "embedded texture" error (strict refs, commit b4b33cc), so the user
// sees the loss before anything imports; an UNREFERENCED unreadable part loses
// nothing and imports normally.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installEnv } from './env.mjs';

installEnv();
const BABYLON = { ...await import('@babylonjs/core') };
BABYLON.Texture = class { constructor(url) { this.url = url; } };
globalThis.window.BABYLON = BABYLON;
globalThis.window.removeEventListener = () => {};
globalThis.document.addEventListener = () => {};
globalThis.document.removeEventListener = () => {};
console.error = () => {};
const { DOMParser } = await import('./xml-dom.mjs');
globalThis.DOMParser = DOMParser;

const Loader = await import('../src/core/ThreeMFLoader.js');
const { classifyImportFailure } = await import('../src/core/import/ImportFailure.js');

const scene = new BABYLON.Scene(new BABYLON.NullEngine());
URL.createObjectURL ??= () => 'blob:fake';

function model({ referenced }) {
  return '<?xml version="1.0" encoding="UTF-8"?>'
    + '<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"'
    + ' xmlns:m="http://schemas.microsoft.com/3dmanufacturing/material/2015/02"><resources>'
    + '<m:texture2d id="1" path="/3D/Texture/skin.png" contenttype="image/png"/>'
    + '<m:texture2dgroup id="2" texid="1"><m:tex2coord u="0" v="0"/><m:tex2coord u="1" v="0"/><m:tex2coord u="0" v="1"/></m:texture2dgroup>'
    + '<object id="3" type="model"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="10" y="0" z="0"/><vertex x="0" y="10" z="0"/></vertices>'
    + `<triangles><triangle v1="0" v2="1" v3="2"${referenced ? ' pid="2" p1="0" p2="1" p3="2"' : ''}/></triangles></mesh></object>`
    + '</resources><build><item objectid="3"/></build></model>';
}

const zipWith = (mode) => ({
  file: (p) => {
    if (mode === 'missing' || p !== '3D/Texture/skin.png') return null;
    return { async: () => Promise.reject(new Error('bad deflate data')) };
  },
});

for (const mode of ['missing', 'undecodable']) {
  test(`a referenced ${mode} texture fails the import with the embedded-texture error`, async () => {
    const run = Loader.__test.buildContainer(scene, zipWith(mode), model({ referenced: true }), { modelPath: '3D/3dmodel.model' });
    await assert.rejects(run, (err) => {
      assert.equal(classifyImportFailure(err, 'skin.3mf').category, 'embeddedTexture');
      return true;
    });
  });
}

test('an unreferenced unreadable texture loses nothing and imports normally', async () => {
  const container = await Loader.__test.buildContainer(scene, zipWith('undecodable'), model({ referenced: false }), { modelPath: '3D/3dmodel.model' });
  assert.equal(container.meshes.length, 1);
});
