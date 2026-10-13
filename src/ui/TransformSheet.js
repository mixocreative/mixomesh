// Numeric "Transform" sheet (overhaul 8.5) — precise Move / Rotate / Scale for
// touch, where typing into the G/R/S modal is not possible. One Apply = one
// TransformCommand (one undo step). Targets come from
// Selection.getTransformTargets(), so groups move rigidly and locked items are
// skipped exactly like the gizmo and the G/R/S modal.
//
// Semantics (all relative, applied about the active pivot — the same pivot the
// gizmo and the modal use):
//   Move   X/Y/Z  mm  — world-axis offset
//   Rotate X/Y/Z  deg — world-axis rotation about the pivot (X, then Y, then Z)
//   Scale  %          — uniform; 100 = unchanged
// A blank field means "no change" (0 / 0 / 100).
//
// The maths (parseSheetValues / planSheetTransform) is DOM-free and pure so it
// is unit-tested headlessly; applySheet() is the thin scene integration.

import { SceneManager } from '../core/SceneManager.js';
import { Selection } from '../core/Selection.js';
import { getState } from '../core/StateManager.js';
import { push, TransformCommand } from '../core/HistoryManager.js';
import { BU_TO_MM } from '../core/print/ExportContext.js';
import { Toast } from './Toast.js';
import { icon } from '../core/Icons.js';
import { escapeAttr } from './renderSafe.js';
import { tr } from './lib/tr.js';

export const SCALE_PERCENT_MIN = 0.01;
export const SCALE_PERCENT_MAX = 100000;

export const SHEET_DEFAULTS = Object.freeze({
  moveX: 0, moveY: 0, moveZ: 0, rotX: 0, rotY: 0, rotZ: 0, scalePct: 100,
});

function _parseNum(raw) {
  const str = String(raw ?? '').trim().replace(',', '.');
  if (str === '') return { blank: true };
  // Plain decimals only: no hex, no 'Infinity', no stray text.
  if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(str)) return { error: true };
  const v = Number(str);
  return Number.isFinite(v) ? { value: v } : { error: true };
}

/**
 * Parse the sheet's raw text fields. Blank gives the default (no change).
 * @param {Record<string, string|number|null|undefined>} raw
 * @returns {{ ok: true, values: typeof SHEET_DEFAULTS } |
 *           { ok: false, field: string, reason: 'number'|'scale' }}
 */
export function parseSheetValues(raw = {}) {
  const values = { ...SHEET_DEFAULTS };
  for (const key of Object.keys(SHEET_DEFAULTS)) {
    const r = _parseNum(raw[key]);
    if (r.error) return { ok: false, field: key, reason: 'number' };
    if (!r.blank) values[key] = r.value;
  }
  if (values.scalePct < SCALE_PERCENT_MIN || values.scalePct > SCALE_PERCENT_MAX) {
    return { ok: false, field: 'scalePct', reason: 'scale' };
  }
  return { ok: true, values };
}

/** @param {typeof SHEET_DEFAULTS} v */
export function isNoopValues(v) {
  return v.moveX === 0 && v.moveY === 0 && v.moveZ === 0 &&
         v.rotX === 0 && v.rotY === 0 && v.rotZ === 0 && v.scalePct === 100;
}

/**
 * Compute prev/next absolute snapshots for the sheet values.
 * @param {{ id: string, snap: { position:{x:number,y:number,z:number}, rotation:{x:number,y:number,z:number,w:number}, scaling:{x:number,y:number,z:number} } }[]} entries
 * @param {{ x:number, y:number, z:number }} pivot  world pivot (BU)
 * @param {typeof SHEET_DEFAULTS} values
 * @param {number} [buToMm]
 * @returns {{ prev: Record<string, any>, next: Record<string, any>, noop: boolean }}
 */
