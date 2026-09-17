import { EVENTS } from '../core/events.js';
import { subscribe, getState, setState, markDirty } from '../core/StateManager.js';
import { t, applyTranslations } from '../i18n/index.js';
import { PrintManager, SCALE_PRESETS } from '../core/PrintManager.js';
import { MeshValidator } from '../core/MeshValidator.js';
import { AssetLoader } from '../core/AssetLoader.js';
import { SceneManager } from '../core/SceneManager.js';
import { SettingsStore } from '../core/SettingsStore.js';
import { Toast } from './Toast.js';
import { reportError } from './Status.js';
import { reportBatchRepairResult } from './RepairFeedback.js';
import { icon, sectionIcon } from '../core/Icons.js';
import { Modal } from './Modal.js';
import { ProgressOverlay } from './ProgressOverlay.js';
import { Workspace } from './Workspace.js';
import { escapeHtml, escapeAttr } from './renderSafe.js';
import printersData from '../config/printers.json' with { type: 'json' };
import { formatScaleRatio, parseScaleRatioText, exportRatiosFromState } from '../core/scale/ScaleMath.js';
import { shouldDisplayObject } from '../core/LogicalObjects.js';
import { wireNumbers, wireSelects, wireToggles, reflectToggle } from './lib/fields.js';
import * as Selection from '../core/Selection.js';
import { renderCostBlock } from './print/CostBlock.js';

// Printer profiles maintained in `config/printers.json`; they seed build-area
// reference dimensions only. Export format is chosen by the buttons below.
// `custom` entry has all-null bed dims; user types XYZ manually.
export const PRINTERS = printersData;

let _bodyEl = null;
let _root   = null;
let _activeTab = 'scale'; // 'scale' | 'validation' | 'bed' | 'export'

// Walk every element under `root` that carries data-i18n-key and rewrite its
// textContent through t(). MUST use textContent — translations are plain text,
// never HTML (translator-safety rule from spec §Security).
function _retranslate(root) {
  applyTranslations(root);
}

export function init() {
  _bodyEl = document.getElementById('rp-print-body');
  _root   = document.getElementById('rp-print');
  if (!_bodyEl) return;
  _bodyEl.classList.add('pp-body');
  // Locale changes must rebuild tab/body markup generated from t(), then
  // refresh the static header/body data-i18n attributes in one root walk.
  subscribe(EVENTS.LOCALE_CHANGED, () => { _render(); _retranslate(_root); });

  // Re-render on state changes. (EVENTS.OBJECT_ADDED never existed — the
  // import signal is ASSET_INSTANTIATED; review M11.)
  const events = [
    EVENTS.SELECTION_CHANGED,
    EVENTS.ASSET_INSTANTIATED,
    EVENTS.OBJECT_UPDATED,
    EVENTS.OBJECT_REMOVED,
    EVENTS.OBJECT_RESTORED,
    EVENTS.VALIDATION_COMPLETE,   // cache updates from import auto-validate (A6)
    // Cost block volume depends on live geometry (task 6) — undo/redo of a
    // boolean/repair/transform command can change it without a matching
    // OBJECT_UPDATED for every affected mesh, so listen to history directly.
    EVENTS.HISTORY_PUSHED,
    EVENTS.HISTORY_UNDONE,
    EVENTS.HISTORY_REDONE,
  ];
  for (const ev of events) subscribe(ev, _render);
  // A print reset (or reset-all) rewrote print settings — re-render to show them.
  subscribe(EVENTS.SETTINGS_RESET, _render);

  // B5 toast click-through: a clicked validation toast surfaces this panel's
  // Validation tab.
  subscribe(EVENTS.VALIDATION_FOCUS_REQUESTED, _focusValidation);

  // Register validation modals
  Modal.register('validationErrors', _renderValidationErrorsModal);
  Modal.register('exportGate', _renderExportGateModal);

  _render();
}

/**
 * Bring the Validation tab on screen: switch to the Print workspace (the
 * only one whose right column shows this panel), clear a manual right-panel
 * collapse, expand the section if the user folded it, then activate the tab.
 */
function _focusValidation() {
  Workspace.setWorkspace('print');
  if (getState().ui.panelCollapsed?.right === true) Workspace.togglePanel('right');
  const sec = document.getElementById('rp-print');
  if (sec?.classList.contains('collapsed')) {
    sec.classList.remove('collapsed');
    sec.querySelector('.rp-section-header')?.setAttribute('aria-expanded', 'true');
  }
  _activeTab = 'validation';
  _render();
}

// ── Tabs ──────────────────────────────────────────────────

