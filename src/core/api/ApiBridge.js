// ApiBridge — renderer end of the automation API (API.6, ADR 0005). Main sends
// `{id, method, params}` through the OPTIONAL bridge methods `onApiRequest(cb)` /
// `respondApi(res)` / `notifyApi(evt)`; this module runs each request through the
// dispatcher (`createAppDispatcher` -> `.dispatch(method, params)`) and answers with
// `{id, result}` or `{id, error}`. Without the bridge (web, OPFS, older preload)
// `init()` is a no-op. Refs only: params/results never carry OS paths, and any
// unexpected throw is answered as E_INTERNAL with a path-scrubbed message.
//
// Toast policy: one coalesced toast per external batch for MUTATING calls
// (imported / exported / other change counts), at most one per 2 s, counts summed
// while waiting. Read-only calls and failures stay silent here.

import { storage as defaultStorage } from '../storage/StorageAdapter.js';
import { apiError, isApiError } from './ApiErrors.js';
import { scrubPaths } from './ApiDispatcher.js';

export const TOAST_MIN_INTERVAL_MS = 2000;

/** Mutating methods that earn a toast, mapped to the counter they feed. */
const TOAST_KIND = Object.freeze({
  'scene.import': 'imported',
  'export.run': 'exported',
  'project.new': 'changed',
  'project.open': 'changed',
  'project.save': 'changed',
  'project.saveAs': 'changed',
  'scene.remove': 'changed',
  'repair.run': 'changed',
  'library.mount': 'changed',
});

const scrub = text => scrubPaths(text).slice(0, 300);

function countFor(kind, method, result) {
  if (kind === 'imported') return Array.isArray(result?.added) ? result.added.length : 1;
  if (kind === 'exported') return Array.isArray(result) ? result.length : 1;
  if (method === 'scene.remove') return Array.isArray(result?.removed) ? result.removed.length : 1;
  return 1;
}

/**
 * @param {{
 *   bridge: {onApiRequest?:Function, respondApi?:Function, notifyApi?:Function, getApiStatus?:Function},
 *   createDispatcher: (extra:{notify:(evt:any)=>void})=>Promise<{dispatch:(m:string,p:any)=>Promise<any>}>|{dispatch:Function},
 *   toast?: (message:string, type:string, duration:number)=>any,
 *   t?: (key:string, fallback:string, params?:object)=>string,
 *   now?: ()=>number,
 *   setTimer?: (fn:Function, ms:number)=>any,
 * }} deps
 */
export function createApiBridge(deps) {
  const bridge = deps.bridge ?? {};
  const toast = deps.toast ?? (() => {});
  const fill = (fb, p) => String(fb).replace(/\{(\w+)\}/g, (_, n) => String(p?.[n] ?? ''));
  const t = (k, fb, p) => {
    const v = deps.t ? deps.t(k, fb, p) : fb;
    return v === fb ? fill(fb, p) : v;   // locale text is already interpolated by i18n
  };
  const now = deps.now ?? Date.now;
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));

  let dispatcherP = null;
  const pending = { imported: 0, exported: 0, changed: 0 };
  let lastToastAt = -Infinity;
  let timerSet = false;

  function _dispatcher() {
    dispatcherP ??= Promise.resolve(deps.createDispatcher({
      notify: evt => { try { bridge.notifyApi?.(evt)?.catch?.(() => {}); } catch { /* sink must never break a command */ } },
    }));
    return dispatcherP;
  }

  function _flush() {
    timerSet = false;
    const { imported, exported, changed } = pending;
    if (!imported && !exported && !changed) return;
    pending.imported = pending.exported = pending.changed = 0;
    lastToastAt = now();
    const parts = [];
    if (imported) parts.push(t('api.toast.imported', 'imported {n} files', { n: imported }));
    if (exported) parts.push(t('api.toast.exported', 'exported {n} files', { n: exported }));
    if (changed) parts.push(t('api.toast.changed', 'applied {n} changes', { n: changed }));
    try {
      toast(t('api.toast.prefix', 'External request: {list}', { list: parts.join(', ') }), 'info', 4000);
    } catch { /* toast failure is non-fatal */ }
  }

  function _noteMutation(kind, n) {
    pending[kind] += n;
    const wait = lastToastAt + TOAST_MIN_INTERVAL_MS - now();
    if (wait <= 0) _flush();
    else if (!timerSet) { timerSet = true; setTimer(_flush, wait); }
  }

  const inflight = new Map();   // request id -> AbortController

  /**
   * Answer one request; resolves after respondApi was called. Never rejects. Main sends
   * `{cancel: id}` on the same channel when the caller timed out or disconnected: that
   * request is dropped if it has not started, and the cancel itself gets no answer.
   */
  async function handle(req) {
    if (req && Object.hasOwn(req, 'cancel')) {
      inflight.get(req.cancel)?.abort();
      return;
    }
    const id = req?.id;
    const cancel = new AbortController();
    inflight.set(id, cancel);
    let res;
    try {
      const method = String(req?.method ?? '');
      const d = await _dispatcher();
      try {
        const result = await d.dispatch(method, req?.params ?? {}, { signal: cancel.signal });
        res = { id, result: result === undefined ? null : result };
        const kind = TOAST_KIND[method];
        if (kind) _noteMutation(kind, countFor(kind, method, result));
      } catch (e) {
        res = { id, error: isApiError(e) ? e : apiError('E_INTERNAL', scrub(e?.message ?? e)) };
      }
    } catch (e) {
      res = { id, error: apiError('E_INTERNAL', scrub(e?.message ?? e)) };
    }
    inflight.delete(id);
    try { await bridge.respondApi(res); } catch (err) { console.warn('[api] respond failed:', scrub(err?.message)); }
  }

  // Main turned the API off because its settings file could not be read (B-01): say so once.
  async function _showStartupNotice() {
    let status = null;
    try { status = await bridge.getApiStatus?.(); } catch { return; }
    if (status?.notice !== 'settings-unreadable') return;
    try {
      toast(t('api.notice.settingsUnreadable', 'Automation API turned off: its settings could not be read. Turn it on again in Preferences.'), 'warning', 8000);
    } catch { /* toast failure is non-fatal */ }
  }

  /** Subscribe to requests. No bridge -> no-op. Returns unsubscribe. */
  function init() {
    _showStartupNotice();
    if (typeof bridge.onApiRequest !== 'function' || typeof bridge.respondApi !== 'function') return () => {};
    const off = bridge.onApiRequest(req => { handle(req); });
    return typeof off === 'function' ? off : () => {};
  }

  return { init, handle };
}

let _bridge = null;

/** Wire the real deps (lazy imports keep this module headless-safe) and start. */
async function init() {
  if (_bridge) return;
  const s = defaultStorage;
  if (typeof s.onApiRequest !== 'function' || typeof s.respondApi !== 'function') return;
  const [{ createAppDispatcher }, { Toast }, { tr }] = await Promise.all([
    import('./AppDispatcherDeps.js'),
    import('../../ui/Toast.js'),
    import('../../ui/lib/tr.js'),
  ]);
  _bridge = createApiBridge({
    bridge: s,
    createDispatcher: extra => createAppDispatcher(extra),
    toast: (m, type, ms) => Toast.show(m, type, ms),
    t: tr,
  });
  _bridge.init();
}

export const ApiBridge = { init, createApiBridge };
