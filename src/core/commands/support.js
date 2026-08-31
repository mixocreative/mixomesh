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

export function applyAbsoluteNodeTransform(node, t) {
  if (!node || !t) return;
  const parent = node.parent ?? null;
  node.setParent?.(null);
  if (node.position?.set) node.position.set(t.position.x, t.position.y, t.position.z);
  else node.position = new BABYLON.Vector3(t.position.x, t.position.y, t.position.z);
  node.rotationQuaternion = new BABYLON.Quaternion(t.rotation.x, t.rotation.y, t.rotation.z, t.rotation.w);
  node.rotation?.set?.(0, 0, 0);
  if (node.scaling?.set) node.scaling.set(t.scaling.x, t.scaling.y, t.scaling.z);
  else node.scaling = new BABYLON.Vector3(t.scaling.x, t.scaling.y, t.scaling.z);
  node.setParent?.(parent);   // preserves the world transform we just set
  node.computeWorldMatrix?.(true);
}

export function applyAbsoluteTransform(mesh, t) {
  applyAbsoluteNodeTransform(mesh, t);
}

export function setParentPreserveWorld(node, parent) {
  if (!node) return;
  const world = captureWorldNode(node);
  node.setParent?.(parent ?? null);
  applyAbsoluteNodeTransform(node, world);
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

/** Snapshot a node's world transform in the {position,rotation:quat,scaling} shape. */
export function captureWorldNode(node) {
  node.computeWorldMatrix?.(true);
  const world = node.getWorldMatrix?.();
  if (world?.decompose) {
    const s0 = new BABYLON.Vector3(1, 1, 1);
    const q0 = new BABYLON.Quaternion(0, 0, 0, 1);
    const p0 = new BABYLON.Vector3(0, 0, 0);
    if (world.decompose(s0, q0, p0)) {
      return {
        position: { x: p0.x, y: p0.y, z: p0.z },
        rotation: { x: q0.x, y: q0.y, z: q0.z, w: q0.w },
        scaling:  { x: s0.x, y: s0.y, z: s0.z },
      };
    }
  }
  const q = node.absoluteRotationQuaternion
    ?? node.rotationQuaternion
    ?? BABYLON.Quaternion.FromEulerVector(node.rotation ?? BABYLON.Vector3.Zero());
  const p = node.getAbsolutePosition?.() ?? node.position ?? BABYLON.Vector3.Zero();
  const s = node.absoluteScaling ?? node.scaling ?? new BABYLON.Vector3(1, 1, 1);
  return {
    position: { x: p.x, y: p.y, z: p.z },
    rotation: { x: q.x, y: q.y, z: q.z, w: q.w },
    scaling:  { x: s.x, y: s.y, z: s.z },
  };
}

/** Snapshot a mesh's world transform in the {position,rotation:quat,scaling} shape. */
export function captureWorld(mesh) {
  return captureWorldNode(mesh);
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