function _renderTabs() {
  // Preview controls (wireframe edges, matte/flat) moved to the viewport
  // toggles under the NavCube (ui/ViewportToggles.js) so they're reachable
  // from every workspace — no Preview tab.
  const tabs = ['scale', 'validation', 'bed', 'export'];
  const labelKeys = {
    scale: 'print.tab.scale',
    validation: 'print.tab.validation',
    bed: 'print.tab.bed',
    export: 'print.tab.export',
  };
  const tabIcons = {
    scale: 'Percent',
    validation: 'CheckCircle',
    bed: 'Maximize',
    export: 'FileDown',
  };

  let html = `<div class="pp-tabs" role="tablist" aria-label="${escapeAttr(t('print.settingsAria'))}">`;
  for (const tab of tabs) {
    const active = tab === _activeTab ? ' active' : '';
    const selected = tab === _activeTab ? 'true' : 'false';
    html += `<button class="pp-tab${active}" data-tab="${escapeAttr(tab)}" role="tab" aria-selected="${selected}">${sectionIcon(tabIcons[tab])}${escapeHtml(t(labelKeys[tab]))}</button>`;
  }
  // ↺ resets the whole print settings slice (scale / bed / export) — they
  // share one state slice, so one button covers all three settings tabs.
  html += `<button class="pp-tab-reset" data-act="reset-print" title="${escapeAttr(t('print.resetTitle'))}" aria-label="${escapeAttr(t('print.resetTitle'))}">${sectionIcon('RotateCcw')}</button>`;
  html += '</div>';

  const el = document.createElement('div');
  el.innerHTML = html;
  el.querySelectorAll('.pp-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      _activeTab = btn.dataset.tab;
      _render();
    });
  });
  el.querySelector('[data-act="reset-print"]')?.addEventListener('click',
    () => SettingsStore.resetSection('print'));

  return el;
}

// ── Scale Tab ─────────────────────────────────────────────

function _renderScaleTab() {
  const state = getState();
  // Per-object ratio redesign (2026-06-16): scene scale is now PER OBJECT
  // (Properties ▸ Transform ▸ Ratio). This tab manages the export TARGET ratios.
  // An EMPTY list = "as shown" → print at the active printable reference ratio
  // (the size in the viewport). Adding absolute ratios rescales relative to
  // that reference (e.g. 1:144 on a 1:72 object = half). One output per entry.
  //
  // Everything export-shaped (reference, factor, dims) comes from ONE
  // previewExportContext() call so the panel, the export pipeline, and the
  // dimension helper cannot drift.
  const exportRatios = exportRatiosFromState(state);
  const preview = PrintManager.previewExportContext();
  const referenceR = preview?.referenceRatio ?? 1;
  const referenceId = preview?.referenceUnit?.logicalId ?? null;

  let html = '<div class="pp-tab-content">';
  html += '<div class="pp-field-group">';

  html += `<label>${escapeHtml(t('print.printScale'))}</label>`;
  html += '<div class="pp-ratio-list" data-export-ratios>';
  if (exportRatios.length === 0) {
    // Only show the "as shown · 1:R" pill when a real reference exists —
    // showing it with referenceR=1 when there are no printable parts would
    // claim a scale that isn't actually being used by anything.
    if (preview) {
      html += `<span class="pp-ratio-pill is-asshown" title="${escapeAttr(t('print.printScaleHelp'))}">${escapeHtml(t('print.asShown'))} · ${escapeHtml(formatScaleRatio(referenceR))}</span>`;
    }
  } else {
    for (const r of exportRatios) {
      html += `<span class="pp-ratio-pill"><span class="pp-ratio-pill-label">${escapeHtml(formatScaleRatio(r))}</span><button class="pp-ratio-remove" data-remove-ratio="${escapeAttr(r)}" title="${escapeAttr(t('print.removeRatio'))}" aria-label="${escapeAttr(t('print.removeRatio'))}">×</button></span>`;
    }
  }
  html += '</div>';

  html += '<div class="pp-ratio-select">';
  html += '<select data-add-ratio class="pp-preset-select">';
  html += `<option value="">${escapeHtml(t('print.addRatio'))}</option>`;
  for (const preset of SCALE_PRESETS) {
    if (preset.ratio !== null) {
      html += `<option value="${escapeAttr(preset.ratio)}">${escapeHtml(preset.label)}</option>`;
    }
  }
  html += `<option value="custom">${escapeHtml(t('print.custom'))}</option>`;
  html += '</select>';
  html += `<input type="text" class="pp-ratio-input" data-add-ratio-input placeholder="${escapeAttr(t('print.customRatioPlaceholder'))}" hidden>`;
  html += '</div>';
  html += `<p class="pp-help">${escapeHtml(t('print.printScaleHelp'))}</p>`;

  html += '</div>';

  // Factor + dims come from the SAME preview context — single source of truth.
  // When there are no printable parts, render an em-dash placeholder rather
  // than "0.00" (which looks broken, not empty).
  if (preview) {
    html += `<div class="pp-info"><strong>${escapeHtml(t('print.exportScaleLabel'))}</strong> ${preview.factor.toFixed(2)} ${escapeHtml(t('print.exportScaleUnit'))}</div>`;

    // Example dimensions — show the export reference object so the queried mesh
    // and export factor agree even when the active selection is not printable.
    const exampleId = referenceId ?? state.selection.activeId ?? state.selection.selectedIds?.[0] ?? null;
    if (exampleId && state.scene.objects[exampleId]) {
      const dims = PrintManager.getExportedDimensions(exampleId, preview);
      if (dims) {
        html += `<div class="pp-info"><strong>${escapeHtml(t('print.exampleActiveLabel'))}</strong> ${dims.x.toFixed(1)}×${dims.y.toFixed(1)}×${dims.z.toFixed(1)} mm</div>`;
      }
    }
  } else {
    html += `<div class="pp-info"><strong>${escapeHtml(t('print.exportScaleLabel'))}</strong> —</div>`;
    html += `<p class="pp-empty">${escapeHtml(t('print.noPrintParts'))}</p>`;
  }

  html += '</div>';

  const el = document.createElement('div');
  el.innerHTML = html;

  const addRatio = (val) => {
    if (!(Number.isFinite(val) && val > 0)) return;
    setState(s => {
      const cur = exportRatiosFromState(s);
      if (cur.includes(val)) return s;
      return { ...s, print: { ...s.print, exportRatios: [...cur, val] } };
    });
    _render();
  };

  const addSel = el.querySelector('[data-add-ratio]');
  const customInput = el.querySelector('[data-add-ratio-input]');
  addSel?.addEventListener('change', (e) => {
    const v = e.target.value;
    if (v === 'custom') {
      // Reveal the inline input; reset the select so re-picking Custom re-fires.
      e.target.value = '';
      if (customInput) { customInput.hidden = false; customInput.focus(); }
    } else if (v) {
      addRatio(parseFloat(v));          // preset → add directly (_render rebuilds)
    }
  });
  const commitCustom = () => {
    const val = parseScaleRatioText(customInput.value);
    if (val) addRatio(val);             // valid → add (_render rebuilds, input hides)
    else { customInput.hidden = true; customInput.value = ''; }
  };
  customInput?.addEventListener('change', commitCustom);
  customInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter')  { e.preventDefault(); commitCustom(); }
    if (e.key === 'Escape') { customInput.hidden = true; customInput.value = ''; }
  });
  el.querySelectorAll('[data-remove-ratio]').forEach(btn => {
    btn.addEventListener('click', () => {
      const val = parseFloat(btn.dataset.removeRatio);
      setState(s => {
        const cur = exportRatiosFromState(s).filter(r => r !== val);
        // Empty ⇒ back to "as shown" (print at the export reference ratio).
        return { ...s, print: { ...s.print, exportRatios: cur } };
      });
      _render();
    });
  });

  return el;
}

