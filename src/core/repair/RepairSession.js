/**
 * RepairSession — the repair ORCHESTRATION layer (review I9).
 *
 * `MeshValidator.js` had grown to own two jobs: deciding what is wrong with a
 * mesh (the checks + the result cache) and carrying out repairs (the engine
 * calls, the per-part walk, the `geometryFixes` bookkeeping, the persistence
 * replay). The second job lives here; `MeshValidator.js` re-exports every
 * name so the public API surface is unchanged (`applyGeometryFix`, `autoFix`,
 * `repairObject`, `repairObjects`, `replayGeometryFixes`).
 *
 * The import edge back to MeshValidator (`validateMesh`) is deliberate and
 * one-directional in practice: repairing means validate → fix → re-validate,
 * and only function declarations cross the cycle, so both modules are fully
 * initialised before any of them is called.
 */

import { getState, setState, markDirty } from '../StateManager.js';
import { AssetLoader } from '../AssetLoader.js';
import { logicalObjectPartIds } from '../LogicalObjects.js';
import { validateMesh } from '../MeshValidator.js';
import { repairMesh } from './MeshRepair.js';
import { repairGroup, toLeadMatrix } from './GroupRepair.js';
import { withRestTransform } from '../scene/ImportBounce.js';
import { weldMesh, WELD_DISTANCE } from './Weld.js';

const BABYLON = window.BABYLON;
if (!BABYLON) throw new Error('Babylon.js failed to load');

const SILENT = { silent: true };

// Pre-engine 'nonManifold' fix (vertex weld only — cannot fill a hole).
// Kept as the offline fallback for 'nonManifold' specifically: unlike
// 'holes', a weld is a real (if weaker) cleanup for non-manifold data, so it
// stays available even when the repair engine cannot load. I6: this used to
// probe two Babylon APIs that do not exist in 9.6.2 and always returned
// false — the shared `weldMesh` (./Weld.js) does it for real, and is the same
// weld the export prep steps run.
function _weldLocally(mesh) {
  return weldMesh(mesh, WELD_DISTANCE);
}

/**
 * Apply ONE geometry fix by type to a live mesh. Shared by `autoFix` (the
 * Print-tab button) and persistence replay so the on-load reproduction is
 * bit-for-bit the same operation. Both fixes are scale-sensitive only via the
 * absolute WELD_DISTANCE, so callers must apply them AT the displayed scale
 * (after the import seed + per-object ratio bake) for the weld to behave the
 * same on reload as it did when first applied.
 *
 * `mirror-x|y|z` (placement, ADR 0003) is also recorded + replayed here:
 * reflect the LOCAL geometry about its bbox centre on that axis, reverse
 * winding, recompute normals — UVs are preserved (unlike CSG2), so textured
 * parts mirror cleanly. It is its own inverse (mirror twice = identity),
 * which the command relies on for undo.
 *
 * `holes` and `nonManifold` both repair through the MeshRepair engine
 * (repairMesh) — the same vendored pipeline (merge → winding → non-manifold
 * → hole fill), so either type closes holes AND welds non-manifold edges in
 * one pass; async because the engine load / repair run is async.
 * `nonManifold` additionally falls back to a local weld when the engine
 * itself is unavailable (validateMesh always offers it, unlike `holes`, whose
 * autoFixAvailable already tracks engine presence) — see `_weldLocally`.
 *
 * M2: `report` (optional) is filled with the engine's REAL counters
 * (`holesFilled`, `nmFixed`, `normalsFlipped`, `merged`, `isWatertight`) so
 * callers can toast what actually happened instead of re-using the
 * boundary-edge COUNT as if it were a number of holes. Counters accumulate,
 * so one report object can span a whole multi-part object or batch.
 *
 * @param {BABYLON.Mesh} mesh
 * @param {'holes'|'nonManifold'|'invertedNormals'|'mirror-x'|'mirror-y'|'mirror-z'} type
 * @param {{holesFilled?:number, nmFixed?:number, normalsFlipped?:number,
 *          merged?:number, isWatertight?:boolean}|null} [report]
 * @returns {Promise<boolean>} true when the fix was applied
 */
