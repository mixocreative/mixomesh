// Per-user PANEL settings — persisted to localStorage so a fresh boot / New
// project starts with the user's last-used setup. Content (objects, shaders,
// UV, selection, live camera pose, cross-section, cursor) is NEVER persisted
// here; that lives in the .mixo file. See docs/superpowers/specs/
// 2026-06-14-settings-persistence-design.md.
//
// Precedence: FILE WINS. seedBootState only seeds the empty boot / New scene;
// opening a .mixo restores exactly what the file holds (PersistenceManager
// applies those directly, never through this store).
//
// Factory defaults live in the editable config/default-settings.json — the
// single source of truth for boot, New, and every reset button.

import DS from '../config/default-settings.json' with { type: 'json' };
import { getState, setState, dispatch, subscribe } from './StateManager.js';
import { SceneManager } from './SceneManager.js';
import { Selection } from './Selection.js';
import { EVENTS } from './events.js';

const SILENT = { silent: true };
const STORAGE_KEY = 'mx-settings-v1';
const VERSION = 1;
const SAVE_DEBOUNCE_MS = 300;

/** The editable factory defaults (config file, verbatim). */
export const DEFAULTS = DS;

// ── Schema ───────────────────────────────────────────────
// Each entry: which state path is a persisted settings slice, and (optionally)
// the field allow-list that narrows it. `fields: null` = the whole object is
// settings; `scalar: true` = a leaf value. Anything not listed here is content
// and is never written or read back.
const SCHEMA = [
  { key: 'render',    path: ['scene', 'render'],    fields: null },
  { key: 'renderOut', path: ['scene', 'renderOut'], fields: ['width', 'height', 'transparent', 'turntable'] },
  { key: 'grid',      path: ['scene', 'grid'],      fields: null },
  { key: 'overlays',  path: ['scene', 'overlays'],  fields: ['grid', 'axes', 'printPreview'] },
  { key: 'print',     path: ['print'],              fields: null },
  { key: 'gizmo',     path: ['gizmo'],              fields: ['space', 'snap'] },
  { key: 'pivotMode', path: ['selection', 'pivotMode'], scalar: true },
];
const SCHEMA_BY_KEY = Object.fromEntries(SCHEMA.map(e => [e.key, e]));

// Section keys (per-section reset buttons) → the factory field groups they
// restore. A section may touch sub-groups of one slice (env vs camera both
// live in `render`) or span slices (grid styling + grid/axes overlays).
const RENDER_CAMERA_FIELDS = ['fovDeg', 'clipNearMM'];
const RENDER_ENV_FIELDS = Object.keys(DS.render).filter(k => !RENDER_CAMERA_FIELDS.includes(k));
const SECTIONS = {
  grid:        [{ slice: 'grid' }, { slice: 'overlays', fields: ['grid', 'axes'] }],
  environment: [{ slice: 'render', fields: RENDER_ENV_FIELDS }],
  camera:      [{ slice: 'render', fields: RENDER_CAMERA_FIELDS }],
  rendering:   [{ slice: 'renderOut' }],
  print:       [{ slice: 'print' }],
};
/** Section keys with a reset button (for callers / docs). */
export const SECTION_KEYS = Object.keys(SECTIONS);

// ── Path helpers ─────────────────────────────────────────

function _get(obj, path) {
  return path.reduce((o, k) => (o == null ? o : o[k]), obj);
}
function _clone(v) { return JSON.parse(JSON.stringify(v)); }

// Immutably write `value` at `path` in `state`, cloning the spine.
function _setPath(state, path, value) {
  if (!path.length) return value;
  const [head, ...rest] = path;
  return { ...state, [head]: _setPath(state?.[head] ?? {}, rest, value) };
}

// Keep only `fields` of an object (or the whole clone when fields is null).
function _narrow(obj, fields) {
  if (!obj || typeof obj !== 'object') return obj;
  if (!fields) return _clone(obj);
  const out = {};
  for (const f of fields) if (f in obj) out[f] = _clone(obj[f]);
  return out;
}

// Fields that must NOT be reset while a scene is loaded because they are tied to
// live geometry. Empty since the per-object ratio redesign (2026-06-16): scale
// is now per-object (`state.scene.objects[id].ratio`), which is content — never
// a persisted setting — so a settings reset can't touch it. The mechanism is
// kept for any future geometry-tied setting.
const SCENE_PROTECTED = {};
function _sceneLoaded(state) {
  return Object.keys(state?.scene?.objects ?? {}).length > 0;
}
// Drop scene-protected fields from a factory partial when the scene is loaded,
// so the current (cur-spread) values survive the reset.
function _guardFactory(sliceKey, factory, state) {
  if (!_sceneLoaded(state)) return factory;
  const prot = SCENE_PROTECTED[sliceKey];
  if (!prot) return factory;
  const out = { ...factory };
  for (const f of prot) delete out[f];
  return out;
}

// ── Pure core (unit-tested) ──────────────────────────────

/** The persisted subset of a full state object: { key → value }. */
export function pickSettings(state) {
  const out = {};
  for (const e of SCHEMA) {
    const val = _get(state, e.path);
    if (val === undefined) continue;
    out[e.key] = e.scalar ? val : _narrow(val, e.fields);
  }
  return out;
}

/**
 * Deep-merge a persisted `settings` blob over a base state, accepting only
 * SCHEMA-known keys + fields (a corrupt / old blob can never inject unknown
 * paths). Returns a new state; `base` is not mutated.
 */
