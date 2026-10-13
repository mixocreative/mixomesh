/**
 * Export tab ▸ "Print at" row, the "Other sizes…" editor and the
 * "Reference: … [change]" row + mixed-scale note (tasks 1.3 / 1.15 / 1.16 /
 * 1.17 UI, plan §3.5 #4-#5).
 *
 * Empty `print.exportTargets` = the size shown (the reference object's
 * EFFECTIVE scale, Decision 26). Each entry (Scale 1:X · Multiply ×N ·
 * Height mm) writes one file. Every edit is an undoable command
 * (Add/RemoveExportTargetCommand, SetReferenceObjectCommand); HISTORY_*
 * events re-render the panel.
 */

import { getState } from '../../core/StateManager.js';
import { t } from '../../i18n/index.js';
import { icon } from '../../core/Icons.js';
import { escapeHtml, escapeAttr } from '../renderSafe.js';
import { PrintManager } from '../../core/PrintManager.js';
import { push, AddExportTargetCommand, RemoveExportTargetCommand, SetReferenceObjectCommand } from '../../core/HistoryManager.js';
import { formatScaleRatio, parseScaleRatioText, exportTargetsFromState, normalizeExportTarget, exportTargetsEqual } from '../../core/scale/ScaleMath.js';
import { boundsForExportContext } from '../../core/print/PrintReadiness.js';
import { withRestTransform } from '../../core/scene/ImportBounce.js';

const KINDS = ['ratio', 'factor', 'height'];
const KIND_ICON = { ratio: 'Ruler', factor: 'Maximize', height: 'ChevronUp' };

// UI-only state that must survive the panel's full re-render.
let _editorOpen = false;
let _addKind = 'ratio';
let _pickingReference = false;

/** "1:144", "×2", "120 mm tall". */
export function printSizeLabel(target) {
  if (!target) return '';
  if (target.kind === 'factor') return `×${target.value}`;
  if (target.kind === 'height') return t('print.sizes.heightValue', { mm: target.mm });
  return formatScaleRatio(target.value);
}

/** Markup twin of printSizeLabel: monospace only on the number itself. */
export function printSizeHtml(target) {
  if (!target) return '';
  if (target.kind === 'height') {
    const MARK = '{{mm}}';
    const text = t('print.sizes.heightValue', { mm: MARK });
    const at = text.indexOf(MARK);
    if (at < 0) return escapeHtml(printSizeLabel(target));
    const before = text.slice(0, at);
    const after = text.slice(at + MARK.length);
    return `${escapeHtml(before)}<span class="pp-num">${escapeHtml(String(target.mm))}</span>${escapeHtml(after)}`;
  }
  return `<span class="pp-num">${escapeHtml(printSizeLabel(target))}</span>`;
}

function _kindLabel(kind) {
  if (kind === 'factor') return t('print.sizes.kind.factor');
  if (kind === 'height') return t('print.sizes.kind.height');
  return t('print.sizes.kind.ratio');
}

/** Whole-print W×D×H (mm) for one preview ctx, or '' when not measurable. */
function _packageDims(ctx) {
  if (!ctx) return '';
  try {
    const b = withRestTransform(() => boundsForExportContext(ctx));
    if (!b) return '';
    return b.max.map((v, i) => Math.max(0, v - b.min[i]).toFixed(1)).join('×');
  } catch {
    return '';
  }
}

/** Parse the add-field text for a kind → a typed target, or null. */
function _parseTarget(kind, text) {
  const raw = String(text ?? '').trim();
  if (kind === 'ratio') {
    const r = parseScaleRatioText(raw);
    return r ? normalizeExportTarget({ kind: 'ratio', value: r }) : null;
  }
  const n = parseFloat(raw.replace(/^[x×]/i, ''));
  if (!(Number.isFinite(n) && n > 0)) return null;
  return normalizeExportTarget(kind === 'height' ? { kind: 'height', mm: n } : { kind: 'factor', value: n });
}

