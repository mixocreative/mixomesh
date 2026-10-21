// Hierarchy / object-lifecycle commands (split from HistoryManager.js —
// review L29): visibility, lock, renames, delete, group/ungroup, duplicate,
// smart replace, print-part flag.

import { EVENTS } from '../events.js';
import { dispatch, setState, getState, markDirty } from '../StateManager.js';
import { t } from '../../i18n/index.js';
import { Selection } from '../Selection.js';
import { AssetLoader } from '../AssetLoader.js';
import { SceneManager } from '../SceneManager.js';
import { ShaderLibrary } from '../ShaderLibrary.js';
import { canonicalObjectId, logicalObjectCommandIds } from '../LogicalObjects.js';
import { planHierarchyRemoval } from '../hierarchy/HierarchyIntegrity.js';
import { uniqueGroupName } from './ParentCommands.js';
import {
  SILENT, withDetachedPivot, applyAbsoluteTransform, findGroupNode,
  findNodeForId, captureWorld, captureWorldNode, setParentPreserveWorld,
  applyAbsoluteNodeTransform, patchSceneObject, removeSceneObject,
  restoreSceneObject,
} from './support.js';

function _expandedCommandIds(ids) {
  return logicalObjectCommandIds(ids, getState().scene.objects);
}

function _ancestorIds(id, state) {
  const { objects, groups } = state.scene;
  const out = [];
  const seen = new Set([id]);
  let cur = objects[id]?.parentId ?? groups[id]?.parentId ?? null;
  while (cur && !seen.has(cur)) { out.push(cur); seen.add(cur); cur = groups[cur]?.parentId ?? null; }
  return out;
}

/** Group + every nested group (parent-first) and every object beneath it. */
export function collectGroupSubtree(groupId, state) {
  const { objects, groups } = state.scene;
  const groupIds = [];
  const objectIds = new Set();
  const queue = [groupId];
  while (queue.length) {
    const gid = queue.shift();
    if (!groups[gid] || groupIds.includes(gid)) continue;
    groupIds.push(gid);
    for (const id of groups[gid].childIds ?? []) if (objects[id]) objectIds.add(id);
    for (const o of Object.values(objects)) if (o.parentId === gid) objectIds.add(o.id);
    for (const g of Object.values(groups)) if (g.parentId === gid) queue.push(g.id);
  }
  return { groupIds, objectIds: [...objectIds] };
}

/**
 * Split a selection into top-level groups (selected, not inside another
 * selected group) and loose objects (not inside any selected group) so nothing
 * is processed twice. Mixed selections are the union of both.
 */
function _resolveSelection(ids, state) {
  const { objects, groups } = state.scene;
  const sel = new Set(ids);
  const covered = id => _ancestorIds(id, state).some(a => sel.has(a));
  const isGroup = id => !objects[id] && !!groups[id];
  return {
    topGroupIds: [...sel].filter(id => isGroup(id) && !covered(id)),
    looseIds: [...sel].filter(id => objects[id] && !covered(id)),
  };
}

