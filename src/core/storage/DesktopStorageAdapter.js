// Desktop (Electron) StorageAdapter — real Node fs via the preload IPC bridge
// (`window.electronAPI`), ADR 0001 Phase 2. Mounted-asset `ref` values are random
// main-process registry tokens; OS paths never enter renderer state.
//
// window.electronAPI is only touched at CALL time, so importing this module is
// headless-safe — it is simply not the active adapter unless `isDesktop()`. The KV
// methods persist to a JSON file in the app's userData dir (main-process handler);
// the picker + fs methods are declared for the LEAF-site migration.
//
// Running the desktop shell: see `docs/handoff/electron.md` (needs `npm i -D electron`).

import { caps } from './capabilities.js';

const _api = () => (typeof window !== 'undefined' ? window.electronAPI : undefined);

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
    if (typeof File !== 'undefined') return new File([result.bytes], result.name);
    const blob = new Blob([result.bytes]);
    Object.defineProperty(blob, 'name', { value: result.name });
    return blob;
  },
};
