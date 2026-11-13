// The per-object inspector: object, source, transform, scale, material. The panel the operator
// spends the most time in, and the largest file in this folder -- its cut is named in
// ../../docs/size-debt.md, and new work belongs at one of those seams, not at the end.
//
// One job: render the selected object's state and send edits back as commands. It owns no state.
//
// Two traps it carries, both learned the hard way:
//   - SOURCE_UNIT_FACTORS is imported from ../core/ImportNormalizer.js and never redefined here.
//     Two tables of unit factors is two different answers to "how big is this".
//   - the scale row distinguishes DECLARING a ratio from CONVERTING to it (`defaultScaleVerb`,
//     `scaleConsequence`). Getting that wrong reloads an object at double size, which is a bug
//     that only shows up after a save and a reopen.
import { EVENTS } from '../core/events.js';
import { subscribe, setState, getState } from '../core/StateManager.js';
import { t, applyTranslations } from '../i18n/index.js';
import { Toast } from './Toast.js';
import { Selection } from '../core/Selection.js';
import { AssetLoader } from '../core/AssetLoader.js';
import { SceneManager } from '../core/SceneManager.js';
import {
  push, beginBatch, endBatch,
  TransformCommand, VisibilityCommand, LockCommand, RenameCommand,
  PrintPartCommand, RescaleObjectCommand,
  SetScaleLabelCommand, ratioSourceOf, RATIO_SOURCE,
  BedPlacementCommand, UngroupCommand, collectGroupSubtree,
  sizeEntryProblem, MAX_SIDE_MM,
} from '../core/HistoryManager.js';
import { findGroupNode, captureWorldNode } from '../core/commands/support.js';
import { dropToBedDelta } from '../core/placement/BedPlacement.js';
import { SCALE_PRESETS, BU_TO_MM } from '../core/PrintManager.js';
import { Modal } from './Modal.js';
import { icon, sectionIcon } from '../core/Icons.js';
import {
  formatScaleRatio, parseScaleRatioText, objectRatio, effectiveRatioInfo,
} from '../core/scale/ScaleMath.js';
import { logicalObjectPartIds } from '../core/LogicalObjects.js';
import { escapeHtml as _escape, escapeAttr } from './renderSafe.js';
import { renderShaderSection, wireShaderSection, shaderPickerRenderer } from './properties/ShaderSection.js';
import { logicalTargetIds } from './properties/targets.js';
import {
  renderSourceRow, wireSourceRow, sourceStatusFor, installSourceMenuDismiss,
} from './properties/SourceRow.js';
import { renderSourceUnitSection, wireSourceUnitSection } from './properties/SourceUnitSection.js';
import { renderUVOverrideSection, wireUVOverrideSection } from './properties/UVOverrideSection.js';
import { fmt as _fmt } from './properties/format.js';
import { escEnter, wireToggles, reflectToggle } from './lib/fields.js';
import { createCollapseController } from './lib/sections.js';
import { renderRefinementSection, wireRefinementSection } from './refinement/RefinementSection.js';
import { RefinementController } from '../core/refinement/RefinementController.js';
import { worldSizeOf, hierarchyMeshes } from '../core/scene/WorldExtents.js';

const BABYLON = window.BABYLON;

let _root = null;
let _bodyEl = null;
// Section keys that the user has collapsed. Preserved across re-renders, lost
// on page reload (session-only by design — object context resets per project).
const _collapse = createCollapseController();

// Scale control (task 1.13): the ratio picked but not yet applied, and the
// selection it was picked for (a selection change drops it). The consequence
// line previews both verbs before anything is applied.
let _pendingRatio = null;
let _pendingKey = '';

// Walk every element under `root` that carries data-i18n-key and rewrite its
// textContent through t(). MUST use textContent — translations are plain text,
// never HTML (translator-safety rule from spec §Security).
function _retranslate(root) {
  applyTranslations(root);
}

// ── Init ─────────────────────────────────────────────────

/** Initialise the Properties panel. Must be called once after DOM is ready. */
export function init() {
  // The right column is now a stack of collapsible sections; we render into
  // our pre-mounted body container (see index.html). No private header — the
  // section shell owns it.
  _root = document.getElementById('rp-properties');
  _bodyEl = document.getElementById('rp-properties-body');
  _bodyEl.classList.add('pp-body');

  const events = [
    EVENTS.SELECTION_CHANGED,
    EVENTS.ACTIVE_OBJECT_CHANGED,
    EVENTS.TRANSFORM_COMMITTED,
    EVENTS.VISIBILITY_CHANGED,
    EVENTS.LOCK_CHANGED,
    EVENTS.OBJECT_RENAMED,
    EVENTS.ASSET_REGISTERED,
    EVENTS.ASSET_REMOVED,
    EVENTS.ASSET_INSTANTIATED,
    EVENTS.SHADER_CREATED,
    EVENTS.SHADER_UPDATED,
    EVENTS.SHADER_ASSIGNED,
    EVENTS.SHADER_DUPLICATED,
    EVENTS.COLOR_APPLIED,
    EVENTS.UV_OVERRIDE_CHANGED,
    EVENTS.OBJECT_UPDATED,
    EVENTS.REFINEMENT_CHANGED,
    EVENTS.REFINEMENT_PROGRESS,
    EVENTS.REFINEMENT_READY,
    EVENTS.REFINEMENT_FAILED,
    EVENTS.REFINEMENT_CANCELLED,
    EVENTS.REFINEMENT_STALE,
    EVENTS.WORKSPACE_CHANGED,    // empty-state hint is workspace-specific
    EVENTS.ASSET_RELINKED,       // Source row status
    EVENTS.GROUP_CREATED,
    EVENTS.GROUP_DISSOLVED,
    // Commands that change state without a domain event (Set scale relabel,
    // group Print subtree) re-render through the history signal.
    EVENTS.HISTORY_PUSHED,
    EVENTS.HISTORY_UNDONE,
    EVENTS.HISTORY_REDONE,
  ];
  for (const ev of events) subscribe(ev, _render);
  installSourceMenuDismiss(() => _bodyEl);
  // Locale changes must rebuild body markup generated from t(), then refresh
  // static header/body data-i18n attributes in one root walk.
  subscribe(EVENTS.LOCALE_CHANGED, () => { _render(); _retranslate(_root); });
  Modal.register('shader-picker', shaderPickerRenderer);
  _retranslate(_root);
  _render();
}

