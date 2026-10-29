/**
 * SupportMeshSource: the one read path from the JS side (cost quote, triangle budget) to the
 * generated support meshes. The cache itself is TypeScript (src/supports/supportCache.ts), which
 * registers its reader here when it loads, so the headless Node tests (which never load it) see the
 * fail-closed default: no mesh, which makes every built support STALE and therefore left out of a
 * quote rather than quoted from a guess.
 */

let _lookup = () => undefined;

/** Register the reader: `(objectId, revision) => GeneratedSupportMesh | undefined`. */
export function setSupportMeshLookup(fn) {
  _lookup = typeof fn === 'function' ? fn : () => undefined;
}

/**
 * The support mesh of one object if it was built for `revision` (the object's current
 * `supports.revision`), else undefined.
 */
export function supportMeshFor(objectId, revision) {
  return _lookup(objectId, revision);
}
