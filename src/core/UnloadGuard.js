// Pure decision for the dirty-project `beforeunload` guard (task 0.4).
// Electron now guards too: its main process turns the prompt into a native
// confirm via `will-prevent-unload`. The smoke bypass never applies to a
// production build.

/**
 * @param {{ isElectron?: boolean, dirty?: boolean, smoke?: boolean, isProd?: boolean }} ctx
 * @returns {boolean} true when `beforeunload` should be cancelled to warn the user
 */
export function shouldGuardUnload({ dirty = false, smoke = false, isProd = false } = {}) {
  if (!dirty) return false;
  if (smoke && !isProd) return false;
  return true;
}
