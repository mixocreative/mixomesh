import { EVENTS } from '../events.js';
import { getState, setState, dispatch, markDirty } from '../StateManager.js';
import { AssetLoader } from '../AssetLoader.js';
import { Selection } from '../Selection.js';
import { ShaderLibrary } from '../ShaderLibrary.js';
import { computeBoolean } from '../BooleanService.js';
import { canonicalObjectId, logicalObjectPartIds } from '../LogicalObjects.js';
import {
  evaluateSliceConnectorEligibility,
  nextSlicePartNames,
  planSliceConnector,
  worldBoundsForMesh,
  createSliceConnectorMeshes,
} from '../SliceConnectorService.js';
import { withDetachedPivot, removeSceneObject, restoreSceneObject } from './support.js';

function _isSolidColor(mesh) {
  const mat = mesh?.material;
  return !(mat && (mat.diffuseTexture || mat.albedoTexture || mat.emissiveTexture));
}

function _triangles(mesh) {
  return Math.floor((mesh?.getTotalIndices?.() ?? 0) / 3);
}

function _recipeObject({ recipeId, baseName, partIndex, role, side, source, plan, options }) {
  return {
    version: 1,
    recipeId,
    baseName,
    partIndex,
    role,
    side,
    sourceObjectId: source.id,
    sourceAssetId: source.assetId,
    sourceName: source.name,
    parentRecipeId: source.sliceRecipe?.recipeId ?? null,
    lineStart: plan.lineStart,
    lineEnd: plan.lineEnd,
    cameraNormal: plan.cameraNormal ?? options.cameraNormal ?? null,
    planeNormal: plan.planeNormal,
    planeCenter: plan.planeCenter,
    connectorPoint: plan.connectorPoint,
    maleSide: plan.maleSideKey,
    connectorShape: plan.connectorShape,
    diameterMM: plan.diameterMM,
    depthMM: plan.depthMM,
    clearanceMM: plan.clearanceMM,
  };
}

function _resultObject({ id, assetId, source, name, sliceRecipe, shaderId }) {
  return {
    id,
    name,
    assetId,
    collectionId: source.collectionId ?? null,
    parentId: null,
    shaderId,
    visible: true,
    locked: false,
    isGhost: false,
    isUnlinked: false,
    isPrintPart: true,
    sourceGroupId: null,
    logicalObjectId: null,
    isInternalPart: false,
    containerMeshIndex: 0,
    ratio: 1,
    sliceRecipe,
  };
}

function _disposeAll(meshes) {
  for (const mesh of meshes) {
    try { mesh?.dispose?.(); } catch { /* already disposed */ }
  }
}

function _block(reason) {
  return { blocked: true, reason };
}

function _stripCsgOptionalVertexData(mesh) {
  const B = window.BABYLON;
  const kinds = [
    B.VertexBuffer.UVKind,
    B.VertexBuffer.UV2Kind,
    B.VertexBuffer.ColorKind,
    B.VertexBuffer.MatricesIndicesKind,
    B.VertexBuffer.MatricesWeightsKind,
    B.VertexBuffer.MatricesIndicesExtraKind,
    B.VertexBuffer.MatricesWeightsExtraKind,
  ].filter(Boolean);
  for (const kind of kinds) {
    if (mesh.isVerticesDataPresent?.(kind)) mesh.removeVerticesData(kind);
  }
}

function _cloneForSliceCsg(mesh, name) {
  const clone = mesh.clone(name, mesh.parent ?? null, true);
  if (!clone) return mesh;
  clone.makeGeometryUnique?.();
  clone.metadata = { ...(clone.metadata ?? {}), sliceConnectorFurniture: true };
  clone.isVisible = false;
  clone.isPickable = false;
  _stripCsgOptionalVertexData(clone);
  return clone;
}

/**
 * Split one selected solid object with a camera-derived plane and add one
 * plug/socket connector pair. Returns an already-applied command.
 */
