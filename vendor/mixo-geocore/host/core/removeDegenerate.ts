/*
 * Explicit repair, never implicit: removes triangles with a repeated corner or zero area.
 * Nothing in the host calls this on its own; a caller that wants the clean-up asks for it and
 * reports `removed`. Positions are not touched.
 */
interface RemoveEngine {
  remove_degenerate_triangles(positions: Float32Array, indices: Uint32Array): {
    take_indices(): Uint32Array;
    free(): void;
  };
}

export function removeDegenerateTriangles(
  engine: RemoveEngine,
  positions: Float32Array,
  indices: Uint32Array,
): { indices: Uint32Array; removed: number } {
  const result = engine.remove_degenerate_triangles(positions, indices);
  try {
    const kept = result.take_indices();
    return { indices: kept, removed: (indices.length - kept.length) / 3 };
  } finally {
    result.free();
  }
}
