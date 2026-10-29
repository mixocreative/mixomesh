import type { TriangleMesh } from '../core/analysis/types';
import type { Placement } from '../core/transform';
import type { Vector } from '../core/vec3';
import { transformEngine } from './transformEngine';

/** A unit's placement on the plate: position in mm, rotation as Euler XYZ in radians. */
export type ModelTransform = Placement;

export const identityTransform: ModelTransform = {
  position: [0, 0, 0],
  rotation: [0, 0, 0],
};

const placement = (transform: ModelTransform): Float64Array => transformEngine().placement_matrix(Float64Array.from(transform.position), Float64Array.from(transform.rotation));
const inverse = (transform: ModelTransform): Float64Array => transformEngine().invert_matrix(placement(transform));
const through = (matrix: Float64Array, value: readonly number[], direction: boolean): Vector => {
  const out = transformEngine().transform_vectors(Float64Array.of(value[0]!, value[1]!, value[2]!), matrix, direction);
  return [out[0]!, out[1]!, out[2]!];
};

export function applyTransform(mesh: TriangleMesh, transform: ModelTransform): TriangleMesh {
  return { positions: transformEngine().transform_positions(mesh.positions, placement(transform), 0), indices: new Uint32Array(mesh.indices) };
}

/** Maps every vertex of a mesh from world space back into unit-local space. */
export function inverseTransformMesh<T extends TriangleMesh>(mesh: T, transform: ModelTransform): T {
  return { ...mesh, positions: transformEngine().transform_positions(mesh.positions, inverse(transform), 0) };
}

/** Lowest plate-space y of positions placed by `transform` (Rust; no copy of the transformed mesh). */
export function transformedMinY(positions: Float32Array, transform: ModelTransform): number {
  return transformEngine().transformed_min_y(positions, placement(transform));
}

/** Unit-local point to world (plate) space. */
export function transformPoint(transform: ModelTransform, point: readonly number[]): Vector {
  return through(placement(transform), point, false);
}

/** World (plate) point to unit-local space. */
export function inverseTransformPoint(transform: ModelTransform, point: readonly number[]): Vector {
  return through(inverse(transform), point, false);
}

export function transformDirection(transform: ModelTransform, direction: readonly number[]): Vector {
  return through(placement(transform), direction, true);
}

export function inverseTransformDirection(transform: ModelTransform, direction: readonly number[]): Vector {
  return through(inverse(transform), direction, true);
}

/** Model and support vertices share the unit's single parent transform. */
export function unitWorldTransform(unit: { transform: ModelTransform }, vertex: readonly number[]): Vector {
  return transformPoint(unit.transform, vertex);
}
