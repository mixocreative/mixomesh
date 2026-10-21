import { EVENTS } from '../core/events.js';
import { subscribe, getState } from '../core/StateManager.js';
import { t, applyTranslations } from '../i18n/index.js';
import { PrintManager } from '../core/PrintManager.js';
import { MeshValidator } from '../core/MeshValidator.js';
import { AssetLoader } from '../core/AssetLoader.js';
import { SettingsStore } from '../core/SettingsStore.js';
import { reportError } from './Status.js';
import { icon, sectionIcon } from '../core/Icons.js';
import { Modal } from './Modal.js';
import { ProgressOverlay } from './ProgressOverlay.js';
import { Workspace } from './Workspace.js';
import { Toast } from './Toast.js';
import { escapeHtml, escapeAttr } from './renderSafe.js';
import { shouldDisplayObject } from '../core/LogicalObjects.js';
import * as Selection from '../core/Selection.js';
import { readinessStripHtml, issueLabel, renderIssueList, wireIssueRoutes } from './print/ReadinessStrip.js';
import { renderPrinterTab } from './print/PrinterTab.js';
import { renderExportTab } from './print/ExportTab.js';
import { renderPublishTab } from './print/PublishTab.js';
import { caps } from '../core/storage/capabilities.js';

// Print panel shell (tasks 0.6 / 1.2 / 1.3): tab bar, the readiness strip on
// every tab, the Validation tab, the export runner + gate modals. The
// Printer and Export tabs live in ui/print/*.js.

let _bodyEl = null;
let _root   = null;
let _activeTab = 'printer'; // 'printer' | 'validation' | 'export' | 'publish' (desktop only)


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
    EVENTS.MATERIALS_LOADED,      // presets file (re)loaded — Cost block select
    EVENTS.REFINEMENT_CHANGED,
    EVENTS.REFINEMENT_PROGRESS,
    EVENTS.REFINEMENT_READY,
    EVENTS.REFINEMENT_FAILED,
    EVENTS.REFINEMENT_STALE,
    EVENTS.REFINEMENT_CANCELLED,
  ];
  for (const ev of events) subscribe(ev, _render);
  // The Validation tab's last outcome line describes the scene it ran on —
  // a new import or a removed object makes it stale, so drop it (the scene
  // summary line below it stays live either way).
  for (const ev of [EVENTS.ASSET_INSTANTIATED, EVENTS.OBJECT_REMOVED]) {
    subscribe(ev, () => { if (_valStatus.kind === 'done') { _valStatus = { kind: 'idle' }; _render(); } });
  }
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
  const prev = getState().ui.workspace;
  Workspace.setWorkspace('print');
  if (prev && prev !== 'print') {
    Toast.show(t('toast.workspaceSwitched', { name: t('workspace.print'), back: t(`workspace.${prev}`) }),
      'info', 4000, { tag: 'workspace', onClick: () => Workspace.setWorkspace(prev) });
  }
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

const BASE_TABS = ['printer', 'validation', 'export'];
/** The Publish tab exists only where caps.publish is true (desktop shell). */
const _tabs = () => (caps.publish ? [...BASE_TABS, 'publish'] : BASE_TABS);

/** Literal t() calls so scripts/i18n-check.mjs sees every tab key. */
function _tabLabel(tab) {
  if (tab === 'printer') return t('print.tab.printer');
  if (tab === 'validation') return t('print.tab.validation');
  if (tab === 'publish') return t('print.tab.publish');
  return t('print.tab.export');
}
const TAB_ICONS = { printer: 'Printer', validation: 'CheckCircle', export: 'FileDown', publish: 'Upload' };