// ── Validation Tab ───────────────────────────────────────
// Reads the A6 cache (state.scene.validation) instead of re-running topology
// checks on every render (review M11). "Validate All" refreshes explicitly;
// imports auto-validate already.

function _renderValidationTab() {
  const state = getState();
  const cache = state.scene.validation ?? {};

  // One row per print part; split-group siblings collapse to one display row.
  const rows = [];
  const seenGroups = new Set();
  for (const [meshId, obj] of Object.entries(state.scene.objects)) {
    if (!obj.isPrintPart || obj.isGhost) continue;
    if (!shouldDisplayObject(obj)) continue;
    if (obj.sourceGroupId) {
      if (seenGroups.has(obj.sourceGroupId)) continue;
      seenGroups.add(obj.sourceGroupId);
    }
    rows.push({ meshId, obj, entry: cache[meshId] ?? null });
  }

  // Repairable = at least one cached result still fixable (mirrors the
  // per-result Auto-Fix button's own `canFix` gate below).
  const fixableRows = rows.filter(({ entry }) => entry?.results?.some(r => r.autoFixAvailable && !r.fixed));

  let html = '<div class="pp-tab-content">';
  html += '<div class="pp-field-group">';
  html += `<button class="pp-export-btn" id="pp-validate-all">${icon('RefreshCw', { class: 'inline', width: 14, height: 14 })} ${escapeHtml(t('print.validateAll'))}</button>`;
  html += `<button class="pp-export-btn" id="pp-repair-all"${fixableRows.length ? '' : ' hidden'}>${icon('AlertTriangle', { class: 'inline', width: 14, height: 14 })} ${escapeHtml(t('print.repairAll'))}</button>`;
  html += '</div>';

  if (!rows.length) {
    html += `<p class="pp-empty">${escapeHtml(t('print.noPrintParts'))}</p>`;
  } else {
    for (const { meshId, obj, entry } of rows) {
      const results = entry?.results ?? null;
      const hasErrors = !!results?.some(r => r.severity === 'error');
      const hasWarnings = !hasErrors && !!results?.some(r => r.severity === 'warning');
      const icon_name = !results ? 'Circle' : hasErrors ? 'AlertCircle' : hasWarnings ? 'AlertTriangle' : 'Check';
      const icon_class = !results ? 'pending' : hasErrors ? 'error' : hasWarnings ? 'warning' : 'success';
      const staleBadge = entry?.stale ? ` <span class="pp-stale" title="${escapeAttr(t('print.staleTitle'))}">${escapeHtml(t('print.stale'))}</span>` : '';

      html += `<div class="pp-mesh-validation ${icon_class}">`;
      html += `<div class="pp-mesh-header">`;
      html += `${icon(icon_name, { class: 'inline' })}`;
      html += `<span class="pp-mesh-name">${escapeHtml(obj.name)}</span>${staleBadge}`;
      html += `</div>`;

      if (!results) {
        html += `<p class="pp-hint">${escapeHtml(t('print.notValidated'))}</p>`;
      } else if (results.length > 0) {
        html += '<ul class="pp-result-list">';
        for (const result of results) {
          const canFix = result.autoFixAvailable && !result.fixed;
          html += `<li class="pp-result ${escapeAttr(result.severity)}">`;
          html += `<span>${escapeHtml(result.message)}</span>`;
          if (canFix) {
            html += `<button class="pp-autofix-btn" data-mesh-id="${escapeAttr(meshId)}" data-result-type="${escapeAttr(result.type)}">${escapeHtml(t('print.autoFix'))}</button>`;
          }
          html += '</li>';
        }
        html += '</ul>';
      }

      html += '</div>';
    }
  }

  html += '</div>';

  const el = document.createElement('div');
  el.innerHTML = html;

  el.querySelector('#pp-validate-all')?.addEventListener('click', async () => {
    await MeshValidator.validateAllPrintParts();   // refreshes the cache
    _render();
  });

  el.querySelector('#pp-repair-all')?.addEventListener('click', async () => {
    if (!fixableRows.length) return;
    const ids = fixableRows.map(({ meshId }) => meshId);
    ProgressOverlay.show(t('print.repairAll'));
    try {
      const result = await MeshValidator.repairObjects(ids, {
        onProgress: (frac, name) => ProgressOverlay.update(frac, name),
      });
      reportBatchRepairResult(ids.length, result);
    } catch (err) {
      reportError(err, { title: t('toast.autoFixFailed') });
    } finally {
      ProgressOverlay.hide();
      _render();
    }
  });

  // Wire auto-fix buttons
  el.querySelectorAll('.pp-autofix-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const meshId = btn.dataset.meshId;
      const obj = getState().scene.objects[meshId];
      if (!obj) return;
      const mesh = AssetLoader.getBabylonMesh(meshId);
      if (!mesh) return;

      try {
        const results = await MeshValidator.validateMesh(mesh);
        await MeshValidator.autoFix(mesh, results);
        // Record applied fixes so they survive .mixo reload (M1): the file
        // keeps raw source bytes + ratio, so without this the restored mesh
        // comes back with its original defects. Persistence replays them.
        const applied = results.filter(r => r.fixed).map(r => r.type);
        if (applied.length) {
          setState(s => {
            const o = s.scene.objects[meshId];
            if (!o) return s;
            const fixes = [...new Set([...(o.geometryFixes ?? []), ...applied])];
            return { ...s, scene: { ...s.scene, objects: { ...s.scene.objects, [meshId]: { ...o, geometryFixes: fixes } } } };
          }, { silent: true });
          markDirty();   // persisted in .mixo (replayed on reload) — not undoable, must dirty (M4)
        }
        // I7b: a fix that changed nothing is never reported as success.
        if (applied.length) Toast.show(t('toast.fixed', { name: obj.name }), 'success', 2000);
        else Toast.show(t('toast.nothingToRepair', { name: obj.name }), 'info', 2500);
        _render();
      } catch (err) {
        reportError(err, { title: t('toast.autoFixFailed') });
      }
    });
  });

  return el;
}

