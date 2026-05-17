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
    overlays: { grid: true, axes: true, wireframe: false, printPreview: false, bedPreview: false },
    // The scene floor footprint equals the printer bed XY (print.bedDimensions).
    // `grid` only styles the lines drawn on it: cellMM = minor cell size in mm,
    // subdivisions = how many minor cells between major lines.
    grid: { cellMM: 10, subdivisions: 10 },
    cursor3d: { x: 0, y: 0, z: 0 },
  },
  selection: { selectedIds: [], activeId: null, pivotMode: 'active' },
  print: {
    workingRatio: 1, targetRatio: 1,
    bedPreset: 'Elegoo Saturn 4 Ultra', bedDimensions: { x: 218.88, y: 122.88, z: 220 },
    minWallThickness: 1.2, printMode: 'fdm', chordTolerance: 0.05,
  },
  ui: { activePanel: 'properties', outlinerCollapsed: {}, assetPanelHeight: 220, scaleLocked: true },
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
export function getState() {
  if (DEV) return _deepFreeze(JSON.parse(JSON.stringify(_state)));
  return _state;
}

/**
 * Update state via an updater function.
 * @param {function} updaterFn  Receives current state, must return new state.
 * @param {{ silent?: boolean }} [opts]  Pass silent:true to suppress PROJECT_DIRTY.
 */
export function setState(updaterFn, opts = {}) {
  _state = updaterFn(_state);
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
}

/** A deep clone of the pristine initial state (for New Project). */
export function freshState() {
  return JSON.parse(JSON.stringify(INITIAL_STATE));
}

export const StateManager = {
  subscribe, dispatch, getState, setState, withoutDirty, markDirty,
  replaceState, freshState,
};
