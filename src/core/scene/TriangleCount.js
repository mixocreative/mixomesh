/**
 * TriangleCount: the ONE triangle count in the app. The import budget check,
 * the status-bar budget line and the viewport Stats HUD all read it, so they
 * always show the same number for the same scene.
 *
 * "Scene triangles" = the objects in the scene document (deleted objects have
 * left it, even while undo keeps their meshes), each as the viewport shows it
 * (its refined meshes while a refinement preview is visible). Counts come from
 * buffer lengths, cached per mesh against its GeometryStore revision.
 */

import { getBabylonMesh } from '../AssetLoader.js';
import { getState } from '../StateManager.js';
import { canonicalObjectId } from '../LogicalObjects.js';
import { revisionOf } from '../geometry/GeometryStore.js';

// RefinementController sits above this module in the import graph (it reaches
// MeshValidator, which reaches back here through AssetLoader), so a static
// import evaluates it too early. Bind it once the graph has loaded; no refined
// mesh can exist before then.
let _derivedMeshes = () => null;
import('../refinement/RefinementController.js').then(m => { _derivedMeshes = m.getDerivedMeshes; });

const _cache = new WeakMap();   // mesh → { rev, indices, vertices, tris, verts }

/**
 * Faces (triangles) and vertices of one mesh from buffer lengths, cached per
 * revision. Unindexed meshes count vertices / 3 triangles.
 * @param {any} mesh  Babylon mesh (duck-typed: getTotalIndices / getTotalVertices)
 * @returns {{ tris: number, verts: number }}
 */
export function meshCounts(mesh) {
  if (!mesh || mesh.isDisposed?.() || !mesh.geometry) return { tris: 0, verts: 0 };
  const rev = revisionOf(mesh);
  const indices = mesh.getTotalIndices?.() ?? 0;
  const vertices = mesh.getTotalVertices?.() ?? 0;
  const hit = _cache.get(mesh);
  if (hit && hit.rev === rev && hit.indices === indices && hit.vertices === vertices) return hit;
  const entry = { rev, indices, vertices, tris: Math.floor((indices || vertices) / 3), verts: vertices };
  _cache.set(mesh, entry);
  return entry;
}

/** Triangle count of a single mesh (0 when it carries no geometry). */
export function meshTriangles(mesh) {
  return meshCounts(mesh).tris;
}

/**
 * The live registered mesh of every object in the scene document. A transient
 * export clone shares its source's `metadata.meshId` but is never the
 * registered mesh, so it is never counted twice.
 * @param {Record<string, any>} [objects]
 */
export function sceneObjectMeshes(objects = getState().scene?.objects ?? {}) {
  return Object.keys(objects).map(id => getBabylonMesh(id)).filter(Boolean);
}

/**
 * Swap each logical object's source meshes for its refined meshes while those
 * are what the viewport shows.
 * @param {any[]} meshes
 * @param {{ objects?: Record<string, any>, derivedFor?: (leadId: string) => any[]|null }} [opts]
 */
export function displayedMeshes(meshes, { objects = getState().scene?.objects ?? {}, derivedFor = _derivedMeshes } = {}) {
  const byLead = new Map();
  for (const m of meshes) {
    const id = m?.metadata?.meshId;
    const lead = id && objects[id] ? canonicalObjectId(id, objects) : id;
    if (!byLead.has(lead)) byLead.set(lead, []);
    byLead.get(lead).push(m);
  }
  const out = [];
  for (const [lead, sources] of byLead) {
    const derived = derivedFor?.(lead);
    out.push(...(derived?.length && derived.some(m => m?.isVisible) ? derived : sources));
  }
  return out;
}

/**
 * Triangles and vertices of `meshes` as displayed, each mesh once.
 * @param {any[]} meshes
 * @param {Parameters<typeof displayedMeshes>[1]} [opts]
 */
export function displayedCounts(meshes, opts) {
  let tris = 0, verts = 0;
  for (const m of new Set(displayedMeshes(meshes, opts))) {
    const c = meshCounts(m);
    tris += c.tris;
    verts += c.verts;
  }
  return { tris, verts };
}

/**
 * Scene-wide displayed triangle total (see the module header).
 * @param {Record<string, any>} [objects]
 * @param {{ derivedFor?: (leadId: string) => any[]|null }} [opts]
 */
export function countSceneTriangles(objects = getState().scene?.objects ?? {}, opts = {}) {
  return displayedCounts(sceneObjectMeshes(objects), { ...opts, objects }).tris;
}

/**
 * Triangle total across an AssetContainer's meshes, used BEFORE
 * `addAllToScene()` when nothing has a meshId yet.
 */
export function countContainerTriangles(container) {
  let tris = 0;
  for (const mesh of container?.meshes ?? []) tris += meshTriangles(mesh);
  return tris;
}

/** Compact triangle-count formatting: 342 / 12.3k / 342k / 1.5M (one decimal for M). */
export function formatTriCount(n) {
  const v = Number.isFinite(n) ? n : 0;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 100_000) return `${Math.round(v / 1000)}k`;
  if (v >= 1000) return `${(v / 1000).toFixed(1)}k`;
  return `${Math.round(v)}`;
}