// ── Render ───────────────────────────────────────────────

function _render() {
  if (!_bodyEl) return;
  const activeId = Selection.getActiveId();
  const { objects, groups } = getState().scene;
  const obj      = activeId ? objects[activeId] : null;

  const selKey = `${activeId ?? ''}|${Selection.getSelectedIds().join(',')}`;
  if (selKey !== _pendingKey) { _pendingKey = selKey; _pendingRatio = null; }

  // A user group is the active selection (task 3.6): group-scoped panel.
  if (!obj && activeId && groups?.[activeId]) {
    _renderGroup(activeId);
    return;
  }

  if (!obj) {
    // Scene-wide settings live in the Scene panel (#rp-scene) now — this
    // panel is object-scoped only. Hint matches the workspace's task.
    const hasObjects = Object.keys(objects).length > 0;
    const ws = document.body.dataset.workspace ?? 'layout';
    const hint = !hasObjects
      ? _escape(t('properties.empty.noObjects'))
      : ws === 'shade'
        ? _escape(t('properties.empty.selectShaderObject'))
        : _escape(t('properties.empty.selectMesh'));
    _bodyEl.innerHTML = `<div class="pp-empty">${hint}</div>`;
    return;
  }

  const mesh   = AssetLoader.getBabylonMesh(activeId);
  const asset  = obj.assetId ? getState().scene.assetLibrary[obj.assetId] : null;
  const sel    = Selection.getSelectedIds();
  const multi  = sel.length > 1;
  const resolved = Selection.getSelectedResolved();

  _bodyEl.innerHTML = `
    ${_renderObjectSection(obj, multi, sel.length, asset)}
    ${renderRefinementSection(obj, RefinementController.getProgress(activeId), sel.filter(id => RefinementController.availability(id).available).length, RefinementController.availability(activeId))}
    ${_renderTransformSection(mesh, multi, resolved)}
    ${asset ? renderSourceUnitSection(asset) : ''}
    ${renderShaderSection(obj)}
    ${renderUVOverrideSection(obj)}
  `;

  _wireObjectSection(obj, asset);
  wireRefinementSection(_bodyEl, activeId, sel);
  _wireTransformSection(activeId);
  if (asset) wireSourceUnitSection(_bodyEl, asset, _render);
  wireShaderSection(_bodyEl);
  wireUVOverrideSection(_bodyEl, obj, _render);
  _applyAndWireSectionCollapse();
  _retranslate(_bodyEl);
}

function _applyAndWireSectionCollapse() {
  _collapse.wire(_bodyEl, { sectionSelector: '.pp-section[data-section]', collapsedClass: 'pp-collapsed' });
}

// ── Object section ───────────────────────────────────────
// Visible in every workspace (Decision 6 / task 5.2): name, Source (4.6),
// Print, visible / lock.

function _renderObjectSection(obj, multi, total, asset = null) {
  const visible = obj.visible !== false;
  const locked  = !!obj.locked;
  const nameVal = multi ? '—' : obj.name;
  const nameDisabled = multi ? 'disabled' : '';
  return `
    <section class="pp-section" data-section="object">
      <header class="pp-section-header">${sectionIcon('Shapes')}${_escape(t('properties.object'))}${multi ? ` <span class="pp-multi">${_escape(t('properties.selectedCount', { n: total }))}</span>` : ''}</header>
      <div class="pp-row">
        <label for="pp-name">${_escape(t('properties.name'))}</label>
        <input type="text" id="pp-name" value="${_escape(nameVal)}" ${nameDisabled}>
      </div>
      ${asset && !multi ? renderSourceRow(obj, asset) : ''}
      ${_renderPrintRow(!!(obj.isPrintPart ?? false))}
      <div class="pp-row pp-row-inline">
        <button type="button" class="pp-toggle${visible ? ' pp-toggle-on' : ''}" id="pp-visible" aria-pressed="${visible ? 'true' : 'false'}">${icon(visible ? 'Eye' : 'EyeOff', { width: 13, height: 13 })} ${_escape(t('properties.visible'))}</button>
        <button type="button" class="pp-toggle${locked ? ' pp-toggle-on' : ''}" id="pp-locked" aria-pressed="${locked ? 'true' : 'false'}">${icon(locked ? 'Lock' : 'Unlock', { width: 13, height: 13 })} ${_escape(t('properties.locked'))}</button>
      </div>
    </section>
  `;
}

// "Print" row (was its own section): include this object — or, for a group,
// its whole subtree — in exports, validation and the cost quote.
function _renderPrintRow(on, { mixed = false, group = false } = {}) {
  const label = t(group ? 'properties.printGroup' : 'properties.exportPrintPart');
  return `
    <div class="pp-row pp-print-row">
      <label>${_escape(t('properties.printPart'))}</label>
      <div class="pp-row-value">
        <button type="button" class="pp-toggle${on ? ' pp-toggle-on' : ''}${mixed ? ' pp-toggle-mixed' : ''}" id="pp-is-print-part"
                aria-pressed="${mixed ? 'mixed' : (on ? 'true' : 'false')}" title="${escapeAttr(t('properties.exportPrintPartHint'))}"><span class="pp-toggle-dot" aria-hidden="true"></span>${_escape(label)}</button>
      </div>
    </div>
  `;
}

