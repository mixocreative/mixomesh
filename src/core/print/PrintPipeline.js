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
import { settleImportBounce } from '../scene/ImportBounce.js';
import { weldMesh, WELD_DISTANCE } from '../repair/Weld.js';
import { exportTargetsFromState, objectRatio } from '../scale/ScaleMath.js';
import { buildExportContext, collectPrintUnits, getExportReference, resolveExportUnits, hasBuiltSupports, resolveIncludeSupports } from './ExportContext.js';
import { bundleName, exportBaseName, perMeshBaseName } from './PrintNaming.js';
import { createPrepSteps } from './PrintPrep.js';
import {
  _ensureCSG2, _ensureRepairRuntime, _tryCsg, _tryRepair, _tryRepairGroup, repairVerdictOf,
} from './ExportRepair.js';
import { createFormats } from './PrintFormats.js';
import { packageAndDownload, buildExportBlob } from './PrintPackaging.js';
import { buildColorGroupEntries, buildMaterialsExtEntries } from './ThreeMFWriter.js';
import { getPrinterProfile } from './PrinterProfiles.js';
import { serializeOBJ } from './ObjWriter.js';
import { serializeSTL } from './StlWriter.js';
import { serializePLY } from './PlyWriter.js';
import { serializeWRL } from './WrlWriter.js';
import { buildReadiness, boundsForExportContext } from './PrintReadiness.js';
import { clampedUVsLeaveUnitSquare } from './UvTransform.js';
import { getTextureDimensions } from './ExportTextures.js';
import { logicalObjectPartIds, shouldDisplayObject } from '../LogicalObjects.js';
import { whileBusy } from '../BusyRegistry.js';

const BABYLON = window.BABYLON;
if (!BABYLON) throw new Error('Babylon.js failed to load');


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
  serializePLY,
  serializeWRL,
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
      byId.set(id, { logicalId: id, name: entry.logicalName ?? entry.name, meshes: [], supports: [] });
    }
    byId.get(id)[entry.isSupport ? 'supports' : 'meshes'].push(entry);
  }
  return [...byId.values()];
}

// ── orchestration ────────────────────────────────────────

/**
 * @param {'obj'|'stl'|'3mf'|'ply'|'wrl'} formatKey
 * @param {{selectedOnly?:boolean, individually?:boolean,
 *          acknowledgeWarnings?:boolean,
 *          onProgress?:(frac:number,msg:string)=>void}} options
 */
function _runExport(formatKey, options = {}) {
  return whileBusy('export', () => _exportBatch(formatKey, options));
}

