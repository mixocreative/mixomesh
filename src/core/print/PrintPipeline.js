/**
 * Export orchestrator.
 *
 * One pipeline runs every format:
 *   collect → init CSG → build context per target → clone + prep + validate
 *   → format-specific serialise → package + download.
 *
 * Format-shaped code lives outside this file (OBJ → ObjWriter, 3MF →
 * ThreeMFWriter, STL inline). The pipeline only drives prep steps and
 * dispatches to the serializer for each format.
 *
 * No mutable module globals — every per-export value lives in the
 * ExportContext, built fresh per target.
 */

import { getState } from '../StateManager.js';
import { Toast } from '../../ui/Toast.js';
import { t } from '../../i18n/index.js';
import { MeshValidator } from '../MeshValidator.js';
import { repairMesh, diagnoseMesh, ensureRepairEngine } from '../repair/MeshRepair.js';
import { repairGroup, diagnoseGroup } from '../repair/GroupRepair.js';
import { settleImportBounce } from '../scene/ImportBounce.js';
import { weldMesh, WELD_DISTANCE } from '../repair/Weld.js';
import { exportRatiosFromState } from '../scale/ScaleMath.js';
import { buildExportContext, collectPrintUnits } from './ExportContext.js';
import { exportBaseName, perMeshBaseName } from './PrintNaming.js';
import { createPrepSteps } from './PrintPrep.js';
import { createFormats } from './PrintFormats.js';
import { packageAndDownload } from './PrintPackaging.js';
import { buildColorGroupEntries, buildMaterialsExtEntries } from './ThreeMFWriter.js';
import { serializeOBJ } from './ObjWriter.js';
import { serializeSTL } from './StlWriter.js';
import { buildReadiness, boundsForExportContext } from './PrintReadiness.js';
import { logicalObjectPartIds, shouldDisplayObject } from '../LogicalObjects.js';
import { vendorUrl, MANIFOLD_VENDOR_DIR } from '../vendorUrl.js';

const BABYLON = window.BABYLON;
if (!BABYLON) throw new Error('Babylon.js failed to load');

// ── CSG2 init (lazy, module-scoped because the underlying Babylon init is too) ──

let _csgInitPromise = null;

