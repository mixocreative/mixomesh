// The Properties panel's UV Override section: a per-object offset / scale / rotation applied on top
// of its shader's own UV transform, plus copy-to-selection and reset.
//
// One job: let one object's texture be placed differently from every other object sharing the same
// shader, without cloning the shader. That is the whole reason the concept exists -- the
// alternative is a duplicate shader per object, which multiplies the material list and the export.
//
// Two things to keep right, both learned here:
//   - `UVOverrideCommand` is SINGLE-mesh, so copy-to-selection pushes N commands inside one
//     `beginBatch`/`endBatch`. Without the batch the operator gets an undo that reverts one mesh
//     at a time, which looks like the app losing the operation half way.
//   - the copy button sits in the section header, and the header's own click toggles collapse. The
//     `stopPropagation` on the copy handler is load-bearing, not tidiness: without it, copying also
//     collapses the section the operator is working in.
//
// Cut out of PropertiesPanel.js on 2026-11-14, following the refinement/RefinementSection.js
// pattern -- render builds HTML, wire takes the root element and a rerender callback.

import { getState } from '../../core/StateManager.js';
import { t } from '../../i18n/index.js';
import { sectionIcon } from '../../core/Icons.js';
import { escapeHtml as _escape, escapeAttr } from '../renderSafe.js';
import { Selection } from '../../core/Selection.js';
import { push, beginBatch, endBatch, UVOverrideCommand } from '../../core/HistoryManager.js';
import { wireNumbers } from '../lib/fields.js';
import { fmt as _fmt } from './format.js';

/** The identity override, used whenever an object has none yet. */
const NEUTRAL = { offsetX: 0, offsetY: 0, scaleX: 1, scaleY: 1, rotation: 0 };
const UV_KEYS = ['offsetX', 'offsetY', 'scaleX', 'scaleY', 'rotation'];

export function renderUVOverrideSection(obj) {
  if (!obj.shaderId) return '';
  const override = getState().scene.uvOverrides[obj.id] ?? null;
  const active = !!override;
  const uv = override ?? NEUTRAL;
  // ↧ Copy-from-active: visible when multi-select. Active's override (or
  // "clear" if it has none) propagates to every other selected mesh.
  const multi = Selection.getSelectedIds().length > 1;
  const copyBtn = multi
    ? `<button class="pp-copy-btn" data-copy="uv-override" title="${escapeAttr(t('properties.copyUvTitle'))}">↧</button>`
    : '';
  return `
    <section class="pp-section" data-section="uv-override">
      <header class="pp-section-header">
        ${sectionIcon('Map')}${_escape(t('properties.uvOverride'))}${copyBtn}
        ${active ? `<span class="pp-multi">${_escape(t('properties.active'))}</span>` : ''}
      </header>
      <div class="pp-grid3">
        <label>${_escape(t('properties.offset'))}</label>
        <input type="number" step="0.01" id="pp-uv-ox" value="${_fmt(uv.offsetX, 3)}">
        <input type="number" step="0.01" id="pp-uv-oy" value="${_fmt(uv.offsetY, 3)}">
        <span class="pp-readout-thin">${_escape(t('properties.uvAxes'))}</span>
      </div>
      <div class="pp-grid3">
        <label>${_escape(t('properties.scale'))}</label>
        <input type="number" step="0.05" id="pp-uv-sx" value="${_fmt(uv.scaleX, 3)}">
        <input type="number" step="0.05" id="pp-uv-sy" value="${_fmt(uv.scaleY, 3)}">
        <span class="pp-readout-thin">${_escape(t('properties.uvAxes'))}</span>
      </div>
      <div class="pp-row">
        <label>${_escape(t('properties.rotation'))}</label>
        <input type="number" step="0.05" id="pp-uv-rot" value="${_fmt(uv.rotation, 3)}">
      </div>
      <div class="pp-row-inline">
        <span class="pp-hint">${_escape(t(active ? 'properties.uvActiveHint' : 'properties.uvNoOverrideHint'))}</span>
        <button class="pp-btn" id="pp-uv-reset" ${active ? '' : 'disabled'}>${_escape(t('properties.resetDefault'))}</button>
      </div>
    </section>
  `;
}

/**
 * @param {HTMLElement} root the panel body
 * @param {object} obj
 * @param {() => void} rerender used as `onInvalid`: a rejected number puts the stored value back
 */
export function wireUVOverrideSection(root, obj, rerender) {
  if (!obj.shaderId) return;
  const fields = [
    ['pp-uv-ox',  'offsetX'],
    ['pp-uv-oy',  'offsetY'],
    ['pp-uv-sx',  'scaleX'],
    ['pp-uv-sy',  'scaleY'],
    ['pp-uv-rot', 'rotation'],
  ];

  for (const [elId, key] of fields) {
    wireNumbers(root, `#${elId}`, (_el, n) => {
      const prev = getState().scene.uvOverrides[obj.id] ?? null;
      const base = prev ?? NEUTRAL;
      if (Math.abs(base[key] - n) < 1e-9) return;
      const next = { ...base, [key]: n };
      push(new UVOverrideCommand(obj.id, prev, next));
    }, { onInvalid: rerender });
  }

  root.querySelector('#pp-uv-reset')?.addEventListener('click', () => {
    const prev = getState().scene.uvOverrides[obj.id] ?? null;
    if (!prev) return;
    push(new UVOverrideCommand(obj.id, prev, null));
  });

  root.querySelector('[data-copy="uv-override"]')?.addEventListener('click', (e) => {
    e.stopPropagation();   // header click toggles section collapse; copy must not
    _copyUVOverrideFromActive();
  });
}

/**
 * Propagate the active mesh's UV override to every OTHER selected mesh.
 * `UVOverrideCommand` is single-mesh, so N pushes are wrapped in a batch for
 * a single undo entry. If the active has no override, targets are cleared
 * (symmetric with "Reset to Default" applied across the selection).
 */
function _copyUVOverrideFromActive() {
  const activeId = Selection.getActiveId();
  const selIds = Selection.getSelectedIds();
  if (!activeId || selIds.length < 2) return;
  const overrides = getState().scene.uvOverrides;
  const source = overrides[activeId] ?? null;

  const work = [];
  for (const id of selIds) {
    if (id === activeId) continue;
    const prev = overrides[id] ?? null;
    const next = source ? { ...source } : null;
    if (_uvEq(prev, next)) continue;
    work.push({ id, prev, next });
  }
  if (!work.length) return;
  beginBatch('Copy UV Override');
  for (const { id, prev, next } of work) push(new UVOverrideCommand(id, prev, next));
  endBatch();
}

function _uvEq(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  for (const k of UV_KEYS) {
    if (Math.abs((a[k] ?? 0) - (b[k] ?? 0)) > 1e-9) return false;
  }
  return true;
}
