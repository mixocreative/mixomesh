// Import error surface. A failed model/texture import is worth more than a
// transient toast — the user needs the filename, a plain-language hint, AND the
// technical detail (message + stack) to act on it. This shows a dismissable
// modal with all three; the stack is tucked inside a <details> so the modal
// stays clean until expanded.

import { Modal } from './Modal.js';
import { reportError, guard } from './Status.js';
import { escapeHtml } from './renderSafe.js';
import { t } from '../i18n/index.js';
import { classifyImportFailure } from '../core/import/ImportFailure.js';
import { desktopAppOffered } from '../core/storage/capabilities.js';

// Owns the `importError` modal RENDERER; the error POLICY (when to show it)
// lives in Status (reportError modal route / guard). safeImport is the import
// adapter over guard, exactly as safeAsync is the toast adapter.
export function init() {
  Modal.register('importError', _render);
  Modal.register('errorDetail', _renderErrorDetail);
}

/**
 * Show the import-error modal for an already-caught error.
 * @param {string} filename
 * @param {unknown} err
 */
export function showImportError(filename, err) {
  reportError(err, { title: t('import.failed'), modal: true, filename });
}

/**
 * Wrap an import entry point — failures surface the detail modal (via Status),
 * not a transient toast. Drop-in for safeAsync at model/texture import sites.
 * @param {() => Promise<unknown>} fn
 * @param {string} filename
 * @param {string} [loadingToastId]
 */
export function safeImport(fn, filename, loadingToastId) {
  return guard(fn, { title: t('import.failed'), modal: true, filename, loadingToastId });
}

function _render({ data, close }) {
  const filename = data?.filename ?? 'file';
  const message = data?.message ?? 'Unknown error';
  const detail = [message, data?.detail].filter(Boolean).join('\n\n');
  const failure = classifyImportFailure({ message, code: data?.code }, filename, { desktopApp: desktopAppOffered() });
  const el = document.createElement('div');
  el.className = 'modal-content import-error';
  el.innerHTML = `
    <h3>${escapeHtml(t('import.failed'))}</h3>
    <p class="import-error-file">${escapeHtml(filename)}</p>
    <p class="import-error-msg">${escapeHtml(t(failure.reasonKey))}</p>
    <p class="import-error-hint">${escapeHtml(t(failure.hintKey))}</p>
    ${detail ? `<details class="import-error-details"><summary>${escapeHtml(t('import.technicalDetails'))}</summary><pre>${escapeHtml(detail)}</pre></details>` : ''}
    <div class="modal-actions">
      <button class="btn btn-primary" data-action="close" type="button">${escapeHtml(t('btn.close'))}</button>
    </div>`;
  el.querySelector('[data-action="close"]').addEventListener('click', () => close());
  return el;
}

// A failed save / export / publish: its own title and message up front, the
// stack under Technical details.
function _renderErrorDetail({ data, close }) {
  const el = document.createElement('div');
  el.className = 'modal-content import-error';
  el.innerHTML = `
    <h3>${escapeHtml(data?.title ?? t('toast.somethingWentWrong'))}</h3>
    <p class="import-error-msg">${escapeHtml(data?.message ?? t('toast.unknownError'))}</p>
    ${data?.detail ? `<details class="import-error-details"><summary>${escapeHtml(t('import.technicalDetails'))}</summary><pre>${escapeHtml(data.detail)}</pre></details>` : ''}
    <div class="modal-actions">
      <button class="btn btn-primary" data-action="close" type="button">${escapeHtml(t('btn.close'))}</button>
    </div>`;
  el.querySelector('[data-action="close"]').addEventListener('click', () => close());
  return el;
}

export const ImportError = { init, show: showImportError, safeImport };
