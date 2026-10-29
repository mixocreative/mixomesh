/**
 * Stale supports (plan P3 contract): built supports no longer fit their object when its geometry
 * (`sourceHash`: repair, weld, ratio bake, refinement level, re-import / relink) or its pose
 * (rotation, scale) changed since the build. Translation never makes them stale (contacts are
 * object-local). The flag is DERIVED: it is recomputed from the scene on every event that can change
 * either input, so an undo of the rotation or repair clears it again. It is written outside history
 * (silent, no revision bump); stale supports draw greyed (P3.3), block export (P4.2) and regenerate
 * with hand work rekeyed on the next mode entry.
 */
import { getState, subscribe } from '../core/StateManager.js';
import { EVENTS } from '../core/events.js';
import { isBuilt, samePose, type ObjectSupports, type StaleReason, type SupportPose } from './model';
import { readSupports, supportedObjectIds, supportsOwner, writeSupports } from './store';
import { forgetSupportCaches } from './supportCache';

/** What the scene says about an object now. Null = cannot tell (no geometry yet): keep the flag. */
export interface SupportSceneSource {
  pose(objectId: string): SupportPose | null;
  sourceHash(objectId: string): string | null;
  /** The cached hash of `objectId` (or of all) is out of date although no revision moved. */
  forgetHash(objectId?: string): void;
}

export function staleReason(supports: ObjectSupports, now: { hash: string | null; pose: SupportPose | null }): StaleReason | null {
  if (!isBuilt(supports)) return null;
  if (now.hash !== null && now.hash !== supports.sourceHash) return 'geometry';
  if (now.pose !== null && !samePose(now.pose, supports.pose!)) return 'pose';
  return null;
}

/**
 * Re-derive the flag of the given objects (any part ids; default: every object with supports).
 * `geometry: false` (a transform event) checks the pose only and keeps a geometry verdict as it is,
 * so a gizmo commit never re-hashes a mesh.
 */
export function refreshStale(source: SupportSceneSource, ids?: readonly string[], { geometry = true } = {}): void {
  const objects = getState().scene.objects;
  const owners = ids ? [...new Set(ids.map((id) => supportsOwner(id, objects)))] : supportedObjectIds(objects);
  for (const id of owners) {
    const supports = readSupports(id, objects);
    if (!supports || !isBuilt(supports)) continue;
    const reason = !geometry && supports.stale === 'geometry'
      ? 'geometry'
      : staleReason(supports, { hash: geometry ? source.sourceHash(id) : null, pose: source.pose(id) });
    if (reason !== supports.stale) writeSupports(id, { ...supports, stale: reason });
  }
}

/** Subscribe the stale rule to the scene events. Returns the unsubscribe. */
export function installStaleWatch(source: SupportSceneSource): () => void {
  const offs = [
    subscribe(EVENTS.TRANSFORM_COMMITTED, (p: { meshIds?: string[] } | undefined) => refreshStale(source, p?.meshIds ?? [], { geometry: false })),
    subscribe(EVENTS.GEOMETRY_CHANGED, (p: { meshId?: string } | undefined) => { if (p?.meshId) refreshStale(source, [p.meshId]); }),
    subscribe(EVENTS.REFINEMENT_CHANGED, (p: { objectId?: string } | undefined) => { if (p?.objectId) refreshStale(source, [p.objectId]); }),
    subscribe(EVENTS.OBJECT_UPDATED, (p: { meshId?: string } | undefined) => {
      if (!p?.meshId) return;
      source.forgetHash(supportsOwner(p.meshId));
      refreshStale(source, [p.meshId]);
    }),
    subscribe(EVENTS.ASSET_RELINKED, () => { source.forgetHash(); refreshStale(source); }),
    subscribe(EVENTS.PROJECT_NEW, () => { source.forgetHash(); forgetSupportCaches(); }),
    subscribe(EVENTS.PROJECT_LOADED, () => { source.forgetHash(); forgetSupportCaches(); refreshStale(source); }),
  ];
  return () => offs.forEach((off) => off());
}
