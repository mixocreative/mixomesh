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

// The ratio an object's vertices are baked at, relative to its asset's raw
// bytes (vertices = raw × unit × modelRatio / bakedRatio). It equals `ratio`
// until a Set scale relabel moves the label without resizing; the relabel
// stores the old anchor as `bakedRatio` so a reload rebuilds the same size.
export function bakedRatioOf(obj) {
  const n = Number(obj?.bakedRatio);
  return Number.isFinite(n) && n > 0 ? n : objectRatio(obj);
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

// Typed print sizes (task 1.17 / Decision 27). `print.exportTargets` is a
// list of `{kind:'ratio', value}` (print at 1:value), `{kind:'factor', value}`
// (×value of the size shown) or `{kind:'height', mm}` (make the export
// reference `mm` tall along print-space Z, the bed-up axis). An EMPTY list
// means "as shown" — PrintPipeline + ExportContext resolve that to the
// reference object's effective ratio (factor 1). Legacy `exportRatios` lists
// are migrated by ProjectLoader.resolveLoadedExportTargets.
export const EXPORT_TARGET_KINDS = Object.freeze(['ratio', 'factor', 'height']);

/**
 * Normalise one export target. Accepts a typed target or a bare positive
 * number (legacy ratio). Returns a frozen typed target, or null when invalid.
 */
export function normalizeExportTarget(target) {
  if (typeof target === 'number') {
    return target > 0 && Number.isFinite(target) ? Object.freeze({ kind: 'ratio', value: target }) : null;
  }
  if (!target || typeof target !== 'object') return null;
  if (target.kind === 'height') {
    const mm = Number(target.mm);
    return Number.isFinite(mm) && mm > 0 ? Object.freeze({ kind: 'height', mm }) : null;
  }
  if (target.kind === 'ratio' || target.kind === 'factor') {
    const value = Number(target.value);
    return Number.isFinite(value) && value > 0 ? Object.freeze({ kind: target.kind, value }) : null;
  }
  return null;
}

/** Normalised list (invalid entries dropped, duplicates collapsed). */
export function normalizeExportTargets(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const raw of list) {
    const t = normalizeExportTarget(raw);
    if (t && !out.some(o => exportTargetsEqual(o, t))) out.push(t);
  }
  return out;
}

/** Same kind and same magnitude. */
export function exportTargetsEqual(a, b) {
  if (!a || !b || a.kind !== b.kind) return false;
  return a.kind === 'height' ? a.mm === b.mm : a.value === b.value;
}

/** The project's typed print sizes; [] = as shown. */
export function exportTargetsFromState(state) {
  return normalizeExportTargets(state?.print?.exportTargets);
}

/**
 * Ratio-kind target values only (denominators). Used for the one-minor
 * `exportRatios` mirror written next to `exportTargets` in saved documents so
 * schema-3.3 readers still see the ratio targets.
 */
export function exportRatiosFromState(state) {
  return exportTargetsFromState(state).filter(t => t.kind === 'ratio').map(t => t.value);
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
