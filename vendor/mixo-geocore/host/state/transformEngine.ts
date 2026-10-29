/**
 * The Rust matrix calls `state/transform` runs on. The host registers its engine once it is ready
 * (`geometryReady` in each realm; tests and Node scripts register the pkg-node build). Interactive
 * transforms are synchronous, so the engine is held here rather than awaited per call.
 */
export interface TransformEngine {
  placement_matrix(position: Float64Array, rotation: Float64Array): Float64Array;
  invert_matrix(matrix: Float64Array): Float64Array;
  transform_positions(positions: Float32Array, matrix: Float64Array, handedness: number): Float32Array;
  transformed_min_y(positions: Float32Array, matrix: Float64Array): number;
  transform_vectors(values: Float64Array, matrix: Float64Array, direction: boolean): Float64Array;
}

let current: TransformEngine | undefined;

/** Registers this realm's engine; `workers/geometryClient.geometryReady` calls it. */
export function setTransformEngine(engine: TransformEngine): void {
  current = engine;
}

/** The registered engine; throws when `geometryReady()` has not resolved in this realm. */
export function transformEngine(): TransformEngine {
  if (!current) throw new Error('Geometry engine is not ready: await geometryReady() before transforming');
  return current;
}
