// Electron preload (ADR 0001 Phase 2). The ONLY bridge between the renderer and
// Node — a narrow, allowlisted `window.electronAPI`. contextIsolation is on, so the
// renderer never sees ipcRenderer/require directly.
//
// SANDBOXED (task 6.1, `sandbox: true`): a sandboxed preload may only require
// 'electron' (contextBridge / ipcRenderer / webUtils are all available there)
// and a few polyfilled built-ins — never Node's fs/path. Keep it that way: all
// file work happens in main behind opaque tokens. Save dialogs take only a
// DESCRIPTOR ({suggestedName} / {suggestedName, ext, description}); main
// sanitises it and owns the path (task 6.2).
//
// `capabilities` is read by src/core/storage/capabilities.js → the app detects a
// desktop runtime with full filesystem support and swaps in DesktopStorageAdapter.

const { contextBridge, ipcRenderer, webUtils } = require('electron');

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
  // Boot gate handshake (task 4.4): resolves {ok:true} once main's stores are loaded.
  storageReady: () => ipcRenderer.invoke('storage:ready'),
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
  // Project / import / export dialogs (task 4.4). Main shows the dialog and hands
  // back opaque tokens ({ref,name}) — never a path. Only project tokens are writable.
  pickOpenProject: () => ipcRenderer.invoke('project:pickOpen'),
  pickSaveProject: (opts) => ipcRenderer.invoke('project:pickSave', opts),
  writeFileRef: (ref, data) => ipcRenderer.invoke('fs:writeFileRef', ref, data),
  pickImportAssets: (opts) => ipcRenderer.invoke('dialog:pickImport', opts),
  saveExport: (opts, data) => ipcRenderer.invoke('export:save', opts, data),
  // OS drag-drop: the File's path is looked up HERE (isolated preload world) and
  // goes straight to main; the page gets back a read-only {ref,name} token.
  refForDroppedFile: (file) => {
    let filePath = '';
    try { filePath = webUtils.getPathForFile(file); } catch { filePath = ''; }
    return filePath ? ipcRenderer.invoke('fs:registerDropped', filePath) : Promise.resolve(null);
  },
  onCloseRequested: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('app:close-requested', listener);
    return () => ipcRenderer.removeListener('app:close-requested', listener);
  },
  respondToClose: (result) => ipcRenderer.send('app:close-response', result),
  // Listbridge marketplace publishing (ADR 0004). Secrets go IN only: no call returns a
  // saved credential. Listings travel as { platform, accountId, fileHostId?, remoteId?,
  // manifest, images: [bytes], files: [bytes] } — typed arrays, never file paths.
  // start / retry / cancel resolve with the job outcome; onProgress(event) receives
  // { jobId, step, status, message } for every step and returns an unsubscribe.
  listbridge: {
    describe: () => ipcRenderer.invoke('publish:describe'),
    hasCredentials: (id) => ipcRenderer.invoke('publish:hasCredentials', id),
    setCredentials: (id, secret) => ipcRenderer.invoke('publish:setCredentials', id, secret),
    clearCredentials: (id) => ipcRenderer.invoke('publish:clearCredentials', id),
    testConnection: (id) => ipcRenderer.invoke('publish:testConnection', id),
    start: (request) => ipcRenderer.invoke('publish:start', request),
    retry: (jobId) => ipcRenderer.invoke('publish:retry', jobId),
    cancel: (jobId) => ipcRenderer.invoke('publish:cancel', jobId),
    extendHold: (jobId, ms) => ipcRenderer.invoke('publish:extendHold', jobId, ms),
    onProgress: (callback) => {
      const listener = (_event, progress) => callback(progress);
      ipcRenderer.on('publish:progress', listener);
      return () => ipcRenderer.removeListener('publish:progress', listener);
    },
  },
});
