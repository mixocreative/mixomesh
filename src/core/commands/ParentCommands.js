// Parent/group transform commands. Kept separate from object lifecycle
// commands so the HistoryManager façade can stay small and each command module
// stays inside the Blueprint size budget.

import { EVENTS } from '../events.js';
import { dispatch, setState, getState, markDirty } from '../StateManager.js';
import { t } from '../../i18n/index.js';
import { SceneManager } from '../SceneManager.js';
import { AssetLoader } from '../AssetLoader.js';
import { Selection } from '../Selection.js';
import { logicalObjectCommandIds, canonicalObjectId, logicalObjectPartIds } from '../LogicalObjects.js';
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
class _DissolveGroup {
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
    this._units = [...new Set(list.filter(Boolean))].map(id => new _DissolveGroup(id));
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

// ── Split to parts / Join (owner decision 2026-09-18) ─────────────────
//
// A multi-material import is ONE logical object made of several SceneObject
// parts (lead + `isInternalPart` siblings linked by `logicalObjectId`).
// Separation is an explicit, undoable user action — never automatic
// (Blender "Separate / Join", PrusaSlicer "Split to parts"). Geometry,
// shaders and geometryFixes are untouched by both commands; only the
// linkage flags, names and (for Split) the Outliner parent change.

function _uniqueNameIn(baseName, objects) {
  const taken = new Set(Object.values(objects).map(o => o?.name));
  if (!taken.has(baseName)) return baseName;
  const m = baseName.match(/^(.*)\.(\d{3,})$/);
  const stem = m ? m[1] : baseName;
  for (let i = 1; i < 999; i++) {
    const candidate = `${stem}.${String(i).padStart(3, '0')}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${baseName}.dup`;
}

const LINK_FIELDS = ['name', 'isInternalPart', 'logicalObjectId', 'sourceGroupId', 'isPrintPart'];

function _snapshotLink(obj) {
  const out = {};
  for (const k of LINK_FIELDS) out[k] = obj[k];
  return out;
}

function _applyLinkPatches(patches) {
  setState(state => {
    const objects = { ...state.scene.objects };
    for (const [id, patch] of Object.entries(patches)) {
      if (!objects[id]) continue;
      objects[id] = { ...objects[id], ...patch };
    }
    return { ...state, scene: { ...state.scene, objects } };
  }, SILENT);
  for (const id of Object.keys(patches)) dispatch(EVENTS.OBJECT_UPDATED, { meshId: id });
}

/**
 * Turn the internal parts of ONE logical object into independent objects
 * under a new group named after the lead. No-op (`applied === false`) on a
 * single-part object.
 */
export class SplitToPartsCommand {
  constructor(leadId) {
    this._leadId = leadId;
    this._before = null;        // id → link snapshot
    this._after = null;         // id → link patch
    this._group = null;         // CreateGroupCommand
    this._reparent = null;      // ReparentCommand (group under the lead's old parent)
    this.applied = false;
    this.label = t('history.separateByMaterial');
  }
  _plan() {
    if (this._before) return true;
    const objects = getState().scene.objects;
    const ids = logicalObjectCommandIds([this._leadId], objects);
    if (ids.length < 2) return false;
    const leadId = ids[0];
    const lead = objects[leadId];
    if (!lead || lead.isGhost) return false;
    const before = {}, after = {};
    const draft = { ...objects };
    ids.forEach((id, i) => {
      const obj = objects[id];
      before[id] = _snapshotLink(obj);
      const name = i === 0 ? obj.name : _uniqueNameIn(`${lead.name}.${String(i).padStart(3, '0')}`, draft);
      after[id] = { name, isInternalPart: false, logicalObjectId: null, sourceGroupId: null, isPrintPart: !!lead.isPrintPart };
      draft[id] = { ...obj, ...after[id] };
    });
    this._ids = ids;
    this._before = before;
    this._after = after;
    this._leadParentId = lead.parentId ?? null;
    return true;
  }
  execute() {
    if (!this._plan()) { this.applied = false; return; }
    _applyLinkPatches(this._after);
    // Group AFTER the flags are cleared so the group command sees N plain
    // objects (its id expansion would otherwise re-collapse them).
    this._group ??= new CreateGroupCommand(this._ids, `${getState().scene.objects[this._ids[0]].name} parts`);
    this._group.execute();
    if (this._leadParentId) {
      this._reparent ??= new ReparentCommand(this._group._groupId, this._leadParentId);
      this._reparent.execute();
    }
    this.applied = true;
    markDirty();
  }
  undo() {
    if (!this.applied) return;
    this._reparent?.undo();
    this._group?.undo();
    _applyLinkPatches(this._before);
    this.applied = false;
  }
}

/**
 * Merge two or more displayable objects into ONE logical object: the first
 * (or `opts.leadId`) becomes the lead, every other object — and each of its
 * existing parts — becomes an internal part. Meshes keep their transforms
 * and Babylon parents. No-op (`applied === false`) with fewer than two
 * distinct objects.
 */
export class JoinCommand {
  constructor(ids, opts = {}) {
    this._requested = ids ?? [];
    this._leadHint = opts.leadId ?? null;
    this._before = null;
    this._after = null;
    this._reparent = null;      // ReparentCommand (parts → lead's parent)
    this._dissolves = [];       // emptied `<lead> parts` groups removed
    this.applied = false;
    this.label = t('history.join');
  }
  _plan() {
    if (this._before) return true;
    const objects = getState().scene.objects;
    const { canonicalObjectId, logicalObjectPartIds } = _logical();
    const leads = [...new Set(this._requested.map(id => canonicalObjectId(id, objects)))]
      .filter(id => objects[id] && !objects[id].isGhost && !objects[id].isInternalPart);
    if (leads.length < 2) return false;
    const leadId = this._leadHint && leads.includes(canonicalObjectId(this._leadHint, objects))
      ? canonicalObjectId(this._leadHint, objects) : leads[0];
    const lead = objects[leadId];
    const before = {}, after = {};
    before[leadId] = _snapshotLink(lead);
    after[leadId] = { isInternalPart: false, logicalObjectId: leadId, sourceGroupId: null, isPrintPart: !!lead.isPrintPart };
    // The lead's own existing parts stay parts, re-pointed at the lead id.
    for (const id of logicalObjectPartIds(leadId, objects)) {
      if (id === leadId) continue;
      before[id] = _snapshotLink(objects[id]);
      after[id] = { isInternalPart: true, logicalObjectId: leadId, sourceGroupId: null, isPrintPart: !!lead.isPrintPart };
    }
    for (const other of leads) {
      if (other === leadId) continue;
      for (const id of logicalObjectPartIds(other, objects)) {
        before[id] = _snapshotLink(objects[id]);
        after[id] = { isInternalPart: true, logicalObjectId: leadId, sourceGroupId: null, isPrintPart: !!lead.isPrintPart };
      }
    }
    this._leadId = leadId;
    this._before = before;
    this._after = after;
    return true;
  }
  execute() {
    if (!this._plan()) { this.applied = false; return; }
    _applyLinkPatches(this._after);
    // Parts live where their lead lives. First dissolve any `<lead> parts`
    // group that holds only members of this join (its children rise to the
    // group's parent), then reparent stragglers next to the lead.
    if (this._reparent === null) {
      const joined = new Set(Object.keys(this._after));
      const { groups, objects } = getState().scene;
      const candidates = new Set([...joined].map(id => objects[id]?.parentId).filter(Boolean));
      for (const gid of candidates) {
        const g = groups[gid];
        if (!g || !/ parts(\.\d+)?$/.test(g.name ?? '')) continue;
        const objKids = Object.values(objects).filter(o => o.parentId === gid);
        const hasGroupKids = Object.values(groups).some(x => x.parentId === gid);
        if (!hasGroupKids && objKids.every(o => joined.has(o.id))) this._dissolves.push(new _DissolveGroup(gid));
      }
      for (const d of this._dissolves) d.execute();
      const now = getState().scene.objects;
      const leadParent = now[this._leadId]?.parentId ?? null;
      const moving = [...joined].some(id => id !== this._leadId && (now[id]?.parentId ?? null) !== leadParent);
      this._reparent = moving ? new ReparentCommand(this._leadId, leadParent) : false;
      if (this._reparent) this._reparent.execute();
    } else {
      for (const d of this._dissolves) d.execute();
      if (this._reparent) this._reparent.execute();
    }
    this.applied = true;
    markDirty();
  }
  undo() {
    if (!this.applied) return;
    if (this._reparent) this._reparent.undo();
    for (let i = this._dissolves.length - 1; i >= 0; i--) this._dissolves[i].undo();
    _applyLinkPatches(this._before);
    this.applied = false;
  }
}

// LogicalObjects is imported at the top for logicalObjectCommandIds; the two
// extra helpers are pulled through one accessor so the import line stays the
// single place that names the module.
function _logical() { return { canonicalObjectId, logicalObjectPartIds }; }
