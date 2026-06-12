import { EVENTS } from './events.js';

const DEV = location.hostname === 'localhost' || location.hostname === '127.0.0.1';

const INITIAL_STATE = {
  project: { name: 'Untitled', isDirty: false, lastSavedAt: null, version: '3.1' },
  scene: {
    objects: {},
    groups: {},
    collections: {},
    assetLibrary: {},
    shaders: {},
    uvOverrides: {},
    // Derived validation-result cache (arch A6): Record<meshId, { results,
    // validatedAt, stale }>. Written by MeshValidator, NEVER persisted —
    // recomputed per session. UI (PrintPanel tab, Outliner icons, export
    // confirm) reads this instead of re-running topology checks.
    validation: {},
    userSwatches: [],
    camera: {
      // Front-3/4 elevated default. Babylon ArcRotateCamera positions camera at
      //   target + R·(sinβ cosα, cosβ, sinβ sinα).
      // β = π/4 (45° downward); α = π/3 puts camera in the front-right quadrant
      // (+X, +Z). radius 0.4243 ≈ 0.3 / cos(π/4) → camera.y ≈ 30 cm above origin.
      preset: 'perspective', alpha: Math.PI / 3, beta: Math.PI / 4, radius: 0.4243,
      target: { x: 0, y: 0, z: 0 }, isOrthographic: false,
      followMode: 'free',          // 'free' | 'followActive' | 'worldOrigin'
    },
    overlays: { grid: true, axes: true, wireframe: false, printPreview: true, bedPreview: false },
    // The scene floor footprint equals the printer bed XY (print.bedDimensions).
    // `grid` only styles the lines drawn on it: cellMM = minor cell size in mm,
    // subdivisions = how many minor cells between major lines.
    grid: { cellMM: 10, subdivisions: 10 },
    cursor3d: { x: 0, y: 0, z: 0 },
  },
  selection: { selectedIds: [], activeId: null, pivotMode: 'active' },
  print: {
    workingRatio: 1, targetRatio: 1,
    targetPrinterId: 'mimaki-3duj-553',
    bedDimensions: { x: 508, y: 508, z: 305 },
    minWallThickness: 1.2, printMode: 'fdm', chordTolerance: 0.05,
    objBakeSolidTextures: true,
  },
  ui: {
    activePanel: 'properties', outlinerCollapsed: {}, assetPanelHeight: 220, scaleLocked: true,
    // Workspaces (PART 13b) — per-user preference, seeded from localStorage,
    // NEVER persisted in .mixo. Manual N/T/\ toggles layer on top of the
    // active workspace's defaults; switching workspace resets them.
    // Tri-state per side: true = force-hide, false = force-show, ABSENT =
    // defer to the workspace default. Must start EMPTY — a concrete `false`
    // is a force-show override that would defeat every workspace default
    // (the Layout↔Shade "no visible difference" bug).
    workspace: 'layout',                                   // 'layout' | 'shade' | 'print'
    panelCollapsed: {},
  },
  gizmo: { mode: 'translate', space: 'world', snap: { translate: 1.0, rotate: 15, scale: 0.1 } },
};

let _state = JSON.parse(JSON.stringify(INITIAL_STATE));
const _listeners = new Map();
let _suppressDirty = false;

function _deepFreeze(obj) {
  if (obj === null || typeof obj !== 'object') return obj;
  Object.getOwnPropertyNames(obj).forEach(k => _deepFreeze(obj[k]));
  return Object.freeze(obj);
}

/**
 * Subscribe to a named event.
 * @param {string} eventName
 * @param {function} fn
 * @returns {function} unsubscribe
 */
export function subscribe(eventName, fn) {
  if (typeof eventName !== 'string' || !eventName) {
    // A typo'd EVENTS key is undefined — the listener would silently never
    // fire (review A8). Fail loudly in dev; tolerate in prod.
    if (DEV) throw new Error('subscribe: unknown event (typo in EVENTS key?)');
    return () => {};
  }
  if (!_listeners.has(eventName)) _listeners.set(eventName, new Set());
  _listeners.get(eventName).add(fn);
  return () => _listeners.get(eventName)?.delete(fn);
}

/**
 * Dispatch a named event to all subscribers synchronously.
 * @param {string} eventName
 * @param {*} [payload]
 */
export function dispatch(eventName, payload) {
  const fns = _listeners.get(eventName);
  if (!fns) return;
  for (const fn of fns) {
    try { fn(payload); } catch (err) { console.error(err); }
  }
}

/**
 * Return current application state. Deep-frozen in dev mode.
 * @returns {object}
 */
let _devFrozenCache = null;   // invalidated on every state write (dev only)

export function getState() {
  if (DEV) {
    // Cache the frozen snapshot between writes — getState runs in hot paths
    // (selection loops, per-frame hooks) and a deep clone per call made dev
    // mode crawl (review L22).
    if (!_devFrozenCache) _devFrozenCache = _deepFreeze(JSON.parse(JSON.stringify(_state)));
    return _devFrozenCache;
  }
  return _state;
}

/**
 * Update state via an updater function.
 * @param {function} updaterFn  Receives current state, must return new state.
 * @param {{ silent?: boolean }} [opts]  Pass silent:true to suppress PROJECT_DIRTY.
 */
export function setState(updaterFn, opts = {}) {
  _state = updaterFn(_state);
  _devFrozenCache = null;
  if (!opts.silent && !_suppressDirty) {
    dispatch(EVENTS.PROJECT_DIRTY, null);
  }
}

/**
 * Run fn() with PROJECT_DIRTY dispatch suppressed (for load/undo operations).
 * @param {function} fn
 */
export function withoutDirty(fn) {
  _suppressDirty = true;
  try { fn(); } finally { _suppressDirty = false; }
}

/**
 * Mark the project dirty without mutating state. Use from commands that
 * change Babylon objects directly (e.g. transforms) rather than state.
 * Respects the suppression flag set by withoutDirty().
 */
export function markDirty() {
  if (_suppressDirty) return;
  dispatch(EVENTS.PROJECT_DIRTY, null);
}

/**
 * Replace the entire state tree (project new / load). Silent against
 * PROJECT_DIRTY — the caller owns dirty/saved signalling.
 * @param {object} next  full state object (used verbatim, not cloned)
 */
export function replaceState(next) {
  _state = next;
  _devFrozenCache = null;
}

/** A deep clone of the pristine initial state (for New Project). */
export function freshState() {
  return JSON.parse(JSON.stringify(INITIAL_STATE));
}

export const StateManager = {
  subscribe, dispatch, getState, setState, withoutDirty, markDirty,
  replaceState, freshState,
};
