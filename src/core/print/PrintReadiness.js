import { checkBedFit } from './BedFit.js';
import { toPrintSpace } from './PrintSpace.js';

export const EXPORT_FORMATS = Object.freeze(['obj', '3mf', 'stl']);

/**
 * Formats that ship the part where it sits in the scene. The 3MF writer
 * re-seats the build (centred in X/Y, min z → 0), so a part dipping under
 * the scene floor is only a problem for these.
 */
export const WORLD_PLACED_FORMATS = Object.freeze(['obj', 'stl']);

function issue(code, severity, objectIds, data = {}) {
  return { code, severity, objectIds: [...new Set(objectIds ?? [])], data };
}

function partIds(parts, predicate) {
  return parts.filter(predicate).flatMap(part => part.objectIds?.length
    ? part.objectIds : [part.objectId]).filter(Boolean);
}

/**
 * Build stable, untranslated readiness records for UI and export gating.
 *
 * Bed-fit decision (audit H5, 2026-09-17): readiness is computed in the SAME
 * frame the exporter ships. `target.bounds` are PrintSpace world mm bounds
 * (see {@link boundsForExportContext}); {@link checkBedFit} applies the 3MF
 * writer's placement (centre X/Y, rest on bed).
 *   (a) `bed-overflow` — the seated X/Y footprint exceeds the bed, or the
 *       height exceeds bed Z when a Z limit is configured. Applies to every
 *       format: the extent is placement-independent.
 *   (b) `below-bed`    — min print-space z < 0, i.e. the part dips under the
 *       scene floor. Only OBJ/STL keep world placement, so the issue names
 *       them in `data.formats`; a 3MF-only export may ignore it.
 */
export function buildReadiness({ parts = [], targets = [], bedDimensions } = {}) {
  const issues = [];
  if (!parts.length) {
    issues.push(issue('no-print-parts', 'error', []));
  } else {
    const missingSource = partIds(parts, part => part.sourceAvailable === false);
    const missingTexture = partIds(parts, part => part.textureAvailable === false);
    const unconfirmed = partIds(parts, part => part.unitConfirmed === false);
    if (missingSource.length) issues.push(issue('missing-source', 'error', missingSource));
    if (missingTexture.length) issues.push(issue('missing-texture', 'error', missingTexture));
    if (unconfirmed.length) issues.push(issue('unit-unconfirmed', 'warning', unconfirmed));

    const geometryErrors = parts.filter(part => part.validationResults?.some(r => r.severity === 'error'));
    const geometryWarnings = parts.filter(part => part.validationResults?.some(r => r.severity === 'warning'));
    if (geometryErrors.length) {
      issues.push(issue('geometry-error', 'error', partIds(geometryErrors, () => true), {
        messages: geometryErrors.flatMap(part => part.validationResults
          .filter(result => result.severity === 'error').map(result => result.message)),
      }));
    }
    if (geometryWarnings.length) {
      issues.push(issue('geometry-warning', 'warning', partIds(geometryWarnings, () => true), {
        messages: geometryWarnings.flatMap(part => part.validationResults
          .filter(result => result.severity === 'warning').map(result => result.message)),
      }));
    }
  }

  const targetSummaries = targets.map(target => {
    const fit = checkBedFit(target.bounds, bedDimensions);
    const objectIds = target.objectIds ?? parts.flatMap(part => part.objectIds ?? [part.objectId]);
    if (!fit.fits) {
      issues.push(issue('bed-overflow', 'warning', objectIds, {
        targetRatio: target.ratio ?? null,
        targetLabel: target.label ?? null,
        overflowMM: fit.overflowMM,
        sizeMM: fit.sizeMM,
      }));
    }
    if (fit.belowBedMM > 0) {
      issues.push(issue('below-bed', 'warning', objectIds, {
        targetRatio: target.ratio ?? null,
        targetLabel: target.label ?? null,
        belowBedMM: fit.belowBedMM,
        formats: [...WORLD_PLACED_FORMATS],
      }));
    }
    return { ...target, fit };
  });

  const hasErrors = issues.some(item => item.severity === 'error');
  const hasWarnings = issues.some(item => item.severity === 'warning');
  return {
    status: hasErrors ? 'blocked' : hasWarnings ? 'warning' : 'ready',
    canExport: !hasErrors,
    requiresAcknowledgement: !hasErrors && hasWarnings,
    formats: [...EXPORT_FORMATS],
    targets: targetSummaries,
    issues,
  };
}

/**
 * Union of the live Babylon world AABBs of every print part, scaled to the
 * target ratio about the export pivot, converted to millimetres with
 * `ctx.unitFactor` and mapped into PrintSpace (right-handed, Z-up) with the
 * same `toPrintSpace` every writer uses. No bed placement is applied here —
 * {@link checkBedFit} owns that — so the bounds are exactly what the STL
 * writer ships and what the 3MF writer sees before it seats the build.
 *
 * `toPrintSpace` is an axis permutation with sign flips, so mapping the two
 * AABB corners and re-sorting per axis is exact.
 *
 * @returns {{min:number[], max:number[]}|null} null when there is nothing
 *   to measure (no ratio, no pivot, no live bounding boxes).
 */
export function boundsForExportContext(ctx) {
  const r = ctx?.ratioFactor;
  const p = ctx?.pivot;
  if (!(r > 0) || !p) return null;
  const mm = ctx.unitFactor;
  if (!(mm > 0)) throw new TypeError('boundsForExportContext: ctx.unitFactor missing — pass a real ExportContext');
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  let found = false;
  const scale = (v, pivot) => ((v - pivot) * r + pivot) * mm;
  for (const unit of ctx.units ?? []) {
    for (const part of unit.parts ?? []) {
      const mesh = part.mesh;
      mesh?.computeWorldMatrix?.(true);
      const box = mesh?.getBoundingInfo?.()?.boundingBox;
      if (!box?.minimumWorld || !box?.maximumWorld) continue;
      const lo = box.minimumWorld;
      const hi = box.maximumWorld;
      const a = toPrintSpace(scale(lo.x, p.x), scale(lo.y, p.y), scale(lo.z, p.z));
      const b = toPrintSpace(scale(hi.x, p.x), scale(hi.y, p.y), scale(hi.z, p.z));
      for (let axis = 0; axis < 3; axis++) {
        min[axis] = Math.min(min[axis], a[axis], b[axis]);
        max[axis] = Math.max(max[axis], a[axis], b[axis]);
      }
      found = true;
    }
  }
  return found ? { min, max } : null;
}
