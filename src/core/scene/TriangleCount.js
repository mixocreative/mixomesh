/**
 * TriangleCount — the ONE triangle-counting traversal in the app (review M5).
 *
 * Lived in `src/ui/MeshStats.js`, which made a core import path
 * (`AssetImport` → the pre-import budget check) depend on a UI module. The
 * HUD still owns the caching and the rendering; the counting lives here.
 */

import { getBabylonMesh } from '../AssetLoader.js';

/** Per-mesh triangle count: getTotalIndices()/3, falling back to getIndices().length/3. */
function _meshTriangles(mesh) {
  if (!mesh || !mesh.geometry) return 0;
  const total = mesh.getTotalIndices?.();
  if (Number.isFinite(total)) return total / 3;
  const idx = mesh.getIndices?.();
  return Number.isFinite(idx?.length) ? idx.length / 3 : 0;
}

/**
 * Scene-wide triangle total across live print-part / imported meshes. Helper
 * overlays (3D cursor, cross-section stripe/cap, floor disc) carry no
 * `metadata.meshId` and are excluded.
 *
 * A mesh carrying `metadata.meshId` is not necessarily the LIVE registered
 * mesh for that id — `Mesh.clone()` copies the metadata reference, so a
 * transient export clone (`PrintPipeline`'s `${mesh.name}__export`) carries
 * the SAME source `meshId` while it exists in the scene. If a geometry event
 * (export validates its clones through the same `MeshValidator.validateMesh`
 * → `VALIDATION_COMPLETE` path a real edit uses) fires a re-walk while such a
 * clone is still alive, a naive `mesh.metadata?.meshId` filter double-counts
 * it alongside the real mesh (observed live: a 4-triangle repaired solid read
 * HUD "tris 8"). `MeshValidator.js`'s own cache-write path guards the
 * identical hazard with its `isLive` check — this walk uses the same registry
 * check, so only the CURRENTLY REGISTERED live mesh for an id is ever summed.
 */
export function countSceneTriangles(scene) {
  if (!scene?.meshes) return 0;
  let tris = 0;
  for (const mesh of scene.meshes) {
    const meshId = mesh.metadata?.meshId;
    if (!meshId || getBabylonMesh(meshId) !== mesh) continue;
    tris += _meshTriangles(mesh);
  }
  return tris;
}

/**
 * Triangle total across an AssetContainer's meshes — used BEFORE
 * `addAllToScene()`, when nothing has a meshId yet, so it sums every
 * geometry-bearing mesh unconditionally.
 */
export function countContainerTriangles(container) {
  if (!container?.meshes) return 0;
  let tris = 0;
  for (const mesh of container.meshes) tris += _meshTriangles(mesh);
  return tris;
}

/** Triangle count of a single mesh (0 when it carries no geometry). */
export function meshTriangles(mesh) {
  return _meshTriangles(mesh);
}

/** Compact triangle-count formatting: 342 / 12.3k / 342k / 1.5M (one decimal for M). */
export function formatTriCount(n) {
  const v = Number.isFinite(n) ? n : 0;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 100_000) return `${Math.round(v / 1000)}k`;
  if (v >= 1000) return `${(v / 1000).toFixed(1)}k`;
  return `${Math.round(v)}`;
}
