import { EVENTS } from './events.js';
import { dispatch, getState, setState, subscribe } from './StateManager.js';
import { AssetLoader } from './AssetLoader.js';

const BABYLON = window.BABYLON;
if (!BABYLON) throw new Error('Babylon.js failed to load');

// ── Tunables ─────────────────────────────────────────────
const MERGE_DISTANCE   = 1e-4;      // 0.1 mm (Babylon units = meters)
const NORMAL_SAMPLE    = 64;        // faces sampled for inverted-normal vote
const RAY_OFFSET       = 1e-3;      // 1 mm — push ray start outside surface
const RAY_LENGTH       = 100;       // generous; we only need a hit flag
const TRI_BUDGET_AUTO  = 100_000;   // BLUEPRINT §14.3 — vertex budget

// ── Geometry helpers ─────────────────────────────────────

function _getPositions(mesh) {
  return mesh.getVerticesData(BABYLON.VertexBuffer.PositionKind);
}
function _getIndices(mesh) {
  return mesh.getIndices();
}

/**
 * Map every vertex index to a canonical index shared by all vertices at the
 * same position (within MERGE_DISTANCE). Imported glTF/STL geometry is almost
 * always unwelded — each triangle carries its own vertex copies split for
 * normals/UVs — so a raw index-keyed topology check reports nearly every edge
 * as non-manifold even on a perfectly closed mesh. Welding by position first
 * makes the count reflect *real* topology.
 */
function _weldedIndexMap(positions) {
  const eps = MERGE_DISTANCE;
  const canonical = new Map();                 // 'x|y|z' → canonical index
  const remap = new Int32Array(positions.length / 3);
  for (let i = 0; i < remap.length; i++) {
    const k = `${Math.round(positions[i * 3] / eps)}|`
            + `${Math.round(positions[i * 3 + 1] / eps)}|`
            + `${Math.round(positions[i * 3 + 2] / eps)}`;
    let c = canonical.get(k);
    if (c === undefined) { c = i; canonical.set(k, c); }
    remap[i] = c;
  }
  return remap;
}

/**
 * Build edge → faceCount map over position-welded indices. An edge belongs to
 * exactly 2 faces in a closed manifold; anything else is a real boundary /
 * non-manifold edge (an actual hole or T-junction, not just unwelded data).
 */
function _checkNonManifold(positions, indices) {
  const w = _weldedIndexMap(positions);
  const edges = new Map(); // 'a:b' → count
  const key = (a, b) => (a < b ? `${a}:${b}` : `${b}:${a}`);
  for (let i = 0; i < indices.length; i += 3) {
    const a = w[indices[i]], b = w[indices[i + 1]], c = w[indices[i + 2]];
    if (a === b || b === c || c === a) continue;   // degenerate after weld
    [[a, b], [b, c], [c, a]].forEach(([u, v]) => {
      const k = key(u, v);
      edges.set(k, (edges.get(k) ?? 0) + 1);
    });
  }
  let badEdges = 0;
  for (const count of edges.values()) {
    if (count !== 2) badEdges++;
  }
  return badEdges;
}

/**
 * Cast a ray from each sampled face's centroid along its normal. If the ray
 * re-enters the mesh, the normal is pointing inward. Majority vote decides
 * the entire mesh's winding (a low-fi but cheap heuristic).
 */
function _checkInvertedNormals(mesh, positions, indices) {
  const triCount = indices.length / 3;
  if (triCount === 0) return false;

  const step = Math.max(1, Math.floor(triCount / NORMAL_SAMPLE));
  let inwardVotes = 0;
  let sampled     = 0;

  const a = new BABYLON.Vector3();
  const b = new BABYLON.Vector3();
  const c = new BABYLON.Vector3();

  const worldMatrix = mesh.getWorldMatrix();

  for (let t = 0; t < triCount; t += step) {
    const i0 = indices[t * 3], i1 = indices[t * 3 + 1], i2 = indices[t * 3 + 2];
    a.set(positions[i0 * 3], positions[i0 * 3 + 1], positions[i0 * 3 + 2]);
    b.set(positions[i1 * 3], positions[i1 * 3 + 1], positions[i1 * 3 + 2]);
    c.set(positions[i2 * 3], positions[i2 * 3 + 1], positions[i2 * 3 + 2]);

    const aw = BABYLON.Vector3.TransformCoordinates(a, worldMatrix);
    const bw = BABYLON.Vector3.TransformCoordinates(b, worldMatrix);
    const cw = BABYLON.Vector3.TransformCoordinates(c, worldMatrix);

    const centroid = aw.add(bw).add(cw).scaleInPlace(1 / 3);
    const edge1    = bw.subtract(aw);
    const edge2    = cw.subtract(aw);
    const normal   = BABYLON.Vector3.Cross(edge1, edge2);
    if (normal.lengthSquared() < 1e-12) continue;
    normal.normalize();

    const origin = centroid.add(normal.scale(RAY_OFFSET));
    const ray    = new BABYLON.Ray(origin, normal, RAY_LENGTH);
    const hit    = mesh.intersects(ray, true);
    if (hit.hit) inwardVotes++;
    sampled++;
  }

  return sampled > 0 && (inwardVotes / sampled) > 0.5;
}

