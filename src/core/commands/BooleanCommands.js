// Interactive Boolean command (ADR 0002). The CSG2 compute + synthetic-asset
// registration are ASYNC, so `performBoolean` does that work up front (and applies
// the scene mutation), then returns an ALREADY-APPLIED BooleanCommand whose sync
// execute/undo drive redo/undo — mirroring how the gizmo commits a transform.
// The caller (ContextMenu) pushes the returned command onto HistoryManager.

import { EVENTS } from '../events.js';
import { getState, setState, dispatch, markDirty } from '../StateManager.js';
import { AssetLoader } from '../AssetLoader.js';
import { Selection } from '../Selection.js';
import { ShaderLibrary } from '../ShaderLibrary.js';
import { evaluateBooleanEligibility, computeBoolean } from '../BooleanService.js';
import { canonicalObjectId, logicalObjectPartIds } from '../LogicalObjects.js';
import { withDetachedPivot, removeSceneObject, restoreSceneObject } from './support.js';

function _operandDescriptor(id, objects) {
  const m = AssetLoader.getBabylonMesh(id);
  return {
    id,
    triangles: m ? Math.floor((m.getTotalIndices?.() ?? 0) / 3) : 0,
    // Solid-colour-first (ADR 0002): the textured-operand gate is a UI concern
    // (bake-or-cancel modal). The command assumes solid operands.
    solidColor: true,
    partCount: logicalObjectPartIds(id, objects).length,
  };
}

/**
 * Run an interactive Boolean and apply it to the scene. Async (CSG2 + serialise).
 * Returns an already-applied `BooleanCommand` for the caller to push, or a
 * `{ blocked, reason }` when eligibility fails (caller surfaces the reason).
 *
 * @param {string[]} meshIds  selected object ids
 * @param {'union'|'subtract'|'intersect'} op  subtract base = meshIds[0]'s object
 * @returns {Promise<BooleanCommand | { blocked: true, reason: string }>}
 */
export async function performBoolean(meshIds, op) {
  const objects = getState().scene.objects;
  const operandIds = [...new Set((meshIds ?? []).map(id => canonicalObjectId(id, objects)).filter(Boolean))];
  const gate = evaluateBooleanEligibility(operandIds.map(id => _operandDescriptor(id, objects)));
  if (!gate.ok) return { blocked: true, reason: gate.reason };

  const meshes = operandIds.map(id => AssetLoader.getBabylonMesh(id)).filter(Boolean);
  if (meshes.length < 2) return { blocked: true, reason: 'needs-two' };

  const result = await computeBoolean(op, meshes, { name: op });
  const { assetId, meshId } = await AssetLoader.registerBakedResult(result, `${op}_result`);

  const lead = objects[operandIds[0]];
  const resultObj = {
    id: meshId, name: op, assetId,
    collectionId: lead?.collectionId ?? null, parentId: null,
    shaderId: lead?.shaderId ?? null,
    visible: true, locked: false, isGhost: false, isUnlinked: false, isPrintPart: true,
    sourceGroupId: null, logicalObjectId: null, isInternalPart: false,
    containerMeshIndex: 0, ratio: 1,
  };

  const snapshots = [];
  withDetachedPivot(() => {
    for (const id of operandIds) {
      const o = objects[id];
      const m = AssetLoader.getBabylonMesh(id);
      if (!o || !m) continue;
      snapshots.push({ id, obj: { ...o }, mesh: m, prevParent: m.parent ?? null });
      m.setParent(null);
      m.setEnabled(false);
      removeSceneObject(id);
    }
    setState(s => ({ ...s, scene: { ...s.scene, objects: { ...s.scene.objects, [meshId]: resultObj } } }), { silent: true });
    if (resultObj.shaderId) ShaderLibrary.assignToMesh(resultObj.shaderId, meshId);
    dispatch(EVENTS.OBJECT_RESTORED, { id: meshId });
    Selection.set([meshId], meshId);
  });
  markDirty();

  return new BooleanCommand({ snapshots, resultId: meshId, resultAssetId: assetId, resultObj });
}

/**
 * Undo/redo for a Boolean. The mutation already happened in `performBoolean`, so the
 * FIRST execute is a no-op; undo restores the operands + hides the result; redo
 * re-hides operands + shows the result. The synthetic asset + result mesh stay
 * registered across undo/redo (only enabled/SceneObject state toggles).
 */
export class BooleanCommand {
  constructor({ snapshots, resultId, resultAssetId, resultObj }) {
    this._snapshots = snapshots;
    this._resultId = resultId;
    this._resultAssetId = resultAssetId;
    this._resultObj = resultObj;
    this._skipFirstExecute = true;
    this.label = resultObj?.name ? `Boolean (${resultObj.name})` : 'Boolean';
  }

  execute() {
    if (this._skipFirstExecute) { this._skipFirstExecute = false; markDirty(); return; }
    withDetachedPivot(() => {
      for (const s of this._snapshots) { s.mesh.setParent(null); s.mesh.setEnabled(false); removeSceneObject(s.id); }
      const rm = AssetLoader.getBabylonMesh(this._resultId);
      if (rm) rm.setEnabled(true);
      restoreSceneObject(this._resultId, this._resultObj);
      if (this._resultObj.shaderId) ShaderLibrary.assignToMesh(this._resultObj.shaderId, this._resultId);
      Selection.set([this._resultId], this._resultId);
    });
    markDirty();
  }

  undo() {
    withDetachedPivot(() => {
      const rm = AssetLoader.getBabylonMesh(this._resultId);
      if (rm) rm.setEnabled(false);
      removeSceneObject(this._resultId);
      for (const s of this._snapshots) {
        s.mesh.setEnabled(true);
        s.mesh.setParent(s.prevParent);
        restoreSceneObject(s.id, s.obj);
      }
      const ids = this._snapshots.map(s => s.id);
      if (ids.length) Selection.set(ids, ids[0]);
    });
  }
}
