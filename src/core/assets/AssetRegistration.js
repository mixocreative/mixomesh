// SceneObject / collection minting for imports — unique display names,
// logical-object grouping (so the validator welds a multi-shader object's
// parts before the manifold check), asset-library entries, and the
// post-import validation toast flow.

import { EVENTS } from '../events.js';
import { dispatch, setState, getState } from '../StateManager.js';
import { ShaderLibrary } from '../ShaderLibrary.js';
import { MeshValidator } from '../MeshValidator.js';
import { Toast } from '../../ui/Toast.js';
import { reportError } from '../../ui/Status.js';
import { reportRepairResult } from '../../ui/RepairFeedback.js';
import { t } from '../../i18n/index.js';
import { newId, registerMesh, getBabylonMesh } from './MeshRegistry.js';

/**
 * Pick a name that no existing SceneObject already owns. If `baseName` is
 * free, it's returned unchanged; otherwise we append `.NNN` (and increment
 * if it already ends in `.NNN`). Used at every entry point that adds a new
 * SceneObject — import, duplicate, primitive — so the uniqueness invariant
 * `name → at most one object` holds across the whole scene. Per-object
 * export filenames (`${project}_${name}_r{w}to{t}.${ext}`) depend on this.
 */
function _uniqueObjectName(baseName, objects = getState().scene.objects) {
  const taken = new Set(Object.values(objects).map(o => o.name));
  if (!taken.has(baseName)) return baseName;
  const m = baseName.match(/^(.*)\.(\d{3,})$/);
  const stem = m ? m[1] : baseName;
  for (let i = 1; i < 999; i++) {
    const candidate = `${stem}.${String(i).padStart(3, '0')}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${baseName}.dup`;
}

/** Like _uniqueObjectName but also avoids group-name collisions (import hierarchy). */
export function uniqueHierarchyName(baseName) {
  const state = getState();
  const taken = new Set([
    ...Object.values(state.scene.objects).map(o => o.name),
    ...Object.values(state.scene.groups).map(g => g.name),
  ]);
  if (!taken.has(baseName)) return baseName;
  const m = baseName.match(/^(.*)\.(\d{3,})$/);
  const stem = m ? m[1] : baseName;
  for (let i = 1; i < 999; i++) {
    const candidate = `${stem}.${String(i).padStart(3, '0')}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${baseName}.dup`;
}

function _logicalDisplayName(mesh) {
  // Both loader-made part suffixes are dropped from the OBJECT's name: the
  // MultiMaterial split's `__part<N>` and Babylon's glTF `_primitive<N>`
  // (a scanned bowl showed as "bowl.ar_primitive0" — sweep 2026-09-18).
  const partSuffix = /(?:__part|_primitive)\d+$/.exec(String(mesh?.name ?? ''));
  const sourceName = mesh?.metadata?.sourceMeshName ?? mesh?.metadata?.gltf?.extras?.name;
  if (sourceName) return String(sourceName);
  if (partSuffix) return String(mesh.name).slice(0, -partSuffix[0].length) || 'mesh';
  return String(mesh?.name || 'mesh');
}

/** Duplicate naming: always increments even when the base is free. */
export function nextDupName(baseName) {
  // Duplicates always increment even when the base is free, so the source
  // and the copy don't share a stem; force a collision then resolve.
  const objects = getState().scene.objects;
  const taken = new Set(Object.values(objects).map(o => o.name));
  const m = baseName.match(/^(.*)\.(\d{3,})$/);
  const stem = m ? m[1] : baseName;
  for (let i = 1; i < 999; i++) {
    const candidate = `${stem}.${String(i).padStart(3, '0')}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${baseName}.dup`;
}

/** Add an AssetEntry to the library (silent state write + ASSET_REGISTERED). */
export function registerAssetEntry(entry) {
  setState(s => ({
    ...s,
    scene: { ...s.scene, assetLibrary: { ...s.scene.assetLibrary, [entry.id]: entry } },
  }), { silent: true });
  dispatch(EVENTS.ASSET_REGISTERED, { assetId: entry.id, entry });
}

/**
 * Mint SceneObjects (+ groups) for every geometry mesh in a freshly loaded
 * container: metadata stamp, shader link, logical-object grouping, ratio seed.
 * @returns {string[]} created meshIds
 */
export function registerInstantiatedMeshes(container, assetId, sourceUnit, byMaterial, collectionId, hierarchy = null, modelRatio = 1) {
  const meshIds = [];
  const instantiatedEvents = [];
  const objectsToAdd = {};
  const groupsToAdd = {};
  const groups = hierarchy?.groups ?? {};
  for (const [id, group] of Object.entries(groups)) {
    groupsToAdd[id] = { ...group, childIds: [] };
  }
  const logicalLeadByKey = new Map();

  for (const mesh of container.meshes) {
    if (!mesh.geometry || (mesh.getTotalVertices?.() ?? 0) === 0) continue;
    const meshId = newId('mesh');
    mesh.metadata = { ...(mesh.metadata ?? {}), meshId, assetId, sourceUnit };
    registerMesh(meshId, mesh);

    const shaderId = mesh.material ? byMaterial.get(mesh.material) : null;
    const sourceGroupId = mesh.metadata?.sourceGroupId ?? null;
    const parentId = hierarchy?.groupIdForMesh?.(mesh) ?? null;

    // Logical-object key — group the parts of ONE printable object so the UI
    // shows one entry and (critically) the validator welds them before the
    // manifold check. Two cases, both watertight-as-a-whole but open along the
    // seams between parts:
    //   1. a MultiMaterial mesh split on import (shared `sourceGroupId`).
    //   2. a glTF multi-primitive mesh — Babylon names the primitives
    //      `<stem>_primitive<N>` and parents them under one node, so they share
    //      a stem AND a parentId. (Most multi-shader models export this way.)
    // Separate objects are distinct nodes with no `_primitive` name → never
    // merged (verified against a 2-object glTF).
    let logicalKey = null;
    if (sourceGroupId) {
      logicalKey = `sg:${sourceGroupId}`;
    } else {
      const prim = /^(.*)_primitive\d+$/.exec(mesh.name || '');
      // Keyed on the ORIGIN node (pre-bake), not the Outliner group: a
      // single-child wrapper no longer becomes a group, so parentId would be
      // null for every collapsed node and same-stem primitives of different
      // nodes would merge into one object.
      if (prim) logicalKey = `pp:${hierarchy?.originNodeKey?.(mesh) ?? parentId ?? ''}:${prim[1]}`;
    }

    let logicalObjectId = null;
    let isInternalPart = false;
    if (logicalKey) {
      logicalObjectId = logicalLeadByKey.get(logicalKey) ?? null;
      if (!logicalObjectId) {
        logicalObjectId = meshId;
        logicalLeadByKey.set(logicalKey, meshId);
      } else {
        isInternalPart = true;
      }
    }
    const displayName = isInternalPart
      ? _uniqueObjectName(mesh.name || 'mesh', { ...getState().scene.objects, ...objectsToAdd })
      : _uniqueObjectName(_logicalDisplayName(mesh), { ...getState().scene.objects, ...objectsToAdd });

    const sceneObject = {
      id: meshId,
      name: displayName,
      assetId,
      collectionId: collectionId ?? null,
      parentId,
      shaderId: shaderId ?? null,
      visible: mesh.isVisible !== false,
      locked: false,
      isGhost: false,
      isPrintPart: true,
      sourceGroupId,
      logicalObjectId,
      isInternalPart,
      // Per-object scale ratio (2026-06-16): seeded from the asset's authoring
      // ratio so a fresh import sits at its authored scale. Mutated live via
      // RescaleObjectCommand; persisted per object in .mixo.
      ratio: (Number.isFinite(modelRatio) && modelRatio > 0) ? modelRatio : 1,
    };
    objectsToAdd[meshId] = sceneObject;
    if (parentId && groupsToAdd[parentId]) groupsToAdd[parentId].childIds.push(meshId);

    if (shaderId) ShaderLibrary.linkMesh(shaderId, meshId);

    meshIds.push(meshId);
    instantiatedEvents.push({ assetId, meshId, meshName: mesh.name });
  }
  setState(s => ({
    ...s,
    scene: {
      ...s.scene,
      groups: { ...s.scene.groups, ...groupsToAdd },
      objects: { ...s.scene.objects, ...objectsToAdd },
    },
  }), { silent: true });
  for (const groupId of Object.keys(groupsToAdd)) dispatch(EVENTS.GROUP_CREATED, { groupId });
  for (const ev of instantiatedEvents) dispatch(EVENTS.ASSET_INSTANTIATED, ev);
  return meshIds;
}

/**
 * Create a new outliner collection (display-only file bucket) for an import.
 * Each import call mints its own collection — re-dragging the same asset still
 * gets a fresh collection (named "<filename>.001", etc.) so the user can tell
 * which drop produced which set of meshes.
 *
 * @param {string} filename  Source filename (with extension)
 * @param {string} assetId   The minted asset id this collection groups
 * @returns {string} collectionId
 */
export function createCollectionFromFilename(filename, assetId) {
  const baseName = filename;
  const taken = new Set(Object.values(getState().scene.collections ?? {}).map(c => c.name));
  let finalName = baseName;
  if (taken.has(baseName)) {
    for (let i = 1; i < 999; i++) {
      const candidate = `${baseName}.${String(i).padStart(3, '0')}`;
      if (!taken.has(candidate)) { finalName = candidate; break; }
    }
  }

  const collectionId = newId('col');
  const entry = {
    id: collectionId,
    name: finalName,
    sourceFile: filename,
    sourceAssetId: assetId,
    createdAt: new Date().toISOString(),
  };
  setState(s => ({
    ...s,
    scene: { ...s.scene, collections: { ...(s.scene.collections ?? {}), [collectionId]: entry } },
  }), { silent: true });
  dispatch(EVENTS.COLLECTION_CREATED, { collectionId, entry });
  return collectionId;
}

/**
 * Shared repair-then-toast path: repairObject (validate → autoFix → record
 * geometryFixes/dirty → re-validate), then the Task 3 success toast. Used by
 * both the manual "click to fix" toast action and the opt-in
 * print.repairOnImport auto-repair below — same recorded path either way.
 * @param {string} meshId
 * @param {string} name
 * @returns {Promise<void>}
 */
async function _repairAndToast(meshId, name) {
  try {
    reportRepairResult(name, await MeshValidator.repairObject(meshId));
  } catch (err) {
    reportError(err, { title: t('toast.autoFixFailed') });
  }
}

/**
 * Queue the non-blocking post-import validation with its toast flow. Runs
 * only for live imports (called from AssetImport.js's loadFromBlob /
 * instantiateAsset) — project-restore never calls this (AssetRestore.js has
 * its own load path), so the opt-in auto-repair below never fires on load.
 * @param {string} meshId
 * @returns {Promise<void>} resolves once validation (and any auto-repair) settles — callers may ignore it (fire-and-forget) or await it (tests).
 */
export function queueValidation(meshId) {
  const mesh = getBabylonMesh(meshId);
  if (!mesh) return Promise.resolve();
  const name = mesh.name || 'mesh';
  if (!MeshValidator.shouldAutoValidate(mesh)) {
    Toast.show(t('toast.validateSkipped', { name }), 'info', 4000);
    return Promise.resolve();
  }
  const toastId = Toast.show(t('toast.validating', { name }), 'loading');
  return Promise.resolve().then(async () => {
    try {
      const results = await MeshValidator.validateMesh(mesh);
      Toast.dismiss(toastId);
      if (!results.length) {
        Toast.show(t('toast.validateOk', { name }), 'success', 3000);
        return;
      }
      const errs  = results.filter(r => r.severity === 'error').length;
      const warns = results.filter(r => r.severity === 'warning').length;
      // B5 click-through: clicking the persistent toast opens the Print
      // Panel's Validation tab (PrintPanel subscribes; event avoids a
      // core→ui→core import cycle).
      const onClick = () => dispatch(EVENTS.VALIDATION_FOCUS_REQUESTED, { meshId });
      if (errs > 0) {
        const msg = warns
          ? t('toast.validateErrorsWithWarnings', { name, errs, warns })
          : t('toast.validateErrors', { name, errs });
        Toast.show(msg, 'error', 0, { onClick, tag: Toast.validationTag(meshId) });
      } else if (results.some(r => r.autoFixAvailable)) {
        if (getState().print?.repairOnImport) {
          // Opt-in (Task 5): skip the click-to-fix toast and just repair.
          await _repairAndToast(meshId, name);
        } else {
          // At least one warning is one-click fixable — the toast IS the fix
          // action (shared repairObject path, same as Outliner/context menu/
          // Print panel), not just a link to the Validation tab.
          const onFixClick = () => { _repairAndToast(meshId, name); };
          Toast.show(t('toast.validateWarningsFix', { name, warns }), 'warning', 0, { onClick: onFixClick, tag: Toast.validationTag(meshId) });
        }
      } else {
        Toast.show(t('toast.validateWarnings', { name, warns }), 'warning', 0, { onClick, tag: Toast.validationTag(meshId) });
      }
    } catch (err) {
      Toast.dismiss(toastId);
      // User asked for this validation — a vanishing toast reads as "passed".
      reportError(err, { title: t('toast.validateFailed', { name }) });
    }
  });
}
