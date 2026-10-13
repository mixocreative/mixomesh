// Pure logic behind the responsive layout + the phone viewer (overhaul 8.3 /
// 8.6). No DOM, no Babylon: the layout decision, the top-level object list and
// the info-sheet text are plain functions so they unit-test headlessly.
// CSS mirrors the same breakpoints (src/styles/viewer.css, layout.css) — keep
// the numbers in step.

import { shouldDisplayObject } from './LogicalObjects.js';
import { formatScaleRatio, objectRatio } from './scale/ScaleMath.js';

/** Below this width the app is the read-only viewer (CSS: max-width 767px). */
export const VIEWER_MAX_WIDTH = 768;
/** Below this width Properties opens as a bottom sheet (iPad portrait). */
export const PORTRAIT_MAX_WIDTH = 1024;
/** Below this width the side panels are slide-over sheets. Desktop starts here. */
export const SHEET_MAX_WIDTH = 1280;

/**
 * Layout tier for a viewport width in CSS px.
 *  viewer   < 768        read-only phone viewer
 *  portrait 768–1023     full app, panels as sheets, Properties = bottom sheet
 *  narrow   1024–1279    full app, panels as side sheets
 *  full     >= 1280      desktop layout
 * @param {number} width
 * @returns {'viewer'|'portrait'|'narrow'|'full'}
 */
export function layoutModeForWidth(width) {
  const w = Number(width);
  if (!Number.isFinite(w)) return 'full';
  if (w < VIEWER_MAX_WIDTH) return 'viewer';
  if (w < PORTRAIT_MAX_WIDTH) return 'portrait';
  if (w < SHEET_MAX_WIDTH) return 'narrow';
  return 'full';
}

/** @param {number} width @returns {boolean} */
export function isViewerWidth(width) {
  return layoutModeForWidth(width) === 'viewer';
}

/**
 * Keyboard shortcuts that stay live in the viewer: camera / framing / select
 * only. Everything else (G/R/S, Delete, Ctrl+Z, Ctrl+S, paste, nudge...) is
 * blocked by InputManager while read-only.
 * @param {string} key  InputManager shortcut string, e.g. 'Numpad7', 'Alt+1'
 * @returns {boolean}
 */
export function isReadOnlyShortcut(key) {
  if (typeof key !== 'string' || !key) return false;
  return READONLY_KEYS.has(key) || /^(Ctrl\+)?(Alt\+)?Numpad[0-9]$/.test(key);
}
const READONLY_KEYS = new Set([
  'F', 'Home', 'A', 'Alt+A', '.',
  'Alt+1', 'Alt+3', 'Alt+7', 'Ctrl+Alt+1', 'Ctrl+Alt+3', 'Ctrl+Alt+7',
]);

/**
 * Top-level rows of the object list: top-level groups first, then top-level
 * displayable objects (material-split parts are folded into their lead) —
 * the same order the Outliner uses.
 * @param {{objects?:Record<string,any>, groups?:Record<string,any>}} scene
 * @returns {Array<{id:string, kind:'group'|'object', name:string, count:number}>}
 */
export function topLevelItems(scene) {
  const objects = scene?.objects ?? {};
  const groups = scene?.groups ?? {};
  const out = [];
  for (const g of Object.values(groups)) {
    if (!g || g.parentId) continue;
    const kids = (g.childIds ?? []).filter(id => shouldDisplayObject(objects[id])).length
      + Object.values(groups).filter(s => s?.parentId === g.id).length;
    out.push({ id: g.id, kind: 'group', name: g.name || g.id, count: kids });
  }
  for (const o of Object.values(objects)) {
    if (!shouldDisplayObject(o) || o.parentId) continue;
    out.push({ id: o.id, kind: 'object', name: o.name || o.id, count: 0 });
  }
  return out;
}

/**
 * Union of world-space boxes. Input and output in Babylon units.
 * @param {Array<{min:{x:number,y:number,z:number}, max:{x:number,y:number,z:number}}>} boxes
 * @returns {{x:number,y:number,z:number}|null} extents (Babylon axes), null when empty
 */
