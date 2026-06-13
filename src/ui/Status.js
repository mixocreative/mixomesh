// Centralized user-facing FEEDBACK policy: error surfacing + loading lifecycle.
// One place to decide how the app reports a failure and how it shows progress —
// so changing that policy (telemetry, retry, a different overlay) is a single
// edit, not a 20-file sweep.
//
// Scope (deliberate): this owns the two genuine cross-cutting concerns —
//   (1) USER-FACING failures (import/export/save), and
//   (2) LOADING lifecycle (overlay / loading toast).
// It does NOT wrap intentional silent fallbacks (`catch { /* optional */ }`) —
// those are local recoveries, not errors, and centralizing them would just add
// noise. `safeAsync`/`safeImport` are thin adapters that delegate here, so every
// surfaced error already flows through `reportError` without touching call sites.

import { Toast, dismiss } from './Toast.js';
import { Modal } from './Modal.js';
import { ProgressOverlay } from './ProgressOverlay.js';

/**
 * Surface a failure to the user. `modal` routes opaque/heavy operations
 * (import, export, save) to the detail modal (filename + hint + stack);
 * everything else gets a persistent error toast.
 * @param {unknown} err
 * @param {{ title?: string, modal?: boolean, filename?: string }} [opts]
 */
export function reportError(err, { title = 'Something went wrong', modal = false, filename } = {}) {
  const message = err?.message ? String(err.message) : String(err ?? 'Unknown error');
  console.error(`${title}:`, err);
  if (modal) {
    const detail = err?.stack ? String(err.stack) : err?.cause ? String(err.cause) : '';
    Modal.open('importError', { filename: filename ?? title, message, detail });
    return;
  }
  Toast.show(`${title}: ${message}`, 'error', 0);
}

/**
 * Run an async op and route any failure through {@link reportError}. The single
 * implementation behind `safeAsync` (toast) and `safeImport` (modal).
 * @param {() => Promise<T>} fn
 * @param {{ title?: string, modal?: boolean, filename?: string, loadingToastId?: string }} [opts]
 * @returns {Promise<T|undefined>}
 * @template T
 */
export async function guard(fn, { title = 'Operation failed', modal = false, filename, loadingToastId } = {}) {
  try {
    return await fn();
  } catch (err) {
    if (loadingToastId) dismiss(loadingToastId);
    reportError(err, { title, modal, filename });
    return undefined;
  }
}

/**
 * Run a long op with ONE loading surface. `overlay` → the blocking
 * ProgressOverlay (with a progress bar); otherwise a loading toast. Always
 * cleaned up, even on throw. `fn` receives an `onProgress(frac, msg)` updater
 * (a no-op for the toast path).
 * @param {string} label
 * @param {(onProgress: (frac: number, msg?: string) => void) => Promise<T>} fn
 * @param {{ overlay?: boolean }} [opts]
 * @returns {Promise<T>}
 * @template T
 */
export async function runTask(label, fn, { overlay = false } = {}) {
  let toastId = null;
  if (overlay) ProgressOverlay.show(label);
  else toastId = Toast.show(label, 'loading');
  const onProgress = overlay
    ? (frac, msg) => ProgressOverlay.update(frac, msg ?? label)
    : () => {};
  try {
    return await fn(onProgress);
  } finally {
    if (overlay) ProgressOverlay.hide();
    else if (toastId) dismiss(toastId);
  }
}

/**
 * Toast-policy adapter — the canonical wrapper for UI entry points that aren't
 * imports/exports. Kept as a named export so existing `safeAsync` call sites
 * move here with only an import-path change.
 * @param {() => Promise<unknown>} fn
 * @param {string} [loadingToastId]
 */
export function safeAsync(fn, loadingToastId) {
  return guard(fn, { title: 'Error', loadingToastId });
}

export const Status = { reportError, guard, runTask, safeAsync };