function _renderTabs() {
  // Preview controls (wireframe edges, matte/flat) live in the viewport
  // toggles under the NavCube (ui/ViewportToggles.js) — no Preview tab. The
  // old Scale tab folded into Export (Print at), Bed into Printer (1.2/1.3).
  let html = `<div class="pp-tabs" role="tablist" aria-label="${escapeAttr(t('print.settingsAria'))}">`;
  for (const tab of _tabs()) {
    const active = tab === _activeTab ? ' active' : '';
    const selected = tab === _activeTab ? 'true' : 'false';
    html += `<button class="pp-tab${active}" data-tab="${escapeAttr(tab)}" role="tab" aria-selected="${selected}" title="${escapeAttr(_tabLabel(tab))}">${sectionIcon(TAB_ICONS[tab])}${escapeHtml(_tabLabel(tab))}</button>`;
  }
  // ↺ resets the print settings (printer, bed, export options) — one button
  // for the whole slice; print sizes + the reference are project content.
  html += `<button class="pp-tab-reset" data-act="reset-print" title="${escapeAttr(t('print.resetTitle'))}" aria-label="${escapeAttr(t('print.resetTitle'))}">${sectionIcon('RotateCcw')}</button>`;
  html += '</div>';

  const el = document.createElement('div');
  el.innerHTML = html;
  el.querySelectorAll('.pp-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      _activeTab = /** @type {HTMLElement} */ (btn).dataset.tab ?? 'printer';
      _render();
    });
  });
  el.querySelector('[data-act="reset-print"]')?.addEventListener('click',
    () => SettingsStore.resetSection('print'));

  return el;
}

// ── Validation Tab ───────────────────────────────────────
// Reads the A6 cache (state.scene.validation) instead of re-running topology
// checks on every render (review M11). "Validate All" refreshes explicitly;
// imports auto-validate already.
//
// Status strip (owner feedback 2026-09-18): the tab itself shows what is
// happening and what it found — an inline progress bar while a validate /
// repair runs, then the outcome (repaired counts, failures) next to a scene
// summary ("N parts · M still with issues") so "did it work, and is the
// scene clean now?" never needs a toast.

/** @type {{kind:'idle'}|{kind:'running',frac:number,label:string}|{kind:'done',tone:'success'|'warning'|'error',text:string}} */
let _valStatus = { kind: 'idle' };

/** The rows the Validation tab lists: one per print part (split-group siblings collapsed). */
function _validationRows(state) {
  const cache = state.scene.validation ?? {};
  const rows = [];
  const seenGroups = new Set();
  for (const [meshId, obj] of Object.entries(state.scene.objects)) {
    if (!obj.isPrintPart || obj.isGhost) continue;
    if (!shouldDisplayObject(obj)) continue;
    if (obj.logicalObjectId) {   // 2.7: one row per logical object (never sourceGroupId)
      if (seenGroups.has(obj.logicalObjectId)) continue;
      seenGroups.add(obj.logicalObjectId);
    }
    rows.push({ meshId, obj, entry: cache[meshId] ?? null });
  }
  return rows;
}

/** Scene-level summary from the cache: counts feeding the status strip. */
function _validationSummary(rows) {
  let unchecked = 0, withIssues = 0, fixable = 0;
  for (const { entry } of rows) {
    const results = entry?.results ?? null;
    if (!results || entry?.stale) unchecked++;
    if (results?.length) withIssues++;
    if (results?.some(r => r.autoFixAvailable && !r.fixed)) fixable++;
  }
  return { total: rows.length, unchecked, withIssues, fixable };
}

function _renderValidationStatus(summary) {
  if (_valStatus.kind === 'running') {
    const pct = Math.round(Math.max(0, Math.min(1, _valStatus.frac)) * 100);
    return `<div class="pp-val-status running" role="status" aria-live="polite">` +
      `<div class="pp-val-label"><span class="pp-val-spin">${icon('Loader2', { class: 'inline', width: 14, height: 14 })}</span><span id="pp-val-progress-label">${escapeHtml(_valStatus.label)}</span></div>` +
      `<div class="pp-val-bar" aria-hidden="true"><div class="pp-val-bar-fill" id="pp-val-progress-fill" style="width:${pct}%"></div></div>` +
      `</div>`;
  }
  let sceneLine;
  let tone;
  if (!summary.total) { sceneLine = t('print.noPrintParts'); tone = 'neutral'; }
  else if (summary.withIssues) {
    sceneLine = summary.fixable
      ? t('print.valSummary.issuesFixable', { n: summary.total, issues: summary.withIssues, fixable: summary.fixable })
      : t('print.valSummary.issues', { n: summary.total, issues: summary.withIssues });
    tone = 'warning';
  } else if (summary.unchecked) { sceneLine = t('print.valSummary.unchecked', { n: summary.total, unchecked: summary.unchecked }); tone = 'neutral'; }
  else { sceneLine = t('print.valSummary.clean', { n: summary.total }); tone = 'success'; }

  let html = `<div class="pp-val-status ${_valStatus.kind === 'done' ? _valStatus.tone : tone}" role="status" aria-live="polite">`;
  if (_valStatus.kind === 'done') {
    const ic = _valStatus.tone === 'success' ? 'CheckCircle' : _valStatus.tone === 'error' ? 'XCircle' : 'AlertTriangle';
    html += `<div class="pp-val-label pp-val-result">${icon(ic, { class: 'inline', width: 14, height: 14 })}<span>${escapeHtml(_valStatus.text)}</span></div>`;
  }
  const sceneIcon = tone === 'success' ? 'CheckCircle' : tone === 'warning' ? 'AlertTriangle' : 'Circle';
  html += `<div class="pp-val-label pp-val-scene">${icon(sceneIcon, { class: 'inline', width: 14, height: 14 })}<span>${escapeHtml(sceneLine)}</span></div>`;
  html += '</div>';
  return html;
}

