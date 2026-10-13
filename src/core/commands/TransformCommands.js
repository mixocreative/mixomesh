// Transform-domain commands (split from HistoryManager.js — review L29).

import { EVENTS } from '../events.js';
import { dispatch, markDirty } from '../StateManager.js';
import { AssetLoader } from '../AssetLoader.js';
import { applyTransforms, captureWorld, transformedMeshIds } from './support.js';

/**
 * Apply per-NODE absolute transforms. `prev` and `next` are objects keyed by
 * node id — an object meshId or a user groupId (overhaul 2.2) — with
 * `{position, rotation:quat, scaling}` plain-object values. A group entry
 * moves the group TransformNode rigidly; its children keep their locals.
 *
 * Pass `{ alreadyApplied: true }` when the change has already been made to the
 * scene (e.g. by the gizmo) — the initial execute() becomes a no-op so the
 * node state isn't re-applied on top of itself.
 *
 * `TRANSFORM_COMMITTED` carries `nodeIds` (the snapshot keys) and `meshIds`
 * (every object mesh whose world transform changed — group ids expanded).
 */
export class TransformCommand {
  constructor(prev, next, opts = {}) {
    this.label = 'Transform';
    this._prev = prev;
    this._next = next;
    this._skipFirstExecute = !!opts.alreadyApplied;
  }
  execute() {
    if (!this._skipFirstExecute) applyTransforms(this._next);
    this._skipFirstExecute = false;
    markDirty();
    _announce(this._next);
  }
  undo() {
    applyTransforms(this._prev);
    _announce(this._prev);
  }
}

function _announce(snapshot) {
  const nodeIds = Object.keys(snapshot);
  dispatch(EVENTS.TRANSFORM_COMMITTED, { meshIds: transformedMeshIds(nodeIds), nodeIds });
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
    this.label = this._targets.length === 1 ? 'Copy placement from active' : `Copy placement from active (${this._targets.length})`;
  }
  execute() { applyTransforms(this._next); markDirty(); dispatch(EVENTS.TRANSFORM_COMMITTED, { meshIds: Object.keys(this._next) }); }
  undo()    { applyTransforms(this._prev); dispatch(EVENTS.TRANSFORM_COMMITTED, { meshIds: Object.keys(this._prev) }); }
}
