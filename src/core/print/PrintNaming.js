/**
 * Export filename helpers.
 *
 * Both helpers take an ExportContext (see ExportContext.js). No getState()
 * reads, no module-level state. The ratio suffix `_r{ref}to{target}` (e.g.
 * `_r1to1` for "as shown") is appended INTERNALLY by ExportPlanner — callers
 * never need it standalone, so there's no separate `ratioSuffix` accessor.
 *
 * Pure math + string formatting only — actual file naming policy.
 */

import {
  exportBaseName as plannerExportBaseName,
  perMeshBaseName as plannerPerMeshBaseName,
} from './ExportPlanner.js';

/** @typedef {import('./ExportContext.js').ExportContext} ExportContext */

function _scales(ctx) {
  return [
    { sceneRatio: ctx.referenceRatio },
    { printRatio: ctx.targetRatio },
  ];
}

/**
 * Bundle name: `{projectName}_r{ref}to{target}`.
 * @param {ExportContext} ctx
 */
export function exportBaseName(ctx) {
  const [scene, print] = _scales(ctx);
  return plannerExportBaseName(ctx.projectName, scene, print);
}

/**
 * Per-part name: `{projectName}_{partName}_r{ref}to{target}`.
 * @param {ExportContext} ctx
 * @param {string} meshName
 */
export function perMeshBaseName(ctx, meshName) {
  const [scene, print] = _scales(ctx);
  return plannerPerMeshBaseName(ctx.projectName, meshName, scene, print);
}