/** Live progress: patch the bar in place (no full re-render mid-run). */
function _setValidationProgress(frac, label) {
  _valStatus = { kind: 'running', frac, label };
  const fill = _bodyEl?.querySelector('#pp-val-progress-fill');
  const lab = _bodyEl?.querySelector('#pp-val-progress-label');
  if (fill && lab) {
    fill.style.width = `${Math.round(Math.max(0, Math.min(1, frac)) * 100)}%`;
    lab.textContent = label;
  } else {
    _render();
  }
}

/** Run a validate/repair action with the tab's inline progress + outcome. */
async function _runValidationAction(label, fn) {
  if (_valStatus.kind === 'running') return;
  _setValidationProgress(0, label);
  // Blocking overlay WITH the inline strip (owner ask 2026-09-18): the
  // screen is blocked while the engine runs, with title + percentage +
  // current object; the strip then keeps the outcome on screen afterwards.
  ProgressOverlay.show(label);
  try {
    _valStatus = await fn((frac, name) => {
      _setValidationProgress(frac, name ? `${label} — ${name}` : label);
      ProgressOverlay.update(frac, name ?? '');
    });
  } catch (err) {
    _valStatus = { kind: 'done', tone: 'error', text: t('print.valResult.failed', { error: err?.message ?? String(err) }) };
    reportError(err, { title: t('toast.autoFixFailed') });
  } finally {
    ProgressOverlay.hide();
    _render();
  }
}

/**
 * The status strip IS the feedback for tab-initiated repairs (no success /
 * nothing-to-repair toast on top of it — review finding 2026-09-18). Only a
 * per-object failure still goes through reportError, because the strip
 * carries the names but not the error detail the modal shows.
 */
function _reportRepairFailures(result) {
  if (!result?.failed?.length) return;
  const err = new Error(result.failed.map(f => `${f.name}: ${f.error?.message ?? f.error ?? 'unknown error'}`).join('\n'));
  reportError(err, { title: t('toast.autoFixFailed') });
}

/** Outcome line for a batch repair, from RepairSession.repairObjects' result. */
function _repairOutcome(count, result, summaryAfter) {
  if (result?.failed?.length) {
    return { kind: 'done', tone: 'error', text: t('print.valResult.repairFailed', { names: result.failed.map(f => f.name).join(', ') }) };
  }
  if (!result?.repaired) return { kind: 'done', tone: 'warning', text: t('toast.nothingToRepairBatch', { n: count }) };
  const text = t('print.valResult.repaired', { n: result.repaired, holes: result.holesFilled ?? 0, nm: result.nmFixed ?? 0 });
  return { kind: 'done', tone: summaryAfter.withIssues ? 'warning' : 'success', text };
}

