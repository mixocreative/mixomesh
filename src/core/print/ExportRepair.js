// Making a mesh printable on the way OUT: the CSG re-bake and the watertight repair, both applied
// to the export CLONE and never to the scene.
//
// That last clause is the whole reason this is a module and not a step inside the pipeline. Repair
// rewrites geometry. Doing it to the user's own mesh would mean an export silently changing the
// thing they are still working on, with no undo entry and no way back. Every function here takes a
// clone, and the scene is never an argument.
//
// Cut out of PrintPipeline.js on 2026-11-14 (190 lines of a 1,031-line file). The boundary was
// already clean: the block needed nothing from the pipeline but `window.BABYLON`, and the pipeline
// needs five functions back. The verdict bookkeeping (`_reportEntryFor`, `_recordRepairVerdict`,
// `_refreshRepairVerdict`) and `_csgRebake` stay private here, which is the ratio that makes this
// a job rather than a line-count exercise.
//
// CSG2 is initialised lazily and module-scoped because Babylon's own init is: calling it twice is
// not free, and calling it at import time costs every run that never exports.

import { repairMesh, diagnoseMesh, ensureRepairEngine } from '../repair/MeshRepair.js';
import { repairGroup, diagnoseGroup } from '../repair/GroupRepair.js';
import { frontFaceIsClockwise } from './PrintSpace.js';
import { initCsg2 } from '../vendorUrl.js';

let _csgInitPromise = null;

export async function _ensureCSG2() {
  const B = window.BABYLON;
  if (!B || !B.CSG2 || typeof B.InitializeCSG2Async !== 'function') return false;
  try {
    if (!_csgInitPromise) _csgInitPromise = initCsg2(B);
    await _csgInitPromise;
    return true;
  } catch (err) {
    // Clear the cached rejection so a later export can retry (transient
    // WASM-fetch failures should not kill CSG for the page lifetime).
    _csgInitPromise = null;
    console.error('CSG2 init failed:', err);
    return false;
  }
}

/**
 * Round-trip through CSG2 (Manifold). Manifold output is watertight by
 * construction → single re-bake closes sub-tolerance gaps AND dissolves
 * internal faces (FEP-stuck islands).
 */
function _csgRebake(mesh) {
  const B = window.BABYLON;
  // CSG2 reads the index order raw (it knows no side orientation), so it gets
  // Babylon's native counter-clockwise order: a glTF clone (ClockWise flag,
  // e.g. a closed part the repair step left alone) is re-indexed first. Same
  // triangles and outward side, only the flag moves. Without it, a closed
  // glTF solid came back inside-out (trimesh volume -8000 on a 20 mm cube).
  if (frontFaceIsClockwise(mesh)) {
    const idx = mesh.getIndices() ?? [];
    const swapped = new Uint32Array(idx.length);
    for (let i = 0; i + 2 < idx.length; i += 3) { swapped[i] = idx[i]; swapped[i + 1] = idx[i + 2]; swapped[i + 2] = idx[i + 1]; }
    mesh.setIndices(swapped);
    mesh.sideOrientation = 1;   // BABYLON.Material.CounterClockWiseSideOrientation
  }
  const csg = B.CSG2.FromMesh(mesh);
  // toVertexData, not toMesh: CSG2.toMesh re-centres the result on the origin
  // (centerMesh defaults to true), which moved every re-baked part off its
  // world position (a 20 mm cube resting on the bed came out at z -10..10,
  // and its supports no longer met it; P4.2).
  const vd = csg.toVertexData();
  // Manifold accepts closed solids only; handed an open surface (an open
  // sheet repair kept as-is, P4.4) it can come back EMPTY, which would ship a
  // part with no facets. Leave the clone as it was (named in csgSkipped).
  if (vd.indices != null && vd.indices.length === 0 && (mesh.getIndices()?.length ?? 0) > 0) {
    csg.dispose?.();
    throw new Error('CSG returned no geometry (the part is not a closed solid)');
  }
  vd.applyToMesh(mesh);
  // CSG2.toMesh emits geometry in Babylon's NATIVE winding (CounterClockWise
  // front). A glTF-imported clone still carries the loader's ClockWise flag,
  // which would make PrintSpace.printIndices reverse the fresh winding and
  // ship the part inside-out (found 2026-09-17 on the STL path via trimesh).
  mesh.sideOrientation = 1;   // BABYLON.Material.CounterClockWiseSideOrientation
  csg.dispose?.();
}

export async function _tryCsg(mesh, ctx) {
  if (!ctx.csgReady) return;
  try { _csgRebake(mesh); }
  catch (err) {
    // CIA F3: never a silent catch on the export path — name the mesh, same
    // posture as _tryRepair below.
    console.error(`CSG re-bake skipped for ${mesh.name}:`, err);
    ctx.csgSkipped.push(mesh.name);
    return;
  }
  await _refreshRepairVerdict(mesh, ctx);
}

// Which repairReport entry belongs to which CLONE. Keyed on the mesh object,
// never on `mesh.name`: Babylon names collide freely across imports (see
// MeshValidator's own note), so two export clones can share a name — and a
// name-keyed lookup could then move one clone's verdict onto another's entry.
// For the strict gate that would be a FAIL-OPEN (a genuinely open part
// inheriting a watertight verdict), which is exactly what must not happen.
const _reportEntryFor = new WeakMap();

function _recordRepairVerdict(mesh, ctx, entry) {
  ctx.repairReport.push(entry);
  _reportEntryFor.set(mesh, entry);
}