function _wireObjectSection(obj, asset = null) {
  const nameEl = _bodyEl.querySelector('#pp-name');

  if (nameEl && !nameEl.disabled) {
    nameEl.addEventListener('change', () => {
      const next = nameEl.value.trim();
      if (next && next !== obj.name) push(new RenameCommand(obj.id, obj.name, next));
    });
    escEnter(nameEl, () => { nameEl.value = obj.name; nameEl.blur(); });
  }

  // Visible / Locked are toggle BUTTONS (checkbox→toggle audit) — object mode
  // switches with eye/lock glyphs. The panel re-renders on VISIBILITY_CHANGED
  // / LOCK_CHANGED, so the pressed state + glyph repaint from fresh state.
  wireToggles(_bodyEl, '#pp-visible', (_el, next) => {
    push(new VisibilityCommand([obj.id], { [obj.id]: !!obj.visible }, next));
  });
  wireToggles(_bodyEl, '#pp-locked', (_el, next) => {
    push(new LockCommand([obj.id], { [obj.id]: !!obj.locked }, next));
  });
  // Per-object export flag = toggle button (checkbox→toggle audit).
  wireToggles(_bodyEl, '#pp-is-print-part', (el, next) => {
    push(new PrintPartCommand(obj.id, !!obj.isPrintPart, next));
    reflectToggle(el, next);
  });
  if (asset) wireSourceRow(_bodyEl, asset, _render);
}

// ── Transform section ────────────────────────────────────

/**
 * Transform fields are read-only when ANY selected item is effectively locked
 * (it, or an ancestor group, is locked — overhaul 2.5).
 * @param {string[]} ids
 */
export function isTransformReadOnly(ids) {
  return (ids ?? []).some(id => Selection.isEffectivelyLocked(id));
}

function _renderTransformSection(mesh, multi, resolved = []) {
  if (!mesh) return '';
  const readOnly = isTransformReadOnly(Selection.getSelectedIds());
  const xform = _readTransform(mesh);
  // mm and deg view for the user.
  const posMM = { x: xform.position.x * BU_TO_MM, y: xform.position.y * BU_TO_MM, z: xform.position.z * BU_TO_MM };
  const rotDeg = _quatToEulerDeg(xform.rotation);
  const sc = xform.scaling;
  const dis = (multi || readOnly) ? 'disabled' : '';
  const roTitle = readOnly ? ` title="${escapeAttr(t('properties.lockedTransformTitle'))}"` : '';

  // Print-space size from world AABB. The number to compare against the real
  // model spec on the box — "1:35 hull should be ~245 mm long".
  const sizeBU = (multi || resolved.length > 1) ? _worldSize(resolved.map(r => r.mesh))
                                                : _worldSize([mesh]);
  const sizeMM = sizeBU ? { x: sizeBU.x * BU_TO_MM, y: sizeBU.y * BU_TO_MM, z: sizeBU.z * BU_TO_MM } : null;

  const scaleLocked = getState().ui?.scaleLocked !== false;
  const lockedCls = scaleLocked ? 'pp-locked' : '';
  const lockIcon = scaleLocked ? 'Lock' : 'Unlock';

  // ↧ Copy-from-active: only meaningful when the selection has >1 mesh and a
  // single active mesh exists. Hidden otherwise.
  const copyBtn = multi
    ? `<button class="pp-copy-btn" data-copy="transform" title="${escapeAttr(t('properties.copyTransformTitle'))}">↧</button>`
    : '';

  return `
    <section class="pp-section" data-section="transform"${roTitle}>
      <header class="pp-section-header">${sectionIcon('Move')}<span data-i18n-key="section.transform">Transform</span>${copyBtn}</header>
      ${_renderScaleRow(readOnly, mesh)}
      <div class="pp-grid3">
        <label>${_escape(t('properties.sizeMm'))}</label>
        <input type="number" step="0.1" min="0.001" data-size-axis="x" value="${sizeMM ? _fmt(sizeMM.x) : ''}" ${dis || (sizeMM ? '' : 'disabled')}${roTitle}>
        <input type="number" step="0.1" min="0.001" data-size-axis="y" value="${sizeMM ? _fmt(sizeMM.y) : ''}" ${dis || (sizeMM ? '' : 'disabled')}${roTitle}>
        <input type="number" step="0.1" min="0.001" data-size-axis="z" value="${sizeMM ? _fmt(sizeMM.z) : ''}" ${dis || (sizeMM ? '' : 'disabled')}${roTitle}>
      </div>
      <div class="pp-grid3 pp-axes">
        <label>${_escape(t('properties.posMm'))}</label>
        <input type="number" step="0.1" data-xform="position" data-axis="x" value="${_fmt(posMM.x)}" ${dis}${roTitle}>
        <input type="number" step="0.1" data-xform="position" data-axis="y" value="${_fmt(posMM.y)}" ${dis}${roTitle}>
        <input type="number" step="0.1" data-xform="position" data-axis="z" value="${_fmt(posMM.z)}" ${dis}${roTitle}>
      </div>
      <div class="pp-grid3 pp-axes">
        <label>${_escape(t('properties.rotDeg'))}</label>
        <input type="number" step="0.1" data-xform="rotation" data-axis="x" value="${_fmt(rotDeg.x)}" ${dis}${roTitle}>
        <input type="number" step="0.1" data-xform="rotation" data-axis="y" value="${_fmt(rotDeg.y)}" ${dis}${roTitle}>
        <input type="number" step="0.1" data-xform="rotation" data-axis="z" value="${_fmt(rotDeg.z)}" ${dis}${roTitle}>
      </div>
      <div class="pp-grid3 pp-axes pp-scale-row ${lockedCls}">
        <label>${_escape(t('properties.scaleXyz'))}</label>
        <input type="number" step="0.001" min="0.0001" data-xform="scaling" data-axis="x" value="${_fmt(sc.x, 4)}" ${dis}${roTitle}>
        <input type="number" step="0.001" min="0.0001" data-xform="scaling" data-axis="y" value="${_fmt(sc.y, 4)}" ${dis}${roTitle}>
        <input type="number" step="0.001" min="0.0001" data-xform="scaling" data-axis="z" value="${_fmt(sc.z, 4)}" ${dis}${roTitle}>
      </div>
      <div class="pp-row pp-row-inline">
        <button class="pp-icon-btn pp-scale-lock" data-action="scaleLock" title="${escapeAttr(t(scaleLocked ? 'properties.unlockScaleTitle' : 'properties.lockScaleTitle'))}">${icon(lockIcon, { width: 13, height: 13 })}</button>
        <span class="pp-hint">${_escape(t(scaleLocked ? 'properties.scaleLockedHint' : 'properties.scaleUnlockedHint'))}</span>
      </div>
      ${_renderDropToBedRow(readOnly)}
    </section>
  `;
}

