// Parent/group transform commands. Kept separate from object lifecycle
// commands so the HistoryManager façade can stay small and each command module
// stays inside the Blueprint size budget.

import { EVENTS } from '../events.js';
import { dispatch, setState, getState, markDirty } from '../StateManager.js';
import { SceneManager } from '../SceneManager.js';
import { AssetLoader } from '../AssetLoader.js';
import { logicalObjectCommandIds } from '../LogicalObjects.js';
import { directSubgroupIds, validateParentChange } from '../hierarchy/HierarchyIntegrity.js';
import {
  SILENT, withDetachedPivot, applyAbsoluteNodeTransform, findGroupNode,
  findNodeForId, captureWorldNode, setParentPreserveWorld,
} from './support.js';

const BABYLON = window.BABYLON;

function _expandedCommandIds(ids) {
  return logicalObjectCommandIds(ids, getState().scene.objects);
}

function _withoutChild(childIds = [], objectId) {
  return childIds.filter(id => id !== objectId);
}

function _withChild(childIds = [], objectId) {
  const next = _withoutChild(childIds, objectId);
  next.push(objectId);
  return next;
}

function _moveObjectParentInDraft(objects, groups, objectId, nextParentId) {
  const obj = objects[objectId];
  if (!obj) return;
  const prevParentId = obj.parentId ?? null;
  if (prevParentId && groups[prevParentId]) {
    groups[prevParentId] = {
      ...groups[prevParentId],
      childIds: _withoutChild(groups[prevParentId].childIds ?? [], objectId),
    };
  }
  if (nextParentId && groups[nextParentId]) {
    groups[nextParentId] = {
      ...groups[nextParentId],
      childIds: _withChild(groups[nextParentId].childIds ?? [], objectId),
    };
  }
  objects[objectId] = { ...obj, parentId: nextParentId ?? null };
}

function _setNodeParents(entries, parentKey) {
  setState(state => {
    const objects = { ...state.scene.objects };
    const groups = Object.fromEntries(Object.entries(state.scene.groups).map(([id, group]) => [
      id,
      { ...group, childIds: [...(group.childIds ?? [])] },
    ]));
    for (const entry of entries) {
      const parentId = entry[parentKey] ?? null;
      if (objects[entry.id]) {
        _moveObjectParentInDraft(objects, groups, entry.id, parentId);
      } else if (groups[entry.id]) {
        groups[entry.id] = { ...groups[entry.id], parentId };
      }
    }
    return { ...state, scene: { ...state.scene, objects, groups } };
  }, SILENT);
}

function _nodeKind(id, state) {
  if (state.scene.objects[id]) return 'object';
  if (state.scene.groups[id]) return 'group';
  return null;
}

function _resolveNodeParent(parentId) {
  if (!parentId) return null;
  const parentNode = findGroupNode(parentId);
  if (!parentNode) throw new Error(`Invalid hierarchy: missing runtime parent "${parentId}"`);
  return parentNode;
}

function _restoreGroupsAndObjectParents(groups, parentByObjectId) {
  setState(state => {
    const objects = { ...state.scene.objects };
    for (const [objectId, parentId] of Object.entries(parentByObjectId)) {
      if (objects[objectId]) objects[objectId] = { ...objects[objectId], parentId: parentId ?? null };
    }
    return { ...state, scene: { ...state.scene, groups: structuredClone(groups), objects } };
  }, SILENT);
}

/**
 * Reparent an object or group under another group (or scene root). Mesh objects
 * are leaves in the current runtime; group nodes are the transform parents.
 */
export class ReparentCommand {
  constructor(nodeId, nextParentId) {
    this._nodeId = nodeId;
    this._nextParentId = nextParentId ?? null;
    this._entries = null;
    this.label = this._nextParentId ? 'Reparent' : 'Unparent';
  }
  _ensureSnapshots() {
    if (this._entries) return;
    const state = getState();
    const kind = _nodeKind(this._nodeId, state);
    if (!kind) throw new Error(`Invalid hierarchy: missing node "${this._nodeId}"`);
    const ids = kind === 'object' ? _expandedCommandIds([this._nodeId]) : [this._nodeId];
    this._entries = ids.map(id => {
      validateParentChange(id, this._nextParentId, state);
      const node = findNodeForId(id);
      if (!node) throw new Error(`Invalid hierarchy: missing runtime node "${id}"`);
      return {
        id,
        beforeParentId: _nodeKind(id, state) === 'group'
          ? state.scene.groups[id]?.parentId ?? null
          : state.scene.objects[id]?.parentId ?? null,
        afterParentId: this._nextParentId,
        beforeWorld: captureWorldNode(node),
      };
    });
  }
  _apply(parentKey, worldKey) {
    const resolved = this._entries.map(entry => ({
      entry,
      node: findNodeForId(entry.id),
      parent: _resolveNodeParent(entry[parentKey] ?? null),
    }));
    for (const { entry, node, parent } of resolved) {
      if (!node) throw new Error(`Invalid hierarchy: missing runtime node "${entry.id}"`);
      setParentPreserveWorld(node, parent);
      applyAbsoluteNodeTransform(node, entry[worldKey]);
    }
    _setNodeParents(this._entries, parentKey);
    for (const entry of this._entries) {
      dispatch(EVENTS.PARENT_CHANGED, {
        id: entry.id,
        parentId: entry[parentKey] ?? null,
        prevParentId: parentKey === 'afterParentId' ? entry.beforeParentId : entry.afterParentId,
      });
    }
  }
  execute() {
    withDetachedPivot(() => {
      this._ensureSnapshots();
      this._apply('afterParentId', 'beforeWorld');
    });
    markDirty();
  }
  undo() {
    if (!this._entries) return;
    withDetachedPivot(() => this._apply('beforeParentId', 'beforeWorld'));
  }
}