/**
 * Compare the mesh's *exported* AABB against the configured bed dimensions.
 *
 * In-scene size is in metres at the scene's working ratio (1 BU = 1 m). The
 * bed constraint applies to the physical print, so we rescale by
 * (workingRatio / targetRatio) before converting to mm.
 */
function _checkExceedsBed(mesh) {
  const bb     = mesh.getBoundingInfo().boundingBox;
  const size   = bb.maximumWorld.subtract(bb.minimumWorld);   // metres at workingRatio
  const print  = getState().print;
  const wr     = print.workingRatio > 0 ? print.workingRatio : 1;
  const tr     = print.targetRatio  > 0 ? print.targetRatio  : 1;
  const k      = 1000 * (wr / tr);                            // BU → mm at targetRatio
  const sizeMM = { x: size.x * k, y: size.y * k, z: size.z * k };
  const bed    = print.bedDimensions;
  return sizeMM.x > bed.x || sizeMM.y > bed.y || sizeMM.z > bed.z
    ? { sizeMM, bedMM: bed }
    : null;
}

// ── Group-aware helpers (split-on-import) ───────

/**
 * Collect live Babylon meshes that share a sourceGroupId. Split shells of an
 * original MultiMaterial mesh stamp the same id at import time — without
 * concatenating them, every shell looks non-watertight by construction.
 */
function _collectGroupSiblings(sourceGroupId) {
  const objects = getState().scene.objects;
  const siblings = [];
  for (const [meshId, obj] of Object.entries(objects)) {
    if (obj.sourceGroupId !== sourceGroupId) continue;
    if (obj.isGhost) continue;
    const babylonMesh = AssetLoader.getBabylonMesh?.(meshId);
    if (!babylonMesh) continue;
    siblings.push({ meshId, babylonMesh });
  }
  return siblings;
}

/**
 * Concatenate sibling positions in world space and shift indices to match.
 * Welding in _checkNonManifold then re-joins shared seams regardless of
 * which sub-material side each triangle originated on.
 */
