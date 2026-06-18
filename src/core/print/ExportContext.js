/**
 * ExportContext — the ONE object that drives every export concern.
 *
 * Built once per export target (and once per Scale-panel preview). Every
 * downstream consumer reads from the same fields: PrintPipeline, PrintPrep,
 * PrintNaming, ObjWriter, ThreeMFWriter, PrintPanel preview,
 * getExportedDimensions. No mutable module globals, no getState() reads in
 * the consumers.
 *
 * Field ownership (see typedef below):
 *   • Immutable inputs: state, options, units, referenceUnit, referenceRatio,
 *     targetRatio, pivot, ratioFactor, unitFactor, factor, projectName,
 *     individually.
 *     These are set by buildExportContext and never reassigned. The returned
 *     object is Object.freeze'd (shallow) so attempts to reassign throw in
 *     strict mode.
 *   • Pipeline-managed mutables: csgReady, csgSkipped, meshes, cloneGroups.
 *     The arrays live inside the frozen object but their contents are
 *     populated by PrintPipeline as it walks the clone+prep+validate stages.
 *     This is intentional — the alternative (a separate "run" object that
 *     wraps the immutable ctx) doubles the type surface for no gain.
 */

import { objectRatio, exportRatiosFromState } from '../scale/ScaleMath.js';
import { logicalObjectLeadIds, logicalObjectPartIds } from '../LogicalObjects.js';
import { AssetLoader } from '../AssetLoader.js';
import { getState } from '../StateManager.js';

const BABYLON = window.BABYLON;
if (!BABYLON) throw new Error('Babylon.js failed to load');

/** Babylon scene units (metres) → millimetres. Defined once. */
export const BU_TO_MM = 1000;

/**
 * @typedef {Object} ExportContext
 * @property {Object} state           StateManager snapshot at build time.
 * @property {Object} options         Caller options ({selectedOnly, individually, ...}).
 * @property {Array}  units           Logical print units (one entry per object).
 * @property {Object} referenceUnit   Anchor for ratio + pivot (active printable, else first).
 * @property {number} referenceRatio  Ratio of referenceUnit (positive number).
 * @property {number} targetRatio     Output ratio (positive). Equals referenceRatio for "as shown".
 * @property {{x:number,y:number,z:number}} pivot  World-space scaling anchor.
 * @property {number} ratioFactor     referenceRatio / targetRatio (dimensionless).
 * @property {number} unitFactor      BU→mm (always BU_TO_MM).
 * @property {number} factor          ratioFactor * unitFactor (× to convert BU dimension → mm at target).
 * @property {string} projectName     state.project.name || 'Untitled'.
 * @property {boolean} individually   Per-part output.
 * @property {boolean} csgReady       Mutated by pipeline once CSG2 init resolves.
 * @property {string[]} csgSkipped    Mutated by pipeline.
 * @property {Array} meshes           Mutated by pipeline (clone entries).
 * @property {Array} cloneGroups      Mutated by pipeline (per-logical-unit groupings).
 */

/**
 * Build the ExportContext for one export target.
 *
 * Scalar fields (ratios, factors, pivot, names, flags) are set here and are
 * shallow-frozen via Object.freeze on the returned object — reassigning them
 * throws in strict mode. The four list fields (csgSkipped, meshes, cloneGroups)
 * are arrays whose CONTENTS the pipeline mutates as it walks clones, but
 * whose REFERENCES cannot be swapped. csgReady is a build-time input —
 * callers pass true after CSG2 init resolves; otherwise false. This keeps
 * the ctx as a single immutable-shape object without per-run side flags.
 *
 * @param {Object} args
 * @param {Object} args.state          StateManager snapshot.
 * @param {Array}  args.units          Result of collectPrintUnits.
 * @param {number} [args.target]       Explicit target ratio; null ⇒ "as shown" (== referenceRatio).
 * @param {Object} [args.options]      Caller options bag.
 * @param {boolean} [args.csgReady]    True once CSG2 init resolved.
 * @returns {ExportContext}
 */
export function buildExportContext({ state, units, target = null, options = {}, csgReady = false }) {
  if (!state) throw new Error('buildExportContext: state required');
  if (!Array.isArray(units) || !units.length) throw new Error('buildExportContext: units required');
  const referenceUnit = _selectReferenceUnit(units, state);
  const referenceRatio = objectRatio(referenceUnit?.obj ?? null);
  const targetRatio = _positiveOrNull(target) ?? referenceRatio;
  if (!(referenceRatio > 0)) throw new Error('buildExportContext: referenceRatio must be positive');
  if (!(targetRatio > 0))    throw new Error('buildExportContext: targetRatio must be positive');
  const ratioFactor = referenceRatio / targetRatio;
  // Deep-freeze the nested objects a consumer might be tempted to mutate.
  // units must stay live — its Babylon mesh handles are referenced after the
  // ctx is built and Babylon mutates them itself. pivot is converted to a
  // plain {x,y,z} before freezing so we don't freeze a Babylon Vector3 whose
  // internal state Babylon may mutate.
  const p = _referencePivot(referenceUnit);
  const pivot = Object.freeze({ x: p.x, y: p.y, z: p.z });
  const frozenOptions = Object.freeze({ ...options });
  return Object.freeze({
    state,
    options: frozenOptions,
    units,
    referenceUnit,
    referenceRatio,
    targetRatio,
    pivot,
    ratioFactor,
    unitFactor: BU_TO_MM,
    factor: ratioFactor * BU_TO_MM,
    projectName: state.project?.name || 'Untitled',
    individually: !!options.individually,
    csgReady: !!csgReady,
    csgSkipped: [],
    meshes: [],
    cloneGroups: [],
  });
}

