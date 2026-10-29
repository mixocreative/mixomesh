import type { Vector } from '../host/core/vec3';

/** A model-surface hit, already converted to the active unit's local coordinate system. */
export interface SurfaceHit {
  point: Vector;
  normal: Vector;
}

import type { SurfaceStamp } from '../host/core/supports/zones';
export type { SurfaceStamp };

/** Converts a completed surface-brush stroke into independently owned, ordered unit-local stamps. */
export function appendSurfaceStamps<K extends string>(kind: K, radius: number, hits: readonly SurfaceHit[]): SurfaceStamp<K>[] {
  if (!Number.isFinite(radius) || radius <= 0) throw new RangeError('surface brush radius must be positive');
  return hits.map(({ point, normal }) => ({ center: [...point], radius, normal: [...normal], kind }));
}