export function unionExtents(boxes) {
  let min = null, max = null;
  for (const b of boxes ?? []) {
    if (!b?.min || !b?.max) continue;
    // Copy x/y/z explicitly: Babylon vectors expose them as prototype accessors,
    // so a spread would drop them.
    if (!min) {
      min = { x: b.min.x, y: b.min.y, z: b.min.z };
      max = { x: b.max.x, y: b.max.y, z: b.max.z };
      continue;
    }
    for (const k of ['x', 'y', 'z']) {
      if (b.min[k] < min[k]) min[k] = b.min[k];
      if (b.max[k] > max[k]) max[k] = b.max[k];
    }
  }
  if (!min) return null;
  const ext = { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z };
  return [ext.x, ext.y, ext.z].every(Number.isFinite) ? ext : null;
}

/**
 * Print-space size text, W×D×H in mm (print X = Babylon X, depth = Z, height =
 * Y — the same mapping the status-bar HUD uses), one decimal.
 * @param {{x:number,y:number,z:number}|null} extentsBU  Babylon units
 * @param {number} buToMm  millimetres per Babylon unit
 * @returns {string} '' when there is no size
 */
export function formatSizeMM(extentsBU, buToMm) {
  if (!extentsBU || !Number.isFinite(buToMm)) return '';
  const f = (v) => (Math.abs(v * buToMm)).toFixed(1);
  return `${f(extentsBU.x)} × ${f(extentsBU.z)} × ${f(extentsBU.y)} mm`;
}

/**
 * Scale label for a selection: the objects' shared ratio ('1:72'), or null
 * when they mix. Objects are the SceneObject rows behind the selection.
 * @param {Array<object>} objs
 * @returns {string|null} null = mixed / none
 */
export function scaleLabelFor(objs) {
  const list = (objs ?? []).filter(Boolean);
  if (!list.length) return null;
  const first = objectRatio(list[0]);
  return list.every(o => Math.abs(objectRatio(o) - first) < 1e-9) ? formatScaleRatio(first) : null;
}

/**
 * Info-sheet content for one item (object or group).
 * @param {{objects?:Record<string,any>, groups?:Record<string,any>}} scene
 * @param {string} id
 * @param {{extentsBU?:{x:number,y:number,z:number}|null, buToMm:number}} measured
 * @returns {{id:string, kind:'group'|'object', name:string, size:string, scale:string|null, count:number}|null}
 */
export function describeItem(scene, id, measured) {
  const objects = scene?.objects ?? {};
  const groups = scene?.groups ?? {};
  const size = formatSizeMM(measured?.extentsBU ?? null, measured?.buToMm);
  if (groups[id]) {
    const members = collectGroupObjects(groups, objects, id);
    return {
      id, kind: 'group', name: groups[id].name || id, size,
      scale: scaleLabelFor(members), count: members.length,
    };
  }
  const o = objects[id];
  if (!o) return null;
  return { id, kind: 'object', name: o.name || id, size, scale: scaleLabelFor([o]), count: 0 };
}

/**
 * Every displayable object under a group, depth-first.
 * @returns {object[]}
 */
export function collectGroupObjects(groups, objects, groupId, seen = new Set()) {
  if (seen.has(groupId)) return [];
  seen.add(groupId);
  const out = [];
  for (const cid of groups[groupId]?.childIds ?? []) {
    if (shouldDisplayObject(objects[cid])) out.push(objects[cid]);
  }
  for (const g of Object.values(groups)) {
    if (g?.parentId === groupId) out.push(...collectGroupObjects(groups, objects, g.id, seen));
  }
  return out;
}

/** File extensions the viewer's "Open a file…" accepts. */
export const VIEWER_OPEN_EXTENSIONS = Object.freeze(['.mixo', '.glb', '.gltf', '.3mf', '.obj', '.stl']);

/**
 * How the viewer should open a picked file.
 * @param {string} filename
 * @returns {'project'|'model'|null}
 */
export function openKindFor(filename) {
  const name = String(filename ?? '').toLowerCase();
  const i = name.lastIndexOf('.');
  const ext = i === -1 ? '' : name.slice(i);
  if (ext === '.mixo') return 'project';
  return VIEWER_OPEN_EXTENSIONS.includes(ext) ? 'model' : null;
}

/**
 * Relative "edited" line for the project list.
 * @param {number} lastModified  ms epoch
 * @param {number} [now]
 * @returns {'today'|'yesterday'|'earlier'}
 */
export function recencyBucket(lastModified, now = Date.now()) {
  const day = 86400000;
  const startOfToday = new Date(now); startOfToday.setHours(0, 0, 0, 0);
  const t0 = startOfToday.getTime();
  if (lastModified >= t0) return 'today';
  if (lastModified >= t0 - day) return 'yesterday';
  return 'earlier';
}