// ── Export Tab ────────────────────────────────────────────

function _issueLabel(issue) {
  const key = `print.issue.${issue.code}`;
  if (issue.code === 'bed-overflow') {
    const amounts = Object.entries(issue.data?.overflowMM ?? {})
      .filter(([, value]) => value > 0)
      .map(([axis, value]) => `${axis.toUpperCase()} +${value.toFixed(1)} mm`)
      .join(', ');
    return `${t(key)}${amounts ? ` · ${amounts}` : ''}`;
  }
  if (issue.code === 'below-bed') {
    return `${t(key)} · ${Number(issue.data?.belowBedMM ?? 0).toFixed(1)} mm`;
  }
  return t(key, { n: issue.objectIds?.length ?? 0 });
}

function _issueActionLabel(issue) {
  const actions = {
    'no-print-parts': 'print.issueAction.no-print-parts',
    'missing-source': 'print.issueAction.missing-source',
    'missing-texture': 'print.issueAction.missing-texture',
    'unit-unconfirmed': 'print.issueAction.unit-unconfirmed',
    'validation-pending': 'print.issueAction.validation-pending',
    'bed-overflow': 'print.issueAction.bed-overflow',
    'below-bed': 'print.issueAction.below-bed',
    'geometry-error': 'print.issueAction.geometry',
    'geometry-warning': 'print.issueAction.geometry',
  };
  const key = actions[issue.code];
  return key ? t(key) : '';
}

