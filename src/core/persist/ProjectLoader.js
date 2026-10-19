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
import { clear as historyClear, push as historyPush, RelinkAssetCommand, seedRatioSource, ratioSourceOf } from '../HistoryManager.js';
import { Toast } from '../../ui/Toast.js';
import { t } from '../../i18n/index.js';
import { directoryRefFacade } from '../assets/DirMounts.js';
import {
  applyWorld, stripFileData, bufFromB64,
  deriveAssetSource, deriveDisplayName, setPreservedTopLevelKeys,
} from './ProjectSerializer.js';
import { resolveAssetBlob, sourcesOf } from './AssetResolver.js';
import { storage } from '../storage/StorageAdapter.js';
import { clearDirty } from './DirtyTracker.js';
import { SILENT, SCHEMA_VERSION } from './constants.js';
import { normalizeListings } from '../publish/Listings.js';
import { mintProjectId } from './ProjectId.js';
import { deleteAutosave } from './AutosaveKeys.js';
import {
  validateDocument, parseSchemaVersion, compareSchemaVersions, preservedTopLevelKeys,
} from './ProjectValidator.js';
import { isLoading, setLoading } from './LoadGate.js';
import { normalizeGroupOrigin } from '../hierarchy/HierarchyIntegrity.js';
import { canonicalObjectId, seedLogicalObjectIds } from '../LogicalObjects.js';
import { normalizeExportTargets } from '../scale/ScaleMath.js';
import { applyPersistedRatioBake as _applyPersistedRatioBake } from '../assets/AssetRestore.js';
import { normalizeMixoProvenance, normalizeMixoRefinement, mixoPrimitiveId } from '../import/ImportMetadata.js';

/** Restore only lead-owned, supported Mixo Blender provenance from .mixo JSON. */
function normalizeLoadedMixoProvenance(sceneObject) {
  if (sceneObject?.isInternalPart) return null;
  return normalizeMixoProvenance(sceneObject?.mixoProvenance);
}

function normalizeLoadedMixoRefinement(sceneObject, primitiveVertexCounts) {
  if (!normalizeLoadedMixoProvenance(sceneObject) || !Array.isArray(sceneObject?.mixoRefinement)) return null;
  const descriptors = [];
  const seen = new Set();
  for (const descriptor of sceneObject.mixoRefinement) {
    if (typeof descriptor?.primitiveId !== 'string' || !descriptor.primitiveId || seen.has(descriptor.primitiveId)) return null;
    seen.add(descriptor.primitiveId);
    const vertexCount = primitiveVertexCounts?.get?.(descriptor.primitiveId);
    const normalized = normalizeMixoRefinement(descriptor, vertexCount);
    if (!normalized) return null;
    descriptors.push({ primitiveId: descriptor.primitiveId, ...normalized });
  }
  return descriptors.length ? descriptors : null;
}
import { getTextureImage, storeTextureImage } from '../assets/TextureImageStore.js';

const BABYLON = window.BABYLON;

const _ghostMeshes = new Set(); // wireframe placeholders for unresolved assets

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
  setPreservedTopLevelKeys({});
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
    groupsState[g.id] = normalizeGroupOrigin({
      id: g.id, name: g.name, parentId: g.parentId ?? null,
      childIds: [...(g.childIds ?? [])],
      origin: g.origin,
      ...(g.locked ? { locked: true } : {}),
    });
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

// ── Schema migration ladder (task 4.1) ───────────────────
//
// One step per schema minor. A step runs when the document is OLDER than the
// step's `to` version; steps run in order and each mutates the working copy
// `data` (never the caller's doc). Every per-field migration lives here and
// is idempotent, so a document whose version stamp lagged its content (e.g. a
// 3.3 file already carrying `exportTargets`) migrates cleanly.
//
// Newer-MINOR documents (3.6+) skip every step and load best-effort; their
// unknown top-level keys are preserved by the loader (preservedTopLevelKeys)
// and written back on save. Newer-MAJOR documents never reach here
// (validateDocument refuses them before the world is reset).

