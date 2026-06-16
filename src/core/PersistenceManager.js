import { EVENTS } from './events.js';
import {
  getState, setState, dispatch, subscribe, replaceState, freshState,
} from './StateManager.js';
import { SceneManager } from './SceneManager.js';
import { settleImportBounce } from './scene/ImportBounce.js';
import { capturePng } from './RenderOutput.js';
import { AssetLoader } from './AssetLoader.js';
import { ShaderLibrary } from './ShaderLibrary.js';
import { MeshValidator } from './MeshValidator.js';
import { Selection } from './Selection.js';
import { SettingsStore } from './SettingsStore.js';
import {
  clear as historyClear,
  getPosition as historyPosition,
  isApplying as historyIsApplying,
} from './HistoryManager.js';
import { Toast } from '../ui/Toast.js';
import { t } from '../i18n/index.js';
import {
  kvSet, kvGet, kvDelete, kvKeys,
  putFileHandle, getFileHandle,
} from './idb.js';

const BABYLON = window.BABYLON;

// 3.2 adds §10b texture-identity fields (sourceFileHash / sourceAssetId /
// babylonTextureName) on texture AssetEntries. 3.1 docs load unchanged —
// missing fields skip the imported-texture rebind and fall back to colour.
const SCHEMA_VERSION = '3.2';
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

function _applyPersistedRatioBake(mesh, asset, ratio, rebaked = null) {
  if (!mesh?.geometry) return;
  if (rebaked?.has(mesh)) return;
  const modelRatio = (Number.isFinite(asset?.modelRatio) && asset.modelRatio > 0) ? asset.modelRatio : 1;
  const objRatio = (Number.isFinite(ratio) && ratio > 0) ? ratio : 1;
  const delta = modelRatio / objRatio;
  if (Number.isFinite(delta) && delta > 0 && Math.abs(delta - 1) > 1e-9) {
    mesh.bakeTransformIntoVertices(BABYLON.Matrix.Scaling(delta, delta, delta));
    mesh.refreshBoundingInfo?.();
  }
  rebaked?.add(mesh);
}

// ── Serialise ────────────────────────────────────────────

function _stripFileData(a) {
  const { fileData, ...rest } = a;   // never keep base64 in live state
  return rest;
}

