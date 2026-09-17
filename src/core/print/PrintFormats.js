export function createFormats({ serializeOBJ, serializeSTL, serialize3MF }) {
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
  };
}
