// One parse core per format (thermo #6): the worker entry point and the
// main-thread SceneLoader plugin give identical geometry for the same bytes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { installEnv } from './env.mjs';
import { binaryStlChunks, threeMFModelChunks } from '../scripts/heavy-mesh/generate.mjs';

installEnv();
const BABYLON = { ...await import('@babylonjs/core') };
globalThis.window.BABYLON = BABYLON;
await import('@babylonjs/loaders/STL/stlFileLoader.js');   // Babylon's own STL plugin registers first
const { DOMParser } = await import('./xml-dom.mjs');
globalThis.DOMParser = DOMParser;
const JSZip = createRequire(import.meta.url)('jszip');
const core = await import('../src/core/import/meshImportCore.js');
const { buildStlContainer } = await import('../src/core/MeshImportWorker.js');
const { buildThreeMFContainerFromParsed, __test: loader } = await import('../src/core/ThreeMFLoader.js');
await import('../src/core/import/StlLoader.js');
loader.useJSZip(JSZip);

const engine = new BABYLON.NullEngine({ renderWidth: 64, renderHeight: 64, textureSize: 64 });
const scene = new BABYLON.Scene(engine);
const dataUrl = (bytes) => `data:application/octet-stream;base64,${Buffer.from(bytes).toString('base64')}`;

function shape(container) {
  return container.meshes.filter(m => m.geometry).map(m => ({
    name: m.name,
    vertices: m.getTotalVertices(),
    positions: [...m.getVerticesData('position')],
    indices: [...m.getIndices()],
    normals: [...(m.getVerticesData('normal') ?? [])],
  }));
}

test('STL: worker core and the .stl SceneLoader plugin build the same mesh', async () => {
  const bytes = Buffer.concat([...binaryStlChunks(9)]);
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length);
  const viaWorker = buildStlContainer(scene, core.importStlBuffer(buffer).result.meshes);
  const viaPlugin = await BABYLON.SceneLoader.LoadAssetContainerAsync(dataUrl(bytes), '', scene, null, '.stl');
  const a = shape(viaWorker), b = shape(viaPlugin);
  assert.equal(a.length, 1);
  assert.deepEqual(a, b);
  assert.ok(a[0].vertices < a[0].indices.length / 2, 'welded, not Babylon\'s unwelded soup');
  assert.equal(viaPlugin.meshes[0].metadata?.flatShaded ?? viaWorker.meshes[0].metadata?.flatShaded,
    viaWorker.meshes[0].metadata?.flatShaded, 'same flat flag');
});

test('3MF: worker core and the .3mf SceneLoader plugin build the same meshes', async () => {
  const xml = [...threeMFModelChunks(8)].join('');
  const zipBytes = await new JSZip()
    .file('_rels/.rels', '<Relationships><Relationship Target="/3D/3dmodel.model" Id="r0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>')
    .file('3D/3dmodel.model', Buffer.from(xml))
    .generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
  const { result } = await core.importThreeMFBuffer(zipBytes.buffer, { JSZip });
  const viaWorker = await buildThreeMFContainerFromParsed(scene, result);
  const viaPlugin = await BABYLON.SceneLoader.LoadAssetContainerAsync(dataUrl(zipBytes), '', scene, null, '.3mf');
  const a = shape(viaWorker), b = shape(viaPlugin);
  assert.ok(a.length >= 1);
  assert.deepEqual(a, b);
  assert.equal(viaWorker.materials.length, viaPlugin.materials.length);
});
