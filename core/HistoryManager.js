import { EVENTS } from './events.js';
import { dispatch, setState, getState, withoutDirty, markDirty } from './StateManager.js';
import { SceneManager } from './SceneManager.js';
import { Selection } from './Selection.js';
import { AssetLoader } from './AssetLoader.js';
import { ShaderLibrary } from './ShaderLibrary.js';

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

// ── Shader / UV commands (Phase 4) ───────────────────────

/**
 * Create a fresh shader. On undo the shader is deleted; on redo it is
 * recreated from the captured entry (id may change but no outstanding
 * reference should survive an undo).
 */
export class ShaderCreateCommand {
  constructor(partial = {}) {
    this._partial = partial;
    this._newId   = null;
    this._entry   = null;
    this.label = 'New Shader';
  }
  execute() {
    const seed = (this._newId && this._entry) ? this._entry : this._partial;
    this._newId = ShaderLibrary.createShader(seed);
    this._entry = this._newId ? { ...getState().scene.shaders[this._newId] } : null;
    markDirty();
  }
  undo() {
    if (this._newId) ShaderLibrary.deleteShader(this._newId);
  }
  /** Last-created shader id; useful for UI callers that want to focus it. */
  getNewId() { return this._newId; }
}

/**
 * Assign a shader to one or more meshes. `prev` is captured per-mesh so
 * undo restores each mesh to whatever it had before — possibly null.
 */
export class ShaderAssignCommand {
  constructor(meshIds, shaderId) {
    this._meshIds  = meshIds.slice();
    this._shaderId = shaderId;
    const objects  = getState().scene.objects;
    this._prev = {};
    for (const id of this._meshIds) this._prev[id] = objects[id]?.shaderId ?? null;
    this.label = this._meshIds.length === 1 ? 'Assign Shader' : `Assign Shader (${this._meshIds.length})`;
  }
  execute() {
    for (const id of this._meshIds) ShaderLibrary.assignToMesh(this._shaderId, id);
    markDirty();
  }
  undo() {
    for (const id of this._meshIds) {
      const prev = this._prev[id];
      if (prev) ShaderLibrary.assignToMesh(prev, id);
    }
  }
}

/**
 * Mutate one field of a shader (name / diffuseColor / opacity / etc.).
 * The caller passes both prev and next values; we don't read prev from state
 * inside execute() to keep the BLUEPRINT contract ("capture prev before execute").
 */
export class ShaderUpdateCommand {
  constructor(shaderId, field, prevValue, nextValue) {
    this._shaderId = shaderId;
    this._field    = field;
    this._prev     = prevValue;
    this._next     = nextValue;
    this.label = `Update Shader (${field})`;
  }
  execute() {
    ShaderLibrary.updateShader(this._shaderId, this._field, this._next);
    markDirty();
  }
  undo() {
    ShaderLibrary.updateShader(this._shaderId, this._field, this._prev);
  }
}

/**
 * Duplicate an existing shader. The first execute() forwards to
 * `ShaderLibrary.duplicateShader`; redo recreates from the captured entry —
 * the redone shader is a fresh id, which is fine because nothing should
 * reference the original-dup's id after undo.
 */
export class ShaderDuplicateCommand {
  constructor(sourceId) {
    this._sourceId = sourceId;
    this._newId    = null;
    this._entry    = null;
    this.label = 'Duplicate Shader';
  }
  execute() {
    if (this._newId && this._entry) {
      // Redo path. Material was disposed on undo; rebuild from snapshot.
      this._newId = ShaderLibrary.createShader(this._entry);
    } else {
      this._newId = ShaderLibrary.duplicateShader(this._sourceId);
      if (this._newId) this._entry = { ...getState().scene.shaders[this._newId] };
    }
    markDirty();
  }
  undo() {
    if (this._newId) ShaderLibrary.deleteShader(this._newId);
  }
  /** Last-created shader id; useful for UI callers that want to focus it. */
  getNewId() { return this._newId; }
}

/**
 * Delete a shader (only valid when no meshes are linked — the UI button must
 * gate on that). Undo recreates the shader from its captured fields.
 */
export class ShaderDeleteCommand {
  constructor(shaderId) {
    this._shaderId = shaderId;
    const sh = getState().scene.shaders[shaderId];
    this._snapshot = sh ? { ...sh } : null;
    this.label = 'Delete Shader';
  }
  execute() {
    if (!this._snapshot) return;
    if (ShaderLibrary.deleteShader(this._shaderId)) markDirty();
  }
  undo() {
    if (!this._snapshot) return;
    // Loses the original id (createShader mints a new one), but no
    // outstanding references should survive a successful delete.
    this._shaderId = ShaderLibrary.createShader(this._snapshot);
  }
}

