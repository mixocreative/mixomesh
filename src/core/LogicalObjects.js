/**
 * Helpers for the user-facing object layer over internal material-split meshes.
 * Split siblings stay as SceneObjects for shader/export correctness, but only
 * the lead sibling is presented as the object the user selects and manages.
 */

/** @param {Record<string, any>} objects */
function _leadForSourceGroup(sourceGroupId, objects) {
  if (!sourceGroupId) return null;
  const matches = Object.values(objects ?? {}).filter(o => o?.sourceGroupId === sourceGroupId);
  return matches.find(o => !o.isInternalPart && (!o.logicalObjectId || o.logicalObjectId === o.id))
    ?? matches.find(o => !o.isInternalPart)
    ?? matches[0]
    ?? null;
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
  if (obj.sourceGroupId) return _leadForSourceGroup(obj.sourceGroupId, objects)?.id ?? id;
  return id;
}

export function logicalObjectPartIds(id, objects) {
  const leadId = canonicalObjectId(id, objects);
  const lead = objects?.[leadId];
  if (!lead) return [];

  const logicalId = lead.logicalObjectId ?? lead.id;
  const sourceGroupId = lead.sourceGroupId ?? null;
  const ids = [];
  for (const obj of Object.values(objects ?? {})) {
    if (!obj) continue;
    if (obj.id === leadId) {
      ids.push(obj.id);
    } else if (logicalId && obj.logicalObjectId === logicalId) {
      ids.push(obj.id);
    } else if (!lead.logicalObjectId && sourceGroupId && obj.sourceGroupId === sourceGroupId) {
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