/** @type {{ to: string, up: (data: Record<string, any>) => void }[]} */
const MIGRATIONS = [
  // 3.0 → 3.1: v3.0 saves carried a scalar `scene.gridSize` — intentionally
  // ignored (footprint tracks the printer bed); nothing to rewrite.
  { to: '3.1', up: () => {} },
  // 3.1 → 3.2: assets-before-shaders load order is a loader change; the
  // document shape is unchanged.
  { to: '3.2', up: () => {} },
  // 3.2 → 3.3: content-addressed `textureImages` are additive; per-asset
  // `fileData` on texture entries still resolves through AssetResolver.
  { to: '3.3', up: () => {} },
  // 3.3 → 3.4: asset provenance + every per-field migration owned by 1.13 /
  // 1.15 / 1.17 / 2.7.
  { to: '3.4', up: _migrateTo34 },
  // 3.4 → 3.5: marketplace listings (PB.8) live under project.listings.
  { to: '3.5', up: _migrateTo35 },
];

function _migrateTo35(data) {
  const project = (data.project && typeof data.project === 'object') ? { ...data.project } : {};
  project.listings = normalizeListings(project.listings);
  data.project = project;
}

function _migrateTo34(data) {
  // AssetEntry `source` + `displayName` (§4.4, owned by 4.1).
  if (Array.isArray(data.assetLibrary)) {
    data.assetLibrary = data.assetLibrary.map(a => {
      if (!a || typeof a !== 'object') return a;
      return {
        ...a,
        source: a.source !== undefined ? a.source : deriveAssetSource(a),
        displayName: deriveDisplayName(a),
      };
    });
  }

  const print = (data.print && typeof data.print === 'object') ? { ...data.print } : null;
  if (print) {
    // 1.17: legacy `exportRatios` / pre-redesign `targetRatio` → typed targets.
    print.exportTargets = resolveLoadedExportTargets(print);
    // 1.15: explicit export reference — absent means "first printable unit".
    if (!('referenceObjectId' in print)) print.referenceObjectId = null;
    data.print = print;
  }

  if (Array.isArray(data.sceneObjects)) {
    const workingRatio = print?.workingRatio;
    data.sceneObjects = data.sceneObjects.map(o => {
      if (!o || typeof o !== 'object') return o;
      const next = { ...o };
      // Per-object ratio redesign (2026-06-16): fold the old global
      // `print.workingRatio` into objects saved without their own ratio.
      if (!(Number.isFinite(next.ratio) && next.ratio > 0)
        && Number.isFinite(workingRatio) && workingRatio > 0) {
        next.ratio = workingRatio;
      }
      return next;
    });
    // 2.7 / Decision 33: legacy saves link split siblings only by
    // `sourceGroupId` — seed `logicalObjectId` / `isInternalPart` ONCE here;
    // runtime never reads `sourceGroupId` again.
    seedLogicalObjectIds(data.sceneObjects);
    // 1.13 (Decision 24): seed each object's `ratioSource` from its asset —
    // a file that declared its authored scale (`modelRatio ≠ 1`) is 'file',
    // else 'default'. An explicit value already on the object is kept.
    const modelRatioByAsset = new Map((Array.isArray(data.assetLibrary) ? data.assetLibrary : [])
      .filter(a => a && typeof a === 'object').map(a => [a.id, a.modelRatio]));
    data.sceneObjects = data.sceneObjects.map(o => {
      if (!o || typeof o !== 'object' || ['file', 'user', 'default'].includes(o.ratioSource)) return o;
      return { ...o, ratioSource: seedRatioSource(modelRatioByAsset.get(o.assetId)) };
    });
  }
  // project.id (0.11) is formal in 3.4; a document without one gets a fresh
  // uuid from the loader (mintProjectId), never from migrate (pure).
}

/**
 * Bring a parsed (already validated) document up to SCHEMA_VERSION.
 * Returns a NEW top-level object (and new copies of every array/entry a step
 * rewrites); the caller's doc is never mutated. Large payloads (`fileData`
 * strings) are shared by reference, not copied.
 * @param {Record<string, any>} doc
 * @returns {Record<string, any>}
 */