/**
 * @param {Object} args
 * @param {Object|null} args.preview   previewExportContext({ target: null }) — the as-shown ctx
 * @param {Object} args.readiness      PrintManager.getPrintReadiness()
 * @returns {string}
 */
export function printSizesHtml({ preview, readiness }) {
  const state = getState();
  const targets = exportTargetsFromState(state);
  const shownRatio = preview ? formatScaleRatio(preview.referenceRatio) : '';

  let html = '<div class="pp-field-group pp-print-at">';
  html += '<div class="pp-print-at-row">';
  html += `<span class="pp-print-at-label">${escapeHtml(t('print.printAt'))}</span>`;
  html += '<span class="pp-print-at-value" data-print-at>';
  if (!targets.length) {
    html += escapeHtml(preview ? t('print.sizeShown', { ratio: shownRatio }) : t('print.sizeShownBare'));
  } else {
    html += targets.map(printSizeHtml).join(' · ');
  }
  html += '</span>';
  html += `<button type="button" class="pp-link-btn" data-act="other-sizes" aria-expanded="${_editorOpen}">${escapeHtml(t('print.otherSizes'))}</button>`;
  html += '</div>';

  if (targets.length || _editorOpen) {
    html += '<div class="pp-sizes" data-sizes>';
    if (targets.length) {
      html += '<ul class="pp-size-list">';
      targets.forEach((tg, i) => {
        const dims = _packageDims(PrintManager.previewExportContext({ targetIndex: i }));
        html += `<li class="pp-size-row" data-size-index="${i}">${icon(KIND_ICON[tg.kind] ?? 'Ruler', { class: 'inline', width: 13, height: 13 })}`
          + `<span class="pp-size-label">${printSizeHtml(tg)}</span>`
          + (dims ? `<span class="pp-num pp-size-dims">${escapeHtml(dims)} mm</span>` : '<span class="pp-size-dims"></span>')
          + `<button type="button" class="pp-icon-btn" data-remove-target="${i}" title="${escapeAttr(t('print.sizes.remove'))}" aria-label="${escapeAttr(t('print.sizes.remove'))}">${icon('XCircle', { width: 13, height: 13 })}</button></li>`;
      });
      html += '</ul>';
    }
    if (_editorOpen) {
      html += `<div class="pp-seg pp-size-kinds" role="radiogroup" aria-label="${escapeAttr(t('print.sizes.addVia'))}">`;
      for (const kind of KINDS) {
        const on = kind === _addKind;
        html += `<button type="button" class="pp-seg-btn${on ? ' active' : ''}" role="radio" aria-checked="${on}" data-size-kind="${kind}">${escapeHtml(_kindLabel(kind))}</button>`;
      }
      html += '</div>';
      const prefix = _addKind === 'ratio' ? '1:' : _addKind === 'factor' ? '×' : '';
      const suffix = _addKind === 'height' ? 'mm' : '';
      const ph = _addKind === 'ratio' ? '72' : _addKind === 'factor' ? '2' : '120';
      html += '<div class="pp-size-add">';
      html += `<label class="pp-affix-field">${prefix ? `<span class="pp-affix">${escapeHtml(prefix)}</span>` : ''}`
        + `<input type="text" inputmode="decimal" class="pp-num-input" data-size-input placeholder="${escapeAttr(ph)}" aria-label="${escapeAttr(_kindLabel(_addKind))}">`
        + `${suffix ? `<span class="pp-affix">${escapeHtml(suffix)}</span>` : ''}</label>`;
      html += `<button type="button" class="pp-btn" data-act="add-size">${icon('Plus', { class: 'inline', width: 12, height: 12 })}${escapeHtml(t('print.sizes.add'))}</button>`;
      html += '</div>';
      html += `<p class="pp-help">${escapeHtml(t('print.sizes.oneFileEach'))}</p>`;
    }
    html += '</div>';
  }
  html += '</div>';

  html += _referenceHtml(preview, readiness);
  return html;
}