/**
 * Re-diagnose a clone whose geometry was REPLACED after the repair step ran
 * (CIA F10). CSG2 rebuilds the mesh wholesale from Manifold output, so the
 * strict-export gate and the post-export warning toast would otherwise
 * describe pre-CSG geometry that is not what got written to the file.
 * A verdict of `null` (diagnose itself failed) stays "unknown" — warned
 * about, never a strict-mode blocker, exactly like _tryRepair's error path.
 */
async function _refreshRepairVerdict(mesh, ctx) {
  if (!ctx.repairReady) return;
  let verdict = null;
  try { verdict = (await diagnoseMesh(mesh)).isWatertight; }
  catch (err) { console.error(`Post-CSG diagnose failed for ${mesh.name}:`, err); }
  const entry = _reportEntryFor.get(mesh);
  if (entry) { entry.isWatertight = verdict; entry.afterCsg = true; }
  else _recordRepairVerdict(mesh, ctx, { name: mesh.name, isWatertight: verdict, afterCsg: true });
  // repairSkipped is a NAME list (it feeds a user-facing toast), so this
  // adds/removes exactly ONE occurrence — the right count even when two
  // clones share a name.
  const at = ctx.repairSkipped.indexOf(mesh.name);
  if (verdict === true) { if (at >= 0) ctx.repairSkipped.splice(at, 1); }
  else if (at < 0) ctx.repairSkipped.push(mesh.name);
}


/**
 * Pre-flight repair-engine load, mirroring _ensureCSG2. Runs once per
 * `_runExport` batch (not per target, not per mesh) so a slow/failed vendor
 * script load produces ONE toast, not one per part. `options.repair === false`
 * is a hard caller opt-out — never even attempts the load.
 */
export async function _ensureRepairRuntime(options) {
  if (options.repair === false) return false;
  try { await ensureRepairEngine(); return true; }
  catch (err) { console.error('Repair engine init failed:', err); return false; }
}

/**
 * Attempt watertight repair on one export CLONE. Never throws — a
 * still-not-watertight result (confirmed by the engine, or unknown because
 * the engine failed mid-attempt) is recorded on ctx for the strict-mode gate
 * and the post-export warning toast; the pre-existing weld/CSG prep steps
 * must keep running regardless.
 *
 * A batch-wide unavailable engine (ctx.repairReady false — see
 * _ensureRepairRuntime) is NOT recorded here: that already produced its own
 * one-time toast.repairUnavailable, and re-listing every clone in
 * repairSkipped would double up that message with a second, redundant toast.
 */
export async function _tryRepair(mesh, ctx) {
  if (!ctx.repairReady) return;
  try {
    // C1: diagnose FIRST and leave a healthy clone completely alone.
    // MeshFixLib's stage 1 merges duplicate positions — which is exactly what
    // a UV seam is made of — so running it on a hole-free part rewrote the
    // geometry for no gain and could only cost texture fidelity. A part with
    // real defects is still repaired, and MeshRepair.arraysToMesh now carries
    // seam UVs through that repair.
    const d = await diagnoseMesh(mesh);
    if (d.boundaryEdges === 0 && d.nonManifoldEdges === 0 && d.isWatertight) {
      _recordRepairVerdict(mesh, ctx, { name: mesh.name, isWatertight: true, skipped: true });
      return;
    }
    const r = await repairMesh(mesh);
    _recordRepairVerdict(mesh, ctx, { name: mesh.name, isWatertight: r.isWatertight });
    if (!r.isWatertight) ctx.repairSkipped.push(mesh.name);
  } catch (err) {
    // Engine failure mid-batch (e.g. the triangle cap) or any other repair
    // failure: unknown watertight status (null), never a strict-mode
    // blocker on its own — only a CONFIRMED not-watertight result is.
    console.error(`Repair skipped for ${mesh.name}:`, err);
    _recordRepairVerdict(mesh, ctx, { name: mesh.name, isWatertight: null, error: err?.message ?? String(err) });
    ctx.repairSkipped.push(mesh.name);
  }
}

/**
 * Repair the CLONES of one multi-part unit as ONE solid (GroupRepair on the
 * welded union) and record a verdict per clone. Per-clone repair capped
 * every material seam of a split object — the exported file grew an
 * internal wall along each seam (2026-09-18). Clones are already flattened
 * to one space by the time this runs, so no matrices are involved. Same
 * never-throws posture as _tryRepair.
 */
export async function _tryRepairGroup(clones, ctx, name) {
  if (!ctx.repairReady) return;
  const parts = clones.map(mesh => ({ mesh }));
  try {
    const d = await diagnoseGroup(parts);
    if (d.boundaryEdges === 0 && d.nonManifoldEdges === 0 && d.isWatertight) {
      for (const mesh of clones) _recordRepairVerdict(mesh, ctx, { name: mesh.name, isWatertight: true, skipped: true });
      return;
    }
    const r = await repairGroup(parts, { name });
    for (const mesh of clones) _recordRepairVerdict(mesh, ctx, { name: mesh.name, isWatertight: r.isWatertight });
    if (!r.isWatertight) ctx.repairSkipped.push(name);
  } catch (err) {
    console.error(`Repair skipped for ${name}:`, err);
    for (const mesh of clones) _recordRepairVerdict(mesh, ctx, { name: mesh.name, isWatertight: null, error: err?.message ?? String(err) });
    ctx.repairSkipped.push(name);
  }
}

/**
 * The watertight verdict recorded for an export clone, for the readiness report.
 *
 * An accessor rather than the map: the pipeline only ever asks this one question, and a module
 * that hands out its own WeakMap has invited a second writer to its bookkeeping.
 *
 * @returns {true|false|null|undefined} true/false as measured, null when repair could not say,
 *   undefined when this mesh was never looked at
 */
export function repairVerdictOf(mesh) {
  return _reportEntryFor.get(mesh)?.isWatertight;
}
