// Hierarchy / object-lifecycle commands (split from HistoryManager.js —
// review L29): visibility, lock, renames, delete, group/ungroup, duplicate,
// smart replace, print-part flag.

import { EVENTS } from '../events.js';
import { dispatch, setState, getState, markDirty } from '../StateManager.js';
import { SceneManager } from '../SceneManager.js';
import { Selection } from '../Selection.js';
import { AssetLoader } from '../AssetLoader.js';
import { ShaderLibrary } from '../ShaderLibrary.js';
import { canonicalObjectId, logicalObjectCommandIds } from '../LogicalObjects.js';
import { planHierarchyRemoval } from '../hierarchy/HierarchyIntegrity.js';
import {
  SILENT, withDetachedPivot, applyAbsoluteTransform, findGroupNode,
  findNodeForId, captureWorld, patchSceneObject, removeSceneObject,
  restoreSceneObject,
} from './support.js';

const BABYLON = window.BABYLON;
let _duplicateGroupSerial = 0;

function _expandedCommandIds(ids) {
  return logicalObjectCommandIds(ids, getState().scene.objects);
}

function _newDuplicateSourceGroupId() {
  return `dup_${Date.now().toString(36)}_${++_duplicateGroupSerial}`;
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
  patchSceneObject(meshId, { visible });
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
  patchSceneObject(meshId, { locked });
  dispatch(EVENTS.LOCK_CHANGED, { meshId, locked });
}

/**
 * Rename the project. The project name is shown in the header (editable in
 * place) and is the prefix for every export filename — see §12 *Export
 * filenames*. Empty / whitespace-only input is rejected up-stream; the
 * command itself trusts its input.
 */
export class RenameProjectCommand {
  constructor(prevName, nextName) {
    this.label = 'Rename project';
    this._prev = prevName;
    this._next = nextName;
  }
  execute() { _setProjectName(this._next); markDirty(); }
  undo()    { _setProjectName(this._prev); }
}