async function _exportBatch(formatKey, options) {
  const fmt = FORMATS[formatKey];
  if (!fmt) throw new Error(`Unknown export format: ${formatKey}`);
  const progress = typeof options.onProgress === 'function' ? options.onProgress : () => {};
  const readiness = getPrintReadiness(options);
  if (!readiness.canExport) {
    const noParts = readiness.targets.length === 0
      && !readiness.issues.some(issue => issue.code === 'refinement-unavailable');
    throw Object.assign(
      new Error(noParts ? 'No printable meshes to export.' : 'Print readiness errors must be resolved before export.'),
      { readinessIssues: readiness.issues },
    );
  }
  // Decision 18 / task 1.8: warnings need an explicit acknowledgement, and it
  // is enforced HERE (not only by the panel) so no caller can write a file
  // from a warning state by omission. Info issues never require it. The UI
  // turns this rejection into the three-way modal (default Repair & export)
  // and re-calls with `acknowledgeWarnings: true`.
  if (readiness.requiresAcknowledgement && options.acknowledgeWarnings !== true) {
    throw Object.assign(
      new Error('Print readiness warnings need acknowledgement before export.'),
      { needsAcknowledgement: true, code: 'EXPORT_NEEDS_ACKNOWLEDGEMENT', readinessIssues: readiness.issues },
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

  // 3MF package thumbnail (task 1.5): ONE viewport capture per batch, taken
  // BEFORE any export clone exists so the preview is the scene as shown.
  // Never fails the export — no image ⇒ the package simply has no thumbnail.
  if (formatKey === '3mf') {
    options = { ...options, thumbnailPng: await _captureThumbnail(options) };
  }

  // Repair runs on every format (unlike CSG, OBJ included). One pre-flight
  // engine load for the whole batch — a slow/failed vendor script load
  // produces ONE toast, not one per target/mesh.
  const repairReady = await _ensureRepairRuntime(options);
  if (options.repair !== false && !repairReady) Toast.show(t('toast.repairUnavailable'), 'warning', 4000);

  // One file per typed print size in print.exportTargets (ratio / factor /
  // height, task 1.17). Empty list = "as shown" (factor 1 → displayed mm).
  // Targets are passed into buildExportContext directly — no mutable global,
  // no setExportTargetOverride.
  const state0 = getState();
  const explicit = exportTargetsFromState(state0);
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
  const representationIssues = resolveExportUnits(units, options.derivedMeshesFor).issues;
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
      ratio: objectRatio(obj),
      // 1.4 profile hints: distinct diffuse textures (what export ships) with
      // pixel size, the validator's thickness proxy, and an open-shell verdict.
      textures: _partTextures(ids, objects, state),
      clampedTextureOverflow: (unitsById.get(obj.id)?.parts ?? []).some(part => clampedUVsLeaveUnitSquare(part.mesh)),
      thicknessBU: _minThickness(ids, state),
      watertight: _watertightVerdict(ids, state),
    };
  });
  const explicit = exportTargetsFromState(state);
  const requested = explicit.length ? explicit : [null];
  const targets = units.length && !representationIssues.length ? requested.map(target => {
    let ctx;
    // A height target on a flat (zero-Z) reference has no factor — it throws
    // at export with a clear message; readiness just has no line for it.
    try { ctx = buildExportContext({ state, units, target, options, derivedMeshesFor: options.derivedMeshesFor }); } catch (err) {
      if (target?.kind === 'height') return { bounds: null };
      throw err;
    }
    return {
      ratio: ctx.targetRatio,
      requestedRatio: target?.kind === 'ratio' ? target.value : null,
      target,
      label: _targetLabel(target),
      bounds: boundsForExportContext(ctx),
      scaleToMM: ctx.ratioFactor * ctx.unitFactor,
      objectIds: units.map(unit => unit.logicalId),
    };
  }).filter(target => target.bounds) : [];
  const reference = units.length ? getExportReference(options) : null;
  const profile = getPrinterProfile(state.print?.targetPrinterId);
  return buildReadiness({
    parts, targets, bedDimensions: state.print.bedDimensions, reference,
    profile, strictExport: !!state.print?.strictExport, representationIssues,
    supports: units.length ? supportReadiness(units, options.includeSupports ?? state.print?.includeSupports) : null,
  });
}

/**
 * P4.2 support facts of an export: the effective `includeSupports`, the objects whose supports are
 * stale (they block an export that carries supports) and whether a supports-only export has none.
 * @param {Array} units  collectPrintUnits result
 * @param {string|null|undefined} requested
 */
export function supportReadiness(units, requested) {
  const built = units.filter(unit => hasBuiltSupports(unit.obj));
  const include = resolveIncludeSupports(requested, built.length > 0);
  return {
    include,
    stale: include === 'none' ? [] : built.filter(unit => unit.obj.supports.stale).map(unit => unit.logicalId),
    missing: include === 'supportsOnly' && built.length === 0,
  };
}

// Language-neutral label for non-ratio print sizes ("×2", "120 mm"); ratio
// targets and "as shown" are labelled by their ratio (null here).
function _targetLabel(target) {
  if (target?.kind === 'factor') return `×${target.value}`;
  if (target?.kind === 'height') return `${target.mm} mm`;
  return null;
}

