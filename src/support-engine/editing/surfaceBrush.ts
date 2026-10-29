import type { Vector } from '../core/vec3';

/** A model-surface hit, already converted to the active unit's local coordinate system. */
export interface SurfaceHit {
  point: Vector;
  normal: Vector;
}

/** One immutable brush dab. Consumers choose the semantic meaning of `kind`. */
export interface SurfaceStamp<K extends string> {
  center: Vector;
  radius: number;
  normal: Vector;
  kind: K;
}

/** Converts a completed surface-brush stroke into independently owned, ordered unit-local stamps. */
export function appendSurfaceStamps<K extends string>(kind: K, radius: number, hits: readonly SurfaceHit[]): SurfaceStamp<K>[] {
  if (!Number.isFinite(radius) || radius <= 0) throw new RangeError('surface brush radius must be positive');
  return hits.map(({ point, normal }) => ({ center: [...point], radius, normal: [...normal], kind }));
}