/**
 * Set or clear a per-mesh UV override. Pass `nextUV = null` to clear.
 * `prevUV` is whatever was in state.scene.uvOverrides at command-construction
 * time, or null when the mesh had no prior override.
 */
export class UVOverrideCommand {
  constructor(meshId, prevUV, nextUV) {
    this._meshId = meshId;
    this._prev = prevUV ? { ...prevUV } : null;
    this._next = nextUV ? { ...nextUV } : null;
    this.label = 'UV Override';
  }
  execute() {
    if (this._next) ShaderLibrary.setUVOverride(this._meshId, this._next);
    else            ShaderLibrary.clearUVOverride(this._meshId);
    markDirty();
  }
  undo() {
    if (this._prev) ShaderLibrary.setUVOverride(this._meshId, this._prev);
    else            ShaderLibrary.clearUVOverride(this._meshId);
  }
}

/**
 * Apply a swatch's hex color to a shader's diffuse. Effectively a specialised
 * ShaderUpdateCommand for 'diffuseColor', kept separate so the COLOR_APPLIED
 * event fires for swatch-drag tracking.
 */
export class ColorApplyCommand {
  constructor(shaderId, prevHex, nextHex) {
    this._shaderId = shaderId;
    this._prev = prevHex;
    this._next = nextHex;
    this.label = 'Apply Color';
  }
  execute() {
    ShaderLibrary.applySwatchColor(this._shaderId, this._next);
    markDirty();
  }
  undo() {
    if (this._prev) ShaderLibrary.applySwatchColor(this._shaderId, this._prev);
  }
}

/** Set isPrintPart, partLabel, partTolerance on a mesh for export. */
export class PrintPartCommand {
  constructor(meshId, prevPrintPart, nextPrintPart) {
    this._meshId = meshId;
    this._prev = prevPrintPart ? { ...prevPrintPart } : { isPrintPart: false, partLabel: '', partTolerance: 0 };
    this._next = nextPrintPart ? { ...nextPrintPart } : { isPrintPart: false, partLabel: '', partTolerance: 0 };
    this.label = this._next.isPrintPart ? 'Mark as Print Part' : 'Unmark as Print Part';
  }
  execute() {
    _setPrintPart(this._meshId, this._next);
    markDirty();
  }
  undo() {
    _setPrintPart(this._meshId, this._prev);
  }
}

function _setPrintPart(meshId, printPart) {
  setState(state => {
    const o = state.scene.objects[meshId];
    if (!o) return state;
    return {
      ...state,
      scene: {
        ...state.scene,
        objects: {
          ...state.scene.objects,
          [meshId]: { ...o, ...printPart },
        },
      },
    };
  }, SILENT);
  dispatch(EVENTS.OBJECT_UPDATED, { meshId });
}

// ── Apply rotation / scale to vertices ─────────────────────

/**
 * Bake the current rotation or scaling of a mesh into its vertex data, then
 * reset the corresponding transform component to identity. Position is left
 * untouched. Mirrors Blender's "Apply Rotation / Apply Scale" command.
 *
 * Undo restores the pre-bake vertex positions and normals from a snapshot,
 * so floating-point error doesn't accumulate over many cycles.
 */