export function planSheetTransform(entries, pivot, values, buToMm = BU_TO_MM) {
  const B = window.BABYLON;
  const noop = isNoopValues(values);
  /** @type {Record<string, any>} */ const prev = {};
  /** @type {Record<string, any>} */ const next = {};
  const d = new B.Vector3(values.moveX / buToMm, values.moveY / buToMm, values.moveZ / buToMm);
  const rad = Math.PI / 180;
  // World-axis order X, then Y, then Z: q = qz * qy * qx.
  const qx = B.Quaternion.RotationAxis(B.Axis.X, values.rotX * rad);
  const qy = B.Quaternion.RotationAxis(B.Axis.Y, values.rotY * rad);
  const qz = B.Quaternion.RotationAxis(B.Axis.Z, values.rotZ * rad);
  const q = qz.multiply(qy).multiply(qx);
  const s = values.scalePct / 100;
  const pv = new B.Vector3(pivot.x, pivot.y, pivot.z);

  for (const { id, snap } of entries) {
    prev[id] = snap;
    const rel = new B.Vector3(snap.position.x, snap.position.y, snap.position.z).subtract(pv);
    const rotated = rel.applyRotationQuaternion(q);
    const pos = pv.add(rotated.scale(s)).add(d);
    const rot = q.multiply(new B.Quaternion(snap.rotation.x, snap.rotation.y, snap.rotation.z, snap.rotation.w));
    rot.normalize();
    next[id] = {
      position: { x: pos.x, y: pos.y, z: pos.z },
      rotation: { x: rot.x, y: rot.y, z: rot.z, w: rot.w },
      scaling:  { x: snap.scaling.x * s, y: snap.scaling.y * s, z: snap.scaling.z * s },
    };
  }
  return { prev, next, noop };
}

function _snapshotNode(node) {
  const B = window.BABYLON;
  node.computeWorldMatrix(true);
  const aq = node.absoluteRotationQuaternion ?? B.Quaternion.Identity();
  const ap = node.getAbsolutePosition();
  const as = node.absoluteScaling ?? node.scaling;
  return {
    position: { x: ap.x, y: ap.y, z: ap.z },
    rotation: { x: aq.x, y: aq.y, z: aq.z, w: aq.w },
    scaling:  { x: as.x, y: as.y, z: as.z },
  };
}

/**
 * Apply parsed values to the current selection as ONE undoable command.
 * @param {typeof SHEET_DEFAULTS} values
 * @returns {'applied'|'noop'|'nothing'|'locked'}
 */
export function applySheet(values) {
  const { targets, activeNode, activeGeometry, lockedSkipped } = Selection.getTransformTargets();
  if (!targets.length) return lockedSkipped ? 'locked' : 'nothing';
  if (isNoopValues(values)) return 'noop';
  // Canonical parents first, then drop nodes covered by a selected ancestor.
  SceneManager.attachToSelection([], 'median', null);
  const top = SceneManager.topmostTransformTargets(targets, e => e.node);
  const pivotMode = getState().selection?.pivotMode ?? 'median';
  const pivot = SceneManager.computePivotPosition(top.map(e => e.node), pivotMode, activeNode, activeGeometry);
  const entries = top.map(({ id, node }) => ({ id, snap: _snapshotNode(node) }));
  const { prev, next } = planSheetTransform(entries, pivot, values);
  push(new TransformCommand(prev, next));   // applyTransforms re-attaches the pivot
  return 'applied';
}

// ── DOM sheet ────────────────────────────────────────────

const FIELDS = [
  { group: 'move',   key: 'moveX', axis: 'X', unit: 'mm' },
  { group: 'move',   key: 'moveY', axis: 'Y', unit: 'mm' },
  { group: 'move',   key: 'moveZ', axis: 'Z', unit: 'mm' },
  { group: 'rotate', key: 'rotX',  axis: 'X', unit: '°' },
  { group: 'rotate', key: 'rotY',  axis: 'Y', unit: '°' },
  { group: 'rotate', key: 'rotZ',  axis: 'Z', unit: '°' },
];

/** @type {HTMLElement|null} */
let _sheet = null;

function _label(group) {
  if (group === 'move')   return tr('transformSheet.move', 'Move');
  if (group === 'rotate') return tr('transformSheet.rotate', 'Rotate');
  return tr('transformSheet.scale', 'Scale');
}

function _row(group) {
  const cells = FIELDS.filter(f => f.group === group).map(f => `
    <label class="ts-cell"><span>${f.axis}</span>
      <input type="text" inputmode="decimal" enterkeyhint="done" autocomplete="off"
             data-field="${f.key}" placeholder="0" aria-label="${escapeAttr(`${_label(group)} ${f.axis} (${f.unit})`)}">
      <em>${f.unit}</em></label>`).join('');
  return `<div class="ts-row"><b>${_label(group)}</b>${cells}</div>`;
}