function _renderDropToBedRow(readOnly) {
  return `
    <div class="pp-row pp-drop-row">
      <span></span>
      <button type="button" class="pp-btn pp-drop-btn" data-action="dropToBed"${readOnly ? ' disabled' : ''}>${icon('Download', { width: 13, height: 13 })} ${_escape(t('placement.dropToBed'))}</button>
    </div>
  `;
}

// ── Scale control: declare vs convert (task 1.13 / 1.16) ──
//
// "Scale [1:72 ▾] Set scale | Convert…" — picking a ratio only stages it; the
// consequence line says what each verb will do before anything is applied.
// Set scale = relabel (SetScaleLabelCommand, no geometry); Convert = resize by
// old/new (RescaleObjectCommand). The default verb (primary button, Enter) is
// relabel while the scale was never declared (ratioSource 'default' — STL/OBJ)
// and convert once it is trusted ('file' / 'user'). With nothing staged the
// line shows the effective scale (Decision 26): "×2.0 → prints as 1:36".

/**
 * The verb Enter / the primary button applies for these objects.
 * @param {object[]} objs  scene objects (targets)
 * @param {Record<string, object>} assetLibrary
 * @returns {'label'|'convert'}
 */
export function defaultScaleVerb(objs, assetLibrary = {}) {
  const list = (objs ?? []).filter(Boolean);
  if (!list.length) return 'label';
  return list.every(o => ratioSourceOf(o, assetLibrary?.[o.assetId]) === RATIO_SOURCE.DEFAULT) ? 'label' : 'convert';
}

/**
 * What each verb would do when `nextRatio` is applied to objects currently at
 * `currentRatios`: relabel never resizes; convert resizes by old/new (one
 * factor, or null when the selection mixes ratios).
 * @param {number[]} currentRatios
 * @param {number} nextRatio
 * @returns {{ changed: boolean, factor: number|null }}
 */
export function scaleConsequence(currentRatios, nextRatio) {
  const rs = (currentRatios ?? []).filter(r => Number.isFinite(r) && r > 0);
  if (!(Number.isFinite(nextRatio) && nextRatio > 0) || !rs.length) return { changed: false, factor: null };
  const changed = rs.some(r => Math.abs(r - nextRatio) > 1e-9);
  const factors = [...new Set(rs.map(r => +(r / nextRatio).toFixed(6)))];
  return { changed, factor: factors.length === 1 ? factors[0] : null };
}

function _fmtFactor(f) {
  if (!Number.isFinite(f)) return '';
  if (f < 1) return `×${Number(f.toPrecision(3))}`;   // ×0.0139, ×0.486
  const r = Math.round(f * 100) / 100;
  return `×${Number.isInteger(r) ? r.toFixed(1) : String(r)}`;
}

function _scaleTargets() {
  const objects = getState().scene.objects;
  return _ratioTargetIds(Selection.getSelectedIds(), objects);
}

function _renderScaleRow(readOnly = false, mesh = null) {
  const { objects, assetLibrary } = getState().scene;
  const ids = Selection.getSelectedIds().filter(id => objects[id]);
  const ratios = ids.map(id => objectRatio(objects[id]));
  const mixed = ratios.length > 1 && ratios.some(r => r !== ratios[0]);
  const current = mixed ? null : (ratios[0] ?? 1);
  const shown = _pendingRatio ?? current;
  const presetOpts = SCALE_PRESETS
    .filter(p => p.ratio !== null)
    .map(p => `<option value="${escapeAttr(p.ratio)}"${shown === p.ratio ? ' selected' : ''}>${_escape(p.label)}</option>`)
    .join('');
  const targetObjs = _scaleTargets().map(id => objects[id]);
  const verb = defaultScaleVerb(targetObjs, assetLibrary);
  const sources = [...new Set(targetObjs.map(o => ratioSourceOf(o, assetLibrary?.[o?.assetId])))];
  const cons = _pendingRatio != null ? scaleConsequence(targetObjs.map(o => objectRatio(o)), _pendingRatio) : null;
  const canApply = !readOnly && !!cons?.changed;
  const btn = (kind, key) => `<button type="button" class="pp-btn${verb === kind ? ' pp-btn-primary' : ''}" data-scale-verb="${kind}"${canApply ? '' : ' disabled'}>${_escape(t(key))}</button>`;
  return `
    <div class="pp-row pp-ratio-row" data-ratio-source="${escapeAttr(sources.length === 1 ? sources[0] : 'mixed')}" data-scale-default="${verb}">
      <label title="${escapeAttr(t('properties.scaleTitle'))}">${_escape(t('properties.scaleRatio'))}</label>
      <div class="pp-scale-ctl">
        <select data-ratio-preset class="pp-preset-select" aria-label="${escapeAttr(t('properties.scaleRatio'))}"${readOnly ? ' disabled' : ''}>
          <option value="">${mixed && _pendingRatio == null ? '—' : _escape(t('print.custom'))}</option>
          ${presetOpts}
        </select>
        <input type="text" data-ratio-input class="pp-ratio-input" value="${escapeAttr(shown == null ? '' : formatScaleRatio(shown))}" placeholder="${mixed ? '—' : '1:1'}" aria-label="${escapeAttr(t('properties.scaleRatio'))}"${readOnly ? ' disabled' : ''}>
        <div class="pp-scale-verbs">
          ${btn('label', 'properties.setScale')}
          ${btn('convert', 'properties.convertScale')}
        </div>
      </div>
    </div>
    ${_renderScaleNote(cons, verb, mesh, ids, sources)}
  `;
}

