// Scale vocabulary used across import, scene editing, validation, and export.
// Runtime state still stores the v3.1 persisted names (`workingRatio`,
// `targetRatio`, `modelRatio`) for compatibility; this module exposes the
// clearer architecture names used by the new code paths.

export const SOURCE_UNIT_FACTORS = {
  millimeters: 0.001,
  centimeters: 0.01,
  meters:      1,
  inches:      0.0254,
  feet:        0.3048,
};

export const DEFAULT_SOURCE_UNIT = 'millimeters';

export function parseScaleRatioText(value) {
  const s = String(value ?? '').trim();
  let m = s.match(/^(\d+(?:\.\d+)?)\s*[:/]\s*(\d+(?:\.\d+)?)$/);
  if (m) {
    const a = parseFloat(m[1]);
    const b = parseFloat(m[2]);
    return a > 0 && b > 0 ? b / a : null;
  }
  m = s.match(/^(\d+(?:\.\d+)?)$/);
  if (m) {
    const n = parseFloat(m[1]);
    return n > 0 ? n : null;
  }
  return null;
}

export function formatScaleRatio(ratio) {
  const n = Number(ratio);
  if (!Number.isFinite(n) || n <= 0) return '1:1';
  if (Math.abs(n - 1) < 1e-9) return '1:1';
  if (n > 1) {
    const r = Math.round(n);
    return Math.abs(n - r) < 1e-6 ? `1:${r}` : `1:${(+n.toFixed(3)).toString()}`;
  }
  const m = 1 / n;
  const r = Math.round(m);
  return Math.abs(m - r) < 1e-6 ? `${r}:1` : `${(+m.toFixed(3)).toString()}:1`;
}

export function sceneScaleFromState(state) {
  const sceneRatio = state?.scale?.sceneRatio ?? state?.print?.workingRatio;
  return { sceneRatio: _positiveOrOne(sceneRatio) };
}

// Per-object scale (the per-object ratio redesign, 2026-06-16). An object's
// `ratio` IS the old global workingRatio promoted to object scope; it falls
// back to the asset's authoring `modelRatio`, then 1. Used as the scene-scale
// term for that object at import, display, and export.
export function objectRatio(obj) {
  return _positiveOrOne(obj?.ratio ?? obj?.modelRatio);
}

export function objectScaleFromObject(obj) {
  return { sceneRatio: objectRatio(obj) };
}

// The user's explicit export target ratios (denominators). New default is an
// EMPTY list, meaning "as shown" — PrintPipeline + ExportContext resolve that
// to the active printable object's ratio. Migrated pre-redesign saves surface
// their single `targetRatio` as one entry.
export function exportRatiosFromState(state) {
  const list = state?.print?.exportRatios;
  if (Array.isArray(list) && list.length) return list.map(_positiveOrOne);
  const legacy = state?.print?.targetRatio;
  return (Number.isFinite(legacy) && legacy > 0) ? [_positiveOrOne(legacy)] : [];
}

export function printScaleFromState(state) {
  const printRatio = state?.scale?.printRatio ?? state?.print?.targetRatio;
  return { printRatio: _positiveOrOne(printRatio) };
}

export function authoredScaleFromAsset(asset) {
  return {
    sourceUnit: asset?.authoredScale?.sourceUnit ?? asset?.sourceUnit ?? DEFAULT_SOURCE_UNIT,
    authoredRatio: _positiveOrOne(asset?.authoredScale?.authoredRatio ?? asset?.modelRatio),
    detectedFrom: asset?.authoredScale?.detectedFrom ?? 'default',
    confirmedByUser: asset?.authoredScale?.confirmedByUser ?? asset?.unitConfirmed !== false,
  };
}

export function computeSceneNormalizationScale(authoredScale, sceneScale) {
  const sourceUnit = authoredScale?.sourceUnit ?? DEFAULT_SOURCE_UNIT;
  const sourceFactor = SOURCE_UNIT_FACTORS[sourceUnit] ?? SOURCE_UNIT_FACTORS[DEFAULT_SOURCE_UNIT];
  const authoredRatio = _positiveOrOne(authoredScale?.authoredRatio);
  const sceneRatio = _positiveOrOne(sceneScale?.sceneRatio);
  return sourceFactor * (authoredRatio / sceneRatio);
}

export function computePrintExportScale(sceneScale, printScale) {
  const sceneRatio = _positiveOrOne(sceneScale?.sceneRatio);
  const printRatio = _positiveOrOne(printScale?.printRatio);
  return (sceneRatio / printRatio) * 1000;
}

export function computeSceneScaleRebakeFactor(previousSceneRatio, nextSceneRatio) {
  return _positiveOrOne(previousSceneRatio) / _positiveOrOne(nextSceneRatio);
}

function _positiveOrOne(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 1;
}
