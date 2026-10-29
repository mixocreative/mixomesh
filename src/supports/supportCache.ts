/**
 * Runtime support caches (plan P3.1), never state: the generated support mesh and the automatic
 * placement per object id. A mesh entry is valid only for the revision it was built from
 * (`object.supports.revision`, monotonic across undo), so any edit or undo invalidates it by itself.
 * The placement is derived data (the same geometry and placement settings give the same ids), held
 * here for Add snapping and regeneration and recomputed after a project load.
 */
import type { SupportPoint } from '@mixo-geocore/host/core/analysis/types';
import type { GeneratedSupportMesh } from '@mixo-geocore/host/core/supports/mesh';
import { setSupportFiguresLookup, setSupportMeshLookup } from '../core/scene/SupportMeshSource.js';
import { dispatch } from '../core/StateManager.js';
import { EVENTS } from '../core/events.js';

const meshes = new Map<string, { revision: number; mesh: GeneratedSupportMesh }>();
/** Export-build figures per object (P4.3b, D24: volume and triangle count only, never the mesh). */
export type SupportFigures = { revision: number; scale: number } & ({ volumeMM3: number; triangles: number; failed?: never } | { failed: true });
const figures = new Map<string, SupportFigures>();
const placements = new Map<string, readonly SupportPoint[]>();

export function cachedSupportMesh(objectId: string, revision: number): GeneratedSupportMesh | undefined {
  const hit = meshes.get(objectId);
  return hit && hit.revision === revision ? hit.mesh : undefined;
}

export function cacheSupportMesh(objectId: string, revision: number, mesh: GeneratedSupportMesh): void {
  meshes.set(objectId, { revision, mesh });
  // After the write: a reader that recomputes on this event (HUD, cost card) sees the new mesh.
  dispatch(EVENTS.SUPPORTS_CACHE_CHANGED, { objectId, kind: 'mesh' });
}

/** Forget the support mesh of one object (nothing is built for it now), keeping its placement. */
export function dropSupportMesh(objectId: string): void {
  const had = meshes.delete(objectId);
  if (had) dispatch(EVENTS.SUPPORTS_CACHE_CHANGED, { objectId, kind: 'mesh' });
}

export function cachedSupportFigures(objectId: string, revision: number, scale = 1): SupportFigures | undefined {
  const hit = figures.get(objectId);
  return hit && hit.revision === revision && hit.scale === scale ? hit : undefined;
}

export function cacheSupportFigures(objectId: string, entry: SupportFigures): void {
  figures.set(objectId, entry);
  dispatch(EVENTS.SUPPORTS_CACHE_CHANGED, { objectId, kind: 'figures' });
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
    figures.clear();
    placements.clear();
    return;
  }
  meshes.delete(objectId);
  figures.delete(objectId);
  placements.delete(objectId);
}

// Let the JS side (print cost, triangle budget) read these meshes without importing TypeScript.
setSupportMeshLookup(cachedSupportMesh);
setSupportFiguresLookup(cachedSupportFigures);
