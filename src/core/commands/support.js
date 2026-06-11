// Shared helpers for command classes (split from HistoryManager.js — review
// L29 / Blueprint §0.5). Commands import from here; HistoryManager.js stays
// the stack machinery + façade.

import { dispatch, setState } from '../StateManager.js';
import { EVENTS } from '../events.js';
import { SceneManager } from '../SceneManager.js';
import { Selection } from '../Selection.js';
import { AssetLoader } from '../AssetLoader.js';

const BABYLON = window.BABYLON;

export const SILENT = { silent: true };

/**
 * Pause the gizmo's selection-pivot parenting so that downstream parent
 * mutations (Group / Ungroup / Delete) see the meshes in their canonical
 * parents, then restore visuals.
 */
export function withDetachedPivot(fn) {
  SceneManager.attachToSelection([], 'median', null);
  try { fn(); }
  finally { Selection.refresh(); }
}

export function applyAbsoluteTransform(mesh, t) {
  const parent = mesh.parent;
  mesh.setParent(null);
  mesh.position.set(t.position.x, t.position.y, t.position.z);
  mesh.rotationQuaternion = new BABYLON.Quaternion(t.rotation.x, t.rotation.y, t.rotation.z, t.rotation.w);
  mesh.scaling.set(t.scaling.x, t.scaling.y, t.scaling.z);
  mesh.setParent(parent);   // preserves the world transform we just set
}

export function applyTransforms(snapshot) {
  for (const [id, t] of Object.entries(snapshot)) {
    const mesh = AssetLoader.getBabylonMesh(id);
    if (!mesh) continue;
    applyAbsoluteTransform(mesh, t);
  }
  Selection.refresh();
}

export function findGroupNode(groupId) {
  if (!groupId) return null;
  const scene = SceneManager.getScene();
  if (!scene) return null;
  for (const t of scene.transformNodes) {
    if (t.metadata?.groupId === groupId) return t;
  }
  return null;
}

export function findNodeForId(id) {
  if (!id) return null;
  const mesh = AssetLoader.getBabylonMesh(id);
  if (mesh) return mesh;
  return findGroupNode(id);
}

/** Snapshot a mesh's world transform in the {position,rotation:quat,scaling} shape. */
export function captureWorld(mesh) {
  mesh.computeWorldMatrix(true);
  const q = mesh.absoluteRotationQuaternion
    ?? BABYLON.Quaternion.FromEulerVector(mesh.rotation ?? BABYLON.Vector3.Zero());
  const p = mesh.getAbsolutePosition();
  const s = mesh.absoluteScaling ?? mesh.scaling;
  return {
    position: { x: p.x, y: p.y, z: p.z },
    rotation: { x: q.x, y: q.y, z: q.z, w: q.w },
    scaling:  { x: s.x, y: s.y, z: s.z },
  };
}

/** Patch one SceneObject's fields immutably (silent). No-op when absent. */
export function patchSceneObject(meshId, fields) {
  setState(state => {
    const o = state.scene.objects[meshId];
    if (!o) return state;
    return {
      ...state,
      scene: { ...state.scene, objects: { ...state.scene.objects, [meshId]: { ...o, ...fields } } },
    };
  }, SILENT);
}

/** Remove one SceneObject from state (silent) + announce. */
export function removeSceneObject(meshId) {
  setState(state => {
    const next = { ...state.scene.objects };
    delete next[meshId];
    return { ...state, scene: { ...state.scene, objects: next } };
  }, SILENT);
  dispatch(EVENTS.OBJECT_REMOVED, { id: meshId });
}

/** Restore one SceneObject into state (silent) + announce. */
export function restoreSceneObject(meshId, obj) {
  setState(state => ({
    ...state,
    scene: { ...state.scene, objects: { ...state.scene.objects, [meshId]: obj } },
  }), SILENT);
  dispatch(EVENTS.OBJECT_RESTORED, { id: meshId });
}
