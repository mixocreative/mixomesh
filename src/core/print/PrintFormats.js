export function createFormats({ serializeOBJ, serializeSTL, serialize3MF, serializePLY, serializeWRL }) {
  return {
    obj: {
      label: 'OBJ + MTL',
      needsCSG: false,
      prep: ['fallbackMaterial', 'flattenWorld', 'weld', 'repair', 'optimizeIndices', 'createNormals'],
      serialize: serializeOBJ,
    },
    stl: {
      label: 'STL',
      needsCSG: true,
      prep: ['flattenWorld', 'weld', 'repair', 'optimizeIndices', 'csg', 'createNormals'],
      serialize: serializeSTL,
    },
    '3mf': {
      label: '3MF',
      needsCSG: true,
      prep: ['fallbackMaterial', 'flattenWorld', 'weldSolidOnly', 'repair', 'optimizeIndices', 'csgSolidOnly', 'createNormals'],
      serialize: serialize3MF,
    },
    // PLY + WRL carry colour/UVs, so like OBJ they never CSG re-bake
    // (Manifold output drops UVs and would flatten the vertex colours).
    ply: {
      label: 'PLY',
      needsCSG: false,
      prep: ['fallbackMaterial', 'flattenWorld', 'weld', 'repair', 'optimizeIndices', 'createNormals'],
      serialize: serializePLY,
    },
    wrl: {
      label: 'VRML',
      needsCSG: false,
      prep: ['fallbackMaterial', 'flattenWorld', 'weld', 'repair', 'optimizeIndices', 'createNormals'],
      serialize: serializeWRL,
    },
  };
}
