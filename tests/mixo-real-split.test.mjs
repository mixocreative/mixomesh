import assert from 'node:assert/strict';
import * as BABYLON from '@babylonjs/core';
import { extractMixoRefinement, mixoPrimitiveId } from '../src/core/import/ImportMetadata.js';

globalThis.window = { BABYLON, addEventListener() {}, removeEventListener() {} };
const { splitMultiMaterialMeshesInContainer } = await import('../src/core/assets/MeshSplit.js');

const engine = new BABYLON.NullEngine();
const scene = new BABYLON.Scene(engine);
try {
  const source = new BABYLON.Mesh('primitive', scene);
  const data = new BABYLON.VertexData();
  data.positions = new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]);
  data.indices = new Uint32Array([0, 1, 2, 0, 2, 3]);
  data.applyToMesh(source);
  const material = new BABYLON.MultiMaterial('multi', scene);
  material.subMaterials = [new BABYLON.StandardMaterial('a', scene), new BABYLON.StandardMaterial('b', scene)];
  source.material = material;
  source.subMeshes = [];
  new BABYLON.SubMesh(0, 0, 4, 0, 3, source);
  new BABYLON.SubMesh(1, 0, 4, 3, 3, source);
  source.metadata = {
    mixoPrimitiveId: 'gltf:0:primitive:0',
    mixoPrimitiveRefinement: { version: 1, creaseByVertex: [0, 1, 0, 0], sharpEdges: [[0, 1, 0.75]] },
    gltf: { extras: { mixo_origin: 'mixo3d', mixo_marker_version: 1, mixo_viewport_subdiv_level: 1, mixo_render_subdiv_level: 2 } },
  };
  const container = { meshes: [source], materials: [material, ...material.subMaterials] };
  splitMultiMaterialMeshesInContainer(container);
  assert.equal(container.meshes.length, 2);
  for (const child of container.meshes) {
    assert.equal(child.getTotalVertices(), 4, 'split preserves primitive-local vertex indices');
    assert.equal(mixoPrimitiveId(child), 'gltf:0:primitive:0');
    const refinement = extractMixoRefinement(child);
    assert.deepEqual([...refinement.creaseByVertex], [0, 1, 0, 0]);
    assert.deepEqual([...child.getIndices()].filter(index => index > 3), []);
  }
  assert.deepEqual([...container.meshes[0].getIndices()], [0, 1, 2]);
  assert.deepEqual([...container.meshes[1].getIndices()], [0, 2, 3]);
} finally {
  scene.dispose();
  engine.dispose();
}