async function _serialiseAssetLibrary({ skipEmbed = false } = {}) {
  const lib = getState().scene.assetLibrary;
  const out = [];
  for (const a of Object.values(lib)) {
    const base = {
      id: a.id, name: a.name, filename: a.filename,
      displayName: a.displayName ?? null,
      originalPath: a.originalPath ?? null, extension: a.extension,
      kind: a.kind ?? 'mesh', sourceUnit: a.sourceUnit ?? 'millimeters',
      unitConfirmed: a.unitConfirmed !== false, modelRatio: a.modelRatio ?? 1,
      directoryHandleKey: a.directoryHandleKey ?? null,
      fileHandleKey: a.fileHandleKey ?? null,
      isImported: !!a.isImported,
      // §10b texture identity — drive dedupe scoping + reload rebind.
      sourceFileHash: a.sourceFileHash ?? null,
      sourceAssetId: a.sourceAssetId ?? null,
      babylonTextureName: a.babylonTextureName ?? null,
      libraryItem: a.libraryItem ?? null,
      thumbnailDataUrl: typeof a.thumbnailDataUrl === 'string'
        && a.thumbnailDataUrl.startsWith('data:') ? a.thumbnailDataUrl : null,
      fileData: null, contentHash: null,
    };
    // Embed bytes for meshes + user-loaded textures. glTF-embedded textures
    // are owned by their container — no standalone bytes to keep. Autosave
    // passes skipEmbed (arch A9): re-encoding every asset to base64 each
    // 60s froze the main thread on big scenes; recovery resolves assets via
    // the live tiers (dir / hash-scan / file handle) using the kept hash.
    //
    // EXCEPTION (M7): a LOOSE drag-drop has no dir/file handle, so its embedded
    // bytes are the ONLY recovery path — autosave must embed it anyway or
    // crash-recovery resolves it to a ghost. Container-owned textures still
    // never carry standalone bytes (skipped either way).
    const isContainerTexture = a.kind === 'texture' && a.isImported;
    const hasLiveTier = !!a.directoryHandleKey || !!a.fileHandleKey;
    if (skipEmbed && (hasLiveTier || isContainerTexture)) {
      base.contentHash = a.contentHash ?? null;
    } else if (!isContainerTexture) {
      try {
        const buf = await AssetLoader.getAssetBytes(a.id);
        if (buf) {
          base.fileData    = _b64FromBuf(buf);
          // Bytes are immutable per assetId — reuse the import-time hash
          // instead of re-hashing on every save (review M16).
          base.contentHash = a.contentHash ?? await _sha256Hex(buf);
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
      logicalObjectId: o.logicalObjectId ?? null,
      isInternalPart: !!o.isInternalPart,
      containerMeshIndex,
      // Per-object scale ratio (2026-06-16). Persisted so each object keeps its
      // ratio across save/reload, never lost.
      ratio: (Number.isFinite(o.ratio) && o.ratio > 0) ? o.ratio : 1,
      // Auto-fix geometry edits (weld / normal-flip) are baked into live
      // vertices, not the raw source bytes — persist the applied fix types so
      // they replay on reload (M1) instead of vanishing.
      geometryFixes: Array.isArray(o.geometryFixes) && o.geometryFixes.length ? [...o.geometryFixes] : undefined,
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

async function _buildDocument(opts = {}) {
  // Snap any in-flight import/duplicate bounce to its resting scale FIRST: the
  // pop multiplies live node scaling, and _serialiseSceneObjects decomposes the
  // world matrix — a save mid-bounce would otherwise bake the transient factor
  // into the saved transform (duplicate reloaded permanently shrunk — audit
  // dup-reload bug 2026-06-16).
  settleImportBounce();
  const s = getState();
  return {
    version: SCHEMA_VERSION,
    savedAt: new Date().toISOString(),
    project: { name: s.project.name || 'Untitled' },
    sceneSettings: {
      camera: { ...SceneManager.saveCameraState(), followMode: s.scene.camera.followMode ?? 'free' },
      overlays: { ...s.scene.overlays },
      render: { ...s.scene.render },
      renderOut: { ...s.scene.renderOut },
      grid: { ...s.scene.grid },
      cursor3d: { ...s.scene.cursor3d },
    },
    print: { ...s.print },
    assetLibrary: await _serialiseAssetLibrary(opts),
    collections: Object.values(s.scene.collections ?? {}),
    shaders: Object.values(s.scene.shaders).map(({ linkedMeshIds, ...rest }) => rest),
    uvOverrides: { ...s.scene.uvOverrides },
    userSwatches: [...(s.scene.userSwatches ?? [])],
    sceneObjects: _serialiseSceneObjects(),
    groups: _serialiseGroups(),
    selection: { ...s.selection },
    gizmo: { ...s.gizmo },
    // Workspace layout is a per-USER preference (localStorage, PART 13b) —
    // a teammate opening this .mixo must not inherit the saver's layout.
    ui: (({ workspace, panelCollapsed, ...rest }) => rest)(s.ui),
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

function _resolveLoadedExportRatios(loadedPrint = {}) {
  if (Array.isArray(loadedPrint.exportRatios)) {
    return loadedPrint.exportRatios.filter(r => Number.isFinite(r) && r > 0);
  }
  return (Number.isFinite(loadedPrint.targetRatio) && loadedPrint.targetRatio > 0)
    ? [loadedPrint.targetRatio]
    : [];
}

function _printWithoutLegacyScale(loadedPrint = {}) {
  const { workingRatio, targetRatio, ...rest } = loadedPrint;
  return rest;
}

async function _loadProject(doc) {
  const data = _migrate(doc);
  historyClear();
  _resetWorld();

  // Per-object ratio redesign migration: ensure an `exportRatios` list. New
  // saves carry it; pre-redesign saves carry only a single `targetRatio`.
  const loadedPrint = data.print || {};
  const exportRatios = _resolveLoadedExportRatios(loadedPrint);
  const loadedPrintClean = _printWithoutLegacyScale(loadedPrint);

  setState(s => ({
    ...s,
    project: { ...s.project, name: data.project?.name || 'Untitled' },
    print:   { ...s.print, ...loadedPrintClean, exportRatios },
    scene: {
      ...s.scene,
      camera:   { ...s.scene.camera, ...(data.sceneSettings?.camera || {}) },
      overlays: { ...s.scene.overlays, ...(data.sceneSettings?.overlays || {}) },
      render:   { ...s.scene.render, ...(data.sceneSettings?.render || {}) },
      renderOut: {
        ...s.scene.renderOut, ...(data.sceneSettings?.renderOut || {}),
        turntable: {
          ...s.scene.renderOut?.turntable,
          ...(data.sceneSettings?.renderOut?.turntable || {}),
        },
      },
      grid:     { ...s.scene.grid, ...(data.sceneSettings?.grid || {}) },
      cursor3d: { ...s.scene.cursor3d, ...(data.sceneSettings?.cursor3d || {}) },
      userSwatches: data.userSwatches || [],
      collections:  _arrToMap(data.collections),
    },
    selection: { ...s.selection, ...(data.selection || {}) },
    gizmo:     { ...s.gizmo, ...(data.gizmo || {}) },
    // Merge saved ui but keep THIS user's workspace layout (13b: per-user,
    // not a project artefact — also guards docs from builds that saved it).
    ui:        { ...s.ui, ...(data.ui || {}), workspace: s.ui.workspace, panelCollapsed: s.ui.panelCollapsed },
  }), SILENT);

  // Assets restore BEFORE shaders (§11 Load Sequence) — restoreShader rebinds
  // diffuseTextureAssetId via getBabylonTexture, which only resolves once
  // user textures are restored and container-owned textures are rebound.
  // The pre-3.2 shaders-first order silently dropped every texture binding.
  const importedBySource = new Map();   // sourceAssetId → imported-texture entries
  for (const a of data.assetLibrary || []) {
    if (a.kind === 'texture' && a.isImported && a.sourceAssetId && a.babylonTextureName) {
      if (!importedBySource.has(a.sourceAssetId)) importedBySource.set(a.sourceAssetId, []);
      importedBySource.get(a.sourceAssetId).push(a);
    }
  }

  const assetRes = new Map();   // assetId → { status, geom? }
  const unmatched = [];
  const sceneObjectCountByAsset = new Map();
  for (const o of data.sceneObjects || []) {
    sceneObjectCountByAsset.set(o.assetId, (sceneObjectCountByAsset.get(o.assetId) ?? 0) + 1);
  }
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
    if (a.libraryItem && !sceneObjectCountByAsset.get(a.id)) {
      AssetLoader.cacheAssetBlob(a.id, r.blob);
      assetRes.set(a.id, { status: r.live ? 'live' : 'static' });
      continue;
    }
    try {
      // OBJ: hand the live directory over so mtllib/texture siblings rebind
      // (permission was just granted in _resolveAssetBlob's tier-1 attempt).
      let restoreOpts = {};
      if (a.extension === '.obj' && a.directoryHandleKey && a.originalPath) {
        try {
          const dirHandle = await getFileHandle(a.directoryHandleKey);
          if (dirHandle) restoreOpts = { dirHandle, originalPath: a.originalPath };
        } catch { /* no live dir — OBJ restores with default material */ }
      }
      const geom = await AssetLoader.restoreContainer(
        a.id, r.blob, a.extension, { ...restoreOpts, libraryItem: a.libraryItem ?? null }
      );
      const status = r.live ? 'live' : 'static';
      assetRes.set(a.id, { status, geom });
      // §10b reload rebind: re-register this container's imported textures
      // under their persisted assetIds so shader restore finds them live.
      const container = AssetLoader.getContainer(a.id);
      for (const t of importedBySource.get(a.id) ?? []) {
        const tex = container?.textures?.find?.(x => x?.name === t.babylonTextureName);
        if (tex) AssetLoader.bindRestoredTexture(t.id, tex);
      }
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

  for (const sh of data.shaders || []) ShaderLibrary.restoreShader(sh);

  const objMap = {};
  const assetById = _arrToMap(data.assetLibrary);
  const _reBaked = new WeakSet();
  // Meshes already bound to a SceneObject this load. A duplicate was saved with
  // the source's (assetId, containerMeshIndex), so the 2nd+ object resolving to
  // the same container mesh must get its OWN clone — otherwise both collapse
  // onto one mesh and only one ratio/transform survives.
  const _claimed = new Set();
  for (const o of data.sceneObjects || []) {
    const res = assetRes.get(o.assetId);
    let mesh = null, ghost = false, unlinked = false;
    if (res && res.geom) {
      const idx = Number.isInteger(o.containerMeshIndex) ? o.containerMeshIndex : 0;
      mesh = res.geom[idx] || res.geom.find(m => m.name === o.name) || res.geom[0] || null;
      unlinked = res.status === 'static';
    }
    // Per-object ratio. New saves carry `o.ratio`; MIGRATION of pre-redesign
    // saves folds the old global `print.workingRatio` into each object.
    const objRatio = (Number.isFinite(o.ratio) && o.ratio > 0)
      ? o.ratio
      : ((Number.isFinite(data.print?.workingRatio) && data.print.workingRatio > 0) ? data.print.workingRatio : 1);
    if (mesh) {
      if (_claimed.has(mesh)) {
        // Duplicate sharing a container mesh — give this object its own copy.
        mesh = AssetLoader.cloneRestoredMesh(mesh, o.id, o.assetId, o.sourceUnit);
      } else {
        AssetLoader.bindRestoredMesh(o.id, mesh, o.assetId, o.sourceUnit);
      }
      _claimed.add(mesh);
      // restoreContainer already re-ran the import seed (unit + glTF flip +
      // winding) at ratio = modelRatio. Apply the per-object ratio DELTA here
      // (modelRatio / ratio) so size AND the per-object ratio survive reload —
      // fresh + migrated saves alike. (Guarded by the browser-smoke ratio
      // round-trip.) The saved node transform (position/rot/scale) is applied
      // after; the flip lives in the vertices so it is unaffected.
      const asset = assetById[o.assetId];
      _applyPersistedRatioBake(mesh, asset, objRatio, _reBaked);
      // Replay persisted auto-fix edits at the displayed scale (after the ratio
      // bake) so the weld's absolute MERGE_DISTANCE behaves as it did when the
      // fix was first applied (M1). Each SceneObject owns a distinct mesh here
      // (duplicates were cloned above), so this replays once per object.
      if (Array.isArray(o.geometryFixes) && o.geometryFixes.length) {
        MeshValidator.replayGeometryFixes(mesh, o.geometryFixes);
      }
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
      logicalObjectId: o.logicalObjectId ?? null,
      isInternalPart: !!o.isInternalPart,
      containerMeshIndex: Number.isInteger(o.containerMeshIndex) ? o.containerMeshIndex : 0,
      ratio: objRatio,
      ...(Array.isArray(o.geometryFixes) && o.geometryFixes.length ? { geometryFixes: [...o.geometryFixes] } : {}),
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
  SceneManager.setCursorFromState(getState().scene.cursor3d);
  // Edge colour BEFORE the wireframeEdges toggle so re-enabled edge
  // renderers pick up the saved colour, not the default (review M19).
  const savedEdgeColor = getState().scene.overlays?.wireframeEdgeColor;
  if (typeof savedEdgeColor === 'string') SceneManager.setWireframeEdgeColor(savedEdgeColor);
  for (const [k, v] of Object.entries(getState().scene.overlays || {})) {
    if (k === 'wireframeEdgeColor') continue;   // value, not a toggle
    SceneManager.setOverlay(k, !!v);
  }
  SceneManager.applyRenderSettings(getState().scene.render);
  SceneManager.setScaleLock(getState().ui.scaleLocked !== false);
  ShaderLibrary.rebuildLinkedIndex();

  dispatch(EVENTS.PROJECT_LOADED, {});                       // SceneManager restores camera from state
  const fm = getState().scene.camera.followMode;
  if (fm) SceneManager.setFollowMode(fm);
  Selection.set(getState().selection.selectedIds || [], getState().selection.activeId || null);
  // Cursor visibility tracks pivotMode (set on every setPivotMode/interaction),
  // but load restores only the cursor POSITION via setCursorFromState — sync
  // visibility to the restored pivotMode so a 'cursor'-pivot project reopens
  // with the 3D cursor showing (audit LOW #22).
  SceneManager.setCursorVisible(getState().selection.pivotMode === 'cursor');

  _dirty = false;
  dispatch(EVENTS.PROJECT_SAVED, {});                        // project is clean post-load
  await kvDelete(`${AUTOSAVE_PREFIX}${getState().project.name}`);

  if (unmatched.length) {
    dispatch(EVENTS.MODAL_OPEN, { id: 'unmatchedAssets', assets: unmatched });
  }
  Toast.show(t('toast.loaded', { name: getState().project.name }), 'success', 3000);
}

function _arrToMap(arr) {
  const m = {};
  for (const x of arr || []) m[x.id] = x;
  return m;
}

// ── Recent projects + thumbnail ──────────────────────────

async function _screenshot() {
  try {
    // Routed through RenderOutput.capturePng so it works on BOTH engines —
    // CreateScreenshotUsingRenderTargetAsync returns empty on WebGPU.
    const blob = await capturePng({ width: 240, height: 160 });
    return await new Promise((res) => {
      const fr = new FileReader();
      fr.onload = () => res(fr.result);
      fr.onerror = () => res(null);
      fr.readAsDataURL(blob);
    });
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

/**
 * Write to the currently-open file, or prompt if none.
 * @returns {Promise<boolean>} true when bytes hit disk; false when the user
 *   cancelled the save picker. Callers in "save then continue" flows MUST
 *   abort on false — proceeding discards the project the user asked to keep
 *   (review H9).
 */
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
  Toast.show(t('toast.projectSaved'), 'success', 2000);
  return true;
}

/**
 * Prompt for a file location and save there.
 * @returns {Promise<boolean>} true on save, false on picker cancel.
 */
export async function saveAs() {
  const suggested = `${getState().project.name || 'Untitled'}${FILE_EXT}`;
  let handle;
  try {
    handle = await window.showSaveFilePicker({ suggestedName: suggested, types: FILE_TYPES });
  } catch (err) {
    if (err?.name === 'AbortError') return false;
    throw err;
  }
  _fileHandle = handle;
  const name = handle.name.replace(/\.mixo$/i, '');
  setState(s => ({ ...s, project: { ...s.project, name } }), SILENT);
  return save();
}

/** Prompt for a .mixo file and load it. */
export async function open() {
  if (_dirty) {
    const choice = await _confirmDirty();
    if (choice === 'cancel') return;
    if (choice === 'save' && !(await save())) return;   // picker cancelled — abort (H9)
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
    if (choice === 'save' && !(await save())) return;   // picker cancelled — abort (H9)
  }
  historyClear();
  _resetWorld();
  _fileHandle = null;
  // New starts from the user's last-used settings, not raw factory (File-wins
  // applies to OPENING a .mixo, not to New). seedBootState merges the persisted
  // per-user settings onto the fresh factory state; applyToScene pushes the
  // whole look (render/grid/overlays/bed/gizmo/pivot) to the engine.
  SettingsStore.seedBootState();
  SettingsStore.applyToScene();
  SceneManager.setCursorFromState(getState().scene.cursor3d);
  dispatch(EVENTS.PROJECT_NEW, {});
  _dirty = false;
  dispatch(EVENTS.PROJECT_SAVED, {});
  Toast.show(t('toast.newProject'), 'info', 2000);
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
    if (choice === 'save' && !(await save())) return;   // picker cancelled — abort (H9)
  }
  const handle = await getFileHandle(rec.handleKey);
  if (!handle) { Toast.show(t('toast.recentHandleLost'), 'error', 4000); return; }
  if ((await handle.requestPermission({ mode: 'read' })) !== 'granted') {
    Toast.show(t('toast.filePermissionDenied'), 'warning', 4000);
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
  // Shared guard so two objects that alias one restored mesh don't double-bake
  // the ratio scale (mirrors the _loadProject restore loop).
  const _reBaked = new WeakSet();
  for (const o of objs) {
    const old = AssetLoader.getBabylonMesh(o.id);
    const t   = old ? _decompose(old) : (o._savedTransform ?? null);
    if (old && _ghostMeshes.has(old)) { _ghostMeshes.delete(old); old.dispose(); }
    const idx  = Number.isInteger(o.containerMeshIndex) ? o.containerMeshIndex : 0;
    const mesh = geom[idx] || geom.find(m => m.name === o.name) || geom[0];
    if (!mesh) continue;
    AssetLoader.bindRestoredMesh(o.id, mesh, assetId, o.sourceUnit);
    _applyPersistedRatioBake(mesh, getState().scene.assetLibrary[assetId], o.ratio, _reBaked);
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
  Toast.show(t('toast.assetRelinked'), 'success', 3000);
}

// ── Autosave ─────────────────────────────────────────────

export function startAutosave(ms = 60000) {
  stopAutosave();
  _autosaveTimer = setInterval(async () => {
    if (!_dirty) return;
    try {
      const doc = await _buildDocument({ skipEmbed: true });   // A9
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

// Position-based dirty (Blueprint §5): dirty ⇔ history position differs from
// the position recorded at save/load/new, OR a non-undoable mutation fired
// PROJECT_DIRTY since then (sticky). Command-driven dirty events arrive while
// HistoryManager.isApplying() — the position diff already covers those, so
// they must NOT stick (undo would never read clean otherwise).
let _savedPosition = 0;
let _sticky        = false;

function _baseline() {
  _savedPosition = historyPosition();
  _sticky = false;
  _dirty = false;
}

function _recomputeDirty() {
  const next = _sticky || historyPosition() !== _savedPosition;
  if (next === _dirty) return;
  _dirty = next;
  // Announce the transition so StatusBar/ProjectMenu track undo-driven
  // changes too (undo/redo suppress PROJECT_DIRTY via withoutDirty).
  dispatch(next ? EVENTS.PROJECT_DIRTY : EVENTS.PROJECT_SAVED, {});
}

/** @returns {boolean} current dirty state (position-based + sticky). */
export function isDirty() {
  return _dirty;
}

/** Wire dirty tracking. Call once at boot. */
export function init() {
  subscribe(EVENTS.PROJECT_DIRTY, () => {
    if (!historyIsApplying()) _sticky = true;
    _dirty = true;
  });
  subscribe(EVENTS.PROJECT_SAVED,  _baseline);
  subscribe(EVENTS.PROJECT_LOADED, _baseline);
  subscribe(EVENTS.PROJECT_NEW,    _baseline);
  subscribe(EVENTS.HISTORY_PUSHED, _recomputeDirty);
  subscribe(EVENTS.HISTORY_UNDONE, _recomputeDirty);
  subscribe(EVENTS.HISTORY_REDONE, _recomputeDirty);
}

export const PersistenceManager = {
  init, isDirty,
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
  _arrToMap, _migrate, _resolveLoadedExportRatios, _buildDocument, _loadProject,
};
