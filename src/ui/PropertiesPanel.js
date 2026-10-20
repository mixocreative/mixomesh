import { EVENTS } from '../core/events.js';
import { subscribe, setState, getState } from '../core/StateManager.js';
import { t, applyTranslations } from '../i18n/index.js';
import { runFindMoved } from './FindMoved.js';
import { canFindMoved, getAssetStatus, sourcesOf } from '../core/persist/AssetResolver.js';
import { refreshAsset } from '../core/persist/ProjectLoader.js';
import { PersistenceManager } from '../core/PersistenceManager.js';
import { qualifiedDisplayName } from '../core/assets/DisplayNames.js';
import { Status } from './Status.js';
import { Toast } from './Toast.js';
import { Selection } from '../core/Selection.js';
import { AssetLoader } from '../core/AssetLoader.js';
import { SOURCE_UNIT_FACTORS } from '../core/ImportNormalizer.js';
import { SceneManager } from '../core/SceneManager.js';
import {
  push, beginBatch, endBatch,
  TransformCommand, VisibilityCommand, LockCommand, RenameCommand,
  ShaderAssignCommand, ShaderDuplicateCommand, UVOverrideCommand,
  PrintPartCommand, SourceUnitCommand, RescaleObjectCommand,
  SetScaleLabelCommand, ratioSourceOf, RATIO_SOURCE,
  BedPlacementCommand, UngroupCommand, collectGroupSubtree,
} from '../core/HistoryManager.js';
import { findGroupNode, captureWorldNode } from '../core/commands/support.js';
import { dropToBedDelta } from '../core/placement/BedPlacement.js';
import { SCALE_PRESETS, BU_TO_MM } from '../core/PrintManager.js';
import { ShaderPanel, renderShaderPreview } from './ShaderPanel.js';
import { Modal } from './Modal.js';
import { icon, sectionIcon } from '../core/Icons.js';
import {
  authoredScaleFromAsset, formatScaleRatio, parseScaleRatioText, objectRatio, effectiveRatioInfo,
} from '../core/scale/ScaleMath.js';
import { logicalObjectPartIds } from '../core/LogicalObjects.js';
import { escapeHtml as _escape, escapeAttr } from './renderSafe.js';
import { escEnter, wireNumbers, wireToggles, reflectToggle } from './lib/fields.js';
import { createCollapseController } from './lib/sections.js';
import { renderRefinementSection, wireRefinementSection } from './refinement/RefinementSection.js';
import { RefinementController } from '../core/refinement/RefinementController.js';

const BABYLON = window.BABYLON;

