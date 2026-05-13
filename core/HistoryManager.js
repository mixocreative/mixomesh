import { EVENTS } from './events.js';
import { dispatch, setState, getState, withoutDirty, markDirty } from './StateManager.js';
import { SceneManager } from './SceneManager.js';
import { Selection } from './Selection.js';
import { AssetLoader } from './AssetLoader.js';

const BABYLON = window.BABYLON;
const STACK_LIMIT = 200;

let _undoStack = [];
let _redoStack = [];
let _batchLabel = null;
let _batchCmds  = [];

// ── Batch command ────────────────────────────────────────
class BatchCommand {
  constructor(label, commands) {
    this.label = label;
    this._commands = commands;
  }
  execute() { this._commands.forEach(c => c.execute()); }
  undo()    { [...this._commands].reverse().forEach(c => c.undo()); }
}

// ── Public API ───────────────────────────────────────────

/**
 * Execute a command, add to undo stack, clear redo.
 * During an open batch, collects into the batch instead.
 * @param {{ label: string, execute(): void, undo(): void }} command
 */
export function push(command) {
  command.execute();
  if (_batchLabel !== null) {
    _batchCmds.push(command);
    return;
  }
  _undoStack.push(command);
  if (_undoStack.length > STACK_LIMIT) _undoStack.shift();
  _redoStack = [];
  dispatch(EVENTS.HISTORY_PUSHED, { label: command.label });
}

/** Undo the most recent command. Does not mark project dirty. */
export function undo() {
  if (!_undoStack.length) return;
  const cmd = _undoStack.pop();
  withoutDirty(() => cmd.undo());
  _redoStack.push(cmd);
  dispatch(EVENTS.HISTORY_UNDONE, { label: cmd.label });
}

/** Redo the most recently undone command. Does not mark project dirty. */
export function redo() {
  if (!_redoStack.length) return;
  const cmd = _redoStack.pop();
  withoutDirty(() => cmd.execute());
  _undoStack.push(cmd);
  dispatch(EVENTS.HISTORY_REDONE, { label: cmd.label });
}

/** Clear both stacks (called on new/load project). */
export function clear() {
  _undoStack = [];
  _redoStack = [];
  _batchLabel = null;
  _batchCmds  = [];
}

/** @returns {string|null} */
export function getUndoLabel() {
  return _undoStack.length ? _undoStack[_undoStack.length - 1].label : null;
}

/** @returns {string|null} */
export function getRedoLabel() {
  return _redoStack.length ? _redoStack[_redoStack.length - 1].label : null;
}

/** Start collecting commands into a named batch. */
export function beginBatch(label) {
  _batchLabel = label;
  _batchCmds = [];
}

/** Close the batch and push it as a single undo entry. */
export function endBatch() {
  if (_batchLabel === null) return;
  const batch = new BatchCommand(_batchLabel, [..._batchCmds]);
  _batchLabel = null;
  _batchCmds = [];
  _undoStack.push(batch);
  if (_undoStack.length > STACK_LIMIT) _undoStack.shift();
  _redoStack = [];
  dispatch(EVENTS.HISTORY_PUSHED, { label: batch.label });
}

export const HistoryManager = { push, undo, redo, clear, getUndoLabel, getRedoLabel, beginBatch, endBatch };

// ── Shared helpers ───────────────────────────────────────

const SILENT = { silent: true };

/**
 * Pause the gizmo's selection-pivot parenting so that downstream parent
 * mutations (Group / Ungroup / Delete) see the meshes in their canonical
 * parents, then restore visuals.
 */
function _withDetachedPivot(fn) {
  SceneManager.attachToSelection([], 'median', null);
  try { fn(); }
  finally { Selection.refresh(); }
}

function _applyAbsoluteTransform(mesh, t) {
  const parent = mesh.parent;
  mesh.setParent(null);
  mesh.position.set(t.position.x, t.position.y, t.position.z);
  mesh.rotationQuaternion = new BABYLON.Quaternion(t.rotation.x, t.rotation.y, t.rotation.z, t.rotation.w);
  mesh.scaling.set(t.scaling.x, t.scaling.y, t.scaling.z);
  mesh.setParent(parent);   // preserves the world transform we just set
}

function _applyTransforms(snapshot) {
  for (const [id, t] of Object.entries(snapshot)) {
    const mesh = AssetLoader.getBabylonMesh(id);
    if (!mesh) continue;
    _applyAbsoluteTransform(mesh, t);
  }
  Selection.refresh();
}

function _findGroupNode(groupId) {
  if (!groupId) return null;
  const scene = SceneManager.getScene();
  if (!scene) return null;
  for (const t of scene.transformNodes) {
    if (t.metadata?.groupId === groupId) return t;
  }
  return null;
}