export class BakeTransformCommand {
  constructor(meshId, kind /* 'rotation' | 'scale' */) {
    this._meshId = meshId;
    this._kind = kind;
    this._snapPositions = null;
    this._snapNormals   = null;
    this._snapRotation  = null;
    this._snapQuaternion = null;
    this._snapScaling   = null;
    this.label = kind === 'rotation' ? 'Apply Rotation' : 'Apply Scale';
  }
  execute() {
    const mesh = AssetLoader.getBabylonMesh(this._meshId);
    if (!mesh || !mesh.geometry) return;
    if (this._snapPositions === null) {
      const pos = mesh.getVerticesData(BABYLON.VertexBuffer.PositionKind);
      this._snapPositions = pos ? new Float32Array(pos) : null;
      const norm = mesh.getVerticesData(BABYLON.VertexBuffer.NormalKind);
      this._snapNormals = norm ? new Float32Array(norm) : null;
      this._snapRotation = mesh.rotation.clone();
      this._snapQuaternion = mesh.rotationQuaternion ? mesh.rotationQuaternion.clone() : null;
      this._snapScaling = mesh.scaling.clone();
    }

    let mat;
    if (this._kind === 'rotation') {
      if (mesh.rotationQuaternion) {
        mat = new BABYLON.Matrix();
        mesh.rotationQuaternion.toRotationMatrix(mat);
      } else {
        mat = BABYLON.Matrix.RotationYawPitchRoll(mesh.rotation.y, mesh.rotation.x, mesh.rotation.z);
      }
      mesh.bakeTransformIntoVertices(mat);
      mesh.rotation.set(0, 0, 0);
      if (mesh.rotationQuaternion) mesh.rotationQuaternion = BABYLON.Quaternion.Identity();
    } else {
      mat = BABYLON.Matrix.Scaling(mesh.scaling.x, mesh.scaling.y, mesh.scaling.z);
      mesh.bakeTransformIntoVertices(mat);
      mesh.scaling.set(1, 1, 1);
    }
    mesh.refreshBoundingInfo?.();
    dispatch(EVENTS.OBJECT_UPDATED, { meshId: this._meshId });
    markDirty();
  }
  undo() {
    const mesh = AssetLoader.getBabylonMesh(this._meshId);
    if (!mesh) return;
    if (this._snapPositions) mesh.setVerticesData(BABYLON.VertexBuffer.PositionKind, this._snapPositions, /*updatable*/ false);
    if (this._snapNormals)   mesh.setVerticesData(BABYLON.VertexBuffer.NormalKind,   this._snapNormals,   /*updatable*/ false);
    if (this._snapRotation)  mesh.rotation.copyFrom(this._snapRotation);
    if (this._snapQuaternion) mesh.rotationQuaternion = this._snapQuaternion.clone();
    if (this._snapScaling)   mesh.scaling.copyFrom(this._snapScaling);
    mesh.refreshBoundingInfo?.();
    dispatch(EVENTS.OBJECT_UPDATED, { meshId: this._meshId });
  }
}

// ── Rescale world (working ratio change) ───────────────────

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
    this.label = `Set working scale ${_fmtRatioLabel(nextRatio)}`;
  }
  execute() { _applyWorldRescale(this._prev, this._next); markDirty(); }
  undo()    { _applyWorldRescale(this._next, this._prev); }
}

// Format a ratio number as a display string for command labels. Mirrors the
// PrintPanel formatter so an undo-stack entry reads "Set working scale 2:1"
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
}

// ── Transform Swab / Smart Replace (Phase 6) ─────────────

/** Snapshot a mesh's world transform in the {position,rotation:quat,scaling} shape. */
function _captureWorld(mesh) {
  mesh.computeWorldMatrix(true);
  const q = mesh.absoluteRotationQuaternion
    ?? BABYLON.Quaternion.FromEulerVector(mesh.rotation ?? BABYLON.Vector3.Zero());
  const p = mesh.getAbsolutePosition();
  const s = mesh.absoluteScaling ?? mesh.scaling;
  return {
    position: { x: p.x, y: p.y, z: p.z },
    rotation: { x: q.x, y: q.y, z: q.z, w: q.w },
    scaling:  { x: s.x, y: s.y, z: s.z },
  };
}

/**
 * Snap every other selected object's transform to match the active object.
 * Position + rotation + scale. Undo restores each target's prior transform.
 */
export class TransformSwabCommand {
  constructor(meshIds, activeId) {
    this._activeId = activeId;
    this._targets = (meshIds ?? []).filter(id => id !== activeId);
    this._prev = {};
    this._next = {};
    const active = AssetLoader.getBabylonMesh(activeId);
    const src = active ? _captureWorld(active) : null;
    for (const id of this._targets) {
      const m = AssetLoader.getBabylonMesh(id);
      if (!m || !src) continue;
      this._prev[id] = _captureWorld(m);
      this._next[id] = { position: { ...src.position }, rotation: { ...src.rotation }, scaling: { ...src.scaling } };
    }
    this.label = this._targets.length === 1 ? 'Transform Swab' : `Transform Swab (${this._targets.length})`;
  }
  execute() { _applyTransforms(this._next); markDirty(); dispatch(EVENTS.TRANSFORM_COMMITTED, { meshIds: Object.keys(this._next) }); }
  undo()    { _applyTransforms(this._prev); dispatch(EVENTS.TRANSFORM_COMMITTED, { meshIds: Object.keys(this._prev) }); }
}

/**
 * Replace every other selected object's geometry with a clone of the active
 * object's mesh, keeping each target's own world transform, shader,
 * collection, parent and print-part flags (BLUEPRINT context-menu "Smart
 * Replace"). Soft-deletes the originals so undo restores them instantly.
 */