// SOURCE_UNIT_FACTORS imported from ImportNormalizer.js — single source of
// truth for the import-normalization seam (no more hand-synced duplicate).
const SOURCE_UNIT_LABEL_KEYS = {
  meters:      'unit.meters',
  centimeters: 'unit.centimeters',
  millimeters: 'unit.millimeters',
  inches:      'unit.inches',
  feet:        'unit.feet',
};

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
  document.addEventListener('pointerdown', _closeSourceMenuOnOutside, true);
  // Locale changes must rebuild body markup generated from t(), then refresh
  // static header/body data-i18n attributes in one root walk.
  subscribe(EVENTS.LOCALE_CHANGED, () => { _render(); _retranslate(_root); });
  Modal.register('shader-picker', _shaderPickerRenderer);
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
    ${asset ? _renderSourceUnitSection(asset) : ''}
    ${_renderShaderSection(obj)}
    ${_renderUVOverrideSection(obj)}
  `;

  _wireObjectSection(obj, asset);
  wireRefinementSection(_bodyEl, activeId, sel);
  _wireTransformSection(activeId);
  if (asset) _wireSourceUnitSection(asset);
  _wireShaderSection();
  _wireUVOverrideSection(obj);
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
      ${asset && !multi ? _renderSourceRow(obj, asset) : ''}
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
  if (asset) _wireSourceRow(asset);
}

// ── Source row (task 4.6, Properties part) ───────────────

const SOURCE_STATUS_KEYS = {
  embedded: 'properties.sourceStatus.embedded',
  linked:   'properties.sourceStatus.linked',
  changed:  'properties.sourceStatus.changed',
  missing:  'properties.sourceStatus.missing',
};

/**
 * The status the Source chip shows: the per-session resolution status when
 * the asset was resolved at load; a ghost is always missing; otherwise a
 * fresh import is "linked" when it carries a link, else an embedded copy.
 * @param {object} obj
 * @param {object} asset
 * @returns {'embedded'|'linked'|'changed'|'missing'}
 */
export function sourceStatusFor(obj, asset) {
  if (obj?.isGhost) return 'missing';
  const st = asset ? getAssetStatus(asset.id) : null;
  if (st && SOURCE_STATUS_KEYS[st]) return st;
  return asset && sourcesOf(asset).length ? 'linked' : 'embedded';
}

function _renderSourceRow(obj, asset) {
  const status = sourceStatusFor(obj, asset);
  const name = qualifiedDisplayName(asset, getState().scene.assetLibrary) || asset.filename || '';
  const hasLink = sourcesOf(asset).length > 0;
  const findOk = canFindMoved(asset.id);
  return `
    <div class="pp-row pp-source-row" data-source-status="${escapeAttr(status)}">
      <label>${_escape(t('properties.source'))}</label>
      <div class="pp-source">
        <span class="pp-source-chip pp-source-${escapeAttr(status)}">${_escape(t(SOURCE_STATUS_KEYS[status]))}</span>
        <span class="pp-source-name" title="${escapeAttr(name)}">${_escape(name)}</span>
        <button type="button" class="pp-source-more" data-source-menu aria-haspopup="menu" aria-expanded="false"
                title="${escapeAttr(t('properties.sourceMenu'))}" aria-label="${escapeAttr(t('properties.sourceMenu'))}">${icon('MoreHorizontal', { width: 14, height: 14 })}</button>
        <div class="pp-menu" role="menu" hidden>
          <button type="button" role="menuitem" data-source-action="refresh"${hasLink ? '' : ' disabled'}>${_escape(t('properties.sourceRefresh'))}</button>
          <button type="button" role="menuitem" data-source-action="find"${findOk ? '' : ' disabled'}>${_escape(t('asset.findMoved.action'))}</button>
          <button type="button" role="menuitem" data-source-action="relink">${_escape(t('properties.sourceRelink'))}</button>
        </div>
      </div>
    </div>
  `;
}

function _wireSourceRow(asset) {
  const btn = _bodyEl.querySelector('[data-source-menu]');
  const menu = btn?.parentElement?.querySelector('.pp-menu');
  if (!btn || !menu) return;
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = menu.hidden;
    menu.hidden = !open;
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) menu.querySelector('button:not([disabled])')?.focus();
  });
  menu.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { _closeSourceMenu(); btn.focus(); }
  });
  menu.querySelectorAll('[data-source-action]').forEach(item => {
    item.addEventListener('click', () => {
      _closeSourceMenu();
      _runSourceAction(item.dataset.sourceAction, asset.id);
    });
  });
}

function _runSourceAction(action, assetId) {
  if (action === 'find') {
    Status.guard(async () => { if (await runFindMoved(assetId)) _render(); });
    return;
  }
  if (action === 'refresh') {
    Status.guard(async () => {
      const ok = await refreshAsset(assetId);
      if (!ok) Toast.show(t('properties.sourceRefreshFailed'), 'warning');
      _render();
    }, { title: t('properties.sourceRefresh') });
    return;
  }
  if (action === 'relink') {
    Status.guard(async () => { await PersistenceManager.relinkAsset(assetId); _render(); },
      { title: t('properties.sourceRelink') });
  }
}

function _closeSourceMenu() {
  const menu = _bodyEl?.querySelector('.pp-source .pp-menu');
  if (!menu || menu.hidden) return;
  menu.hidden = true;
  _bodyEl.querySelector('[data-source-menu]')?.setAttribute('aria-expanded', 'false');
}

function _closeSourceMenuOnOutside(e) {
  const wrap = _bodyEl?.querySelector('.pp-source');
  if (wrap && !wrap.contains(e.target)) _closeSourceMenu();
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
  const sizeBU = (multi || resolved.length > 1) ? _aggregateWorldSize(resolved.map(r => r.mesh))
                                                : _hierarchyWorldSize(mesh);
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
        <input type="number" step="0.001" data-xform="scaling" data-axis="x" value="${_fmt(sc.x, 4)}" ${dis}${roTitle}>
        <input type="number" step="0.001" data-xform="scaling" data-axis="y" value="${_fmt(sc.y, 4)}" ${dis}${roTitle}>
        <input type="number" step="0.001" data-xform="scaling" data-axis="z" value="${_fmt(sc.z, 4)}" ${dis}${roTitle}>
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

function _hierarchyWorldSize(mesh) {
  if (!mesh) return null;
  // getHierarchyBoundingVectors includes child meshes — correct for multi-mesh
  // glTF imports where the picked node is a parent transform.
  try {
    const r = mesh.getHierarchyBoundingVectors(true);
    return { x: r.max.x - r.min.x, y: r.max.y - r.min.y, z: r.max.z - r.min.z };
  } catch {
    const bi = mesh.getBoundingInfo?.();
    if (!bi) return null;
    const d = bi.boundingBox.maximumWorld.subtract(bi.boundingBox.minimumWorld);
    return { x: d.x, y: d.y, z: d.z };
  }
}

function _aggregateWorldSize(meshes) {
  if (!meshes.length) return null;
  let min = new BABYLON.Vector3( Infinity,  Infinity,  Infinity);
  let max = new BABYLON.Vector3(-Infinity, -Infinity, -Infinity);
  for (const m of meshes) {
    if (!m) continue;
    try {
      const r = m.getHierarchyBoundingVectors(true);
      min = BABYLON.Vector3.Minimize(min, r.min);
      max = BABYLON.Vector3.Maximize(max, r.max);
    } catch {
      const bi = m.getBoundingInfo?.();
      if (!bi) continue;
      min = BABYLON.Vector3.Minimize(min, bi.boundingBox.minimumWorld);
      max = BABYLON.Vector3.Maximize(max, bi.boundingBox.maximumWorld);
    }
  }
  if (!Number.isFinite(min.x)) return null;
  return { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z };
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
    if (parsed) _stageRatio(parsed); else _render();
  });
  ratioInput?.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const parsed = parseScaleRatioText(ratioInput.value);
    if (!parsed) { _render(); return; }
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

  const prev = {};
  const next = {};
  for (const id of selIds) {
    if (id === activeId) continue;
    const m = AssetLoader.getBabylonMesh(id);
    if (!m) continue;
    prev[id] = _readTransform(m);
    next[id] = {
      position: { ...source.position },
      rotation: { ...source.rotation },
      scaling:  { ...source.scaling },
    };
  }
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
  const targetIds = _logicalTargetIds(meshId);
  const axis = input.dataset.sizeAxis;
  const newMM = parseFloat(input.value);
  const sizeBU = targetIds.length > 1
    ? _aggregateWorldSize(targetIds.map(id => AssetLoader.getBabylonMesh(id)).filter(Boolean))
    : _hierarchyWorldSize(mesh);
  const curMM = sizeBU ? sizeBU[axis] * BU_TO_MM : 0;
  if (!Number.isFinite(newMM) || newMM <= 0 || curMM <= 1e-6) { _render(); return; }
  const factor = newMM / curMM;
  if (Math.abs(factor - 1) < 1e-9) return;

  const prev = {};
  const next = {};
  const locked = getState().ui?.scaleLocked !== false;
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

  const targetIds = _logicalTargetIds(meshId);
  const prev = {};
  const next = {};

  const which = input.dataset.xform;
  const axis  = input.dataset.axis;
  const value = parseFloat(input.value);
  if (!Number.isFinite(value)) { _render(); return; }

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

function _logicalTargetIds(meshId) {
  const ids = logicalObjectPartIds(meshId, getState().scene.objects);
  return ids.length ? ids : [meshId];
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
    const size = _hierarchyWorldSize(node);
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
    const size = _hierarchyWorldSize(node);
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

// ── Authored Scale section ───────────────────────────────

function _renderSourceUnitSection(asset) {
  const authoredScale = authoredScaleFromAsset(asset);
  const opts = Object.entries(SOURCE_UNIT_LABEL_KEYS).map(([k, labelKey]) =>
    `<option value="${k}" ${k === asset.sourceUnit ? 'selected' : ''}>${_escape(t(labelKey))}</option>`
  ).join('');
  const warn = asset.unitConfirmed === false
    ? `<span class="pp-warn" title="${escapeAttr(t('properties.sourceUnitUnconfirmed'))}">${icon('AlertTriangle', { width: 12, height: 12 })}</span>`
    : '';
  return `
    <section class="pp-section" data-section="source-unit">
      <header class="pp-section-header">${sectionIcon('Ruler')}${_escape(t('properties.authoredScale'))} ${warn}</header>
      <div class="pp-row">
        <label>${_escape(t('properties.sourceUnit'))}</label>
        <select id="pp-source-unit">${opts}</select>
      </div>
      <div class="pp-row pp-row-inline">
        <span class="pp-hint">${_escape(t('properties.authoredAt', { ratio: formatScaleRatio(authoredScale.authoredRatio) }))}</span>
        <button class="pp-btn" id="pp-confirm-unit" ${asset.unitConfirmed ? 'disabled' : ''}>${_escape(t('properties.confirm'))}</button>
      </div>
      ${canFindMoved(asset.id) ? `<div class="pp-row pp-row-inline">
        <span class="pp-hint">${_escape(t('asset.findMoved.hint'))}</span>
        <button class="pp-btn" id="pp-find-moved">${_escape(t('asset.findMoved.action'))}</button>
      </div>` : ''}
    </section>
  `;
}

function _wireSourceUnitSection(asset) {
  const sel = _bodyEl.querySelector('#pp-source-unit');
  const btn = _bodyEl.querySelector('#pp-confirm-unit');

  sel?.addEventListener('change', () => {
    const newUnit = sel.value;
    if (newUnit === asset.sourceUnit) return;
    _changeSourceUnit(asset, newUnit);
  });
  _bodyEl.querySelector('#pp-find-moved')?.addEventListener('click', async () => {
    if (await runFindMoved(asset.id)) _render();
  });
  btn?.addEventListener('click', () => {
    setState(s => {
      const a = s.scene.assetLibrary[asset.id];
      if (!a) return s;
      return { ...s, scene: { ...s.scene, assetLibrary: { ...s.scene.assetLibrary, [asset.id]: { ...a, unitConfirmed: true } } } };
    });
    _render();
  });
}

function _changeSourceUnit(asset, newUnit) {
  const oldUnit = asset.sourceUnit;
  const oldF = SOURCE_UNIT_FACTORS[oldUnit] ?? 0.001;
  const newF = SOURCE_UNIT_FACTORS[newUnit] ?? 0.001;
  if (oldF <= 0 || newF <= 0) return;
  if (Math.abs(newF / oldF - 1) < 1e-12) return;

  // Destructive vertex re-bake → must be a command (Blueprint §0.1; review
  // M12). SourceUnitCommand owns pivot detach, delta bake, and state update.
  push(new SourceUnitCommand(asset.id, oldUnit, newUnit));
  Selection.refresh();
  _render();
}

// ── Shader section (binding-only slot list) ──────────────

/**
 * Slot list. Each slot represents one distinct shader currently bound to the
 * selected meshes (active mesh's bucket first). The slot exposes:
 *   • a click target that focuses the shader in the Shader Library
 *   • a combined dropdown to either replace the binding with another shader
 *     or duplicate it in place (clone + reassign in one undo entry)
 *
 * Shader *appearance* (color / texture / sliders / UV base) is edited only in
 * the Library — auto-focus brings the active mesh's shader into the editor
 * when the active object changes.
 */
function _renderShaderSection(obj) {
  const libShaders = Object.values(getState().scene.shaders);
  if (!libShaders.length) {
    return `
      <section class="pp-section" data-section="shader">
        <header class="pp-section-header">${sectionIcon('Brush')}<span data-i18n-key="section.shader">Shader</span></header>
        <div class="pp-row pp-row-inline">
          <span class="pp-hint">${_escape(t('properties.noShaders'))}</span>
        </div>
      </section>
    `;
  }

  const activeId = Selection.getActiveId();
  const selIds   = Selection.getSelectedResolved().map(r => r.id);
  const meshIds  = selIds.length ? selIds : _logicalTargetIds(obj.id);

  // Buckets by shader, then re-ordered so the active mesh's bucket is first.
  const buckets = _collectShaderBuckets(meshIds);
  const activeBucketIdx = buckets.findIndex(b => b.meshIds.includes(activeId));
  if (activeBucketIdx > 0) {
    const [active] = buckets.splice(activeBucketIdx, 1);
    buckets.unshift(active);
  }

  const slotsHtml = buckets.map(b => _renderShaderSlot(b, libShaders)).join('');

  // ↧ Copy-from-active: visible when multi-select AND the active mesh has a
  // shader to propagate. Reassigns every other selected mesh's binding to the
  // active's shader in one undo step.
  const activeObj = activeId ? getState().scene.objects[activeId] : null;
  const canCopy = meshIds.length > 1 && activeObj?.shaderId;
  const copyBtn = canCopy
    ? `<button class="pp-copy-btn" data-copy="shader" title="${escapeAttr(t('properties.copyShaderTitle'))}">↧</button>`
    : '';

  return `
    <section class="pp-section" data-section="shader">
      <header class="pp-section-header">
        ${sectionIcon('Brush')}<span data-i18n-key="section.shader">Shader</span>${copyBtn}
        <span class="pp-multi">${meshIds.length === 1 ? '' : `(${meshIds.length} meshes)`}</span>
      </header>
      <div class="pp-shader-list">${slotsHtml}</div>
    </section>
  `;
}

function _collectShaderBuckets(meshIds) {
  const objects = getState().scene.objects;
  const byShader = new Map();   // shaderId (or '' for none) → meshIds[]
  for (const id of meshIds) {
    const o = objects[id];
    if (!o) continue;
    const key = o.shaderId ?? '';
    if (!byShader.has(key)) byShader.set(key, []);
    byShader.get(key).push(id);
  }
  return Array.from(byShader.entries()).map(([shaderId, ids]) => ({
    shaderId: shaderId || null,
    meshIds:  ids,
  }));
}

function _renderShaderSlot(bucket /*, libShaders */) {
  // Empty bucket — meshes with no shader bound. One [Assign…] button opens
  // the picker modal (no Duplicate — nothing to clone from).
  if (!bucket.shaderId) {
    return `
      <div class="pp-shader-slot pp-shader-slot-empty"
           data-bucket-shader=""
           data-bucket-meshes="${escapeAttr(bucket.meshIds.join(','))}">
        <span class="pp-shader-chip pp-shader-chip-empty">${icon('AlertTriangle', { width: 12, height: 12 })}</span>
        <span class="pp-shader-name">${_escape(t('properties.noShader'))}</span>
        <span class="pp-shader-meshcount">${bucket.meshIds.length}</span>
        <button class="pp-slot-action" data-slot-assign type="button" title="${escapeAttr(t('properties.assignShaderTitle'))}">${_escape(t('properties.assign'))}</button>
      </div>
    `;
  }

  const sh = getState().scene.shaders[bucket.shaderId];
  if (!sh) return '';

  return `
    <div class="pp-shader-slot"
         data-bucket-shader="${escapeAttr(sh.id)}"
         data-bucket-meshes="${escapeAttr(bucket.meshIds.join(','))}">
      <button class="pp-slot-info" type="button" data-slot-focus="${escapeAttr(sh.id)}"
              title="${escapeAttr(t('properties.openShaderTitle', { name: sh.name }))}">
        ${renderShaderPreview(sh, 18)}
        <span class="pp-shader-name">${_escape(sh.name)}</span>
        <span class="pp-shader-meshcount" title="${escapeAttr(t('properties.meshCountInSelection', { n: bucket.meshIds.length }))}">${bucket.meshIds.length}</span>
      </button>
      <button class="pp-slot-action pp-slot-icon" data-slot-dup="${escapeAttr(sh.id)}" type="button" title="${escapeAttr(t('properties.duplicateInPlace'))}">${icon('Copy', { width: 13, height: 13 })}</button>
      <button class="pp-slot-action" data-slot-replace="${escapeAttr(sh.id)}" type="button" title="${escapeAttr(t('properties.replaceShaderTitle'))}">${_escape(t('properties.replace'))}</button>
    </div>
  `;
}

function _wireShaderSection() {
  // Slot click → focus the shader in the Library (replaces the old Edit button).
  _bodyEl.querySelectorAll('[data-slot-focus]').forEach(el => {
    el.addEventListener('click', () => {
      const id = el.dataset.slotFocus;
      if (id) ShaderPanel.focus(id);
    });
  });

  // Duplicate-in-place: clone source shader + reassign to bucket's meshes.
  _bodyEl.querySelectorAll('[data-slot-dup]').forEach(btn => {
    btn.addEventListener('click', () => {
      const sourceId = btn.dataset.slotDup;
      const slot = btn.closest('.pp-shader-slot');
      const targets = (slot?.dataset.bucketMeshes ?? '').split(',').filter(Boolean);
      if (!sourceId || !targets.length) return;
      beginBatch('Duplicate Shader in Place');
      const dup = new ShaderDuplicateCommand(sourceId);
      push(dup);
      const newId = dup.getNewId();
      if (newId) push(new ShaderAssignCommand(targets, newId));
      endBatch();
      if (newId) ShaderPanel.focus(newId);
    });
  });

  // Replace…: open shader picker modal with the bucket's current shader excluded.
  _bodyEl.querySelectorAll('[data-slot-replace]').forEach(btn => {
    btn.addEventListener('click', () => {
      const sourceId = btn.dataset.slotReplace;
      const slot = btn.closest('.pp-shader-slot');
      const targets = (slot?.dataset.bucketMeshes ?? '').split(',').filter(Boolean);
      if (!targets.length) return;
      Modal.open('shader-picker', {
        excludeShaderId: sourceId,
        title: t('properties.replaceShader'),
        onClose: (nextId) => {
          if (!nextId || nextId === sourceId) return;
          push(new ShaderAssignCommand(targets, nextId));
        },
      });
    });
  });

  // Assign…: empty-bucket variant, same picker, no exclusion.
  _bodyEl.querySelectorAll('[data-slot-assign]').forEach(btn => {
    btn.addEventListener('click', () => {
      const slot = btn.closest('.pp-shader-slot');
      const targets = (slot?.dataset.bucketMeshes ?? '').split(',').filter(Boolean);
      if (!targets.length) return;
      Modal.open('shader-picker', {
        excludeShaderId: null,
        title: t('properties.assignShader'),
        onClose: (nextId) => {
          if (!nextId) return;
          push(new ShaderAssignCommand(targets, nextId));
        },
      });
    });
  });

  _bodyEl.querySelector('[data-copy="shader"]')?.addEventListener('click', (e) => {
    e.stopPropagation();   // header click toggles section collapse; copy must not
    _copyShaderFromActive();
  });
}

/**
 * Propagate the active mesh's shader binding to every OTHER selected mesh.
 * `ShaderAssignCommand` is natively multi-mesh, so one push = one undo step.
 * Skips meshes already bound to the active shader (no-op edges).
 */
function _copyShaderFromActive() {
  const activeId = Selection.getActiveId();
  const selIds = Selection.getSelectedIds();
  if (!activeId || selIds.length < 2) return;
  const objects = getState().scene.objects;
  const activeObj = objects[activeId];
  if (!activeObj?.shaderId) return;
  const targets = selIds.filter(id => {
    if (id === activeId) return false;
    const o = objects[id];
    return o && o.shaderId !== activeObj.shaderId;
  });
  if (!targets.length) return;
  push(new ShaderAssignCommand(targets, activeObj.shaderId));
}

// Shader picker modal renderer: searchable thumbnail grid driven by
// state.scene.shaders. Closes with the picked shader id (or null on cancel).
function _shaderPickerRenderer({ data, close }) {
  const excludeId = data?.excludeShaderId ?? null;
  const title = data?.title ?? t('properties.pickShader');
  const root = document.createElement('div');
  root.className = 'modal-shader-picker';
  let query = '';

  const render = () => {
    const all = Object.values(getState().scene.shaders);
    const q = query.trim().toLowerCase();
    const filtered = all
      .filter(s => s.id !== excludeId)
      .filter(s => !q || s.name.toLowerCase().includes(q));

    root.innerHTML = `
      <header class="modal-header">
        <h3>${_escape(title)}</h3>
        <button class="modal-close" data-action="cancel" type="button" aria-label="${escapeAttr(t('btn.close'))}">×</button>
      </header>
      <div class="modal-shader-picker-search">
        <input type="search" placeholder="${escapeAttr(t('properties.searchShaders'))}" value="${escapeAttr(query)}" autocomplete="off">
      </div>
      <div class="modal-shader-picker-grid">
        ${filtered.length ? filtered.map(s => `
          <button class="modal-shader-tile" data-shader-id="${escapeAttr(s.id)}" type="button" title="${escapeAttr(s.name)}">
            ${renderShaderPreview(s, 72)}
            <span class="modal-shader-tile-name">${_escape(s.name)}</span>
          </button>
        `).join('') : `<div class="modal-empty">${_escape(t('properties.noShadersMatch'))}</div>`}
      </div>
      <footer class="modal-footer">
        <button class="modal-btn" data-action="cancel" type="button">${_escape(t('btn.cancel'))}</button>
      </footer>
    `;

    const search = root.querySelector('input[type="search"]');
    search?.addEventListener('input', (e) => {
      query = e.target.value;
      render();
    });
    root.querySelectorAll('[data-shader-id]').forEach(tile => {
      tile.addEventListener('click', () => close(tile.dataset.shaderId));
    });
    root.querySelectorAll('[data-action="cancel"]').forEach(b => {
      b.addEventListener('click', () => close(null));
    });
    search?.focus();
  };
  render();
  return root;
}

// ── UV Override section ──────────────────────────────────

function _renderUVOverrideSection(obj) {
  if (!obj.shaderId) return '';
  const override = getState().scene.uvOverrides[obj.id] ?? null;
  const active = !!override;
  const uv = override ?? { offsetX: 0, offsetY: 0, scaleX: 1, scaleY: 1, rotation: 0 };
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

function _wireUVOverrideSection(obj) {
  if (!obj.shaderId) return;
  const fields = [
    ['pp-uv-ox',  'offsetX'],
    ['pp-uv-oy',  'offsetY'],
    ['pp-uv-sx',  'scaleX'],
    ['pp-uv-sy',  'scaleY'],
    ['pp-uv-rot', 'rotation'],
  ];

  for (const [elId, key] of fields) {
    wireNumbers(_bodyEl, `#${elId}`, (_el, n) => {
      const prev = getState().scene.uvOverrides[obj.id] ?? null;
      const base = prev ?? { offsetX: 0, offsetY: 0, scaleX: 1, scaleY: 1, rotation: 0 };
      if (Math.abs(base[key] - n) < 1e-9) return;
      const next = { ...base, [key]: n };
      push(new UVOverrideCommand(obj.id, prev, next));
    }, { onInvalid: _render });
  }

  _bodyEl.querySelector('#pp-uv-reset')?.addEventListener('click', () => {
    const prev = getState().scene.uvOverrides[obj.id] ?? null;
    if (!prev) return;
    push(new UVOverrideCommand(obj.id, prev, null));
  });

  _bodyEl.querySelector('[data-copy="uv-override"]')?.addEventListener('click', (e) => {
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
  for (const k of ['offsetX', 'offsetY', 'scaleX', 'scaleY', 'rotation']) {
    if (Math.abs((a[k] ?? 0) - (b[k] ?? 0)) > 1e-9) return false;
  }
  return true;
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

function _fmt(n, dp = 2) {
  return Number.isFinite(n) ? n.toFixed(dp) : '0';
}

export const PropertiesPanel = { init };

export const __test = {
  ratioTargetIds: _ratioTargetIds,
  defaultScaleVerb,
  scaleConsequence,
  sourceStatusFor,
};
