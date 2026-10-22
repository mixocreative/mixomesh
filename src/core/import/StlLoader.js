// STL on the main thread = the worker's parse core (stlParse → welded,
// crease-split, flat-shaded meshes), registered as the `.stl` SceneLoader
// plugin in place of Babylon's unwelded STLFileLoader. One STL import: a
// file gives the same vertex count, validation input and OBJ `vn` decision
// whether the worker ran or the main-thread fallback did (thermo 02/F5).

import { importStlBuffer } from './meshImportCore.js';
import { markFlat } from '../scene/FlatShading.js';

const BABYLON = window.BABYLON;

let _registered = false;

/** Welded STL meshes → container, mirroring STLFileLoader.loadAssetContainer. */
export function buildStlContainer(scene, meshes) {
  const container = new BABYLON.AssetContainer(scene);
  scene._blockEntityCollection = true;
  try {
    for (const m of meshes) {
      const mesh = new BABYLON.Mesh(m.name || 'stlmesh', scene);
      const vd = new BABYLON.VertexData();
      vd.positions = m.positions;
      vd.normals = m.normals;
      vd.indices = m.indices;
      vd.applyToMesh(mesh);
      // Welded geometry, faceted look: STL always rendered flat (review I1).
      markFlat(mesh);
      mesh.computeWorldMatrix(true);
      container.meshes.push(mesh);
    }
  } finally {
    scene._blockEntityCollection = false;
  }
  return container;
}

/** STL bytes → container through the shared core (what the worker path builds). */
export function stlContainerFromBuffer(scene, data) {
  const { result } = importStlBuffer(data);
  if (!result.meshes.length) throw new Error('STL: no geometry found in file');
  return buildStlContainer(scene, result.meshes);
}

/** Register the `.stl` SceneLoader plugin exactly once (replaces Babylon's). Idempotent. */
export function registerStlLoader() {
  if (_registered || !BABYLON?.SceneLoader?.RegisterPlugin) return;
  _registered = true;
  BABYLON.SceneLoader.RegisterPlugin({
    name: 'mixo-stl',
    extensions: { '.stl': { isBinary: true } },
    canDirectLoad: () => false,
    async loadAssetContainerAsync(scene, data) { return stlContainerFromBuffer(scene, data); },
    async importMeshAsync(_meshNames, scene, data) {
      const c = stlContainerFromBuffer(scene, data);
      return { meshes: c.meshes, particleSystems: [], skeletons: [], animationGroups: [], transformNodes: [], geometries: [], lights: [] };
    },
    async loadAsync(scene, data) { stlContainerFromBuffer(scene, data).addAllToScene(); },
  });
}

registerStlLoader();
