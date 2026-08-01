// Placement-precision commands (ADR 0003, Phase B). Align first; mirror/mate/array
// follow (docs/handoff/placement.md).

import { EVENTS } from '../events.js';
import { dispatch, markDirty, getState, setState } from '../StateManager.js';
import { AssetLoader } from '../AssetLoader.js';
import { applyTransforms, captureWorld, withDetachedPivot, removeSceneObject, restoreSceneObject } from './support.js';
import { canonicalObjectId, logicalObjectPartIds } from '../LogicalObjects.js';
import { computeAlignDeltas } from '../placement/AlignMath.js';
import { applyGeometryFix } from '../MeshValidator.js';

const AXES = new Set(['x', 'y', 'z']);

/**
 * Align a selection along one WORLD axis to the selection's min / center / max.
 * Objects move rigidly (position shift on that axis only); multi-part logical
 * objects move as one unit (all parts share the object's delta). Undo restores
 * every part's prior absolute transform. Pure delta math lives in AlignMath.
 */
export class AlignCommand {
  /**
   * @param {string[]} meshIds  Selected object ids (any part of a logical object).
   * @param {'x'|'y'|'z'} axis
   * @param {'min'|'center'|'max'} mode
   */
  constructor(meshIds, axis, mode) {
    this._axis = AXES.has(axis) ? axis : 'x';
    this._mode = mode;
    this._prev = {};
    this._next = {};
    this.label = `Align ${mode} ${this._axis.toUpperCase()}`;

    const objects = getState().scene.objects;
    const ax = this._axis;

    // Group the selection into logical objects; one AABB + one delta per object.
    const canonicals = [...new Set((meshIds ?? []).map(id => canonicalObjectId(id, objects)).filter(Boolean))];
    const items = [];
    const partsByCanonical = {};
    for (const c of canonicals) {
      const parts = logicalObjectPartIds(c, objects).filter(id => AssetLoader.getBabylonMesh(id));
      if (!parts.length) continue;
      let min = Infinity, max = -Infinity;
      for (const p of parts) {
        const m = AssetLoader.getBabylonMesh(p);
        m.computeWorldMatrix(true);
        const bb = m.getBoundingInfo().boundingBox;
        min = Math.min(min, bb.minimumWorld[ax]);
        max = Math.max(max, bb.maximumWorld[ax]);
      }
      if (!Number.isFinite(min) || !Number.isFinite(max)) continue;
      items.push({ id: c, min, max });
      partsByCanonical[c] = parts;
    }

    const deltas = computeAlignDeltas(items, mode);
    for (const c of Object.keys(deltas)) {
      const delta = deltas[c];
      for (const p of partsByCanonical[c]) {
        const m = AssetLoader.getBabylonMesh(p);
        const world = captureWorld(m);
        this._prev[p] = world;
        this._next[p] = {
          position: { ...world.position, [ax]: world.position[ax] + delta },
          rotation: { ...world.rotation },
          scaling: { ...world.scaling },
        };
      }
    }
  }

  execute() {
    applyTransforms(this._next);
    markDirty();
    dispatch(EVENTS.TRANSFORM_COMMITTED, { meshIds: Object.keys(this._next) });
  }

  undo() {
    applyTransforms(this._prev);
    dispatch(EVENTS.TRANSFORM_COMMITTED, { meshIds: Object.keys(this._prev) });
  }
}

/**
 * Linear array: duplicate one object `count-1` times, each offset by `i·spacing`
 * along a world axis (kitbash repeats — bolts, teeth). Reuses
 * `cloneMeshAsNewObject` (independent geometry, persists like a normal duplicate).
 * One undo step; clones are soft-hidden on undo (kept for redo), not disposed.
 */
export class ArrayCommand {
  /**
   * @param {string} sourceId  object to repeat
   * @param {number} count      total copies incl. the source (≥2)
   * @param {'x'|'y'|'z'} axis
   * @param {number} spacing    world-unit step between copies
   */
  constructor(sourceId, count, axis, spacing) {
    this._sourceId = sourceId;
    this._count = Math.max(2, Math.floor(count) || 2);
    this._axis = AXES.has(axis) ? axis : 'x';
    this._spacing = Number(spacing) || 0;
    this._clones = [];   // [{ id, obj }]
    this._executed = false;
    this.label = `Array (${this._count})`;
  }

  execute() {
    if (this._executed) {   // redo — re-show the same clones
      withDetachedPivot(() => {
        for (const c of this._clones) {
          const m = AssetLoader.getBabylonMesh(c.id);
          if (m) m.setEnabled(true);
          restoreSceneObject(c.id, c.obj);
        }
      });
      markDirty();
      return;
    }
    const B = window.BABYLON;
    withDetachedPivot(() => {
      for (let i = 1; i < this._count; i++) {
        const offset = new B.Vector3(0, 0, 0);
        offset[this._axis] = i * this._spacing;
        const newId = AssetLoader.cloneMeshAsNewObject(this._sourceId, offset);
        if (!newId) continue;
        this._clones.push({ id: newId, obj: { ...getState().scene.objects[newId] } });
      }
    });
    this._executed = true;
    markDirty();
  }

  undo() {
    withDetachedPivot(() => {
      for (const c of this._clones) {
        const m = AssetLoader.getBabylonMesh(c.id);
        if (m) { m.setParent(null); m.setEnabled(false); }
        removeSceneObject(c.id);
      }
    });
  }
}

/**
 * Mirror single-part objects about their own centre on a world axis, UV-preserving
 * (reflect geometry + reverse winding + recompute normals — kept for export/print,
 * unlike a node negative-scale which exports inside-out). Recorded as a `mirror-<axis>`
 * geometryFix so it survives `.mixo` reload (replayed by persistence). Self-inverse:
 * execute and undo both re-apply. Multi-part logical objects are skipped (their parts
 * would each reflect about their own centre) — single-part first.
 */
export class MirrorCommand {
  constructor(meshIds, axis) {
    this._axis = AXES.has(axis) ? axis : 'x';
    const objects = getState().scene.objects;
    this._ids = [...new Set((meshIds ?? []).map(id => canonicalObjectId(id, objects)).filter(Boolean))]
      .filter(id => logicalObjectPartIds(id, objects).length === 1 && AssetLoader.getBabylonMesh(id));
    this.label = `Mirror ${this._axis.toUpperCase()}`;
  }

  _apply() {
    const type = `mirror-${this._axis}`;
    for (const id of this._ids) {
      const m = AssetLoader.getBabylonMesh(id);
      if (m) applyGeometryFix(m, type);
      setState(s => {
        const o = s.scene.objects[id];
        if (!o) return s;
        const fixes = new Set(o.geometryFixes ?? []);
        if (fixes.has(type)) fixes.delete(type); else fixes.add(type);   // parity toggle
        return { ...s, scene: { ...s.scene, objects: { ...s.scene.objects, [id]: { ...o, geometryFixes: [...fixes] } } } };
      }, { silent: true });
      dispatch(EVENTS.OBJECT_UPDATED, { meshId: id });
    }
    markDirty();
  }

  execute() { this._apply(); }
  undo() { this._apply(); }   // reflection is its own inverse
}
