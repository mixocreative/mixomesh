// Electron preload (ADR 0001 Phase 2). The ONLY bridge between the renderer and
// Node — a narrow, allowlisted `window.electronAPI`. contextIsolation is on, so the
// renderer never sees ipcRenderer/require directly.
//
// `capabilities` is read by src/core/storage/capabilities.js → the app detects a
// desktop runtime with full filesystem support and swaps in DesktopStorageAdapter.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Full filesystem tier on desktop (Node fs) — capabilities.js trusts this verbatim.
  // watchFiles stays false until watchAsset is implemented (task 4.2).
  capabilities: {
    persistAssets: true,
    mountDirectory: true,
    relinkByPath: true,
    watchFiles: false,
    writeFiles: true,
  },
  // Cross-session KV (autosave / recent / settings) — JSON file in userData.
  kvSet: (key, value) => ipcRenderer.invoke('kv:set', key, value),
  kvGet: (key) => ipcRenderer.invoke('kv:get', key),
  kvDelete: (key) => ipcRenderer.invoke('kv:delete', key),
  kvKeys: () => ipcRenderer.invoke('kv:keys'),
  // Mounted asset directories use opaque refs; OS paths never enter renderer state.
  mountDirectory: () => ipcRenderer.invoke('dialog:mountDirectory'),
  listDirectory: (ref, parentPath) => ipcRenderer.invoke('fs:listDirectoryRef', ref, parentPath),
  readFileRef: (ref) => ipcRenderer.invoke('fs:readFileRef', ref),
  // Persisted asset refs: stable keys (dir_/file_) ↔ session tokens; never paths.
  persistRef: (ref) => ipcRenderer.invoke('refs:persist', ref),
  restoreRef: (key) => ipcRenderer.invoke('refs:restore', key),
  deleteRef: (key) => ipcRenderer.invoke('refs:delete', key),
  readStoredFile: (key, relPath) => ipcRenderer.invoke('refs:read', key, relPath),
  // Explicit "Find moved file" walk; onProgress({scanned}) while it runs.
  findMoved: (args, onProgress) => {
    const id = `fm_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const listener = (_event, requestId, progress) => {
      if (requestId === id && typeof onProgress === 'function') onProgress(progress);
    };
    ipcRenderer.on('refs:find-progress', listener);
    return ipcRenderer.invoke('refs:findMoved', id, args)
      .finally(() => ipcRenderer.removeListener('refs:find-progress', listener));
  },
  // User-editable config files (materials.json): <userData>/config/<name>,
  // seeded from the shipped copy on first run. Returns { text, path } or { error }.
  readUserConfig: (name) => ipcRenderer.invoke('config:read', name),
  // Legacy project/export dialogs; migrate separately behind descriptors.
  pickOpen: (opts) => ipcRenderer.invoke('dialog:open', opts),
  pickSave: (opts) => ipcRenderer.invoke('dialog:save', opts),
  onCloseRequested: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('app:close-requested', listener);
    return () => ipcRenderer.removeListener('app:close-requested', listener);
  },
  respondToClose: (result) => ipcRenderer.send('app:close-response', result),
});
