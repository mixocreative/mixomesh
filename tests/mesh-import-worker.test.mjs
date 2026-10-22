// Worker import cores vs the main-thread loaders they replace (heavy-mesh task c).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { installEnv } from './env.mjs';
import { binaryStlChunks, threeMFModelChunks } from '../scripts/heavy-mesh/generate.mjs';

installEnv();
const BABYLON = { ...await import('@babylonjs/core') };
globalThis.window.BABYLON = BABYLON;
const { STLFileLoader } = await import('@babylonjs/loaders/STL/stlFileLoader.js');
const { DOMParser } = await import('./xml-dom.mjs');
globalThis.DOMParser = DOMParser;
const JSZip = createRequire(import.meta.url)('jszip');
const core = await import('../src/core/import/meshImportCore.js');
const Loader = await import('../src/core/ThreeMFLoader.js');
const { buildStlContainer } = await import('../src/core/MeshImportWorker.js');
const { mayFallBackToMainThread, MAIN_THREAD_FALLBACK_MAX_BYTES } = await import('../src/core/assets/AssetImport.js');

const engine = new BABYLON.NullEngine({ renderWidth: 64, renderHeight: 64, textureSize: 64 });
const scene = new BABYLON.Scene(engine);

function cornerSoup(mesh) {
  const p = mesh.getVerticesData('position');
  return [...mesh.getIndices()].flatMap(i => [p[i * 3], p[i * 3 + 1], p[i * 3 + 2]]);
}

test('STL via the worker core = Babylon STLFileLoader corner for corner, fewer vertices', () => {
  const bytes = Buffer.concat([...binaryStlChunks(9)]);
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length);
  const { result, transfer } = core.importStlBuffer(buffer);
  assert.equal(transfer.length, 3);
  const ours = buildStlContainer(scene, result.meshes).meshes[0];
  const babylon = new STLFileLoader().loadAssetContainer(scene, buffer, '').meshes[0];
  assert.equal(ours.name, babylon.name);
  assert.deepEqual(cornerSoup(ours), cornerSoup(babylon));
  assert.ok(ours.getTotalVertices() < babylon.getTotalVertices() / 2);
  assert.ok(ours.getIndices() instanceof Uint32Array);
});

test('rels → root model path', () => {
  assert.equal(core.modelPathFromRels('<Relationships><Relationship Target="/3D/x.model" Id="r" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>'), '3D/x.model');
  assert.equal(core.modelPathFromRels(''), '3D/3dmodel.model');
});

test('3MF via the worker core = the SceneLoader plugin path; texture parts come back as bytes', async () => {
  const xml = [...threeMFModelChunks(8)].join('');
  const zipBytes = await new JSZip()
    .file('_rels/.rels', '<Relationships><Relationship Target="/3D/3dmodel.model" Id="r0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>')
    .file('3D/3dmodel.model', Buffer.from(xml))
    .file('3D/Textures/a.png', Buffer.from([137, 80, 78, 71]))
    .generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
  const stages = [];
  const { result } = await core.importThreeMFBuffer(zipBytes.buffer, { JSZip, progress: e => stages.push(e.stage) });
  assert.equal(result.rootPath, '3D/3dmodel.model');
  for (const [, g] of result.models[0].geometry) {
    assert.equal(g.positions.byteLength, g.positions.buffer.byteLength, 'no slack in transferred buffers (review M11)');
    assert.equal(g.triangles.byteLength, g.triangles.buffer.byteLength);
  }
  assert.deepEqual(result.parts.map(([p]) => p).sort(), ['3D/Textures/a.png', '_rels/.rels']);
  assert.ok(stages.includes('parse'));
  const viaWorker = await Loader.buildThreeMFContainerFromParsed(scene, result);
  const viaPlugin = await Loader.__test.buildContainer(scene, await JSZip.loadAsync(zipBytes), xml, { modelPath: '3D/3dmodel.model' });
  assert.equal(viaWorker.meshes.length, viaPlugin.meshes.length);
  assert.deepEqual(cornerSoup(viaWorker.meshes[0]), cornerSoup(viaPlugin.meshes[0]));
});

test('3MF over the triangle budget is refused inside the worker parse', async () => {
  const zipBytes = await new JSZip().file('3D/3dmodel.model', Buffer.from([...threeMFModelChunks(8)].join(''))).generateAsync({ type: 'uint8array' });
  await assert.rejects(core.importThreeMFBuffer(zipBytes.buffer, { JSZip, triangleBudget: 10 }), /polygon handling limit/);
});

test('main-thread fallback only for small files that failed for other reasons', () => {
  assert.equal(mayFallBackToMainThread(new Error('bundle missing'), 1000), true);
  assert.equal(mayFallBackToMainThread(new Error('bundle missing'), MAIN_THREAD_FALLBACK_MAX_BYTES + 1), false);
  assert.equal(mayFallBackToMainThread(Object.assign(new Error('x'), { code: 'timeout' }), 10), false);
  assert.equal(mayFallBackToMainThread(new DOMException('c', 'AbortError'), 10), false);
  assert.equal(mayFallBackToMainThread(Object.assign(new Error('3MF model has 9 triangles'), { code: 'over-budget' }), 10), false);
});
