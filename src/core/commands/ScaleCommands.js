// Scale-domain commands (split from HistoryManager.js — review L29):
// per-object ratio rescale (RescaleObjectCommand), per-asset source-unit
// re-bake (SourceUnitCommand) and the project's typed print sizes
// (ExportTargetCommands — task 1.17).

import { EVENTS } from '../events.js';
import { dispatch, setState, getState, markDirty } from '../StateManager.js';
import { t } from '../../i18n/index.js';
import { AssetLoader } from '../AssetLoader.js';
import {
  SOURCE_UNIT_FACTORS, exportTargetsFromState, normalizeExportTarget, exportTargetsEqual,
  formatScaleRatio,
} from '../scale/ScaleMath.js';
import { canonicalObjectId } from '../LogicalObjects.js';
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
    this.label = t('history.fileUnits', { unit: nextUnit });
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

// (The global RescaleWorldCommand was removed in the per-object ratio redesign,
// 2026-06-16 — scene scale is now per-object via RescaleObjectCommand below.)

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

/**
 * Per-object scale ratio change (per-object ratio redesign, 2026-06-16).
 *
 * Rescales each given object by `prevRatio / nextRatio`, baked into that
 * object's OWN geometry and stores the new `ratio`. Scaling is about the
 * object's OWN origin (task 1.14): a top-level mesh keeps its position; a
 * child's LOCAL position (relative to its parent) scales with the factor so
 * spacing inside a group follows; top-level sibling parts of a logical object
 * scale their offset from the lead so the parts stay assembled. Shared
 * group/collection ancestors are never touched (finding D). The
 * caller passes the full member set of a logical object so multi-mesh objects
 * scale as one unit (finding E). Geometry is uniquified at duplication time
 * (AssetLoader.cloneMeshAsNewObject), so the bake here can't alias siblings
 * (finding C).
 *
 * Mirrors RescaleWorldCommand's vertex math, scoped to a selection instead of
 * the whole scene. One undoable step for the whole batch.
 */
export class RescaleObjectCommand {
  constructor(objectIds, nextRatio) {
    this._ids = [...new Set(objectIds)];
    this._next = _positiveRatio(nextRatio);
    this._prevById = {};
    const objects = getState().scene.objects;
    for (const id of this._ids) this._prevById[id] = _positiveRatio(objects[id]?.ratio);
    this.label = t('history.setRatio', { ratio: _fmtRatioLabel(this._next) });
  }
  execute() {
    for (const id of this._ids) _rescaleObject(id, this._prevById[id], this._next);
    markDirty();
  }
  undo() {
    for (const id of this._ids) _rescaleObject(id, this._next, this._prevById[id]);
  }
}

function _positiveRatio(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

function _rescaleObject(id, fromRatio, toRatio) {
  const to = _positiveRatio(toRatio);
  let updatedMesh = false;
  if (_positiveRatio(fromRatio) !== to) {
    const factor = _positiveRatio(fromRatio) / to;
    const mesh = AssetLoader.getBabylonMesh(id);
    if (mesh) {
      if (mesh.geometry && typeof mesh.bakeTransformIntoVertices === 'function') {
        mesh.bakeTransformIntoVertices(BABYLON.Matrix.Scaling(factor, factor, factor));
      }
      _rescalePosition(id, mesh, factor);
      mesh.refreshBoundingInfo?.();
      updatedMesh = true;
    }
  }
  setState(s => {
    const obj = s.scene.objects[id];
    if (!obj) return s;
    return {
      ...s,
      scene: {
        ...s.scene,
        objects: { ...s.scene.objects, [id]: { ...obj, ratio: to } },
      },
    };
  }, SILENT);
  if (updatedMesh) dispatch(EVENTS.OBJECT_UPDATED, { meshId: id });
}

// Position policy for a rescale (task 1.14). Never scales about the world
// origin. Exact inverse under factor -> 1/factor (lead position is untouched).
function _rescalePosition(id, mesh, factor) {
  const pos = mesh.position;
  if (!pos) return;
  const scaleAbout = (ax, ay, az) => {
    pos.x = ax + (pos.x - ax) * factor;
    pos.y = ay + (pos.y - ay) * factor;
    pos.z = az + (pos.z - az) * factor;
  };
  if (mesh.parent) { scaleAbout(0, 0, 0); return; }   // local offset inside parent
  const objects = getState().scene.objects;
  const leadId = canonicalObjectId(id, objects);
  if (leadId === id) return;                           // top-level lead: own origin
  const lead = AssetLoader.getBabylonMesh(leadId);
  if (lead && !lead.parent && lead.position) {
    scaleAbout(lead.position.x, lead.position.y, lead.position.z);
  }
}

// ── Print sizes (task 1.17) ──────────────────────────────
// `print.exportTargets` edits are undoable project edits. Every variant
// snapshots the whole list before/after so undo restores the exact order.

/**
 * Replace the whole `print.exportTargets` list (one undo step). Invalid
 * entries are dropped and duplicates collapsed; [] = "as shown".
 */
export class SetExportTargetsCommand {
  constructor(nextTargets, label = 'Print sizes') {
    this._prev = exportTargetsFromState(getState());
    this._next = exportTargetsFromState({ print: { exportTargets: nextTargets } });
    this.label = label;
  }
  execute() { _writeExportTargets(this._next); markDirty(); }
  undo() { _writeExportTargets(this._prev); }
}

/** Append one typed print size (no-op list when it is already present). */
export class AddExportTargetCommand extends SetExportTargetsCommand {
  constructor(target) {
    const cur = exportTargetsFromState(getState());
    const t = normalizeExportTarget(target);
    super(t ? [...cur, t] : cur, `Add print size ${exportTargetLabel(t)}`);
  }
}

/** Remove one typed print size (matched by kind + magnitude). */
export class RemoveExportTargetCommand extends SetExportTargetsCommand {
  constructor(target) {
    const t = normalizeExportTarget(target);
    const cur = exportTargetsFromState(getState());
    super(cur.filter(c => !exportTargetsEqual(c, t)), `Remove print size ${exportTargetLabel(t)}`);
  }
}

/** Replace one typed print size in place (keeps its position in the list). */
export class ReplaceExportTargetCommand extends SetExportTargetsCommand {
  constructor(oldTarget, newTarget) {
    const o = normalizeExportTarget(oldTarget);
    const n = normalizeExportTarget(newTarget);
    const cur = exportTargetsFromState(getState());
    super(n ? cur.map(c => (exportTargetsEqual(c, o) ? n : c)) : cur, `Change print size ${exportTargetLabel(n)}`);
  }
}

/** Short language-neutral label: "1:144", "×2", "120 mm". */
export function exportTargetLabel(target) {
  if (!target) return '';
  if (target.kind === 'factor') return `×${target.value}`;
  if (target.kind === 'height') return `${target.mm} mm`;
  return formatScaleRatio(target.value);
}

function _writeExportTargets(list) {
  setState(s => ({ ...s, print: { ...s.print, exportTargets: list.map(t => ({ ...t })) } }), SILENT);
}
