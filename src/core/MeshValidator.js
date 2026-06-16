import { EVENTS } from './events.js';
import { dispatch, getState, setState, subscribe } from './StateManager.js';
import { AssetLoader } from './AssetLoader.js';
import { logicalObjectPartIds } from './LogicalObjects.js';
import { isValidateWorkerSupported, validateTopologyInWorker } from './ValidateWorker.js';

const BABYLON = window.BABYLON;
if (!BABYLON) throw new Error('Babylon.js failed to load');

// ── Tunables ─────────────────────────────────────────────
const MERGE_DISTANCE   = 1e-4;      // 0.1 mm (Babylon units = meters)
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
 * Inverted-winding test via signed mesh volume — one O(tris) pass, no ray
 * casts or octree (the old 64-ray heuristic was O(tris) PER ray = the heavy
 * part of validation on dense meshes). V < 0 ⇒ inward winding. Robust for
 * closed meshes; a cheap heuristic for open ones (same status as before).
 * Sign is transform-invariant, so local positions are fine.
 */
function _checkInvertedNormals(positions, indices) {
  let v6 = 0;
  for (let i = 0; i < indices.length; i += 3) {
    const i0 = indices[i] * 3, i1 = indices[i + 1] * 3, i2 = indices[i + 2] * 3;
    const ax = positions[i0], ay = positions[i0 + 1], az = positions[i0 + 2];
    const bx = positions[i1], by = positions[i1 + 1], bz = positions[i1 + 2];
    const cx = positions[i2], cy = positions[i2 + 1], cz = positions[i2 + 2];
    const crx = by * cz - bz * cy;
    const cry = bz * cx - bx * cz;
    const crz = bx * cy - by * cx;
    v6 += ax * crx + ay * cry + az * crz;
  }
  return v6 < 0;
}

/**
 * Topology pass (non-manifold edge count + inverted winding) for one
 * positions/indices pair. Runs in a Web Worker when available so a heavy
 * print model (80k+ tris) never blocks the UI thread; falls back to the
 * inline pure-JS path (Node tests, no Worker).
 * @returns {Promise<{ badEdgeCount: number, inverted: boolean }>}
 */
async function _topology(positions, indices) {
  if (isValidateWorkerSupported()) {
    try {
      return await validateTopologyInWorker(positions, indices);
    } catch {
      /* worker unavailable / crashed — fall through to inline */
    }
  }
  return {
    badEdgeCount: _checkNonManifold(positions, indices),
    inverted: _checkInvertedNormals(positions, indices),
  };
}

// Bed-overflow validation was removed in the per-object ratio redesign
// (2026-06-16): with per-object ratios there is no single scene→bed scale, and
// the user dropped the fit-check. Bed/grid/camera VISUALS stay (cosmetic).

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

  const { badEdgeCount } = await _topology(positions, indices);
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

// Monotonic invalidation counter per meshId. Bumped on every edit event so an
// async validateMesh can detect that the geometry changed WHILE its worker pass
// was in flight, and refuse to cache the now-stale result as fresh.
const _seq = new Map();
function _bumpSeq(meshIds) {
  for (const id of [].concat(meshIds)) if (id) _seq.set(id, (_seq.get(id) ?? 0) + 1);
}
function _seqOf(id) { return _seq.get(id) ?? 0; }

