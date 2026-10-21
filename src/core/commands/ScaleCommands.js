// Scale-domain commands (split from HistoryManager.js — review L29):
// per-object ratio rescale (RescaleObjectCommand = "Convert"), per-object
// scale relabel (SetScaleLabelCommand = "Set scale", task 1.13), per-asset source-unit
// re-bake (SourceUnitCommand) and the project's typed print sizes
// (ExportTargetCommands — task 1.17).

import { EVENTS } from '../events.js';
import { dispatch, setState, getState, markDirty } from '../StateManager.js';
import { t } from '../../i18n/index.js';
import { AssetLoader } from '../AssetLoader.js';
import {
  SOURCE_UNIT_FACTORS, exportTargetsFromState, normalizeExportTarget, exportTargetsEqual,
  formatScaleRatio, bakedRatioOf,
} from '../scale/ScaleMath.js';
import { canonicalObjectId } from '../LogicalObjects.js';
import { SILENT, withDetachedPivot } from './support.js';
import { bump } from '../geometry/GeometryStore.js';

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
          bump(m);
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
    this._prevSourceById = {};
    const objects = getState().scene.objects;
    for (const id of this._ids) {
      this._prevById[id] = _positiveRatio(objects[id]?.ratio);
      this._prevSourceById[id] = objects[id]?.ratioSource;
    }
    this.label = t('history.setRatio', { ratio: _fmtRatioLabel(this._next) });
  }
  execute() {
    // Converting is an explicit user scale action → ratioSource 'user' (1.13).
    for (const id of this._ids) _rescaleObject(id, this._prevById[id], this._next, RATIO_SOURCE.USER);
    markDirty();
  }
  undo() {
    for (const id of this._ids) _rescaleObject(id, this._next, this._prevById[id], this._prevSourceById[id]);
  }
}

// ── Declare vs convert (task 1.13 / Decision 24) ─────────

/** Where an object's declared `ratio` came from. */
export const RATIO_SOURCE = Object.freeze({ FILE: 'file', USER: 'user', DEFAULT: 'default' });
const RATIO_SOURCES = new Set(Object.values(RATIO_SOURCE));

/**
 * Seed for a freshly imported / migrated object: a file that declared its
 * authored scale (`modelRatio ≠ 1`) is 'file', otherwise 'default' (STL/OBJ).
 * @param {number|undefined} modelRatio
 * @returns {'file'|'default'}
 */
export function seedRatioSource(modelRatio) {
  const n = Number(modelRatio);
  return Number.isFinite(n) && n > 0 && n !== 1 ? RATIO_SOURCE.FILE : RATIO_SOURCE.DEFAULT;
}

/**
 * An object's ratioSource, deriving the seed from its asset when the field is
 * absent (objects minted by Boolean / Slice paths, pre-1.13 sessions).
 * @param {object|null|undefined} obj
 * @param {object|null|undefined} [asset]
 * @returns {'file'|'user'|'default'}
 */
export function ratioSourceOf(obj, asset = null) {
  if (RATIO_SOURCES.has(obj?.ratioSource)) return obj.ratioSource;
  return seedRatioSource(asset?.modelRatio);
}

/**
 * "Set scale": relabel the objects' declared ratio WITHOUT touching geometry
 * or transforms (the STL/OBJ case — "this kit is 1:72"). Marks every target
 * `ratioSource: 'user'`. One undo step restores each prior ratio + source.
 */
export class SetScaleLabelCommand {
  constructor(objectIds, nextRatio) {
    this._ids = [...new Set(objectIds)];
    this._next = _positiveRatio(nextRatio);
    const objects = getState().scene.objects;
    this._prev = {};
    for (const id of this._ids) {
      if (!objects[id]) continue;
      this._prev[id] = {
        ratio: _positiveRatio(objects[id].ratio),
        ratioSource: objects[id].ratioSource,
        bakedRatio: objects[id].bakedRatio,
      };
    }
    this.label = t('history.setScaleLabel', { ratio: _fmtRatioLabel(this._next) });
  }
  execute() {
    const objects = getState().scene.objects;
    _writeRatioFields(Object.fromEntries(Object.keys(this._prev).map(id => [id, {
      ratio: this._next,
      ratioSource: RATIO_SOURCE.USER,
      bakedRatio: _anchorUnlessLabel(bakedRatioOf(objects[id]), this._next),
    }])));
    markDirty();
  }
  undo() { _writeRatioFields(this._prev); }
}

function _writeRatioFields(byId) {
  setState(s => {
    const objects = { ...s.scene.objects };
    for (const [id, f] of Object.entries(byId)) {
      if (!objects[id]) continue;
      const next = { ...objects[id], ratio: f.ratio };
      if (f.ratioSource === undefined) delete next.ratioSource; else next.ratioSource = f.ratioSource;
      if (f.bakedRatio === undefined) delete next.bakedRatio; else next.bakedRatio = f.bakedRatio;
      objects[id] = next;
    }
    return { ...s, scene: { ...s.scene, objects } };
  }, SILENT);
  // No OBJECT_UPDATED: geometry is untouched, so validation must not go
  // stale. Panels showing the label re-render on HISTORY_* (push/undo/redo).
}

// `bakedRatio` is stored only while it differs from the label (see
// ScaleMath.bakedRatioOf); equal means the object never was relabelled.
function _anchorUnlessLabel(bakedRatio, ratio) {
  return Math.abs(bakedRatio - ratio) <= 1e-9 * ratio ? undefined : bakedRatio;
}

function _positiveRatio(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

function _rescaleObject(id, fromRatio, toRatio, ratioSource) {
  const to = _positiveRatio(toRatio);
  let updatedMesh = false;
  if (_positiveRatio(fromRatio) !== to) {
    const factor = _positiveRatio(fromRatio) / to;
    const mesh = AssetLoader.getBabylonMesh(id);
    if (mesh) {
      if (mesh.geometry && typeof mesh.bakeTransformIntoVertices === 'function') {
        mesh.bakeTransformIntoVertices(BABYLON.Matrix.Scaling(factor, factor, factor));
        bump(mesh);
      }
      _rescalePosition(id, mesh, factor);
      mesh.refreshBoundingInfo?.();
      updatedMesh = true;
    }
  }
  setState(s => {
    const obj = s.scene.objects[id];
    if (!obj) return s;
    // The vertices scaled by from/to, so a relabelled anchor moves by to/from.
    const { bakedRatio: _old, ...rest } = obj;
    const anchor = obj.bakedRatio === undefined
      ? undefined
      : _anchorUnlessLabel(bakedRatioOf(obj) * to / _positiveRatio(fromRatio), to);
    const next = anchor === undefined ? { ...rest, ratio: to } : { ...rest, ratio: to, bakedRatio: anchor };
    return {
      ...s,
      scene: {
        ...s.scene,
        objects: { ...s.scene.objects, [id]: _withRatioSource(next, ratioSource) },
      },
    };
  }, SILENT);
  if (updatedMesh) dispatch(EVENTS.OBJECT_UPDATED, { meshId: id });
}

function _withRatioSource(obj, ratioSource) {
  if (ratioSource === undefined) { const { ratioSource: _drop, ...rest } = obj; return rest; }
  return { ...obj, ratioSource };
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
