// D20 in one place (plan 2026-10-29 P3.3): support-layer meshes are invisible to the rest of the
// app. Every support layer node carries `metadata.supportLayer` (and never `metadata.meshId`), is
// not pickable, and hangs under a registered root; `isSupportLayerMesh` is the one predicate every
// content walk asks (WorldExtents, MeshStats / TriangleCount, MeshValidator, SelectionOutline,
// thumbnails, BoxSelect, the export unit list) and `hideSupportLayers` is how PNG / video renders
// take them out of the frame. Plain JS on purpose: legacy modules and node tests import it.

/** @type {Set<any>} */
const _roots = new Set();

/**
 * Mark a support-layer node (mesh or transform node): no meshId, not pickable.
 * @param {any} node
 * @param {string} layer   which layer ('supports', 'ghost', 'ring', 'brush', 'zones', ...)
 * @param {string} [objectId]  the logical object it belongs to
 */
export function tagSupportLayer(node, layer, objectId) {
  const meta = { ...(node.metadata ?? {}), supportLayer: layer };
  delete meta.meshId;
  if (objectId) meta.supportOf = objectId;
  node.metadata = meta;
  if ('isPickable' in node || typeof node.getTotalVertices === 'function') node.isPickable = false;
  return node;
}

/**
 * Whether `node` is a support-layer node (itself or any ancestor tagged).
 * @param {any} node
 * @returns {boolean}
 */
export function isSupportLayerMesh(node) {
  for (let n = node; n; n = n.parent) if (n.metadata?.supportLayer) return true;
  return false;
}

/**
 * `meshes` without support-layer meshes.
 * @template T
 * @param {Iterable<T>} meshes
 * @returns {T[]}
 */
export function withoutSupportLayers(meshes) {
  const out = [];
  for (const m of meshes) if (!isSupportLayerMesh(m)) out.push(m);
  return out;
}

/** Register the root node every support layer of a scene hangs under. */
export function registerSupportLayerRoot(root) {
  _roots.add(root);
  root.onDisposeObservable?.add?.(() => _roots.delete(root));
}

/**
 * Take every support layer out of the rendered frame (PNG still, video frame); returns the
 * restore function. Disables the roots only: the layers' own visibility is never touched, so a
 * layer update during the capture cannot bring one back.
 * @returns {() => void}
 */
export function hideSupportLayers() {
  const was = [];
  for (const root of _roots) {
    if (root.isDisposed?.()) continue;
    was.push([root, root.isEnabled(false)]);
    root.setEnabled(false);
  }
  return () => { for (const [root, enabled] of was) if (!root.isDisposed?.()) root.setEnabled(enabled); };
}

/**
 * Support Mode isolation bit (SupportMode.ts `ISOLATION_LAYER`; a vitest pins the two equal). The mode
 * hides non-target objects by giving them only this layer-mask bit, which the main camera lacks.
 */
export const ISOLATION_LAYER_BIT = 0x10000000;

/** The default Babylon layer mask (every content mesh carries it outside Support Mode). */
const DEFAULT_LAYER_MASK = 0x0FFFFFFF;

/**
 * Renders and exports are output: they show every object as if Support Mode were off. Gives every
 * isolation-masked mesh of `scene` its default mask back for the capture (so the camera, the shadow
 * map and every other pass see it as outside the mode); returns the restore function, which puts the
 * isolation mask back. Only meshes carrying the isolation bit alone are touched.
 * @param {any} scene
 * @returns {() => void}
 */
export function seeIsolatedObjects(scene) {
  const touched = [];
  for (const mesh of scene?.meshes ?? []) {
    const mask = mesh.layerMask;
    if (typeof mask !== 'number' || !(mask & ISOLATION_LAYER_BIT) || (mask & DEFAULT_LAYER_MASK)) continue;
    touched.push([mesh, mask]);
    mesh.layerMask = mask | DEFAULT_LAYER_MASK;
  }
  return () => { for (const [mesh, mask] of touched) mesh.layerMask = mask; };
}