export class UnparentCommand extends ReparentCommand {
  constructor(nodeId) {
    super(nodeId, null);
    this.label = 'Unparent';
  }
}

/**
 * Group N selected objects under a new TransformNode pivot at the median.
 * The new group's id and transform snapshot are stable across redo/undo.
 */
export class CreateGroupCommand {
  constructor(meshIds, groupName = 'Group') {
    this._ids = _expandedCommandIds(meshIds);
    this._groupId = `group_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    this._groupName = groupName;
    this._groupsBefore = null;
    this._beforeParents = {};
    this._beforeWorlds = {};
    this._groupWorld = null;
    this._didCreate = false;
    this.label = 'Group';
  }
  _ensureSnapshots(meshes) {
    if (this._groupsBefore) return;
    const state = getState();
    this._groupsBefore = structuredClone(state.scene.groups);
    for (const id of this._ids) {
      const obj = state.scene.objects[id];
      if (!obj) continue;
      validateParentChange(id, this._groupId, {
        ...state,
        scene: {
          ...state.scene,
          groups: {
            ...state.scene.groups,
            [this._groupId]: { id: this._groupId, name: this._groupName, parentId: null, childIds: [], origin: 'user' },
          },
        },
      });
      this._beforeParents[id] = obj.parentId ?? null;
      const mesh = AssetLoader.getBabylonMesh(id);
      if (mesh) this._beforeWorlds[id] = captureWorldNode(mesh);
    }
    const center = new BABYLON.Vector3(0, 0, 0);
    meshes.forEach(mesh => center.addInPlace(mesh.getAbsolutePosition()));
    center.scaleInPlace(1 / meshes.length);
    this._groupWorld = {
      position: { x: center.x, y: center.y, z: center.z },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      scaling: { x: 1, y: 1, z: 1 },
    };
  }
  execute() {
    withDetachedPivot(() => {
      const meshes = this._ids.map(id => AssetLoader.getBabylonMesh(id)).filter(Boolean);
      if (!meshes.length) return;
      this._ensureSnapshots(meshes);

      const scene = SceneManager.getScene();
      let node = findGroupNode(this._groupId);
      if (!node) {
        node = new BABYLON.TransformNode(this._groupName, scene);
        node.metadata = { ...(node.metadata ?? {}), groupId: this._groupId };
      }
      node.name = this._groupName;
      applyAbsoluteNodeTransform(node, this._groupWorld);

      for (const id of this._ids) {
        const mesh = AssetLoader.getBabylonMesh(id);
        if (!mesh) continue;
        setParentPreserveWorld(mesh, node);
        applyAbsoluteNodeTransform(mesh, this._beforeWorlds[id]);
      }

      setState(state => {
        const groups = Object.fromEntries(Object.entries(state.scene.groups).map(([id, group]) => [
          id,
          { ...group, childIds: [...(group.childIds ?? [])] },
        ]));
        groups[this._groupId] = {
          id: this._groupId,
          name: this._groupName,
          parentId: null,
          childIds: [],
          origin: 'user',
        };
        const objects = { ...state.scene.objects };
        for (const id of this._ids) _moveObjectParentInDraft(objects, groups, id, this._groupId);
        return { ...state, scene: { ...state.scene, groups, objects } };
      }, SILENT);
      this._didCreate = true;
      dispatch(EVENTS.GROUP_CREATED, { groupId: this._groupId });
      dispatch(EVENTS.PARENT_CHANGED, { id: this._groupId, parentId: null });
    });
    markDirty();
  }
  undo() {
    if (!this._didCreate || !this._groupsBefore) return;
    withDetachedPivot(() => {
      for (const id of this._ids) {
        const mesh = AssetLoader.getBabylonMesh(id);
        if (!mesh) continue;
        mesh.setParent(_resolveNodeParent(this._beforeParents[id] ?? null));
        applyAbsoluteNodeTransform(mesh, this._beforeWorlds[id]);
      }
      findGroupNode(this._groupId)?.dispose();
      _restoreGroupsAndObjectParents(this._groupsBefore, this._beforeParents);
      dispatch(EVENTS.GROUP_DISSOLVED, { groupId: this._groupId });
      dispatch(EVENTS.PARENT_CHANGED, { id: this._groupId, parentId: null });
    });
  }
}

export class GroupCommand extends CreateGroupCommand {}

/**
 * Dissolve an existing group. Direct object children and direct subgroups move
 * to the dissolved group's parent while preserving world transforms.
 */
export class UngroupCommand {
  constructor(groupId) {
    this._groupId = groupId;
    this._snapshot = null;
    this.label = 'Ungroup';
  }
  _ensureSnapshots() {
    if (this._snapshot) return;
    const state = getState();
    const group = state.scene.groups[this._groupId];
    if (!group) return;
    const groupNode = findGroupNode(this._groupId);
    if (!groupNode) throw new Error(`Invalid hierarchy: missing runtime node "${this._groupId}"`);
    const objectIds = (group.childIds ?? []).filter(id => state.scene.objects[id]);
    const subgroupIds = directSubgroupIds(state.scene.groups, this._groupId);
    const beforeWorlds = { [this._groupId]: captureWorldNode(groupNode) };
    for (const id of [...objectIds, ...subgroupIds]) {
      const node = findNodeForId(id);
      if (node) beforeWorlds[id] = captureWorldNode(node);
    }
    this._snapshot = {
      group: { ...group, childIds: [...(group.childIds ?? [])] },
      objectIds,
      subgroupIds,
      parentId: group.parentId ?? null,
      groupsBefore: structuredClone(state.scene.groups),
      objectParentsBefore: Object.fromEntries(objectIds.map(id => [id, state.scene.objects[id]?.parentId ?? null])),
      beforeWorlds,
    };
  }
  _buildAfterState(state) {
    const snap = this._snapshot;
    const groups = Object.fromEntries(Object.entries(state.scene.groups).map(([id, group]) => [
      id,
      { ...group, childIds: [...(group.childIds ?? [])] },
    ]));
    delete groups[this._groupId];
    for (const subgroupId of snap.subgroupIds) {
      if (groups[subgroupId]) groups[subgroupId] = { ...groups[subgroupId], parentId: snap.parentId };
    }
    const objects = { ...state.scene.objects };
    for (const objectId of snap.objectIds) _moveObjectParentInDraft(objects, groups, objectId, snap.parentId);
    return { groups, objects };
  }
  execute() {
    withDetachedPivot(() => {
      this._ensureSnapshots();
      if (!this._snapshot) return;
      const snap = this._snapshot;
      const parentNode = _resolveNodeParent(snap.parentId);
      for (const id of [...snap.objectIds, ...snap.subgroupIds]) {
        const node = findNodeForId(id);
        if (!node) continue;
        setParentPreserveWorld(node, parentNode);
        applyAbsoluteNodeTransform(node, snap.beforeWorlds[id]);
      }
      findGroupNode(this._groupId)?.dispose();

      const { groups, objects } = this._buildAfterState(getState());
      setState(state => ({ ...state, scene: { ...state.scene, groups, objects } }), SILENT);
      dispatch(EVENTS.GROUP_DISSOLVED, { groupId: this._groupId });
      dispatch(EVENTS.PARENT_CHANGED, { id: this._groupId, parentId: null });
    });
    markDirty();
  }
  undo() {
    const snap = this._snapshot;
    if (!snap) return;
    withDetachedPivot(() => {
      const scene = SceneManager.getScene();
      let node = findGroupNode(this._groupId);
      if (!node) {
        node = new BABYLON.TransformNode(snap.group.name, scene);
        node.metadata = { ...(node.metadata ?? {}), groupId: this._groupId };
      }
      node.name = snap.group.name;
      applyAbsoluteNodeTransform(node, snap.beforeWorlds[this._groupId]);
      node.setParent(_resolveNodeParent(snap.parentId));
      applyAbsoluteNodeTransform(node, snap.beforeWorlds[this._groupId]);

      for (const id of [...snap.objectIds, ...snap.subgroupIds]) {
        const child = findNodeForId(id);
        if (!child) continue;
        setParentPreserveWorld(child, node);
        applyAbsoluteNodeTransform(child, snap.beforeWorlds[id]);
      }
      _restoreGroupsAndObjectParents(snap.groupsBefore, snap.objectParentsBefore);
      dispatch(EVENTS.GROUP_CREATED, { groupId: this._groupId });
      dispatch(EVENTS.PARENT_CHANGED, { id: this._groupId, parentId: snap.parentId });
    });
  }
}