/** Set isVisible on a set of meshes. `prev` is meshId → bool; `next` is bool. */
export class VisibilityCommand {
  constructor(meshIds, prev, next) {
    this._ids = meshIds.slice();
    this._prev = { ...prev };
    this._next = next;
    this.label = next ? t('history.show') : t('history.hide');
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

/** Set the `locked` flag on objects and/or groups (ids may mix both). */
export class LockCommand {
  constructor(meshIds, prev, next) {
    this._ids = meshIds.slice();
    this._prev = { ...prev };
    this._next = next;
    this.label = next ? t('history.lock') : t('history.unlock');
  }
  execute() {
    for (const id of this._ids) _setLocked(id, this._next);
    markDirty();
  }
  undo() {
    for (const id of this._ids) _setLocked(id, this._prev[id]);
  }
}

function _setLocked(id, locked) {
  const meshId = id;
  if (!getState().scene.objects[id] && getState().scene.groups[id]) {
    // Groups carry their own `locked` flag (cascades to descendants, 2.5).
    setState(state => ({
      ...state,
      scene: { ...state.scene, groups: { ...state.scene.groups, [id]: { ...state.scene.groups[id], locked } } },
    }), SILENT);
  } else {
    patchSceneObject(meshId, { locked });
  }
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
    this.label = t('history.renameProject');
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
    this.label = t('history.rename');
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
    this.label = t('history.renameCollection');
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

// Triangles only this hidden mesh keeps alive: 0 when its geometry is shared
// with another live mesh (a duplicate), since releasing it would free nothing
// (review M5).
const _tris = (mesh) => {
  if (!mesh || mesh.isDisposed?.()) return 0;
  const sharers = mesh.geometry?.meshes ?? [];
  if (sharers.some(m => m !== mesh && !m.isDisposed?.() && m.isEnabled?.())) return 0;
  return (mesh.getTotalIndices?.() ?? 0) / 3;
};
export { _tris as retainedTrianglesOf };

/**
 * Soft-delete: meshes are kept in memory (setEnabled(false)) so undo can
 * restore them without re-loading the asset. State entries are removed.
 * When the entry leaves the undo window (HistoryManager release, heavy-mesh
 * spec §4) the meshes are disposed for good.
 */
export class DeleteCommand {
  constructor(meshIds) {
    const requestedCount = meshIds.length;
    this._snapshots = [];
    const state = getState();
    const objects = state.scene.objects;
    const { topGroupIds, looseIds } = _resolveSelection(meshIds, state);
    const subtreeGroupIds = new Set();
    const objectIds = new Set(_expandedCommandIds(looseIds));
    for (const gid of topGroupIds) {
      const sub = collectGroupSubtree(gid, state);
      sub.groupIds.forEach(id => subtreeGroupIds.add(id));
      sub.objectIds.forEach(id => objectIds.add(id));
    }
    this._subtreeGroupIds = [...subtreeGroupIds];
    for (const id of objectIds) {
      const obj  = objects[id];
      const mesh = AssetLoader.getBabylonMesh(id);
      if (!obj || !mesh) continue;
      this._snapshots.push({ id, obj: { ...obj }, mesh, prevParent: null });
    }
    this._groupsBefore = structuredClone(state.scene.groups);
    this._groupsAfter = null;
    this._prunedGroupIds = [];   // groups whose nodes are disabled: subtree + emptied imports
    this.label = requestedCount === 1 ? t('history.delete') : t('history.deleteCount', { n: requestedCount });
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
        const doomed = new Set(this._subtreeGroupIds);
        const remaining = Object.fromEntries(Object.entries(this._groupsBefore).filter(([id]) => !doomed.has(id)));
        const plan = planHierarchyRemoval(
          remaining,
          new Set(this._snapshots.map(snapshot => snapshot.id)),
        );
        this._groupsAfter = structuredClone(plan.groups);
        for (const groupId of plan.pruneIds) delete this._groupsAfter[groupId];
        this._prunedGroupIds = [...this._subtreeGroupIds, ...plan.pruneIds];
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
  /** Executed (undo side): the deleted meshes are held only for this entry. */
  retainedTriangles(side) {
    return side === 'undo' ? this._snapshots.reduce((n, s) => n + _tris(s.mesh), 0) : 0;
  }
  release(side) {
    if (side !== 'undo') return;   // undone: the meshes are live scene content again
    for (const s of this._snapshots) {
      if (s.mesh?.isEnabled?.() === false) AssetLoader.releaseMesh(s.id, s.mesh);
    }
  }
}

function _setGroups(groups) {
  setState(state => ({
    ...state,
    scene: { ...state.scene, groups: structuredClone(groups) },
  }), SILENT);
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
    const state = getState();
    const { topGroupIds, looseIds } = _resolveSelection(sourceIds, state);
    // Each selected top-level group duplicates its WHOLE subtree as a new group.
    this._groupPlans = topGroupIds.map(rootId => ({ rootId, ...collectGroupSubtree(rootId, state) }));
    const all = new Set(_expandedCommandIds(looseIds));
    for (const plan of this._groupPlans) plan.objectIds.forEach(id => all.add(id));
    this._sourceIds = [...all];
    this._instances = [];       // [{ id, mesh, obj }]
    this._newGroupIds = [];     // every created group id
    this._newRootIds = [];      // one per duplicated top-level group
    this._groupObjectIds = new Set();   // clones that live inside a new group
    this._groupsBefore = null;
    this._groupsAfter = null;
    this._executed  = false;
    this.label = requestedCount === 1 ? t('history.duplicate') : t('history.duplicateCount', { n: requestedCount });
  }
  _selectNew() {
    const ids = [
      ...this._newRootIds,
      ...this._instances.filter(i => !this._groupObjectIds.has(i.id)).map(i => i.id),
    ];
    if (ids.length) Selection.set(ids, ids[ids.length - 1]);
  }
  execute() {
    if (this._executed) {
      // Redo path — clones still exist in memory, just disabled.
      withDetachedPivot(() => {
        _setGroups(this._groupsAfter);
        for (const gid of this._newGroupIds) findGroupNode(gid)?.setEnabled(true);
        for (const inst of this._instances) {
          inst.mesh.setEnabled(true);
          inst.mesh.setParent(inst.obj.parentId ? findGroupNode(inst.obj.parentId) : null);
          AssetLoader.restoreCloneToScene(inst.id, inst.obj, inst.mesh);
          dispatch(EVENTS.OBJECT_RESTORED, { id: inst.id });
        }
        for (const gid of this._newGroupIds) dispatch(EVENTS.GROUP_CREATED, { groupId: gid });
        this._selectNew();
      });
      markDirty();
      return;
    }

    withDetachedPivot(() => {
      const state0 = getState();
      const sourceObjects = state0.scene.objects;
      this._groupsBefore = structuredClone(state0.scene.groups);
      const inPlan = new Set(this._groupPlans.flatMap(p => p.objectIds));
      const cloneIdBySourceId = new Map();
      const sourceWorlds = new Map();
      for (const sourceId of this._sourceIds) {
        const src = AssetLoader.getBabylonMesh(sourceId);
        if (src) sourceWorlds.set(sourceId, captureWorldNode(src));
      }
      const groupWorlds = new Map();
      for (const plan of this._groupPlans) {
        for (const gid of plan.groupIds) {
          const n = findGroupNode(gid);
          if (n) groupWorlds.set(gid, captureWorldNode(n));
        }
      }
      // Same convention as object duplicate: a small world-X nudge.
      const shifted = w => ({ ...w, position: { ...w.position, x: w.position.x + DUP_OFFSET_BU } });

      for (const sourceId of this._sourceIds) {
        // Objects inside a duplicated group are placed by their group (below).
        const offset = inPlan.has(sourceId) ? undefined : { x: DUP_OFFSET_BU, y: 0, z: 0 };
        const newId = AssetLoader.cloneMeshAsNewObject(sourceId, offset);
        if (!newId) continue;
        cloneIdBySourceId.set(sourceId, newId);
        const mesh = AssetLoader.getBabylonMesh(newId);
        const obj  = getState().scene.objects[newId];
        if (!mesh || !obj) continue;
        this._instances.push({ id: newId, mesh, obj });
      }
      _remapDuplicateLogicalObjects(this._sourceIds, cloneIdBySourceId, sourceObjects);

      // Build the duplicated group subtrees (parent-first) and move the clones in.
      const scene = SceneManager.getScene();
      const draft = structuredClone(getState().scene.groups);
      const reparent = new Map();   // cloneId -> new group id
      const groupIdMap = new Map();
      for (const plan of this._groupPlans) {
        for (const oldGid of plan.groupIds) {
          const old = state0.scene.groups[oldGid];
          const newGid = `group_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
          groupIdMap.set(oldGid, newGid);
          const name = uniqueGroupName(old.name, { scene: { groups: draft } });
          const parentId = oldGid === plan.rootId ? (old.parentId ?? null) : (groupIdMap.get(old.parentId) ?? null);
          draft[newGid] = { id: newGid, name, parentId, childIds: [], origin: 'user' };
          const node = new window.BABYLON.TransformNode(name, scene);
          node.metadata = { ...(node.metadata ?? {}), groupId: newGid };
          const w = groupWorlds.get(oldGid);
          if (w) applyAbsoluteNodeTransform(node, shifted(w));
          setParentPreserveWorld(node, parentId ? findGroupNode(parentId) : null);
          if (w) applyAbsoluteNodeTransform(node, shifted(w));
          this._newGroupIds.push(newGid);
          if (oldGid === plan.rootId) this._newRootIds.push(newGid);
        }
        for (const oldId of plan.objectIds) {
          const cloneId = cloneIdBySourceId.get(oldId);
          const mesh = cloneId ? AssetLoader.getBabylonMesh(cloneId) : null;
          const newParent = groupIdMap.get(sourceObjects[oldId].parentId);
          if (!mesh || !newParent) continue;
          setParentPreserveWorld(mesh, findGroupNode(newParent));
          const w = sourceWorlds.get(oldId);
          if (w) applyAbsoluteNodeTransform(mesh, shifted(w));
          // cloneMeshAsNewObject registered the clone under the SOURCE parent — move it.
          const oldParent = sourceObjects[oldId].parentId;
          if (draft[oldParent]) draft[oldParent].childIds = draft[oldParent].childIds.filter(c => c !== cloneId);
          draft[newParent].childIds.push(cloneId);
          reparent.set(cloneId, newParent);
          this._groupObjectIds.add(cloneId);
        }
      }
      setState(state => {
        const objects = { ...state.scene.objects };
        for (const [cloneId, parentId] of reparent) {
          if (objects[cloneId]) objects[cloneId] = { ...objects[cloneId], parentId };
        }
        return { ...state, scene: { ...state.scene, objects, groups: draft } };
      }, SILENT);
      for (const inst of this._instances) {
        inst.obj = getState().scene.objects[inst.id] ?? inst.obj;
      }
      this._groupsAfter = structuredClone(getState().scene.groups);
      for (const gid of this._newGroupIds) dispatch(EVENTS.GROUP_CREATED, { groupId: gid });
      this._selectNew();
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
      for (const gid of this._newGroupIds) {
        findGroupNode(gid)?.setEnabled(false);
        dispatch(EVENTS.GROUP_DISSOLVED, { groupId: gid });
      }
      if (this._groupsBefore) _setGroups(this._groupsBefore);
    });
  }
}

function _remapDuplicateLogicalObjects(sourceIds, cloneIdBySourceId, sourceObjects) {
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

      // Re-link logicalObjectId onto the clones (glTF multi-primitive and
      // MultiMaterial splits alike). sourceGroupId is migrate-only (Decision
      // 33): clones carry none, and runtime never reads it.
      let logicalObjectId = null;
      if (sourceObj.logicalObjectId) {
        logicalObjectId = leadCloneByOldLead.get(canonicalObjectId(sourceId, sourceObjects)) ?? newId;
      }
      objects[newId] = {
        ...cloneObj,
        sourceGroupId: null,
        logicalObjectId,
        isInternalPart: !!sourceObj.isInternalPart,
      };

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
    // Any part expands to every part of its logical object (one undo step);
    // each part's prior flag is captured so undo restores exactly.
    const objects = getState().scene.objects;
    this._ids = logicalObjectCommandIds([meshId], objects);
    if (!this._ids.length) this._ids = [meshId];
    this._prevById = Object.fromEntries(this._ids.map(id => [id, id === meshId ? this._prev : !!objects[id]?.isPrintPart]));
    this.label = this._next ? t('history.markToPrint') : t('history.unmarkAsPrintPart');
  }
  execute() {
    for (const id of this._ids) _setPrintPart(id, this._next);
    markDirty();
  }
  undo() {
    for (const id of this._ids) _setPrintPart(id, this._prevById[id]);
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
    this.label = this._targets.length === 1 ? t('history.replaceWithActive') : t('history.replaceWithActiveCount', { n: this._targets.length });
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
