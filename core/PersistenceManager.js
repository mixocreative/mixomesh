import { EVENTS } from './events.js';
import {
  getState, setState, dispatch, subscribe, replaceState, freshState,
} from './StateManager.js';
import { SceneManager } from './SceneManager.js';
import { AssetLoader } from './AssetLoader.js';
import { ShaderLibrary } from './ShaderLibrary.js';
import { Selection } from './Selection.js';
import { clear as historyClear } from './HistoryManager.js';
import { Toast } from '../ui/Toast.js';
import {
  kvSet, kvGet, kvDelete, kvKeys,
  putFileHandle, getFileHandle,
} from './idb.js';

const BABYLON = window.BABYLON;

const SCHEMA_VERSION = '3.1';
const FILE_EXT       = '.mixo';
const FILE_TYPES     = [{
  description: 'MIXOMESH project',
  accept: { 'application/json': [FILE_EXT] },
}];
const RECENT_KEY      = 'recent_projects';
const RECENT_MAX      = 10;
const AUTOSAVE_PREFIX = 'autosave_';
const SCAN_FILE_LIMIT = 4000;            // hash-scan safety cap
const SILENT          = { silent: true };

// Module-local — not persisted.
let _fileHandle    = null;     // FileSystemFileHandle of the open .mixo
let _autosaveTimer = null;
let _dirty         = false;
const _ghostMeshes = new Set(); // wireframe placeholders for unresolved assets

// ── Base64 / hashing ─────────────────────────────────────

