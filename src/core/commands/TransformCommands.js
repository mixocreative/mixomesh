// Transform-domain commands (split from HistoryManager.js — review L29).

import { EVENTS } from '../events.js';
import { dispatch, markDirty } from '../StateManager.js';
import { AssetLoader } from '../AssetLoader.js';
import { applyTransforms, captureWorld } from './support.js';

/**
 * Apply per-mesh absolute transforms. `prev` and `next` are objects keyed by
 * meshId with `{position, rotation:quat, scaling}` plain-object values.
 *
 * Pass `{ alreadyApplied: true }` when the change has already been made to the
 * scene (e.g. by the gizmo) — the initial execute() becomes a no-op so the
 * mesh state isn't re-applied on top of itself.
 */
export class TransformCommand {
  constructor(prev, next, opts = {}) {
    this.label = 'Transform';
    this._prev = prev;
    this._next = next;
    this._skipFirstExecute = !!opts.alreadyApplied;
  }
  execute() {
    if (this._skipFirstExecute) {
      this._skipFirstExecute = false;
      markDirty();
      dispatch(EVENTS.TRANSFORM_COMMITTED, { meshIds: Object.keys(this._next) });
      return;
    }
    applyTransforms(this._next);
    markDirty();
    dispatch(EVENTS.TRANSFORM_COMMITTED, { meshIds: Object.keys(this._next) });
  }
  undo() {
    applyTransforms(this._prev);
    dispatch(EVENTS.TRANSFORM_COMMITTED, { meshIds: Object.keys(this._prev) });
  }
}

// BakeTransformCommand (Blender-style "Apply Rotation / Apply Scale") was
// REMOVED 2026-06-16: baking a user transform into vertices + zeroing the node
// destroyed the editable, persisted Scale/Rotation properties and was lost on
// .mixo reload (the .mixo stores raw bytes + the node transform, not the baked
// vertices). User rotation/scale now ALWAYS live on the node — editable in
// Properties and saved via _decompose. Export still flattens the world matrix,
// so the printed geometry is unaffected.

/**
 * Snap every other selected object's transform to match the active object.
 * Position + rotation + scale. Undo restores each target's prior transform.
 */
export class TransformSwabCommand {
  constructor(meshIds, activeId) {
    this._activeId = activeId;
    this._targets = (meshIds ?? []).filter(id => id !== activeId);
    this._prev = {};
    this._next = {};
    const active = AssetLoader.getBabylonMesh(activeId);
    const src = active ? captureWorld(active) : null;
    for (const id of this._targets) {
      const m = AssetLoader.getBabylonMesh(id);
      if (!m || !src) continue;
      this._prev[id] = captureWorld(m);
      this._next[id] = { position: { ...src.position }, rotation: { ...src.rotation }, scaling: { ...src.scaling } };
    }
    this.label = this._targets.length === 1 ? 'Transform Swab' : `Transform Swab (${this._targets.length})`;
  }
  execute() { applyTransforms(this._next); markDirty(); dispatch(EVENTS.TRANSFORM_COMMITTED, { meshIds: Object.keys(this._next) }); }
  undo()    { applyTransforms(this._prev); dispatch(EVENTS.TRANSFORM_COMMITTED, { meshIds: Object.keys(this._prev) }); }
}
