import assert from 'node:assert/strict';
import { installEnv } from './env.mjs';

installEnv();
const { registerInstantiatedMeshes } = await import('../src/core/assets/AssetRegistration.js');
const { getState } = await import('../src/core/StateManager.js');

const marker = { mixo_origin: 'mixo3d', mixo_marker_version: 1, mixo_viewport_subdiv_level: 1, mixo_render_subdiv_level: 2 };
const parent = { metadata: { gltf: { extras: marker } } };
function mesh(name, id, payload) {
  return {
    name, parent, geometry: {}, material: null, isVisible: true,
    getTotalVertices: () => 3,
    metadata: { mixoPrimitiveId: id, ...(payload ? { mixoPrimitiveRefinement: payload } : {}) },
  };
}
const payload = { version: 1, creaseByVertex: [0, 1, 0], sharpEdges: [[0, 1, 0.5]] };
const meshes = [mesh('part_primitive0', 'gltf:0:primitive:0', null), mesh('part_primitive1', 'gltf:0:primitive:1', payload)];
const ids = registerInstantiatedMeshes({ meshes }, 'asset-mixo', 'mm', new Map(), null, { originNodeKey: () => 'same-node' });
assert.equal(ids.length, 2);
const lead = getState().scene.objects[ids[0]];
const sibling = getState().scene.objects[ids[1]];
assert.ok(lead.mixoProvenance);
assert.equal(lead.mixoRefinement?.length, 1, 'sibling payload is attached even if lead has none');
assert.equal(lead.mixoRefinement[0].primitiveId, 'gltf:0:primitive:1');
assert.equal(sibling.mixoRefinement, undefined);