function _b64FromBuf(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function _bufFromB64(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function _sha256Hex(buf) {
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function _extOf(name) {
  const i = name.lastIndexOf('.');
  return i === -1 ? '' : name.slice(i).toLowerCase();
}

// ── Transform (de)serialise ──────────────────────────────

function _decompose(node) {
  node.computeWorldMatrix(true);
  const s = new BABYLON.Vector3();
  const q = new BABYLON.Quaternion();
  const p = new BABYLON.Vector3();
  node.getWorldMatrix().decompose(s, q, p);
  return { p: [p.x, p.y, p.z], q: [q.x, q.y, q.z, q.w], s: [s.x, s.y, s.z] };
}

/** Place an unparented node at a saved world transform. */
function _applyWorld(node, t) {
  if (!t) return;
  node.setParent(null);
  node.position.set(t.p[0], t.p[1], t.p[2]);
  node.rotationQuaternion = new BABYLON.Quaternion(t.q[0], t.q[1], t.q[2], t.q[3]);
  node.scaling.set(t.s[0], t.s[1], t.s[2]);
}

// ── Serialise ────────────────────────────────────────────

function _stripFileData(a) {
  const { fileData, ...rest } = a;   // never keep base64 in live state
  return rest;
}

async function _serialiseAssetLibrary() {
  const lib = getState().scene.assetLibrary;
  const out = [];
  for (const a of Object.values(lib)) {
    const base = {
      id: a.id, name: a.name, filename: a.filename,
      originalPath: a.originalPath ?? null, extension: a.extension,
      kind: a.kind ?? 'mesh', sourceUnit: a.sourceUnit ?? 'millimeters',
      unitConfirmed: a.unitConfirmed !== false, modelRatio: a.modelRatio ?? 1,
      directoryHandleKey: a.directoryHandleKey ?? null,
      fileHandleKey: a.fileHandleKey ?? null,
      isImported: !!a.isImported,
      thumbnailDataUrl: typeof a.thumbnailDataUrl === 'string'
        && a.thumbnailDataUrl.startsWith('data:') ? a.thumbnailDataUrl : null,
      fileData: null, contentHash: null,
    };
    // Embed bytes for meshes + user-loaded textures. glTF-embedded textures
    // are owned by their container — no standalone bytes to keep.
    if (!(a.kind === 'texture' && a.isImported)) {
      try {
        const buf = await AssetLoader.getAssetBytes(a.id);
        if (buf) {
          base.fileData    = _b64FromBuf(buf);
          base.contentHash = await _sha256Hex(buf);
        }
      } catch (err) {
        console.error(`Could not embed asset ${a.filename}:`, err);
      }
    }
    out.push(base);
  }
  return out;
}

function _serialiseSceneObjects() {
  const { objects } = getState().scene;
  return Object.values(objects).map(o => {
    const mesh = AssetLoader.getBabylonMesh(o.id);
    let containerMeshIndex = Number.isInteger(o.containerMeshIndex) ? o.containerMeshIndex : 0;
    if (mesh && !o.isGhost) {
      const geom = AssetLoader.getContainerGeomMeshes(o.assetId);
      const idx = geom.findIndex(m => m.metadata?.meshId === o.id);
      if (idx >= 0) containerMeshIndex = idx;
    }
    return {
      id: o.id, name: o.name, assetId: o.assetId,
      collectionId: o.collectionId ?? null, parentId: o.parentId ?? null,
      shaderId: o.shaderId ?? null,
      visible: o.visible !== false, locked: !!o.locked,
      isGhost: !!o.isGhost, isUnlinked: !!o.isUnlinked,
      isPrintPart: o.isPrintPart !== false,
      sourceGroupId: o.sourceGroupId ?? null,
      containerMeshIndex,
      transform: mesh ? _decompose(mesh) : (o._savedTransform ?? null),
    };
  });
}

function _serialiseGroups() {
  const scene = SceneManager.getScene();
  const { groups } = getState().scene;
  return Object.values(groups).map(g => {
    const node = scene.transformNodes.find(t => t.metadata?.groupId === g.id);
    return {
      id: g.id, name: g.name, parentId: g.parentId ?? null,
      childIds: [...(g.childIds ?? [])],
      transform: node ? _decompose(node) : null,
    };
  });
}

async function _buildDocument() {
  const s = getState();
  return {
    version: SCHEMA_VERSION,
    savedAt: new Date().toISOString(),
    project: { name: s.project.name || 'Untitled' },
    sceneSettings: {
      camera: { ...SceneManager.saveCameraState(), followMode: s.scene.camera.followMode ?? 'free' },
      overlays: { ...s.scene.overlays },
      grid: { ...s.scene.grid },
      cursor3d: { ...s.scene.cursor3d },
    },
    print: { ...s.print },
    assetLibrary: await _serialiseAssetLibrary(),
    collections: Object.values(s.scene.collections ?? {}),
    shaders: Object.values(s.scene.shaders).map(({ linkedMeshIds, ...rest }) => rest),
    uvOverrides: { ...s.scene.uvOverrides },
    userSwatches: [...(s.scene.userSwatches ?? [])],
    sceneObjects: _serialiseSceneObjects(),
    groups: _serialiseGroups(),
    selection: { ...s.selection },
    gizmo: { ...s.gizmo },
    ui: { ...s.ui },
  };
}

// ── Asset resolution (load) ──────────────────────────────

async function _fileHandleAtPath(dirHandle, path) {
  const parts = String(path).split(/[\\/]+/).filter(Boolean);
  let dir = dirHandle;
  for (let i = 0; i < parts.length - 1; i++) {
    dir = await dir.getDirectoryHandle(parts[i]);
  }
  return dir.getFileHandle(parts[parts.length - 1]);
}

async function _scanDirForHash(dirHandle, hash, ext, budget = { n: 0 }) {
  for await (const [, h] of dirHandle.entries()) {
    if (budget.n > SCAN_FILE_LIMIT) return null;
    if (h.kind === 'file') {
      if (ext && _extOf(h.name) !== ext) continue;
      budget.n++;
      try {
        const f   = await h.getFile();
        const buf = await f.arrayBuffer();
        if (await _sha256Hex(buf) === hash) return f;
      } catch { /* unreadable — skip */ }
    } else if (h.kind === 'directory') {
      const found = await _scanDirForHash(h, hash, ext, budget);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Resolve an asset's bytes for load. Priority:
 *   1. Live file at originalPath inside a re-granted mounted directory.
 *   2. Live file found by content-hash scan of that directory (moved/renamed).
 *   3. Embedded base64 copy (static / unlinked).
 *   4. null → ghost.
 * @returns {Promise<{blob:Blob, live:boolean}|null>}
 */
async function _resolveAssetBlob(entry) {
  if (entry.directoryHandleKey && entry.originalPath) {
    try {
      const dir = await getFileHandle(entry.directoryHandleKey);
      if (dir && (await dir.requestPermission({ mode: 'read' })) === 'granted') {
        try {
          const fh = await _fileHandleAtPath(dir, entry.originalPath);
          if (fh) return { blob: await fh.getFile(), live: true };
        } catch { /* path miss → hash fallback */ }
        if (entry.contentHash) {
          const f = await _scanDirForHash(dir, entry.contentHash, entry.extension);
          if (f) return { blob: f, live: true };
        }
      }
    } catch (err) {
      console.error(`Live resolve failed for ${entry.filename}:`, err);
    }
  }
  // Loose drag-drop: no directory, but a persisted single-file handle. Lower
  // priority than a mounted directory (a dir also gives the hash-rescan
  // relink) but above the frozen embedded snapshot — a dragged file can stay
  // live across reloads in the same browser profile.
  if (entry.fileHandleKey) {
    try {
      const fh = await getFileHandle(entry.fileHandleKey);
      if (fh && (await fh.requestPermission({ mode: 'read' })) === 'granted') {
        return { blob: await fh.getFile(), live: true };
      }
    } catch (err) {
      console.error(`File-handle resolve failed for ${entry.filename}:`, err);
    }
  }
  if (entry.fileData) {
    return { blob: new Blob([_bufFromB64(entry.fileData)]), live: false };
  }
  return null;
}

function _makeGhostMesh(obj) {
  const scene = SceneManager.getScene();
  const box = BABYLON.MeshBuilder.CreateBox(`ghost_${obj.id}`, { size: 0.05 }, scene);
  const mat = new BABYLON.StandardMaterial(`ghostMat_${obj.id}`, scene);
  mat.wireframe       = true;
  mat.diffuseColor    = new BABYLON.Color3(0.94, 0.27, 0.27);
  mat.emissiveColor   = new BABYLON.Color3(0.5, 0.1, 0.1);
  mat.backFaceCulling = false;
  box.material = mat;
  AssetLoader.bindRestoredMesh(obj.id, box, obj.assetId, obj.sourceUnit);
  _ghostMeshes.add(box);
  return box;
}

// ── World teardown ───────────────────────────────────────

function _resetWorld() {
  Selection.clear();
  for (const m of _ghostMeshes) { try { m.dispose(); } catch { /* */ } }
  _ghostMeshes.clear();
  const scene = SceneManager.getScene();
  for (const tn of [...scene.transformNodes]) {
    if (tn.metadata?.groupId) { try { tn.dispose(); } catch { /* */ } }
  }
  AssetLoader.resetAll();
  ShaderLibrary.resetAll();
  replaceState(freshState());
}

// ── Group restore ────────────────────────────────────────

function _restoreGroups(groupDefs, objMap) {
  if (!groupDefs.length) return;
  const scene = SceneManager.getScene();
  const nodes = new Map();   // groupId → TransformNode
  const groupsState = {};

  for (const g of groupDefs) {
    const node = new BABYLON.TransformNode(g.name, scene);
    node.metadata = { ...(node.metadata ?? {}), groupId: g.id };
    _applyWorld(node, g.transform);
    nodes.set(g.id, node);
    groupsState[g.id] = {
      id: g.id, name: g.name, parentId: g.parentId ?? null,
      childIds: [...(g.childIds ?? [])],
    };
  }
  setState(s => ({ ...s, scene: { ...s.scene, groups: groupsState } }), SILENT);

  // Parent groups before their children. Process roots-first.
  const ordered = [];
  const seen = new Set();
  const visit = (g) => {
    if (seen.has(g.id)) return;
    if (g.parentId && groupsState[g.parentId] && !seen.has(g.parentId)) {
      visit(groupDefs.find(x => x.id === g.parentId));
    }
    seen.add(g.id); ordered.push(g);
  };
  for (const g of groupDefs) visit(g);

  for (const g of ordered) {
    const node = nodes.get(g.id);
    if (g.parentId && nodes.has(g.parentId)) node.setParent(nodes.get(g.parentId));
    for (const childId of g.childIds ?? []) {
      const obj = objMap[childId];
      if (!obj) continue;
      const mesh = AssetLoader.getBabylonMesh(childId);
      if (mesh) mesh.setParent(node);   // setParent preserves the world transform
    }
  }
}

// ── Load ─────────────────────────────────────────────────

function _migrate(doc) {
  // v3.0 saves carried a scalar scene.gridSize — intentionally dropped
  // (footprint now tracks the printer bed). Everything else is forward
  // compatible; unknown future versions still attempt a best-effort load.
  return doc;
}

async function _loadProject(doc) {
  const data = _migrate(doc);
  historyClear();
  _resetWorld();

  setState(s => ({
    ...s,
    project: { ...s.project, name: data.project?.name || 'Untitled' },
    print:   { ...s.print, ...(data.print || {}) },
    scene: {
      ...s.scene,
      camera:   { ...s.scene.camera, ...(data.sceneSettings?.camera || {}) },
      overlays: { ...s.scene.overlays, ...(data.sceneSettings?.overlays || {}) },
      grid:     { ...s.scene.grid, ...(data.sceneSettings?.grid || {}) },
      cursor3d: { ...s.scene.cursor3d, ...(data.sceneSettings?.cursor3d || {}) },
      userSwatches: data.userSwatches || [],
      collections:  _arrToMap(data.collections),
    },
    selection: { ...s.selection, ...(data.selection || {}) },
    gizmo:     { ...s.gizmo, ...(data.gizmo || {}) },
    ui:        { ...s.ui, ...(data.ui || {}) },
  }), SILENT);

  for (const sh of data.shaders || []) ShaderLibrary.restoreShader(sh);

  const assetRes = new Map();   // assetId → { status, geom? }
  const unmatched = [];
  for (const a of data.assetLibrary || []) {
    if (a.kind === 'texture' && a.isImported) {
      AssetLoader.registerAssetEntry(_stripFileData(a));
      assetRes.set(a.id, { status: 'imported' });
      continue;
    }
    const r = await _resolveAssetBlob(a);
    if (a.kind === 'texture') {
      if (r) { await AssetLoader.restoreTexture(_stripFileData(a), r.blob); assetRes.set(a.id, { status: r.live ? 'live' : 'static' }); }
      else   { AssetLoader.registerAssetEntry(_stripFileData(a)); assetRes.set(a.id, { status: 'ghost' }); }
      continue;
    }
    AssetLoader.registerAssetEntry(_stripFileData(a));
    if (!r) { assetRes.set(a.id, { status: 'ghost' }); continue; }
    try {
      const geom = await AssetLoader.restoreContainer(a.id, r.blob, a.extension);
      const status = r.live ? 'live' : 'static';
      assetRes.set(a.id, { status, geom });
      // Only nag for assets that were SUPPOSED to track a live file (had a
      // dir or file handle) but fell back to the embedded snapshot. A loose
      // drag-drop with no handle is an expected snapshot — never flag it,
      // otherwise the modal cries wolf on every reopen.
      if (status === 'static' && (a.directoryHandleKey || a.fileHandleKey)) {
        unmatched.push(a);
      }
    } catch (err) {
      console.error(`Container restore failed for ${a.filename}:`, err);
      assetRes.set(a.id, { status: 'ghost' });
    }
  }

  const objMap = {};
  for (const o of data.sceneObjects || []) {
    const res = assetRes.get(o.assetId);
    let mesh = null, ghost = false, unlinked = false;
    if (res && res.geom) {
      const idx = Number.isInteger(o.containerMeshIndex) ? o.containerMeshIndex : 0;
      mesh = res.geom[idx] || res.geom.find(m => m.name === o.name) || res.geom[0] || null;
      unlinked = res.status === 'static';
    }
    if (mesh) {
      AssetLoader.bindRestoredMesh(o.id, mesh, o.assetId, o.sourceUnit);
      _applyWorld(mesh, o.transform);
      const vis = o.visible !== false;
      mesh.setEnabled(vis);
      mesh.isVisible = vis;
    } else {
      ghost = true;
      const box = _makeGhostMesh(o);
      _applyWorld(box, o.transform);
    }
    objMap[o.id] = {
      id: o.id, name: o.name, assetId: o.assetId,
      collectionId: o.collectionId ?? null, parentId: o.parentId ?? null,
      shaderId: ghost ? null : (o.shaderId ?? null),
      visible: o.visible !== false, locked: !!o.locked,
      isGhost: ghost, isUnlinked: unlinked && !ghost,
      isPrintPart: o.isPrintPart !== false,
      sourceGroupId: o.sourceGroupId ?? null,
      containerMeshIndex: Number.isInteger(o.containerMeshIndex) ? o.containerMeshIndex : 0,
      _savedTransform: o.transform ?? null,
    };
  }
  setState(s => ({ ...s, scene: { ...s.scene, objects: objMap } }), SILENT);

  for (const o of data.sceneObjects || []) {
    const obj = objMap[o.id];
    if (!obj || obj.isGhost || !o.shaderId) continue;
    if (getState().scene.shaders[o.shaderId]) ShaderLibrary.assignToMesh(o.shaderId, o.id);
  }
  for (const [meshId, uv] of Object.entries(data.uvOverrides || {})) {
    const obj = objMap[meshId];
    if (obj && !obj.isGhost && obj.shaderId) ShaderLibrary.setUVOverride(meshId, uv);
  }

  _restoreGroups(data.groups || [], objMap);

  SceneManager.rebuildBed();
  SceneManager.setGrid(getState().scene.grid);
  for (const [k, v] of Object.entries(getState().scene.overlays || {})) {
    SceneManager.setOverlay(k, !!v);
  }
  SceneManager.setScaleLock(getState().ui.scaleLocked !== false);
  ShaderLibrary.rebuildLinkedIndex();

  dispatch(EVENTS.PROJECT_LOADED, {});                       // SceneManager restores camera from state
  const fm = getState().scene.camera.followMode;
  if (fm) SceneManager.setFollowMode(fm);
  Selection.set(getState().selection.selectedIds || [], getState().selection.activeId || null);

  _dirty = false;
  dispatch(EVENTS.PROJECT_SAVED, {});                        // project is clean post-load
  await kvDelete(`${AUTOSAVE_PREFIX}${getState().project.name}`);

  if (unmatched.length) {
    dispatch(EVENTS.MODAL_OPEN, { id: 'unmatchedAssets', assets: unmatched });
  }
  Toast.show(`Loaded ${getState().project.name}`, 'success', 3000);
}

function _arrToMap(arr) {
  const m = {};
  for (const x of arr || []) m[x.id] = x;
  return m;
}

// ── Recent projects + thumbnail ──────────────────────────

async function _screenshot() {
  try {
    const engine = SceneManager.getEngine();
    const cam = SceneManager.getScene().activeCamera;
    return await BABYLON.Tools.CreateScreenshotUsingRenderTargetAsync(
      engine, cam, { width: 240, height: 160 }, 'image/png'
    );
  } catch { return null; }
}

async function _pushRecent(name, handle) {
  const handleKey = `recent_${Date.now().toString(36)}`;
  try { await putFileHandle(handleKey, handle); } catch { /* */ }
  const thumb = await _screenshot();
  let list = (await kvGet(RECENT_KEY)) || [];
  list = list.filter(r => r.name !== name);
  list.unshift({ name, path: name + FILE_EXT, savedAt: new Date().toISOString(), handleKey, thumbnailDataUrl: thumb });
  if (list.length > RECENT_MAX) list = list.slice(0, RECENT_MAX);
  await kvSet(RECENT_KEY, list);
}

// ── Public API ───────────────────────────────────────────

/** Write to the currently-open file, or prompt if none. */
export async function save() {
  if (!_fileHandle) return saveAs();
  const text = JSON.stringify(await _buildDocument());
  const w = await _fileHandle.createWritable();
  await w.write(text);
  await w.close();
  setState(s => ({ ...s, project: { ...s.project, lastSavedAt: new Date().toISOString() } }), SILENT);
  _dirty = false;
  dispatch(EVENTS.PROJECT_SAVED, {});
  await _pushRecent(getState().project.name, _fileHandle);
  await kvDelete(`${AUTOSAVE_PREFIX}${getState().project.name}`);
  Toast.show('Project saved', 'success', 2000);
}

/** Prompt for a file location and save there. */
export async function saveAs() {
  const suggested = `${getState().project.name || 'Untitled'}${FILE_EXT}`;
  let handle;
  try {
    handle = await window.showSaveFilePicker({ suggestedName: suggested, types: FILE_TYPES });
  } catch (err) {
    if (err?.name === 'AbortError') return;
    throw err;
  }
  _fileHandle = handle;
  const name = handle.name.replace(/\.mixo$/i, '');
  setState(s => ({ ...s, project: { ...s.project, name } }), SILENT);
  await save();
}

/** Prompt for a .mixo file and load it. */
export async function open() {
  if (_dirty) {
    const choice = await _confirmDirty();
    if (choice === 'cancel') return;
    if (choice === 'save')   await save();
  }
  let handle;
  try {
    [handle] = await window.showOpenFilePicker({ types: FILE_TYPES, multiple: false });
  } catch (err) {
    if (err?.name === 'AbortError') return;
    throw err;
  }
  const file = await handle.getFile();
  const doc  = JSON.parse(await file.text());
  _fileHandle = handle;
  await _loadProject(doc);
}

/** Reset to a blank project (confirm if dirty). */
export async function newProject() {
  if (_dirty) {
    const choice = await _confirmDirty();
    if (choice === 'cancel') return;
    if (choice === 'save')   await save();
  }
  historyClear();
  _resetWorld();
  _fileHandle = null;
  SceneManager.rebuildBed();
  SceneManager.setGrid(getState().scene.grid);
  for (const [k, v] of Object.entries(getState().scene.overlays || {})) {
    SceneManager.setOverlay(k, !!v);
  }
  dispatch(EVENTS.PROJECT_NEW, {});
  _dirty = false;
  dispatch(EVENTS.PROJECT_SAVED, {});
  Toast.show('New project', 'info', 2000);
}

/** @returns {Promise<Array>} recent project entries (most-recent first). */
export async function getRecentProjects() {
  return (await kvGet(RECENT_KEY)) || [];
}

/** Open a recent project by its stored entry. */
export async function openRecent(rec) {
  if (_dirty) {
    const choice = await _confirmDirty();
    if (choice === 'cancel') return;
    if (choice === 'save')   await save();
  }
  const handle = await getFileHandle(rec.handleKey);
  if (!handle) { Toast.show('Recent project handle lost', 'error', 4000); return; }
  if ((await handle.requestPermission({ mode: 'read' })) !== 'granted') {
    Toast.show('Permission denied for that file', 'warning', 4000);
    return;
  }
  const file = await handle.getFile();
  _fileHandle = handle;
  await _loadProject(JSON.parse(await file.text()));
}

/**
 * Relink a ghost / unlinked asset to a file the user picks. Re-binds every
 * scene object backed by that asset to the freshly-loaded geometry.
 * @param {string} assetId
 */
export async function relinkAsset(assetId) {
  let handle;
  try {
    [handle] = await window.showOpenFilePicker({ multiple: false });
  } catch (err) {
    if (err?.name === 'AbortError') return;
    throw err;
  }
  const file = await handle.getFile();
  const ext  = _extOf(file.name);
  const geom = await AssetLoader.restoreContainer(assetId, file, ext);

  const objs = Object.values(getState().scene.objects).filter(o => o.assetId === assetId);
  for (const o of objs) {
    const old = AssetLoader.getBabylonMesh(o.id);
    const t   = old ? _decompose(old) : (o._savedTransform ?? null);
    if (old && _ghostMeshes.has(old)) { _ghostMeshes.delete(old); old.dispose(); }
    const idx  = Number.isInteger(o.containerMeshIndex) ? o.containerMeshIndex : 0;
    const mesh = geom[idx] || geom.find(m => m.name === o.name) || geom[0];
    if (!mesh) continue;
    AssetLoader.bindRestoredMesh(o.id, mesh, assetId, o.sourceUnit);
    _applyWorld(mesh, t);
    const vis = o.visible !== false;
    mesh.setEnabled(vis); mesh.isVisible = vis;
    setState(s => ({
      ...s,
      scene: { ...s.scene, objects: { ...s.scene.objects,
        [o.id]: { ...s.scene.objects[o.id], isGhost: false, isUnlinked: false } } },
    }), SILENT);
    if (o.shaderId && getState().scene.shaders[o.shaderId]) ShaderLibrary.assignToMesh(o.shaderId, o.id);
  }
  ShaderLibrary.rebuildLinkedIndex();
  dispatch(EVENTS.ASSET_RELINKED, { assetId });
  dispatch(EVENTS.PROJECT_LOADED, {});   // cheap full re-render of Outliner etc.
  Selection.refresh();
  Toast.show('Asset relinked', 'success', 3000);
}

// ── Autosave ─────────────────────────────────────────────

export function startAutosave(ms = 60000) {
  stopAutosave();
  _autosaveTimer = setInterval(async () => {
    if (!_dirty) return;
    try {
      const doc = await _buildDocument();
      await kvSet(`${AUTOSAVE_PREFIX}${getState().project.name}`, {
        savedAt: new Date().toISOString(), doc,
      });
      dispatch(EVENTS.AUTOSAVE_WRITTEN, {});
    } catch (err) {
      console.error('Autosave failed:', err);
    }
  }, ms);
}

export function stopAutosave() {
  if (_autosaveTimer) { clearInterval(_autosaveTimer); _autosaveTimer = null; }
}

/**
 * On boot, offer to recover the newest autosave if one exists.
 * @returns {Promise<boolean>} true if a project was recovered
 */
export async function recoverAutosave() {
  let keys;
  try { keys = await kvKeys(); } catch { return false; }
  const auto = (keys || []).filter(k => typeof k === 'string' && k.startsWith(AUTOSAVE_PREFIX));
  if (!auto.length) return false;

  let newest = null;
  for (const k of auto) {
    const v = await kvGet(k);
    if (v?.savedAt && (!newest || v.savedAt > newest.savedAt)) newest = { key: k, ...v };
  }
  if (!newest) return false;

  const choice = await new Promise(resolve => {
    dispatch(EVENTS.MODAL_OPEN, {
      id: 'recoverAutosave',
      savedAt: newest.savedAt,
      onClose: (r) => resolve(r || 'discard'),
    });
  });
  if (choice === 'recover') {
    await _loadProject(newest.doc);
    return true;
  }
  await kvDelete(newest.key);
  return false;
}

// ── Dirty tracking + dirty-confirm modal ─────────────────

function _confirmDirty() {
  return new Promise(resolve => {
    dispatch(EVENTS.MODAL_OPEN, {
      id: 'dirtyConfirm',
      blocking: true,
      onClose: (r) => resolve(r || 'cancel'),
    });
  });
}

/** Wire dirty tracking. Call once at boot. */
export function init() {
  subscribe(EVENTS.PROJECT_DIRTY,  () => { _dirty = true; });
  subscribe(EVENTS.PROJECT_SAVED,  () => { _dirty = false; });
  subscribe(EVENTS.PROJECT_LOADED, () => { _dirty = false; });
  subscribe(EVENTS.PROJECT_NEW,    () => { _dirty = false; });
}

export const PersistenceManager = {
  init,
  save, saveAs, open, newProject,
  getRecentProjects, openRecent, relinkAsset,
  startAutosave, stopAutosave, recoverAutosave,
};

// Headless-test surface only. These are pure, browser-API-light helpers that
// carry the milestone-critical invariants (byte-exact embed, asset-resolution
// priority, migration). Not part of the public API — do not call from app code.
export const __test = {
  _b64FromBuf, _bufFromB64, _sha256Hex, _extOf,
  _resolveAssetBlob, _scanDirForHash, _fileHandleAtPath,
  _arrToMap, _migrate,
};
