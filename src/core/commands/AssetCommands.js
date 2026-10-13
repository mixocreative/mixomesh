// Asset commands (overhaul task 4.5). Split from HistoryManager like the other
// command modules; re-exported from there.

import { EVENTS } from '../events.js';
import { dispatch, getState, setState, markDirty } from '../StateManager.js';
import { Selection } from '../Selection.js';
import { AssetLoader } from '../AssetLoader.js';
import { ShaderLibrary } from '../ShaderLibrary.js';
import { sha256Hex } from '../hash.js';
import { extOf } from '../assets/AssetTypes.js';
import {
  prepareAssetReplacement, installAssetSet, applyPersistedRatioBake,
  cloneRestoredMesh,
} from '../assets/AssetRestore.js';
import { decompose, applyWorld } from '../persist/ProjectSerializer.js';
import { SILENT } from './support.js';

/**
 * Replace the bytes behind an asset: Relink (ghost / missing asset -> a file the
 * user picked), Find-moved, or Refresh (a `changed` asset re-read from its own
 * source). Every SceneObject of the asset is re-bound to the new geometry,
 * keeping its transform, parent, ratio, material and every other field; the
 * asset entry takes the new filename / extension / link / contentHash, so the
 * next save embeds the NEW bytes under the NEW hash.
 *
 * Loading is async, execute/undo/redo are synchronous swaps: build it with
 * `await RelinkAssetCommand.create(...)` and push the result. Both geometry
 * sets stay alive in the command, so undo restores the previous meshes (or the
 * ghost placeholder) and the previous asset entry exactly, and redo re-applies
 * the same prepared meshes. Held meshes are disabled + scene-detached while
 * inactive; they are released with the page (history has no dispose hook).
 */
export class RelinkAssetCommand {
  /**
   * @param {string} assetId
   * @param {{
   *   blob: Blob, filename: string, siblingFiles?: File[],
   *   link?: { directoryHandleKey?: string|null, fileHandleKey?: string|null,
   *            originalPath?: string|null, source?: object|null },
   *   label?: string,
   * }} spec
   *   `link` = the provenance the asset takes (Relink: the picked file's
   *   fileHandleKey + source). Omit to KEEP the existing link (Refresh).
   * @returns {Promise<RelinkAssetCommand>}
   */
  static async create(assetId, spec) {
    const entry = getState().scene.assetLibrary[assetId];
    if (!entry) throw new Error(`RelinkAssetCommand: unknown asset ${assetId}`);
    const { blob } = spec;
    const filename = spec.filename || entry.filename;
    const extension = extOf(filename);
    const contentHash = await sha256Hex(await blob.arrayBuffer());
    const { previous, next } = await prepareAssetReplacement(assetId, blob, extension, {
      ...(spec.siblingFiles ? { siblingFiles: spec.siblingFiles } : {}),
    });
    const patch = { filename, extension, contentHash, isGhost: false, libraryItem: null };
    if (entry.sourceFileHash != null || spec.link?.fileHandleKey) patch.sourceFileHash = contentHash;
    if (spec.link) {
      patch.directoryHandleKey = spec.link.directoryHandleKey ?? null;
      patch.fileHandleKey = spec.link.fileHandleKey ?? null;
      patch.originalPath = spec.link.originalPath ?? null;
      patch.source = spec.link.source ?? null;
    }
    return new RelinkAssetCommand(assetId, { previous, next, patch, label: spec.label });
  }

  constructor(assetId, { previous, next, patch, label }) {
    this._assetId = assetId;
    this._previous = previous;   // AssetSet
    this._next = next;           // AssetSet
    this._patch = patch;
    this._prevEntry = null;      // asset entry before the first execute
    this._bound = null;          // objId -> { prevMesh, nextMesh, prevFields }
    this.label = label ?? 'Relink Asset';
  }

  /** New content hash this command writes (also readable on the asset entry). */
  get contentHash() { return this._patch.contentHash; }

