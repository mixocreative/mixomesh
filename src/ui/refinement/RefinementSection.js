import { push, beginBatch, endBatch, SetPrintRefinementCommand, refinementSetting } from '../../core/HistoryManager.js';
import { getState } from '../../core/StateManager.js';
import { canonicalObjectId } from '../../core/LogicalObjects.js';
import { RefinementController } from '../../core/refinement/RefinementController.js';
import { t } from '../../i18n/index.js';
import { Status } from '../Status.js';
import { escapeHtml as escape, escapeAttr } from '../renderSafe.js';

let activeBatch = null;

function eligible(object) { return !!object?.mixoProvenance && Array.isArray(object.mixoRefinement) && object.mixoRefinement.length > 0; }
function phaseLabel(phase) {
  const key = { 'Reading topology': 'reading', Refining: 'refining', Validating: 'validating', Queued: 'queued' }[phase];
  return key ? t(`print.refine.${key}`) : phase;
}

/** Render the complete manual refinement journey for a Mixo logical-object lead. */
export function renderRefinementSection(object, progress = null, batchCount = 1, availability = null) {
  if (!object?.mixoProvenance || object.isInternalPart) return '';
  const provenance = object.mixoProvenance;
  const setting = refinementSetting(object);
  const valid = availability ? availability.available : eligible(object);
  const levelButtons = valid ? `<div class="mixo-refine-choice" role="group" aria-label="${escapeAttr(t('print.refine.levelGroup'))}">
    ${[0, 1, 2].map(level => `<button type="button" data-action="refine-level" data-level="${level}" aria-pressed="${setting.requestedLevel === level}" class="mixo-refine-choice-btn">${escape(level ? t('print.refine.level', { level }) : t('print.refine.off'))}</button>`).join('')}
  </div>` : '';
  const working = setting.status === 'queued' || setting.status === 'building';
  const percent = progress && Number.isFinite(progress.completed) && Number.isFinite(progress.total) && progress.total > 0
    ? ` ${Math.round(progress.completed / progress.total * 100)}%` : '';
  const progressBar = progress && Number.isFinite(progress.completed) && Number.isFinite(progress.total) && progress.total > 0
    ? `<progress aria-label="${escapeAttr(t('print.refine.progress'))}" value="${Math.max(0, Math.min(progress.completed, progress.total))}" max="${progress.total}"></progress>`
    : `<progress aria-label="${escapeAttr(t('print.refine.progress'))}"></progress>`;
  const batch = progress?.objectCount > 1 || batchCount > 1
    ? ` · ${escape(t('print.refine.batchStatus', { index: progress?.objectIndex ?? 1, total: progress?.objectCount ?? batchCount, name: progress?.objectName ?? object.name ?? '' }))}` : '';
  let state = '';
  if (working) state = `<div class="mixo-refine-status" role="status" aria-live="polite">${escape(phaseLabel(progress?.phase ?? (setting.status === 'queued' ? 'Queued' : 'Refining')))}${percent}${batch}</div>${progressBar}<button type="button" data-action="refine-cancel">${escape(t('print.refine.cancel'))}</button>`;
  else if (setting.status === 'failed') state = `<p class="mixo-refine-error" role="alert">${escape(setting.error?.message || t('print.refine.failed'))}</p><button type="button" data-action="refine-build">${escape(t('print.refine.retry'))}</button><button type="button" data-action="refine-original">${escape(t('print.refine.useOriginal'))}</button>`;
  else if (setting.status === 'ready' && setting.requestedLevel > 0) state = `<div class="mixo-refine-status" role="status">${escape(t('print.refine.ready', { level: setting.requestedLevel }))}</div><div class="mixo-refine-choice" role="group" aria-label="${escapeAttr(t('print.refine.previewGroup'))}"><button type="button" data-action="refine-preview" data-preview="original" aria-pressed="${setting.preview === 'original'}">${escape(t('print.refine.previewOriginal'))}</button><button type="button" data-action="refine-preview" data-preview="refined" aria-pressed="${setting.preview === 'refined'}">${escape(t('print.refine.previewRefined'))}</button></div>${setting.preview === 'refined' ? `<span class="mixo-refine-preview-indicator">${escape(t('print.refine.previewIndicator'))}</span>` : ''}`;
  else if (setting.requestedLevel > 0) state = `<div class="mixo-refine-status" role="status">${escape(t(setting.status === 'cancelled' ? 'print.refine.cancelled' : 'print.refine.needsBuild'))}</div><button type="button" data-action="refine-build">${escape(batchCount > 1 ? t('print.refine.buildBatch', { n: batchCount }) : t('print.refine.build'))}</button>`;
  if (!valid) state = setting.preview === 'refined' ? `<button type="button" data-action="refine-original">${escape(t('print.refine.useOriginal'))}</button>` : '';
  const unavailable = !valid ? `<p class="mixo-refine-note">${escape(availability?.reason ?? t('print.refine.unavailable'))}</p>` : '';
  return `<section class="pp-section mixo-refine-section" data-section="print-refinement" data-object-id="${escapeAttr(object.id)}">
    <header class="pp-section-header">${escape(t('print.refine.title'))} <span class="mixo-source-badge">${escape(t('print.refine.sourceBadge'))}</span></header>
    <div class="pp-section-body">
      <p class="mixo-refine-note">${escape(t('print.refine.authored', { viewport: provenance.viewportSubdivLevel, render: provenance.renderSubdivLevel }))}</p>
      ${unavailable}${levelButtons}${state}
    </div>
  </section>`;
}

function selectedEligibleIds(activeId, selectedIds) {
  const objects = getState().scene.objects;
  const ids = [...new Set((selectedIds?.length ? selectedIds : [activeId]).map(id => canonicalObjectId(id, objects)))];
  return ids.filter(id => eligible(objects[id]) && RefinementController.availability(id).available);
}

/** Bind controls after a Properties render. */
export function wireRefinementSection(root, activeId, selectedIds) {
  const section = root.querySelector('.mixo-refine-section');
  if (!section) return;
  section.addEventListener('click', event => {
    const button = event.target.closest?.('[data-action]');
    if (!button || !section.contains(button)) return;
    event.stopPropagation();
    const action = button.dataset.action;
    const ids = selectedEligibleIds(activeId, selectedIds);
    if (action === 'refine-level') {
      const level = Number(button.dataset.level);
      beginBatch('Print refinement');
      try { for (const id of ids) push(new SetPrintRefinementCommand(id, { requestedLevel: level, preview: 'original' })); }
      finally { endBatch(); }
    } else if (action === 'refine-preview') {
      push(new SetPrintRefinementCommand(activeId, { preview: button.dataset.preview }));
    } else if (action === 'refine-original') {
      push(new SetPrintRefinementCommand(activeId, { preview: 'original' }));
    } else if (action === 'refine-cancel') {
      if (activeBatch) activeBatch.cancelled = true;
      if (activeBatch?.currentId) RefinementController.cancel(activeBatch.currentId);
      else for (const id of ids) RefinementController.cancel(id);
    } else if (action === 'refine-build') {
      Status.guard(async () => {
        const batch = { cancelled: false };
        activeBatch = batch;
        try { for (const id of ids) { if (batch.cancelled) break; batch.currentId = id; await RefinementController.build(id); } }
        finally { if (activeBatch === batch) activeBatch = null; }
      });
    }
  });
}