function _partTextures(ids, objects, state) {
  const seen = new Map();
  for (const id of ids) {
    const assetId = state.scene.shaders?.[objects[id]?.shaderId]?.diffuseTextureAssetId;
    if (!assetId || seen.has(assetId)) continue;
    const dim = getTextureDimensions(assetId, state);
    seen.set(assetId, { assetId, width: dim?.width ?? 0, height: dim?.height ?? 0 });
  }
  return [...seen.values()];
}

function _minThickness(ids, state) {
  let min = null;
  for (const id of ids) {
    const c = state.scene.validation?.[id];
    if (c && !c.stale && c.thicknessBU > 0 && (min === null || c.thicknessBU < min)) min = c.thicknessBU;
  }
  return min;
}

// false = a fresh validation found holes / non-manifold edges; null = unknown.
function _watertightVerdict(ids, state) {
  let known = false;
  for (const id of ids) {
    const c = state.scene.validation?.[id];
    if (!c || c.stale) continue;
    known = true;
    if (c.results?.some(r => r.type === 'holes' || r.type === 'nonManifold')) return false;
  }
  return known ? true : null;
}

function _throwIfCancelled(signal) {
  if (signal?.aborted) throw new DOMException('Export cancelled', 'AbortError');
}

async function _runExportForTarget(fmt, target, options, csgReady, repairReady, progress, state = getState()) {
  progress(0.02, t('progress.collecting'));
  settleImportBounce();   // flattenWorld bakes world matrices — never a mid-pop scale
  const units = collectPrintUnits(state, !!options.selectedOnly);
  if (!units.length) throw new Error('No printable meshes to export.');

  // ctx.options carries the caller's per-call request; ctx.prefs carries the
  // snapshotted state.print.* values (set inside buildExportContext). The
  // two stay separate so callers can't accidentally override a pref by
  // spreading their own options bag.
  const ctx = buildExportContext({ state, units, target, csgReady, repairReady, options, derivedMeshesFor: options.derivedMeshesFor });
  // P4.2: a supports-only export clones no model part (the model still anchors pivot and ratio).
  const supportsOnly = ctx.includeSupports === 'supportsOnly';
  if (supportsOnly && !ctx.units.some(unit => hasBuiltSupports(unit.obj))) {
    throw Object.assign(new Error('No supports to export: build supports in Support Mode first.'), { code: 'EXPORT_NO_SUPPORTS' });
  }
  const printMeshes = supportsOnly ? [] : _flattenPrintUnits(ctx.units);

  const clones = [];
  const supportClones = [];
  const dispose = () => {
    for (const e of clones) { try { e.mesh.dispose?.(); } catch { /* */ } }
    // Support clones own their material (made for this export); model clones share the live one.
    for (const e of supportClones) { try { e.mesh.dispose?.(false, true); } catch { /* */ } }
  };

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
      clone.__geometryDetached = true;   // prep edits must not bump the live mesh's revision
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
      progress(0.05 + 0.25 * ((i + 1) / N), t('progress.preparing', { i: i + 1, n: N }));
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
        progress(0.30 + 0.10 * ((u + 1) / byUnit.length), t('progress.repairing', { i: u + 1, n: byUnit.length }));
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
      progress(0.40 + 0.10 * ((i + 1) / N), t('progress.finishing', { i: i + 1, n: N }));
    }
    if (ctx.includeSupports !== 'none') {
      progress(0.42, t('progress.supports'));
      await _addSupportClones(ctx, supportClones);
      if (supportsOnly && !supportClones.length) {
        throw Object.assign(new Error('No supports to export: every support was removed.'), { code: 'EXPORT_NO_SUPPORTS' });
      }
    }
    ctx.meshes.push(...clones, ...supportClones);
    ctx.cloneGroups.push(..._groupCloneEntries([...clones, ...supportClones]));

    // Fail closed (Decision 18): strictExport blocks on a CONFIRMED
    // not-watertight clone AND on any UNKNOWN verdict (engine unavailable,
    // capped, errored, repair opted out) — "could not verify" is not "fine".
    if (ctx.prefs?.strictExport ?? state.print?.strictExport) {
      const open = [], unknown = [];
      // MX-04: walk everything in the FILE and skip supports deliberately, so the scope is the
      // gate's own decision and not whichever list was in scope. Why supports are out: MEASURED
      // on support-plain-cube.glb through the real engine (2026-11-12), the support export build
      // is 25528 facets with 0 boundary edges, 5410 NON-MANIFOLD edges and 226 zero-area facets —
      // a closed, interpenetrating union of pillars and raft with positive signed volume. It
      // slices (tests/consumers.mjs asserts supports.outward, never supports.watertight) and it
      // can never be watertight, because nothing booleans the pillars into one manifold. Gating
      // on a watertight verdict here would refuse EVERY strict export that includes supports, so
      // the LABEL was narrowed instead (i18n print.strictExport + print.strictExportSupports).
      // Guard: tests/export-gate-supports-mx04.test.mjs and the census check in
      // tests/browser-supports-export-smoke.mjs, which re-measures the claim.
      for (const c of ctx.meshes) {
        if (c.isSupport) continue;
        const verdict = repairVerdictOf(c.mesh);
        if (verdict === false) open.push(c.name);
        else if (verdict !== true) unknown.push(c.name);
      }
      if (open.length) {
        throw _exportError(
          `Parts are not watertight: ${open.join(', ')}`,
          open.map(name => ({ meshName: name, message: 'Not watertight after repair' })),
        );
      }
      if (unknown.length) {
        throw _exportError(
          `Strict export: could not verify watertight: ${unknown.join(', ')}`,
          unknown.map(name => ({ meshName: name, message: 'Watertight status unknown (strict export blocks unverified parts)' })),
        );
      }
    }

    // MX-04: the validator is handed the WHOLE file, supports included, so a validator crash on
    // support geometry blocks the export instead of never being attempted. It still returns
    // nothing for them — D20 (supportLayerTag.js) makes support-layer meshes invisible to every
    // content walk, MeshValidator among them — which is the other half of why the strict label
    // says "model parts". Pinned by tests/export-gate-supports-mx04.test.mjs.
    const remaining = await _validateExportMeshes(
      ctx.meshes, (d, tot) => progress(0.5 + 0.3 * (d / tot), t('progress.validating', { i: d, n: tot })));
    if (remaining.length) throw _exportError('Validation errors remain after auto-fix.', remaining);

    progress(0.82, t('progress.writing', { format: fmt.label }));
    _throwIfCancelled(options.signal);
    const out = await fmt.serialize(ctx);
    // Cancel (export overlay) wins over a finished encode: nothing is saved.
    _throwIfCancelled(options.signal);

    // Collect mode (publish): same writers + ctx, but the bytes go to the
    // caller's sink instead of the save picker — no second writer.
    if (Array.isArray(options.sink)) {
      const blob = await buildExportBlob(out, progress);
      options.sink.push({
        name: out.filename, mime: out.mime || blob.type || 'application/octet-stream',
        bytes: new Uint8Array(await blob.arrayBuffer()),
      });
      progress(1, t('progress.done'));
      if (ctx.repairSkipped.length) {
        Toast.show(t('toast.exportedWithWarnings', { names: ctx.repairSkipped.join(', ') }), 'warning', 5000);
      }
      return true;
    }
    const written = await packageAndDownload(out, fmt.label, progress);
    if (!written) {
      // User cancelled the save picker: say so, never "✓ Exported" (H6).
      progress(1, t('progress.cancelled'));
      Toast.show(t('toast.exportCancelled', { filename: out.filename ?? fmt.label }), 'info', 3000);
      return false;
    }
    progress(1, t('progress.done'));
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
    // A user Cancel is not a failure (re-review minor 4).
    if (!err.validationErrors && err?.name !== 'AbortError') console.error(`${fmt.label} export failed:`, err);
    throw err;
  } finally {
    dispose();
  }
}