function _renderReadinessSummary(readiness) {
  const statusIcon = readiness.status === 'ready' ? 'CheckCircle'
    : readiness.status === 'warning' ? 'AlertTriangle' : 'AlertCircle';
  let html = `<section class="pp-readiness ${escapeAttr(readiness.status)}" aria-label="${escapeAttr(t('print.readiness'))}">`;
  html += `<div class="pp-readiness-head">${icon(statusIcon, { class: 'inline' })}<strong>${escapeHtml(t(`print.readiness.${readiness.status}`))}</strong></div>`;
  if (!readiness.canExport) {
    html += `<p class="pp-readiness-hint">${escapeHtml(t('print.readiness.blockedHint'))}</p>`;
  }
  if (readiness.targets.length) {
    html += '<div class="pp-target-list">';
    for (const target of readiness.targets) {
      const size = target.bounds.max.map((value, axis) => Math.max(0, value - target.bounds.min[axis]));
      html += `<div class="pp-target-summary"><span>${escapeHtml(formatScaleRatio(target.ratio))}</span><span>${size.map(value => value.toFixed(1)).join('×')} mm</span></div>`;
    }
    html += '</div>';
  }
  for (const readinessIssue of readiness.issues) {
    const objectId = readinessIssue.objectIds?.[0] ?? '';
    const action = _issueActionLabel(readinessIssue);
    html += `<button type="button" class="pp-readiness-issue ${escapeAttr(readinessIssue.severity)}" data-issue-code="${escapeAttr(readinessIssue.code)}" data-object-id="${escapeAttr(objectId)}">`;
    html += `${icon(readinessIssue.severity === 'error' ? 'AlertCircle' : 'AlertTriangle', { class: 'inline' })}`;
    html += `<span class="pp-readiness-copy"><span>${escapeHtml(_issueLabel(readinessIssue))}</span>`;
    if (action) html += `<span class="pp-readiness-action">${escapeHtml(action)}</span>`;
    html += '</span>';
    html += '</button>';
  }
  html += '</section>';
  return html;
}

