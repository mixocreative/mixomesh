// Desktop (Electron) StorageAdapter — real Node fs via the preload IPC bridge
// (`window.electronAPI`), ADR 0001 Phase 2. Mounted-asset `ref` values are random
// main-process registry tokens; OS paths never enter renderer state.
//
// window.electronAPI is only touched at CALL time, so importing this module is
// headless-safe — it is simply not the active adapter unless `isDesktop()`. The KV
// methods persist to a JSON file in the app's userData dir (main-process handler);
// the picker + fs methods are declared for the LEAF-site migration.
//
// Asset refs (task 4.2): `persistRef(token)` → stable key the MAIN process derives
// from the absolute path and stores in `<userData>/mixo-refs.json`; `restoreRef(key)`
// re-validates (exists, right kind, readable) and hands back a fresh session token.
// Reads by key + relative path go through `readStoredFile`, which re-validates on
// every call and refuses paths that escape the folder. Absolute paths never cross.
//
// Running the desktop shell: see `docs/handoff/electron.md` (needs `npm i -D electron`).

import { caps } from './capabilities.js';
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