function _findNodeForId(id) {
  if (!id) return null;
  const mesh = AssetLoader.getBabylonMesh(id);
  if (mesh) return mesh;
  return _findGroupNode(id);
}

// ── Standard command classes ─────────────────────────────

/**
 * Apply per-mesh absolute transforms. `prev` and `next` are objects keyed by
 * meshId with `{position, rotation:quat, scaling}` plain-object values.
 *
 * Pass `{ alreadyApplied: true }` when the change has already been made to the
 * scene (e.g. by the gizmo) — the initial execute() becomes a no-op so the
 * mesh state isn't re-applied on top of itself.
 */
export class TransformCommand {
  constructor(prev, next, opts = {}) {
    this.label = 'Transform';
    this._prev = prev;
    this._next = next;
    this._skipFirstExecute = !!opts.alreadyApplied;
  }
  execute() {
    if (this._skipFirstExecute) {
      this._skipFirstExecute = false;
      markDirty();
      dispatch(EVENTS.TRANSFORM_COMMITTED, { meshIds: Object.keys(this._next) });
      return;
    }
    _applyTransforms(this._next);
    markDirty();
    dispatch(EVENTS.TRANSFORM_COMMITTED, { meshIds: Object.keys(this._next) });
  }
  undo() {
    _applyTransforms(this._prev);
    dispatch(EVENTS.TRANSFORM_COMMITTED, { meshIds: Object.keys(this._prev) });
  }
}

/** Set isVisible on a set of meshes. `prev` is meshId → bool; `next` is bool. */
export class VisibilityCommand {
  constructor(meshIds, prev, next) {
    this._ids = meshIds.slice();
    this._prev = { ...prev };
    this._next = next;
    this.label = next ? 'Show' : 'Hide';
  }
  execute() {
    for (const id of this._ids) _setVisible(id, this._next);
    markDirty();
  }
  undo() {
    for (const id of this._ids) _setVisible(id, this._prev[id]);
  }
}

function _setVisible(meshId, visible) {
  setState(state => {
    const o = state.scene.objects[meshId];
    if (!o) return state;
    return {
      ...state,
      scene: { ...state.scene, objects: { ...state.scene.objects, [meshId]: { ...o, visible } } },
    };
  }, SILENT);
  const mesh = AssetLoader.getBabylonMesh(meshId);
  if (mesh) mesh.isVisible = visible;
  dispatch(EVENTS.VISIBILITY_CHANGED, { meshId, visible });
}

/** Set the `locked` flag on objects. */
export class LockCommand {
  constructor(meshIds, prev, next) {
    this._ids = meshIds.slice();
    this._prev = { ...prev };
    this._next = next;
    this.label = next ? 'Lock' : 'Unlock';
  }
  execute() {
    for (const id of this._ids) _setLocked(id, this._next);
    markDirty();
  }
  undo() {
    for (const id of this._ids) _setLocked(id, this._prev[id]);
  }
}

function _setLocked(meshId, locked) {
  setState(state => {
    const o = state.scene.objects[meshId];
    if (!o) return state;
    return {
      ...state,
      scene: { ...state.scene, objects: { ...state.scene.objects, [meshId]: { ...o, locked } } },
    };
  }, SILENT);
  dispatch(EVENTS.LOCK_CHANGED, { meshId, locked });
}

/** Rename an object or group. */
export class RenameCommand {
  constructor(id, prevName, nextName) {
    this.label = 'Rename';
    this._id = id;
    this._prev = prevName;
    this._next = nextName;
  }
  execute() { _setName(this._id, this._next); markDirty(); }
  undo()    { _setName(this._id, this._prev); }
}

function _setName(id, name) {
  setState(state => {
    if (state.scene.objects[id]) {
      const o = state.scene.objects[id];
      return { ...state, scene: { ...state.scene, objects: { ...state.scene.objects, [id]: { ...o, name } } } };
    }
    if (state.scene.groups[id]) {
      const g = state.scene.groups[id];
      return { ...state, scene: { ...state.scene, groups: { ...state.scene.groups, [id]: { ...g, name } } } };
    }
    return state;
  }, SILENT);
  const node = _findNodeForId(id);
  if (node) node.name = name;
  dispatch(EVENTS.OBJECT_RENAMED, { id, name });
}

/**
 * Soft-delete: meshes are kept in memory (setEnabled(false)) so undo can
 * restore them without re-loading the asset. State entries are removed.
 */
