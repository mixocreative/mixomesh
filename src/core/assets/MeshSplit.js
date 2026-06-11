// Split-on-import: one-mesh-one-shader invariant (split from AssetLoader.js
// — review L29).
//
// Any mesh with a `MultiMaterial` (duck-typed via `mat.subMaterials[]` + >1
// subMeshes) is split into N single-material siblings, one per subMesh.
// Each sibling carries:
//   - its own VertexData copy (positions/normals/uvs + the subMesh's slice
//     of the index buffer — verts are over-copied for simplicity, dead
//     verts cost bytes only, no correctness impact)
//   - the corresponding sub-material as `mesh.material`
//   - `mesh.metadata.sourceGroupId` shared across all siblings of one split
//
// MultiMaterial wrappers are filtered out of `container.materials` so
// ShaderLibrary never mints orphan shader entries for them. The original
// source mesh is disposed.
//
// Pure split spec is in `splitMultiMaterialMeshes` (testable; no Babylon
// constructors). The wrapper that calls Babylon to build real children is
// `splitMultiMaterialMeshesInContainer`.

const BABYLON = window.BABYLON;

let _groupCounter = 0;
const _newGroupId = () => `grp_${Date.now().toString(36)}_${++_groupCounter}`;

/**
 * Pure split planner — walks a list of mesh-like objects and decides which
 * to keep vs. split. Calls `makeChild(spec)` for each new sibling. Caller
 * supplies the factory + group-id generator so this function is testable
 * without a Babylon scene.
 *
 * @param {Array} meshes      live `container.meshes`
 * @param {(spec:{name:string, scene:any, sourceMesh:any, subMaterial:any,
 *                indexStart:number, indexCount:number,
 *                verticesStart:number, verticesCount:number,
 *                groupId:string, partIndex:number})=>any} makeChild
 * @param {()=>string} genGroupId
 * @returns {{meshes:Array, disposed:Array, orphanMultiMaterials:Array}}
 */
export function splitMultiMaterialMeshes(meshes, makeChild, genGroupId) {
  const out = [];
  const disposed = [];
  const orphanMultiMaterials = [];
  for (const mesh of meshes) {
    const mat = mesh.material;
    const isMulti = !!mat && Array.isArray(mat.subMaterials) && mat.subMaterials.length > 0;
    const subs = mesh.subMeshes;
    if (!isMulti) { out.push(mesh); continue; }

    if (!subs || subs.length === 0) {
      // MultiMaterial with no subMeshes — unwrap to first sub-material.
      mesh.material = mat.subMaterials[0] ?? null;
      orphanMultiMaterials.push(mat);
      out.push(mesh);
      continue;
    }
    if (subs.length === 1) {
      // Single subMesh — unwrap to its sub-material, no split needed.
      const sm = subs[0];
      mesh.material = mat.subMaterials[sm.materialIndex] ?? mat.subMaterials[0] ?? null;
      orphanMultiMaterials.push(mat);
      out.push(mesh);
      continue;
    }

    const groupId = genGroupId();
    for (let i = 0; i < subs.length; i++) {
      const sm = subs[i];
      const child = makeChild({
        name: `${mesh.name || 'mesh'}__part${i}`,
        scene: mesh.getScene?.() ?? null,
        sourceMesh: mesh,
        subMaterial: mat.subMaterials[sm.materialIndex] ?? null,
        indexStart:  sm.indexStart,
        indexCount:  sm.indexCount,
        verticesStart: sm.verticesStart ?? 0,
        verticesCount: sm.verticesCount ?? 0,
        groupId,
        partIndex: i,
      });
      out.push(child);
    }
    disposed.push(mesh);
    orphanMultiMaterials.push(mat);
  }
  return { meshes: out, disposed, orphanMultiMaterials };
}

/** Real-Babylon child factory used by the in-container split. */
function _makeBabylonChildMesh(spec) {
  const { name, scene, sourceMesh, subMaterial,
          indexStart, indexCount, groupId } = spec;

  const positions = sourceMesh.getVerticesData?.(BABYLON.VertexBuffer.PositionKind);
  const normals   = sourceMesh.getVerticesData?.(BABYLON.VertexBuffer.NormalKind);
  const uvs       = sourceMesh.getVerticesData?.(BABYLON.VertexBuffer.UVKind);
  const indices   = sourceMesh.getIndices?.();
  const subIdx    = indices ? indices.slice(indexStart, indexStart + indexCount) : [];

  const child = new BABYLON.Mesh(name, scene);
  const vd    = new BABYLON.VertexData();
  // Per-child TYPED copies (review M18). Copies are load-bearing — children
  // sharing one buffer would corrupt each other when a later bake mutates
  // vertex data in place. Typed copies cost ~4 bytes/float vs the old
  // Array.from plain-number arrays (~8+ with boxing) on dense meshes.
  if (positions) vd.positions = new Float32Array(positions);
  if (normals)   vd.normals   = new Float32Array(normals);
  if (uvs)       vd.uvs       = new Float32Array(uvs);
  vd.indices = subIdx;
  vd.applyToMesh(child);

  child.material = subMaterial ?? null;
  child.parent   = sourceMesh.parent ?? null;
  if (sourceMesh.position?.clone) child.position = sourceMesh.position.clone();
  if (sourceMesh.scaling?.clone)  child.scaling  = sourceMesh.scaling.clone();
  if (sourceMesh.rotationQuaternion?.clone) {
    child.rotationQuaternion = sourceMesh.rotationQuaternion.clone();
  } else if (sourceMesh.rotation?.clone) {
    child.rotation = sourceMesh.rotation.clone();
  }
  child.metadata = { ...(sourceMesh.metadata ?? {}), sourceGroupId: groupId };
  return child;
}

/**
 * Wrapper: split every MultiMaterial mesh in `container.meshes`, prune the
 * MultiMaterial wrappers from `container.materials`, dispose source meshes.
 * Called from every import / restore entry point so the rest of the pipeline
 * only ever sees single-material meshes.
 */
export function splitMultiMaterialMeshesInContainer(container) {
  const result = splitMultiMaterialMeshes(
    container.meshes ?? [],
    _makeBabylonChildMesh,
    _newGroupId
  );
  container.meshes = result.meshes;
  for (const m of result.disposed) {
    try { m.dispose?.(); } catch { /* fall through */ }
  }
  if (Array.isArray(container.materials) && result.orphanMultiMaterials.length) {
    const orphans = new Set(result.orphanMultiMaterials);
    container.materials = container.materials.filter(mat => {
      if (orphans.has(mat)) {
        try { mat.dispose?.(); } catch { /* fall through */ }
        return false;
      }
      return true;
    });
  }
}
