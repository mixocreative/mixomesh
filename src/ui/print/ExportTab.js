/**
 * Print ▸ Export tab (tasks 1.3 + 5.3, plan §4.3).
 *
 * Top to bottom: Print at (+ Other sizes… editor) · Reference [change] (+
 * mixed-scale note) · Format (segmented, EVERY writer; "modified" dot +
 * Printer default ↺ when it differs from the printer profile; OBJ axis / 3MF
 * flavour sub-row) · readiness issues · Cost (per-size lines, settings in a
 * ⚙ popover) · Advanced disclosure · the one primary "Export for <printer>
 * (<FORMAT>)" button, which runs the export gate (errors block; warnings open
 * the three-way modal whose default is Repair & export).
 *
 * Per-project settings (format, axis, flavour, split, individually, bake)
 * change through SetPrintSettingsCommand (undoable, persisted in the .mixo);
 * per-user preferences (strict, repair-on-import) write state + the
 * SettingsStore (Decision 15).
 */

import { getState, setState, markDirty } from '../../core/StateManager.js';
import { t } from '../../i18n/index.js';
import { icon, sectionIcon } from '../../core/Icons.js';
import { escapeHtml, escapeAttr } from '../renderSafe.js';
import { push, SetPrintSettingsCommand } from '../../core/HistoryManager.js';
import { getPrinterProfile, PRINTER_OBJ_AXES, PRINTER_3MF_FLAVOURS } from '../../core/print/PrinterProfiles.js';
import { effectivePrintSettings, modifiedFields, FORMAT_KEYS } from '../../core/print/PrintProfileSettings.js';
import { wireToggles } from '../lib/fields.js';
import { renderCostBlock } from './CostBlock.js';
import { renderIssueList } from './ReadinessStrip.js';
import { printSizesHtml, wirePrintSizes } from './PrintSizes.js';
import { wirePrinterDefault } from './PrinterTab.js';
import { caps } from '../../core/storage/capabilities.js';
import { saveListingPackageFromView } from './PublishTab.js';
import { formatLabel, formatDetail, objAxisLabel, flavourLabel, modifiedDot } from './printLabels.js';
import { logicalObjectLeadIds } from '../../core/LogicalObjects.js';
import { SetPrintRefinementCommand } from '../../core/commands/RefinementCommands.js';
import { RefinementController } from '../../core/refinement/RefinementController.js';
import { safeAsync } from '../Status.js';

// Disclosure state survives the panel's full re-render.
let _advancedOpen = false;

/** Short representation summary for the primary export action. */
export function exportRepresentationSummary(state) {
  const objects = state.scene?.objects ?? {};
  const leads = logicalObjectLeadIds(objects).map(id => objects[id]).filter(obj => obj?.isPrintPart && !obj.isGhost);
  if (!leads.length) return '';
  const refined = leads.filter(obj => obj.printRefinement?.preview === 'refined');
  if (!refined.length) return t('print.representation.original');
  if (leads.length === 1) return `${t('print.representation.refined')} · ${t('print.refine.level', { level: refined[0].printRefinement.requestedLevel })}`;
  return `${refined.length} ${t('print.representation.refined')} · ${leads.length - refined.length} ${t('print.representation.original')}`;
}

/** Per-object representation choices shown next to the export gate. */
export function exportRepresentationsHtml(state) {
  const objects = state.scene?.objects ?? {};
  const leads = logicalObjectLeadIds(objects).map(id => objects[id]).filter(obj => obj?.isPrintPart);
  if (!leads.length) return '';
  let html = `<div class="pp-field-group pp-export-representations"><span class="pp-group-label">${escapeHtml(t('print.representation.heading'))}</span>`;
  for (const object of leads) {
    const r = object.printRefinement;
    const refined = r?.preview === 'refined';
    const selected = refined ? `${t('print.representation.refined')} · ${t('print.refine.level', { level: r.requestedLevel })}` : t('print.representation.original');
    const active = r?.status === 'queued' || r?.status === 'building';
    html += `<div class="pp-row pp-representation-row"><span>${escapeHtml(object.name ?? object.id)}</span>`
      + `<span>${escapeHtml(selected)}</span>`;
    if (refined && r?.status !== 'ready') {
      html += `<span role="alert">${escapeHtml(t('print.representation.unavailable'))}</span>`;
      html += `<button type="button" data-refinement-action="${r?.status === 'failed' ? 'retry' : active ? 'cancel' : 'build'}" data-object-id="${escapeAttr(object.id)}">${escapeHtml(t(r?.status === 'failed' ? 'print.representation.retry' : active ? 'print.representation.cancel' : 'print.representation.build'))}</button>`;
      html += `<button type="button" data-refinement-action="original" data-object-id="${escapeAttr(object.id)}">${escapeHtml(t('print.representation.useOriginal'))}</button>`;
    } else if (refined) {
      html += `<button type="button" data-refinement-action="original" data-object-id="${escapeAttr(object.id)}">${escapeHtml(t('print.representation.useOriginal'))}</button>`;
    }
    html += '</div>';
  }
  return `${html}</div>`;
}

