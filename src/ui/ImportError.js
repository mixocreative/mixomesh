// Import error surface. A failed model/texture import is worth more than a
// transient toast — the user needs the filename, a plain-language hint, AND the
// technical detail (message + stack) to act on it. This shows a dismissable
// modal with all three; the stack is tucked inside a <details> so the modal
// stays clean until expanded.

import { Modal } from './Modal.js';
import { reportError, guard } from './Status.js';
import { escapeHtml } from './renderSafe.js';

// Owns the `importError` modal RENDERER; the error POLICY (when to show it)
// lives in Status (reportError modal route / guard). safeImport is the import
// adapter over guard, exactly as safeAsync is the toast adapter.
export function init() {
  Modal.register('importError', _render);
}

/**
 * Show the import-error modal for an already-caught error.
 * @param {string} filename
 * @param {unknown} err
 */
export function showImportError(filename, err) {
  reportError(err, { title: 'Import failed', modal: true, filename });
}

/**
 * Wrap an import entry point — failures surface the detail modal (via Status),
 * not a transient toast. Drop-in for safeAsync at model/texture import sites.
 * @param {() => Promise<unknown>} fn
 * @param {string} filename
 * @param {string} [loadingToastId]
 */
export function safeImport(fn, filename, loadingToastId) {
  return guard(fn, { title: 'Import failed', modal: true, filename, loadingToastId });
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
