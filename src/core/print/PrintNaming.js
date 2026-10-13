/**
 * Export filename helpers.
 *
 * Both helpers take an ExportContext (see ExportContext.js). No getState()
 * reads, no module-level state. The scale suffix — `_r{ref}to{target}` for
 * ratio targets and "as shown" (e.g. `_r1to1`), `_x{N}` for a factor target,
 * `_h{N}mm` for a height target — is appended INTERNALLY by ExportPlanner — callers
 * never need it standalone, so there's no separate `ratioSuffix` accessor.
 *
 * Pure math + string formatting only — actual file naming policy.
 */

import {
  exportBaseName as plannerExportBaseName,
  perMeshBaseName as plannerPerMeshBaseName,
} from './ExportPlanner.js';

/** @typedef {import('./ExportContext.js').ExportContext} ExportContext */

// Symmetric with PrintPrep.flattenWorld: throw explicit on missing ctx
// instead of letting `ctx.projectName` deref a vague "Cannot read properties
// of undefined" deep inside the ExportPlanner call.
function _requireCtx(ctx, where) {
  if (!ctx) throw new Error(`PrintNaming.${where}: ctx required`);
  if (!(ctx.referenceRatio > 0)) throw new Error(`PrintNaming.${where}: ctx.referenceRatio must be positive`);
  if (!(ctx.targetRatio > 0))    throw new Error(`PrintNaming.${where}: ctx.targetRatio must be positive`);
}

function _scales(ctx) {
  return [
    { sceneRatio: ctx.referenceRatio },
    { printRatio: ctx.targetRatio, target: ctx.target ?? null },
  ];
}

/**
 * Bundle name: `{projectName}{suffix}` (`_r{ref}to{T}` | `_x{N}` | `_h{N}mm`).
 * @param {ExportContext} ctx
 */
export function exportBaseName(ctx) {
  _requireCtx(ctx, 'exportBaseName');
  const [scene, print] = _scales(ctx);
  return plannerExportBaseName(ctx.projectName, scene, print);
}

/**
 * Per-part name: `{projectName}_{partName}{suffix}`.
 * @param {ExportContext} ctx
 * @param {string} meshName
 */
export function perMeshBaseName(ctx, meshName) {
  _requireCtx(ctx, 'perMeshBaseName');
  const [scene, print] = _scales(ctx);
  return plannerPerMeshBaseName(ctx.projectName, meshName, scene, print);
}
