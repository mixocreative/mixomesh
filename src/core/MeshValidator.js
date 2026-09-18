import { EVENTS } from './events.js';
import { dispatch, getState, setState, subscribe } from './StateManager.js';
import { AssetLoader } from './AssetLoader.js';
import { logicalObjectPartIds } from './LogicalObjects.js';
import { isValidateWorkerSupported, validateTopologyInWorker } from './ValidateWorker.js';
import { frontFaceIsClockwise } from './print/PrintSpace.js';
import { REPAIR_TRIANGLE_CAP } from './repair/MeshRepair.js';
import { engineDiagnose } from './repair/Diagnose.js';
import { weldArrays } from './repair/Weld.js';

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
    // Force a fresh world matrix: right after import the cached one is the
    // PRE-bake matrix (root reflection × unit scale) — with one sibling
    // refreshed by a render tick and the other not, the parts landed in two
    // different spaces and every seam read as a hole (smoke 2026-09-18).
    babylonMesh.computeWorldMatrix?.(true);
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

/**
 * Holes = open boundary edges as reported by the MeshRepair engine's
 * diagnose(). Emitted ONLY when the engine actually answered (I4): the
 * validator's own edge count mixes boundary AND non-manifold edges, so using
 * it as a fallback double-reported the very same edges as both `nonManifold`
 * and `holes`. Offline, only `nonManifold` speaks.
 *
 * Auto-Fix is offered only when the engine answered AND the geometry is
 * inside the repair cap (I3). A group/union scope is repaired AS ONE SOLID
 * (GroupRepair.repairGroup on the welded union, 2026-09-18) — the old
 * "repair each part" advice capped every material seam.
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
      ? (scope === 'group' ? `${edges} across this multi-part object — Auto-Fix repairs it as one solid` : `${edges} — Auto-Fix fills them`)
      : `${edges}${scope === 'group' ? ' across this multi-part object' : ''} — too large to repair in the browser`,
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

/**
 * Topology verdict for the parts of ONE multi-part object, on their WELDED
 * union. Shared by validateGroup (sourceGroupId siblings) and validateMesh's
 * logical-object branch (glTF multi-primitive) — the two used to carry
 * separate copies of this and only one of them got fixed.
 *
 * The parts of a material-split object share their seam vertices only by
 * POSITION (each part carries its own copy), so the unwelded concatenation
 * showed every seam as an open boundary: a perfectly closed cube split into
 * two materials reported "16 holes" (measured live 2026-09-18). _topology
 * welds internally already; the engine diagnose did not.
 *
 * Auto-Fix on a group result = GroupRepair on the welded union (one solid),
 * offered only when the engine answered and the union is inside the cap.
 */
async function _validateUnion(siblings, label) {
  const results = [];
  const raw = _buildGroupUnion(siblings);
  if (!raw.positions.length || !raw.indices.length) return results;
  const { positions, indices } = weldArrays(raw.positions, raw.indices);
  const fixable = indices.length / 3 <= REPAIR_TRIANGLE_CAP;

  const groupClockwise = _groupOrientation(siblings);
  const { badEdgeCount, inverted } = await _topology(positions, indices, groupClockwise ?? false);
  if (groupClockwise !== null && inverted) results.push(_invertedResult(false));
  const { diag } = await engineDiagnose(positions, indices, label);
  const canFix = fixable && !!diag;
  if (badEdgeCount > 0) {
    results.push({
      ..._nonManifoldResult(badEdgeCount, canFix, { scopeLabel: 'this multi-part object' }),
      scope: 'group',
    });
  }
  if (diag && diag.boundaryEdges > 0) {
    results.push({ ..._holesResult(diag.boundaryEdges, canFix, 'group'), scope: 'group' });
  }
  return results;
}

export async function validateGroup(sourceGroupId) {
  const siblings = _collectGroupSiblings(sourceGroupId);
  if (siblings.length === 0) return [];
  return (await _validateUnion(siblings, `group ${sourceGroupId}`)).map(r => ({ ...r, sourceGroupId }));
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
      // Topology on the WELDED union — one shared routine with validateGroup.
      const siblings = partIds.map(id => ({ meshId: id, babylonMesh: AssetLoader.getBabylonMesh(id) }));
      results.push(...await _validateUnion(siblings, mesh.name ?? 'object'));
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
      const { diag } = await engineDiagnose(mesh);
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

// ── Repair orchestration (src/core/repair/RepairSession.js, review I9) ──
// Re-exported so the public API surface is unchanged: every UI surface and
// test still reaches these through MeshValidator.
export {
  applyGeometryFix, autoFix, repairObject, repairObjects, replayGeometryFixes,
} from './repair/RepairSession.js';
import {
  applyGeometryFix, autoFix, repairObject, repairObjects, replayGeometryFixes,
} from './repair/RepairSession.js';

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
