// Desktop (Electron) StorageAdapter — real Node fs via the preload IPC bridge
// (`window.electronAPI`), ADR 0001 Phase 2. Mounted-asset `ref` values are random
// main-process registry tokens; OS paths never enter renderer state.
//
// window.electronAPI is only touched at CALL time, so importing this module is
// headless-safe — it is simply not the active adapter unless `isDesktop()`. The KV
// methods persist to a JSON file in the app's userData dir (main-process handler).
//
// Project / import / export (task 4.4): main shows the native dialog and returns
// `{ref,name}` tokens (never a path). Project tokens are writable (`writeFile` →
// atomic temp+rename in main); import tokens are read-only; `saveExport` hands the
// bytes to main, which writes the user-chosen file and answers true/false.
// Dialogs take DESCRIPTORS only (task 6.2): `{suggestedName}` for a project save,
// `{suggestedName, ext, description}` for an export. Main strips folders / drive /
// reserved characters from the name, accepts only whitelisted export extensions
// (3mf obj stl ply wrl zip png mp4 webm) and mints no token for an export.
// `ready()` is the boot-gate handshake: the bridge must expose every method this
// adapter calls and main must answer `storage:ready`.
//
// Asset refs (task 4.2): `persistRef(token)` → stable key the MAIN process derives
// from the absolute path and stores in `<userData>/mixo-refs.json`; `restoreRef(key)`
// re-validates (exists, right kind, readable) and hands back a fresh session token.
// Reads by key + relative path go through `readStoredFile`, which re-validates on
// every call and refuses paths that escape the folder. Absolute paths never cross.
//
// Running the desktop shell: see `docs/handoff/electron.md` (needs `npm i -D electron`).

import { caps, storageUnavailable } from './capabilities.js';
import { FIND_MOVED_LIMIT, extOfName, normalizeSource, resolveVia } from './AssetSource.js';

const _api = () => (typeof window !== 'undefined' ? window.electronAPI : undefined);

function _requireApi(method) {
  const api = _api();
  if (typeof api?.[method] !== 'function') throw new Error(`Desktop bridge is missing ${method}`);
  return api;
}

/** Bridge payload `{name, bytes}` → File (Blob with a name outside browsers). */
function _toFile(result) {
  if (!result?.bytes) return null;
  if (typeof File !== 'undefined') return new File([result.bytes], result.name);
  const blob = new Blob([result.bytes]);
  Object.defineProperty(blob, 'name', { value: result.name });
  return blob;
}

// Every bridge method the adapter calls — the boot gate refuses a partial bridge
// (stale preload / mismatched build) instead of failing on first save.
const REQUIRED_BRIDGE = [
  'storageReady', 'kvSet', 'kvGet', 'kvDelete', 'kvKeys',
  'mountDirectory', 'listDirectory', 'readFileRef',
  'persistRef', 'restoreRef', 'deleteRef', 'readStoredFile', 'findMoved',
  'pickOpenProject', 'pickSaveProject', 'writeFileRef', 'pickImportAssets', 'saveExport',
  'refForDroppedFile',
];
const READY_TIMEOUT_MS = 10000;

