import { checkBedFit } from './BedFit.js';

export const EXPORT_FORMATS = Object.freeze(['obj', '3mf', 'stl']);

function issue(code, severity, objectIds, data = {}) {
  return { code, severity, objectIds: [...new Set(objectIds ?? [])], data };
}

function partIds(parts, predicate) {
  return parts.filter(predicate).flatMap(part => part.objectIds?.length
    ? part.objectIds : [part.objectId]).filter(Boolean);
}

/** Build stable, untranslated readiness records for UI and export gating. */
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
    if (Object.values(fit.overflowMM).some(value => value > 0)) {
      issues.push(issue('bed-overflow', 'warning', objectIds, {
        targetRatio: target.ratio ?? null,
        targetLabel: target.label ?? null,
        overflowMM: fit.overflowMM,
      }));
    }
    if (fit.belowBedMM > 0) {
      issues.push(issue('below-bed', 'warning', objectIds, {
        targetRatio: target.ratio ?? null,
        targetLabel: target.label ?? null,
        belowBedMM: fit.belowBedMM,
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

/** Project live Babylon world AABBs into the slicer's positive XYZ bed space. */
export function boundsForExportContext(ctx, bedDimensions) {
  const r = ctx?.ratioFactor;
  const p = ctx?.pivot;
  if (!(r > 0) || !p) return null;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  let found = false;
  for (const unit of ctx.units ?? []) {
    for (const part of unit.parts ?? []) {
      const mesh = part.mesh;
      mesh?.computeWorldMatrix?.(true);
      const box = mesh?.getBoundingInfo?.()?.boundingBox;
      if (!box?.minimumWorld || !box?.maximumWorld) continue;
      const lo = box.minimumWorld;
      const hi = box.maximumWorld;
      const projectedMin = [
        ((lo.x - p.x) * r + p.x) * 1000 + Number(bedDimensions?.x ?? 0) / 2,
        ((lo.z - p.z) * r + p.z) * 1000 + Number(bedDimensions?.y ?? 0) / 2,
        ((lo.y - p.y) * r + p.y) * 1000,
      ];
      const projectedMax = [
        ((hi.x - p.x) * r + p.x) * 1000 + Number(bedDimensions?.x ?? 0) / 2,
        ((hi.z - p.z) * r + p.z) * 1000 + Number(bedDimensions?.y ?? 0) / 2,
        ((hi.y - p.y) * r + p.y) * 1000,
      ];
      for (let axis = 0; axis < 3; axis++) {
        min[axis] = Math.min(min[axis], projectedMin[axis]);
        max[axis] = Math.max(max[axis], projectedMax[axis]);
      }
      found = true;
    }
  }
  return found ? { min, max } : null;
}
