// Import security caps (overhaul plan Decision 19 / task 6.4): max file size,
// and for zip-based formats (3MF) max entry count + max total uncompressed
// size (zip-bomb guard) + path-traversal rejection. Violations throw an Error
// with a user-readable message; the existing import-error modal shows it.
// (The 4x triangle budget of Decision 19 is a separate concern.)

export const IMPORT_LIMITS = Object.freeze({
  maxFileBytes: 1024 ** 3,               // 1 GB
  // Texture/material counts are not an import limit; the byte budget below is.
  maxZipEntries: Number.POSITIVE_INFINITY,
  maxZipUncompressedBytes: 2 * 1024 ** 3, // 2 GB
});

const mb = (n) => (n / 1024 / 1024).toFixed(0);

/** `err.code` of a triangle-budget refusal. Retry and failure-classification
 *  decisions key on it, never on the message wording. */
export const OVER_BUDGET = 'over-budget';

const overBudget = (message) => Object.assign(new Error(message), { code: OVER_BUDGET });

/** Throw when a file exceeds the size cap. */
export function assertImportFileSize(size, filename, limits = IMPORT_LIMITS) {
  if (Number.isFinite(size) && size > limits.maxFileBytes) {
    throw new Error(`"${filename}" is too large to import (${mb(size)} MB; the limit is ${mb(limits.maxFileBytes)} MB).`);
  }
}

/** True for an entry name that could escape the package root. */
export function isUnsafeZipPath(name) {
  const n = String(name).split('\\').join('/');
  return n.startsWith('/') || /^[A-Za-z]:/.test(n) || n.split('/').includes('..') || n.includes('\0');
}

/**
 * Inspect an already-opened JSZip's central directory (nothing decompressed):
 * entry count, declared total uncompressed size, unsafe paths.
 * @param {{ files: Record<string, any> }} zip
 */
export function assertZipSafe(zip, label = 'archive', limits = IMPORT_LIMITS) {
  const names = Object.keys(zip.files);
  if (names.length > limits.maxZipEntries) {
    throw new Error(`${label} has too many entries (${names.length}; the limit is ${limits.maxZipEntries}).`);
  }
  let total = 0;
  for (const name of names) {
    if (isUnsafeZipPath(name)) {
      throw new Error(`${label} contains an unsafe file path ("${name}") and was rejected.`);
    }
    total += zip.files[name]?._data?.uncompressedSize ?? 0;
    if (total > limits.maxZipUncompressedBytes) {
      throw new Error(`${label} expands to more than ${mb(limits.maxZipUncompressedBytes)} MB uncompressed and was rejected.`);
    }
  }
}

/** Reject a model before mesh creation when it exceeds the runtime's hard budget. */
export function assertTriangleCapacity(triangles, triangleBudget, label = 'Model') {
  const limit = triangleBudget * 4;
  if (limit > 0 && triangles > limit) {
    throw overBudget(`${label} has ${triangles.toLocaleString('en-US')} triangles; the polygon handling limit for this runtime is ${limit.toLocaleString('en-US')}. Simplify or split the model before importing.`);
  }
}

/** Margin on sampled (non-exact) estimates before they may refuse an import. */
/** Sampled estimates refuse only far above the limit (review M9): a wrong
 *  refusal blocks a file the user may well be able to load. */
export const ESTIMATE_REFUSE_MARGIN = 2;

/**
 * Pre-parse budget decision (heavy-mesh spec §1/§3). Throws the refusal
 * message when the scene would exceed 4× the budget — on an exact count, or on
 * a sampled estimate above 4× × ESTIMATE_REFUSE_MARGIN (never for `warnOnly`). Returns 'warn' above 1×,
 * 'ok' otherwise, or 'unknown' when there is no estimate.
 * @param {{ triangles: number, exact: boolean } | null} estimate
 * @param {{ sceneTriangles?: number, budget: number, filename: string, desktop?: boolean }} ctx
 * @returns {'ok'|'warn'|'unknown'}
 */
export function assertPreParseCapacity(estimate, { sceneTriangles = 0, budget, filename, desktop = false }) {
  if (!estimate || !(budget > 0)) return 'unknown';
  const projected = sceneTriangles + estimate.triangles;
  const limit = budget * 4;
  // `warnOnly` estimates (3MF: bytes per triangle vary with per-triangle
  // attributes) never refuse; the parse-time check is their backstop.
  const refuseAt = estimate.exact ? limit : estimate.warnOnly ? Infinity : limit * ESTIMATE_REFUSE_MARGIN;
  if (projected > refuseAt) {
    const about = estimate.exact ? '' : 'about ';
    const scene = sceneTriangles > 0 ? ` (with the ${sceneTriangles.toLocaleString('en-US')} already in the scene)` : '';
    const next = desktop ? 'Simplify or split the model before importing.' : 'Simplify or split the model, or use the desktop app.';
    throw overBudget(`"${filename}" has ${about}${estimate.triangles.toLocaleString('en-US')} triangles${scene}; this ${desktop ? 'desktop' : 'web'} build handles up to ${limit.toLocaleString('en-US')}. ${next}`);
  }
  return projected > budget ? 'warn' : 'ok';
}