function _build() {
  const el = document.createElement('div');
  el.className = 'transform-sheet';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', tr('transformSheet.title', 'Transform'));
  el.hidden = true;
  el.innerHTML = `
    <div class="ts-head"><b>${tr('transformSheet.title', 'Transform')}</b>
      <span class="ts-hint">${tr('transformSheet.hint', 'Relative to the pivot. Blank = no change.')}</span>
      <button type="button" class="vt-btn ts-close" data-act="close" aria-label="${escapeAttr(tr('transformSheet.close', 'Close'))}">×</button></div>
    ${_row('move')}
    ${_row('rotate')}
    <div class="ts-row"><b>${_label('scale')}</b>
      <label class="ts-cell ts-wide"><input type="text" inputmode="decimal" enterkeyhint="done" autocomplete="off"
        data-field="scalePct" placeholder="100" aria-label="${escapeAttr(`${_label('scale')} (%)`)}"><em>%</em></label></div>
    <div class="ts-actions"><button type="button" class="pp-btn ts-apply" data-act="apply">${tr('transformSheet.apply', 'Apply')}</button></div>`;
  el.addEventListener('click', (e) => {
    const target = /** @type {HTMLElement|null} */ (e.target);
    const act = /** @type {HTMLElement|null} */ (target?.closest?.('[data-act]'))?.dataset.act;
    if (act === 'close') close();
    if (act === 'apply') _submit();
  });
  el.addEventListener('keydown', (e) => {
    // Typing must never reach the canvas shortcuts (G/R/S/X/Delete...).
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); _submit(); }
    else if (e.key === 'Escape') close();
  });
  return el;
}

function _submit() {
  if (!_sheet) return;
  /** @type {Record<string, string>} */ const raw = {};
  _sheet.querySelectorAll('input[data-field]').forEach(i => {
    const inp = /** @type {HTMLInputElement} */ (i);
    raw[inp.dataset.field ?? ''] = inp.value;
  });
  const parsed = parseSheetValues(raw);
  if (!parsed.ok) {
    /** @type {HTMLElement|null} */ (_sheet.querySelector(`[data-field="${parsed.field}"]`))?.focus();
    Toast.show(parsed.reason === 'scale'
      ? tr('transformSheet.badScale', 'Scale must be a positive percentage.')
      : tr('transformSheet.badNumber', 'Enter plain numbers only.'), 'error', 2500);
    return;
  }
  const r = applySheet(parsed.values);
  if (r === 'nothing') Toast.show(tr('toast.nothingSelected', 'Nothing selected'), 'info', 2000);
  else if (r === 'locked') Toast.show(tr('toast.lockedNoTransform', 'Locked items cannot be transformed'), 'info', 2000);
  else if (r === 'applied') {
    _sheet.querySelectorAll('input[data-field]').forEach(i => { /** @type {HTMLInputElement} */ (i).value = ''; });
  }
}

export function open() {
  if (!_sheet) return;
  _sheet.hidden = false;
  /** @type {HTMLElement|null} */ (_sheet.querySelector('[data-field="moveX"]'))?.focus();
}
export function close() { if (_sheet) _sheet.hidden = true; }
export function toggle() { if (_sheet?.hidden) open(); else close(); }
export function isOpen() { return !!_sheet && !_sheet.hidden; }

/** @param {HTMLElement|null} host  viewport container the sheet floats in */
export function init(host) {
  if (_sheet || !host) return;
  _sheet = _build();
  host.appendChild(_sheet);
}

/** Toolbar button markup (visible only on touch via CSS). */
export function buttonHtml() {
  const title = tr('transformSheet.openTitle', 'Numeric transform (Move / Rotate / Scale)');
  return `<button class="vt-btn vt-touch-only" data-kind="transformSheet" title="${escapeAttr(title)}" aria-label="${escapeAttr(title)}">${icon('SlidersHorizontal', { width: 14, height: 14 })}</button>`;
}

export const TransformSheet = { init, open, close, toggle, isOpen, buttonHtml };