function _renderExportTab() {
  const state = getState();
  const bakeSolids = state.print?.objBakeSolidTextures ?? false;
  const strictExport = state.print?.strictExport ?? false;
  const repairOnImport = state.print?.repairOnImport ?? false;
  const readiness = PrintManager.getPrintReadiness();

  let html = '<div class="pp-tab-content">';

  html += _renderReadinessSummary(readiness);

  html += '<div id="pp-cost-block"></div>';

  html += '<div class="pp-field-group">';
  html += `<label>${escapeHtml(t('print.exportOptions'))}</label>`;

  html += '<div class="pp-checkbox">';
  html += '<input type="checkbox" id="pp-selected-only" data-option="selectedOnly">';
  html += `<label for="pp-selected-only">${escapeHtml(t('print.selectedOnly'))}</label>`;
  html += '</div>';

  html += '<div class="pp-checkbox">';
  html += '<input type="checkbox" id="pp-individually" data-option="individually">';
  html += `<label for="pp-individually">${escapeHtml(t('print.eachIndividually'))}</label>`;
  html += '</div>';

  html += '<div class="pp-checkbox">';
  html += `<input type="checkbox" id="pp-bake-solid" ${bakeSolids ? 'checked' : ''}>`;
  html += `<label for="pp-bake-solid">${escapeHtml(t('print.bakeSolids'))}</label>`;
  html += '</div>';

  html += '<div class="pp-checkbox">';
  html += `<input type="checkbox" id="pp-strict-export" ${strictExport ? 'checked' : ''}>`;
  html += `<label for="pp-strict-export">${escapeHtml(t('print.strictExport'))}</label>`;
  html += '</div>';

  html += '<div class="pp-checkbox">';
  html += `<input type="checkbox" id="pp-repair-on-import" ${repairOnImport ? 'checked' : ''}>`;
  html += `<label for="pp-repair-on-import">${escapeHtml(t('print.repairOnImport'))}</label>`;
  html += '</div>';

  html += '</div>';

  html += '<div class="pp-field-group">';
  html += `<label>${escapeHtml(t('print.format'))}</label>`;

  const disabledAttr = readiness.canExport ? ''
    : ` disabled aria-disabled="true" title="${escapeAttr(t('print.exportDisabledTitle'))}"`;

  html += `<button class="pp-export-btn pp-export-obj" data-format="obj"${disabledAttr}>`;
  html += `${icon('Download', { class: 'inline', width: 14, height: 14 })} ${escapeHtml(t('print.exportObj'))}`;
  html += `</button>`;

  html += `<button class="pp-export-btn pp-export-3mf" data-format="3mf"${disabledAttr}>`;
  html += `${icon('Download', { class: 'inline', width: 14, height: 14 })} ${escapeHtml(t('print.export3mf'))}`;
  html += `</button>`;

  html += `<button class="pp-export-btn pp-export-stl" data-format="stl"${disabledAttr}>`;
  html += `${icon('Download', { class: 'inline', width: 14, height: 14 })} ${escapeHtml(t('print.exportStl'))}`;
  html += `</button>`;

  html += '</div>';

  html += '</div>';

  const el = document.createElement('div');
  el.innerHTML = html;

  const costMount = el.querySelector('#pp-cost-block');
  if (costMount) renderCostBlock(costMount, state);

  el.querySelectorAll('.pp-readiness-issue').forEach(row => {
    row.addEventListener('click', () => {
      const code = row.dataset.issueCode;
      _routeReadinessIssue(code);
      const objectId = row.dataset.objectId;
      if (objectId && !getState().scene.objects[objectId]?.isGhost) Selection.set([objectId], objectId);
      _render();
    });
  });

  // Collect options
  const getOptions = () => {
    const selectedOnly = el.querySelector('#pp-selected-only').checked;
    const individually = el.querySelector('#pp-individually').checked;
    return { selectedOnly, individually };
  };

  // Wire export buttons. Hard errors are handled INSIDE the export (post
  // auto-fix); cached WARNINGS gate with a three-way prompt first (Blueprint
  // §12 export gate, arch B6 + watertight-repair-and-cost task 4):
  // Auto-fix and export / Export anyway / Cancel.
  const runExport = async (fn, opts) => {
    const currentReadiness = PrintManager.getPrintReadiness(opts);
    if (!currentReadiness.canExport) {
      reportError(new Error(t('print.readiness.blockedHint')), {
        title: t('print.readiness.blocked'),
        modal: true,
      });
      _render();
      return;
    }
    let exportOpts = opts;
    if (currentReadiness.requiresAcknowledgement) {
      const choice = await _confirmExportGate(currentReadiness.issues);
      if (choice === 'autofix') {
        const ids = _affectedObjectIds(currentReadiness.issues);
        if (ids.length) {
          ProgressOverlay.show(t('progress.working'));
          try {
            await MeshValidator.repairObjects(ids, {
              onProgress: (frac, name) => ProgressOverlay.update(frac, name),
            });
          } finally {
            ProgressOverlay.hide();
          }
        }
        const afterFix = PrintManager.getPrintReadiness(opts);
        if (!afterFix.canExport) {
          reportError(new Error(t('print.readiness.blockedHint')), {
            title: t('print.readiness.blocked'),
            modal: true,
          });
          _render();
          return;
        }
        // Explicit user click on Auto-fix IS the export consent — proceed
        // below without re-opening the gate, even if unrelated warnings
        // (e.g. bed-overflow) remain.
      } else if (choice === 'export') {
        // Clones are still repaired on export regardless (the `repair` prep
        // step runs on every export); this only records the user's explicit
        // "export anyway" so a caller-level repair:false can never sneak in.
        // The pipeline is the sole owner of toast.exportedWithWarnings — it
        // knows the real post-repair result (which parts, if any, are still
        // not watertight); the panel does not also toast here (fix-round-1
        // finding #2 — a caller-side toast here duplicated the pipeline's).
        exportOpts = { ...opts, repair: true };
      } else {
        return;   // 'cancel', ESC, or backdrop dismissal
      }
    }
    ProgressOverlay.show(t('progress.exporting'));
    try {
      await fn({ ...exportOpts, onProgress: (frac, msg) => ProgressOverlay.update(frac, msg) });
    } catch (err) {
      if (err?.validationErrors?.length) {
        Modal.open('validationErrors', { errors: err.validationErrors });
      } else if (err?.readinessIssues?.length) {
        reportError(err, { title: t('print.readiness.blocked'), modal: true });
      } else {
        // Export = heavy opaque op → detail modal per Status policy.
        reportError(err, { title: t('print.exportFailed'), modal: true });
      }
    } finally {
      ProgressOverlay.hide();
    }
  };

  wireToggles(el, '#pp-bake-solid', (_cb, on) => {
    setState(s => ({ ...s, print: { ...s.print, objBakeSolidTextures: on } }), { silent: true });
    markDirty();   // print slice is persisted wholesale in .mixo (M4)
  });

  wireToggles(el, '#pp-strict-export', (_cb, on) => {
    setState(s => ({ ...s, print: { ...s.print, strictExport: on } }), { silent: true });
    markDirty();   // print slice is persisted wholesale in .mixo (M4)
  });

  wireToggles(el, '#pp-repair-on-import', (_cb, on) => {
    setState(s => ({ ...s, print: { ...s.print, repairOnImport: on } }), { silent: true });
    markDirty();   // print slice is persisted wholesale in .mixo (M4)
  });

  el.querySelector('.pp-export-obj').addEventListener('click', () =>
    runExport(PrintManager.exportOBJ, getOptions()));

  el.querySelector('.pp-export-3mf').addEventListener('click', () =>
    runExport(PrintManager.exportThreeMF, getOptions()));

  el.querySelector('.pp-export-stl').addEventListener('click', () =>
    runExport(PrintManager.exportSTL, getOptions()));

  return el;
}

