import assert from 'node:assert/strict';
import { NullEngine, Scene, SceneLoader } from '@babylonjs/core';
import '@babylonjs/loaders';
import '../src/core/import/MixoPrimitiveExtras.js';
import { extractMixoRefinement, extractMixoProvenance } from '../src/core/import/ImportMetadata.js';

function makeGlb() {
  const positions = new Float32Array([
    0, 0, 0, 1, 0, 0, 0, 1, 0,
    0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1,
  ]);
  const binary = Buffer.from(positions.buffer);
  const json = {
    asset: { version: '2.0' },
    buffers: [{ byteLength: binary.length }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }, { buffer: 0, byteOffset: 36, byteLength: 48 }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' },
      { bufferView: 1, componentType: 5126, count: 4, type: 'VEC3' },
    ],
    meshes: [{ primitives: [
      { attributes: { POSITION: 0 }, extras: { mixo_print_refinement: { version: 1, creaseByVertex: [0, 0.5, 1], sharpEdges: [[0, 1, 1]] } } },
      { attributes: { POSITION: 1 }, extras: { mixo_print_refinement: { version: 1, creaseByVertex: [0, 0, 0, 1], sharpEdges: [[2, 3, 0.5]] } } },
    ] }],
    nodes: [{ mesh: 0, extras: { mixo_origin: 'mixo3d', mixo_marker_version: 1, mixo_viewport_subdiv_level: 1, mixo_render_subdiv_level: 2 } }],
    scenes: [{ nodes: [0] }], scene: 0,
  };
  const jsonBytes = Buffer.from(JSON.stringify(json));
  const paddedJson = Buffer.concat([jsonBytes, Buffer.alloc((4 - jsonBytes.length % 4) % 4, 0x20)]);
  const out = Buffer.alloc(12 + 8 + paddedJson.length + 8 + binary.length);
  out.writeUInt32LE(0x46546c67, 0);
  out.writeUInt32LE(2, 4);
  out.writeUInt32LE(out.length, 8);
  out.writeUInt32LE(paddedJson.length, 12);
  out.writeUInt32LE(0x4e4f534a, 16);
  paddedJson.copy(out, 20);
  const offset = 20 + paddedJson.length;
  out.writeUInt32LE(binary.length, offset);
  out.writeUInt32LE(0x004e4942, offset + 4);
  binary.copy(out, offset + 8);
  return out;
}

const engine = new NullEngine();
const scene = new Scene(engine);
try {
  const url = `data:application/octet-stream;base64,${makeGlb().toString('base64')}`;
  const container = await SceneLoader.LoadAssetContainerAsync(url, '', scene, null, '.glb');
  const meshes = container.meshes.filter(mesh => mesh.geometry);
  assert.equal(meshes.length, 2);
  assert.deepEqual(meshes.map(mesh => mesh.getTotalVertices()), [3, 4]);
  assert.ok(meshes.every(mesh => extractMixoProvenance(mesh)));
  assert.deepEqual(meshes.map(mesh => [...extractMixoRefinement(mesh).creaseByVertex]), [[0, 0.5, 1], [0, 0, 0, 1]]);
  assert.notEqual(meshes[0].metadata.mixoPrimitiveId, meshes[1].metadata.mixoPrimitiveId);
  container.dispose();
} finally {
  scene.dispose();
  engine.dispose();
}
