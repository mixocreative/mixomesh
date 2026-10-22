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
 * @property {boolean} publish        Marketplace publish available (Electron shell exposing `electronAPI.listbridge`; never web/opfs).
 * @property {number}  triangleBudget  Safe scene-wide triangle ceiling before imports/tab perf degrade (imports warn above it).
 * @property {number}  triangleLimit   Scene-wide triangle count above which imports are refused.
 */

// Triangle-budget tiering (watertight-repair-and-cost task 7; numbers MEASURED in
// docs/superpowers/specs/2026-10-21-heavy-mesh-handling.md §2/§6).
// Imports warn above the budget and are refused above the limit (ImportLimits),
// before parsing when the format allows a count. With worker import + welded geometry a
// tab peaks at ~1.8 GB renderer + ~1.1 GB GPU process for 10M triangles (≈ 4x the
// web budget) and ~0.6 GB at the 2.5M warning line. Desktop keeps 6M / 24M: the
// renderer heap is raised to 4 GiB (electron/HeapFlags.cjs), the extrapolated 24M
// peak is ~4 GB renderer + ~2.2 GB GPU, and the 1 GB file cap stops binary STL at
// ~21M anyway. This is a runtime-tier constant, not a shell-reported capability,
// so it is keyed off `desktop` directly rather than trusted verbatim from
// `desktopCaps` (Electron never injects it). Change it only together with the
// spec's measured table.
export const WEB_TRIANGLE_BUDGET = 2_500_000;
export const WEB_TRIANGLE_LIMIT = 10_000_000;
export const DESKTOP_TRIANGLE_BUDGET = 6_000_000;
export const DESKTOP_TRIANGLE_LIMIT = 24_000_000;
// WebKit (Safari, every iOS / iPadOS browser) is UNMEASURED, a
// conservative guess (owner 2026-10-22, cia E-03); raise after a real-device test.
export const WEBKIT_TRIANGLE_BUDGET = 1_000_000;
export const WEBKIT_TRIANGLE_LIMIT = 3_000_000;
const TRIANGLE_TIERS = {
  desktop: { triangleBudget: DESKTOP_TRIANGLE_BUDGET, triangleLimit: DESKTOP_TRIANGLE_LIMIT },
  web: { triangleBudget: WEB_TRIANGLE_BUDGET, triangleLimit: WEB_TRIANGLE_LIMIT },
  webkit: { triangleBudget: WEBKIT_TRIANGLE_BUDGET, triangleLimit: WEBKIT_TRIANGLE_LIMIT },
};
/** Boolean ceiling when Booleans run in the Manifold worker (BooleanService
 *  keeps DEFAULT_BOOLEAN_TRIANGLE_CAP for the inline main-thread fallback). */
export const WEB_BOOLEAN_TRIANGLE_CAP = 250_000;
export const DESKTOP_BOOLEAN_TRIANGLE_CAP = 1_000_000;

/**
 * @typedef {'chromium'|'webkit'|'gecko'|'other'} Engine
 * @typedef {{hasFSA?:boolean, hasIDB?:boolean, hasOPFS?:boolean, hasListbridge?:boolean, desktop?:boolean, desktopCaps?:Partial<Capabilities>, engine?:Engine}} StorageEnv
 * @typedef {'desktop'|'browser'|'opfs'} StorageTier
 */

/** Browsers the boot gate names to the user (AGENTS rule 5). */
export const SUPPORTED_BROWSERS_TEXT =
  'Chrome or Edge on desktop (full app), or Safari on iPad, iPhone and Mac.';

/**
 * Rendering engine from the user agent (task 8.1). Pure.
 * - Electron shell (`env.desktop` or an `Electron/` token) -> chromium.
 * - ANY iOS / iPadOS browser is WebKit (Apple mandates it), whatever its brand
 *   token: CriOS (Chrome), FxiOS (Firefox), EdgiOS (Edge) all -> webkit.
 *   iPadOS 13+ reports a "Macintosh" desktop UA; `maxTouchPoints > 1`
 *   (a real Mac has 0) tells it apart.
 * - Firefox desktop / Android (`Firefox/`) -> gecko.
 * - `Chrome/`, `Chromium/`, `Edg/`, `OPR/` -> chromium.
 * - `Safari/` + `Version/` with no Chromium token (macOS Safari) -> webkit.
 * - anything else -> other.
 * @param {string} [ua]
 * @param {{maxTouchPoints?:number, desktop?:boolean}} [env]
 * @returns {Engine}
 */
