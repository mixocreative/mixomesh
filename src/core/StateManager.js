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
    // Viewport render look (Scene panel). Defaults mirror scene/SceneConstants
    // (tone/shadow/light values) — applied via SceneManager.applyRenderSettings
    // on boot/load/new. fovDeg 45.8° = Babylon's 0.8 rad default; clipNearMM 1
    // = the 1 mm near plane CameraRig boots with.
    render: {
      exposure: 1.05, contrast: 1.10,
      shadowsEnabled: true, shadowDarkness: 0.62,
      background: 'light',
      keyIntensity: 0.70, fillIntensity: 0.25, hemiIntensity: 0.85,
      fovDeg: 45.8, clipNearMM: 1,
      // Grade: tone-map curve + colour controls (Babylon imageProcessing).
      // saturation is colorCurves.globalSaturation (-100..100, 0 = neutral).
      toneMapping: 'aces',        // 'aces' | 'standard' | 'neutral' | 'off'
      saturation: 0,
      vignette: false, vignetteWeight: 1.5,
      // Environment floor — solid-colour shadow-catcher plane (Scene ▸
      // Environment). zMM = height in print-space Z (Babylon Y), mm.
      // floorDiameterMM: round disc diameter; 0 = auto (4× largest bed dim).
      floorEnabled: false, floorColor: '#9a9a9a', floorZMM: 0, floorDiameterMM: 0,
      // HDRI image-based lighting (prefiltered .env files in public/env/).
      // Lighting only — the gradient backdrop stays; affects PBR materials
      // (imported glTF/OBJ). Intensity = scene.environmentIntensity.
      hdriEnabled: true, hdriPreset: 'studio', hdriIntensity: 0.6,
      // SSAO contact darkening (scene/ViewEffects.js) — viewport-only post
      // effect (the RTT export paths skip the camera post chain by design).
      // DEFAULT OFF: SSAO2 runs a geometry prePass that re-renders all scene
      // geometry every frame; on a heavy import (80k+ tris) that caused
      // ~250-330 ms frame stalls that read as a frozen import (and could
      // wedge a TDR-prone GPU/driver). Opt-in for capable machines.
      ssaoEnabled: false, ssaoStrength: 1,
      // Viewport texture cap (assets/TextureCap.js) — downsamples the GPU copy
      // of textures for VRAM relief on heavy 4096²+ scenes. 0 = OFF (full res,
      // default). Export is UNAFFECTED: it reads the full-res source frozen at
      // import (assets/TextureSource.js), so capping never degrades Mimaki
      // output. Persisted with the render look.
      textureCapPx: 0,
    },
    // Cross-section inspection plane (scene/ViewEffects.js). SESSION-ONLY —
    // deliberately not persisted (it's an inspection tool, not a scene look).
    // axis/offset are print-space (Z = up, mm); flip keeps the other side.
    section: { enabled: false, axis: 'z', offsetMM: 0, flip: false },
    // Render output (Scene ▸ Rendering): PNG stills + turntable video.
    // pose = saved render-camera composition (null until the user sets one);
    // the render-view toggle swaps the live camera to/from it.
    renderOut: {
      width: 1920, height: 1080, transparent: false,
      pose: null,   // { alpha, beta, radius, target, isOrthographic } | null
      turntable: { durationS: 8, fps: 30, direction: 'left', ease: true },
    },
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