function _buildGroupUnion(siblings) {
  let totalVerts = 0;
  let totalIndices = 0;
  for (const { babylonMesh } of siblings) {
    const pos = _getPositions(babylonMesh);
    const idx = _getIndices(babylonMesh);
    if (!pos || !idx) continue;
    totalVerts   += pos.length / 3;
    totalIndices += idx.length;
  }
  const positions = new Float32Array(totalVerts * 3);
  const indices   = new Uint32Array(totalIndices);
  let pOff = 0, iOff = 0, vOff = 0;
  const tmp = new BABYLON.Vector3();
  for (const { babylonMesh } of siblings) {
    const pos = _getPositions(babylonMesh);
    const idx = _getIndices(babylonMesh);
    if (!pos || !idx) continue;
    const wm = babylonMesh.getWorldMatrix?.() ?? null;
    const vCount = pos.length / 3;
    for (let i = 0; i < vCount; i++) {
      tmp.set(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
      const w = wm ? BABYLON.Vector3.TransformCoordinates(tmp, wm) : tmp;
      positions[(vOff + i) * 3]     = w.x;
      positions[(vOff + i) * 3 + 1] = w.y;
      positions[(vOff + i) * 3 + 2] = w.z;
    }
    for (let i = 0; i < idx.length; i++) {
      indices[iOff + i] = idx[i] + vOff;
    }
    vOff += vCount;
    iOff += idx.length;
    pOff += vCount * 3;
  }
  return { positions, indices };
}

/**
 * Run topology checks on the welded union of all siblings sharing a
 * sourceGroupId. Inverted-normals is skipped on group scope — raycasting
 * against a synthetic union mesh adds complexity for a heuristic the slicer
 * also corrects, and split shells frequently mislead the per-mesh check.
 */
export async function validateGroup(sourceGroupId) {
  const siblings = _collectGroupSiblings(sourceGroupId);
  const results = [];
  if (siblings.length === 0) return results;
  const { positions, indices } = _buildGroupUnion(siblings);
  if (!positions.length || !indices.length) return results;

  const badEdgeCount = _checkNonManifold(positions, indices);
  if (badEdgeCount > 0) {
    results.push({
      type: 'nonManifold',
      severity: 'warning',
      count: badEdgeCount,
      autoFixAvailable: false,
      fixed: false,
      scope: 'group',
      sourceGroupId,
      message: `${badEdgeCount} non-manifold edge${badEdgeCount === 1 ? '' : 's'} across group (slicer-repairable)`,
    });
  }
  return results;
}

// ── Validation result cache (arch A6) ────────────────────
// state.scene.validation: Record<meshId, { results, validatedAt, stale }>.
// Stale entries keep their last results so the UI can grey them out instead
// of blanking. Export clones never write here — they carry the source
// meshId in metadata but are not the live registered mesh.

const SILENT = { silent: true };

function _cacheResults(meshIds, results) {
  const ids = [].concat(meshIds).filter(Boolean);
  if (!ids.length) return;
  setState(s => {
    const v = { ...s.scene.validation };
    const validatedAt = Date.now();
    for (const id of ids) v[id] = { results, validatedAt, stale: false };
    return { ...s, scene: { ...s.scene, validation: v } };
  }, SILENT);
}

function _markStale(meshIds) {
  const ids = [].concat(meshIds).filter(id => getState().scene.validation[id]);
  if (!ids.length) return;
  setState(s => {
    const v = { ...s.scene.validation };
    for (const id of ids) if (v[id]) v[id] = { ...v[id], stale: true };
    return { ...s, scene: { ...s.scene, validation: v } };
  }, SILENT);
}

function _dropEntry(meshId) {
  if (!getState().scene.validation[meshId]) return;
  setState(s => {
    const v = { ...s.scene.validation };
    delete v[meshId];
    return { ...s, scene: { ...s.scene, validation: v } };
  }, SILENT);
}

function _clearCache() {
  setState(s => ({ ...s, scene: { ...s.scene, validation: {} } }), SILENT);
}

/** Mark every cached entry stale (e.g. bed dimensions changed). */
export function invalidateAll() {
  _markStale(Object.keys(getState().scene.validation));
}

/** Wire cache invalidation. Call once at boot (and in headless tests). */
export function init() {
  subscribe(EVENTS.TRANSFORM_COMMITTED, (p) => _markStale(p?.meshIds ?? []));
  subscribe(EVENTS.OBJECT_UPDATED, (p) => _markStale(p?.meshId ? [p.meshId] : []));
  subscribe(EVENTS.OBJECT_REMOVED, (p) => { if (p?.id) _dropEntry(p.id); });
  subscribe(EVENTS.PROJECT_NEW, _clearCache);
  subscribe(EVENTS.PROJECT_LOADED, _clearCache);
}

// ── Public API ───────────────────────────────────────────

/**
 * Run validation checks against a mesh. If the SceneObject carries a
 * sourceGroupId (split-on-import shell), topology checks dispatch to the
 * welded-union path — a single shell is non-watertight by construction.
 * Integrity checks (bed bounds) stay per-mesh.
 * @param {BABYLON.AbstractMesh} mesh
 * @returns {Promise<ValidationResult[]>}
 */
export async function validateMesh(mesh) {
  dispatch(EVENTS.VALIDATION_STARTED, { meshName: mesh.name });

  const results = [];
  // SceneObjects are keyed by minted meshId (stamped on mesh.metadata at
  // registration) — Babylon mesh.name is unrelated and collides across imports.
  const sceneObj = getState().scene.objects?.[mesh.metadata?.meshId];
  const groupId  = sceneObj?.sourceGroupId ?? null;

  const positions = _getPositions(mesh);
  const indices   = _getIndices(mesh);

  if (positions && indices && indices.length > 0) {
    if (groupId) {
      // Topology on the welded union; inverted-normals skipped on group scope.
      const groupResults = await validateGroup(groupId);
      results.push(...groupResults);
    } else {
      const badEdgeCount = _checkNonManifold(positions, indices);
      if (badEdgeCount > 0) {
        // Warning, not error: a colored-print assembly tool works with downloaded
        // display models that are frequently non-watertight, and slicers
        // (Bambu / Lychee / Cura) auto-repair these. Surfaced, never blocking.
        results.push({
          type: 'nonManifold',
          severity: 'warning',
          count: badEdgeCount,
          autoFixAvailable: true,
          fixed: false,
          message: `${badEdgeCount} non-manifold edge${badEdgeCount === 1 ? '' : 's'} (slicer-repairable)`,
        });
      }
      const inverted = _checkInvertedNormals(mesh, positions, indices);
      if (inverted) {
        results.push({
          type: 'invertedNormals',
          severity: 'warning',
          count: 1,
          autoFixAvailable: true,
          fixed: false,
          message: 'Normals appear inverted (auto-fixed on export)',
        });
      }
    }
  }

  const overBed = _checkExceedsBed(mesh);
  if (overBed) {
    const { sizeMM, bedMM } = overBed;
    results.push({
      type: 'exceedsBed',
      severity: 'warning',
      count: 1,
      autoFixAvailable: false,
      fixed: false,
      message: `Exceeds bed: ${sizeMM.x.toFixed(0)}×${sizeMM.y.toFixed(0)}×${sizeMM.z.toFixed(0)} mm vs ${bedMM.x}×${bedMM.y}×${bedMM.z} mm`,
    });
  }

  // Cache (A6): only for the LIVE registered mesh — export clones carry the
  // source meshId in metadata but must not overwrite live results.
  const meshId = mesh.metadata?.meshId;
  const isLive = !!meshId && AssetLoader.getBabylonMesh(meshId) === mesh;
  if (isLive) {
    if (groupId) {
      // Group-scoped topology results attach to every sibling (Blueprint §9);
      // per-mesh integrity results (bed bounds) stay on this mesh only.
      const siblingIds = _collectGroupSiblings(groupId)
        .map(s => s.meshId)
        .filter(id => id !== meshId);
      if (siblingIds.length) _cacheResults(siblingIds, results.filter(r => r.scope === 'group'));
    }
    _cacheResults([meshId], results);
  }

  dispatch(EVENTS.VALIDATION_COMPLETE, { meshName: mesh.name, meshId: isLive ? meshId : null, results });
  return results;
}

/**
 * Apply available auto-fixes for a result list.
 * @param {BABYLON.Mesh} mesh
 * @param {ValidationResult[]} results
 * @returns {Promise<ValidationResult[]>} mutated results with fixed flags set
 */
export async function autoFix(mesh, results) {
  for (const r of results) {
    if (!r.autoFixAvailable || r.fixed) continue;
    if (r.type === 'nonManifold') {
      if (typeof BABYLON.VertexData?.MergeByDistance === 'function') {
        const vd = BABYLON.VertexData.ExtractFromMesh(mesh);
        BABYLON.VertexData.MergeByDistance(vd, MERGE_DISTANCE);
        vd.applyToMesh(mesh);
      } else if (typeof mesh.mergeVerticesByDistance === 'function') {
        mesh.mergeVerticesByDistance(MERGE_DISTANCE);
      } else {
        continue;
      }
      r.fixed = true;
    } else if (r.type === 'invertedNormals') {
      const indices = mesh.getIndices();
      if (!indices) continue;
      const flipped = new Uint32Array(indices.length);
      for (let i = 0; i < indices.length; i += 3) {
        flipped[i]     = indices[i];
        flipped[i + 1] = indices[i + 2];
        flipped[i + 2] = indices[i + 1];
      }
      mesh.setIndices(flipped);
      r.fixed = true;
    }
  }
  return results;
}

/** @param {ValidationResult[]} results */
export function hasErrors(results) {
  return results.some(r => r.severity === 'error');
}

/** @param {ValidationResult[]} results */
export function hasWarnings(results) {
  return results.some(r => r.severity === 'warning');
}

/**
 * Re-validate every mesh currently flagged as a Print Part. Grouped shells
 * (sourceGroupId set) collapse to one entry per group — the union check ran
 * against the same geometry for every sibling otherwise.
 * @returns {Promise<Map<string, ValidationResult[]>>}
 */
export async function validateAllPrintParts() {
  const out = new Map();
  const objects = getState().scene.objects;
  const seenGroups = new Set();
  for (const [meshId, obj] of Object.entries(objects)) {
    if (!obj.isPrintPart || obj.isGhost) continue;
    if (obj.sourceGroupId) {
      if (seenGroups.has(obj.sourceGroupId)) continue;
      seenGroups.add(obj.sourceGroupId);
    }
    const babylonMesh = AssetLoader.getBabylonMesh(meshId);
    if (!babylonMesh) continue;
    out.set(meshId, await validateMesh(babylonMesh));
  }
  return out;
}

/** Soft-threshold check used by AssetLoader to skip auto-validation on huge meshes. */
export function shouldAutoValidate(mesh) {
  return (mesh.getTotalVertices?.() ?? 0) <= TRI_BUDGET_AUTO;
}

export const MeshValidator = {
  init, invalidateAll,
  validateMesh, validateGroup, autoFix, hasErrors, hasWarnings,
  validateAllPrintParts, shouldAutoValidate,
};
