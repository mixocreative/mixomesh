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
import { exportRatiosFromState } from '../scale/ScaleMath.js';
import { buildExportContext, collectPrintUnits } from './ExportContext.js';
import { exportBaseName, perMeshBaseName } from './PrintNaming.js';
import { createPrepSteps } from './PrintPrep.js';
import { createFormats } from './PrintFormats.js';
import { packageAndDownload } from './PrintPackaging.js';
import { buildColorGroupEntries, buildMaterialsExtEntries } from './ThreeMFWriter.js';
import { serializeOBJ } from './ObjWriter.js';
import { buildReadiness, boundsForExportContext } from './PrintReadiness.js';
import { logicalObjectPartIds, shouldDisplayObject } from '../LogicalObjects.js';

const BABYLON = window.BABYLON;
if (!BABYLON) throw new Error('Babylon.js failed to load');

// ── CSG2 init (lazy, module-scoped because the underlying Babylon init is too) ──

let _csgInitPromise = null;

async function _ensureCSG2() {
  const B = window.BABYLON;
  if (!B || !B.CSG2 || typeof B.InitializeCSG2Async !== 'function') return false;
  try {
    if (!_csgInitPromise) _csgInitPromise = B.InitializeCSG2Async();
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
  baked.dispose();
  csg.dispose?.();
}

function _tryCsg(mesh, ctx) {
  if (!ctx.csgReady) return;
  try { _csgRebake(mesh); }
  catch { ctx.csgSkipped.push(mesh.name); }
}

// ── weld helpers ─────────────────────────────────────────

const WELD_DISTANCE = 1e-4;   // 0.1 mm at 1 BU = 1 m. Matches MeshValidator.

function _weld(mesh) {
  const B = window.BABYLON;
  try {
    if (typeof mesh.mergeVerticesByDistance === 'function') {
      mesh.mergeVerticesByDistance(WELD_DISTANCE);
    } else if (typeof B.VertexData?.MergeByDistance === 'function') {
      const vd = B.VertexData.ExtractFromMesh(mesh);
      B.VertexData.MergeByDistance(vd, WELD_DISTANCE);
      vd.applyToMesh(mesh);
    }
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
});

const FORMATS = createFormats({
  serializeOBJ,
  serializeSTL: _serializeSTL,
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
    await _runExportForTarget(fmt, targets[ti], options, csgReady, span);
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
    };
  });
  const explicit = exportRatiosFromState(state);
  const ratios = explicit.length ? explicit : [null];
  const targets = units.length ? ratios.map(target => {
    const ctx = buildExportContext({ state, units, target, options });
    return {
      ratio: ctx.targetRatio,
      requestedRatio: target,
      bounds: boundsForExportContext(ctx, state.print.bedDimensions),
      objectIds: units.map(unit => unit.logicalId),
    };
  }).filter(target => target.bounds) : [];
  return buildReadiness({ parts, targets, bedDimensions: state.print.bedDimensions });
}

