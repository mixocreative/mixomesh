/**
 * Runtime support caches (plan P3.1), never state: the generated support mesh and the automatic
 * placement per object id. A mesh entry is valid only for the revision it was built from
 * (`object.supports.revision`, monotonic across undo), so any edit or undo invalidates it by itself.
 * The placement is derived data (the same geometry and placement settings give the same ids), held
 * here for Add snapping and regeneration and recomputed after a project load.
 */
import type { SupportPoint } from '@mixo-geocore/host/core/analysis/types';
import type { GeneratedSupportMesh } from '@mixo-geocore/host/core/supports/mesh';

const meshes = new Map<string, { revision: number; mesh: GeneratedSupportMesh }>();
const placements = new Map<string, readonly SupportPoint[]>();

export function cachedSupportMesh(objectId: string, revision: number): GeneratedSupportMesh | undefined {
  const hit = meshes.get(objectId);
  return hit && hit.revision === revision ? hit.mesh : undefined;
}

export function cacheSupportMesh(objectId: string, revision: number, mesh: GeneratedSupportMesh): void {
  meshes.set(objectId, { revision, mesh });
}

/** Forget the support mesh of one object (nothing is built for it now), keeping its placement. */
export function dropSupportMesh(objectId: string): void {
  meshes.delete(objectId);
}

export function cachedPlacement(objectId: string): readonly SupportPoint[] | undefined {
  return placements.get(objectId);
}

export function cachePlacement(objectId: string, points: readonly SupportPoint[] | undefined): void {
  if (points) placements.set(objectId, points);
  else placements.delete(objectId);
}

/** Drop everything of one object, or of all (project new / load). */
export function forgetSupportCaches(objectId?: string): void {
  if (objectId === undefined) {
    meshes.clear();
    placements.clear();
    return;
  }
  meshes.delete(objectId);
  placements.delete(objectId);
}