function _renderScaleNote(cons, verb, mesh, ids, sources) {
  let kind = '';
  let text = '';
  if (cons?.changed) {
    const relabel = t('properties.scaleRelabelOnly');
    const resize = cons.factor != null ? t('properties.scaleResize', { factor: _fmtFactor(cons.factor) }) : t('properties.scaleResizeMixed');
    const first = verb === 'label' ? `${t('properties.setScale')}: ${relabel}` : `${t('properties.convertScale')}: ${resize}`;
    const second = verb === 'label' ? `${t('properties.convertScale')}: ${resize}` : `${t('properties.setScale')}: ${relabel}`;
    kind = 'consequence';
    text = [first, second];
  } else if (ids.length === 1 && mesh) {
    const obj = getState().scene.objects[ids[0]];
    const info = effectiveRatioInfo(obj, mesh);
    if (!info.uniform) {
      kind = 'nonuniform';
      text = t('properties.scaleNonUniform');
    } else if (Math.abs(info.nodeScale - 1) > 1e-6) {
      kind = 'effective';
      text = t('properties.scaleEffective', { factor: _fmtFactor(info.nodeScale), ratio: formatScaleRatio(info.ratio) });
    } else if (sources.length === 1 && sources[0] === RATIO_SOURCE.DEFAULT) {
      kind = 'undeclared';
      text = t('properties.scaleUndeclared');
    }
  }
  if (!text) return '';
  const html = Array.isArray(text) ? text.map(x => `<span>${_escape(x)}</span>`).join('') : _escape(text);
  return `<div class="pp-scale-note" data-scale-note="${kind}">${html}</div>`;
}

// Apply the staged ratio with one verb as ONE undoable step over every
// selected object expanded to its logical-object parts (finding E).
function _applyScale(verb) {
  const ratio = _pendingRatio;
  if (!(Number.isFinite(ratio) && ratio > 0)) return;
  const targets = _scaleTargets();
  if (!targets.length) return;
  _pendingRatio = null;
  push(verb === 'convert' ? new RescaleObjectCommand(targets, ratio) : new SetScaleLabelCommand(targets, ratio));
  _render();
}

function _stageRatio(ratio) {
  _pendingRatio = (Number.isFinite(ratio) && ratio > 0) ? ratio : null;
  _render();
}

function _ratioTargetIds(selectedIds, objects) {
  const ids = new Set();
  for (const id of selectedIds ?? []) {
    if (!objects?.[id]) continue;
    ids.add(id);
    for (const partId of logicalObjectPartIds(id, objects)) ids.add(partId);
  }
  return [...ids].filter(id => objects?.[id]);
}

// True world extents of the nodes and every mesh under them (a picked glTF
// root, a group node), not Babylon's rotated local box (L2-04).
function _worldSize(nodes) {
  return worldSizeOf(nodes.flatMap(hierarchyMeshes));
}

function _wireScaleRow() {
  const ratioSelect = _bodyEl.querySelector('[data-ratio-preset]');
  const ratioInput  = _bodyEl.querySelector('[data-ratio-input]');
  ratioSelect?.addEventListener('change', () => {
    const val = parseFloat(ratioSelect.value);
    if (Number.isFinite(val) && val > 0) _stageRatio(val);
  });
  ratioInput?.addEventListener('change', () => {
    const parsed = parseScaleRatioText(ratioInput.value);
    if (parsed) _stageRatio(parsed); else _refuseEntry('[data-ratio-input]', 'properties.ratioInvalid');
  });
  ratioInput?.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const parsed = parseScaleRatioText(ratioInput.value);
    if (!parsed) { ratioInput.blur(); return; }   // the change handler says why, once
    _pendingRatio = parsed;
    const verb = _bodyEl.querySelector('.pp-ratio-row')?.dataset.scaleDefault ?? 'label';
    const cons = scaleConsequence(_scaleTargets().map(id => objectRatio(getState().scene.objects[id])), parsed);
    if (cons.changed) _applyScale(verb); else _stageRatio(parsed);
  });
  if (ratioInput) escEnter(ratioInput, () => { _pendingRatio = null; _render(); });
  _bodyEl.querySelectorAll('[data-scale-verb]').forEach(b => {
    b.addEventListener('click', () => _applyScale(b.dataset.scaleVerb));
  });
}

// A refused entry snaps back and says why, at the field and in a toast (cia W-07).
function _refuseEntry(selector, key) {
  _render();
  const message = t(key, { max: MAX_SIDE_MM / 1000 });
  const input = _bodyEl.querySelector(selector);
  input?.setAttribute('aria-invalid', 'true');
  input?.setAttribute('title', message);
  Toast.show(message, 'warning', 4000);
}

const _longestMM = sizeBU => (sizeBU ? Math.max(sizeBU.x, sizeBU.y, sizeBU.z) * BU_TO_MM : 0);

function _wireTransformSection(meshId) {
  if (!meshId) return;

  _wireScaleRow();

  _bodyEl.querySelectorAll('[data-xform]').forEach(input => {
    if (input.disabled) return;
    input.addEventListener('change', () => _commitTransformInput(meshId, input));
    escEnter(input, _render);
  });

  _bodyEl.querySelectorAll('[data-size-axis]').forEach(input => {
    if (input.disabled) return;
    input.addEventListener('change', () => _commitSizeInput(meshId, input));
    escEnter(input, _render);
  });

  _wireScaleLock();

  _bodyEl.querySelector('[data-action="dropToBed"]')?.addEventListener('click', () => {
    const cmd = new BedPlacementCommand(Selection.getSelectedIds(), 'drop');
    if (cmd.affectedIds?.length) push(cmd);
  });

  _bodyEl.querySelector('[data-copy="transform"]')?.addEventListener('click', (e) => {
    e.stopPropagation();   // header click toggles section collapse; copy must not
    _copyTransformFromActive();
  });
}

function _wireScaleLock() {
  const lockBtn = _bodyEl.querySelector('[data-action="scaleLock"]');
  lockBtn?.addEventListener('click', () => {
    const cur = getState().ui?.scaleLocked !== false;
    setState(s => ({ ...s, ui: { ...s.ui, scaleLocked: !cur } }), { silent: true });
    SceneManager.setScaleLock(!cur);
    _render();
  });
}