export class SmartReplaceCommand {
  constructor(meshIds, activeId) {
    this._activeId = activeId;
    this._targets  = (meshIds ?? []).filter(id => id !== activeId);
    this._executed = false;
    this._pairs    = [];   // [{ oldId, oldObj, oldMesh, oldParent, newId, newMesh }]
    this.label = this._targets.length === 1 ? 'Smart Replace' : `Smart Replace (${this._targets.length})`;
  }
  execute() {
    if (this._executed) {                       // redo
      _withDetachedPivot(() => {
        for (const p of this._pairs) {
          p.oldMesh.setParent(null); p.oldMesh.setEnabled(false);
          p.newMesh.setEnabled(true);
          AssetLoader.restoreCloneToScene(p.newId, p.newObj, p.newMesh);
          setState(state => {
            const next = { ...state.scene.objects };
            delete next[p.oldId];
            return { ...state, scene: { ...state.scene, objects: next } };
          }, SILENT);
          dispatch(EVENTS.OBJECT_REMOVED,  { id: p.oldId });
          dispatch(EVENTS.OBJECT_RESTORED, { id: p.newId });
        }
        const ids = this._pairs.map(p => p.newId);
        if (ids.length) Selection.set(ids, ids[ids.length - 1]);
      });
      markDirty();
      return;
    }
    const active = AssetLoader.getBabylonMesh(this._activeId);
    if (!active) return;
    _withDetachedPivot(() => {
      for (const oldId of this._targets) {
        const oldObj  = getState().scene.objects[oldId];
        const oldMesh = AssetLoader.getBabylonMesh(oldId);
        if (!oldObj || !oldMesh) continue;
        const world = _captureWorld(oldMesh);

        const newId = AssetLoader.cloneMeshAsNewObject(this._activeId, null);
        if (!newId) continue;
        const newMesh = AssetLoader.getBabylonMesh(newId);
        if (!newMesh) continue;

        _applyAbsoluteTransform(newMesh, world);

        // Adopt the target's identity + settings; geometry comes from active.
        setState(state => {
          const cur = state.scene.objects[newId];
          if (!cur) return state;
          return {
            ...state,
            scene: { ...state.scene, objects: { ...state.scene.objects, [newId]: {
              ...cur,
              name: oldObj.name,
              collectionId: oldObj.collectionId ?? null,
              parentId: oldObj.parentId ?? null,
              isPrintPart: !!oldObj.isPrintPart,
              partLabel: oldObj.partLabel ?? '',
              partTolerance: oldObj.partTolerance ?? 0,
            } } },
          };
        }, SILENT);
        if (oldObj.shaderId) ShaderLibrary.assignToMesh(oldObj.shaderId, newId);

        oldMesh.setParent(null);
        oldMesh.setEnabled(false);
        const oldParent = oldMesh.parent ?? null;
        setState(state => {
          const next = { ...state.scene.objects };
          delete next[oldId];
          return { ...state, scene: { ...state.scene, objects: next } };
        }, SILENT);
        dispatch(EVENTS.OBJECT_REMOVED, { id: oldId });

        this._pairs.push({
          oldId, oldObj: { ...oldObj }, oldMesh, oldParent,
          newId, newObj: { ...getState().scene.objects[newId] }, newMesh,
        });
      }
      const ids = this._pairs.map(p => p.newId);
      if (ids.length) Selection.set(ids, ids[ids.length - 1]);
    });
    this._executed = true;
    markDirty();
  }
  undo() {
    _withDetachedPivot(() => {
      for (const p of this._pairs) {
        p.newMesh.setParent(null); p.newMesh.setEnabled(false);
        setState(state => {
          const next = { ...state.scene.objects };
          delete next[p.newId];
          return { ...state, scene: { ...state.scene, objects: next } };
        }, SILENT);
        dispatch(EVENTS.OBJECT_REMOVED, { id: p.newId });

        p.oldMesh.setEnabled(true);
        p.oldMesh.setParent(p.oldParent);
        setState(state => ({
          ...state,
          scene: { ...state.scene, objects: { ...state.scene.objects, [p.oldId]: p.oldObj } },
        }), SILENT);
        dispatch(EVENTS.OBJECT_RESTORED, { id: p.oldId });
      }
      const ids = this._pairs.map(p => p.oldId);
      if (ids.length) Selection.set(ids, ids[ids.length - 1]);
    });
  }
}