function _renderValidationTab() {
  const state = getState();
  const rows = _validationRows(state);
  const summary = _validationSummary(rows);
  const running = _valStatus.kind === 'running';

  // Repairable = at least one cached result still fixable (mirrors the
  // per-result Auto-Fix button's own `canFix` gate below).
  const fixableRows = rows.filter(({ entry }) => entry?.results?.some(r => r.autoFixAvailable && !r.fixed));

  let html = '<div class="pp-tab-content">';
  html += _renderValidationStatus(summary);
  html += renderIssueList(PrintManager.getPrintReadiness());
  html += '<div class="pp-field-group">';
  html += `<button class="pp-export-btn" id="pp-validate-all"${running || !rows.length ? ' disabled' : ''}>${icon('RefreshCw', { class: 'inline', width: 14, height: 14 })} ${escapeHtml(t('print.validateAll'))}</button>`;
  html += `<button class="pp-export-btn pp-repair-all" id="pp-repair-all"${fixableRows.length ? '' : ' hidden'}${running ? ' disabled' : ''}>${icon('Wrench', { class: 'inline', width: 14, height: 14 })} ${escapeHtml(t('print.repairAllN', { n: fixableRows.length }))}</button>`;
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
      } else if (results.length === 0) {
        html += `<p class="pp-hint pp-hint-ok">${escapeHtml(t('print.partClean'))}</p>`;
      } else {
        html += '<ul class="pp-result-list">';
        for (const result of results) {
          const canFix = result.autoFixAvailable && !result.fixed;
          html += `<li class="pp-result ${escapeAttr(result.severity)}">`;
          html += `<span>${escapeHtml(result.message)}</span>`;
          if (canFix) {
            html += `<button class="pp-autofix-btn" data-mesh-id="${escapeAttr(meshId)}" data-result-type="${escapeAttr(result.type)}"${running ? ' disabled' : ''}>${escapeHtml(t('print.autoFix'))}</button>`;
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

  el.querySelector('#pp-validate-all')?.addEventListener('click', () =>
    _runValidationAction(t('print.validating'), async (progress) => {
      const ids = rows.map(r => r.meshId);
      for (let i = 0; i < ids.length; i++) {
        const mesh = AssetLoader.getBabylonMesh(ids[i]);
        progress(i / ids.length, getState().scene.objects[ids[i]]?.name ?? '');
        if (mesh) await MeshValidator.validateMesh(mesh);   // refreshes the cache
      }
      const after = _validationSummary(_validationRows(getState()));
      return {
        kind: 'done',
        tone: after.withIssues ? 'warning' : 'success',
        text: after.withIssues
          ? t('print.valResult.validatedIssues', { n: after.total, issues: after.withIssues })
          : t('print.valResult.validatedClean', { n: after.total }),
      };
    }));

  el.querySelector('#pp-repair-all')?.addEventListener('click', () => {
    if (!fixableRows.length) return;
    const ids = fixableRows.map(({ meshId }) => meshId);
    _runValidationAction(t('print.repairing'), async (progress) => {
      const result = await MeshValidator.repairObjects(ids, { onProgress: progress });
      _reportRepairFailures(result);
      return _repairOutcome(ids.length, result, _validationSummary(_validationRows(getState())));
    });
  });

  // Wire auto-fix buttons — same shared repair path as Repair all / the
  // Outliner badge / the import toast, one object at a time.
  el.querySelectorAll('.pp-autofix-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const meshId = btn.dataset.meshId;
      const obj = getState().scene.objects[meshId];
      if (!obj) return;
      _runValidationAction(t('print.repairing'), async (progress) => {
        progress(0, obj.name);
        const result = await MeshValidator.repairObjects([meshId], { onProgress: progress });
        _reportRepairFailures(result);
        return _repairOutcome(1, result, _validationSummary(_validationRows(getState())));
      });
    });
  });

  return el;
}

// ── Export runner ─────────────────────────────────────────

/**
 * Run one export through the gate: blocked readiness → modal; cached
 * warnings → three-way prompt (Auto-fix and export / Export anyway /
 * Cancel); then the pipeline under the progress overlay. Shared by the
 * Export tab buttons and the context menu's export-selected action.
 */
async function _runExport(fn, opts, _regated = false, label = null) {
  {
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
        exportOpts = { ...opts, acknowledgeWarnings: true };
      } else if (choice === 'export') {
        // Clones are still repaired on export regardless (the `repair` prep
        // step runs on every export); this only records the user's explicit
        // "export anyway" so a caller-level repair:false can never sneak in.
        // The pipeline is the sole owner of toast.exportedWithWarnings — it
        // knows the real post-repair result (which parts, if any, are still
        // not watertight); the panel does not also toast here (fix-round-1
        // finding #2 — a caller-side toast here duplicated the pipeline's).
        exportOpts = { ...opts, repair: true, acknowledgeWarnings: true };
      } else {
        return;   // 'cancel', ESC, or backdrop dismissal
      }
    }
    // Cancel on the export overlay aborts the run (STL encode in its worker,
    // and no file is saved for any format) — review I6.
    const abort = new AbortController();
    ProgressOverlay.show(t('progress.exporting'), { controller: abort });
    try {
      await fn({ ...exportOpts, signal: abort.signal, onProgress: (frac, msg) => ProgressOverlay.update(frac, msg) });
    } catch (err) {
      if (err?.name === 'AbortError') {
        Toast.show(t('toast.exportCancelled', { filename: label ?? t('progress.exporting') }), 'info', 3000);
      } else if (err?.needsAcknowledgement && !_regated) {
        // The pipeline enforces the gate itself; readiness changed between
        // the panel's check and the run. Re-open the three-way prompt once.
        ProgressOverlay.hide();
        return _runExport(fn, opts, true, label);
      } else if (err?.validationErrors?.length) {
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
  }
}

