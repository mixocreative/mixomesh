import { validateRefinedGeometry } from '../MixoRefinementWorker.js';

/** Create a temporary single-material sibling only after validating worker output. */
export function createDerivedMesh(source, geometry, originalInput, level, scene = source.getScene()) {
  validateRefinedGeometry(geometry, originalInput, level);
  const B = window.BABYLON;
  const mesh = new B.Mesh(`${source.name} · refined L${level}`, scene);
  try {
    const data = new B.VertexData();
    data.positions = geometry.positions;
    data.indices = geometry.indices;
    data.normals = geometry.normals;
    if (geometry.uvs) data.uvs = geometry.uvs;
    data.applyToMesh(mesh);
    mesh.material = source.material;
    mesh.sideOrientation = source.sideOrientation;
    mesh.parent = source.parent;
    mesh.position.copyFrom(source.position);
    mesh.scaling.copyFrom(source.scaling);
    if (source.rotationQuaternion) mesh.rotationQuaternion = source.rotationQuaternion.clone();
    else mesh.rotation.copyFrom(source.rotation);
    mesh.isPickable = false;
    mesh.metadata = { mixoDerivedPreview: true, sourceMeshId: source.id, level };
    return mesh;
  } catch (error) { mesh.dispose(); throw error; }
}

/** Build one temporary sibling per material source in matching order. */
export function createDerivedMeshes(sources, geometries, originalInputs, level) {
  if (!Array.isArray(sources) || !Array.isArray(geometries) || !Array.isArray(originalInputs)
    || sources.length === 0 || sources.length !== geometries.length || sources.length !== originalInputs.length) {
    throw new Error('invalid refinement material batch');
  }
  geometries.forEach((geometry, i) => validateRefinedGeometry(geometry, originalInputs[i], level));
  const created = [];
  try {
    for (let i = 0; i < sources.length; i++) created.push(createDerivedMesh(sources[i], geometries[i], originalInputs[i], level));
    return created;
  } catch (error) { for (const mesh of created) mesh.dispose(); throw error; }
}