function _setProjectName(name) {
  setState(state => ({ ...state, project: { ...state.project, name } }), SILENT);
  dispatch(EVENTS.PROJECT_RENAMED, { name });
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

function _setName(id, requestedName) {
  // Enforce scene-wide name uniqueness across both objects and groups —
  // export filenames embed `${project}_${object.name}` and would collide
  // inside the zip if two parts shared a name. Self is excluded so renames
  // to the same string are a no-op.
  let finalName = requestedName;
  setState(state => {
    const taken = new Set();
    for (const [k, o] of Object.entries(state.scene.objects)) if (k !== id) taken.add(o.name);
    for (const [k, g] of Object.entries(state.scene.groups))  if (k !== id) taken.add(g.name);
    if (taken.has(finalName)) {
      const m = finalName.match(/^(.*)\.(\d{3,})$/);
      const stem = m ? m[1] : finalName;
      for (let i = 1; i < 999; i++) {
        const c = `${stem}.${String(i).padStart(3, '0')}`;
        if (!taken.has(c)) { finalName = c; break; }
      }
    }
    if (state.scene.objects[id]) {
      const o = state.scene.objects[id];
      return { ...state, scene: { ...state.scene, objects: { ...state.scene.objects, [id]: { ...o, name: finalName } } } };
    }
    if (state.scene.groups[id]) {
      const g = state.scene.groups[id];
      return { ...state, scene: { ...state.scene, groups: { ...state.scene.groups, [id]: { ...g, name: finalName } } } };
    }
    return state;
  }, SILENT);
  const node = findNodeForId(id);
  if (node) node.name = finalName;
  dispatch(EVENTS.OBJECT_RENAMED, { id, name: finalName });
}

/** Rename an outliner collection (display bucket). Undoable (review L30). */
export class RenameCollectionCommand {
  constructor(collectionId, prevName, nextName) {
    this.label = 'Rename Collection';
    this._id = collectionId;
    this._prev = prevName;
    this._next = nextName;
  }
  execute() { _setCollectionName(this._id, this._next); markDirty(); }
  undo()    { _setCollectionName(this._id, this._prev); }
}

function _setCollectionName(collectionId, name) {
  setState(state => {
    const col = state.scene.collections?.[collectionId];
    if (!col) return state;
    return {
      ...state,
      scene: {
        ...state.scene,
        collections: { ...state.scene.collections, [collectionId]: { ...col, name } },
      },
    };
  }, SILENT);
  dispatch(EVENTS.COLLECTION_RENAMED, { collectionId, name });
}

/**
 * Soft-delete: meshes are kept in memory (setEnabled(false)) so undo can
 * restore them without re-loading the asset. State entries are removed.
 */
export class DeleteCommand {
  constructor(meshIds) {
    const requestedCount = meshIds.length;
    this._snapshots = [];
    const objects = getState().scene.objects;
    for (const id of _expandedCommandIds(meshIds)) {
      const obj  = objects[id];
      const mesh = AssetLoader.getBabylonMesh(id);
      if (!obj || !mesh) continue;
      this._snapshots.push({ id, obj: { ...obj }, mesh, prevParent: null });
    }
    this._groupsBefore = structuredClone(getState().scene.groups);
    this._groupsAfter = null;
    this._prunedGroupIds = [];
    this.label = requestedCount === 1 ? 'Delete' : `Delete (${requestedCount})`;
  }
  execute() {
    withDetachedPivot(() => {
      for (const s of this._snapshots) {
        // Captured HERE (post-detach) so it is the canonical parent — at
        // construction time the mesh may sit under the temporary selection
        // pivot, which is disposed during detach (review C3).
        s.prevParent = s.mesh.parent ?? null;
        s.mesh.setParent(null);
        s.mesh.setEnabled(false);
        removeSceneObject(s.id);
      }
      if (!this._groupsAfter) {
        const plan = planHierarchyRemoval(
          this._groupsBefore,
          new Set(this._snapshots.map(snapshot => snapshot.id)),
        );
        this._groupsAfter = structuredClone(plan.groups);
        for (const groupId of plan.pruneIds) delete this._groupsAfter[groupId];
        this._prunedGroupIds = plan.pruneIds;
      }
      _setGroups(this._groupsAfter);
      for (const groupId of this._prunedGroupIds) {
        findGroupNode(groupId)?.setEnabled(false);
        dispatch(EVENTS.GROUP_DISSOLVED, { groupId });
      }
      Selection.clear();
    });
    markDirty();
  }
  undo() {
    withDetachedPivot(() => {
      _setGroups(this._groupsBefore);
      for (const groupId of this._prunedGroupIds) {
        findGroupNode(groupId)?.setEnabled(true);
        dispatch(EVENTS.GROUP_CREATED, { groupId });
      }
      for (const s of this._snapshots) {
        s.mesh.setEnabled(true);
        s.mesh.setParent(s.prevParent);
        restoreSceneObject(s.id, s.obj);
      }
    });
  }
}

function _setGroups(groups) {
  setState(state => ({
    ...state,
    scene: { ...state.scene, groups: structuredClone(groups) },
  }), SILENT);
}

/**
 * Group N selected objects under a new TransformNode pivot at the median.
 * The new group's id is stable across redo/undo cycles.
 */
export class GroupCommand {
  constructor(meshIds, groupName = 'Group') {
    this._ids       = _expandedCommandIds(meshIds);
    this._groupId   = `group_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    this._groupName = groupName;
    this._prevParents = {};
    this.label = 'Group';
  }
  execute() {
    withDetachedPivot(() => {
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
      const center = new BABYLON.Vector3(0, 0, 0);
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
            origin: 'user',
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
    withDetachedPivot(() => {
      for (const id of this._ids) {
        const m = AssetLoader.getBabylonMesh(id);
        if (!m) continue;
        // Restore the CANONICAL Babylon parent — for nested groups that is
        // the previous group's TransformNode, not scene root (review M17).
        // setParent preserves the world transform either way.
        const prevGroupNode = findGroupNode(this._prevParents[id] ?? null);
        m.setParent(prevGroupNode ?? null);
      }
      const node = findGroupNode(this._groupId);
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
    this._snapshot = g ? { ...g, childIds: g.childIds.slice() } : null;
    this.label = 'Ungroup';
  }
  execute() {
    if (!this._snapshot) return;
    withDetachedPivot(() => {
      const meshes = this._snapshot.childIds.map(id => AssetLoader.getBabylonMesh(id)).filter(Boolean);
      // Members return to the dissolved group's PARENT node (or scene root
      // for top-level groups) — review M17, mirrors GroupCommand.undo.
      const parentNode = findGroupNode(this._snapshot.parentId ?? null);
      for (const m of meshes) m.setParent(parentNode ?? null);
      const node = findGroupNode(this._groupId);
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
    withDetachedPivot(() => {
      const meshes = this._snapshot.childIds.map(id => AssetLoader.getBabylonMesh(id)).filter(Boolean);
      if (!meshes.length) return;
      const center = new BABYLON.Vector3(0, 0, 0);
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
    const requestedCount = sourceIds.length;
    this._sourceIds = _expandedCommandIds(sourceIds);
    this._instances = [];       // [{ id, mesh, obj }]
    this._executed  = false;
    this.label = requestedCount === 1 ? 'Duplicate' : `Duplicate (${requestedCount})`;
  }
  execute() {
    if (this._executed) {
      // Redo path — clones still exist in memory, just disabled.
      withDetachedPivot(() => {
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

    withDetachedPivot(() => {
      const newIds = [];
      const sourceObjects = getState().scene.objects;
      const cloneIdBySourceId = new Map();
      for (const sourceId of this._sourceIds) {
        const newId = AssetLoader.cloneMeshAsNewObject(sourceId, { x: DUP_OFFSET_BU, y: 0, z: 0 });
        if (!newId) continue;
        cloneIdBySourceId.set(sourceId, newId);
        const mesh = AssetLoader.getBabylonMesh(newId);
        const obj  = getState().scene.objects[newId];
        if (!mesh || !obj) continue;
        this._instances.push({ id: newId, mesh, obj });
        newIds.push(newId);
      }
      _remapDuplicateLogicalObjects(this._sourceIds, cloneIdBySourceId, sourceObjects);
      for (const inst of this._instances) {
        inst.obj = getState().scene.objects[inst.id] ?? inst.obj;
      }
      Selection.set(newIds, newIds[newIds.length - 1] ?? null);
    });
    this._executed = true;
    markDirty();
  }
  undo() {
    withDetachedPivot(() => {
      for (const inst of this._instances) {
        inst.mesh.setParent(null);
        inst.mesh.setEnabled(false);
        removeSceneObject(inst.id);
      }
    });
  }
}

function _remapDuplicateLogicalObjects(sourceIds, cloneIdBySourceId, sourceObjects) {
  const groupIdByOldGroup = new Map();
  const leadCloneByOldLead = new Map();

  for (const sourceId of sourceIds) {
    const newId = cloneIdBySourceId.get(sourceId);
    if (!newId) continue;
    const oldLead = canonicalObjectId(sourceId, sourceObjects);
    if (oldLead === sourceId) leadCloneByOldLead.set(oldLead, newId);
  }
  for (const sourceId of sourceIds) {
    const newId = cloneIdBySourceId.get(sourceId);
    if (!newId) continue;
    const oldLead = canonicalObjectId(sourceId, sourceObjects);
    if (!leadCloneByOldLead.has(oldLead)) leadCloneByOldLead.set(oldLead, newId);
  }

  setState(state => {
    const objects = { ...state.scene.objects };
    for (const sourceId of sourceIds) {
      const newId = cloneIdBySourceId.get(sourceId);
      const sourceObj = sourceObjects[sourceId];
      const cloneObj = objects[newId];
      if (!newId || !sourceObj || !cloneObj) continue;

      let sourceGroupId = null;
      let logicalObjectId = null;
      // Mint a fresh sourceGroupId only when the source actually had one
      // (MultiMaterial split). But re-link logicalObjectId for BOTH cases —
      // a glTF multi-primitive object has a logicalObjectId with NO
      // sourceGroupId, and was previously left null here, splitting the
      // duplicate into N unlinked objects.
      if (sourceObj.sourceGroupId) {
        if (!groupIdByOldGroup.has(sourceObj.sourceGroupId)) {
          groupIdByOldGroup.set(sourceObj.sourceGroupId, _newDuplicateSourceGroupId());
        }
        sourceGroupId = groupIdByOldGroup.get(sourceObj.sourceGroupId);
      }
      if (sourceObj.sourceGroupId || sourceObj.logicalObjectId) {
        logicalObjectId = leadCloneByOldLead.get(canonicalObjectId(sourceId, sourceObjects)) ?? newId;
      }
      objects[newId] = {
        ...cloneObj,
        sourceGroupId,
        logicalObjectId,
        isInternalPart: !!sourceObj.isInternalPart,
      };

      const mesh = AssetLoader.getBabylonMesh(newId);
      if (mesh) {
        mesh.metadata = { ...(mesh.metadata ?? {}), sourceGroupId };
      }
    }
    return { ...state, scene: { ...state.scene, objects } };
  }, SILENT);
}

/** Toggle isPrintPart on a mesh for export. */
export class PrintPartCommand {
  constructor(meshId, prev, next) {
    this._meshId = meshId;
    this._prev = !!prev;
    this._next = !!next;
    this.label = this._next ? 'Mark as Print Part' : 'Unmark as Print Part';
  }
  execute() {
    _setPrintPart(this._meshId, this._next);
    markDirty();
  }
  undo() {
    _setPrintPart(this._meshId, this._prev);
  }
}

function _setPrintPart(meshId, isPrintPart) {
  patchSceneObject(meshId, { isPrintPart: !!isPrintPart });
  dispatch(EVENTS.OBJECT_UPDATED, { meshId });
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
      withDetachedPivot(() => {
        for (const p of this._pairs) {
          p.oldMesh.setParent(null); p.oldMesh.setEnabled(false);
          p.newMesh.setEnabled(true);
          AssetLoader.restoreCloneToScene(p.newId, p.newObj, p.newMesh);
          removeSceneObject(p.oldId);
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
    withDetachedPivot(() => {
      for (const oldId of this._targets) {
        const oldObj  = getState().scene.objects[oldId];
        const oldMesh = AssetLoader.getBabylonMesh(oldId);
        if (!oldObj || !oldMesh) continue;
        const world = captureWorld(oldMesh);

        const newId = AssetLoader.cloneMeshAsNewObject(this._activeId, null);
        if (!newId) continue;
        const newMesh = AssetLoader.getBabylonMesh(newId);
        if (!newMesh) continue;

        applyAbsoluteTransform(newMesh, world);

        // Adopt the target's identity + settings; geometry comes from active.
        patchSceneObject(newId, {
          name: oldObj.name,
          collectionId: oldObj.collectionId ?? null,
          parentId: oldObj.parentId ?? null,
          isPrintPart: !!oldObj.isPrintPart,
        });
        if (oldObj.shaderId) ShaderLibrary.assignToMesh(oldObj.shaderId, newId);

        const oldParent = oldMesh.parent ?? null;   // BEFORE unparenting (review H5)
        oldMesh.setParent(null);
        oldMesh.setEnabled(false);
        removeSceneObject(oldId);

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
    withDetachedPivot(() => {
      for (const p of this._pairs) {
        p.newMesh.setParent(null); p.newMesh.setEnabled(false);
        removeSceneObject(p.newId);

        p.oldMesh.setEnabled(true);
        p.oldMesh.setParent(p.oldParent);
        restoreSceneObject(p.oldId, p.oldObj);
      }
      const ids = this._pairs.map(p => p.oldId);
      if (ids.length) Selection.set(ids, ids[ids.length - 1]);
    });
  }
}