/**
 * Propagate the active mesh's absolute position / rotation / scale to every
 * OTHER selected mesh. Blender's `Ctrl+L Link Transforms` analogue. Pushed as
 * a single `TransformCommand` so undo reverses every affected mesh in one
 * step. No-op when fewer than two meshes are selected or the active mesh
 * cannot be resolved.
 */
function _copyTransformFromActive() {
  const activeId = Selection.getActiveId();
  const selIds = Selection.getSelectedIds();
  if (!activeId || selIds.length < 2) return;
  const activeMesh = AssetLoader.getBabylonMesh(activeId);
  if (!activeMesh) return;
  const source = _readTransform(activeMesh);
  const objects = getState().scene.objects;

  const prev = {};
  const next = {};
  const skipped = [];
  for (const id of selIds) {
    if (id === activeId) continue;
    /*
     * A MULTI-PART target is refused, not approximated (decided 2026-11-13 with Fable, after the
     * old code was found tearing one apart: source at x=10, target lead at x=0 with its arm at
     * x=1, and after the click the lead was at 10 and the arm still at 1 — nine units from its
     * body, in one undoable step).
     *
     * The parts of a logical object are not parented to the lead; each carries its own absolute
     * transform. So copying ONE transform onto the lead alone tears the object, and the obvious
     * repair — apply the delta `M_src · M_lead⁻¹` to every part — is worse than it looks: with a
     * non-uniform scale ratio and a part rotated relative to the lead, `Δ · M_part` contains
     * SHEAR, which a position/rotation/scale triple cannot hold. Babylon's `decompose` drops it
     * without complaint, and that is the deformation nobody sees until the print fails.
     *
     * The lead's pivot is also an import accident, so "make the lead's transform equal the
     * source's" is a rule we would be inventing. The gizmo's per-part delta is not a precedent for
     * it: there the operator is watching a live drag, not deriving a delta from two unrelated
     * absolute transforms.
     *
     * Position-only was rejected as the middle: copying position alone drops the target on top of
     * the source, which in print prep is a collision, and a button that copies everything for some
     * objects and one channel for others is a new silent asymmetry.
     */

    if (logicalObjectPartIds(id, objects).length > 1) {
      skipped.push(objects[id]?.name ?? id);
      continue;
    }
    const m = AssetLoader.getBabylonMesh(id);
    if (!m) continue;
    prev[id] = _readTransform(m);
    next[id] = {
      position: { ...source.position },
      rotation: { ...source.rotation },
      scaling:  { ...source.scaling },
    };
  }
  // Named, and told what to use instead, so the refusal is not a dead end.
  if (skipped.length) Toast.show(t('toast.copyTransformSkippedParts', { names: skipped.join(', ') }), 'warning', 8000);
  // No command when everything was refused: an empty undo step is its own small lie.
  if (!Object.keys(next).length) return;
  push(new TransformCommand(prev, next));
}

/**
 * Edit the world-space Size readout directly: scale the mesh so its bounding
 * box matches the typed mm value. Scale-locked (default) keeps proportions —
 * one axis edit scales all three; unlocked scales the edited axis only.
 * One undoable TransformCommand either way (field request).
 */
function _commitSizeInput(meshId, input) {
  const mesh = AssetLoader.getBabylonMesh(meshId);
  if (!mesh) return;
  const targetIds = logicalTargetIds(meshId);
  const axis = input.dataset.sizeAxis;
  const newMM = parseFloat(input.value);
  const sizeBU = targetIds.length > 1
    ? _worldSize(targetIds.map(id => AssetLoader.getBabylonMesh(id)).filter(Boolean))
    : _worldSize([mesh]);
  const curMM = sizeBU ? sizeBU[axis] * BU_TO_MM : 0;
  const locked = getState().ui?.scaleLocked !== false;
  const longest = _longestMM(sizeBU);
  const problem = sizeEntryProblem(newMM, locked && curMM > 1e-6 ? longest * newMM / curMM : Math.max(longest, newMM));
  if (problem) { _refuseEntry(`[data-size-axis="${axis}"]`, problem); return; }
  if (curMM <= 1e-6) { _render(); return; }
  const factor = newMM / curMM;
  if (Math.abs(factor - 1) < 1e-9) return;

  const prev = {};
  const next = {};
  for (const id of targetIds) {
    const target = AssetLoader.getBabylonMesh(id);
    if (!target) continue;
    prev[id] = _captureAbsolute(target);
    next[id] = _captureAbsolute(target);
    if (locked) {
      next[id].scaling.x = prev[id].scaling.x * factor;
      next[id].scaling.y = prev[id].scaling.y * factor;
      next[id].scaling.z = prev[id].scaling.z * factor;
    } else {
      next[id].scaling[axis] = prev[id].scaling[axis] * factor;
    }
  }
  push(new TransformCommand(prev, next));
  _render();
}

