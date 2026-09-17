import { EVENTS } from './events.js';
import { dispatch, getState, setState, subscribe, markDirty } from './StateManager.js';
import { AssetLoader } from './AssetLoader.js';
import { logicalObjectPartIds } from './LogicalObjects.js';
import { isValidateWorkerSupported, validateTopologyInWorker } from './ValidateWorker.js';
import { frontFaceIsClockwise } from './print/PrintSpace.js';
import { diagnoseMesh, repairMesh, REPAIR_TRIANGLE_CAP } from './repair/MeshRepair.js';
import { weldMesh } from './repair/Weld.js';

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

// Repeated "engine unavailable" / "too large" diagnoses are logged ONCE per
// mesh+reason (they recur on every re-validation and would otherwise bury the
// console); a REAL failure is logged every time.
const _loggedDiagnoseFailures = new Set();

/**
 * MeshRepair diagnose for a mesh, or for a raw positions+indices pair (the
 * group union has no mesh object — diagnoseMesh only ever calls
 * getVerticesData/getIndices, so a duck-typed wrapper is enough).
 *
 * I5: never swallow silently. The reason is classified so the caller can
 * tell "no engine" / "too large to diagnose" (both = "cannot answer", and
 * NOT a geometry verdict) from a real engine failure, and every case is
 * reported to the console with the mesh name.
 *
 * @returns {Promise<{diag: object|null, reason: null|'no-engine'|'too-large'|'failed'}>}
 */
async function _engineDiagnose(meshOrPositions, indices = null, name = 'mesh') {
  const target = indices
    ? { name, getVerticesData: () => meshOrPositions, getIndices: () => indices }
    : meshOrPositions;
  try {
    return { diag: await diagnoseMesh(target), reason: null };
  } catch (err) {
    const message = err?.message ?? String(err);
    const reason = /no engine/i.test(message) ? 'no-engine'
      : /too large/i.test(message) ? 'too-large'
      : 'failed';
    const label = target?.name ?? name;
    const key = `${label}:${reason}`;
    if (reason === 'failed' || !_loggedDiagnoseFailures.has(key)) {
      _loggedDiagnoseFailures.add(key);
      console.error(reason === 'failed'
        ? `MeshValidator: repair-engine diagnose failed for "${label}":`
        : `MeshValidator: repair-engine diagnose unavailable (${reason}) for "${label}":`, message);
    }
    return { diag: null, reason };
  }
}

/**
 * Holes = open boundary edges as reported by the MeshRepair engine's
 * diagnose(). Emitted ONLY when the engine actually answered (I4): the
 * validator's own edge count mixes boundary AND non-manifold edges, so using
 * it as a fallback double-reported the very same edges as both `nonManifold`
 * and `holes`. Offline, only `nonManifold` speaks.
 *
 * Auto-Fix runs `repairMesh` per mesh, so it is offered only when the engine
 * answered AND the mesh is inside the repair cap (I3). A group/union scope
 * never offers it — the repair applies per part, not to the synthetic union
 * — and says so instead of promising a button that is not there (CIA F6).
 */
function _holesResult(count, autoFixAvailable, scope = null) {
  const edges = `${count} open edge${count === 1 ? '' : 's'} (holes)`;
  return {
    type: 'holes',
    severity: 'warning',
    count,
    autoFixAvailable,
    fixed: false,
    message: autoFixAvailable
      ? `${edges} — Auto-Fix fills them`
      : scope === 'group'
        ? `${edges} across this multi-part object — repair each part`
        : `${edges} — too large to repair in the browser`,
  };
}

/**
 * Non-manifold edge count from the validator's own position-welded topology
 * pass. `autoFixAvailable` is gated on the repair cap (I3) — offering a fix
 * that provably throws `too large to repair` is worse than not offering one
 * — and the message says why when it is withheld (CIA F6).
 */
