// Load-side pipeline: schema migration, world teardown, tiered asset restore,
// scene-object/shader/group rebuild, ghost placeholders for unresolved assets,
// and relink. All AssetLoader calls go through the API OBJECT — monkey-patching
// it is the established headless-test seam (bundle-1 plan 2026-06-11).

import { EVENTS } from '../events.js';
import { getState, setState, dispatch, replaceState, freshState } from '../StateManager.js';
import { SceneManager } from '../SceneManager.js';
import { AssetLoader } from '../AssetLoader.js';
import { ShaderLibrary } from '../ShaderLibrary.js';
import { MeshValidator } from '../MeshValidator.js';
import { Selection } from '../Selection.js';
import { clear as historyClear } from '../HistoryManager.js';
import { Toast } from '../../ui/Toast.js';
import { t } from '../../i18n/index.js';
import { kvDelete, getFileHandle } from '../idb.js';
import { decompose, applyWorld, stripFileData, extOf } from './ProjectSerializer.js';
import { resolveAssetBlob } from './AssetResolver.js';
import { clearDirty } from './DirtyTracker.js';
import { AUTOSAVE_PREFIX, SILENT } from './constants.js';

const BABYLON = window.BABYLON;

const _ghostMeshes = new Set(); // wireframe placeholders for unresolved assets

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

/** Dispose everything scene-side and reset state to factory. */
export function resetWorld() {
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
    applyWorld(node, g.transform);
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

export function migrate(doc) {
  // v3.0 saves carried a scalar scene.gridSize — intentionally dropped
  // (footprint now tracks the printer bed). Everything else is forward
  // compatible; unknown future versions still attempt a best-effort load.
  return doc;
}

export function resolveLoadedExportRatios(loadedPrint = {}) {
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

export function arrToMap(arr) {
  const m = {};
  for (const x of arr || []) m[x.id] = x;
  return m;
}

/** Rebuild the full project (state + scene) from a parsed .mixo document. */
export async function loadProject(doc) {
  const data = migrate(doc);
  historyClear();
  resetWorld();

  // Per-object ratio redesign migration: ensure an `exportRatios` list. New
  // saves carry it; pre-redesign saves carry only a single `targetRatio`.
  const loadedPrint = data.print || {};
  const exportRatios = resolveLoadedExportRatios(loadedPrint);
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
      collections:  arrToMap(data.collections),
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
      AssetLoader.registerAssetEntry(stripFileData(a));
      assetRes.set(a.id, { status: 'imported' });
      continue;
    }
    const r = await resolveAssetBlob(a);
    if (a.kind === 'texture') {
      if (r) { await AssetLoader.restoreTexture(stripFileData(a), r.blob); assetRes.set(a.id, { status: r.live ? 'live' : 'static' }); }
      else   { AssetLoader.registerAssetEntry(stripFileData(a)); assetRes.set(a.id, { status: 'ghost' }); }
      continue;
    }
    AssetLoader.registerAssetEntry(stripFileData(a));
    if (!r) { assetRes.set(a.id, { status: 'ghost' }); continue; }
    if (a.libraryItem && !sceneObjectCountByAsset.get(a.id)) {
      AssetLoader.cacheAssetBlob(a.id, r.blob);
      assetRes.set(a.id, { status: r.live ? 'live' : 'static' });
      continue;
    }
    try {
      // OBJ: hand the live directory over so mtllib/texture siblings rebind
      // (permission was just granted in resolveAssetBlob's tier-1 attempt).
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
      // Console-only by policy: the ghost placeholder + unmatchedAssets modal
      // already surface the failure in the scene.
      console.error(`Container restore failed for ${a.filename}:`, err);
      assetRes.set(a.id, { status: 'ghost' });
    }
  }

  for (const sh of data.shaders || []) ShaderLibrary.restoreShader(sh);

  const objMap = {};
  const assetById = arrToMap(data.assetLibrary);
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
      applyWorld(mesh, o.transform);
      const vis = o.visible !== false;
      mesh.setEnabled(vis);
      mesh.isVisible = vis;
    } else {
      ghost = true;
      const box = _makeGhostMesh(o);
      applyWorld(box, o.transform);
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

  clearDirty();
  dispatch(EVENTS.PROJECT_SAVED, {});                        // project is clean post-load
  await kvDelete(`${AUTOSAVE_PREFIX}${getState().project.name}`);

  if (unmatched.length) {
    dispatch(EVENTS.MODAL_OPEN, { id: 'unmatchedAssets', assets: unmatched });
  }
  Toast.show(t('toast.loaded', { name: getState().project.name }), 'success', 3000);
}

// ── Relink ───────────────────────────────────────────────

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
  const ext  = extOf(file.name);
  const geom = await AssetLoader.restoreContainer(assetId, file, ext);

  const objs = Object.values(getState().scene.objects).filter(o => o.assetId === assetId);
  // Shared guard so two objects that alias one restored mesh don't double-bake
  // the ratio scale (mirrors the loadProject restore loop).
  const _reBaked = new WeakSet();
  for (const o of objs) {
    const old = AssetLoader.getBabylonMesh(o.id);
    const t   = old ? decompose(old) : (o._savedTransform ?? null);
    if (old && _ghostMeshes.has(old)) { _ghostMeshes.delete(old); old.dispose(); }
    const idx  = Number.isInteger(o.containerMeshIndex) ? o.containerMeshIndex : 0;
    const mesh = geom[idx] || geom.find(m => m.name === o.name) || geom[0];
    if (!mesh) continue;
    AssetLoader.bindRestoredMesh(o.id, mesh, assetId, o.sourceUnit);
    _applyPersistedRatioBake(mesh, getState().scene.assetLibrary[assetId], o.ratio, _reBaked);
    applyWorld(mesh, t);
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