function _commitTransformInput(meshId, input) {
  const mesh = AssetLoader.getBabylonMesh(meshId);
  if (!mesh) return;

  const targetIds = logicalTargetIds(meshId);
  const prev = {};
  const next = {};

  const which = input.dataset.xform;
  const axis  = input.dataset.axis;
  const value = parseFloat(input.value);
  const field = `[data-xform="${which}"][data-axis="${axis}"]`;
  if (!Number.isFinite(value)) { _refuseEntry(field, 'properties.enterNumber'); return; }
  if (which === 'scaling') {
    const prevVal = _captureAbsolute(mesh).scaling[axis];
    const factor = Math.abs(prevVal) > 1e-9 ? value / Math.abs(prevVal) : 1;
    const sizeBU = targetIds.length > 1
      ? _worldSize(targetIds.map(id => AssetLoader.getBabylonMesh(id)).filter(Boolean))
      : _worldSize([mesh]);
    const problem = sizeEntryProblem(value, _longestMM(sizeBU) * Math.max(1, factor));
    if (problem) { _refuseEntry(field, problem); return; }
  }

  for (const id of targetIds) {
    const target = AssetLoader.getBabylonMesh(id);
    if (!target) continue;
    prev[id] = _captureAbsolute(target);
    next[id] = _captureAbsolute(target);  // start from current; override one component
    if (which === 'position') {
      next[id].position[axis] = value / BU_TO_MM;   // mm → BU
    } else if (which === 'rotation') {
      const e = _quatToEulerDeg(next[id].rotation);
      e[axis] = value;
      const q = BABYLON.Quaternion.FromEulerAngles(
        e.x * Math.PI / 180, e.y * Math.PI / 180, e.z * Math.PI / 180,
      );
      next[id].rotation = { x: q.x, y: q.y, z: q.z, w: q.w };
    } else if (which === 'scaling') {
      const locked = getState().ui?.scaleLocked !== false;
      if (locked) {
        const prevVal = prev[id].scaling[axis];
        const ratio = (Number.isFinite(prevVal) && Math.abs(prevVal) > 1e-9) ? (value / prevVal) : 1;
        next[id].scaling.x = prev[id].scaling.x * ratio;
        next[id].scaling.y = prev[id].scaling.y * ratio;
        next[id].scaling.z = prev[id].scaling.z * ratio;
        next[id].scaling[axis] = value;
      } else {
        next[id].scaling[axis] = value;
      }
    }
    if (_eq(prev[id], next[id])) {
      delete prev[id];
      delete next[id];
    }
  }
  if (!Object.keys(next).length) return;

  push(new TransformCommand(prev, next));
}

// ── Group active (task 3.6) ──────────────────────────────
//
// "Group · <name> (N objects)" + Ungroup; Object = name + Print for the whole
// subtree; Transform = Size of the group bounds, Position, Rotation of the
// group NODE (TransformCommand keyed by the group id — children follow
// rigidly) + Drop to bed. No Scale row (scale is declared per object) and no
// material slots ("Material is set per object").

function _groupObjectIds(groupId) {
  const state = getState();
  const { objectIds } = collectGroupSubtree(groupId, state);
  return objectIds.filter(id => state.scene.objects[id]);
}

function _renderGroup(groupId) {
  const { objects, groups } = getState().scene;
  const g = groups[groupId];
  const sel = Selection.getSelectedIds();
  const multi = sel.length > 1;
  const node = findGroupNode(groupId);
  const objIds = _groupObjectIds(groupId);
  const count = objIds.filter(id => !objects[id].isInternalPart).length;
  const printFlags = objIds.map(id => objects[id].isPrintPart !== false);
  const printOn = printFlags.length > 0 && printFlags.every(Boolean);
  const printMixed = printFlags.some(Boolean) && !printOn;
  const readOnly = multi || isTransformReadOnly([groupId]);
  const dis = readOnly ? 'disabled' : '';
  const roTitle = isTransformReadOnly([groupId]) ? ` title="${escapeAttr(t('properties.lockedTransformTitle'))}"` : '';

  let xformHtml = '';
  if (node) {
    const w = captureWorldNode(node);
    const pos = { x: w.position.x * BU_TO_MM, y: w.position.y * BU_TO_MM, z: w.position.z * BU_TO_MM };
    const rot = _quatToEulerDeg(w.rotation);
    const size = _worldSize([node]);
    const sizeMM = size ? { x: size.x * BU_TO_MM, y: size.y * BU_TO_MM, z: size.z * BU_TO_MM } : null;
    const sizeDis = dis || (sizeMM ? '' : 'disabled');
    xformHtml = `
      <section class="pp-section" data-section="transform"${roTitle}>
        <header class="pp-section-header">${sectionIcon('Move')}<span data-i18n-key="section.transform">Transform</span><span class="pp-section-meta">${_escape(t('properties.groupBounds'))}</span></header>
        <div class="pp-grid3">
          <label>${_escape(t('properties.sizeMm'))}</label>
          ${['x', 'y', 'z'].map(a => `<input type="number" step="0.1" min="0.001" data-group-size="${a}" value="${sizeMM ? _fmt(sizeMM[a]) : ''}" ${sizeDis}${roTitle}>`).join('')}
        </div>
        <div class="pp-grid3 pp-axes">
          <label>${_escape(t('properties.posMm'))}</label>
          ${['x', 'y', 'z'].map(a => `<input type="number" step="0.1" data-group-xform="position" data-axis="${a}" value="${_fmt(pos[a])}" ${dis}${roTitle}>`).join('')}
        </div>
        <div class="pp-grid3 pp-axes">
          <label>${_escape(t('properties.rotDeg'))}</label>
          ${['x', 'y', 'z'].map(a => `<input type="number" step="0.1" data-group-xform="rotation" data-axis="${a}" value="${_fmt(rot[a])}" ${dis}${roTitle}>`).join('')}
        </div>
        ${_renderDropToBedRow(readOnly)}
      </section>
    `;
  }

  _bodyEl.innerHTML = `
    <div class="pp-group-head" data-group-id="${escapeAttr(groupId)}">
      ${icon('Folder', { width: 14, height: 14 })}
      <span class="pp-group-title">${_escape(t('properties.groupTitle', { name: g.name }))}</span>
      <span class="pp-group-count">${_escape(t('properties.groupCount', { n: count }))}</span>
      <button type="button" class="pp-btn pp-group-ungroup" data-action="ungroup">${_escape(t('context.ungroup'))}</button>
    </div>
    <section class="pp-section" data-section="object">
      <header class="pp-section-header">${sectionIcon('Shapes')}${_escape(t('properties.object'))}${multi ? ` <span class="pp-multi">${_escape(t('properties.selectedCount', { n: sel.length }))}</span>` : ''}</header>
      <div class="pp-row">
        <label for="pp-name">${_escape(t('properties.name'))}</label>
        <input type="text" id="pp-name" value="${_escape(multi ? '—' : g.name)}" ${multi ? 'disabled' : ''}>
      </div>
      ${objIds.length ? _renderPrintRow(printOn, { mixed: printMixed, group: true }) : ''}
    </section>
    ${xformHtml}
    <p class="pp-group-material">${icon('Info', { width: 12, height: 12 })}<span>${_escape(t('properties.groupMaterialNote'))}</span></p>
  `;

  _wireGroup(groupId, objIds, readOnly);
  _applyAndWireSectionCollapse();
  _retranslate(_bodyEl);
}