/** string | Blob | ArrayBuffer | view → Uint8Array (structured-clone friendly). */
async function _bytesOf(data) {
  if (typeof data === 'string') return new TextEncoder().encode(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (data && typeof data.arrayBuffer === 'function') return new Uint8Array(await data.arrayBuffer());
  throw new TypeError('writeFile expects text, a Blob or bytes');
}

async function _desktopReadSource(src) {
  const api = _requireApi('readStoredFile');
  return _toFile(await api.readStoredFile(src.refKey, src.kind === 'folder' ? src.path : null));
}

/** @type {import('./StorageAdapter.js').StorageAdapter} */
export const DesktopStorageAdapter = {
  kind: 'desktop',
  caps,
  async kvSet(key, value) { return _api()?.kvSet(key, value); },
  async kvGet(key) { return (await _api()?.kvGet(key)) ?? undefined; },
  async kvDelete(key) { return _api()?.kvDelete(key); },
  async kvKeys() { return (await _api()?.kvKeys()) ?? []; },
  async mountDirectory() {
    const api = _api();
    if (!api?.mountDirectory) throw new Error('Directory mounting is unavailable');
    return api.mountDirectory();
  },
  async listDirectory(ref, parentPath = '') {
    return (await _api()?.listDirectory(ref, parentPath)) ?? [];
  },
  async readFile(ref) {
    const result = await _api()?.readFileRef(ref);
    if (!result?.bytes) return result;
    return _toFile(result);
  },

  async resolveAsset(source, opts = {}) {
    return resolveVia(_desktopReadSource, source, opts);
  },

  async persistRef(ref) {
    if (typeof ref !== 'string' || !ref) throw new TypeError('persistRef: expected an opaque desktop ref');
    return _requireApi('persistRef').persistRef(ref);
  },

  async restoreRef(key) {
    if (typeof key !== 'string' || !key) return null;
    return (await _requireApi('restoreRef').restoreRef(key)) ?? null;
  },

  async deleteRef(key) {
    if (typeof key !== 'string' || !key) return;
    await _requireApi('deleteRef').deleteRef(key);
  },

  async hasRef(key) {
    return !!(await DesktopStorageAdapter.restoreRef(key));
  },

  async ready() {
    const api = _api();
    const missing = REQUIRED_BRIDGE.filter(m => typeof api?.[m] !== 'function');
    if (missing.length) {
      throw storageUnavailable('Desktop storage unavailable',
        `The desktop bridge is incomplete (missing ${missing.join(', ')}). Reinstall or rebuild MIXOMESH.`);
    }
    let timer;
    let res;
    try {
      res = await Promise.race([
        api.storageReady(),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('no answer from the main process')), READY_TIMEOUT_MS); }),
      ]);
    } catch (err) {
      throw storageUnavailable('Desktop storage unavailable',
        `MIXOMESH could not reach its storage (${err?.message ?? err}). Restart the app.`, err);
    } finally { clearTimeout(timer); }
    if (!res?.ok) {
      throw storageUnavailable('Desktop storage unavailable',
        `MIXOMESH could not open its storage (${res?.reason ?? 'unknown error'}). Restart the app.`);
    }
  },

  async pickOpenProject() {
    const picked = await _requireApi('pickOpenProject').pickOpenProject();
    if (!picked?.ref) return null;
    const file = await DesktopStorageAdapter.readFile(picked.ref);
    if (!file) throw new Error(`Could not read ${picked.name}`);
    return { ref: picked.ref, name: picked.name, file };
  },

  async pickSaveProject(suggestedName) {
    const picked = await _requireApi('pickSaveProject').pickSaveProject({ suggestedName });
    return picked?.ref ? { ref: picked.ref, name: picked.name } : null;
  },

  async writeFile(ref, data) {
    if (typeof ref !== 'string' || !ref) throw new TypeError('writeFile: expected an opaque desktop ref');
    await _requireApi('writeFileRef').writeFileRef(ref, await _bytesOf(data));
  },

  async pickImportAssets(opts = {}) {
    const picked = await _requireApi('pickImportAssets').pickImportAssets({ multiple: opts.multiple !== false });
    return Array.isArray(picked) ? picked.filter(p => p?.ref).map(p => ({ ref: p.ref, name: p.name })) : [];
  },

  async saveExport(blob, suggestedName, hint = {}) {
    // No browser download manager to fall back to: a failed native save is final.
    if (hint.forceDownload) throw new Error('The export could not be saved');
    const ext = String(hint.ext || (suggestedName.split('.').pop() || '')).replace(/^\./, '').toLowerCase();
    return !!(await _requireApi('saveExport').saveExport(
      { suggestedName, ext, description: hint.description || `${ext.toUpperCase()} file` },
      await _bytesOf(blob),
    ));
  },

  // NOT async: the File must be taken from the item inside the drop event. The
  // preload resolves it to a read-only token main-side; no path reaches here.
  refForDrop(item) {
    const file = item?.kind === 'file' ? item.getAsFile?.() : null;
    const api = _api();
    if (!file || typeof api?.refForDroppedFile !== 'function') return Promise.resolve(null);
    return Promise.resolve(api.refForDroppedFile(file))
      .then(r => r?.ref ?? null)
      .catch(() => null);
  },

  // Launch integration (LI.4): OPTIONAL bridge methods (not in REQUIRED_BRIDGE — an older
  // preload must still boot). Feature-detected at call time; absent → no batch / no-op.
  async pullLaunchRequests() {
    const api = _api();
    return typeof api?.pullLaunchRequests === 'function' ? ((await api.pullLaunchRequests()) ?? null) : null;
  },

  onLaunchRequests(cb) {
    const api = _api();
    if (typeof api?.onLaunchRequests !== 'function') return () => {};
    const off = api.onLaunchRequests(cb);
    return typeof off === 'function' ? off : () => {};
  },

  async findMoved(source, opts = {}) {
    const src = normalizeSource(source);
    const folderKey = opts.refKey ?? (src?.kind === 'folder' ? src.refKey : null);
    if (!src || !folderKey || !opts.contentHash) return { source: null, blob: null, scanned: 0 };
    const result = await _requireApi('findMoved').findMoved({
      refKey: folderKey,
      contentHash: opts.contentHash,
      ext: extOfName(src.path || src.label),
      limit: opts.limit ?? FIND_MOVED_LIMIT,
    }, typeof opts.onProgress === 'function' ? opts.onProgress : undefined);
    const scanned = result?.scanned ?? 0;
    if (!result?.path) return { source: null, blob: null, scanned };
    return {
      source: { kind: 'folder', refKey: folderKey, path: result.path, label: src.label },
      blob: _toFile(result),
      scanned,
    };
  },
};
