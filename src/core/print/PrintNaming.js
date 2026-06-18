/**
 * Export filename helpers.
 *
 * Every helper takes an ExportContext (see ExportContext.js). No getState()
 * reads, no module-level state. The ratio suffix is `_r{ref}to{target}`; for
 * "as shown" (target == reference) this is `_r1to1`-style.
 *
 * Pure math + string formatting only — actual file naming policy.
 */

import {
  exportBaseName as plannerExportBaseName,
  perMeshBaseName as plannerPerMeshBaseName,
  scaleFilenameSuffix,
} from './ExportPlanner.js';

/** @typedef {import('./ExportContext.js').ExportContext} ExportContext */

function _scales(ctx) {
  return [
    { sceneRatio: ctx.referenceRatio },
    { printRatio: ctx.targetRatio },
  ];
}

/**
 * `_r{ref}to{target}` filename suffix.
 * @param {ExportContext} ctx
 */
export function ratioSuffix(ctx) {
  const [scene, print] = _scales(ctx);
  return scaleFilenameSuffix(scene, print);
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
