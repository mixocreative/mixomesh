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
import { objectRatio, bakedRatioOf, anchorUnlessLabel } from '../scale/ScaleMath.js';
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

/**
 * Does `name` look like a name this app derived from `leadName`?
 *
 * The import names a multi-material part after its lead (`Bowl_primitive1`),
 * and a split names them `Bowl.001`, so both are names to replace. A name the
 * OPERATOR chose is not: a "hook" merged into a "denture" must come back as
 * "hook", not as "denture.001". Only the lead's own prefix counts, so an
 * unrelated name is never mistaken for a derived one.
 */
function _isDerivedName(name, leadName) {
  if (!name || !leadName) return true;
  if (name === leadName) return true;
  const prefix = leadName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${prefix}[._ ]`).test(name);
}

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

/*
 * `ratio` is here because both split commands now WRITE it (see `sourceRatio` below): it is the only
 * field in this list that is not a link, and it is snapshotted for exactly the same reason the links
 * are -- a patch that undo cannot reverse is worse than the defect it fixed. Widening the SNAPSHOT
 * is safe for the commands that do not write it: `_applyLinkPatches` only applies the keys each
 * patch actually carries, so for Join this restores a ratio to the value it already had.
 */
const LINK_FIELDS = ['name', 'isInternalPart', 'logicalObjectId', 'sourceGroupId', 'isPrintPart', 'ratio', 'bakedRatio', 'ratioSource'];

/**
 * The scale fields a part needs to KEEP PRINTING at `ratio` when it becomes an object.
 *
 * Moving the label alone was a regression worse than the defect it fixed, and the reload is what
 * catches it: `ProjectLoader` re-bakes each object's vertices by `bakedRatioOf`, so handing a part
 * printed at 1:1 a body baked at 1:2 and no anchor made it come back DOUBLE the size -- the exact
 * shape of gap 2, reintroduced by a one-field fix. The anchor records where the vertices actually
 * are, which is what "Set scale" has always done when it relabels without resizing
 * (`ScaleMath.anchorUnlessLabel`), and `ratioSource` follows the label it describes so the
 * provenance is not left claiming a ratio the object no longer has.
 *
 * Together: a separate changes NOTHING -- not position, not size on screen, not size after a
 * reload, not what gets printed. That is U5's own invariant, applied to scale.
 */
function _scaleFieldsFor(part, ratio, source) {
  return {
    ratio,
    bakedRatio: anchorUnlessLabel(bakedRatioOf(part), ratio),
    ratioSource: source.ratioSource,
  };
}

function _snapshotLink(obj) {
  const out = {};
  for (const k of LINK_FIELDS) out[k] = obj[k];
  return out;
}

/**
 * Support records of the leads a Join swallows.
 *
 * Supports live on the LEAD of a logical object and every read redirects there
 * (`src/supports/store.ts`), so after a merge the other object's record is
 * unreachable while still sitting in the save file: the operator is told
 * nothing, export is not blocked, and if the new lead had no supports **the
 * print goes out unsupported**. So the Join drops them and says so. Undo puts
 * them back, which is why they are snapshotted rather than simply deleted.
 *
 * Read straight off `state.scene.objects` on purpose: a command in core must
 * not import the support modules, and the record is only a field.
 */
function _supportsToDrop(leads, leadId, objects) {
  const dropped = {};
  for (const other of leads) {
    if (other === leadId) continue;
    if (objects[other]?.supports) dropped[other] = objects[other].supports;
  }
  return dropped;
}

/**
 * Objects a Join swallows whose print RATIO differs from the lead's.
 *
 * Each object carries its own `ratio` and it is already baked into its vertices, so a merge does not
 * resize anything — but the export reads the LEAD's ratio as the reference for a target size
 * (`PrintPipeline` -> `ExportContext.referenceRatio`), and the swallowed object's own `ratio` becomes
 * a field nothing reads. Ask for "print at 1:1" afterwards and the factor is computed from the
 * lead's provenance and applied to geometry that came from another, which lands at a size that is
 * right only if the two agreed.
 *
 * Reported, not corrected: re-baking vertices is exactly what Join must never do (it moves link
 * fields only, so nothing shifts in world space). The operator is told, and can undo and scale
 * first.
 */
function _ratioMismatches(leads, leadId, objects) {
  const lead = Number(objects[leadId]?.ratio ?? objects[leadId]?.modelRatio ?? 1);
  const out = [];
  for (const other of leads) {
    if (other === leadId) continue;
    const ratio = Number(objects[other]?.ratio ?? objects[other]?.modelRatio ?? 1);
    // Both fall back to 1 the way `objectRatio` does, so a missing field never reads as a mismatch.
    if (Number.isFinite(ratio) && Number.isFinite(lead) && Math.abs(ratio - lead) > 1e-9) {
      out.push({ name: objects[other]?.name ?? other, ratio, lead });
    }
  }
  return out;
}

/**
 * The `groupRepair` record cannot survive a separate, and this drops it.
 *
 * A multi-part object is repaired as ONE solid on the welded union of its parts
 * (`RepairSession._repairGroupParts`), and the record is written on EVERY part so a reload replays
 * it once for the whole object (`ProjectLoader`). Separate those parts and that promise cannot be
 * kept: the reload walks each object, finds `groupRepair`, and replays it on THAT OBJECT ALONE — a
 * per-part repair of a union that no longer exists, which is the internal-wall result
 * `GroupRepair` was written to avoid. The project would reload as different geometry from the one
 * on screen, silently.
 *
 * So the record goes, and the operator is told: after a reload those objects come back UNREPAIRED,
 * which the validator reports, rather than repaired in a way nobody chose. Undo puts it back with
 * the link fields. The alternative — refusing the separate until the repair is undone — was
 * rejected because it blocks an edit the operator is entitled to make, and the plan sanctioned
 * either (U5 gap 2: "block or invalidate; do not leave it to chance").
 *
 * Only `groupRepair` is union-specific. Every other fix type replays correctly per object and stays.
 */
const UNION_FIX = 'groupRepair';

function _unionFixesToDrop(ids, objects) {
  const found = {};
  for (const id of ids) {
    const fixes = objects[id]?.geometryFixes;
    if (Array.isArray(fixes) && fixes.includes(UNION_FIX)) found[id] = [...fixes];
  }
  return found;
}

function _setGeometryFixes(records, keep) {
  const ids = Object.keys(records);
  if (ids.length === 0) return;
  setState(state => {
    const objects = { ...state.scene.objects };
    for (const id of ids) {
      if (!objects[id]) continue;
      const fixes = keep ? records[id] : records[id].filter(fix => fix !== UNION_FIX);
      objects[id] = { ...objects[id], geometryFixes: fixes };
    }
    return { scene: { ...state.scene, objects } };
  });
}

/** Warn once, naming the objects whose union repair was dropped. */
function _warnUnionFixDropped(records) {
  const ids = Object.keys(records);
  if (ids.length === 0) return;
  const objects = getState().scene.objects;
  const names = [...new Set(ids.map(id => objects[id]?.name).filter(Boolean))];
  dispatch(EVENTS.TOAST, { message: t('toast.splitDroppedGroupRepair', { names: names.join(', ') }), type: 'warning', duration: 8000 });
}

function _setSupports(records, keep) {
  const ids = Object.keys(records);
  if (ids.length === 0) return;
  setState(state => {
    const objects = { ...state.scene.objects };
    for (const id of ids) {
      if (!objects[id]) continue;
      const next = { ...objects[id] };
      if (keep) next.supports = records[id];
      else delete next.supports;
      objects[id] = next;
    }
    return { scene: { ...state.scene, objects } };
  });
  dispatch(EVENTS.SUPPORTS_CHANGED, { objectIds: ids });
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
      // A part that carries a name of its own keeps it; one named after the lead
      // (an import part, or a name a previous split derived) gets a fresh one.
      const name = i === 0 || !_isDerivedName(obj.name, lead.name)
        ? obj.name
        : _uniqueNameIn(`${lead.name}.${String(i).padStart(3, '0')}`, draft);
      // Every id here becomes its own object, so every one of them needs the lead's scale for the
      // reason `sourceRatio` gives in the separate above: a part's own `ratio` was a field nothing
      // read, and promoting it to a lead would make a stale one authoritative.
      after[id] = { name, isInternalPart: false, logicalObjectId: null, sourceGroupId: null, isPrintPart: !!lead.isPrintPart, ..._scaleFieldsFor(obj, objectRatio(lead), lead) };
      draft[id] = { ...obj, ...after[id] };
    });
    this._ids = ids;
    this._before = before;
    this._after = after;
    this._leadParentId = lead.parentId ?? null;
    this._unionFixes = _unionFixesToDrop(ids, objects);
    return true;
  }
  execute() {
    if (!this._plan()) { this.applied = false; return; }
    _applyLinkPatches(this._after);
    _setGeometryFixes(this._unionFixes, false);
    _warnUnionFixDropped(this._unionFixes);
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
    _setGeometryFixes(this._unionFixes ?? {}, true);
    this.applied = false;
  }
}

/**
 * Separate the PICKED parts of one logical object into ONE new object (U5, the
 * owner's "pick the meshes and separate them"). Link fields only — geometry,
 * shaders and transforms are untouched, exactly as Join and SplitToParts leave
 * them, so nothing moves in world space and the plate position is preserved.
 *
 * No-op (`applied === false`) unless the picked ids are parts of ONE logical
 * object and leave at least one part behind: separating every part is
 * `SplitToPartsCommand`, and separating nothing is not an edit.
 *
 * Two cases, and the second is the one worth knowing about:
 *   - the picked set does not include the object's lead → the first picked part
 *     leads the new object, the rest follow it;
 *   - it DOES include the lead → the object left behind needs a new lead, so
 *     the first REMAINING part takes that job and the others re-point at it.
 *     Nothing about the geometry changes; `logicalObjectId` is a pointer.
 */
export class SeparateSelectionCommand {
  constructor(partIds) {
    this._requested = partIds ?? [];
    this._before = null;
    this._after = null;
    this._reparent = undefined;   // undefined = not decided yet; null = decided, none needed
    this.applied = false;
    this.label = t('history.separateSelection');
  }
  _plan() {
    if (this._before) return true;
    const objects = getState().scene.objects;
    const picked = [...new Set(this._requested)].filter(id => objects[id] && !objects[id].isGhost);
    const leads = new Set(picked.map(id => canonicalObjectId(id, objects)));
    if (picked.length === 0 || leads.size !== 1) return false;
    const sourceLead = [...leads][0];
    const all = logicalObjectPartIds(sourceLead, objects).filter(id => !objects[id]?.isGhost);
    const taken = all.filter(id => picked.includes(id));
    const left = all.filter(id => !picked.includes(id));
    if (taken.length === 0 || left.length === 0) return false;

    const source = objects[sourceLead];
    /*
     * The print scale the object was ACTUALLY being printed at, inherited by BOTH leads this edit
     * produces. Found 2026-11-13 by walking merge-then-separate.
     *
     * `objectRatio` reads the LEAD's `ratio` -- the scale term for an object at import, display and
     * export (`scale/ScaleMath.js`). A part that is not the lead keeps a `ratio` field nothing
     * reads, and a merge deliberately leaves it there while warning that the lead's scale now
     * applies (gap 6). Separating that part out again made it a lead, which PROMOTED the stale field
     * back into the reference: merge an object printed at 1:2 into one printed at 1:1, separate it
     * out, and its declared scale silently returned to 1:2 -- nothing said, geometry untouched.
     *
     * Inherited rather than warned about, because a separate has only ONE scale in play: the one the
     * operator has been looking at. A join warns because it must genuinely drop one of two. This is
     * the same inheritance `isPrintPart` already takes from `source`, one field over.
     *
     * BOTH sides, for the reason the union repair is dropped on both: when the lead itself is taken,
     * the object left behind gets a new lead, and ITS ratio becomes authoritative too.
     */
    const sourceRatio = objectRatio(source);
    const before = {}, after = {};
    const draft = { ...objects };
    const newLead = taken[0];
    // A part that carries a name of its own keeps it; one named after the
    // object it came from gets a fresh derived name (`_isDerivedName`).
    const name = _isDerivedName(objects[newLead].name, source.name)
      ? _uniqueNameIn(`${source.name}.${String(all.indexOf(newLead)).padStart(3, '0')}`, draft)
      : objects[newLead].name;
    for (const id of taken) {
      before[id] = _snapshotLink(objects[id]);
      after[id] = id === newLead
        ? { name, isInternalPart: false, logicalObjectId: newLead, sourceGroupId: null, isPrintPart: !!source.isPrintPart, ..._scaleFieldsFor(objects[id], sourceRatio, source) }
        : { isInternalPart: true, logicalObjectId: newLead, sourceGroupId: null, isPrintPart: !!source.isPrintPart };
      draft[id] = { ...objects[id], ...after[id] };
    }
    // The object left behind: its lead stays its lead unless it was taken, in
    // which case the first remaining part takes over.
    const keptLead = left.includes(sourceLead) ? sourceLead : left[0];
    for (const id of left) {
      before[id] ??= _snapshotLink(objects[id]);
      after[id] = id === keptLead
        ? { name: objects[keptLead].name, isInternalPart: false, logicalObjectId: keptLead, sourceGroupId: null, isPrintPart: !!source.isPrintPart, ..._scaleFieldsFor(objects[keptLead], sourceRatio, source) }
        : { isInternalPart: true, logicalObjectId: keptLead, sourceGroupId: null, isPrintPart: !!source.isPrintPart };
    }
    this._newLeadId = newLead;
    this._keptLeadId = keptLead;
    this._sourceLeadId = sourceLead;
    // BOTH sides, not only the parts that leave: the object left behind is a different union now,
    // so replaying a repair computed over the old one is just as wrong there.
    this._unionFixes = _unionFixesToDrop(all, objects);
    this._before = before;
    this._after = after;
    this._parentId = source.parentId ?? null;
    return true;
  }
  execute() {
    if (!this._plan()) { this.applied = false; return; }
    _applyLinkPatches(this._after);
    _setGeometryFixes(this._unionFixes, false);
    _warnUnionFixDropped(this._unionFixes);
    // The new object lives where the object it came from lives: a separate must
    // not move anything, in world space or in the outliner.
    if (this._reparent === undefined) {
      const now = getState().scene.objects;
      this._reparent = (now[this._newLeadId]?.parentId ?? null) === this._parentId
        ? null
        : new ReparentCommand(this._newLeadId, this._parentId);
    }
    this._reparent?.execute();
    // The supports of the object it came from were built against geometry that
    // has just lost parts: `_applyLinkPatches` dispatches OBJECT_UPDATED per id,
    // which is what marks them stale (src/supports/stale.ts).
    //
    // What is SELECTED afterwards is the caller's call, as it is for Join and
    // SplitToParts: a command that also drove the selection would make its own
    // undo depend on a selection the user may have changed since.
    this.applied = true;
    markDirty();
  }
  undo() {
    if (!this.applied) return;
    this._reparent?.undo();
    _applyLinkPatches(this._before);
    _setGeometryFixes(this._unionFixes ?? {}, true);
    this.applied = false;
  }

  /** The new object's id, once planned: what a caller selects after the edit. */
  get newObjectId() {
    return this._plan() ? this._newLeadId : null;
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
    this._droppedSupports = _supportsToDrop(leads, leadId, objects);
    this._ratioMismatch = _ratioMismatches(leads, leadId, objects);
    return true;
  }
  execute() {
    if (!this._plan()) { this.applied = false; return; }
    _applyLinkPatches(this._after);
    _setSupports(this._droppedSupports, false);
    const names = Object.keys(this._droppedSupports).map(id => getState().scene.objects[id]?.name).filter(Boolean);
    if (names.length > 0) {
      dispatch(EVENTS.TOAST, { message: t('toast.joinDroppedSupports', { names: names.join(', ') }), type: 'warning', duration: 8000 });
    }
    if (this._ratioMismatch.length > 0) {
      const lead = getState().scene.objects[this._leadId]?.name ?? this._leadId;
      dispatch(EVENTS.TOAST, {
        message: t('toast.joinRatioMismatch', { names: this._ratioMismatch.map(entry => entry.name).join(', '), name: lead }),
        type: 'warning',
        duration: 8000,
      });
    }
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
    _setSupports(this._droppedSupports ?? {}, true);
    this.applied = false;
  }
}

// LogicalObjects is imported at the top for logicalObjectCommandIds; the two
// extra helpers are pulled through one accessor so the import line stays the
// single place that names the module.
function _logical() { return { canonicalObjectId, logicalObjectPartIds }; }