export async function performSliceConnector(meshId, options = {}) {
  const objects = getState().scene.objects;
  const id = canonicalObjectId(meshId, objects);
  const source = objects[id];
  const mesh = AssetLoader.getBabylonMesh(id);
  if (!source || !mesh) return _block('missing-object');
  const gate = evaluateSliceConnectorEligibility({
    triangles: _triangles(mesh),
    solidColor: _isSolidColor(mesh),
    partCount: logicalObjectPartIds(id, objects).length,
  });
  if (!gate.ok) return _block(gate.reason);

  const B = window.BABYLON;
  const scene = mesh.getScene();
  const plan = planSliceConnector(worldBoundsForMesh(mesh), options);
  const names = nextSlicePartNames(objects, source);
  const recipeId = `slice_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const furniture = createSliceConnectorMeshes(B, scene, plan, `slice_${id}`);
  const temps = Object.values(furniture);
  for (const temp of temps) _stripCsgOptionalVertexData(temp);
  const sourceCsg = _cloneForSliceCsg(mesh, `slice_${id}_source_csg`);
  temps.push(sourceCsg);

  try {
    const frontHalf = await computeBoolean('intersect', [sourceCsg, furniture.positiveCutter], { name: `${source.name}_front_raw` });
    const backHalf = await computeBoolean('intersect', [sourceCsg, furniture.negativeCutter], { name: `${source.name}_back_raw` });
    temps.push(frontHalf, backHalf);

    const maleRaw = plan.maleSideKey === 'front' ? frontHalf : backHalf;
    const femaleRaw = plan.femaleSideKey === 'front' ? frontHalf : backHalf;
    const maleFinal = await computeBoolean('union', [maleRaw, furniture.peg], { name: names.maleName });
    const femaleFinal = await computeBoolean('subtract', [femaleRaw, furniture.socket], { name: names.femaleName });

    const male = await AssetLoader.registerBakedResult(maleFinal, names.maleName);
    const female = await AssetLoader.registerBakedResult(femaleFinal, names.femaleName);
    const resultObjs = {
      [male.meshId]: _resultObject({
        id: male.meshId,
        assetId: male.assetId,
        source,
        name: names.maleName,
        sliceRecipe: _recipeObject({
          recipeId,
          baseName: names.baseName,
          partIndex: names.malePartIndex,
          role: 'male',
          side: plan.maleSideKey,
          source,
          plan,
          options,
        }),
        shaderId: source.shaderId ?? null,
      }),
      [female.meshId]: _resultObject({
        id: female.meshId,
        assetId: female.assetId,
        source,
        name: names.femaleName,
        sliceRecipe: _recipeObject({
          recipeId,
          baseName: names.baseName,
          partIndex: names.femalePartIndex,
          role: 'female',
          side: plan.femaleSideKey,
          source,
          plan,
          options,
        }),
        shaderId: source.shaderId ?? null,
      }),
    };

    const snapshot = { id, obj: { ...source }, mesh, prevParent: mesh.parent ?? null };
    withDetachedPivot(() => {
      mesh.setParent(null);
      mesh.setEnabled(false);
      removeSceneObject(id);
      setState(s => ({
        ...s,
        scene: { ...s.scene, objects: { ...s.scene.objects, ...resultObjs } },
      }), { silent: true });
      for (const [resultId, obj] of Object.entries(resultObjs)) {
        if (obj.shaderId) ShaderLibrary.assignToMesh(obj.shaderId, resultId);
        dispatch(EVENTS.OBJECT_RESTORED, { id: resultId });
      }
      Selection.set(Object.keys(resultObjs), male.meshId);
    });
    markDirty();

    return new SliceConnectorCommand({
      snapshot,
      resultObjs,
      resultIds: Object.keys(resultObjs),
    });
  } finally {
    _disposeAll(temps);
  }
}

export class SliceConnectorCommand {
  constructor({ snapshot, resultObjs, resultIds }) {
    this.label = 'Slice & Connector';
    this._snapshot = snapshot;
    this._resultObjs = resultObjs;
    this._resultIds = resultIds;
    this._skipFirstExecute = true;
  }

  execute() {
    if (this._skipFirstExecute) { this._skipFirstExecute = false; markDirty(); return; }
    withDetachedPivot(() => {
      this._snapshot.mesh.setParent(null);
      this._snapshot.mesh.setEnabled(false);
      removeSceneObject(this._snapshot.id);
      for (const id of this._resultIds) {
        const mesh = AssetLoader.getBabylonMesh(id);
        if (mesh) mesh.setEnabled(true);
        restoreSceneObject(id, this._resultObjs[id]);
        if (this._resultObjs[id].shaderId) ShaderLibrary.assignToMesh(this._resultObjs[id].shaderId, id);
      }
      Selection.set(this._resultIds, this._resultIds[0]);
    });
    markDirty();
  }

  undo() {
    withDetachedPivot(() => {
      for (const id of this._resultIds) {
        const mesh = AssetLoader.getBabylonMesh(id);
        if (mesh) mesh.setEnabled(false);
        removeSceneObject(id);
      }
      this._snapshot.mesh.setEnabled(true);
      this._snapshot.mesh.setParent(this._snapshot.prevParent);
      restoreSceneObject(this._snapshot.id, this._snapshot.obj);
      Selection.set([this._snapshot.id], this._snapshot.id);
    });
  }
}
