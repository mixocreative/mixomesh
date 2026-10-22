import { checkBedFit } from './BedFit.js';
import { toPrintSpace } from './PrintSpace.js';

export const EXPORT_FORMATS = Object.freeze(['obj', '3mf', 'stl', 'ply', 'wrl']);

/**
 * Formats that ship the part where it sits in the scene. The 3MF writer
 * re-seats the build (centred in X/Y, min z → 0), so a part dipping under
 * the scene floor is only a problem for these.
 */
export const WORLD_PLACED_FORMATS = Object.freeze(['obj', 'stl', 'ply', 'wrl']);

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
export function buildReadiness({
  parts = [], targets = [], bedDimensions, reference = null,
  profile = null, strictExport = false, representationIssues = [],
} = {}) {
  const issues = [...representationIssues];
  if (!parts.length) {
    issues.push(issue('no-print-parts', 'error', []));
  } else {
    const missingSource = partIds(parts, part => part.sourceAvailable === false);
    const missingTexture = partIds(parts, part => part.textureAvailable === false);
    const unconfirmed = partIds(parts, part => part.unitConfirmed === false);
    if (missingSource.length) issues.push(issue('missing-source', 'error', missingSource));
    if (missingTexture.length) issues.push(issue('missing-texture', 'error', missingTexture));
    if (unconfirmed.length) issues.push(issue('unit-unconfirmed', 'warning', unconfirmed));
    const pending = partIds(parts, part => part.validationPending === true);
    if (pending.length) issues.push(issue('validation-pending', 'warning', pending));
    // OBJ/MTL has no clamp (`-clamp on` breaks trimesh), so a clamped texture
    // whose UVs leave [0,1] prints repeated there; 3MF and VRML carry the
    // clamp. A hint, never a gate: info, named per format like below-bed.
    const clamped = partIds(parts, part => part.clampedTextureOverflow === true);
    if (clamped.length) issues.push(issue('texture-clamp-obj', 'info', clamped, { formats: ['obj'] }));

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

  if (parts.length) addProfileHints(issues, parts, targets, profile, strictExport);

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

  // 1.15 (Decision 25): parts at different scales print uniformly relative to
  // the explicit export reference — say so once (info: never blocks, never
  // needs acknowledgement).
  const ratios = [...new Set(parts.map(part => part.ratio).filter(r => r > 0))];
  if (ratios.length > 1) {
    issues.push(issue('mixed-scales', 'info', [], {
      referenceId: reference?.logicalId ?? null,
      referenceRatio: reference?.ratio ?? null,
      ratios: ratios.sort((a, b) => a - b),
    }));
  }

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
 * 1.4 per-printer hints, driven by the selected profile's `colour` and
 * `validation` blocks (0 / absent limit = no limit). Never invents errors:
 * only `watertight-required` escalates, and only under `strictExport`.
 *
 * thin-feature: `part.thicknessBU` is the MeshValidator thickness PROXY in
 * world Babylon units; print mm = BU x `target.scaleToMM` (ratioFactor x
 * unitFactor of that target's ExportContext). Judged against `minWallMM`
 * (falling back to `minFeatureMM`) for every target ratio.
 */
function addProfileHints(issues, parts, targets, profile, strictExport) {
  const colour = profile?.colour ?? {};
  const rules = profile?.validation ?? {};

  const maxSize = colour.maxTextureSize;
  if (maxSize > 0) {
    const big = parts.filter(p => (p.textures ?? []).some(tx => Math.max(tx.width, tx.height) > maxSize));
    if (big.length) {
      issues.push(issue('texture-too-large', 'warning', partIds(big, () => true), {
        maxTextureSize: maxSize,
        textures: big.flatMap(p => p.textures.filter(tx => Math.max(tx.width, tx.height) > maxSize)
          .map(tx => ({ objectId: p.objectId, assetId: tx.assetId, width: tx.width, height: tx.height }))),
      }));
    }
  }

  const maxCount = colour.maxTexturesPerObject;
  if (maxCount > 0) {
    const many = parts.filter(p => (p.textures ?? []).length > maxCount);
    if (many.length) {
      issues.push(issue('texture-count', 'warning', partIds(many, () => true), {
        maxTexturesPerObject: maxCount,
        counts: Object.fromEntries(many.map(p => [p.objectId, p.textures.length])),
      }));
    }
  }

  const minMM = rules.minWallMM > 0 ? rules.minWallMM : (rules.minFeatureMM > 0 ? rules.minFeatureMM : 0);
  if (minMM > 0) {
    for (const target of targets) {
      const k = target.scaleToMM;
      if (!(k > 0)) continue;
      const thin = parts.filter(p => p.thicknessBU > 0 && p.thicknessBU * k < minMM);
      if (!thin.length) continue;
      issues.push(issue('thin-feature', 'warning', partIds(thin, () => true), {
        targetRatio: target.ratio ?? null,
        targetLabel: target.label ?? null,
        minWallMM: minMM,
        minFeatureMM: rules.minFeatureMM ?? null,
        thicknessMM: Object.fromEntries(thin.map(p => [p.objectId, p.thicknessBU * k])),
        estimate: true,
      }));
    }
  }

  if (rules.requireWatertight) {
    const open = parts.filter(p => p.watertight === false);
    if (open.length) {
      issues.push(issue('watertight-required', strictExport ? 'error' : 'warning', partIds(open, () => true), {
        strict: !!strictExport,
      }));
    }
  }
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
