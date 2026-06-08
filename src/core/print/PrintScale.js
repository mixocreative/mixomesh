import { getState } from '../StateManager.js';
import { AssetLoader } from '../AssetLoader.js';
import scalePresetData from '../../config/scale-presets.json' with { type: 'json' };
import {
  computePrintExportScale,
  formatScaleRatio,
  printScaleFromState,
  sceneScaleFromState,
} from '../scale/ScaleMath.js';
import {
  exportBaseName as plannerExportBaseName,
  perMeshBaseName as plannerPerMeshBaseName,
  scaleFilenameSuffix,
} from './ExportPlanner.js';

export const SCALE_PRESETS = scalePresetData;

export function exportFactor() {
  const state = getState();
  return computePrintExportScale(sceneScaleFromState(state), printScaleFromState(state));
}

export function ratioSuffix() {
  const state = getState();
  return scaleFilenameSuffix(sceneScaleFromState(state), printScaleFromState(state));
}

export function exportBaseName(ctx) {
  const state = getState();
  return plannerExportBaseName(ctx.projectName, sceneScaleFromState(state), printScaleFromState(state));
}

export function perMeshBaseName(ctx, meshName) {
  const state = getState();
  return plannerPerMeshBaseName(ctx.projectName, meshName, sceneScaleFromState(state), printScaleFromState(state));
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
  const sceneRatio = sceneScaleFromState(state).sceneRatio;
  const printRatio = printScaleFromState(state).printRatio;
  return {
    sceneRatio,
    printRatio,
    sceneLabel: formatScaleRatio(sceneRatio),
    printLabel: formatScaleRatio(printRatio),
    printExportScale: exportFactor(),
  };
}