export class DeleteCommand {
  constructor(meshIds) {
    this._snapshots = [];
    const objects = getState().scene.objects;
    for (const id of meshIds) {
      const obj  = objects[id];
      const mesh = AssetLoader.getBabylonMesh(id);
      if (!obj || !mesh) continue;
      this._snapshots.push({ id, obj: { ...obj }, mesh, prevParent: mesh.parent ?? null });
    }
    this.label = this._snapshots.length === 1 ? 'Delete' : `Delete (${this._snapshots.length})`;
  }
  execute() {
    _withDetachedPivot(() => {
      for (const s of this._snapshots) {
        s.mesh.setParent(null);
        s.mesh.setEnabled(false);
        setState(state => {
          const next = { ...state.scene.objects };
          delete next[s.id];
          return { ...state, scene: { ...state.scene, objects: next } };
        }, SILENT);
        dispatch(EVENTS.OBJECT_REMOVED, { id: s.id });
      }
      Selection.clear();
    });
    markDirty();
  }
  undo() {
    _withDetachedPivot(() => {
      for (const s of this._snapshots) {
        s.mesh.setEnabled(true);
        s.mesh.setParent(s.prevParent);
        setState(state => ({
          ...state,
          scene: { ...state.scene, objects: { ...state.scene.objects, [s.id]: s.obj } },
        }), SILENT);
        dispatch(EVENTS.OBJECT_RESTORED, { id: s.id });
      }
    });
  }
}

/**
 * Group N selected objects under a new TransformNode pivot at the median.
 * The new group's id is stable across redo/undo cycles.
 */
