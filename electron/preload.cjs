// Electron preload (ADR 0001 Phase 2). The ONLY bridge between the renderer and
// Node — a narrow, allowlisted `window.electronAPI`. contextIsolation is on, so the
// renderer never sees ipcRenderer/require directly.
//
// `capabilities` is read by src/core/storage/capabilities.js → the app detects a
// desktop runtime with full filesystem support and swaps in DesktopStorageAdapter.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Full filesystem tier on desktop (Node fs) — capabilities.js trusts this verbatim.
  capabilities: {
    persistAssets: true,
    mountDirectory: true,
    relinkByPath: true,
    watchFiles: true,
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
  // Legacy project/export leaf operations; migrate separately behind descriptors.
  readFile: (p) => ipcRenderer.invoke('fs:readFile', p),
  writeFile: (p, data) => ipcRenderer.invoke('fs:writeFile', p, data),
  pickOpen: (opts) => ipcRenderer.invoke('dialog:open', opts),
  pickSave: (opts) => ipcRenderer.invoke('dialog:save', opts),
  onCloseRequested: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('app:close-requested', listener);
    return () => ipcRenderer.removeListener('app:close-requested', listener);
  },
  respondToClose: (result) => ipcRenderer.send('app:close-response', result),
});