async function _runExportForTarget(fmt, target, options, csgReady, progress) {
  progress(0.02, 'Collecting meshes…');
  const state = getState();
  const units = collectPrintUnits(state, !!options.selectedOnly);
  if (!units.length) throw new Error('No printable meshes to export.');
  const printMeshes = _flattenPrintUnits(units);

  // ctx.options carries the caller's per-call request; ctx.prefs carries the
  // snapshotted state.print.* values (set inside buildExportContext). The
  // two stay separate so callers can't accidentally override a pref by
  // spreading their own options bag.
  const ctx = buildExportContext({ state, units, target, csgReady, options });

  const clones = [];
  const dispose = () => { for (const e of clones) { try { e.mesh.dispose?.(); } catch { /* */ } } };

  try {
    const N = printMeshes.length;
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
      // Track the clone IMMEDIATELY so the finally{} dispose loop catches it
      // even if a prep step throws (re-thrown PrintPrep.* contract violations
      // would otherwise leak the freshly-cloned Babylon mesh and its GPU
      // buffers, since the old push-after-prep order skipped failed clones).
      clones.push({
        meshId, logicalId, mesh: clone,
        name: mesh.name || `mesh_${meshId}`,
        logicalName: logicalName || mesh.name || `mesh_${meshId}`,
      });
      for (const stepKey of fmt.prep) {
        const step = PREP_STEPS[stepKey];
        if (!step) continue;
        try { step(clone, ctx); }
        catch (e) {
          // Contract violations from the prep layer (PrintPrep throws when its
          // required ctx fields are missing) must NOT be swallowed — they
          // signal a hardened invariant break and the export must abort. The
          // surrounding finally{} disposes the clone (already pushed above).
          if (e?.message?.startsWith('PrintPrep.')) throw e;
          console.error(`Prep "${stepKey}" failed for ${clone.name}:`, e);
        }
      }
      progress(0.05 + 0.45 * ((i + 1) / N), `Preparing ${i + 1}/${N}…`);
    }
    ctx.meshes.push(...clones);
    ctx.cloneGroups.push(..._groupCloneEntries(clones));

    const remaining = await _validateExportMeshes(
      clones, (d, tot) => progress(0.5 + 0.3 * (d / tot), `Validating ${d}/${tot}…`));
    if (remaining.length) throw _exportError('Validation errors remain after auto-fix.', remaining);

    progress(0.82, `Writing ${fmt.label}…`);
    const out = await fmt.serialize(ctx);

    await packageAndDownload(out, fmt.label, progress);
    progress(1, 'Done');
    Toast.show(t('toast.exportedOk', { filename: out.filename ?? fmt.label }), 'success', 3000);
    if (ctx.csgSkipped.length) {
      Toast.show(t('toast.partsNotWatertight', { n: ctx.csgSkipped.length }), 'info', 5000);
    }
  } catch (err) {
    if (!err.validationErrors) console.error(`${fmt.label} export failed:`, err);
    throw err;
  } finally {
    dispose();
  }
}

// ── per-format serializers (STL + 3MF inline; OBJ in ObjWriter) ──

function _serializeSTL(ctx) {
  const meshes = ctx.meshes.map(e => e.mesh);
  if (ctx.individually) {
    const entries = [];
    for (const unit of ctx.cloneGroups) {
      const base = perMeshBaseName(ctx, unit.name);
      const data = BABYLON.STLExport.CreateSTL(unit.meshes.map(e => e.mesh), false, base, true, false, false, false);
      entries.push({ path: `${base}.stl`, data });
    }
    return { kind: 'zip', mime: 'application/zip', filename: `${exportBaseName(ctx)}.zip`, entries };
  }
  // Combined STL: ask the exporter for raw bytes (download=false), route
  // through packageAndDownload like every other format so the user sees the
  // same Save-As dialog with the project+ratio default name.
  const base = exportBaseName(ctx);
  const data = BABYLON.STLExport.CreateSTL(meshes, false, base, true, false, false, false);
  return { kind: 'blob', mime: 'model/stl', filename: `${base}.stl`, data };
}

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
    entries: buildColorGroupEntries(ctx.cloneGroups),
  };
}

async function _serialize3MFMaterialsExt(ctx) {
  if (ctx.individually) {
    return _wrapIndividual3MF(ctx, list => buildMaterialsExtEntries(list));
  }
  const entries = await buildMaterialsExtEntries(ctx.cloneGroups);
  return { kind: 'zip', mime: 'model/3mf', filename: `${exportBaseName(ctx)}.3mf`, entries };
}

// ── public export entry points ───────────────────────────

export const exportOBJ     = (options = {}) => _runExport('obj', options);
export const exportSTL     = (options = {}) => _runExport('stl', options);
export const exportThreeMF = (options = {}) => _runExport('3mf', options);