  execute() {
    const assetId = this._assetId;
    const lib = getState().scene.assetLibrary;
    this._prevEntry ??= { ...lib[assetId] };
    if (!this._bound) this._bindFirstTime();
    this._swap(this._previous, this._next, 'nextMesh', { ...this._prevEntry, ...this._patch });
  }

  undo() {
    this._swap(this._next, this._previous, 'prevMesh', this._prevEntry, true);
  }

  _bindFirstTime() {
    const assetId = this._assetId;
    const asset = { ...getState().scene.assetLibrary[assetId], ...this._patch };
    const geom = this._next.meshes;
    const reBaked = new WeakSet();
    const used = new Set();
    this._bound = {};
    const objs = Object.values(getState().scene.objects).filter(o => o.assetId === assetId);
    for (const o of objs) {
      const prevMesh = AssetLoader.getBabylonMesh(o.id) ?? null;
      const idx = Number.isInteger(o.containerMeshIndex) ? o.containerMeshIndex : 0;
      const src = geom[idx] || geom.find(m => m.name === o.name) || geom[0] || null;
      const rec = {
        prevMesh, nextMesh: null,
        prevFields: { isGhost: !!o.isGhost, isUnlinked: !!o.isUnlinked },
        shaderId: o.shaderId ?? null, visible: o.visible !== false,
        parent: prevMesh?.parent ?? null,
        xform: prevMesh ? decompose(prevMesh) : (o._savedTransform ?? null),
      };
      this._bound[o.id] = rec;
      if (!src) continue;
      applyPersistedRatioBake(src, asset, o.ratio, reBaked);
      let mesh = src;
      if (used.has(src)) {
        // Two objects of one asset on the same container mesh: each owns its
        // geometry (mirrors the load path), clone after the ratio bake.
        mesh = cloneRestoredMesh(src, o.id, assetId, o.sourceUnit);
        reBaked.add(mesh);
      }
      used.add(src);
      rec.nextMesh = mesh;
    }
  }

  _swap(from, to, meshKey, entry, toPrevious = false) {
    const assetId = this._assetId;
    for (const rec of Object.values(this._bound)) {
      const gone = toPrevious ? rec.nextMesh : rec.prevMesh;
      if (gone && gone !== rec[meshKey]) gone.setEnabled?.(false);
    }
    // Registry slots (container / blob URL / OBJ siblings) follow the live set.
    installAssetSet(assetId, to);
    if (from.container) from.container.removeAllFromScene?.();
    if (to.container) to.container.addAllToScene?.();

    setState(s => ({
      ...s,
      scene: { ...s.scene, assetLibrary: { ...s.scene.assetLibrary, [assetId]: entry } },
    }), SILENT);

    for (const [id, rec] of Object.entries(this._bound)) {
      const mesh = rec[meshKey];
      if (!mesh) continue;
      const obj = getState().scene.objects[id];
      if (!obj) continue;
      if (!toPrevious) {
        if (rec.xform && !rec.placed) {
          applyWorld(mesh, rec.xform);
          if (rec.parent) mesh.setParent(rec.parent);
          rec.placed = true;
        }
        const live = rec.shaderId && getState().scene.shaders[rec.shaderId];
        if (live && rec.prevMesh?.material) mesh.material = rec.prevMesh.material;
      }
      AssetLoader.bindRestoredMesh(id, mesh, assetId, obj.sourceUnit);
      mesh.setEnabled?.(rec.visible);
      mesh.isVisible = rec.visible;
      const fields = toPrevious ? rec.prevFields : { isGhost: false, isUnlinked: false };
      setState(s => {
        const cur = s.scene.objects[id];
        if (!cur) return s;
        return { ...s, scene: { ...s.scene, objects: { ...s.scene.objects, [id]: { ...cur, ...fields } } } };
      }, SILENT);
    }
    ShaderLibrary.rebuildLinkedIndex?.();
    for (const id of Object.keys(this._bound)) dispatch(EVENTS.OBJECT_UPDATED, { meshId: id });
    dispatch(EVENTS.ASSET_RELINKED, { assetId });
    Selection.refresh?.();
    markDirty();
  }
}