// ── supports (P4.2) ──────────────────────────────────────

/** Export colour of support structures (the drawn pillar colour). */
const SUPPORT_EXPORT_RGB = [0x8F / 255, 0xA3 / 255, 0xB8 / 255];

/**
 * One export clone per object with built supports: the export-mode build (never the drawn
 * preview) at this target's size, as a temporary Babylon mesh in world axes (support frame to
 * Babylon through frame.ts), then flattenPhysical (origin follows the ratio, vertices stay
 * mm-physical, BU to mm); from there the same PrintSpace seam as the model (axis, winding). A
 * separate shell: never welded, repaired, re-baked or validated with the model. Stale supports
 * throw EXPORT_SUPPORTS_STALE (buildSupportsForExport).
 */
async function _addSupportClones(ctx, out, build = null) {
  // `build` is a test seam only (see tests/supports-nothing-built.test.mjs); production always
  // takes the real builder. Injected because MX-08 is an asymmetry, not a reproduced input: the
  // audit could not construct a case where this returns null on the printable route.
  const buildSupportsForExport = build ?? (await import('../../supports/live/liveGeneration')).buildSupportsForExport;
  const { tagSupportLayer } = await import('../../supports/layers/supportLayerTag.js');
  for (const unit of ctx.units) {
    if (!hasBuiltSupports(unit.obj)) continue;
    const name = `${unit.name ?? unit.logicalId} supports`;
    const built = await buildSupportsForExport(unit.logicalId, ctx.ratioFactor);
    // MX-08: this was `if (!built) continue;`, three lines from `:670` where the SAME condition on
    // the supportsOnly route throws EXPORT_NO_SUPPORTS. A unit the viewport shows standing on
    // supports left the file without them, and the export still said "✓ Exported". Now it is named.
    // DEBT: toast.exportedWithWarnings reads "could not confirm watertight: {names}", which is
    // broader than true here — nothing about these supports was confirmed because they do not
    // exist. Reuse is the plan's own call (§5.4): one outcome channel, one toast, and the pipeline
    // stays the sole owner of that toast. Give this its own key the moment a second cause lands in
    // this list, or the moment the owner rewords it.
    if (!built) { ctx.repairSkipped.push(name); continue; }
    const scene = unit.parts[0]?.mesh?.getScene?.();
    const mesh = new BABYLON.Mesh(`${name}__export`, scene);
    out.push({ meshId: null, logicalId: unit.logicalId, mesh, name, logicalName: unit.name, isSupport: true });
    tagSupportLayer(mesh, 'export', unit.logicalId);   // D20: never content, never drawn
    mesh.setEnabled(false);
    const data = new BABYLON.VertexData();
    data.positions = built.positions;
    data.indices = built.indices;
    data.applyToMesh(mesh, false);
    // Engine triangles are outward counter-clockwise, drawn with Babylon's default front face.
    mesh.sideOrientation = 1;   // BABYLON.Material.CounterClockWiseSideOrientation
    mesh.position.set(built.origin[0], built.origin[1], built.origin[2]);
    const mat = new BABYLON.StandardMaterial('supports', scene);
    mat.diffuseColor = new BABYLON.Color3(...SUPPORT_EXPORT_RGB);
    mesh.material = mat;
    PREP_STEPS.flattenPhysical(mesh, ctx);
    PREP_STEPS.createNormals(mesh);
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
 * Solid-only scenes emit lean colorgroup packages. The printer profile never
 * switches the flavour (AGENTS rule 6); it only supplies package DEFAULTS
 * (split-by-material, metadata, colour alpha) via `_threeMFWriterOptions`.
 */
async function _serialize3MF(ctx) {
  if (_hasTextured3MFContent(ctx.meshes)) return _serialize3MFMaterialsExt(ctx);
  return _serialize3MFColorGroup(ctx);
}

const THUMBNAIL_PX = 256;
const THUMBNAIL_TIMEOUT_MS = 5000;

function _isPngData(data) {
  if (!data) return false;
  if (typeof Blob !== 'undefined' && data instanceof Blob) return data.size > 0;
  const u8 = data instanceof Uint8Array ? data
    : data instanceof ArrayBuffer ? new Uint8Array(data) : null;
  // PNG signature 89 50 4E 47.
  return !!u8 && u8.length > 8 && u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4E && u8[3] === 0x47;
}

/**
 * Viewport thumbnail for the 3MF package via the shared RTT capture path
 * (FrameCapture.capturePng — same as the recent-projects thumbnail, works on
 * WebGL and WebGPU). `options.captureThumbnail` injects the capture (tests);
 * `false` disables it. Headless / failed / slow capture → null, silently.
 * @returns {Promise<Blob|Uint8Array|null>}
 */
async function _captureThumbnail(options = {}) {
  if (options.captureThumbnail === false) return null;
  let timer = null;
  try {
    const capture = typeof options.captureThumbnail === 'function'
      ? options.captureThumbnail
      : async (opts) => (await import('../render/FrameCapture.js')).capturePng(opts);
    const timeout = new Promise(resolve => { timer = setTimeout(() => resolve(null), THUMBNAIL_TIMEOUT_MS); });
    const png = await Promise.race([
      Promise.resolve().then(() => capture({ width: THUMBNAIL_PX, height: THUMBNAIL_PX })),
      timeout,
    ]);
    return _isPngData(png) ? png : null;
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Resolve the 3MF writer options (task 1.5) from the ctx and the selected
 * printer profile. `ctx.prefs.splitByMaterial` (a boolean) wins; otherwise the
 * profile default, which is ON for `per-part` / `paint` colour modes.
 * @returns {import('./ThreeMFWriter.js').ThreeMFWriterOptions}
 */
function _threeMFWriterOptions(ctx, { withState = true } = {}) {
  const profile = getPrinterProfile(ctx.state?.print?.targetPrinterId || null);
  const pref = /** @type {any} */ (ctx.prefs)?.splitByMaterial;
  const splitByMaterial = typeof pref === 'boolean'
    ? pref
    : !!profile.export?.splitByMaterial || profile.colour?.mode === 'per-part' || profile.colour?.mode === 'paint';
  const metadata = profile.export?.threeMF?.metadata === false ? null : {
    title: ctx.projectName,
    application: 'MIXOMESH',
    creationDate: new Date().toISOString().slice(0, 10),
  };
  return {
    ...(withState ? { state: ctx.state } : {}),
    splitByMaterial,
    alpha: !!profile.colour?.alpha,
    metadata,
    thumbnailPng: ctx.options?.thumbnailPng ?? null,
    // Task 1.11: user/project flavour wins, else the printer profile's.
    flavour: /** @type {any} */ (ctx.prefs)?.threeMFFlavour ?? profile.export?.threeMF?.flavour ?? 'core',
    // Non-fatal writer warnings (Bambu slot overflow) → console, like the
    // other non-fatal export fallbacks in this pipeline.
    onWarning: (warning) => console.warn(warning.message),
  };
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
  return { kind: 'zip', mime: 'application/zip', filename: bundleName(ctx, '3mf'), entries };
}

async function _serialize3MFColorGroup(ctx) {
  if (ctx.individually) {
    // One file per unit: no group hierarchy (state omitted, as before).
    const opts = _threeMFWriterOptions(ctx, { withState: false });
    return _wrapIndividual3MF(ctx, list => buildColorGroupEntries(list, opts));
  }
  return {
    kind: 'zip', mime: 'model/3mf', filename: `${exportBaseName(ctx)}.3mf`,
    entries: buildColorGroupEntries(ctx.cloneGroups, _threeMFWriterOptions(ctx)),
  };
}

async function _serialize3MFMaterialsExt(ctx) {
  if (ctx.individually) {
    const opts = _threeMFWriterOptions(ctx, { withState: false });
    return _wrapIndividual3MF(ctx, list => buildMaterialsExtEntries(list, opts));
  }
  const entries = await buildMaterialsExtEntries(ctx.cloneGroups, _threeMFWriterOptions(ctx));
  return { kind: 'zip', mime: 'model/3mf', filename: `${exportBaseName(ctx)}.3mf`, entries };
}

// ── public export entry points ───────────────────────────

/**
 * Run the SAME export pipeline for several formats but return the files in
 * memory instead of saving them (Listbridge publish, PB.6). One entry per
 * format x print size. Honours the readiness gate exactly like a normal
 * export: when blocked (errors, or warnings not acknowledged) returns
 * `{ blocked: true, code, readinessIssues }` and produces nothing.
 * @param {Array<'obj'|'stl'|'3mf'|'ply'|'wrl'>} formatKeys
 * @param {object} [options]  same options as exportSTL etc. (acknowledgeWarnings, selectedOnly, …)
 * @returns {Promise<{blocked:false, files:Array<{name:string,mime:string,bytes:Uint8Array}>}
 *   | {blocked:true, code:string, readinessIssues:any[]}>}
 */
export async function collectExportFiles(formatKeys, options = {}) {
  const readiness = getPrintReadiness(options);
  if (!readiness.canExport) {
    const noParts = readiness.targets.length === 0
      && !readiness.issues.some(issue => issue.code === 'refinement-unavailable');
    return { blocked: true, code: noParts ? 'EXPORT_NOTHING' : 'EXPORT_BLOCKED', readinessIssues: readiness.issues };
  }
  if (readiness.requiresAcknowledgement && options.acknowledgeWarnings !== true) {
    return { blocked: true, code: 'EXPORT_NEEDS_ACKNOWLEDGEMENT', readinessIssues: readiness.issues };
  }
  const sink = [];
  // MX-05: the refusal that is left once bundleName() carries the format token. Downstream,
  // ApiServer and listbridge's validateListing both refuse a repeated name — the right posture,
  // but their message ("duplicate export file name") names the symptom and sends the reader
  // looking at the file system. Here, where the format each name came from is still known, it
  // can be named instead.
  const produced = [];
  for (const key of formatKeys) {
    const before = sink.length;
    await _runExport(key, { ...options, sink });
    for (const file of sink.slice(before)) produced.push([key, file.name]);
    const clash = nameCollision(produced);
    if (clash) throw new Error(clash);
  }
  return { blocked: false, files: sink };
}

/**
 * The first two formats of `produced` that want the same file, as the message saying so — or null.
 * Case-insensitive, because the file systems that matter are: Windows and macOS would silently
 * leave one file where two were asked for.
 * @param {Array<[string, string]>} produced  [formatKey, filename] in the order they were written
 * @returns {string|null}
 */
function nameCollision(produced) {
  const by = new Map();
  for (const [format, name] of produced) {
    const key = String(name).toLowerCase();
    const first = by.get(key);
    if (first && first !== format) {
      return `Export name collision: formats "${first}" and "${format}" both produce "${name}". `
        + 'A bundling writer is missing its format token (PrintNaming.bundleName).';
    }
    by.set(key, format);
  }
  return null;
}

export const exportOBJ     = (options = {}) => _runExport('obj', options);
export const exportSTL     = (options = {}) => _runExport('stl', options);
export const exportThreeMF = (options = {}) => _runExport('3mf', options);
export const exportPLY     = (options = {}) => _runExport('ply', options);
export const exportWRL     = (options = {}) => _runExport('wrl', options);

/**
 * Test seams: the function whose "nothing built" branch MX-08 is about, and the collision
 * detector MX-05 left behind (pure, so it is tested on fabricated pairs rather than by forcing
 * a writer to misbehave).
 */
export const __test = { addSupportClones: _addSupportClones, nameCollision };
