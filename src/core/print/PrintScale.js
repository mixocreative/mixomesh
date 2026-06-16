import { getState } from '../StateManager.js';
import { AssetLoader } from '../AssetLoader.js';
import scalePresetData from '../../config/scale-presets.json' with { type: 'json' };
import {
  computePrintExportScale,
  formatScaleRatio,
  objectRatio,
  exportRatiosFromState,
} from '../scale/ScaleMath.js';
import {
  exportBaseName as plannerExportBaseName,
  perMeshBaseName as plannerPerMeshBaseName,
  scaleFilenameSuffix,
} from './ExportPlanner.js';

export const SCALE_PRESETS = scalePresetData;

// Export scale (2026-06-16): the reference is the ACTIVE object's ratio, and
// the print size = displayed size × (activeRatio / targetRatio) × 1000(BU→mm).
//   • target === activeRatio  ⇒ factor 1000 ⇒ print EXACTLY what's shown ("as
//     shown" — the DEFAULT when the user hasn't added explicit targets).
//   • target 1:144 on a 1:72 object ⇒ 72/144 = 0.5× smaller than shown.
// A mixed-ratio selection scales uniformly by the active object's ratio so the
// on-screen arrangement is preserved (WYSIWYG). The `exportRatios` LIST holds
// extra absolute targets; one output file per target.
function activeRatio(state) {
  const ids = state.selection?.selectedIds ?? [];
  const activeId = state.selection?.activeId ?? ids[0] ?? Object.keys(state.scene.objects)[0] ?? null;
  return objectRatio(activeId ? state.scene.objects[activeId] : null);
}

function sceneScaleFor(state, ctx = null) {
  const ratio = ctx && Number.isFinite(ctx.referenceRatio) && ctx.referenceRatio > 0
    ? ctx.referenceRatio
    : activeRatio(state);
  return { sceneRatio: ratio };
}

// Resolve the export TARGET ratios. An empty list ⇒ one "as shown" export at
// the active object's ratio (factor 1000). Migration of pre-redesign saves
// leaves a single targetRatio entry.
export function resolveExportTargets(state) {
  const list = exportRatiosFromState(state);
  return list.length ? list : [activeRatio(state)];
}

// Batch export drives one file per resolved target. While a single target is
// being written, `_targetOverride` pins THAT ratio so factor / suffix / name
// all reflect it; cleared between targets.
let _targetOverride = null;
export function setExportTargetOverride(ratio) {
  _targetOverride = (Number.isFinite(ratio) && ratio > 0) ? ratio : null;
}

function currentPrintScale(state) {
  return { printRatio: _targetOverride ?? resolveExportTargets(state)[0] };
}

export function exportFactor() {
  const state = getState();
  return computePrintExportScale(sceneScaleFor(state), currentPrintScale(state));
}

export function exportFactorFor(ctx) {
  const state = getState();
  return computePrintExportScale(sceneScaleFor(state, ctx), currentPrintScale(state));
}

export function ratioSuffix() {
  const state = getState();
  return scaleFilenameSuffix(sceneScaleFor(state), currentPrintScale(state));
}

export function exportBaseName(ctx) {
  const state = getState();
  return plannerExportBaseName(ctx.projectName, sceneScaleFor(state, ctx), currentPrintScale(state));
}

export function perMeshBaseName(ctx, meshName) {
  const state = getState();
  return plannerPerMeshBaseName(ctx.projectName, meshName, sceneScaleFor(state, ctx), currentPrintScale(state));
}

export function getExportedDimensions(meshId) {
  const state = getState();
  const obj = state.scene.objects[meshId];
  if (!obj) return null;
  const mesh = AssetLoader.getBabylonMesh(meshId);
  if (!mesh) return null;

  const bb = mesh.getBoundingInfo().boundingBox;
  const size = bb.maximumWorld.subtract(bb.minimumWorld);
  const factor = exportFactor();

  return {
    x: size.x * factor,
    y: size.y * factor,
    z: size.z * factor,
  };
}

export function scaleSummary() {
  const state = getState();
  const sceneRatio = sceneScaleFor(state).sceneRatio;
  const printRatio = currentPrintScale(state).printRatio;
  return {
    sceneRatio,
    printRatio,
    sceneLabel: formatScaleRatio(sceneRatio),
    printLabel: formatScaleRatio(printRatio),
    printExportScale: exportFactor(),
  };
}