/**
 * Collect printable logical units from a state snapshot.
 *
 * One entry per logical object (the user-facing thing). Each carries its
 * parts (one per material-split sibling) with the live Babylon mesh handle.
 * Units with no live mesh parts are dropped.
 *
 * @param {Object}  state        StateManager snapshot.
 * @param {boolean} selectedOnly Filter to selection.
 * @returns {Array} units
 */
export function collectPrintUnits(state, selectedOnly) {
  const objects = state.scene.objects;
  const selected = new Set(state.selection.selectedIds);
  const units = [];
  for (const leadId of logicalObjectLeadIds(objects)) {
    const leadObj = objects[leadId];
    if (!leadObj || leadObj.isGhost || !leadObj.isPrintPart) continue;
    if (selectedOnly && !selected.has(leadId)) continue;
    const parts = [];
    for (const meshId of logicalObjectPartIds(leadId, objects)) {
      const obj = objects[meshId];
      if (!obj || obj.isGhost || !obj.isPrintPart) continue;
      const mesh = AssetLoader.getBabylonMesh(meshId);
      if (!mesh) continue;
      if (!mesh.getTotalVertices?.() || mesh.getTotalVertices() === 0) continue;
      parts.push({ meshId, mesh, obj });
    }
    if (parts.length) units.push({ logicalId: leadId, name: leadObj.name, obj: leadObj, parts });
  }
  return units;
}

/**
 * Build a preview context for the Scale panel and dimension previews. Reads
 * current state and current export-ratio list. Returns null when there are
 * no printable units (caller should render a placeholder rather than crash).
 *
 * @param {{selectedOnly?:boolean, individually?:boolean}} [options]
 * @returns {ExportContext|null}
 */
export function previewExportContext(options = {}) {
  const state = getState();
  const units = collectPrintUnits(state, !!options.selectedOnly);
  if (!units.length) return null;
  const explicit = exportRatiosFromState(state);
  const target = explicit.length ? explicit[0] : null;
  // Mirror PrintPipeline._runExportForTarget: capture persisted print prefs
  // into the ctx options so preview and actual export read from the same
  // snapshot.
  const mergedOptions = {
    objBakeSolidTextures: !!state.print?.objBakeSolidTextures,
    ...options,
  };
  // Crashing the Scale panel because one printable object has a bad ratio is
  // worse than rendering "no preview" — degrade gracefully and let the user
  // fix the value in Properties.
  try {
    return buildExportContext({ state, units, target, options: mergedOptions });
  } catch (err) {
    console.error('previewExportContext: buildExportContext failed:', err);
    return null;
  }
}

/**
 * Public summary of the export reference (used by the Scale panel
 * to label "as shown" with the actual ratio that will be exported).
 *
 * @param {{selectedOnly?:boolean}} [options]
 * @returns {{logicalId: string|null, ratio: number}}
 */
export function getExportReference(options = {}) {
  const state = getState();
  const units = collectPrintUnits(state, !!options.selectedOnly);
  const unit = _selectReferenceUnit(units, state);
  return {
    logicalId: unit?.logicalId ?? null,
    ratio: objectRatio(unit?.obj ?? null),
  };
}

/**
 * Compute the export bounding-box size in millimetres for a single mesh.
 * Accepts an optional pre-built ctx; otherwise builds a preview ctx.
 *
 * @param {string} meshId
 * @param {ExportContext} [ctx] Reuses an existing preview ctx (avoids a rebuild
 *                              when the caller already has one).
 * @returns {{x:number, y:number, z:number}|null} mm, or null when the mesh
 *                                                 isn't present.
 */
export function getExportedDimensions(meshId, ctx = null) {
  // The 2nd arg used to be an `options` bag in the legacy signature. A truthy
  // non-context object silently produced NaN dims. Detect the misuse and
  // throw so the caller's mistake is loud, not a silent NaN.
  if (ctx !== null && (typeof ctx !== 'object' || !Number.isFinite(ctx.factor))) {
    throw new TypeError(
      'getExportedDimensions: second argument must be an ExportContext ' +
      '(use previewExportContext() to build one). The legacy options-bag signature was removed 2026-06-19.'
    );
  }
  const state = getState();
  const obj = state.scene.objects[meshId];
  if (!obj) return null;
  const mesh = AssetLoader.getBabylonMesh(meshId);
  if (!mesh) return null;
  const useCtx = ctx ?? previewExportContext();
  if (!useCtx) return null;
  const bb = mesh.getBoundingInfo().boundingBox;
  const size = bb.maximumWorld.subtract(bb.minimumWorld);
  const f = useCtx.factor;
  return { x: size.x * f, y: size.y * f, z: size.z * f };
}

// ── internals ────────────────────────────────────────────

function _selectReferenceUnit(units, state) {
  const activeId = state.selection?.activeId ?? null;
  const activeUnit = activeId ? units.find(u => u.logicalId === activeId) : null;
  return activeUnit ?? units[0] ?? null;
}

function _referencePivot(unit) {
  const leadPart = unit?.parts?.find(p => p.meshId === unit.logicalId) ?? unit?.parts?.[0] ?? null;
  const mesh = leadPart?.mesh;
  // A reference unit with no live mesh is a contract violation — collectPrintUnits
  // filters meshless parts out, so reaching here means something else broke.
  if (!mesh) throw new Error('buildExportContext: reference unit has no live mesh');
  mesh.computeWorldMatrix?.(true);
  const t = mesh.getWorldMatrix?.()?.getTranslation?.();
  // Silently anchoring scaling at world origin (the previous fallback) made
  // every non-1:1 export shift mixed-ratio multi-selects to wrong positions.
  // Throw explicitly so the orchestrator's caller sees the failure.
  if (!t?.clone) throw new Error('buildExportContext: reference mesh produced no world translation');
  return t.clone();
}

function _positiveOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}
