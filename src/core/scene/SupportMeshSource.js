/**
 * SupportMeshSource: the one read path from the JS side (cost quote, triangle budget) to the
 * generated supports. The cache itself is TypeScript (src/supports/supportCache.ts), which
 * registers its readers here when it loads, so the headless Node tests (which never load it) see the
 * fail-closed defaults: no mesh and no figures, which makes every built support unquoted rather than
 * quoted from a guess.
 *
 * Two things are read:
 *  - the drawn (preview) mesh, for the triangle HUD: `supportMeshFor`;
 *  - the EXPORT-build figures (volume, triangles; never the mesh, D24), for the cost quote:
 *    `supportFiguresFor`. The preview mesh is not the export build (tips only draws a fraction of it
 *    and the engine's preview mode differs from mode 1), so the quote never reads the preview volume.
 */

let _lookup = () => undefined;
let _figures = () => undefined;
let _request = () => {};

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

/** Register the figures reader: `(objectId, revision, scale) => {volumeMM3, triangles} | {failed:true} | undefined`. */
export function setSupportFiguresLookup(fn) {
  _figures = typeof fn === 'function' ? fn : () => undefined;
}

/** Register the requester that starts the export-build measurement: `(objectId) => void`. */
export function setSupportFiguresRequester(fn) {
  _request = typeof fn === 'function' ? fn : () => {};
}

/**
 * Export-build figures of one object at the object's `revision` and the `scale` (x the shown size):
 * `{volumeMM3, triangles}` when measured, `{failed:true}` when the export build cannot be made (the
 * supports no longer fit their object), `undefined` while not measured yet.
 */
export function supportFiguresFor(objectId, revision, scale = 1) {
  return _figures(objectId, revision, scale);
}

/** Ask for the export-build figures of one object (async; a cache-changed event fires when they land). */
export function requestSupportFigures(objectId) {
  _request(objectId);
}
