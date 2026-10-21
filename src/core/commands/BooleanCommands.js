// Interactive Boolean command (ADR 0002). The CSG2 compute + synthetic-asset
// registration are ASYNC, so `performBoolean` does that work up front (and applies
// the scene mutation), then returns an ALREADY-APPLIED BooleanCommand whose sync
// execute/undo drive redo/undo — mirroring how the gizmo commits a transform.
// The caller (ContextMenu) pushes the returned command onto HistoryManager.

import { EVENTS } from '../events.js';
import { getState, setState, dispatch, markDirty } from '../StateManager.js';
import { t } from '../../i18n/index.js';
import { AssetLoader } from '../AssetLoader.js';
import { Selection } from '../Selection.js';
import { ShaderLibrary } from '../ShaderLibrary.js';
import { evaluateBooleanEligibility, computeBooleanAsync, booleanTriangleCap } from '../BooleanService.js';
import { isBooleanWorkerSupported } from '../BooleanWorker.js';
import { caps } from '../storage/capabilities.js';
import { revisionOf } from '../geometry/GeometryStore.js';
import { canonicalObjectId, logicalObjectPartIds } from '../LogicalObjects.js';
import { withDetachedPivot, removeSceneObject, restoreSceneObject } from './support.js';
import { retainedTrianglesOf } from './HierarchyCommands.js';

export function _isMaterialTextured(mat) {   // exported for tests
  if (!mat) return false;
  // Check all texture slots on StandardMaterial and PBRMaterial that Babylon exposes.
  // A material is textured if ANY of these slots has a texture.
  const textureSlots = [
    'diffuseTexture',         // StandardMaterial
    'albedoTexture',          // PBRMaterial
    'normalTexture',          // PBRMaterial (bump equivalent)
    'bumpTexture',            // StandardMaterial
    'emissiveTexture',        // Both
    'opacityTexture',         // StandardMaterial
    'specularTexture',        // StandardMaterial
    // NOT reflectionTexture: on PBR it is the scene environment cube map, not a
    // UV texture — counting it made every lit mesh "textured" (6.3 regression).
    'lightmapTexture',        // Both
    // detailMap / sheen / anisotropy / clearCoat are CONFIGURATION objects
    // (always truthy) — checked via their .texture below, never by presence.
    'occlusionTexture',       // PBRMaterial
    'metallicTexture',        // PBRMaterial (when combined)
    'reflectanceTexture',     // PBRMaterial
    'ambientTexture',         // StandardMaterial
    'microSurfaceTexture',    // PBRMaterial
  ];
  for (const slot of textureSlots) {
    if (mat[slot]) return true;
  }
  for (const cfg of ['detailMap', 'sheen', 'anisotropy', 'clearCoat']) {
    if (mat[cfg]?.texture) return true;
  }
  return false;
}

function _operandDescriptor(id, objects) {
  const m = AssetLoader.getBabylonMesh(id);
  // Solid-colour = no texture on the live material. CSG2/Manifold DROPS UVs
  // (ADR 0002), so a textured operand must NOT silently combine — eligibility
  // returns `needs-texture-bake` and performBoolean blocks (moat protection). A
  // future bake-or-cancel modal lets the user consciously downgrade to solid.
  const mat = m?.material;
  const solidColor = !_isMaterialTextured(mat);
  return {
    id,
    triangles: m ? Math.floor((m.getTotalIndices?.() ?? 0) / 3) : 0,
    solidColor,
    partCount: logicalObjectPartIds(id, objects).length,
  };
}

let _booleanRunning = false;

/** Fingerprint of the operands' identity, geometry revision and world matrix. */
function _operandSnapshot(ids) {
  return JSON.stringify(ids.map(id => {
    const m = AssetLoader.getBabylonMesh(id);
    if (!m || !getState().scene.objects[id]) return null;
    return [id, revisionOf(m), Array.from(m.computeWorldMatrix?.(true)?.m ?? [])];
  }));
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
export async function performBoolean(meshIds, op, opts = {}) {
  const objects = getState().scene.objects;
  const operandIds = [...new Set((meshIds ?? []).map(id => canonicalObjectId(id, objects)).filter(Boolean))];
  const triangleCap = booleanTriangleCap({ workerAvailable: isBooleanWorkerSupported(), caps });
  const gate = evaluateBooleanEligibility(operandIds.map(id => _operandDescriptor(id, objects)), { triangleCap });
  if (!gate.ok) return { blocked: true, reason: gate.reason };
  // `needs-texture-bake` is a SOFT gate (ok:true): CSG2 drops UVs, so proceeding
  // silently loses the texture (ADR 0002 moat). Block UNLESS the caller explicitly
  // opted into bake-to-solid (the modal) — then the result stays solid (no textured
  // shader inherited below; computeBoolean already gives it the operand's colour).
  if (gate.reason === 'needs-texture-bake' && !opts.bakeTexturedToSolid) {
    return { blocked: true, reason: 'needs-texture-bake' };
  }

  const meshes = operandIds.map(id => AssetLoader.getBabylonMesh(id)).filter(Boolean);
  if (meshes.length < 2) return { blocked: true, reason: 'needs-two' };

  // The Boolean runs in a worker while the UI stays live (ContextMenu shows a
  // blocking overlay, but a project load / API call could still interleave):
  // one at a time, and discard the result if any operand changed meanwhile.
  if (_booleanRunning) return { blocked: true, reason: 'busy' };
  const before = _operandSnapshot(operandIds);
  const compute = opts.compute ?? computeBooleanAsync;
  let result;
  _booleanRunning = true;
  try {
    result = await compute(op, meshes, { name: op, signal: opts.signal });
  } finally {
    _booleanRunning = false;
  }
  if (_operandSnapshot(operandIds) !== before) {
    try { result?.dispose?.(); } catch { /* already gone */ }
    return { blocked: true, reason: 'changed-during-boolean' };
  }
  const { assetId, meshId } = await AssetLoader.registerBakedResult(result, `${op}_result`);

  const lead = objects[operandIds[0]];
  const resultObj = {
    id: meshId, name: op, assetId,
    collectionId: lead?.collectionId ?? null, parentId: null,
    // Baked-to-solid ⇒ no textured shader on the result (it would render with no UVs);
    // keep computeBoolean's solid material. Otherwise inherit the operand's shader.
    shaderId: opts.bakeTexturedToSolid ? null : (lead?.shaderId ?? null),
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
    this.label = resultObj?.name ? t('history.booleanNamed', { name: resultObj.name }) : t('history.boolean');
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

  /** Executed (undo side): the operands are held only so undo can bring them back. */
  retainedTriangles(side) {
    if (side !== 'undo') return 0;
    return this._snapshots.reduce((n, s) => n + retainedTrianglesOf(s.mesh), 0);
  }

  /** Entry dropped from the undo window: free the hidden operands (heavy-mesh spec §4). */
  release(side) {
    if (side !== 'undo') return;
    for (const s of this._snapshots) {
      if (s.mesh?.isEnabled?.() === false) AssetLoader.releaseMesh(s.id, s.mesh);
    }
  }
}