function _nonManifoldResult(count, autoFixAvailable, extra = {}) {
  const suffix = extra.scopeLabel ? ` across ${extra.scopeLabel}` : '';
  return {
    type: 'nonManifold',
    severity: 'warning',
    count,
    autoFixAvailable,
    fixed: false,
    // Warning, not error: a colored-print assembly tool works with downloaded
    // display models that are frequently non-watertight, and slicers
    // (Bambu / Lychee / Cura) auto-repair these. Surfaced, never blocking.
    message: `${count} non-manifold edge${count === 1 ? '' : 's'}${suffix} (slicer-repairable)`
      + (autoFixAvailable || extra.scopeLabel ? '' : ' — too large to repair in the browser'),
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
      ..._nonManifoldResult(badEdgeCount, false, { scopeLabel: 'group' }),
      scope: 'group',
      sourceGroupId,
    });
  }
  // Repair applies per part, not to this synthetic union — never auto-fixable here.
  const { diag } = await _engineDiagnose(positions, indices, `group ${sourceGroupId}`);
  if (diag && diag.boundaryEdges > 0) {
    results.push({ ..._holesResult(diag.boundaryEdges, false, 'group'), scope: 'group', sourceGroupId });
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
            ..._nonManifoldResult(badEdgeCount, false, { scopeLabel: 'object' }),
            scope: 'group',
          });
        }
        // Repair applies per part, not to this synthetic union — never auto-fixable here.
        const { diag } = await _engineDiagnose(up, ui, mesh.name ?? 'object');
        if (diag && diag.boundaryEdges > 0) {
          results.push({ ..._holesResult(diag.boundaryEdges, false, 'group'), scope: 'group' });
        }
      }
    } else {
      // Same orientation rule the print writers use (PrintSpace.printIndices),
      // so "inverted" here means exactly what would come out inside-out.
      const { badEdgeCount, inverted } = await _topology(positions, indices, frontFaceIsClockwise(mesh));
      // I3: everything the engine would have to chew on is capped — an
      // Auto-Fix button that can only throw `too large to repair` is not a fix.
      const repairable = Math.floor(indices.length / 3) <= REPAIR_TRIANGLE_CAP;
      if (badEdgeCount > 0) results.push(_nonManifoldResult(badEdgeCount, repairable));
      if (inverted) results.push(_invertedResult(true));
      // I4: `holes` speaks only when the engine ANSWERED. Its boundary count
      // is boundary edges only; the validator's own badEdgeCount is boundary
      // PLUS non-manifold, so using it as a fallback reported the same edges
      // twice (once as nonManifold, once as holes).
      const { diag } = await _engineDiagnose(mesh);
      if (diag && diag.boundaryEdges > 0) {
        results.push(_holesResult(diag.boundaryEdges, repairable && diag.triangles <= REPAIR_TRIANGLE_CAP));
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

// Pre-engine 'nonManifold' fix (vertex weld only — cannot fill a hole).
// Kept as the offline fallback for 'nonManifold' specifically: unlike
// 'holes', a weld is a real (if weaker) cleanup for non-manifold data, so it
// stays available even when the repair engine cannot load. I6: this used to
// probe two Babylon APIs that do not exist in 9.6.2 and always returned
// false — the shared `weldMesh` (src/core/repair/Weld.js) does it for real,
// and is the same weld the export prep steps run.
function _weldLocally(mesh) {
  return weldMesh(mesh, MERGE_DISTANCE);
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
 * M2: `report` (optional) is filled with the engine's REAL counters
 * (`holesFilled`, `nmFixed`, `normalsFlipped`, `merged`, `isWatertight`) so
 * callers can toast what actually happened instead of re-using the
 * boundary-edge COUNT as if it were a number of holes. Counters accumulate,
 * so one report object can span a whole multi-part object or batch.
 * @param {BABYLON.Mesh} mesh
 * @param {'holes'|'nonManifold'|'invertedNormals'|'mirror-x'|'mirror-y'|'mirror-z'} type
 * @param {{holesFilled?:number, nmFixed?:number, normalsFlipped?:number,
 *          merged?:number, isWatertight?:boolean}|null} [report]
 * @returns {Promise<boolean>} true when the fix was applied
 */
export async function applyGeometryFix(mesh, type, report = null) {
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
      if (report) {
        report.holesFilled = (report.holesFilled ?? 0) + r.holesFilled;
        report.nmFixed = (report.nmFixed ?? 0) + r.nmFixed;
        report.normalsFlipped = (report.normalsFlipped ?? 0) + r.normalsFlipped;
        report.merged = (report.merged ?? 0) + r.merged;
        report.isWatertight = (report.isWatertight ?? true) && r.isWatertight;
      }
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

export async function autoFix(mesh, results, report = null) {
  // 'holes' and 'nonManifold' both repair through the identical repairMesh()
  // engine call (see applyGeometryFix) — when a result list carries both
  // (the same open edges can trip both checks), run the engine once and
  // reuse its outcome rather than repairing the same mesh twice.
  let repairOnce = null;
  for (const r of results) {
    if (!r.autoFixAvailable || r.fixed) continue;
    if (r.type === 'holes' || r.type === 'nonManifold') {
      repairOnce ??= applyGeometryFix(mesh, r.type, report);
      if (await repairOnce) r.fixed = true;
      continue;
    }
    if (await applyGeometryFix(mesh, r.type, report)) r.fixed = true;
  }
  return results;
}

/**
 * Record applied fix types on ONE object. Persisted in .mixo (replayed on
 * reload via replayGeometryFixes) — not undoable, must dirty (M4).
 */
function _recordGeometryFixes(meshId, applied) {
  if (!applied.length) return;
  setState(s => {
    const o = s.scene.objects[meshId];
    if (!o) return s;
    const fixes = [...new Set([...(o.geometryFixes ?? []), ...applied])];
    return { ...s, scene: { ...s.scene, objects: { ...s.scene.objects, [meshId]: { ...o, geometryFixes: fixes } } } };
  }, SILENT);
  markDirty();
}

/**
 * Repair ONE part of a logical object.
 *
 * `groupPart` (a multi-part logical object: MultiMaterial split or glTF
 * multi-primitive) takes the direct engine path. I7a: group-scoped
 * validation reports the welded UNION and never offers a per-part fix — the
 * union is synthetic geometry no fix can be applied to — so the
 * validate → autoFix route left multi-part objects permanently unrepairable.
 * Each sibling is diagnosed on its own and repaired only when the engine
 * says it actually needs it (also C1: a healthy part is never rewritten).
 */
async function _repairOnePart(meshId, groupPart) {
  const mesh = AssetLoader.getBabylonMesh(meshId);
  if (!mesh) return { holesFilled: 0, nmFixed: 0, applied: [] };
  const report = {};
  let applied = [];
  if (groupPart) {
    const { diag } = await _engineDiagnose(mesh);
    const needsRepair = !!diag && (diag.boundaryEdges > 0 || diag.nonManifoldEdges > 0);
    if (needsRepair && await applyGeometryFix(mesh, 'holes', report)) applied = ['holes'];
  } else {
    const results = await validateMesh(mesh);
    await autoFix(mesh, results, report);
    applied = results.filter(r => r.fixed).map(r => r.type);
  }
  _recordGeometryFixes(meshId, applied);
  return { holesFilled: report.holesFilled ?? 0, nmFixed: report.nmFixed ?? 0, applied };
}

/**
 * One-click repair entry point shared by every UI surface (import toast,
 * Outliner badge, context menu, Print panel "Repair all") so applied fixes
 * are recorded identically no matter where the user triggered them.
 *
 * A multi-part logical object repairs every live part sequentially and
 * records `geometryFixes` per part (I7a). `holesFilled`/`nmFixed` are the
 * ENGINE's own counters (M2), not the boundary-edge count. `applied` is
 * empty when nothing was actually changed — callers must report that as
 * "nothing to repair", never as success (I7b), and `remaining` says what is
 * still wrong (M3).
 *
 * Tolerant of a missing mesh/engine: `autoFix`/`applyGeometryFix` already
 * fall back (nonManifold → local weld) or leave `holes` unfixed, so this
 * never throws for "no engine" — only a real repair failure propagates.
 * @param {string} meshId
 * @returns {Promise<{ holesFilled: number, nmFixed: number, applied: string[],
 *                     remaining: ValidationResult[] }>}
 */
export async function repairObject(meshId) {
  const objects = getState().scene.objects;
  const partIds = logicalObjectPartIds(meshId, objects)
    .filter(id => objects[id] && !objects[id].isGhost && AssetLoader.getBabylonMesh(id));
  const ids = partIds.length ? partIds : (AssetLoader.getBabylonMesh(meshId) ? [meshId] : []);
  if (!ids.length) return { holesFilled: 0, nmFixed: 0, applied: [], remaining: [] };

  const groupPart = ids.length > 1;
  let holesFilled = 0, nmFixed = 0;
  const applied = [];
  for (const id of ids) {
    const part = await _repairOnePart(id, groupPart);
    holesFilled += part.holesFilled;
    nmFixed += part.nmFixed;
    applied.push(...part.applied);
  }

  const lead = AssetLoader.getBabylonMesh(meshId) ?? AssetLoader.getBabylonMesh(ids[0]);
  const remaining = lead ? await validateMesh(lead) : [];
  return { holesFilled, nmFixed, applied: [...new Set(applied)], remaining };
}

/**
 * Batch entry point for the "repair every selected/print-part object" UI
 * surfaces (context menu, Print panel "Repair all") — the sequential
 * repairObject loop lived duplicated in both call sites; this is the one
 * shared version. Sequential (not Promise.all) so a heavy mesh doesn't
 * contend with another for the main thread, and tolerant: a failing object
 * is recorded in `failed` rather than aborting the rest of the batch.
 * `repaired` counts the objects where a fix was actually applied — 0 means
 * "nothing to repair", which callers must NOT report as success (I7b/I7c).
 * @param {string[]} meshIds
 * @param {{ onProgress?: (frac: number, name: string) => void }} [opts]
 * @returns {Promise<{ holesFilled: number, nmFixed: number, repaired: number,
 *                     failed: Array<{ meshId: string, name: string, error: unknown }> }>}
 */
export async function repairObjects(meshIds, { onProgress } = {}) {
  let holesFilled = 0;
  let nmFixed = 0;
  let repaired = 0;
  const failed = [];
  const total = meshIds.length;
  for (let i = 0; i < total; i++) {
    const meshId = meshIds[i];
    const name = getState().scene.objects[meshId]?.name ?? meshId;
    onProgress?.(i / total, name);
    try {
      const res = await repairObject(meshId);
      holesFilled += res.holesFilled;
      nmFixed += res.nmFixed;
      if (res.applied.length) repaired++;
    } catch (error) {
      failed.push({ meshId, name, error });
    }
  }
  return { holesFilled, nmFixed, repaired, failed };
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
  validateMesh, validateGroup, autoFix, applyGeometryFix, replayGeometryFixes, repairObject, repairObjects,
  hasErrors, hasWarnings,
  validateAllPrintParts, shouldAutoValidate,
};
