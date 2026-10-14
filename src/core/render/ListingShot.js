// Listing-shot helpers (marketplace hero image, PB.2) — pure, no Babylon.

/** Square output limits (px). */
export const LISTING_MIN = 64;
export const LISTING_MAX = 4096;
export const LISTING_DEFAULT = 1600;

/**
 * Normalise captureListingShot options.
 * @param {{ size?: number, background?: string }} [opts]
 * @returns {{ size: number, transparent: boolean }}
 */
export function normalizeListingOptions({ size = LISTING_DEFAULT, background = 'studio' } = {}) {
  if (background !== 'studio' && background !== 'transparent') {
    throw new Error(`Listing shot background must be 'studio' or 'transparent', got '${background}'`);
  }
  const n = Math.round(Number(size));
  const clamped = Number.isFinite(n) ? Math.min(LISTING_MAX, Math.max(LISTING_MIN, n)) : LISTING_DEFAULT;
  return { size: clamped, transparent: background === 'transparent' };
}

/**
 * Run `fn` with every layer suppressed; ALWAYS restore (reverse order), even
 * when `fn` or a later layer's suppress throws, and even if a restore throws
 * (the rest still run; the first restore error surfaces if fn succeeded).
 * @template T
 * @param {Array<() => (() => void)>} suppressors each returns its restore fn
 * @param {() => Promise<T>|T} fn
 * @returns {Promise<T>}
 */
export async function withSuppressed(suppressors, fn) {
  const restores = [];
  let restoreError = null;
  try {
    for (const suppress of suppressors) restores.push(suppress());
    return await fn();
  } finally {
    for (let i = restores.length - 1; i >= 0; i--) {
      try { restores[i](); } catch (e) { restoreError ??= e; }
    }
    if (restoreError) throw restoreError;
  }
}