export function mergeSettings(base, settings) {
  if (!settings || typeof settings !== 'object') return base;
  let out = base;
  for (const e of SCHEMA) {
    if (!(e.key in settings)) continue;
    const incoming = settings[e.key];
    if (e.scalar) {
      out = _setPath(out, e.path, incoming);
    } else {
      // Whole-object slices still narrow to the config's known keys so a
      // corrupt / stale blob can't inject unknown fields.
      const allowed = e.fields ?? Object.keys(DS[e.key] ?? {});
      const cur = _get(out, e.path) ?? {};
      out = _setPath(out, e.path, { ..._clone(cur), ..._narrow(incoming, allowed) });
    }
  }
  return out;
}

/** Parse a stored blob → { v, settings } or null on junk / missing settings. */
export function parseStored(raw) {
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object' || typeof obj.settings !== 'object' || !obj.settings) return null;
    return { v: obj.v, settings: obj.settings };
  } catch {
    return null;
  }
}

/** Restore one section's factory fields (from the config file) into a state. */
export function applySectionToState(state, sectionKey) {
  const parts = SECTIONS[sectionKey];
  if (!parts) return state;
  let out = state;
  for (const part of parts) {
    const entry = SCHEMA_BY_KEY[part.slice];
    if (!entry) continue;
    if (entry.scalar) {
      out = _setPath(out, entry.path, _clone(DS[part.slice]));
      continue;
    }
    const cur = _get(out, entry.path) ?? {};
    const factory = _guardFactory(part.slice, _narrow(DS[part.slice], part.fields ?? entry.fields), out);
    out = _setPath(out, entry.path, { ..._clone(cur), ...factory });
  }
  return out;
}

/** Reset EVERY persisted slice to factory; content (objects/shaders) untouched. */
export function factoryState(state) {
  let out = state;
  for (const e of SCHEMA) {
    if (e.scalar) { out = _setPath(out, e.path, _clone(DS[e.key])); continue; }
    const cur = _get(out, e.path) ?? {};
    const factory = _guardFactory(e.key, _narrow(DS[e.key], e.fields), out);
    out = _setPath(out, e.path, { ..._clone(cur), ...factory });
  }
  return out;
}

// ── localStorage I/O ─────────────────────────────────────

/** @returns {object} the persisted settings blob (or {} when none / unavailable). */
export function load() {
  if (typeof localStorage === 'undefined') return {};
  return parseStored(localStorage.getItem(STORAGE_KEY))?.settings ?? {};
}

/** Write the current settings to localStorage immediately. */
export function save() {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ v: VERSION, settings: pickSettings(getState()) }));
  } catch { /* private mode / quota — non-fatal */ }
}

let _saveTimer = null;
/** Debounced save — call on any user-driven settings edit. */
export function scheduleSave() {
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(save, SAVE_DEBOUNCE_MS);
}

function _clearStored() {
  if (typeof localStorage === 'undefined') return;
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* */ }
}

// ── Boot + apply ─────────────────────────────────────────

/** Merge persisted per-user settings onto the current (factory) state. No scene apply. */
export function seedBootState() {
  setState(s => mergeSettings(s, load()), SILENT);
}

/** Push the live settings slices to the engine. Reused on boot, New, and reset. */
export function applyToScene() {
  const s = getState();
  SceneManager.applyRenderSettings?.(s.scene.render ?? {});
  SceneManager.setGrid?.(s.scene.grid);
  SceneManager.rebuildBed?.();
  // Apply the full overlay set from state: persisted display prefs
  // (grid/axes/printPreview) plus the session inspection modes, which sit at
  // factory-false here — so a New/reset correctly clears any active wireframe
  // / base-colour / cross-section view. (wireframeEdgeColor is a value, not a
  // toggle.)
  for (const [k, v] of Object.entries(s.scene.overlays || {})) {
    if (k === 'wireframeEdgeColor') continue;
    SceneManager.setOverlay?.(k, !!v);
  }
  SceneManager.setGizmoSpace?.(s.gizmo?.space);
  Selection.setPivotMode?.(s.selection?.pivotMode);
}

// ── Reset ────────────────────────────────────────────────

/** Reset one section to factory, re-apply to the scene, persist, notify panels. */
export function resetSection(sectionKey) {
  if (!SECTIONS[sectionKey]) return;
  setState(s => applySectionToState(s, sectionKey), SILENT);
  applyToScene();
  scheduleSave();
  dispatch(EVENTS.SETTINGS_RESET, { section: sectionKey });
}

/** Reset all persisted settings to factory, clear storage, re-apply, notify. */
export function resetAll() {
  setState(factoryState, SILENT);
  _clearStored();
  applyToScene();
  dispatch(EVENTS.SETTINGS_RESET, { section: null });
}

// ── Init (autosave triggers) ─────────────────────────────

/**
 * Wire user-edit → debounced save. A capturing listener on the stable Scene /
 * Print panel containers fires on any control change; gizmo + pivot have their
 * own events. Programmatic applies (boot/load) bypass these, so File-wins holds.
 */
export function init() {
  subscribe(EVENTS.GIZMO_CHANGED, scheduleSave);
  subscribe(EVENTS.PIVOT_MODE_CHANGED, scheduleSave);
  if (typeof document === 'undefined') return;
  for (const id of ['rp-scene-body', 'rp-print-body']) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.addEventListener('change', scheduleSave, true);
    el.addEventListener('input', scheduleSave, true);
  }
}

export const SettingsStore = {
  DEFAULTS, SECTION_KEYS,
  pickSettings, mergeSettings, parseStored, applySectionToState, factoryState,
  load, save, scheduleSave, seedBootState, applyToScene,
  resetSection, resetAll, init,
};