function _checkbox(id, checked, label, extra = '') {
  return `<div class="pp-checkbox"><input type="checkbox" id="${id}"${checked ? ' checked' : ''}>`
    + `<label for="${id}">${escapeHtml(label)}</label>${extra}</div>`;
}

function _formatHtml(eff, mods, profile) {
  let html = '<div class="pp-field-group pp-format">';
  html += '<div class="pp-label-row">';
  html += `<span class="pp-group-label">${escapeHtml(t('print.format'))}${mods.exportFormat ? modifiedDot('exportFormat', formatLabel(mods.exportFormat)) : ''}</span>`;
  if (Object.keys(mods).length) {
    html += `<button type="button" class="pp-link-btn" data-act="printer-default" title="${escapeAttr(t('print.printer.defaultTitle', { printer: profile.displayName }))}">`
      + `${escapeHtml(t('print.printer.default'))}${sectionIcon('RotateCcw')}</button>`;
  }
  html += '</div>';
  html += `<div class="pp-seg pp-format-seg" role="radiogroup" aria-label="${escapeAttr(t('print.formatAria'))}">`;
  for (const key of FORMAT_KEYS) {
    const on = key === eff.exportFormat;
    html += `<button type="button" class="pp-seg-btn${on ? ' active' : ''}" role="radio" aria-checked="${on}" data-fmt="${key}">${escapeHtml(formatLabel(key))}</button>`;
  }
  html += '</div>';
  html += `<p class="pp-help pp-format-detail">${escapeHtml(formatDetail(eff.exportFormat, eff.threeMFFlavour))}</p>`;

  if (eff.exportFormat === 'obj') {
    html += `<div class="pp-row"><label for="pp-obj-axis">${escapeHtml(t('print.objAxis'))}${mods.objAxis ? modifiedDot('objAxis', objAxisLabel(mods.objAxis)) : ''}</label>`;
    html += '<select id="pp-obj-axis" class="pp-preset-select" data-setting="objAxis">';
    for (const axis of PRINTER_OBJ_AXES) html += `<option value="${axis}"${axis === eff.objAxis ? ' selected' : ''}>${escapeHtml(objAxisLabel(axis))}</option>`;
    html += '</select></div>';
  } else if (eff.exportFormat === '3mf') {
    html += `<div class="pp-row"><label for="pp-3mf-flavour">${escapeHtml(t('print.threeMFFlavour'))}${mods.threeMFFlavour ? modifiedDot('threeMFFlavour', flavourLabel(mods.threeMFFlavour)) : ''}</label>`;
    html += '<select id="pp-3mf-flavour" class="pp-preset-select" data-setting="threeMFFlavour">';
    for (const fl of PRINTER_3MF_FLAVOURS) html += `<option value="${fl}"${fl === eff.threeMFFlavour ? ' selected' : ''}>${escapeHtml(flavourLabel(fl))}</option>`;
    html += '</select></div>';
  }
  return `${html}</div>`;
}

function _advancedHtml(print, eff, mods) {
  const flags = [!!print.individually, eff.splitByMaterial, !!print.objBakeSolidTextures, !!print.strictExport];
  const on = flags.filter(Boolean).length;
  let html = '<div class="pp-advanced">';
  html += `<button type="button" class="pp-disclosure" data-act="advanced" aria-expanded="${_advancedOpen}" aria-controls="pp-advanced-body">`
    + `<span class="pp-disclosure-tri" aria-hidden="true"></span>${escapeHtml(t('print.advanced'))}`
    + (on ? `<span class="pp-disclosure-aside">${escapeHtml(t('print.advancedOn', { n: on }))}</span>` : '')
    + '</button>';
  html += `<div class="pp-advanced-body" id="pp-advanced-body"${_advancedOpen ? '' : ' hidden'}>`;
  html += _checkbox('pp-individually', !!print.individually, t('print.eachIndividually'));
  html += _checkbox('pp-split-material', eff.splitByMaterial, t('print.splitByMaterial'),
    mods.splitByMaterial !== undefined ? modifiedDot('splitByMaterial', mods.splitByMaterial ? t('print.on') : t('print.off')) : '');
  html += _checkbox('pp-bake-solid', !!print.objBakeSolidTextures, t('print.bakeSolids'));
  html += _checkbox('pp-strict-export', !!print.strictExport, t('print.strictExport'));
  html += '</div></div>';
  return html;
}

/**
 * @param {Object} args
 * @param {Object} args.readiness    PrintManager.getPrintReadiness()
 * @param {Object|null} args.preview previewExportContext({ target: null })
 * @param {(writerKey:string, opts:Object) => void} args.runExport
 * @param {() => void} args.rerender
 * @returns {HTMLElement}
 */