function _routeReadinessIssue(code) {
  if (code === 'bed-overflow' || code === 'below-bed' || code === 'unit-unconfirmed') {
    _activeTab = 'bed';
  } else if (code === 'geometry-error' || code === 'geometry-warning') {
    _activeTab = 'validation';
  } else if (code === 'no-print-parts' || code === 'missing-source' || code === 'missing-texture') {
    Workspace.setWorkspace('layout');
  }
}

// ── Bed Tab ──────────────────────────────────────────────

function _matchPrinterByBed(dims) {
  for (const [id, p] of Object.entries(PRINTERS)) {
    if (id === 'custom') continue;
    const b = p.bed;
    if (b && b.x === dims.x && b.y === dims.y && b.z === dims.z) return id;
  }
  return 'custom';
}

function _renderBedTab() {
  const state = getState();
  const dims = state.print.bedDimensions;
  const printerId = state.print.targetPrinterId || _matchPrinterByBed(dims);
  const showVolume = state.scene.overlays.bedPreview ?? false;

  let html = '<div class="pp-tab-content">';

  html += '<div class="pp-field-group">';
  html += `<label>${escapeHtml(t('print.targetPrinter'))}</label>`;
  html += '<select id="pp-printer-select" class="pp-preset-select">';
  for (const [id, p] of Object.entries(PRINTERS)) {
    const sel = id === printerId ? ' selected' : '';
    html += `<option value="${escapeAttr(id)}"${sel}>${escapeHtml(p.displayName)}</option>`;
  }
  html += '</select>';
  const cur = PRINTERS[printerId];
  if (cur) {
    html += `<div class="pp-info">${escapeHtml(cur.vendor)} · ${escapeHtml(t('print.buildAreaReference'))}</div>`;
  }
  html += '</div>';

  html += '<div class="pp-field-group">';
  html += `<label>${escapeHtml(t('print.buildVolume'))}</label>`;
  html += '<div class="pp-xyz-row">';
  for (const axis of ['x', 'y', 'z']) {
    html += `<label class="pp-xyz">${axis.toUpperCase()}`;
    html += `<input type="number" min="1" step="1" data-bed-axis="${escapeAttr(axis)}" value="${escapeAttr(dims[axis])}"></label>`;
  }
  html += '</div>';
  html += '</div>';

  html += '<div class="pp-field-group">';
  // Viewport visibility = toggle button (checkbox→toggle audit 2026-06-13).
  html += `<button type="button" class="pp-toggle${showVolume ? ' pp-toggle-on' : ''}" id="pp-bed-show" aria-pressed="${showVolume ? 'true' : 'false'}"><span class="pp-toggle-dot" aria-hidden="true"></span>${escapeHtml(t('print.showBedVolume'))}</button>`;
  html += `<div class="pp-info">${escapeHtml(t('print.bedValidationInfo'))}</div>`;
  html += '</div>';

  html += '</div>';

  const el = document.createElement('div');
  el.innerHTML = html;

  // Commit target printer + bed dims to state (non-undoable metadata, like
  // targetRatio). Re-draw the volume box live when currently shown.
  const commit = (next) => {
    setState(s => ({
      ...s,
      print: { ...s.print, targetPrinterId: next.printerId, bedDimensions: next.dims },
    }), { silent: true });
    markDirty();   // bed/printer are persisted in .mixo — close-without-save must not read clean (M4)
    SceneManager.rebuildBed();
    MeshValidator.invalidateAll();   // exceedsBed results depend on bed dims (A6)
    if (getState().scene.overlays.bedPreview) {
      SceneManager.updateBedPreview(next.dims);
    }
  };

  wireSelects(el, '#pp-printer-select', (_sel, id) => {
    const p = PRINTERS[id];
    if (!p) return;
    if (!p.bed || p.bed.x === null) {
      // Custom: keep current dims, just retarget.
      commit({ printerId: id, dims: getState().print.bedDimensions });
    } else {
      commit({ printerId: id, dims: { x: p.bed.x, y: p.bed.y, z: p.bed.z } });
    }
    _render();
  });

  // Invalid/non-positive dims restore the stored value in place (no
  // re-render — the user keeps focus to retype).
  const restoreBedAxis = (inp) => {
    inp.value = getState().print.bedDimensions[inp.dataset.bedAxis];
  };
  wireNumbers(el, '[data-bed-axis]', (inp, v) => {
    if (!(v > 0)) { restoreBedAxis(inp); return; }
    const dims = { ...getState().print.bedDimensions, [inp.dataset.bedAxis]: v };
    commit({ printerId: _matchPrinterByBed(dims), dims });
    _render();
  }, { onInvalid: restoreBedAxis });

  wireToggles(el, '#pp-bed-show', (btn, on) => {
    setState(s => ({
      ...s,
      scene: { ...s.scene, overlays: { ...s.scene.overlays, bedPreview: on } },
    }), { silent: true });
    SceneManager.setOverlay('bedPreview', on);
    reflectToggle(btn, on);
  });

  return el;
}

// ── Main render ───────────────────────────────────────────