function _cacheResults(meshIds, results, stale = false) {
  const ids = [].concat(meshIds).filter(Boolean);
  if (!ids.length) return;
  setState(s => {
    const v = { ...s.scene.validation };
    const validatedAt = Date.now();
    for (const id of ids) v[id] = { results, validatedAt, stale };
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
  subscribe(EVENTS.TRANSFORM_COMMITTED, (p) => { const ids = p?.meshIds ?? []; _bumpSeq(ids); _markStale(ids); });
  subscribe(EVENTS.OBJECT_UPDATED, (p) => { const ids = p?.meshId ? [p.meshId] : []; _bumpSeq(ids); _markStale(ids); });
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
  const objects = getState().scene.objects;
  const selfId  = mesh.metadata?.meshId ?? null;
  // Snapshot the invalidation counter; if it changes during the async topology
  // pass (user edited the mesh mid-validation), the cached result is stale.
  const startSeq = _seqOf(selfId);
  // The logical object's live, non-ghost parts. >1 ⇒ a multi-part object
  // (MultiMaterial split OR glTF multi-primitive): validate the WELDED UNION so
  // the seams between parts aren't reported as holes and a real hole across the
  // whole object IS caught. Single-part ⇒ validate the mesh directly.
  const partIds = selfId
    ? logicalObjectPartIds(selfId, objects).filter(id =>
        objects[id] && !objects[id].isGhost && AssetLoader.getBabylonMesh(id))
    : [];
  const isLogicalGroup = partIds.length > 1;

  const positions = _getPositions(mesh);
  const indices   = _getIndices(mesh);

  if (positions && indices && indices.length > 0) {
    if (isLogicalGroup) {
      // Topology on the welded union; inverted-normals skipped on group scope.
      const siblings = partIds.map(id => ({ meshId: id, babylonMesh: AssetLoader.getBabylonMesh(id) }));
      const { positions: up, indices: ui } = _buildGroupUnion(siblings);
      if (up.length && ui.length) {
        const { badEdgeCount } = await _topology(up, ui);
        if (badEdgeCount > 0) {
          results.push({
            type: 'nonManifold',
            severity: 'warning',
            count: badEdgeCount,
            autoFixAvailable: false,
            fixed: false,
            scope: 'group',
            message: `${badEdgeCount} non-manifold edge${badEdgeCount === 1 ? '' : 's'} across object (slicer-repairable)`,
          });
        }
      }
    } else {
      const { badEdgeCount, inverted } = await _topology(positions, indices);
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

  // Cache (A6): only for the LIVE registered mesh — export clones carry the
  // source meshId in metadata but must not overwrite live results.
  const meshId = selfId;
  const isLive = !!meshId && AssetLoader.getBabylonMesh(meshId) === mesh;
  if (isLive) {
    // If an edit invalidated this mesh while the worker ran, cache as stale so
    // the Outliner/Print badge doesn't show "valid" for changed geometry.
    const stale = _seqOf(meshId) !== startSeq;
    if (isLogicalGroup) {
      // Group-scoped topology results attach to every logical part so each
      // sibling's Outliner/Properties badge reflects the whole-object verdict.
      const siblingIds = partIds.filter(id => id !== meshId);
      if (siblingIds.length) _cacheResults(siblingIds, results.filter(r => r.scope === 'group'), stale);
    }
    _cacheResults([meshId], results, stale);
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
/**
 * Apply ONE geometry fix by type to a live mesh. Shared by `autoFix` (the
 * Print-tab button) and persistence replay so the on-load reproduction is
 * bit-for-bit the same operation. Both fixes are scale-sensitive only via the
 * absolute MERGE_DISTANCE, so callers must apply them AT the displayed scale
 * (after the import seed + per-object ratio bake) for the weld to behave the
 * same on reload as it did when first applied.
 * @param {BABYLON.Mesh} mesh
 * @param {'nonManifold'|'invertedNormals'} type
 * @returns {boolean} true when the fix was applied
 */
export function applyGeometryFix(mesh, type) {
  if (!mesh) return false;
  if (type === 'nonManifold') {
    if (typeof BABYLON.VertexData?.MergeByDistance === 'function') {
      const vd = BABYLON.VertexData.ExtractFromMesh(mesh);
      BABYLON.VertexData.MergeByDistance(vd, MERGE_DISTANCE);
      vd.applyToMesh(mesh);
    } else if (typeof mesh.mergeVerticesByDistance === 'function') {
      mesh.mergeVerticesByDistance(MERGE_DISTANCE);
    } else {
      return false;
    }
    return true;
  }
  if (type === 'invertedNormals') {
    const indices = mesh.getIndices();
    if (!indices) return false;
    const flipped = new Uint32Array(indices.length);
    for (let i = 0; i < indices.length; i += 3) {
      flipped[i]     = indices[i];
      flipped[i + 1] = indices[i + 2];
      flipped[i + 2] = indices[i + 1];
    }
    mesh.setIndices(flipped);
    return true;
  }
  return false;
}

export async function autoFix(mesh, results) {
  for (const r of results) {
    if (!r.autoFixAvailable || r.fixed) continue;
    if (applyGeometryFix(mesh, r.type)) r.fixed = true;
  }
  return results;
}

/**
 * Re-apply persisted geometry fixes after a reload (M1). The `.mixo` keeps raw
 * source bytes + ratio, so the restored mesh comes back with its original
 * defects; replaying the recorded fix types reproduces the repaired geometry.
 * Must run AT the displayed scale (after the ratio bake) — see applyGeometryFix.
 * @param {BABYLON.Mesh} mesh
 * @param {string[]} types
 */
export function replayGeometryFixes(mesh, types) {
  if (!mesh?.geometry || !Array.isArray(types)) return;
  for (const type of types) applyGeometryFix(mesh, type);
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
  validateMesh, validateGroup, autoFix, applyGeometryFix, replayGeometryFixes,
  hasErrors, hasWarnings,
  validateAllPrintParts, shouldAutoValidate,
};
