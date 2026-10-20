/**
 * Print readiness strip (task 0.6) + the shared readiness issue list.
 *
 * One row at the top of EVERY Print tab: status word + icon in its
 * functional colour, a monospace size readout ("2 to print · 118 × 64 × 41
 * mm") and one sub-line (the first thing to fix, or the all-clear). Clicking
 * it routes to where that first issue is fixed (else the Validation tab).
 * The full clickable issue list (`renderIssueList`) is shared by the Export
 * and Validation tabs. Pure markup builders + one wiring helper; the panel
 * owns routing.
 */

import { t } from '../../i18n/index.js';
import { icon } from '../../core/Icons.js';
import { escapeHtml, escapeAttr } from '../renderSafe.js';

const STATUS_ICON = { ready: 'CheckCircle', warning: 'AlertTriangle', blocked: 'AlertCircle' };
const SEVERITY_RANK = { error: 0, warning: 1, info: 2 };

/** Translated one-line label for a readiness issue record. */
export function issueLabel(issue) {
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

/** Translated "what to do" hint for a readiness issue ('' when none). */
export function issueActionLabel(issue) {
  // Literal t() calls (not a key table) so scripts/i18n-check.mjs sees them.
  switch (issue.code) {
    case 'no-print-parts': return t('print.issueAction.no-print-parts');
    case 'missing-source': return t('print.issueAction.missing-source');
    case 'missing-texture': return t('print.issueAction.missing-texture');
    case 'unit-unconfirmed': return t('print.issueAction.unit-unconfirmed');
    case 'validation-pending': return t('print.issueAction.validation-pending');
    case 'bed-overflow': return t('print.issueAction.bed-overflow');
    case 'below-bed': return t('print.issueAction.below-bed');
    case 'geometry-error':
    case 'geometry-warning': return t('print.issueAction.geometry');
    case 'mixed-scales': return t('print.issueAction.mixed-scales');
    case 'texture-too-large': return t('print.issueAction.texture-too-large');
    case 'texture-count': return t('print.issueAction.texture-count');
    case 'thin-feature': return t('print.issueAction.thin-feature');
    case 'watertight-required': return t('print.issueAction.watertight-required');
    case 'refinement-unavailable': return t('print.issueAction.refinement-unavailable');
    default: return '';
  }
}

/** Blocking/warning issues, most severe first (info notes excluded). */
export function actionableIssues(readiness) {
  return (readiness?.issues ?? [])
    .filter(item => item.severity !== 'info')
    .sort((a, b) => (SEVERITY_RANK[a.severity] ?? 3) - (SEVERITY_RANK[b.severity] ?? 3));
}

function _sizeReadout(readiness) {
  const target = readiness?.targets?.[0];
  if (!target?.bounds) return '';
  const size = target.bounds.max.map((value, axis) => Math.max(0, value - target.bounds.min[axis]));
  return size.map(v => v.toFixed(1)).join(' × ');
}

/**
 * The strip's markup. `count` = printable objects (logical units).
 * @param {{status:string, issues:Array, targets:Array}} readiness
 * @param {number} count
 */
export function readinessStripHtml(readiness, count) {
  const status = readiness?.status ?? 'blocked';
  const issues = actionableIssues(readiness);
  const first = issues[0] ?? null;
  const size = _sizeReadout(readiness);
  const readout = count > 0 && size ? t('print.strip.summary', { n: count, size }) : '';
  let sub = first ? issueLabel(first) : t('print.strip.readySub');
  if (issues.length > 1) sub += ` · ${t('print.strip.more', { n: issues.length - 1 })}`;

  return `<button type="button" class="pp-readiness pp-readiness-strip ${escapeAttr(status)}"`
    + ` data-act="readiness" data-issue-code="${escapeAttr(first?.code ?? '')}"`
    + ` data-object-id="${escapeAttr(first?.objectIds?.[0] ?? '')}"`
    + ` aria-label="${escapeAttr(t('print.strip.aria'))}">`
    + `<span class="pp-rs-icon" aria-hidden="true">${icon(STATUS_ICON[status] ?? 'AlertCircle', { width: 16, height: 16 })}</span>`
    + `<span class="pp-rs-main"><span class="pp-rs-word">${escapeHtml(t(`print.readiness.${status}`))}</span>`
    + `<span class="pp-rs-sub">${escapeHtml(sub)}</span></span>`
    + (readout ? `<span class="pp-rs-readout">${escapeHtml(readout)}</span>` : '')
    + '</button>';
}

/**
 * The full clickable issue list (Export + Validation tabs). Info issues are
 * included (they explain, never block). Empty string when there are none.
 */
export function renderIssueList(readiness) {
  const issues = [...(readiness?.issues ?? [])]
    .sort((a, b) => (SEVERITY_RANK[a.severity] ?? 3) - (SEVERITY_RANK[b.severity] ?? 3));
  if (!issues.length) return '';
  let html = `<div class="pp-issue-list" role="list" aria-label="${escapeAttr(t('print.readiness'))}">`;
  if (readiness && !readiness.canExport) {
    html += `<p class="pp-readiness-hint">${escapeHtml(t('print.readiness.blockedHint'))}</p>`;
  }
  for (const item of issues) {
    const objectId = item.objectIds?.[0] ?? '';
    const action = issueActionLabel(item);
    const ic = item.severity === 'error' ? 'AlertCircle' : item.severity === 'info' ? 'Info' : 'AlertTriangle';
    html += `<button type="button" role="listitem" class="pp-readiness-issue ${escapeAttr(item.severity)}" data-issue-code="${escapeAttr(item.code)}" data-object-id="${escapeAttr(objectId)}">`;
    html += `${icon(ic, { class: 'inline' })}`;
    html += `<span class="pp-readiness-copy"><span>${escapeHtml(issueLabel(item))}</span>`;
    if (action) html += `<span class="pp-readiness-action">${escapeHtml(action)}</span>`;
    html += '</span></button>';
  }
  html += '</div>';
  return html;
}

/**
 * Wire every strip / issue row under `root` to `onIssue(code, objectId)`.
 * @param {HTMLElement} root
 * @param {(code:string, objectId:string) => void} onIssue
 */
export function wireIssueRoutes(root, onIssue) {
  root.querySelectorAll('[data-act="readiness"], .pp-readiness-issue').forEach(el => {
    el.addEventListener('click', () => onIssue(/** @type {HTMLElement} */ (el).dataset.issueCode ?? '',
      /** @type {HTMLElement} */ (el).dataset.objectId ?? ''));
  });
}
