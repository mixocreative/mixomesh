// Parent/group transform commands: reparent, unparent, group, ungroup. Kept separate from object
// lifecycle commands so the HistoryManager façade stays small and each command module stays inside
// the size budget.
//
// Split to parts / Join used to live at the foot of this file and are now ./SplitJoinCommands.js.
// They import from here; nothing here imports from them, which is why the cut was safe.

import { EVENTS } from '../events.js';
import { dispatch, setState, getState, markDirty } from '../StateManager.js';
import { t } from '../../i18n/index.js';
import { SceneManager } from '../SceneManager.js';
import { AssetLoader } from '../AssetLoader.js';
import { Selection } from '../Selection.js';
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
    this.label = this._nextParentId ? t('history.reparent') : t('history.unparent');
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
    this.label = t('history.unparent');
  }
}

/** Ancestor group ids of a node, nearest first (excludes the node itself). */
function _ancestorChain(id, state) {
  const chain = [];
  const seen = new Set([id]);
  let cur = state.scene.objects[id]?.parentId ?? state.scene.groups[id]?.parentId ?? null;
  while (cur && !seen.has(cur)) {
    chain.push(cur);
    seen.add(cur);
    cur = state.scene.groups[cur]?.parentId ?? null;
  }
  return chain;
}

/** Lowest common ancestor group of the given nodes, or null for scene root. */
function _lowestCommonAncestor(memberIds, state) {
  if (!memberIds.length) return null;
  const chains = memberIds.map(id => _ancestorChain(id, state));
  return chains[0].find(a => chains.every(c => c.includes(a))) ?? null;
}