export async function applyGeometryFix(mesh, type, report = null, opts = {}) {
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
      const r = await repairMesh(mesh, { onProgress: opts.onProgress });
      if (report) {
        report.holesFilled = (report.holesFilled ?? 0) + r.holesFilled;
        report.nmFixed = (report.nmFixed ?? 0) + r.nmFixed;
        report.normalsFlipped = (report.normalsFlipped ?? 0) + r.normalsFlipped;
        report.merged = (report.merged ?? 0) + r.merged;
        report.isWatertight = (report.isWatertight ?? true) && r.isWatertight;
      }
      return r.changed;
    } catch (err) {
      // 'holes' has no engine-free equivalent (a weld can't fill a hole) —
      // only 'nonManifold' falls back, and only for the "engine missing" class
      // of failure (ensureRepairEngine/_loadEngine's messages all start with
      // "no engine" — see MeshRepair.js); a real failure (e.g. the triangle-cap
      // guard, malformed engine output) must still surface, not be swallowed.
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

/**
 * Apply every available auto-fix in a result list, marking `fixed` on each.
 * @param {BABYLON.Mesh} mesh
 * @param {ValidationResult[]} results
 * @param {object|null} [report] see applyGeometryFix (M2)
 * @returns {Promise<ValidationResult[]>} the same list, with `fixed` flags set
 */
export async function autoFix(mesh, results, report = null, opts = {}) {
  // 'holes' and 'nonManifold' both repair through the identical repairMesh()
  // engine call (see applyGeometryFix) — when a result list carries both
  // (the same open edges can trip both checks), run the engine once and
  // reuse its outcome rather than repairing the same mesh twice.
  let repairOnce = null;
  for (const r of results) {
    if (!r.autoFixAvailable || r.fixed) continue;
    // A group-scoped result describes the welded UNION of a multi-part
    // object; per-mesh fixes do not apply to it — repairObject() routes those
    // through GroupRepair. Never cap a single part here on its behalf.
    if (r.scope === 'group') continue;
    if (r.type === 'holes' || r.type === 'nonManifold') {
      repairOnce ??= applyGeometryFix(mesh, r.type, report, opts);
      if (await repairOnce) r.fixed = true;
      continue;
    }
    if (await applyGeometryFix(mesh, r.type, report, opts)) r.fixed = true;
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
 * Repair ONE single-part logical object: validate → autoFix (every fixable
 * result type) → record.
 */
async function _repairSinglePart(meshId, { record = true, onProgress } = {}) {
  const mesh = AssetLoader.getBabylonMesh(meshId);
  if (!mesh) return { holesFilled: 0, nmFixed: 0, applied: [] };
  const report = {};
  const results = await validateMesh(mesh);
  await autoFix(mesh, results, report, { onProgress });
  const applied = results.filter(r => r.fixed).map(r => r.type);
  if (record) _recordGeometryFixes(meshId, applied);
  return { holesFilled: report.holesFilled ?? 0, nmFixed: report.nmFixed ?? 0, applied };
}

/**
 * Repair a MULTI-PART logical object (MultiMaterial split / glTF
 * multi-primitive) as ONE solid — GroupRepair.repairGroup on the welded
 * union of its parts, each part written back with its own triangles and
 * UVs. The previous per-part path capped every material seam (a closed
 * split cube came back with an internal wall) — see GroupRepair.js.
 * Records the `groupRepair` fix type on EVERY part so a reload replays it
 * once for the whole object (ProjectLoader).
 */
async function _repairGroupParts(ids, { record = true, onProgress } = {}) {
  const meshes = ids.map(id => AssetLoader.getBabylonMesh(id)).filter(Boolean);
  if (!meshes.length) return { holesFilled: 0, nmFixed: 0, applied: [] };
  const lead = meshes[0];
  // Part → lead matrices at REST: a mid-bounce scale must never leak into
  // the union (see MeshValidator._buildGroupUnion).
  const parts = withRestTransform(() => meshes.map(mesh => ({ mesh, toLead: toLeadMatrix(mesh, lead) })));
  const name = getState().scene.objects[ids[0]]?.name ?? lead.name;
  const r = await repairGroup(parts, { name, onProgress });
  const applied = r.changed ? ['groupRepair'] : [];
  if (record && applied.length) for (const id of ids) _recordGeometryFixes(id, applied);
  return { holesFilled: r.holesFilled, nmFixed: r.nmFixed, applied };
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
 * "nothing to repair", never as success (I7b, see ui/RepairFeedback.js) — and
 * `remaining` says what is still wrong (M3).
 *
 * Tolerant of a missing mesh/engine: `autoFix`/`applyGeometryFix` already
 * fall back (nonManifold → local weld) or leave `holes` unfixed, so this
 * never throws for "no engine" — only a real repair failure propagates.
 * @param {string} meshId
 * @returns {Promise<{ holesFilled: number, nmFixed: number, applied: string[],
 *                     remaining: ValidationResult[] }>}
 */
export async function repairObject(meshId, { record = true, onProgress } = {}) {
  const objects = getState().scene.objects;
  const partIds = logicalObjectPartIds(meshId, objects)
    .filter(id => objects[id] && !objects[id].isGhost && AssetLoader.getBabylonMesh(id));
  const ids = partIds.length ? partIds : (AssetLoader.getBabylonMesh(meshId) ? [meshId] : []);
  if (!ids.length) return { holesFilled: 0, nmFixed: 0, applied: [], remaining: [] };

  const runOnce = () => (ids.length > 1
    ? _repairGroupParts(ids, { record, onProgress })
    : _repairSinglePart(ids[0], { record, onProgress }));
  let { holesFilled, nmFixed, applied } = await runOnce();

  const lead = AssetLoader.getBabylonMesh(meshId) ?? AssetLoader.getBabylonMesh(ids[0]);
  let remaining = lead ? await validateMesh(lead) : [];
  // One more pass when the first changed the geometry but left open /
  // non-manifold edges: on real scans the engine converges in two passes
  // (a cap from pass 1 gives pass 2 something to weld — measured 2026-09-18).
  const openLeft = (rs) => rs.some(r => r.type === 'holes' || r.type === 'nonManifold');
  if (applied.length && openLeft(remaining)) {
    const second = await runOnce();
    holesFilled += second.holesFilled; nmFixed += second.nmFixed;
    applied = [...applied, ...second.applied];
    remaining = lead ? await validateMesh(lead) : [];
  }
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
      // The engine's own progress for THIS object, scaled into its slice of
      // the batch, so a long single repair still moves the bar.
      const inner = (a, b) => {
        // The vendored engine's progress callback shape is not pinned by its
        // API: accept a 0..1 or 0..100 number in either argument, or an
        // object with a `progress` field; anything else counts as 0.
        let f = typeof a === 'number' ? a : typeof b === 'number' ? b : (typeof a?.progress === 'number' ? a.progress : 0);
        if (f > 1) f /= 100;
        onProgress?.((i + Math.max(0, Math.min(1, f))) / total, name);
      };
      const res = await repairObject(meshId, { onProgress: inner });
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
 * Re-apply persisted geometry fixes after a reload (M1 of the earlier wave).
 * The `.mixo` keeps raw source bytes + ratio, so the restored mesh comes back
 * with its original defects; replaying the recorded fix types reproduces the
 * repaired geometry. Must run AT the displayed scale (after the ratio bake) —
 * see applyGeometryFix.
 * @param {BABYLON.Mesh} mesh
 * @param {string[]} types
 * @returns {Promise<void>}
 */
export async function replayGeometryFixes(mesh, types) {
  if (!mesh?.geometry || !Array.isArray(types)) return;
  // 'groupRepair' is replayed ONCE per logical object by ProjectLoader after
  // every part is bound (the union needs all of them) — never per mesh here.
  for (const type of types) if (type !== 'groupRepair') await applyGeometryFix(mesh, type);
}
