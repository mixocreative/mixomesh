import { EVENTS } from './events.js';
import { dispatch, getState, setState, subscribe, markDirty } from './StateManager.js';
import { AssetLoader } from './AssetLoader.js';
import { logicalObjectPartIds } from './LogicalObjects.js';
import { isValidateWorkerSupported, validateTopologyInWorker } from './ValidateWorker.js';
import { frontFaceIsClockwise } from './print/PrintSpace.js';
import { diagnoseMesh, repairMesh } from './repair/MeshRepair.js';

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
 * part of validation on dense meshes). Robust for closed meshes; a cheap
 * heuristic for open ones (same status as before). Sign is transform-
 * invariant, so local positions are fine.
 *
 * The sign that means "outward" depends on the mesh's effective side
 * orientation (see PrintSpace.frontFaceIsClockwise, verified 2026-09-17):
 * Babylon is left-handed, so a CounterClockWise-flagged mesh (native
 * primitives, OBJ/STL/3MF imports, Boolean results) renders outward when the
 * right-handed signed volume is NEGATIVE, while a ClockWise-flagged mesh
 * (glTF imports) renders outward when it is POSITIVE. The old unconditional
 * `V < 0 ⇒ inverted` was only right for ClockWise meshes and flagged every
 * correct CounterClockWise mesh.
 * @param {boolean} clockwise  effective front-face winding of the mesh
 */
function _checkInvertedNormals(positions, indices, clockwise) {
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
  return clockwise ? v6 < 0 : v6 > 0;
}

/**
 * Topology pass (non-manifold edge count + inverted winding) for one
 * positions/indices pair. Runs in a Web Worker when available so a heavy
 * print model (80k+ tris) never blocks the UI thread; falls back to the
 * inline pure-JS path (Node tests, no Worker).
 * @param {boolean} clockwise  effective front-face winding (frontFaceIsClockwise)
 * @returns {Promise<{ badEdgeCount: number, inverted: boolean }>}
 */
async function _topology(positions, indices, clockwise = false) {
  if (isValidateWorkerSupported()) {
    try {
      return await validateTopologyInWorker(positions, indices, clockwise);
    } catch {
      /* worker unavailable / crashed — fall through to inline */
    }
  }
  return {
    badEdgeCount: _checkNonManifold(positions, indices),
    inverted: _checkInvertedNormals(positions, indices, clockwise),
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
  let iOff = 0, vOff = 0;
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
  }
  return { positions, indices };
}

/**
 * Run topology checks on the welded union of all siblings sharing a
 * sourceGroupId. Inverted-normals is skipped on group scope — raycasting
 * against a synthetic union mesh adds complexity for a heuristic the slicer
 * also corrects, and split shells frequently mislead the per-mesh check.
 */
// Nothing flips on export (audit M1) — the repair is the explicit Auto-Fix
// action (applyGeometryFix 'invertedNormals' = index flip). Group scope
// reports without an auto-fix: the flip must be applied per sibling.
function _invertedResult(autoFixAvailable) {
  return {
    type: 'invertedNormals',
    severity: 'warning',
    count: 1,
    autoFixAvailable,
    fixed: false,
    message: autoFixAvailable
      ? 'Normals appear inverted — use Auto-Fix to flip'
      : 'Normals appear inverted on this multi-part object — flip each part',
  };
}

// Boundary-edge count from the MeshRepair engine, or null when the engine is
// unavailable (validateMesh/validateGroup then fall back to their own
// edge-count). Accepts either a live Babylon mesh (getVerticesData/
// getIndices) OR raw positions+indices (the group union has no mesh object —
// diagnoseMesh only ever calls those two methods, so a plain object wrapper
// is enough).
async function _engineBoundary(meshOrPositions, indices) {
  const target = indices
    ? { getVerticesData: () => meshOrPositions, getIndices: () => indices }
    : meshOrPositions;
  try {
    const d = await diagnoseMesh(target);
    return d.boundaryEdges;
  } catch {
    return null;
  }
}

// Holes = open boundary edges reported by the MeshRepair engine's diagnose()
// (falls back to the validator's own edge-count when the engine is
// unavailable — see validateMesh/validateGroup). Auto-Fix runs repairMesh
// through the engine, so it is only offered when the engine actually
// answered (repairDiag present); a group/union scope never offers it here
// because the repair applies per part, not to the synthetic union.
function _holesResult(count, autoFixAvailable) {
  return {
    type: 'holes',
    severity: 'warning',
    count,
    autoFixAvailable,
    fixed: false,
    message: `${count} open edge${count === 1 ? '' : 's'} (holes) — Auto-Fix fills them`,
  };
}

// Shared side orientation of a logical object's siblings (one import → one
// flag). null when they disagree, in which case the inverted check is skipped
// rather than guessed (a wrong flag would report a correct mesh as inverted).
function _groupOrientation(siblings) {
  const flags = new Set(siblings
    .map(s => s.babylonMesh).filter(Boolean)
    .map(m => frontFaceIsClockwise(m)));
  if (flags.size !== 1) {
    if (flags.size > 1) console.warn('MeshValidator: siblings disagree on side orientation — inverted check skipped');
    return null;
  }
  return [...flags][0];
}