export function migrate(doc) {
  const data = { ...doc };
  const from = parseSchemaVersion(doc?.version) ?? parseSchemaVersion(SCHEMA_VERSION);
  for (const step of MIGRATIONS) {
    const to = parseSchemaVersion(step.to);
    if (compareSchemaVersions(from, to) < 0) step.up(data);
  }
  // Older docs are now SCHEMA_VERSION-shaped; a newer minor keeps its stamp.
  if (compareSchemaVersions(from, parseSchemaVersion(SCHEMA_VERSION)) < 0) data.version = SCHEMA_VERSION;
  return data;
}

/**
 * Typed print sizes for a loaded `print` slice (task 1.17 migration):
 * `exportTargets` when the document carries one; else the legacy
 * `exportRatios: number[]` (or a pre-redesign single `targetRatio`) as
 * `[{kind:'ratio', value}]`. [] = as shown.
 */
export function resolveLoadedExportTargets(loadedPrint = {}) {
  if (Array.isArray(loadedPrint.exportTargets)) return normalizeExportTargets(loadedPrint.exportTargets);
  return resolveLoadedExportRatios(loadedPrint).map(value => ({ kind: 'ratio', value }));
}

export function resolveLoadedExportRatios(loadedPrint = {}) {
  if (Array.isArray(loadedPrint.exportRatios)) {
    return loadedPrint.exportRatios.filter(r => Number.isFinite(r) && r > 0);
  }
  return (Number.isFinite(loadedPrint.targetRatio) && loadedPrint.targetRatio > 0)
    ? [loadedPrint.targetRatio]
    : [];
}

/**
 * Strip the pre-redesign global scale fields AND the per-user
 * `repairOnImport` preference (I8) from a loaded `print` slice. `print` is
 * merged wholesale over the current state, so a document carrying
 * `repairOnImport` would otherwise silently override the user's own setting
 * ("file wins on open") — it is a per-user preference, not project data, and
 * is excluded from the serialised document too (ProjectSerializer.js).
 */
function _printWithoutLegacyScale(loadedPrint = {}) {
  // printMode / chordTolerance / minWallThickness: dead settings removed in
  // task 1.10 — old files must not resurrect them into state (or re-save them).
  // exportRatios / exportTargets: replaced by the normalised typed list
  // (resolveLoadedExportTargets) — the ratio mirror never lives in state.
  // strictExport: per-user (Decision 15) — an old file must not flip it.
  const { workingRatio, targetRatio, repairOnImport, strictExport, printMode, chordTolerance, minWallThickness,
    exportRatios, exportTargets, ...rest } = loadedPrint;
  // 1.3: profile-driven fields absent from the file follow the printer profile
  // (null), instead of inheriting the PREVIOUS project's overrides.
  for (const f of ['exportFormat', 'splitByMaterial', 'objAxis', 'threeMFFlavour']) {
    if (!(f in rest)) rest[f] = null;
  }
  if (!('individually' in rest)) rest.individually = false;
  return rest;
}

export function arrToMap(arr) {
  const m = {};
  for (const x of arr || []) m[x.id] = x;
  return m;
}

export { isLoading };

export const IMPORT_IN_FLIGHT_MESSAGE =
  'An import is still running — wait for it to finish before opening a project';

/** Throw if an asset import is mid-flight (F20). Shared by load / new / recover. */
export function assertNoImportInFlight() {
  if (AssetLoader.isImporting()) throw new Error(IMPORT_IN_FLIGHT_MESSAGE);
}

/**
 * Rebuild the full project (state + scene) from a parsed .mixo document.
 * Validates the document and refuses during an import BEFORE any state
 * mutation — a bad file or a racing import leaves the current project intact
 * (audit 2026-09-17 H1 / F20). `isLoading()` is true for the whole call.
 */
export async function loadProject(doc) {
  assertNoImportInFlight();
  validateDocument(doc);
  const previousId = getState().project?.id ?? null;
  setLoading(true);
  try {
    await _loadProjectInner(doc, previousId);
  } finally {
    setLoading(false);
  }
}

