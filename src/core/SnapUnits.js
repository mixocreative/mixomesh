// Snap + nudge units (overhaul 5.6, plan §4.7 "Transform" row). Every step
// the user sees is in MILLIMETRES: `state.gizmo.snap.translate` is a mm value
// (factory default 1 mm, config/default-settings.json), rotate is degrees,
// scale is a plain multiplier. The scene works in BU (1 BU = 1 m), so the
// conversion lives here — ONE place — for the G/R/S modal, the gizmo Ctrl-snap
// and the arrow-key nudge. Pure functions only (unit-tested in
// tests/snap-units.test.mjs).

import { MM_PER_BU } from './scene/SceneConstants.js';

/** Arrow-key nudge steps in mm: plain / Shift / Alt (plan §4.7). */
export const NUDGE_MM = Object.freeze({ base: 1, coarse: 10, fine: 0.1 });

const DEFAULT_TRANSLATE_MM = 1;
const DEFAULT_ROTATE_DEG = 15;
const DEFAULT_SCALE_STEP = 0.1;

function _positive(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Translate snap step in BU from the persisted mm value.
 * @param {{ translate?: number }} [snap]  state.gizmo.snap
 * @returns {number}
 */
export function translateSnapBU(snap) {
  return _positive(snap?.translate, DEFAULT_TRANSLATE_MM) / MM_PER_BU;
}

/**
 * Rotate snap step in radians from the persisted degree value.
 * @param {{ rotate?: number }} [snap]
 * @returns {number}
 */
export function rotateSnapRad(snap) {
  return _positive(snap?.rotate, DEFAULT_ROTATE_DEG) * Math.PI / 180;
}

/**
 * Scale snap step (multiplier increment).
 * @param {{ scale?: number }} [snap]
 * @returns {number}
 */
export function scaleSnapStep(snap) {
  return _positive(snap?.scale, DEFAULT_SCALE_STEP);
}

/**
 * Round `value` to the nearest multiple of `step` (identity for step ≤ 0).
 * @param {number} value
 * @param {number} step
 * @returns {number}
 */
export function snapToStep(value, step) {
  if (!(step > 0) || !Number.isFinite(value)) return value;
  return Math.round(value / step) * step;
}

/**
 * Babylon gizmo `snapDistance` values for Ctrl held (`on`) or released.
 * Position gizmo = BU, rotation gizmo = radians, scale gizmo = multiplier.
 * Released → 0 everywhere (free drag).
 * @param {{ translate?: number, rotate?: number, scale?: number }} [snap]
 * @param {boolean} on
 * @returns {{ translate: number, rotate: number, scale: number }}
 */
export function gizmoSnapDistances(snap, on) {
  if (!on) return { translate: 0, rotate: 0, scale: 0 };
  return { translate: translateSnapBU(snap), rotate: rotateSnapRad(snap), scale: scaleSnapStep(snap) };
}

/**
 * Nudge step in mm for an arrow-key event: Alt = fine 0.1, Shift = coarse 10,
 * otherwise 1. Alt wins when both are held (precision beats speed).
 * @param {{ shiftKey?: boolean, altKey?: boolean }} e
 * @returns {number}
 */
export function nudgeStepMM(e) {
  if (e?.altKey) return NUDGE_MM.fine;
  if (e?.shiftKey) return NUDGE_MM.coarse;
  return NUDGE_MM.base;
}

// Unit world vector along the dominant HORIZONTAL (X or Z) component of `v`,
// or null when `v` has (almost) no horizontal part.
function _dominantHorizontal(v) {
  const ax = Math.abs(v?.x ?? 0), az = Math.abs(v?.z ?? 0);
  if (Math.max(ax, az) < 0.2) return null;
  return ax >= az
    ? { x: Math.sign(v.x), y: 0, z: 0 }
    : { x: 0, y: 0, z: Math.sign(v.z) };
}

/**
 * World direction of an arrow-key nudge, view-relative but snapped to a world
 * axis (Tinkercad-style): Left/Right follow the camera's right vector, Up/Down
 * move AWAY from / TOWARD the viewer on the bed (camera forward; camera up
 * when looking straight down). Ctrl+Up/Down moves vertically (world ±Y).
 * @param {string} key   'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown'
 * @param {boolean} vertical  Ctrl held
 * @param {{ right: {x,y,z}, forward: {x,y,z}, up: {x,y,z} }} cam  world-space camera basis
 * @returns {{x:number,y:number,z:number}|null}
 */
export function nudgeDirection(key, vertical, cam) {
  const neg = (d) => (d ? { x: -d.x || 0, y: -d.y || 0, z: -d.z || 0 } : null);
  if (key === 'ArrowUp' || key === 'ArrowDown') {
    if (vertical) return { x: 0, y: key === 'ArrowUp' ? 1 : -1, z: 0 };
    const away = _dominantHorizontal(cam?.forward) ?? _dominantHorizontal(cam?.up);
    return key === 'ArrowUp' ? away : neg(away);
  }
  if (key === 'ArrowLeft' || key === 'ArrowRight') {
    if (vertical) return null;
    const right = _dominantHorizontal(cam?.right);
    return key === 'ArrowRight' ? right : neg(right);
  }
  return null;
}