export async function validateGroup(sourceGroupId) {
  const siblings = _collectGroupSiblings(sourceGroupId);
  const results = [];
  if (siblings.length === 0) return results;
  const { positions, indices } = _buildGroupUnion(siblings);
  if (!positions.length || !indices.length) return results;

  const groupClockwise = _groupOrientation(siblings);
  const { badEdgeCount, inverted } = await _topology(positions, indices, groupClockwise ?? false);
  if (groupClockwise !== null && inverted) results.push(_invertedResult(false));
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
  const engineBoundary = await _engineBoundary(positions, indices);
  const boundary = engineBoundary ?? badEdgeCount;
  // Repair applies per part, not to this synthetic union — never auto-fixable here.
  if (boundary > 0) results.push({ ..._holesResult(boundary, false), scope: 'group', sourceGroupId });
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
      // Topology on the welded union. Inverted check uses the siblings'
      // shared side flag (one import → one flag); mixed flags → skipped.
      const siblings = partIds.map(id => ({ meshId: id, babylonMesh: AssetLoader.getBabylonMesh(id) }));
      const { positions: up, indices: ui } = _buildGroupUnion(siblings);
      if (up.length && ui.length) {
        const groupClockwise = _groupOrientation(siblings);
        const { badEdgeCount, inverted } = await _topology(up, ui, groupClockwise ?? false);
        if (groupClockwise !== null && inverted) results.push(_invertedResult(false));
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
        const engineBoundary = await _engineBoundary(up, ui);
        const boundary = engineBoundary ?? badEdgeCount;
        // Repair applies per part, not to this synthetic union — never auto-fixable here.
        if (boundary > 0) results.push({ ..._holesResult(boundary, false), scope: 'group' });
      }
    } else {
      // Same orientation rule the print writers use (PrintSpace.printIndices),
      // so "inverted" here means exactly what would come out inside-out.
      const { badEdgeCount, inverted } = await _topology(positions, indices, frontFaceIsClockwise(mesh));
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
      if (inverted) results.push(_invertedResult(true));
      // Engine present ⇒ Auto-Fix can run repairMesh; engine missing ⇒ still
      // report the open-edge count from the validator's own topology pass,
      // just without an available fix (never throw for a missing engine).
      const engineBoundary = await _engineBoundary(mesh);
      const boundary = engineBoundary ?? badEdgeCount;
      if (boundary > 0) results.push(_holesResult(boundary, engineBoundary !== null));
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

// Pre-engine 'nonManifold' fix (position weld only — cannot fill a hole).
// Kept as the offline fallback for 'nonManifold' specifically: unlike
// 'holes', a plain weld is a real (if weaker) fix for non-manifold edges, so
// it stays available even when the repair engine cannot load.
function _weldLocally(mesh) {
  if (typeof BABYLON.VertexData?.MergeByDistance === 'function') {
    const vd = BABYLON.VertexData.ExtractFromMesh(mesh);
    BABYLON.VertexData.MergeByDistance(vd, MERGE_DISTANCE);
    vd.applyToMesh(mesh);
    return true;
  }
  if (typeof mesh.mergeVerticesByDistance === 'function') {
    mesh.mergeVerticesByDistance(MERGE_DISTANCE);
    return true;
  }
  return false;
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
 * `mirror-x|y|z` (placement, ADR 0003) is also recorded + replayed here: reflect
 * the LOCAL geometry about its bbox centre on that axis, reverse winding, recompute
 * normals — UVs are preserved (unlike CSG2), so textured parts mirror cleanly. It is
 * its own inverse (mirror twice = identity), which the command relies on for undo.
 * `holes` and `nonManifold` both repair through the MeshRepair engine
 * (repairMesh) — the same vendored pipeline (merge → winding → non-manifold
 * → hole fill), so either type closes holes AND welds non-manifold edges in
 * one pass; async because the engine load / repair run is async. `nonManifold`
 * additionally falls back to a local position-weld when the engine itself is
 * unavailable (validateMesh always offers it, unlike `holes`, whose
 * autoFixAvailable already tracks engine presence) — see `_weldLocally`.
 * @param {BABYLON.Mesh} mesh
 * @param {'holes'|'nonManifold'|'invertedNormals'|'mirror-x'|'mirror-y'|'mirror-z'} type
 * @returns {Promise<boolean>} true when the fix was applied
 */
export async function applyGeometryFix(mesh, type) {
  if (!mesh) return false;
  if (type === 'mirror-x' || type === 'mirror-y' || type === 'mirror-z') {
    const positions = mesh.getVerticesData?.(BABYLON.VertexBuffer.PositionKind);
    const indices = mesh.getIndices?.();
    if (!positions || !indices) return false;
    const a = type === 'mirror-x' ? 0 : type === 'mirror-y' ? 1 : 2;
    let lo = Infinity, hi = -Infinity;
    for (let i = a; i < positions.length; i += 3) { if (positions[i] < lo) lo = positions[i]; if (positions[i] > hi) hi = positions[i]; }
    const twiceCentre = lo + hi;   // reflect v → (lo+hi) - v  (about the axis midpoint)
    for (let i = a; i < positions.length; i += 3) positions[i] = twiceCentre - positions[i];
    const flipped = new Uint32Array(indices.length);
    for (let i = 0; i < indices.length; i += 3) { flipped[i] = indices[i]; flipped[i + 1] = indices[i + 2]; flipped[i + 2] = indices[i + 1]; }
    mesh.setVerticesData(BABYLON.VertexBuffer.PositionKind, positions);
    mesh.setIndices(flipped);
    const normals = [];
    BABYLON.VertexData.ComputeNormals(positions, flipped, normals);
    mesh.setVerticesData(BABYLON.VertexBuffer.NormalKind, normals);
    mesh.refreshBoundingInfo?.();
    return true;
  }
  if (type === 'holes' || type === 'nonManifold') {
    try {
      const r = await repairMesh(mesh);
      return r.changed;
    } catch (err) {
      // 'holes' has no engine-free equivalent (local weld can't fill a hole) —
      // only 'nonManifold' falls back, and only for the "engine missing" class
      // of failure (ensureRepairEngine/_loadEngine's messages all start with
      // "no engine" — see MeshRepair.js); a real failure (e.g. the triangle-cap
      // guard) must still surface as an error, not be swallowed.
      if (type !== 'nonManifold' || !/no engine/i.test(err?.message ?? '')) throw err;
      return _weldLocally(mesh);
    }
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
  // 'holes' and 'nonManifold' both repair through the identical repairMesh()
  // engine call (see applyGeometryFix) — when a result list carries both
  // (the same open edges can trip both checks), run the engine once and
  // reuse its outcome rather than repairing the same mesh twice.
  let repairOnce = null;
  for (const r of results) {
    if (!r.autoFixAvailable || r.fixed) continue;
    if (r.type === 'holes' || r.type === 'nonManifold') {
      repairOnce ??= applyGeometryFix(mesh, r.type);
      if (await repairOnce) r.fixed = true;
      continue;
    }
    if (await applyGeometryFix(mesh, r.type)) r.fixed = true;
  }
  return results;
}

/**
 * One-click repair entry point shared by every UI surface (import toast,
 * Outliner badge, context menu, Print panel "Repair all") so applied fixes
 * are recorded identically no matter where the user triggered them — same
 * validate → autoFix → record `geometryFixes` → markDirty sequence as the
 * Print tab's per-result Auto-Fix button (PrintPanel.js), plus a final
 * re-validate so the caller can report what (if anything) is still wrong.
 * Tolerant of a missing mesh/engine: `autoFix`/`applyGeometryFix` already
 * fall back (nonManifold → local weld) or leave `holes` unfixed, so this
 * never throws for "no engine" — only a real repair failure propagates.
 * @param {string} meshId
 * @returns {Promise<{ holesFilled: number, nmFixed: number, remaining: ValidationResult[] }>}
 */
export async function repairObject(meshId) {
  const mesh = AssetLoader.getBabylonMesh(meshId);
  if (!mesh) return { holesFilled: 0, nmFixed: 0, remaining: [] };

  const results = await validateMesh(mesh);
  await autoFix(mesh, results);

  // Same recording as PrintPanel's per-result Auto-Fix button: persisted in
  // .mixo (replayed on reload via replayGeometryFixes) — not undoable, must
  // dirty (M4).
  const applied = results.filter(r => r.fixed).map(r => r.type);
  if (applied.length) {
    setState(s => {
      const o = s.scene.objects[meshId];
      if (!o) return s;
      const fixes = [...new Set([...(o.geometryFixes ?? []), ...applied])];
      return { ...s, scene: { ...s.scene, objects: { ...s.scene.objects, [meshId]: { ...o, geometryFixes: fixes } } } };
    }, SILENT);
    markDirty();
  }

  const holesFilled = results.find(r => r.type === 'holes' && r.fixed)?.count ?? 0;
  const nmFixed = results.find(r => r.type === 'nonManifold' && r.fixed)?.count ?? 0;
  const remaining = await validateMesh(mesh);
  return { holesFilled, nmFixed, remaining };
}

/**
 * Re-apply persisted geometry fixes after a reload (M1). The `.mixo` keeps raw
 * source bytes + ratio, so the restored mesh comes back with its original
 * defects; replaying the recorded fix types reproduces the repaired geometry.
 * Must run AT the displayed scale (after the ratio bake) — see applyGeometryFix.
 * @param {BABYLON.Mesh} mesh
 * @param {string[]} types
 * @returns {Promise<void>}
 */
export async function replayGeometryFixes(mesh, types) {
  if (!mesh?.geometry || !Array.isArray(types)) return;
  for (const type of types) await applyGeometryFix(mesh, type);
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
  validateMesh, validateGroup, autoFix, applyGeometryFix, replayGeometryFixes, repairObject,
  hasErrors, hasWarnings,
  validateAllPrintParts, shouldAutoValidate,
};