async function _ensureCSG2() {
  const B = window.BABYLON;
  if (!B || !B.CSG2 || typeof B.InitializeCSG2Async !== 'function') return false;
  try {
    if (!_csgInitPromise) _csgInitPromise = B.InitializeCSG2Async({ manifoldUrl: vendorUrl(MANIFOLD_VENDOR_DIR) });
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
  const csg = B.CSG2.FromMesh(mesh);
  const baked = csg.toMesh(`${mesh.name}__csg`, mesh.getScene());
  const vd = B.VertexData.ExtractFromMesh(baked);
  vd.applyToMesh(mesh);
  // CSG2.toMesh emits geometry in Babylon's NATIVE winding (CounterClockWise
  // front). A glTF-imported clone still carries the loader's ClockWise flag,
  // which would make PrintSpace.printIndices reverse the fresh winding and
  // ship the part inside-out (found 2026-09-17 on the STL path via trimesh).
  mesh.sideOrientation = 1;   // BABYLON.Material.CounterClockWiseSideOrientation
  baked.dispose();
  csg.dispose?.();
}

async function _tryCsg(mesh, ctx) {
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

// ── repair (watertight fix on the export CLONE) ──────────

/**
 * Pre-flight repair-engine load, mirroring _ensureCSG2. Runs once per
 * `_runExport` batch (not per target, not per mesh) so a slow/failed vendor
 * script load produces ONE toast, not one per part. `options.repair === false`
 * is a hard caller opt-out — never even attempts the load.
 */
async function _ensureRepairRuntime(options) {
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
async function _tryRepair(mesh, ctx) {
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
async function _tryRepairGroup(clones, ctx, name) {
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

// ── weld helpers ─────────────────────────────────────────

// I6: the weld itself lives in src/core/repair/Weld.js and is shared with
// MeshValidator's offline 'nonManifold' fix. It merges only vertices that
// share BOTH position and UV, so the unconditional `weld` prep step on the
// OBJ/STL paths cannot tear a textured part's seams (review C1).
function _weld(mesh) {
  try {
    weldMesh(mesh, WELD_DISTANCE);
  } catch (err) {
    console.error(`Vertex weld skipped for ${mesh.name}:`, err);
  }
}

function _isSolidColor(mesh) {
  const m = mesh.material;
  if (!m) return true;
  return !(m.diffuseTexture || m.albedoTexture || m.baseTexture);
}

function _hasTextured3MFContent(meshList) {
  return meshList.some(({ mesh }) => {
    const mat = mesh.material;
    const tex = mat?.diffuseTexture || mat?.albedoTexture || mat?.baseTexture;
    if (!tex) return false;
    const uvs = mesh.getVerticesData?.(BABYLON.VertexBuffer.UVKind);
    return !!uvs && uvs.length > 0;
  });
}

// ── prep + format registries ─────────────────────────────

const PREP_STEPS = createPrepSteps({
  BABYLON,
  weld: _weld,
  isSolidColor: _isSolidColor,
  tryCsg: _tryCsg,
  tryRepair: _tryRepair,
});

const FORMATS = createFormats({
  serializeOBJ,
  serializeSTL,
  serialize3MF: _serialize3MF,
});

// ── validation gate ──────────────────────────────────────

function _exportError(message, validationErrors) {
  return Object.assign(new Error(message), { validationErrors });
}

async function _validateExportMeshes(list, onStep) {
  const errors = [];
  for (let i = 0; i < list.length; i++) {
    const { mesh, name } = list[i];
    let results;
    try { results = await MeshValidator.validateMesh(mesh); }
    catch (err) {
      // A validator throw must not silently pass — broken validation should
      // block export, not let unknown geometry through the gate. Record as a
      // hard error so the user sees the underlying message.
      console.error(`Validation failed for ${name}:`, err);
      errors.push({ meshName: name, message: `Validator crashed: ${err?.message ?? String(err)}` });
      onStep?.(i + 1, list.length);
      continue;
    }
    for (const r of results || []) {
      if (r.severity === 'error') errors.push({ meshName: name, message: r.message });
    }
    onStep?.(i + 1, list.length);
  }
  return errors;
}

// ── unit grouping helpers ────────────────────────────────

function _flattenPrintUnits(units) {
  return units.flatMap(unit => unit.parts.map(part => ({
    ...part, logicalId: unit.logicalId, logicalName: unit.name,
  })));
}

function _groupCloneEntries(entries) {
  const byId = new Map();
  for (const entry of entries) {
    const id = entry.logicalId ?? entry.meshId;
    if (!byId.has(id)) {
      byId.set(id, { logicalId: id, name: entry.logicalName ?? entry.name, meshes: [] });
    }
    byId.get(id).meshes.push(entry);
  }
  return [...byId.values()];
}

// ── orchestration ────────────────────────────────────────

/**
 * @param {'obj'|'stl'|'3mf'} formatKey
 * @param {{selectedOnly?:boolean, individually?:boolean,
 *          onProgress?:(frac:number,msg:string)=>void}} options
 */
async function _runExport(formatKey, options = {}) {
  const fmt = FORMATS[formatKey];
  if (!fmt) throw new Error(`Unknown export format: ${formatKey}`);
  const progress = typeof options.onProgress === 'function' ? options.onProgress : () => {};
  const readiness = getPrintReadiness(options);
  if (!readiness.canExport) {
    const noParts = readiness.targets.length === 0;
    throw Object.assign(
      new Error(noParts ? 'No printable meshes to export.' : 'Print readiness errors must be resolved before export.'),
      { readinessIssues: readiness.issues },
    );
  }

  // CSG2 init runs ONCE for the whole batch (was once-per-target in the old
  // shape, producing N identical "unavailable" toasts on failure). Result
  // flows down to every target's ctx.
  let csgReady = false;
  if (fmt.needsCSG) {
    csgReady = await _ensureCSG2();
    if (!csgReady) Toast.show(t('toast.csgUnavailable'), 'warning', 4000);
  }

  // Repair runs on every format (unlike CSG, OBJ included). One pre-flight
  // engine load for the whole batch — a slow/failed vendor script load
  // produces ONE toast, not one per target/mesh.
  const repairReady = await _ensureRepairRuntime(options);
  if (options.repair !== false && !repairReady) Toast.show(t('toast.repairUnavailable'), 'warning', 4000);

  // One file per target ratio in print.exportRatios. Empty list = "as shown"
  // (target = referenceRatio → factor 1000). Targets are passed into
  // buildExportContext directly — no mutable global, no setExportTargetOverride.
  const state0 = getState();
  const explicit = exportRatiosFromState(state0);
  const targets = explicit.length ? explicit : [null];   // null ⇒ "as shown"
  for (let ti = 0; ti < targets.length; ti++) {
    const span = (frac, msg) => progress(
      (ti + Math.max(0, Math.min(1, frac))) / targets.length,
      targets.length > 1 ? `[${ti + 1}/${targets.length}] ${msg}` : msg,
    );
    // ONE state snapshot for the whole batch (M8): a rename / selection change
    // between two save pickers must not change the second file's reference.
    const written = await _runExportForTarget(fmt, targets[ti], options, csgReady, repairReady, span, state0);
    if (written === false) return;   // picker cancelled — stop the batch, don't re-prompt
  }
}

/** Current, format-independent readiness projection used by the panel and gate. */
export function getPrintReadiness(options = {}) {
  const state = getState();
  const selected = new Set(state.selection?.selectedIds ?? []);
  const objects = state.scene?.objects ?? {};
  const units = collectPrintUnits(state, !!options.selectedOnly);
  const unitsById = new Map(units.map(unit => [unit.logicalId, unit]));
  const leads = Object.values(objects).filter(obj => obj?.isPrintPart
    && shouldDisplayObject(obj)
    && (!options.selectedOnly || selected.has(obj.id)));
  const parts = leads.map(obj => {
    const objectIds = logicalObjectPartIds(obj.id, objects);
    const ids = objectIds.length ? objectIds : [obj.id];
    const asset = state.scene.assetLibrary?.[obj.assetId];
    const validationResults = ids.flatMap(id => {
      const cached = state.scene.validation?.[id];
      return cached && !cached.stale ? (cached.results ?? []) : [];
    });
    // M3: a missing or stale cache is NOT "no warnings" — it is "not checked
    // yet". Reported as its own readiness issue so the panel never reads
    // "ready" for geometry nobody has validated since the last edit.
    const validationPending = ids.some(id => {
      const cached = state.scene.validation?.[id];
      return !cached || cached.stale;
    });
    const textureAvailable = ids.every(id => {
      const shader = state.scene.shaders?.[objects[id]?.shaderId];
      const textureId = shader?.diffuseTextureAssetId;
      return !textureId || !!state.scene.assetLibrary?.[textureId];
    });
    return {
      objectId: obj.id,
      objectIds: ids,
      sourceAvailable: !obj.isGhost && unitsById.has(obj.id),
      unitConfirmed: asset?.unitConfirmed !== false,
      textureAvailable,
      validationResults,
      validationPending,
    };
  });
  const explicit = exportRatiosFromState(state);
  const ratios = explicit.length ? explicit : [null];
  const targets = units.length ? ratios.map(target => {
    const ctx = buildExportContext({ state, units, target, options });
    return {
      ratio: ctx.targetRatio,
      requestedRatio: target,
      bounds: boundsForExportContext(ctx),
      objectIds: units.map(unit => unit.logicalId),
    };
  }).filter(target => target.bounds) : [];
  return buildReadiness({ parts, targets, bedDimensions: state.print.bedDimensions });
}

async function _runExportForTarget(fmt, target, options, csgReady, repairReady, progress, state = getState()) {
  progress(0.02, 'Collecting meshes…');
  settleImportBounce();   // flattenWorld bakes world matrices — never a mid-pop scale
  const units = collectPrintUnits(state, !!options.selectedOnly);
  if (!units.length) throw new Error('No printable meshes to export.');
  const printMeshes = _flattenPrintUnits(units);

  // ctx.options carries the caller's per-call request; ctx.prefs carries the
  // snapshotted state.print.* values (set inside buildExportContext). The
  // two stay separate so callers can't accidentally override a pref by
  // spreading their own options bag.
  const ctx = buildExportContext({ state, units, target, csgReady, repairReady, options });

  const clones = [];
  const dispose = () => { for (const e of clones) { try { e.mesh.dispose?.(); } catch { /* */ } } };

  try {
    const N = printMeshes.length;
    // The `repair` step is UNIT-scoped: a multi-part unit is repaired once on
    // the welded union of its clones (_tryRepairGroup), so the per-clone
    // prep is split around it — everything before `repair` per clone, then
    // the repair per unit, then everything after per clone.
    const repairAt = fmt.prep.indexOf('repair');
    const preSteps = repairAt < 0 ? fmt.prep : fmt.prep.slice(0, repairAt);
    const postSteps = repairAt < 0 ? [] : fmt.prep.slice(repairAt + 1);
    const runSteps = async (clone, steps) => {
      for (const stepKey of steps) {
        const step = PREP_STEPS[stepKey];
        if (!step) continue;
        try { await step(clone, ctx); }
        catch (e) {
          // NEVER swallow a prep failure. A flattenWorld that threw mid-way
          // leaves the clone at raw BU scale (1000× too small) and the old
          // console.error path shipped it with a success toast (audit
          // 2026-09-17 H1). The surrounding finally{} disposes the clone.
          if (e?.message?.startsWith('PrintPrep.')) throw e;
          throw Object.assign(
            new Error(`Export prep "${stepKey}" failed for "${clone.name}": ${e?.message ?? e}`),
            { cause: e, prepStep: stepKey },
          );
        }
      }
    };
    for (let i = 0; i < N; i++) {
      const { mesh, meshId, logicalId, logicalName } = printMeshes[i];
      // Keep the parent so the clone's world matrix includes group/ancestor
      // transforms; flattenWorld then bakes that full world (+ ratio +
      // mm-scale) into vertices.
      const clone = mesh.clone?.(`${mesh.name}__export`, mesh.parent ?? null, true);
      if (!clone || clone === mesh) {
        // Never fall back to the live mesh: prep bakes mm-scale into vertices
        // and the finally-block disposes clones.
        throw new Error(`Could not clone "${mesh.name}" for export.`);
      }
      // CRITICAL: Babylon's clone shares geometry by reference. Without a
      // unique copy here, prep would corrupt the live scene mesh.
      clone.makeGeometryUnique?.();
      // The side-orientation flag decides export winding (PrintSpace.printIndices).
      // glTF imports carry ClockWise on the MESH (material.sideOrientation is
      // null), so copy it explicitly rather than trusting clone() to.
      if (mesh.sideOrientation != null) clone.sideOrientation = mesh.sideOrientation;
      // Track the clone IMMEDIATELY so the finally{} dispose loop catches it
      // even if a prep step throws (re-thrown PrintPrep.* contract violations
      // would otherwise leak the freshly-cloned Babylon mesh and its GPU
      // buffers, since the old push-after-prep order skipped failed clones).
      clones.push({
        meshId, logicalId, mesh: clone,
        name: mesh.name || `mesh_${meshId}`,
        logicalName: logicalName || mesh.name || `mesh_${meshId}`,
      });
      await runSteps(clone, preSteps);
      progress(0.05 + 0.25 * ((i + 1) / N), `Preparing ${i + 1}/${N}…`);
    }
    const multiPart = new Set();   // clone meshes that belong to a >1-part unit
    if (repairAt >= 0) {
      const byUnit = _groupCloneEntries(clones);
      for (let u = 0; u < byUnit.length; u++) {
        const unit = byUnit[u];
        if (unit.meshes.length > 1) {
          for (const e of unit.meshes) multiPart.add(e.mesh);
          await _tryRepairGroup(unit.meshes.map(e => e.mesh), ctx, unit.name);
        } else {
          await PREP_STEPS.repair(unit.meshes[0].mesh, ctx);
        }
        progress(0.30 + 0.10 * ((u + 1) / byUnit.length), `Repairing ${u + 1}/${byUnit.length}…`);
      }
    }
    // A part of a multi-part unit is an OPEN patch by design (its seams are
    // interior edges of the union), so the per-clone CSG re-bake cannot run
    // on it — Manifold rejects a non-manifold input and every part would
    // land in csgSkipped with a spurious "not watertight" toast (review
    // finding 2026-09-18). The union was already repaired as one solid.
    const CSG_STEPS = new Set(['csg', 'csgSolidOnly']);
    for (let i = 0; i < N; i++) {
      const { mesh, meshId, logicalName } = printMeshes[i];
      const clone = clones[i].mesh;
      await runSteps(clone, multiPart.has(clone) ? postSteps.filter(k => !CSG_STEPS.has(k)) : postSteps);
      // M4: a part that lost all its triangles in prep (e.g. an empty CSG
      // result) must not silently vanish from the file — every writer used
      // to skip it and the build could even end up empty.
      const triCount = clone.getIndices?.()?.length ?? 0;
      if (!(triCount > 0)) {
        throw new Error(`Part "${logicalName || mesh.name || meshId}" has no triangles after preparation — export aborted`);
      }
      progress(0.40 + 0.10 * ((i + 1) / N), `Finishing ${i + 1}/${N}…`);
    }
    ctx.meshes.push(...clones);
    ctx.cloneGroups.push(..._groupCloneEntries(clones));

    // Fail closed: strictExport blocks on a CONFIRMED not-watertight clone
    // (repair ran and reported isWatertight:false) — never on "unknown"
    // (engine unavailable / capped), which is a repair-engine problem, not
    // a geometry one, and is already surfaced by toast.repairUnavailable.
    if (state.print?.strictExport) {
      const notWatertight = ctx.repairReport.filter(r => r.isWatertight === false).map(r => r.name);
      if (notWatertight.length) {
        throw _exportError(
          `Parts are not watertight: ${notWatertight.join(', ')}`,
          notWatertight.map(name => ({ meshName: name, message: 'Not watertight after repair' })),
        );
      }
    }

    const remaining = await _validateExportMeshes(
      clones, (d, tot) => progress(0.5 + 0.3 * (d / tot), `Validating ${d}/${tot}…`));
    if (remaining.length) throw _exportError('Validation errors remain after auto-fix.', remaining);

    progress(0.82, `Writing ${fmt.label}…`);
    const out = await fmt.serialize(ctx);

    const written = await packageAndDownload(out, fmt.label, progress);
    if (!written) {
      // User cancelled the save picker: say so, never "✓ Exported" (H6).
      progress(1, 'Cancelled');
      Toast.show(t('toast.exportCancelled', { filename: out.filename ?? fmt.label }), 'info', 3000);
      return false;
    }
    progress(1, 'Done');
    Toast.show(t('toast.exportedOk', { filename: out.filename ?? fmt.label }), 'success', 3000);
    if (ctx.csgSkipped.length) {
      Toast.show(t('toast.partsNotWatertight', { n: ctx.csgSkipped.length }), 'info', 5000);
    }
    // A repair attempt that couldn't confirm watertight (confirmed open, or
    // errored mid-attempt): one warning toast naming the part(s). Strict
    // mode would already have thrown above on a CONFIRMED failure, so this
    // only fires for strictExport:false or an "unknown" (e.g. capped) result.
    // This is the SOLE owner of toast.exportedWithWarnings for the pipeline —
    // PrintPanel's "Export anyway" path relies on this same toast rather than
    // firing its own (a caller-side duplicate was fix-round-1 finding #2).
    if (ctx.repairSkipped.length) {
      Toast.show(
        t('toast.exportedWithWarnings', { names: ctx.repairSkipped.join(', ') }),
        'warning', 5000,
      );
    }
    return true;
  } catch (err) {
    if (!err.validationErrors) console.error(`${fmt.label} export failed:`, err);
    throw err;
  } finally {
    dispose();
  }
}

// ── per-format serializers (3MF inline; OBJ in ObjWriter, STL in StlWriter) ──

/**
 * 3MF dispatch — content-driven. The Export panel chooses 3MF; texture
 * presence chooses the sub-pipeline:
 *
 *   3mf-materials-ext → Mimaki UV-inkjet: per-vertex UVs + embedded PNG
 *                       textures via the Materials Extension. Continuous-
 *                       tone colour preserved.
 *   3mf-colorgroup    → Filament multi-colour (Bambu/Prusa/Orca): solid
 *                       diffuse colour per object via <m:colorgroup>.
 *
 * Solid-only scenes emit lean colorgroup packages. Printer profile selection
 * is build-area only and must NOT switch 3MF flavour.
 */
async function _serialize3MF(ctx) {
  if (_hasTextured3MFContent(ctx.meshes)) return _serialize3MFMaterialsExt(ctx);
  return _serialize3MFColorGroup(ctx);
}

/**
 * Per-mesh 3MF wrapper: builds N standalone .3mf zips and bundles them
 * inside an outer .zip so the user gets one file per part on disk.
 */
async function _wrapIndividual3MF(ctx, entriesForUnit) {
  const { default: JSZip } = await import('jszip');
  const entries = [];
  for (const unit of ctx.cloneGroups) {
    const inner = await entriesForUnit([unit]);
    const innerZip = new JSZip();
    for (const x of inner) innerZip.file(x.path, x.data);
    const data = await innerZip.generateAsync({ type: 'uint8array', mimeType: 'model/3mf' });
    entries.push({ path: `${perMeshBaseName(ctx, unit.name)}.3mf`, data });
  }
  return { kind: 'zip', mime: 'application/zip', filename: `${exportBaseName(ctx)}.zip`, entries };
}

async function _serialize3MFColorGroup(ctx) {
  if (ctx.individually) {
    return _wrapIndividual3MF(ctx, list => buildColorGroupEntries(list));
  }
  return {
    kind: 'zip', mime: 'model/3mf', filename: `${exportBaseName(ctx)}.3mf`,
    entries: buildColorGroupEntries(ctx.cloneGroups, { state: ctx.state }),
  };
}

async function _serialize3MFMaterialsExt(ctx) {
  if (ctx.individually) {
    return _wrapIndividual3MF(ctx, list => buildMaterialsExtEntries(list));
  }
  const entries = await buildMaterialsExtEntries(ctx.cloneGroups, { state: ctx.state });
  return { kind: 'zip', mime: 'model/3mf', filename: `${exportBaseName(ctx)}.3mf`, entries };
}

// ── public export entry points ───────────────────────────

export const exportOBJ     = (options = {}) => _runExport('obj', options);
export const exportSTL     = (options = {}) => _runExport('stl', options);
export const exportThreeMF = (options = {}) => _runExport('3mf', options);
