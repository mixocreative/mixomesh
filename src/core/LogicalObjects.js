/**
 * Helpers for the user-facing object layer over internal material-split meshes.
 * Split siblings stay as SceneObjects for shader/export correctness, but only
 * the lead sibling is presented as the object the user selects and manages.
 */

/**
 * Legacy-save migration (Decision 33): files written before `logicalObjectId`
 * existed linked split siblings only by `sourceGroupId`. Seed `logicalObjectId`
 * / `isInternalPart` from it ONCE at load; this is the only runtime read of
 * `sourceGroupId`. Mutates and returns `objects`. Objects that already carry a
 * `logicalObjectId` are untouched.
 * @param {Record<string, any>} objects
 */
export function seedLogicalObjectIds(objects) {
  const byGroup = new Map();
  for (const o of Object.values(objects ?? {})) {
    if (!o || o.logicalObjectId || !o.sourceGroupId) continue;
    if (!byGroup.has(o.sourceGroupId)) byGroup.set(o.sourceGroupId, []);
    byGroup.get(o.sourceGroupId).push(o);
  }
  for (const members of byGroup.values()) {
    const lead = members.find(o => !o.isInternalPart) ?? members[0];
    for (const o of members) {
      o.logicalObjectId = lead.id;
      o.isInternalPart = o.id !== lead.id;
    }
  }
  return objects;
}

export function isInternalPart(obj) {
  return !!obj?.isInternalPart;
}

export function shouldDisplayObject(obj) {
  return !!obj && !isInternalPart(obj);
}

export function canonicalObjectId(id, objects) {
  const obj = objects?.[id];
  if (!obj) return id ?? null;
  if (obj.logicalObjectId && objects[obj.logicalObjectId]) return obj.logicalObjectId;
  return id;
}

export function logicalObjectPartIds(id, objects) {
  const leadId = canonicalObjectId(id, objects);
  const lead = objects?.[leadId];
  if (!lead) return [];

  const logicalId = lead.logicalObjectId ?? lead.id;
  const ids = [];
  for (const obj of Object.values(objects ?? {})) {
    if (!obj) continue;
    if (obj.id === leadId) {
      ids.push(obj.id);
    } else if (logicalId && obj.logicalObjectId === logicalId) {
      ids.push(obj.id);
    }
  }
  return [leadId, ...ids.filter(id2 => id2 !== leadId)];
}

export function logicalObjectCommandIds(ids, objects) {
  const out = [];
  const seen = new Set();
  for (const id of ids ?? []) {
    const partIds = logicalObjectPartIds(id, objects);
    for (const partId of (partIds.length ? partIds : [id])) {
      if (!partId || seen.has(partId) || !objects?.[partId]) continue;
      seen.add(partId);
      out.push(partId);
    }
  }
  return out;
}

export function logicalObjectLeadIds(objects) {
  const out = [];
  const seen = new Set();
  for (const obj of Object.values(objects ?? {})) {
    if (!obj || obj.isGhost) continue;
    const leadId = canonicalObjectId(obj.id, objects);
    if (!leadId || seen.has(leadId)) continue;
    seen.add(leadId);
    if (shouldDisplayObject(objects[leadId])) out.push(leadId);
  }
  return out;
}

/**
 * True when `id` names a user group (`state.scene.groups`). Groups are
 * first-class selection entries alongside objects (overhaul §4.5, task 2.1).
 * @param {string|null|undefined} id
 * @param {Record<string, any>} groups
 */
export function isGroupId(id, groups) {
  return !!id && !!groups && Object.prototype.hasOwnProperty.call(groups, id) && !!groups[id];
}

/**
 * Canonical selection id for `id`: group ids pass through unchanged; object
 * ids collapse to their logical-object lead. Returns null for unknown ids
 * and ghost objects.
 * @param {string|null|undefined} id
 * @param {{ objects?: Record<string, any>, groups?: Record<string, any> }} scene
 * @returns {string|null}
 */
export function canonicalSelectableId(id, scene) {
  if (id == null) return null;
  const objects = scene?.objects ?? {};
  // Objects win on the (pathological) id collision so object behaviour is
  // never changed by the presence of a same-named group.
  if (!objects[id] && isGroupId(id, scene?.groups)) return id;
  const canonical = canonicalObjectId(id, objects);
  const obj = canonical ? objects[canonical] : null;
  if (!obj || obj.isGhost) return null;
  return canonical;
}

/**
 * Click-depth mapping (overhaul task 3.2, plan §4.5 Figma/Keynote model).
 * Maps a picked id (object, material part, or group) to the selectable item
 * at the depth of `scopeId`: material parts collapse to their logical lead,
 * then the lead's group-ancestor chain is walked upward.
 *   - `scopeId == null` (root) → the top-most ancestor (top-level group, or
 *     the object itself when it is ungrouped).
 *   - `scopeId` = a group → the direct child of that group on the chain.
 *   - The item is not inside `scopeId` → null (caller exits the scope).
 * Unknown ids and ghosts → null.
 * @param {string|null|undefined} id
 * @param {{ objects?: Record<string, any>, groups?: Record<string, any> }} scene
 * @param {string|null} [scopeId]
 * @returns {string|null}
 */
export function selectableAtDepth(id, scene, scopeId = null) {
  const start = canonicalSelectableId(id, scene);
  if (start == null) return null;
  const objects = scene?.objects ?? {};
  const groups = scene?.groups ?? {};
  const chain = [start];
  const seen = new Set(chain);
  let cur = objects[start]?.parentId ?? groups[start]?.parentId ?? null;
  while (cur && !seen.has(cur) && isGroupId(cur, groups)) {
    seen.add(cur);
    chain.push(cur);
    cur = groups[cur].parentId ?? null;
  }
  if (scopeId == null) return chain[chain.length - 1];
  const k = chain.indexOf(scopeId);
  return k > 0 ? chain[k - 1] : null;
}
