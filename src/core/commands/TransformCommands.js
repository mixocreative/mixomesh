// Transform-domain commands (split from HistoryManager.js — review L29).

import { EVENTS } from '../events.js';
import { dispatch, markDirty } from '../StateManager.js';
import { AssetLoader } from '../AssetLoader.js';
import { applyTransforms, captureWorld } from './support.js';

const BABYLON = window.BABYLON;

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

/**
 * Bake the current rotation or scaling of a mesh into its vertex data, then
 * reset the corresponding transform component to identity. Position is left
 * untouched. Mirrors Blender's "Apply Rotation / Apply Scale" command.
 *
 * Undo restores the pre-bake vertex positions and normals from a snapshot,
 * so floating-point error doesn't accumulate over many cycles.
 */
export class BakeTransformCommand {
  constructor(meshId, kind /* 'rotation' | 'scale' */) {
    this._meshId = meshId;
    this._kind = kind;
    this._snapPositions = null;
    this._snapNormals   = null;
    this._snapRotation  = null;
    this._snapQuaternion = null;
    this._snapScaling   = null;
    this.label = kind === 'rotation' ? 'Apply Rotation' : 'Apply Scale';
  }
  execute() {
    const mesh = AssetLoader.getBabylonMesh(this._meshId);
    if (!mesh || !mesh.geometry) return;
    if (this._snapPositions === null) {
      const pos = mesh.getVerticesData(BABYLON.VertexBuffer.PositionKind);
      this._snapPositions = pos ? new Float32Array(pos) : null;
      const norm = mesh.getVerticesData(BABYLON.VertexBuffer.NormalKind);
      this._snapNormals = norm ? new Float32Array(norm) : null;
      this._snapRotation = mesh.rotation.clone();
      this._snapQuaternion = mesh.rotationQuaternion ? mesh.rotationQuaternion.clone() : null;
      this._snapScaling = mesh.scaling.clone();
    }

    let mat;
    if (this._kind === 'rotation') {
      if (mesh.rotationQuaternion) {
        mat = new BABYLON.Matrix();
        mesh.rotationQuaternion.toRotationMatrix(mat);
      } else {
        mat = BABYLON.Matrix.RotationYawPitchRoll(mesh.rotation.y, mesh.rotation.x, mesh.rotation.z);
      }
      mesh.bakeTransformIntoVertices(mat);
      mesh.rotation.set(0, 0, 0);
      if (mesh.rotationQuaternion) mesh.rotationQuaternion = BABYLON.Quaternion.Identity();
    } else {
      mat = BABYLON.Matrix.Scaling(mesh.scaling.x, mesh.scaling.y, mesh.scaling.z);
      mesh.bakeTransformIntoVertices(mat);
      mesh.scaling.set(1, 1, 1);
    }
    mesh.refreshBoundingInfo?.();
    dispatch(EVENTS.OBJECT_UPDATED, { meshId: this._meshId });
    markDirty();
  }
  undo() {
    const mesh = AssetLoader.getBabylonMesh(this._meshId);
    if (!mesh) return;
    if (this._snapPositions) mesh.setVerticesData(BABYLON.VertexBuffer.PositionKind, this._snapPositions, /*updatable*/ false);
    if (this._snapNormals)   mesh.setVerticesData(BABYLON.VertexBuffer.NormalKind,   this._snapNormals,   /*updatable*/ false);
    if (this._snapRotation)  mesh.rotation.copyFrom(this._snapRotation);
    if (this._snapQuaternion) mesh.rotationQuaternion = this._snapQuaternion.clone();
    if (this._snapScaling)   mesh.scaling.copyFrom(this._snapScaling);
    mesh.refreshBoundingInfo?.();
    dispatch(EVENTS.OBJECT_UPDATED, { meshId: this._meshId });
  }
}

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