export function renderExportTab({ readiness, preview, runExport, rerender }) {
  const state = getState();
  const print = state.print ?? {};
  const profile = getPrinterProfile(print.targetPrinterId);
  const eff = effectivePrintSettings(print, profile);
  const mods = modifiedFields(print, profile);

  let html = '<div class="pp-tab-content pp-export-tab">';
  html += printSizesHtml({ preview, readiness });
  html += _formatHtml(eff, mods, profile);
  html += exportRepresentationsHtml(state);
  if (readiness.issues.length) html += renderIssueList(readiness);
  html += '<div id="pp-cost-block"></div>';
  html += _advancedHtml(print, eff, mods);

  const representation = exportRepresentationSummary(state);
  const label = `${t('print.exportFor', { printer: profile.displayName, format: formatLabel(eff.exportFormat) })}${representation ? ` · ${representation}` : ''}`;
  const disabled = readiness.canExport ? '' : ` disabled aria-disabled="true" title="${escapeAttr(t('print.exportDisabledTitle'))}"`;
  html += '<div class="pp-export-footer">';
  html += `<button type="button" class="pp-primary-btn" data-act="export-primary" data-export-format="${escapeAttr(eff.exportFormat)}"${disabled}>`
    + `${icon('Download', { class: 'inline', width: 14, height: 14 })}<span class="pp-primary-label">${escapeHtml(label)}</span></button>`;
  // Tiers without publishing (web / iPad / phone) still get the account-free
  // listing package, so a seller can upload it by hand anywhere (PB.7).
  if (!caps.publish) {
    html += `<button type="button" class="pub-btn pub-wide" data-act="save-listing-package">${escapeHtml(t('publish.savePackage'))}</button>`;
    html += `<p class="pp-help">${escapeHtml(t('publish.savePackage.help'))}</p>`;
  }
  html += '</div>';
  html += '</div>';

  const el = document.createElement('div');
  el.innerHTML = html;

  const costMount = el.querySelector('#pp-cost-block');
  if (costMount) renderCostBlock(/** @type {HTMLElement} */ (costMount), state);

  wirePrintSizes(el, rerender);
  wirePrinterDefault(el);

  el.querySelectorAll('[data-refinement-action]').forEach(btn => btn.addEventListener('click', () => {
    const objectId = /** @type {HTMLElement} */ (btn).dataset.objectId;
    const action = /** @type {HTMLElement} */ (btn).dataset.refinementAction;
    if (!objectId) return;
    if (action === 'original') push(new SetPrintRefinementCommand(objectId, { preview: 'original' }));
    else if (action === 'cancel') RefinementController.cancel(objectId);
    else safeAsync(() => RefinementController.build(objectId));
    rerender();
  }));

  const setProject = (patch, lbl) => push(new SetPrintSettingsCommand(patch, lbl));

  el.querySelectorAll('[data-fmt]').forEach(btn => btn.addEventListener('click', () => {
    const fmt = /** @type {HTMLElement} */ (btn).dataset.fmt;
    if (fmt && fmt !== effectivePrintSettings(getState().print).exportFormat) setProject({ exportFormat: fmt }, `Export format ${formatLabel(fmt)}`);
  }));
  el.querySelectorAll('select[data-setting]').forEach(sel => sel.addEventListener('change', () => {
    const key = /** @type {HTMLSelectElement} */ (sel).dataset.setting;
    if (key) setProject({ [key]: /** @type {HTMLSelectElement} */ (sel).value }, 'Change export setting');
  }));

  el.querySelector('[data-act="advanced"]')?.addEventListener('click', () => {
    _advancedOpen = !_advancedOpen;
    rerender();
  });
  wireToggles(el, '#pp-individually', (_cb, on) => setProject({ individually: on }, 'Each object as its own file'));
  wireToggles(el, '#pp-split-material', (_cb, on) => setProject({ splitByMaterial: on }, 'Split by material'));
  wireToggles(el, '#pp-bake-solid', (_cb, on) => setProject({ objBakeSolidTextures: on }, 'Bake solid colours'));
  // Per-user preferences (Decision 15): state + SettingsStore (its capture
  // listener on #rp-print-body schedules the save), not project history.
  // markDirty because the current .mixo writer still carries the print slice.
  wireToggles(el, '#pp-strict-export', (_cb, on) => {
    setState(s => ({ ...s, print: { ...s.print, strictExport: on } }), { silent: true });
    markDirty();
    rerender();
  });

  el.querySelector('[data-act="save-listing-package"]')?.addEventListener('click', () => saveListingPackageFromView({ onDone: rerender }));

  el.querySelector('[data-act="export-primary"]')?.addEventListener('click', () => {
    const p = getState().print ?? {};
    runExport(effectivePrintSettings(p).exportFormat, { individually: !!p.individually });
  });
  return el;
}
