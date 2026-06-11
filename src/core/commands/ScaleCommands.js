// Scale-domain commands (split from HistoryManager.js — review L29):
// world rescale (working-ratio change) and per-asset source-unit re-bake.

import { EVENTS } from '../events.js';
import { dispatch, setState, getState, markDirty } from '../StateManager.js';
import { SceneManager } from '../SceneManager.js';
import { AssetLoader } from '../AssetLoader.js';
import { SOURCE_UNIT_FACTORS } from '../scale/ScaleMath.js';
import { SILENT, withDetachedPivot } from './support.js';

const BABYLON = window.BABYLON;

/**
 * Change an asset's source unit, re-baking the unit DELTA into every mesh
 * instantiated from it (review M12 — this is destructive vertex math and must
 * be undoable). Mirrors the RescaleWorld approach: inverse-factor undo, no
 * vertex snapshots — unit factors are exact constants, so round-trip drift is
 * at float epsilon. Parented (non-root) positions scale so within-asset
 * spacing follows; the world drop anchor (root position) stays put.
 */
export class SourceUnitCommand {
  constructor(assetId, prevUnit, nextUnit) {
    this._assetId = assetId;
    this._prev = prevUnit;
    this._next = nextUnit;
    const a = getState().scene.assetLibrary[assetId];
    this._prevConfirmed = a ? a.unitConfirmed !== false : true;
    this.label = `Source Unit (${nextUnit})`;
  }
  execute() {
    _applySourceUnit(this._assetId, this._prev, this._next, /*confirmed*/ false);
    markDirty();
  }
  undo() {
    _applySourceUnit(this._assetId, this._next, this._prev, this._prevConfirmed);
  }
}

function _applySourceUnit(assetId, fromUnit, toUnit, confirmed) {
  const oldF = SOURCE_UNIT_FACTORS[fromUnit] ?? 0.001;
  const newF = SOURCE_UNIT_FACTORS[toUnit] ?? 0.001;
  if (!(oldF > 0) || !(newF > 0)) return;
  const delta = newF / oldF;

  withDetachedPivot(() => {
    const objects = getState().scene.objects;
    const scaleMat = BABYLON.Matrix.Scaling(delta, delta, delta);
    for (const id of Object.keys(objects)) {
      if (objects[id].assetId !== assetId) continue;
      const m = AssetLoader.getBabylonMesh(id);
      if (!m) continue;
      if (Math.abs(delta - 1) > 1e-12) {
        if (m.geometry && typeof m.bakeTransformIntoVertices === 'function') {
          m.bakeTransformIntoVertices(scaleMat);
        }
        if (m.parent) m.position.scaleInPlace(delta);
      }
      m.refreshBoundingInfo?.();
      dispatch(EVENTS.OBJECT_UPDATED, { meshId: id });
    }
  });

  setState(s => {
    const a = s.scene.assetLibrary[assetId];
    if (!a) return s;
    return {
      ...s,
      scene: {
        ...s.scene,
        assetLibrary: {
          ...s.scene.assetLibrary,
          [assetId]: { ...a, sourceUnit: toUnit, unitConfirmed: confirmed },
        },
      },
    };
  }, SILENT);
}

/**
 * Rebake the entire scene to a new working ratio.
 *
 * Every registered mesh's vertex data is scaled by `prev / next`; every
 * Babylon node on the ancestor chain has its local position scaled by the
 * same factor exactly once. Result: world transforms scale relative to the
 * world origin, mesh.scaling stays (1,1,1), and a mesh's Properties scale
 * still reads "1" after the change.
 *
 * Cursor3d position scales too. Overlays (grid, axes, gizmos, selection RTT)
 * are unaffected — they aren't on any registered mesh's ancestor chain.
 */
export class RescaleWorldCommand {
  constructor(prevRatio, nextRatio) {
    this._prev = prevRatio;
    this._next = nextRatio;
    this.label = `Set scene scale ${_fmtRatioLabel(nextRatio)}`;
  }
  execute() { _applyWorldRescale(this._prev, this._next); markDirty(); }
  undo()    { _applyWorldRescale(this._next, this._prev); }
}

// Format a ratio number as a display string for command labels. Mirrors the
// PrintPanel formatter so an undo-stack entry reads "Set scene scale 2:1"
// when the user typed "2:1", not "1:0.5".
function _fmtRatioLabel(n) {
  if (!Number.isFinite(n) || n <= 0) return '1:1';
  if (Math.abs(n - 1) < 1e-9) return '1:1';
  if (n > 1) {
    const r = Math.round(n);
    return Math.abs(n - r) < 1e-6 ? `1:${r}` : `1:${(+n.toFixed(3)).toString()}`;
  }
  const m = 1 / n;
  const r = Math.round(m);
  return Math.abs(m - r) < 1e-6 ? `${r}:1` : `${(+m.toFixed(3)).toString()}:1`;
}

function _applyWorldRescale(fromRatio, toRatio) {
  if (!Number.isFinite(fromRatio) || !Number.isFinite(toRatio) || fromRatio <= 0 || toRatio <= 0) return;
  if (fromRatio === toRatio) return;
  const factor = fromRatio / toRatio;
  const scaleMat = BABYLON.Matrix.Scaling(factor, factor, factor);
  const visited = new WeakSet();
  const objects = getState().scene.objects;

  for (const meshId of Object.keys(objects)) {
    const mesh = AssetLoader.getBabylonMesh(meshId);
    if (!mesh) continue;
    if (mesh.geometry && typeof mesh.bakeTransformIntoVertices === 'function') {
      mesh.bakeTransformIntoVertices(scaleMat);
    }
    let n = mesh;
    while (n) {
      if (visited.has(n)) break;
      visited.add(n);
      if (n.position && typeof n.position.scaleInPlace === 'function') {
        n.position.scaleInPlace(factor);
      }
      n = n.parent ?? null;
    }
    mesh.refreshBoundingInfo?.();
    dispatch(EVENTS.OBJECT_UPDATED, { meshId });
  }

  setState(s => {
    const c = s.scene.cursor3d ?? { x: 0, y: 0, z: 0 };
    return {
      ...s,
      print: { ...s.print, workingRatio: toRatio },
      scene: { ...s.scene, cursor3d: { x: c.x * factor, y: c.y * factor, z: c.z * factor } },
    };
  }, SILENT);

  // Keep the Babylon cursor sphere in sync with the scaled state cursor —
  // state moved but the visual stayed put before (review M13).
  const c = getState().scene.cursor3d;
  SceneManager.setCursor?.(new BABYLON.Vector3(c.x, c.y, c.z));
}
