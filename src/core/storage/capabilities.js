// Runtime capability model for the Web / Windows-Electron split (ADR 0001).
//
// A single `caps` object describes what the current runtime's storage layer can
// do. UI + logic branch on these FLAGS — never on ad-hoc "is Electron" checks —
// so a control with no supporting capability is hidden (not shown-and-broken).
//
// - Web build: capabilities are feature-detected (File System Access + IndexedDB).
// - Electron build: the shell injects `window.electronAPI.capabilities` (all true,
//   backed by Node fs) which is trusted verbatim.
//
// `detectCapabilities` is a PURE function of an environment snapshot so it can be
// unit-tested without a real window; `caps` is the live singleton built from the
// real environment at module load. `setCapabilities` is the override hook used by
// the Electron boot path and by tests.

/**
 * @typedef {Object} Capabilities
 * @property {boolean} persistAssets   Can store/restore asset+project references across sessions.
 * @property {boolean} mountDirectory  Can mount a folder as a live asset source.
 * @property {boolean} relinkByPath    Can relink a missing asset to a user-picked file.
 * @property {boolean} watchFiles      Can watch mounted files for external changes (desktop only).
 * @property {boolean} writeFiles      Can write to a chosen location via a picker (else blob-download).
 * @property {number}  triangleBudget  Safe scene-wide triangle ceiling before imports/tab perf degrade.
 */

// Triangle-budget tiering (watertight-repair-and-cost task 7). Desktop's Node-fs
// backed shell can push more triangles through a session than a browser tab
// before layout/GC pressure makes imports crawl or the tab crashes — same
// reasoning as DEFAULT_BOOLEAN_TRIANGLE_CAP's desktop-raises-the-cap note and
// the existing 100k auto-validate skip. This is a runtime-tier constant, not a
// shell-reported capability, so it is keyed off `desktop` directly rather than
// trusted verbatim from `desktopCaps` (Electron never injects it).
export const WEB_TRIANGLE_BUDGET = 1_500_000;
export const DESKTOP_TRIANGLE_BUDGET = 6_000_000;

/**
 * Pure capability derivation from an environment snapshot.
 * @param {{hasFSA?:boolean, hasIDB?:boolean, desktop?:boolean, desktopCaps?:Partial<Capabilities>}} [env]
 * @returns {Capabilities}
 */
export function detectCapabilities(env = {}) {
  const { hasFSA, hasIDB, desktop, desktopCaps } = env;
  const triangleBudget = desktop ? DESKTOP_TRIANGLE_BUDGET : WEB_TRIANGLE_BUDGET;
  if (desktop && desktopCaps) {
    // Trust the desktop shell's declared capabilities (Node fs backed).
    return {
      persistAssets: !!desktopCaps.persistAssets,
      mountDirectory: !!desktopCaps.mountDirectory,
      relinkByPath: !!desktopCaps.relinkByPath,
      watchFiles: !!desktopCaps.watchFiles,
      writeFiles: !!desktopCaps.writeFiles,
      triangleBudget,
    };
  }
  // Web build — feature-detect. FSA gates the pickers/mount/relink/write; IDB gates
  // cross-session persistence. Watching is desktop-only.
  return {
    persistAssets: !!hasIDB,
    mountDirectory: !!hasFSA,
    relinkByPath: !!hasFSA,
    writeFiles: !!hasFSA,
    watchFiles: false,
    triangleBudget,
  };
}

function _snapshotEnv() {
  const w = typeof window !== 'undefined' ? window : undefined;
  return {
    hasFSA: !!w && 'showOpenFilePicker' in w,
    hasIDB: typeof indexedDB !== 'undefined',
    desktop: !!w && !!w.electronAPI,
    desktopCaps: w?.electronAPI?.capabilities,
  };
}

/** Live capability singleton for the current runtime. Read `caps.writeFiles` etc. */
export const caps = detectCapabilities(_snapshotEnv());

/** True when running inside the Electron desktop shell. */
export function isDesktop() {
  return typeof window !== 'undefined' && !!window.electronAPI;
}

/**
 * Override the live capabilities in place (Electron boot / tests). Mutates the
 * shared `caps` object so existing imports see the change.
 * @param {Partial<Capabilities>} overrides
 * @returns {Capabilities}
 */
export function setCapabilities(overrides) {
  Object.assign(caps, overrides);
  return caps;
}