async function _render() {
  if (!_bodyEl) return;
  _bodyEl.innerHTML = '';

  // Add tabs
  _bodyEl.appendChild(_renderTabs());

  // Add active tab content
  if (_activeTab === 'scale') {
    _bodyEl.appendChild(_renderScaleTab());
  } else if (_activeTab === 'validation') {
    _bodyEl.appendChild(_renderValidationTab());
  } else if (_activeTab === 'bed') {
    _bodyEl.appendChild(_renderBedTab());
  } else if (_activeTab === 'export') {
    _bodyEl.appendChild(_renderExportTab());
  }
}

// ── Export gate (A6 / B6 + watertight-repair-and-cost task 4) ────────────

/**
 * Export gate shown whenever readiness has only warnings (errors keep the
 * existing blocked modal). Resolves 'autofix' | 'export' | 'cancel' —
 * ESC/backdrop dismissal also resolves 'cancel'. `canAutoFix` decides whether
 * the Auto-fix button exists at all (I12).
 */
function _confirmExportGate(issues) {
  return new Promise(resolve => {
    Modal.open('exportGate', {
      issues,
      canAutoFix: exportGateCanAutoFix(issues),
      onClose: (r) => resolve(r ?? 'cancel'),
    });
  });
}

/** Object ids Auto-fix should run MeshValidator.repairObjects on: the ones flagged by geometry warnings. */
function _affectedObjectIds(issues) {
  const ids = new Set();
  for (const item of issues ?? []) {
    if (item.severity === 'warning' && item.code === 'geometry-warning') {
      for (const id of item.objectIds ?? []) ids.add(id);
    }
  }
  return [...ids];
}

/**
 * I12: offer "Auto-fix and export" only when there is something it can
 * actually fix — at least one geometry-warning object whose cached results
 * carry an unapplied `autoFixAvailable`. Otherwise the button ran a repair
 * batch that provably could not change anything and then exported anyway,
 * which reads as "we fixed it" for geometry nothing touched.
 */
export function exportGateCanAutoFix(issues, state = getState()) {
  const ids = _affectedObjectIds(issues);
  if (!ids.length) return false;
  const cache = state?.scene?.validation ?? {};
  return ids.some(id => cache[id]?.results?.some(r => r.autoFixAvailable && !r.fixed));
}

/** The gate's buttons, in the order they are rendered (first = primary). */
export function exportGateActions(canAutoFix) {
  return canAutoFix ? ['autofix', 'export', 'cancel'] : ['export', 'cancel'];
}

// Literal translate calls (not a key table) so scripts/i18n-check.mjs can
// still see these keys are used and verify all three locales carry them.
const GATE_LABELS = {
  autofix: () => t('print.exportGate.fixAndExport'),
  export: () => t('print.exportGate.exportAnyway'),
  cancel: () => t('print.exportGate.cancel'),
};

/**
 * The gate's markup. A pure string function so the button set, their order
 * and their resolved actions are testable headlessly (CIA F7) without a DOM.
 */
export function exportGateHtml(issues, canAutoFix) {
  const warnings = (issues ?? []).filter(item => item.severity === 'warning');
  const buttons = exportGateActions(canAutoFix).map((action, i) =>
    `<button class="btn${i === 0 ? ' btn-primary' : ''}" data-action="${action}">`
    + `${escapeHtml(GATE_LABELS[action]())}</button>`).join('');
  return `
    <div class="modal-content">
      <h3>${escapeHtml(t('print.exportGate.title'))}</h3>
      <p>${escapeHtml(canAutoFix ? t('print.validationWarningsBody') : t('print.exportGate.bodyNoFix'))}</p>
      <ul>${warnings.map(item => `<li>${escapeHtml(_issueLabel(item))}</li>`).join('')}</ul>
      <div class="modal-actions">${buttons}</div>
    </div>
  `;
}

function _renderExportGateModal({ data, close }) {
  const el = document.createElement('div');
  el.innerHTML = exportGateHtml(data?.issues, !!data?.canAutoFix);
  el.querySelectorAll('[data-action]').forEach(b =>
    b.addEventListener('click', () => close(b.dataset.action)));
  return el;
}

// ── Modals ────────────────────────────────────────────────

function _renderValidationErrorsModal({ data, close }) {
  const errors = data?.errors ?? [];

  let html = '<div class="modal-content">';
  html += `<h3>${escapeHtml(t('print.validationErrors'))}</h3>`;
  html += `<p>${escapeHtml(t('print.validationErrorsBody'))}</p>`;
  html += '<ul>';
  for (const { meshName, message } of errors) {
    html += `<li><strong>${escapeHtml(meshName)}:</strong> ${escapeHtml(message)}</li>`;
  }
  html += '</ul>';
  html += '<div class="modal-actions">';
  html += `<button class="btn btn-primary" data-action="close">${escapeHtml(t('btn.ok'))}</button>`;
  html += '</div>';
  html += '</div>';

  const el = document.createElement('div');
  el.innerHTML = html;
  el.querySelector('[data-action="close"]').addEventListener('click', () => close());
  return el;
}

export const PrintPanel = { init };
