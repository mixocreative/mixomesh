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

// Per-object scale (the per-object ratio redesign, 2026-06-16). An object's
// `ratio` IS the old global workingRatio promoted to object scope; it falls
// back to the asset's authoring `modelRatio`, then 1. Used as the scene-scale
// term for that object at import, display, and export.
export function objectRatio(obj) {
  return _positiveOrOne(obj?.ratio ?? obj?.modelRatio);
}

// World-space node scale of a mesh: per-axis magnitude, so parent scaling
// (a group at x2) counts and a negative (mirror) scale is just its size.
// Reads the world matrix (row-major: rows 0-2 hold the scaled basis vectors),
// else absoluteScaling, else the local scaling chain up the parents.
export function nodeScaleOf(mesh) {
  if (!mesh) return { x: 1, y: 1, z: 1 };
  mesh.computeWorldMatrix?.(true);
  const m = mesh.getWorldMatrix?.()?.m;
  if (m && m.length >= 11) {
    const len = (i) => Math.hypot(m[i], m[i + 1], m[i + 2]);
    return { x: len(0), y: len(4), z: len(8) };
  }
  const a = mesh.absoluteScaling;
  if (a && Number.isFinite(a.x)) return { x: Math.abs(a.x), y: Math.abs(a.y), z: Math.abs(a.z) };
  const t = { x: 1, y: 1, z: 1 };
  for (let n = mesh; n; n = n.parent) {
    if (!n.scaling) continue;
    t.x *= Math.abs(n.scaling.x); t.y *= Math.abs(n.scaling.y); t.z *= Math.abs(n.scaling.z);
  }
  return t;
}

// Effective scale (Decision 26): the declared ratio divided by the node's
// uniform world scale (1:72 at node scale 2 is really 1:36). Non-uniform
// scale has no single answer, so the declared ratio is kept and flagged.
export function effectiveRatioInfo(obj, mesh) {
  const ratio = objectRatio(obj);
  const s = nodeScaleOf(mesh);
  const ok = [s.x, s.y, s.z].every(v => Number.isFinite(v) && v > 0);
  if (!ok) return { ratio, uniform: true, nodeScale: 1 };
  const uniform = Math.abs(s.x - s.y) <= 1e-6 && Math.abs(s.y - s.z) <= 1e-6;
  if (!uniform) return { ratio, uniform: false, nodeScale: s };
  return { ratio: Math.abs(s.x - 1) <= 1e-6 ? ratio : ratio / s.x, uniform: true, nodeScale: s.x };
}

export function effectiveRatio(obj, mesh) {
  return effectiveRatioInfo(obj, mesh).ratio;
}

export function objectScaleFromObject(obj) {
  return { sceneRatio: objectRatio(obj) };
}

// The user's explicit export target ratios (denominators). New default is an
// EMPTY list, meaning "as shown" — PrintPipeline + ExportContext resolve that
// to the active printable object's ratio. (Pre-redesign saves are migrated by
// ProjectLoader.resolveLoadedExportRatios.)
export function exportRatiosFromState(state) {
  const list = state?.print?.exportRatios;
  return (Array.isArray(list) && list.length) ? list.map(_positiveOrOne) : [];
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