const EXPORTERS = {
  obj: () => PrintManager.exportOBJ, '3mf': () => PrintManager.exportThreeMF, stl: () => PrintManager.exportSTL,
  ply: () => PrintManager.exportPLY, wrl: () => PrintManager.exportWRL,
};

/** Export tab primary button: run the writer for `format` through the gate. */
function _exportFormat(format, opts) {
  const fn = EXPORTERS[format]?.();
  if (!fn) return Promise.resolve();
  return _runExport(fn, opts, false, String(format).toUpperCase());
}

/**
 * One-off export of the CURRENT SELECTION as its own file (context menu
 * 匯出所選物件…). Ignores the 列印匯出 flag — the selection is the explicit
 * intent — and changes no state. Same gate/overlay as the Export tab.
 * @param {'obj'|'3mf'|'stl'|'ply'|'wrl'} format
 */
export function exportSelected(format) {
  const fn = EXPORTERS[format]?.();
  if (!fn) return Promise.resolve();
  if (!(getState().selection?.selectedIds?.length)) {
    Toast.show(t('toast.exportSelectedNone'), 'info', 2500);
    return Promise.resolve();
  }
  return _runExport(fn, { selectedOnly: true }, false, String(format).toUpperCase());
}

/**
 * Route a readiness issue (strip or issue row) to where it is fixed. An
 * empty code (the all-clear strip) opens the Validation tab.
 */
function _routeReadinessIssue(code, objectId = '') {
  if (code === 'bed-overflow' || code === 'below-bed') {
    _activeTab = 'printer';
  } else if (code === 'refinement-unavailable') {
    _activeTab = 'export';
  } else if (code === 'no-print-parts' || code === 'missing-source' || code === 'missing-texture'
    || code === 'unit-unconfirmed') {   // File units live in Properties ▸ Object
    Workspace.setWorkspace('layout');
  } else if (code === 'mixed-scales') {
    _activeTab = 'export';
  } else {
    _activeTab = 'validation';
  }
  if (objectId && !getState().scene.objects[objectId]?.isGhost) Selection.set([objectId], objectId);
  _render();
}

// ── Main render ───────────────────────────────────────────

function _render() {
  if (!_bodyEl) return;
  _bodyEl.innerHTML = '';
  if (!_tabs().includes(_activeTab)) _activeTab = 'printer';

  // One readiness + one as-shown preview per render, shared by the strip and
  // the tabs so every number on screen comes from the same snapshot.
  const readiness = PrintManager.getPrintReadiness();
  const preview = PrintManager.previewExportContext({ target: null });

  _bodyEl.appendChild(_renderTabs());

  const strip = document.createElement('div');
  strip.className = 'pp-strip-wrap';
  strip.innerHTML = readinessStripHtml(readiness, preview?.units?.length ?? 0);
  _bodyEl.appendChild(strip);

  if (_activeTab === 'printer') {
    _bodyEl.appendChild(renderPrinterTab({ goExport: () => { _activeTab = 'export'; _render(); } }));
  } else if (_activeTab === 'validation') {
    _bodyEl.appendChild(_renderValidationTab());
  } else if (_activeTab === 'publish') {
    _bodyEl.appendChild(renderPublishTab({ readiness, rerender: _render }));
  } else {
    _bodyEl.appendChild(renderExportTab({
      readiness,
      preview,
      runExport: _exportFormat,
      rerender: _render,
    }));
  }
  wireIssueRoutes(_bodyEl, _routeReadinessIssue);
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
      <ul>${warnings.map(item => `<li>${escapeHtml(issueLabel(item))}</li>`).join('')}</ul>
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

export const PrintPanel = { init, exportSelected };