export function detectEngine(ua = '', env = {}) {
  const u = String(ua || '');
  if (env.desktop || /\bElectron\//.test(u)) return 'chromium';
  if (/\b(iPhone|iPad|iPod)\b/.test(u)) return 'webkit';
  if (/\bMacintosh\b/.test(u) && (env.maxTouchPoints ?? 0) > 1) return 'webkit';
  if (/\bFirefox\//.test(u)) return 'gecko';
  // No leading \b: `HeadlessChrome/` (automation / browser smokes) must match too.
  if (/(Chrome|Chromium|Edg|OPR)\/\d/.test(u)) return 'chromium';
  if (/\bSafari\//.test(u) && /\bVersion\//.test(u)) return 'webkit';
  return 'other';
}

/**
 * Boot-gate decision on engine (task 8.1): null = allowed, else the blocking
 * screen's title + message. gecko / other are blocked regardless of tier.
 * @param {Engine} engine
 * @returns {{title:string, message:string}|null}
 */
export function engineGate(engine) {
  if (engine === 'chromium' || engine === 'webkit') return null;
  return {
    title: 'Browser not supported',
    message: `MIXOMESH needs a supported browser: ${SUPPORTED_BROWSERS_TEXT} `
      + (engine === 'gecko' ? 'Firefox is not supported.' : 'This browser is not supported.'),
  };
}

/**
 * Which StorageAdapter impl this runtime gets (task 8.2). Pure, like
 * `detectCapabilities`:
 * - `desktop` — Electron shell (`window.electronAPI`).
 * - `browser` — File System Access pickers present (Chrome / Edge desktop).
 * - `opfs`    — no FSA pickers but Origin Private File System
 *   (`navigator.storage.getDirectory`) exists: Safari / every iOS + iPadOS
 *   browser (all WebKit). NOTE Firefox also lands here (OPFS, no FSA); the
 *   boot gate (task 8.1), not this function, decides which engines may boot.
 * - neither → `browser`, whose `ready()` blocks with "Browser not supported".
 * @param {StorageEnv} [env]
 * @returns {StorageTier}
 */
export function detectStorageTier(env = {}) {
  if (env.desktop) return 'desktop';
  // Blocked engines (task 8.1) never pick OPFS; the boot gate also stops them.
  if (env.engine === 'gecko' || env.engine === 'other') return 'browser';
  if (env.hasFSA) return 'browser';
  if (env.hasOPFS) return 'opfs';
  return 'browser';
}

/**
 * Pure capability derivation from an environment snapshot.
 * @param {StorageEnv} [env]
 * @returns {Capabilities}
 */
export function detectCapabilities(env = {}) {
  const { hasFSA, hasIDB, desktop, desktopCaps } = env;
  const publish = !!desktop && !!env.hasListbridge;
  const { triangleBudget, triangleLimit } = TRIANGLE_TIERS[desktop ? 'desktop' : env.engine === 'webkit' ? 'webkit' : 'web'];
  const booleanTriangleCap = desktop ? DESKTOP_BOOLEAN_TRIANGLE_CAP : WEB_BOOLEAN_TRIANGLE_CAP;
  if (desktop && desktopCaps) {
    // Trust the desktop shell's declared capabilities (Node fs backed).
    return {
      persistAssets: !!desktopCaps.persistAssets,
      mountDirectory: !!desktopCaps.mountDirectory,
      relinkByPath: !!desktopCaps.relinkByPath,
      watchFiles: !!desktopCaps.watchFiles,
      writeFiles: !!desktopCaps.writeFiles,
      publish,
      triangleBudget,
      triangleLimit,
      booleanTriangleCap,
    };
  }
  if (detectStorageTier(env) === 'opfs') {
    // OPFS tier (task 8.2): projects are written into the origin-private file
    // system (no picker, but in-place saves work); no live folder links at all.
    return {
      persistAssets: !!hasIDB,
      mountDirectory: false,
      relinkByPath: false,
      watchFiles: false,
      writeFiles: true,
      publish,
      triangleBudget,
      triangleLimit,
      booleanTriangleCap,
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
    publish,
    triangleBudget,
    triangleLimit,
    booleanTriangleCap,
  };
}

function _snapshotEnv() {
  const w = typeof window !== 'undefined' ? window : undefined;
  return {
    hasFSA: !!w && 'showOpenFilePicker' in w,
    hasIDB: typeof indexedDB !== 'undefined',
    hasOPFS: typeof globalThis.navigator?.storage?.getDirectory === 'function',
    desktop: !!w && !!w.electronAPI,
    desktopCaps: w?.electronAPI?.capabilities,
    hasListbridge: !!w?.electronAPI?.listbridge,
    engine: detectEngine(globalThis.navigator?.userAgent, {
      maxTouchPoints: globalThis.navigator?.maxTouchPoints,
      desktop: !!w && !!w.electronAPI,
    }),
  };
}

const _env = _snapshotEnv();

/** Live capability singleton for the current runtime. Read `caps.writeFiles` etc. */
export const caps = detectCapabilities(_env);

/** Adapter tier picked for this runtime at load (`detectStorageTier`). */
export const storageTier = detectStorageTier(_env);

/** Rendering engine of this runtime (`detectEngine`). */
export const engine = /** @type {Engine} */ (_env.engine);

/** True when running inside the Electron desktop shell. */
export function isDesktop() {
  return typeof window !== 'undefined' && !!window.electronAPI;
}

/**
 * Whether a "use the desktop app" pointer helps this user: they are in a
 * browser on Windows, the only platform the desktop app ships for (Mac is
 * deferred, ADR 0001). Safari and every iOS browser never qualify (L2-12).
 * @param {string} [ua]
 */
export function desktopAppOffered(ua = globalThis.navigator?.userAgent ?? '') {
  return !isDesktop() && /\bWindows\b/.test(ua);
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

/**
 * Boot-gate failure (task 4.4): `storage.ready()` rejects with this when the
 * runtime's storage layer cannot initialise. The blocking boot screen shows
 * `t(textKey + '.title')` / `t(textKey + '.body')` when a key is given (the
 * storage layer stays free of i18n), else `title` + `message` verbatim.
 * @param {string} title
 * @param {string} message
 * @param {unknown} [cause]
 * @param {string} [textKey]  i18n key prefix with `.title` and `.body` entries
 * @returns {Error & {title:string, storageUnavailable:true, textKey?:string}}
 */
export function storageUnavailable(title, message, cause, textKey) {
  const err = /** @type {Error & {title:string, storageUnavailable:true}} */ (
    new Error(message, cause === undefined ? undefined : { cause })
  );
  err.name = 'StorageUnavailableError';
  err.title = title;
  err.storageUnavailable = true;
  if (textKey) err.textKey = textKey;
  return err;
}
