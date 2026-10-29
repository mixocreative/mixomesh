/**
 * Reads and writes `object.supports` on the logical-object lead (plan P3.1). Commands write
 * through here (silently: the command marks dirty, undo runs under `withoutDirty`), and every write
 * announces `SUPPORTS_CHANGED`.
 */
import { dispatch, getState, setState } from '../core/StateManager.js';
import { EVENTS } from '../core/events.js';
import { canonicalObjectId } from '../core/LogicalObjects.js';
import type { ObjectSupports } from './model';

/* eslint-disable @typescript-eslint/no-explicit-any -- state.scene.objects is untyped JS state */
type Objects = Record<string, any>;

/** The lead id that owns the supports of `id` (any part of a logical object). */
export function supportsOwner(id: string, objects: Objects = getState().scene.objects): string {
  return canonicalObjectId(id, objects) ?? id;
}

export function readSupports(id: string, objects: Objects = getState().scene.objects): ObjectSupports | undefined {
  return objects[supportsOwner(id, objects)]?.supports ?? undefined;
}

/** Lead ids that carry supports. */
export function supportedObjectIds(objects: Objects = getState().scene.objects): string[] {
  return Object.keys(objects).filter((id) => objects[id]?.supports && supportsOwner(id, objects) === id);
}

/** Replace (or with `undefined` remove) the supports of the lead of `id`. No-op for an unknown object. */
export function writeSupports(id: string, supports: ObjectSupports | undefined): void {
  const owner = supportsOwner(id);
  let wrote = false;
  setState((state: any) => {
    const object = state.scene.objects[owner];
    if (!object) return state;
    wrote = true;
    const next = { ...object };
    if (supports) next.supports = supports;
    else delete next.supports;
    return { ...state, scene: { ...state.scene, objects: { ...state.scene.objects, [owner]: next } } };
  }, { silent: true });
  if (wrote) dispatch(EVENTS.SUPPORTS_CHANGED, { objectId: owner, revision: supports?.revision ?? 0, stale: supports?.stale ?? null });
}
