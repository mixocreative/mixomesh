// Placement-precision commands (ADR 0003, Phase B). Align first; mirror/mate/array
// follow (docs/handoff/placement.md).

import { EVENTS } from '../events.js';
import { dispatch, markDirty, getState, setState } from '../StateManager.js';
import { AssetLoader } from '../AssetLoader.js';
import { applyTransforms, captureWorld, withDetachedPivot, removeSceneObject, restoreSceneObject } from './support.js';
import { canonicalObjectId, logicalObjectPartIds } from '../LogicalObjects.js';
import { computeAlignDeltas } from '../placement/AlignMath.js';
import { applyGeometryFix } from '../MeshValidator.js';
import {
  centerOnBedDelta,
  dropToBedDelta,
  multiplyQuaternion,
  quaternionFromNormalToUp,
} from '../placement/BedPlacement.js';

const AXES = new Set(['x', 'y', 'z']);

function _selectionBounds(ids) {
  const min = { x: Infinity, y: Infinity, z: Infinity };
  const max = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (const id of ids) {
    const mesh = AssetLoader.getBabylonMesh(id);
    if (!mesh) continue;
    mesh.computeWorldMatrix(true);
    const box = mesh.getBoundingInfo().boundingBox;
    for (const axis of ['x', 'y', 'z']) {
      min[axis] = Math.min(min[axis], box.minimumWorld[axis]);
      max[axis] = Math.max(max[axis], box.maximumWorld[axis]);
    }
  }
  return Number.isFinite(min.x) ? { min, max } : null;
}

/** Drop/centre selected logical objects, or orient one picked face, as one undo step. */
export class BedPlacementCommand {
  constructor(meshIds, mode, { faceNormal = null } = {}) {
    this.label = mode === 'drop' ? 'Drop to Bed'
      : mode === 'center' ? 'Center on Bed' : 'Place Face on Bed';
    this._mode = mode;
    this._prev = {};
    this._next = {};
    this._finalizedFace = false;
    const objects = getState().scene.objects;
    const canonicals = [...new Set((meshIds ?? []).map(id => canonicalObjectId(id, objects)).filter(Boolean))];
    this.skippedIds = canonicals.filter(id => objects[id]?.locked);
    const unlocked = canonicals.filter(id => !objects[id]?.locked);
    const targetCanonicals = mode === 'face' ? unlocked.slice(0, 1) : unlocked;
    this._ids = [...new Set(targetCanonicals.flatMap(id => logicalObjectPartIds(id, objects)))]
      .filter(id => AssetLoader.getBabylonMesh(id));
    this.affectedIds = [...this._ids];
    for (const id of this._ids) this._prev[id] = captureWorld(AssetLoader.getBabylonMesh(id));
    if (mode === 'face' && faceNormal) {
      const rotation = quaternionFromNormalToUp(faceNormal);
      for (const [id, world] of Object.entries(this._prev)) {
        this._next[id] = { ...world, rotation: multiplyQuaternion(rotation, world.rotation) };
      }
    } else {
      const bounds = _selectionBounds(this._ids);
      const delta = mode === 'center' ? centerOnBedDelta(bounds) : dropToBedDelta(bounds);
      for (const [id, world] of Object.entries(this._prev)) {
        this._next[id] = {
          ...world,
          position: {
            x: world.position.x + delta.x,
            y: world.position.y + delta.y,
            z: world.position.z + delta.z,
          },
        };
      }
    }
  }

  execute() {
    applyTransforms(this._next);
    if (this._mode === 'face' && !this._finalizedFace) {
      const bounds = _selectionBounds(this._ids);
      const delta = dropToBedDelta(bounds);
      for (const next of Object.values(this._next)) {
        next.position = { ...next.position, y: next.position.y + delta.y };
      }
      this._finalizedFace = true;
      applyTransforms(this._next);
    }
    markDirty();
    dispatch(EVENTS.TRANSFORM_COMMITTED, { meshIds: this._ids });
  }

  undo() {
    applyTransforms(this._prev);
    dispatch(EVENTS.TRANSFORM_COMMITTED, { meshIds: this._ids });
  }
}

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

// Union world AABB (per axis) of a logical object's live parts.
function _objectAABB(id, objects) {
  const parts = logicalObjectPartIds(id, objects).filter(p => AssetLoader.getBabylonMesh(p));
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  const K = ['x', 'y', 'z'];
  for (const p of parts) {
    const m = AssetLoader.getBabylonMesh(p);
    m.computeWorldMatrix(true);
    const bb = m.getBoundingInfo().boundingBox;
    for (let a = 0; a < 3; a++) {
      lo[a] = Math.min(lo[a], bb.minimumWorld[K[a]]);
      hi[a] = Math.max(hi[a], bb.maximumWorld[K[a]]);
    }
  }
  return { lo, hi, parts };
}

/**
 * Mate: slide each other selected object until it ABUTS the active object — a
 * face-flush snap without a picking mode. Auto-picks the axis of greatest
 * centre separation and the side the other object sits on, then translates it so
 * their bounding boxes just touch. AABB-aligned faces only (no rotation); the
 * arbitrary-face pick+rotate mate is the advanced version. Undo restores.
 */
export class MateCommand {
  constructor(meshIds, activeId) {
    this._prev = {};
    this._next = {};
    this.label = 'Mate';
    const objects = getState().scene.objects;
    const anchor = canonicalObjectId(activeId, objects);
    if (!anchor) return;
    const A = _objectAABB(anchor, objects);
    if (!Number.isFinite(A.lo[0])) return;
    const others = [...new Set((meshIds ?? []).map(id => canonicalObjectId(id, objects)).filter(Boolean))]
      .filter(id => id !== anchor);
    const K = ['x', 'y', 'z'];
    for (const other of others) {
      const O = _objectAABB(other, objects);
      if (!Number.isFinite(O.lo[0])) continue;
      let axis = 0, best = -Infinity;
      for (let a = 0; a < 3; a++) {
        const sep = Math.abs((O.lo[a] + O.hi[a]) - (A.lo[a] + A.hi[a])) / 2;
        if (sep > best) { best = sep; axis = a; }
      }
      const k = K[axis];
      const otherAboveAnchor = (O.lo[axis] + O.hi[axis]) >= (A.lo[axis] + A.hi[axis]);
      const delta = otherAboveAnchor ? (A.hi[axis] - O.lo[axis]) : (A.lo[axis] - O.hi[axis]);
      for (const p of O.parts) {
        const m = AssetLoader.getBabylonMesh(p);
        const w = captureWorld(m);
        this._prev[p] = w;
        this._next[p] = { position: { ...w.position, [k]: w.position[k] + delta }, rotation: { ...w.rotation }, scaling: { ...w.scaling } };
      }
    }
  }

  execute() { applyTransforms(this._next); markDirty(); dispatch(EVENTS.TRANSFORM_COMMITTED, { meshIds: Object.keys(this._next) }); }
  undo() { applyTransforms(this._prev); dispatch(EVENTS.TRANSFORM_COMMITTED, { meshIds: Object.keys(this._prev) }); }
}
