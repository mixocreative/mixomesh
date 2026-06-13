// Import error surface. A failed model/texture import is worth more than a
// transient toast — the user needs the filename, a plain-language hint, AND the
// technical detail (message + stack) to act on it. This shows a dismissable
// modal with all three; the stack is tucked inside a <details> so the modal
// stays clean until expanded.

import { Modal } from './Modal.js';
import { dismiss } from './Toast.js';
import { escapeHtml } from './renderSafe.js';

export function init() {
  Modal.register('importError', _render);
}

/**
 * Show the import-error modal.
 * @param {string} filename  the file that failed (for the heading)
 * @param {unknown} err      the thrown error
 */
export function showImportError(filename, err) {
  const message = err?.message ? String(err.message) : String(err ?? 'Unknown error');
  const detail = err?.stack ? String(err.stack)
    : err?.cause ? String(err.cause)
    : '';
  Modal.open('importError', { filename: filename ?? 'file', message, detail });
}

/**
 * Wrap an import entry point. On failure: log, dismiss any loading toast, and
 * show the detail modal instead of a transient error toast. Drop-in for the
 * generic safeAsync at every model/texture import call site.
 * @param {() => Promise<unknown>} fn
 * @param {string} filename
 * @param {string} [loadingToastId]
 */
export async function safeImport(fn, filename, loadingToastId) {
  try {
    await fn();
  } catch (err) {
    console.error(`Import failed for ${filename}:`, err);
    if (loadingToastId) dismiss(loadingToastId);
    showImportError(filename, err);
  }
}

// Map common failure messages to an actionable hint.
function _hintFor(message) {
  if (/unsupported file type/i.test(message)) {
    return 'Supported formats: .glb, .gltf, .obj, .stl, .3mf.';
  }
  if (/mtl|texture|sibling|material/i.test(message)) {
    return 'Drop the model together with its .mtl and texture files, or mount the containing folder so they resolve.';
  }
  if (/handle|permission|not available/i.test(message)) {
    return 'The file may have moved or folder permission was lost — re-mount the folder or drop the file again.';
  }
  if (/import|parse|load|read|glb|gltf|stl|3mf|obj/i.test(message)) {
    return 'The file could not be parsed — it may be corrupt or use an unsupported feature. Try re-exporting it.';
  }
  return 'See the technical details below.';
}

function _render({ data, close }) {
  const filename = data?.filename ?? 'file';
  const message = data?.message ?? 'Unknown error';
  const detail = data?.detail ?? '';
  const el = document.createElement('div');
  el.className = 'modal-content import-error';
  el.innerHTML = `
    <h3>Import failed</h3>
    <p class="import-error-file">${escapeHtml(filename)}</p>
    <p class="import-error-msg">${escapeHtml(message)}</p>
    <p class="import-error-hint">${escapeHtml(_hintFor(message))}</p>
    ${detail ? `<details class="import-error-details"><summary>Technical details</summary><pre>${escapeHtml(detail)}</pre></details>` : ''}
    <div class="modal-actions">
      <button class="btn btn-primary" data-action="close" type="button">Close</button>
    </div>`;
  el.querySelector('[data-action="close"]').addEventListener('click', () => close());
  return el;
}

export const ImportError = { init, show: showImportError, safeImport };
