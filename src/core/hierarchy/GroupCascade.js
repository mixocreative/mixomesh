import { logicalObjectPartIds, shouldDisplayObject } from '../LogicalObjects.js';

/**
 * Group cascade helpers (overhaul 3.4 / 2.5): groups carry no visibility of
 * their own — hiding a group hides every object under it — while lock lives on
 * the group node and cascades DOWN through `Selection.isEffectivelyLocked`.
 * Pure functions over `state.scene`; shared by the Outliner and ContextMenu.
 */

/**
 * Displayed (lead) objects anywhere under a group, nested groups included.
 * @param {string} groupId
 * @param {{objects: Record<string, any>, groups: Record<string, any>}} scene
 * @returns {string[]}
 */
export function groupDescendantObjectIds(groupId, scene) {
  const { objects, groups } = scene;
  const out = [];
  const seenObj = new Set();
  const seenGrp = new Set();
  const stack = groups[groupId] ? [groups[groupId]] : [];
  while (stack.length) {
    const g = stack.pop();
    if (seenGrp.has(g.id)) continue;
    seenGrp.add(g.id);
    for (const id of g.childIds ?? []) {
      const o = objects[id];
      if (o && shouldDisplayObject(o) && !seenObj.has(id)) { seenObj.add(id); out.push(id); }
    }
    for (const sg of Object.values(groups)) if (sg.parentId === g.id) stack.push(sg);
  }
  return out;
}

/**
 * Object ids (every material part included) a visibility command must touch
 * for a mixed selection of objects and groups.
 * @param {string[]} ids
 * @param {{objects: Record<string, any>, groups: Record<string, any>}} scene
 * @returns {string[]}
 */
export function cascadeObjectIds(ids, scene) {
  const { objects, groups } = scene;
  const out = [];
  const seen = new Set();
  const addObject = (id) => {
    const parts = logicalObjectPartIds(id, objects);
    for (const p of (parts.length ? parts : [id])) {
      if (objects[p] && !seen.has(p)) { seen.add(p); out.push(p); }
    }
  };
  for (const id of ids ?? []) {
    if (objects[id]) addObject(id);
    else if (groups[id]) for (const o of groupDescendantObjectIds(id, scene)) addObject(o);
  }
  return out;
}

/**
 * Ids a lock command must touch: objects expand to their material parts,
 * groups stay as the group id (the flag cascades by ancestry, not by copying).
 * @param {string[]} ids
 * @param {{objects: Record<string, any>, groups: Record<string, any>}} scene
 * @returns {string[]}
 */
export function cascadeLockIds(ids, scene) {
  const { objects, groups } = scene;
  const out = [];
  const seen = new Set();
  for (const id of ids ?? []) {
    if (objects[id]) {
      const parts = logicalObjectPartIds(id, objects);
      for (const p of (parts.length ? parts : [id])) if (objects[p] && !seen.has(p)) { seen.add(p); out.push(p); }
    } else if (groups[id] && !seen.has(id)) { seen.add(id); out.push(id); }
  }
  return out;
}

/**
 * True while any object under the group is visible (an empty group counts as
 * visible so its eye toggle never reads as "hidden").
 * @param {string} groupId
 * @param {{objects: Record<string, any>, groups: Record<string, any>}} scene
 */
export function groupAnyVisible(groupId, scene) {
  const ids = groupDescendantObjectIds(groupId, scene);
  return ids.length === 0 || ids.some(id => scene.objects[id]?.visible !== false);
}
