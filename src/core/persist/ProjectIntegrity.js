function _addRequired(refs, assetId, ownerId) {
  if (!assetId) return;
  const id = String(assetId);
  if (!refs.has(id)) refs.set(id, new Set());
  if (ownerId) refs.get(id).add(String(ownerId));
}

/**
 * Return asset ids that must be restorable for this .mixo to reopen the saved
 * scene. This is deliberately narrower than the whole Asset Panel library:
 * unused library cards are conveniences, but SceneObjects and assigned shader
 * textures are project state.
 *
 * Ghosts are excluded (H3): a ghost object / ghost asset has no bytes anywhere
 * by definition — the load already told the user, and the serializer writes
 * the entry with `ghost: true` so the project reopens with the same ghost.
 * Demanding bytes here would make every project with one lost file unsaveable.
 */
export function collectRequiredAssetRefs(state) {
  const refs = new Map();
  const scene = state?.scene ?? {};
  const objects = scene.objects ?? {};
  const shaders = scene.shaders ?? {};
  const assets = scene.assetLibrary ?? {};

  for (const obj of Object.values(objects)) {
    if (!obj?.id || obj.isGhost) continue;
    if (!assets[obj.assetId]?.isGhost) _addRequired(refs, obj.assetId, obj.id);
    const shader = obj.shaderId ? shaders[obj.shaderId] : null;
    const texId = shader?.diffuseTextureAssetId;
    if (texId && !assets[texId]?.isGhost) _addRequired(refs, texId, obj.id);
  }

  for (const [assetId, requiredBy] of [...refs.entries()]) {
    const asset = assets[assetId];
    if (asset?.kind === 'texture' && asset.isImported) {
      for (const ownerId of requiredBy) _addRequired(refs, asset.sourceAssetId, ownerId);
    }
  }

  return new Map([...refs.entries()].map(([assetId, requiredBy]) => [
    assetId,
    Object.freeze([...requiredBy]),
  ]));
}

function _requiredIssue(code, asset, assetId, requiredBy) {
  return {
    code,
    assetId,
    filename: asset?.filename ?? null,
    kind: asset?.kind ?? null,
    requiredBy: [...(requiredBy ?? [])],
  };
}

export function missingRequiredAssetEntryIssue(assetId, requiredBy) {
  return _requiredIssue('missing-asset-entry', null, assetId, requiredBy);
}

export function missingRequiredAssetBytesIssue(asset, requiredBy) {
  return _requiredIssue('missing-asset-bytes', asset, asset.id, requiredBy);
}

export function createPortableProjectError(issues) {
  const names = issues
    .map(issue => issue.filename || issue.assetId)
    .filter(Boolean)
    .slice(0, 3)
    .join(', ');
  const suffix = names ? `: ${names}` : '';
  return Object.assign(
    new Error(`Cannot save portable .mixo; required asset bytes are missing${suffix}`),
    { portableIssues: issues },
  );
}
