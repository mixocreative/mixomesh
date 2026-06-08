export function createFormats({ serializeOBJ, serializeSTL, serialize3MF }) {
  return {
    obj: {
      label: 'OBJ + MTL',
      needsCSG: false,
      prep: ['fallbackMaterial', 'flattenWorld', 'weld', 'optimizeIndices', 'createNormals'],
      serialize: serializeOBJ,
    },
    stl: {
      label: 'STL',
      needsCSG: true,
      prep: ['flattenWorld', 'weld', 'optimizeIndices', 'csg', 'createNormals'],
      serialize: serializeSTL,
    },
    '3mf': {
      label: '3MF',
      needsCSG: true,
      prep: ['fallbackMaterial', 'flattenWorld', 'weldSolidOnly', 'optimizeIndices', 'csgSolidOnly', 'createNormals'],
      serialize: serialize3MF,
    },
  };
}