export class GroupCommand {
  constructor(meshIds, groupName = 'Group') {
    this._ids       = meshIds.slice();
    this._groupId   = `group_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    this._groupName = groupName;
    this._prevParents = {};
    this.label = 'Group';
  }
  execute() {
    _withDetachedPivot(() => {
      const meshes = this._ids
        .map(id => AssetLoader.getBabylonMesh(id))
        .filter(Boolean);
      if (!meshes.length) return;

      // Capture previous logical parents
      const objects = getState().scene.objects;
      for (const id of this._ids) {
        this._prevParents[id] = objects[id]?.parentId ?? null;
      }

      // Median in world space
      let center = new BABYLON.Vector3(0, 0, 0);
      meshes.forEach(m => center.addInPlace(m.getAbsolutePosition()));
      center.scaleInPlace(1 / meshes.length);

      const scene = SceneManager.getScene();
      const node = new BABYLON.TransformNode(this._groupName, scene);
      node.position = center;
      node.metadata = { groupId: this._groupId };

      for (const m of meshes) m.setParent(node);

      setState(state => {
        const newGroups = {
          ...state.scene.groups,
          [this._groupId]: {
            id: this._groupId,
            name: this._groupName,
            parentId: null,
            childIds: this._ids.slice(),
          },
        };
        const newObjects = { ...state.scene.objects };
        for (const id of this._ids) {
          if (newObjects[id]) newObjects[id] = { ...newObjects[id], parentId: this._groupId };
        }
        return { ...state, scene: { ...state.scene, groups: newGroups, objects: newObjects } };
      }, SILENT);

      dispatch(EVENTS.GROUP_CREATED, { groupId: this._groupId });
    });
    markDirty();
  }
  undo() {
    _withDetachedPivot(() => {
      const meshes = this._ids.map(id => AssetLoader.getBabylonMesh(id)).filter(Boolean);
      for (const m of meshes) {
        // Unparent preserving world. Babylon's setParent(null) does this.
        m.setParent(null);
      }
      const node = _findGroupNode(this._groupId);
      if (node) node.dispose();

      setState(state => {
        const newGroups = { ...state.scene.groups };
        delete newGroups[this._groupId];
        const newObjects = { ...state.scene.objects };
        for (const id of this._ids) {
          if (newObjects[id]) newObjects[id] = { ...newObjects[id], parentId: this._prevParents[id] ?? null };
        }
        return { ...state, scene: { ...state.scene, groups: newGroups, objects: newObjects } };
      }, SILENT);
      dispatch(EVENTS.GROUP_DISSOLVED, { groupId: this._groupId });
    });
  }
}

/**
 * Dissolve an existing group. Members are unparented (preserving world transform)
 * back to the group's parent (or scene root); the TransformNode is disposed.
 */
export class UngroupCommand {
  constructor(groupId) {
    this._groupId = groupId;
    const g = getState().scene.groups[groupId];
    this._snapshot = g ? { id: g.id, name: g.name, parentId: g.parentId, childIds: g.childIds.slice() } : null;
    this.label = 'Ungroup';
  }
  execute() {
    if (!this._snapshot) return;
    _withDetachedPivot(() => {
      const meshes = this._snapshot.childIds.map(id => AssetLoader.getBabylonMesh(id)).filter(Boolean);
      for (const m of meshes) m.setParent(null);
      const node = _findGroupNode(this._groupId);
      if (node) node.dispose();

      setState(state => {
        const newGroups = { ...state.scene.groups };
        delete newGroups[this._groupId];
        const newObjects = { ...state.scene.objects };
        for (const id of this._snapshot.childIds) {
          if (newObjects[id]) newObjects[id] = { ...newObjects[id], parentId: this._snapshot.parentId };
        }
        return { ...state, scene: { ...state.scene, groups: newGroups, objects: newObjects } };
      }, SILENT);
      dispatch(EVENTS.GROUP_DISSOLVED, { groupId: this._groupId });
    });
    markDirty();
  }
  undo() {
    if (!this._snapshot) return;
    _withDetachedPivot(() => {
      const meshes = this._snapshot.childIds.map(id => AssetLoader.getBabylonMesh(id)).filter(Boolean);
      if (!meshes.length) return;
      let center = new BABYLON.Vector3(0, 0, 0);
      meshes.forEach(m => center.addInPlace(m.getAbsolutePosition()));
      center.scaleInPlace(1 / meshes.length);

      const scene = SceneManager.getScene();
      const node = new BABYLON.TransformNode(this._snapshot.name, scene);
      node.position = center;
      node.metadata = { groupId: this._groupId };
      for (const m of meshes) m.setParent(node);

      setState(state => {
        const newGroups = {
          ...state.scene.groups,
          [this._groupId]: { ...this._snapshot, childIds: this._snapshot.childIds.slice() },
        };
        const newObjects = { ...state.scene.objects };
        for (const id of this._snapshot.childIds) {
          if (newObjects[id]) newObjects[id] = { ...newObjects[id], parentId: this._groupId };
        }
        return { ...state, scene: { ...state.scene, groups: newGroups, objects: newObjects } };
      }, SILENT);
      dispatch(EVENTS.GROUP_CREATED, { groupId: this._groupId });
    });
  }
}

/**
 * Duplicate one or more SceneObjects in place + a small world-X offset so the
 * copies don't z-fight with the originals. After execute() the new clones are
 * selected. Undo disables the clones (kept in memory for redo) and removes
 * them from state; redo re-enables them.
 */
const DUP_OFFSET_BU = 0.01;   // 10 mm of print, irrespective of workingRatio

export class DuplicateCommand {
  constructor(sourceIds) {
    this._sourceIds = sourceIds.slice();
    this._instances = [];       // [{ id, mesh, obj }]
    this._executed  = false;
    this.label = this._sourceIds.length === 1 ? 'Duplicate' : `Duplicate (${this._sourceIds.length})`;
  }
  execute() {
    if (this._executed) {
      // Redo path — clones still exist in memory, just disabled.
      _withDetachedPivot(() => {
        for (const inst of this._instances) {
          inst.mesh.setEnabled(true);
          AssetLoader.restoreCloneToScene(inst.id, inst.obj, inst.mesh);
          dispatch(EVENTS.OBJECT_RESTORED, { id: inst.id });
        }
        const ids = this._instances.map(i => i.id);
        Selection.set(ids, ids[ids.length - 1] ?? null);
      });
      markDirty();
      return;
    }

    _withDetachedPivot(() => {
      const newIds = [];
      for (const sourceId of this._sourceIds) {
        const newId = AssetLoader.cloneMeshAsNewObject(sourceId, { x: DUP_OFFSET_BU, y: 0, z: 0 });
        if (!newId) continue;
        const mesh = AssetLoader.getBabylonMesh(newId);
        const obj  = getState().scene.objects[newId];
        if (!mesh || !obj) continue;
        this._instances.push({ id: newId, mesh, obj });
        newIds.push(newId);
      }
      Selection.set(newIds, newIds[newIds.length - 1] ?? null);
    });
    this._executed = true;
    markDirty();
  }
  undo() {
    _withDetachedPivot(() => {
      for (const inst of this._instances) {
        inst.mesh.setParent(null);
        inst.mesh.setEnabled(false);
        setState(state => {
          const next = { ...state.scene.objects };
          delete next[inst.id];
          return { ...state, scene: { ...state.scene, objects: next } };
        }, SILENT);
        dispatch(EVENTS.OBJECT_REMOVED, { id: inst.id });
      }
    });
  }
}

// ── Stubs for later phases (Phase 4 / Phase 6) ──────────

export class ShaderAssignCommand   { constructor(){ this.label='Assign Shader';   } execute(){} undo(){} }
export class ShaderUpdateCommand   { constructor(){ this.label='Update Shader';   } execute(){} undo(){} }
export class ShaderDuplicateCommand{ constructor(){ this.label='Duplicate Shader';} execute(){} undo(){} }
export class ShaderDeleteCommand   { constructor(){ this.label='Delete Shader';   } execute(){} undo(){} }
export class UVOverrideCommand     { constructor(){ this.label='UV Override';     } execute(){} undo(){} }
export class ColorApplyCommand     { constructor(){ this.label='Apply Color';     } execute(){} undo(){} }
export class SmartReplaceCommand   { constructor(){ this.label='Smart Replace';   } execute(){} undo(){} }
export class TransformSwabCommand  { constructor(){ this.label='Transform Swab';  } execute(){} undo(){} }