/** Unique among all groups: "Group", "Group.001", ... (Split's `.001` convention). */
export function uniqueGroupName(baseName, state) {
  const taken = new Set(Object.values(state.scene.groups).map(g => g?.name));
  if (!taken.has(baseName)) return baseName;
  const m = baseName.match(/^(.*)\.(\d{3,})$/);
  const stem = m ? m[1] : baseName;
  for (let i = 1; i < 9999; i++) {
    const candidate = `${stem}.${String(i).padStart(3, '0')}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${baseName}.dup`;
}

/** Bottom-centre (centre X/Z, min Y; scene is Y-up) of the combined world AABB. */
function _bottomCentre(nodes) {
  const min = new BABYLON.Vector3(Infinity, Infinity, Infinity);
  const max = new BABYLON.Vector3(-Infinity, -Infinity, -Infinity);
  for (const node of nodes) {
    node.computeWorldMatrix?.(true);
    const meshes = node.getTotalVertices ? [node] : [];
    for (const m of (node.getChildMeshes?.(false) ?? [])) meshes.push(m);
    for (const m of meshes) {
      m.computeWorldMatrix(true);
      const bb = m.getBoundingInfo?.().boundingBox;
      if (!bb) continue;
      min.minimizeInPlace(bb.minimumWorld);
      max.maximizeInPlace(bb.maximumWorld);
    }
  }
  if (!Number.isFinite(min.x)) {
    const c = new BABYLON.Vector3(0, 0, 0);
    nodes.forEach(n => c.addInPlace(n.getAbsolutePosition()));
    return c.scaleInPlace(1 / nodes.length);
  }
  return new BABYLON.Vector3((min.x + max.x) / 2, min.y, (min.z + max.z) / 2);
}

/**
 * Group the selected objects and/or groups under a new TransformNode. The new
 * group nests under the lowest common ancestor of the members (root when they
 * span branches), is uniquely named, and its origin sits at the bottom-centre
 * of the members' combined world AABB. Members keep their world transforms.
 * Id, name and transform snapshot are stable across redo/undo.
 */
export class CreateGroupCommand {
  constructor(ids, groupName = 'Group') {
    const state = getState();
    const isGroup = id => !state.scene.objects[id] && !!state.scene.groups[id];
    const groupIds = [...new Set(ids.filter(isGroup))];
    this._ids = _expandedCommandIds(ids.filter(id => !isGroup(id)));
    this._groupMemberIds = groupIds;
    this._groupId = `group_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    this._baseName = groupName;
    this._groupName = groupName;
    this._parentId = null;
    this._groupsBefore = null;
    this._beforeParents = {};
    this._beforeGroupParents = {};
    this._beforeWorlds = {};
    this._groupWorld = null;
    this._didCreate = false;
    this.label = t('history.group');
  }
  /** Id of the group this command creates (valid once executed). */
  get groupId() { return this._groupId; }
  _ensureSnapshots() {
    if (this._groupsBefore) return;
    const state = getState();
    // Drop members already inside another selected group: the outer group moves them.
    const memberSet = new Set([...this._ids, ...this._groupMemberIds]);
    const covered = id => _ancestorChain(id, state).some(a => memberSet.has(a));
    this._groupMemberIds = this._groupMemberIds.filter(id => !covered(id));
    this._ids = this._ids.filter(id => !covered(id));
    const members = [...this._ids, ...this._groupMemberIds];
    this._parentId = _lowestCommonAncestor(members, state);
    this._groupName = uniqueGroupName(this._baseName, state);
    this._groupsBefore = structuredClone(state.scene.groups);
    const tmpState = {
      ...state,
      scene: {
        ...state.scene,
        groups: {
          ...state.scene.groups,
          [this._groupId]: { id: this._groupId, name: this._groupName, parentId: this._parentId, childIds: [], origin: 'user' },
        },
      },
    };
    const nodes = [];
    for (const id of members) {
      validateParentChange(id, this._groupId, tmpState);
      const node = findNodeForId(id);
      if (!node) throw new Error(`Invalid hierarchy: missing runtime node "${id}"`);
      if (state.scene.objects[id]) this._beforeParents[id] = state.scene.objects[id].parentId ?? null;
      else this._beforeGroupParents[id] = state.scene.groups[id].parentId ?? null;
      this._beforeWorlds[id] = captureWorldNode(node);
      nodes.push(node);
    }
    const c = _bottomCentre(nodes);
    this._groupWorld = {
      position: { x: c.x, y: c.y, z: c.z },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      scaling: { x: 1, y: 1, z: 1 },
    };
  }
  execute() {
    withDetachedPivot(() => {
      if (![...this._ids, ...this._groupMemberIds].some(id => findNodeForId(id))) return;
      this._ensureSnapshots();
      // AFTER _ensureSnapshots: it drops members already inside another
      // selected group (the outer group carries them). Building the list
      // earlier re-parented a covered child straight under the new node and
      // broke its undo (6.6b finding).
      const members = [...this._ids, ...this._groupMemberIds];

      const scene = SceneManager.getScene();
      let node = findGroupNode(this._groupId);
      if (!node) {
        node = new BABYLON.TransformNode(this._groupName, scene);
        node.metadata = { ...(node.metadata ?? {}), groupId: this._groupId };
      }
      node.name = this._groupName;
      applyAbsoluteNodeTransform(node, this._groupWorld);
      setParentPreserveWorld(node, _resolveNodeParent(this._parentId));
      applyAbsoluteNodeTransform(node, this._groupWorld);

      for (const id of members) {
        const child = findNodeForId(id);
        if (!child) continue;
        setParentPreserveWorld(child, node);
        applyAbsoluteNodeTransform(child, this._beforeWorlds[id]);
      }

      setState(state => {
        const groups = Object.fromEntries(Object.entries(state.scene.groups).map(([id, group]) => [
          id,
          { ...group, childIds: [...(group.childIds ?? [])] },
        ]));
        groups[this._groupId] = {
          id: this._groupId,
          name: this._groupName,
          parentId: this._parentId,
          childIds: [],
          origin: 'user',
        };
        for (const gid of this._groupMemberIds) {
          if (groups[gid]) groups[gid] = { ...groups[gid], parentId: this._groupId };
        }
        const objects = { ...state.scene.objects };
        for (const id of this._ids) _moveObjectParentInDraft(objects, groups, id, this._groupId);
        return { ...state, scene: { ...state.scene, groups, objects } };
      }, SILENT);
      this._didCreate = true;
      dispatch(EVENTS.GROUP_CREATED, { groupId: this._groupId });
      dispatch(EVENTS.PARENT_CHANGED, { id: this._groupId, parentId: this._parentId });
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
      for (const gid of this._groupMemberIds) {
        const gnode = findGroupNode(gid);
        if (!gnode) continue;
        gnode.setParent(_resolveNodeParent(this._beforeGroupParents[gid] ?? null));
        applyAbsoluteNodeTransform(gnode, this._beforeWorlds[gid]);
      }
      findGroupNode(this._groupId)?.dispose();
      _restoreGroupsAndObjectParents(this._groupsBefore, this._beforeParents);
      dispatch(EVENTS.GROUP_DISSOLVED, { groupId: this._groupId });
      dispatch(EVENTS.PARENT_CHANGED, { id: this._groupId, parentId: this._parentId });
    });
    markDirty();
  }
}

export class GroupCommand extends CreateGroupCommand {}

/**
 * Dissolve ONE group. Direct object children and direct subgroups move to the
 * dissolved group's parent while preserving world transforms. Building block
 * of UngroupCommand (which accepts several groups).
 */
// Exported because SplitJoinCommands.js's Join needs it to dissolve a group whose every
// child it swallowed. Not part of the public command surface -- it is one undo unit, not a command.
export class DissolveGroupUnit {
  constructor(groupId) {
    this._groupId = groupId;
    this._snapshot = null;
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

/**
 * Ungroup (task 2.4). Accepts one group id or an array; dissolves each (nested
 * selected groups included, in order), children keep their world transforms
 * and become the selection. Undo restores groups exactly and re-selects them.
 * `UngroupCommand.targetsFor(selectedIds)` resolves a selection to the groups
 * to dissolve: every selected group plus (legacy) the parent group of each
 * selected object.
 */
export class UngroupCommand {
  constructor(groupIds) {
    const list = Array.isArray(groupIds) ? groupIds : [groupIds];
    this._units = [...new Set(list.filter(Boolean))].map(id => new DissolveGroupUnit(id));
    this.label = this._units.length > 1 ? t('history.ungroupCount', { n: this._units.length }) : t('history.ungroup');
  }
  static targetsFor(selectedIds) {
    const { objects, groups } = getState().scene;
    const out = new Set();
    for (const id of selectedIds ?? []) {
      if (!objects[id] && groups[id]) out.add(id);
      else if (objects[id]?.parentId && groups[objects[id].parentId]) out.add(objects[id].parentId);
    }
    return [...out];
  }
  execute() {
    for (const unit of this._units) unit.execute();
    const { objects, groups } = getState().scene;
    const freed = [];
    for (const unit of this._units) {
      const snap = unit._snapshot;
      if (!snap) continue;
      for (const id of [...snap.objectIds, ...snap.subgroupIds]) {
        if ((objects[id] || groups[id]) && !freed.includes(id)) freed.push(id);
      }
    }
    if (freed.length) Selection.set(freed, freed[freed.length - 1]);
  }
  undo() {
    for (let i = this._units.length - 1; i >= 0; i--) this._units[i].undo();
    const groups = getState().scene.groups;
    const restored = this._units.filter(u => u._snapshot && groups[u._groupId]).map(u => u._groupId);
    if (restored.length) Selection.set(restored, restored[restored.length - 1]);
  }
}