function _wireGroup(groupId, objIds, readOnly) {
  const g = getState().scene.groups[groupId];
  const nameEl = _bodyEl.querySelector('#pp-name');
  if (nameEl && !nameEl.disabled) {
    nameEl.addEventListener('change', () => {
      const next = nameEl.value.trim();
      if (next && next !== g.name) push(new RenameCommand(groupId, g.name, next));
    });
    escEnter(nameEl, () => { nameEl.value = g.name; nameEl.blur(); });
  }

  _bodyEl.querySelector('[data-action="ungroup"]')?.addEventListener('click', () => {
    push(new UngroupCommand([groupId]));
  });

  // Print for the subtree: one undo step; only objects whose flag differs.
  wireToggles(_bodyEl, '#pp-is-print-part', (_el, next) => {
    const objects = getState().scene.objects;
    const work = objIds.filter(id => objects[id] && !objects[id].isInternalPart && (objects[id].isPrintPart !== false) !== next);
    if (!work.length) return;
    beginBatch(t(next ? 'history.markToPrint' : 'history.unmarkAsPrintPart'));
    for (const id of work) push(new PrintPartCommand(id, !next, next));
    endBatch();
  });

  if (readOnly) return;

  _bodyEl.querySelectorAll('[data-group-xform]').forEach(input => {
    input.addEventListener('change', () => _commitGroupTransform(groupId, input.dataset.groupXform, input.dataset.axis, parseFloat(input.value)));
    escEnter(input, _render);
  });
  _bodyEl.querySelectorAll('[data-group-size]').forEach(input => {
    input.addEventListener('change', () => _commitGroupSize(groupId, input.dataset.groupSize, parseFloat(input.value)));
    escEnter(input, _render);
  });
  _bodyEl.querySelector('[data-action="dropToBed"]')?.addEventListener('click', () => _dropGroupToBed(groupId));
}

function _pushGroupTransform(groupId, mutate, label = null) {
  const node = findGroupNode(groupId);
  if (!node) return;
  const prev = captureWorldNode(node);
  const next = JSON.parse(JSON.stringify(prev));
  if (mutate(next, prev, node) === false || _eq(prev, next)) { _render(); return; }
  const cmd = new TransformCommand({ [groupId]: prev }, { [groupId]: next });
  if (label) cmd.label = label;
  push(cmd);
}

function _commitGroupTransform(groupId, which, axis, value) {
  if (!Number.isFinite(value)) { _render(); return; }
  _pushGroupTransform(groupId, (next) => {
    if (which === 'position') { next.position[axis] = value / BU_TO_MM; return true; }
    const e = _quatToEulerDeg(next.rotation);
    e[axis] = value;
    const q = BABYLON.Quaternion.FromEulerAngles(e.x * Math.PI / 180, e.y * Math.PI / 180, e.z * Math.PI / 180);
    next.rotation = { x: q.x, y: q.y, z: q.z, w: q.w };
    return true;
  });
}

function _commitGroupSize(groupId, axis, newMM) {
  _pushGroupTransform(groupId, (next, prev, node) => {
    const size = _worldSize([node]);
    const curMM = size ? size[axis] * BU_TO_MM : 0;
    if (!Number.isFinite(newMM) || newMM <= 0 || curMM <= 1e-6) return false;
    const factor = newMM / curMM;
    if (getState().ui?.scaleLocked !== false) {
      for (const a of ['x', 'y', 'z']) next.scaling[a] = prev.scaling[a] * factor;
    } else {
      next.scaling[axis] = prev.scaling[axis] * factor;
    }
    return true;
  });
}

function _dropGroupToBed(groupId) {
  _pushGroupTransform(groupId, (next, _prev, node) => {
    let bounds;
    try { bounds = node.getHierarchyBoundingVectors(true); } catch { return false; }
    const d = dropToBedDelta({ min: bounds.min, max: bounds.max });
    next.position.y += d.y;
    return true;
  }, t('history.dropToBed'));
}

// ── Helpers ──────────────────────────────────────────────

function _readTransform(mesh) {
  mesh.computeWorldMatrix(true);
  const ap = mesh.getAbsolutePosition();
  const aq = mesh.absoluteRotationQuaternion ?? BABYLON.Quaternion.Identity();
  const as = mesh.absoluteScaling ?? mesh.scaling;
  return {
    position: { x: ap.x, y: ap.y, z: ap.z },
    rotation: { x: aq.x, y: aq.y, z: aq.z, w: aq.w },
    scaling:  { x: as.x, y: as.y, z: as.z },
  };
}

function _captureAbsolute(mesh) {
  return _readTransform(mesh);
}

function _quatToEulerDeg(q) {
  const quat = new BABYLON.Quaternion(q.x, q.y, q.z, q.w);
  const e = quat.toEulerAngles();
  return { x: e.x * 180 / Math.PI, y: e.y * 180 / Math.PI, z: e.z * 180 / Math.PI };
}

function _eq(a, b) {
  for (const k of ['x', 'y', 'z']) {
    if (Math.abs(a.position[k] - b.position[k]) > 1e-9) return false;
    if (Math.abs(a.scaling[k]  - b.scaling[k])  > 1e-9) return false;
  }
  for (const k of ['x', 'y', 'z', 'w']) {
    if (Math.abs(a.rotation[k] - b.rotation[k]) > 1e-9) return false;
  }
  return true;
}

// Re-exported so the panel's public surface is unchanged by the 2026-11-14 cut; it is defined in
// ./properties/SourceRow.js, with the row that uses it.
export { sourceStatusFor };

export const PropertiesPanel = { init };

export const __test = {
  ratioTargetIds: _ratioTargetIds,
  copyTransformFromActive: _copyTransformFromActive,
  defaultScaleVerb,
  scaleConsequence,
  sourceStatusFor,
};
