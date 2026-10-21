// BusyRegistry: the user's own work in flight (save, export, repair, boolean,
// the unsaved-changes dialog, File > Open / New / Recent). Launch batches and
// automation requests wait while it is non-empty, so they never land under
// work the user started (cia A-04, A-08, F-06).

const _active = new Map();   // kind -> count

/**
 * Mark one unit of `kind` in flight.
 * @param {string} kind
 * @returns {() => void} ends it; calling it again is a no-op
 */
export function beginBusy(kind) {
  _active.set(kind, (_active.get(kind) ?? 0) + 1);
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    const n = _active.get(kind) - 1;
    if (n > 0) _active.set(kind, n); else _active.delete(kind);
  };
}

/**
 * Run `fn` with `kind` marked in flight until it settles.
 * @template T @param {string} kind @param {() => Promise<T>|T} fn @returns {Promise<T>}
 */
export async function whileBusy(kind, fn) {
  const end = beginBusy(kind);
  try { return await fn(); } finally { end(); }
}

/** @returns {boolean} true while any of the user's own work is in flight. */
export function isBusy() {
  return _active.size > 0;
}