function _referenceHtml(preview, readiness) {
  if (!preview) return '';
  const state = getState();
  const unit = preview.referenceUnit;
  const name = unit?.name ?? '';
  const mixed = (readiness?.issues ?? []).some(item => item.code === 'mixed-scales');
  let html = '<div class="pp-field-group pp-reference">';
  html += '<div class="pp-print-at-row">';
  html += `<span class="pp-print-at-label">${escapeHtml(t('print.reference'))}</span>`;
  html += `<span class="pp-print-at-value"><strong data-reference-name>${escapeHtml(name)}</strong> <span class="pp-num">(${escapeHtml(formatScaleRatio(preview.referenceRatio))})</span></span>`;
  html += `<button type="button" class="pp-link-btn" data-act="change-reference" aria-expanded="${_pickingReference}">${escapeHtml(t('print.reference.change'))}</button>`;
  html += '</div>';
  if (_pickingReference) {
    const current = state.print?.referenceObjectId ?? '';
    html += `<select class="pp-preset-select" data-reference-select aria-label="${escapeAttr(t('print.reference.aria'))}">`;
    html += `<option value=""${current ? '' : ' selected'}>${escapeHtml(t('print.reference.auto'))}</option>`;
    for (const u of preview.units ?? []) {
      html += `<option value="${escapeAttr(u.logicalId)}"${u.logicalId === current ? ' selected' : ''}>${escapeHtml(u.name)}</option>`;
    }
    html += '</select>';
  }
  if (mixed) {
    html += `<p class="pp-note">${icon('Info', { class: 'inline', width: 12, height: 12 })}<span>${escapeHtml(t('print.reference.note', { name }))}</span></p>`;
  }
  html += '</div>';
  return html;
}

/**
 * Wire the Print-at / sizes / reference controls rendered by printSizesHtml.
 * @param {HTMLElement} el
 * @param {() => void} rerender
 */
export function wirePrintSizes(el, rerender) {
  el.querySelector('[data-act="other-sizes"]')?.addEventListener('click', () => {
    _editorOpen = !_editorOpen;
    rerender();
    if (_editorOpen) /** @type {HTMLElement|null} */ (document.querySelector('[data-size-input]'))?.focus();
  });
  el.querySelectorAll('[data-size-kind]').forEach(btn => btn.addEventListener('click', () => {
    _addKind = /** @type {HTMLElement} */ (btn).dataset.sizeKind ?? 'ratio';
    rerender();
    /** @type {HTMLElement|null} */ (document.querySelector('[data-size-input]'))?.focus();
  }));
  const input = /** @type {HTMLInputElement|null} */ (el.querySelector('[data-size-input]'));
  const add = () => {
    const target = _parseTarget(_addKind, input?.value);
    if (!target) { input?.select(); return; }
    if (exportTargetsFromState(getState()).some(tg => exportTargetsEqual(tg, target))) { if (input) input.value = ''; return; }
    push(new AddExportTargetCommand(target));
  };
  el.querySelector('[data-act="add-size"]')?.addEventListener('click', add);
  input?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); add(); }
    if (e.key === 'Escape') { input.value = ''; }
  });
  el.querySelectorAll('[data-remove-target]').forEach(btn => btn.addEventListener('click', () => {
    const target = exportTargetsFromState(getState())[Number(/** @type {HTMLElement} */ (btn).dataset.removeTarget)];
    // Removing the last one ⇒ back to "the size shown".
    if (target) push(new RemoveExportTargetCommand(target));
  }));
  el.querySelector('[data-act="change-reference"]')?.addEventListener('click', () => {
    _pickingReference = !_pickingReference;
    rerender();
  });
  el.querySelector('[data-reference-select]')?.addEventListener('change', (e) => {
    const id = /** @type {HTMLSelectElement} */ (e.target).value || null;
    _pickingReference = false;
    if ((getState().print?.referenceObjectId ?? null) !== id) push(new SetReferenceObjectCommand(id));
    else rerender();
  });
}