async function _loadProjectInner(doc, previousId) {
  const data = migrate(doc);
  historyClear();
  resetWorld();
  // Forward compat (4.1): a newer-minor doc's unknown top-level keys survive
  // this build and are written back by the next save.
  setPreservedTopLevelKeys(preservedTopLevelKeys(doc));

  // Print sizes: migrate() already turned legacy `exportRatios`/`targetRatio`
  // into `exportTargets` (1.17); this call only normalises the typed list.
  const loadedPrint = data.print || {};
  const exportTargets = resolveLoadedExportTargets(loadedPrint);
  const loadedPrintClean = _printWithoutLegacyScale(loadedPrint);

  setState(s => ({
    ...s,
    // id: the document's identity, or a fresh one for pre-0.11 files (0.11).
    // lastSavedAt: the file's own save time — autosave recovery compares to it.
    project: {
      ...s.project,
      name: data.project?.name || 'Untitled',
      id: (typeof data.project?.id === 'string' && data.project.id) || mintProjectId(),
      lastSavedAt: data.savedAt ?? data.project?.lastSavedAt ?? null,
      listings: normalizeListings(data.project?.listings),
    },
    print:   { ...s.print, ...loadedPrintClean, exportTargets },
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

  // Image resources restore before texture views/assets, which restore before
  // shaders. Equal hashes become one in-memory blob regardless of view count.
  for (const image of data.textureImages || []) {
    if (!image?.hash || !image.fileData) continue;
    const blob = new Blob([bufFromB64(image.fileData)], { type: image.mimeType || 'application/octet-stream' });
    await storeTextureImage(blob, image.width, image.height, image.hash);
  }

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
  const ghosts = [];            // asset entries with no bytes anywhere (H3)
  const _ghostAsset = (a) => {
    AssetLoader.registerAssetEntry({ ...stripFileData(a), isGhost: true });
    assetRes.set(a.id, { status: 'ghost' });
    ghosts.push(a);
  };
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
    const storedImage = a.kind === 'texture' && a.imageContentHash
      ? getTextureImage(a.imageContentHash)
      : null;
    const r = storedImage ? { blob: storedImage.blob, live: false } : await resolveAssetBlob(a);
    if (a.kind === 'texture') {
      if (r) { await AssetLoader.restoreTexture(stripFileData(a), r.blob); assetRes.set(a.id, { status: r.live ? 'live' : 'static' }); }
      else   { _ghostAsset(a); }
      continue;
    }
    if (!r) { _ghostAsset(a); continue; }
    AssetLoader.registerAssetEntry(stripFileData(a));
    if (a.libraryItem && !sceneObjectCountByAsset.get(a.id)) {
      AssetLoader.cacheAssetBlob(a.id, r.blob);
      assetRes.set(a.id, { status: r.live ? 'live' : 'static' });
      continue;
    }
    try {
      // OBJ: hand the live directory over so mtllib/texture siblings rebind
      // (permission was just granted in resolveAssetBlob's tier-1 attempt).
      // Restored through the adapter and wrapped in the runtime-neutral
      // handle facade, so desktop tokens rebind siblings too (task 4.4).
      let restoreOpts = {};
      if (a.extension === '.obj' && a.directoryHandleKey && a.originalPath) {
        try {
          const dirRef = await storage.restoreRef(a.directoryHandleKey);
          if (dirRef) restoreOpts = { dirHandle: directoryRefFacade(storage, dirRef), originalPath: a.originalPath };
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
      // Console-only by policy: the ghost placeholder + ghostAssets modal
      // (H3) surface the failure to the user at the end of the load.
      console.error(`Container restore failed for ${a.filename}:`, err);
      _ghostAsset(a);
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
  const replayFailed = new Set();   // ids whose geometryFixes replay threw — dropped from state
  for (const o of data.sceneObjects || []) {
    const res = assetRes.get(o.assetId);
    let mesh = null, ghost = false, unlinked = false;
    if (res && res.geom) {
      const idx = Number.isInteger(o.containerMeshIndex) ? o.containerMeshIndex : 0;
      mesh = res.geom[idx] || res.geom.find(m => m.name === o.name) || res.geom[0] || null;
      unlinked = res.status === 'static';
    }
    // Per-object ratio (pre-redesign `print.workingRatio` was folded in by
    // migrate()).
    const objRatio = (Number.isFinite(o.ratio) && o.ratio > 0) ? o.ratio : 1;
    const mixoProvenance = normalizeLoadedMixoProvenance(o);
    let mixoRefinement = null;
    if (mixoProvenance && Array.isArray(o.mixoRefinement)) {
      const groupMeshes = (data.sceneObjects || [])
        .filter(part => part.assetId === o.assetId && (part.id === o.id || part.logicalObjectId === o.id))
        .map(part => res?.geom?.[Number.isInteger(part.containerMeshIndex) ? part.containerMeshIndex : 0])
        .filter(Boolean);
      const primitiveVertexCounts = new Map(groupMeshes.map(part => [mixoPrimitiveId(part), part.getTotalVertices?.()]));
      mixoRefinement = normalizeLoadedMixoRefinement(o, primitiveVertexCounts);
    }
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
      // Fault-isolated per object: 'holes'/'nonManifold' replay through the
      // repair engine, which can fail (engine unavailable, triangle cap) —
      // that must not abort the rest of the load. The object's ORIGINAL
      // geometry is already bound and stays loaded; the failed fixes are
      // dropped from the object's state (so a later save does not record them
      // as applied) and the user is told which object needs Auto-Fix re-run.
      if (Array.isArray(o.geometryFixes) && o.geometryFixes.length) {
        try {
          await MeshValidator.replayGeometryFixes(mesh, o.geometryFixes);
        } catch (err) {
          console.error(`Geometry-fix replay failed for "${o.name}":`, err);
          replayFailed.add(o.id);
          Toast.show(t('toast.geometryFixReplayFailed', { name: o.name }), 'warning', 5000);
        }
      }
      applyWorld(mesh, o.transform);
      const vis = o.visible !== false;
      mesh.setEnabled(vis);
      mesh.isVisible = vis;
    } else {
      ghost = true;
      const box = _makeGhostMesh(o);
      applyWorld(box, o.transform);
      // Asset entry absent from the library altogether — still a ghost the
      // user must see; list it once under the object's name.
      if (!res && !ghosts.some(g => g.id === o.assetId)) {
        ghosts.push({ id: o.assetId, filename: o.name, name: o.name, missingEntry: true });
      }
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
      ...(mixoProvenance ? { mixoProvenance } : {}),
      ...(mixoRefinement ? { mixoRefinement } : {}),
      containerMeshIndex: Number.isInteger(o.containerMeshIndex) ? o.containerMeshIndex : 0,
      ratio: objRatio,
      // 1.13: migrate() seeds ratioSource for pre-3.4 docs; a 3.4 doc saved
      // before the field existed derives the same seed here.
      ratioSource: ratioSourceOf(o, assetById[o.assetId]),
      ...(!replayFailed.has(o.id) && Array.isArray(o.geometryFixes) && o.geometryFixes.length ? { geometryFixes: [...o.geometryFixes] } : {}),
      ...(o.sliceRecipe ? { sliceRecipe: JSON.parse(JSON.stringify(o.sliceRecipe)) } : {}),
      _savedTransform: o.transform ?? null,
    };
  }
  // logicalObjectId seeding for legacy saves (2.7) runs in migrate().
  setState(s => ({ ...s, scene: { ...s.scene, objects: objMap } }), SILENT);

  // Multi-part repairs replay ONCE per logical object, and only now — the
  // welded union needs every sibling bound with its transform applied
  // (RepairSession.replayGeometryFixes skips 'groupRepair' per mesh for this
  // reason). `record:false`: the fix types are already on the objects and a
  // load must not dirty the project. Fault-isolated like the per-mesh replay.
  const groupReplayed = new Set();
  for (const o of data.sceneObjects || []) {
    const obj = objMap[o.id];
    if (!obj || obj.isGhost || !obj.geometryFixes?.includes('groupRepair')) continue;
    const lead = canonicalObjectId(o.id, objMap);
    if (groupReplayed.has(lead)) continue;
    groupReplayed.add(lead);
    try {
      await MeshValidator.repairObject(lead, { record: false });
    } catch (err) {
      console.error(`Multi-part geometry-fix replay failed for "${obj.name}":`, err);
    }
  }

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

  // 1.15: an export reference whose object did not load (deleted, ghost-free
  // file edit) falls back to the first printable unit — drop the dangling id.
  const refId = getState().print?.referenceObjectId;
  if (refId && !getState().scene.objects[refId]) {
    setState(s => ({ ...s, print: { ...s.print, referenceObjectId: null } }), SILENT);
  }

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
  // Only AFTER a successful load: the just-opened project's own autosave is
  // stale, and so is the one for the project we just left (its dirty state
  // was either saved or explicitly discarded via the dirty-confirm). A failed
  // load above throws before reaching here, so a torn load keeps both (M2).
  const loadedId = getState().project.id;
  const loadedName = getState().project.name;
  await deleteAutosave(loadedId);
  if (previousId && previousId !== loadedId) await deleteAutosave(previousId);

  // 4.6: unresolved links and ghosts surface in the ONE Sources modal
  // (src/ui/SourcesModal.js), focused on the first affected asset.
  if (unmatched.length || ghosts.length) {
    const first = ghosts[0] ?? unmatched[0];
    dispatch(EVENTS.MODAL_OPEN, { id: 'assetSources', focusAssetId: first?.id ?? null, ghosts, unmatched });
  }
  if (ghosts.length) {
    // H3: never a plain "Loaded" — the scene is incomplete. The Sources modal
    // lists every ghost with a Relink action; the project is still saveable
    // (ghost entries serialise with `ghost: true` and no bytes).
    Toast.show(t('toast.loadedWithGhosts', { name: loadedName, n: ghosts.length }), 'warning', 6000);
    return;
  }
  Toast.show(t('toast.loaded', { name: loadedName }), 'success', 3000);
}

// ── Relink ───────────────────────────────────────────────

/**
 * Relink a ghost / missing / unlinked asset to a file the user picks. One
 * undoable RelinkAssetCommand (task 4.5): re-binds every scene object backed by
 * the asset to the freshly-loaded geometry (transforms, ratios, materials kept),
 * records the new source + contentHash so the next save embeds the new bytes.
 * @param {string} assetId
 */
export async function relinkAsset(assetId) {
  const [picked] = await storage.pickImportAssets({ multiple: false });
  if (!picked) return;
  const file = await storage.readFile(picked.ref);
  let fileHandleKey = null;
  try { fileHandleKey = await storage.persistRef(picked.ref); } catch { /* embedded-only link */ }
  const link = {
    directoryHandleKey: null, fileHandleKey, originalPath: null,
    source: fileHandleKey ? { kind: 'file', refKey: fileHandleKey, path: picked.name, label: picked.name } : null,
  };
  const cmd = await RelinkAssetCommand.create(assetId, { blob: file, filename: picked.name, link, label: 'Relink Asset' });
  historyPush(cmd);
  Toast.show(t('toast.assetRelinked'), 'success', 3000);
}

/**
 * Refresh a `changed` asset: re-read the SAME linked source and adopt its
 * current bytes (undoable, same command as Relink). Returns false when the
 * source cannot be read.
 * @param {string} assetId
 */
export async function refreshAsset(assetId) {
  const entry = getState().scene.assetLibrary[assetId];
  if (!entry) return false;
  for (const source of sourcesOf(entry)) {
    let r;
    try { r = await storage.resolveAsset(source, { contentHash: entry.contentHash }); } catch { continue; }
    if (!r?.blob) continue;
    const cmd = await RelinkAssetCommand.create(assetId, { blob: r.blob, filename: entry.filename, label: 'Refresh Asset' });
    historyPush(cmd);
    Toast.show(t('toast.assetRelinked'), 'success', 3000);
    return true;
  }
  return false;
}

/** Test seam: the pure `print`-slice sanitiser the load merge applies (I8). */
export const __test = { _printWithoutLegacyScale, _restoreGroups, normalizeLoadedMixoProvenance, normalizeLoadedMixoRefinement };
