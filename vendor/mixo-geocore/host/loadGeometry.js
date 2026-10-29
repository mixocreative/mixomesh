// Loads the mixo geometry engine and refuses a build whose engine_version() is
// not HOST_GEOMETRY_VERSION, before any geometry call can run against a
// mismatched ABI. One WASM instance per realm: the main thread and each worker
// load their own.
import { assertGeometryVersion } from './geometryVersion.js';

export const GEOMETRY_GLUE = 'mixo_geometry_wasm.js';
export const GEOMETRY_WASM = 'mixo_geometry_wasm_bg.wasm';

let _engine = null;

/**
 * The engine's module namespace, ready to call. A worker has no
 * document.baseURI, so the caller passes absolute URLs (vendorUrl on the main
 * thread). A failed load or a version mismatch clears the cache so a later call
 * can retry.
 *
 * @param {string} glueUrl absolute URL of mixo_geometry_wasm.js
 * @param {string | URL | BufferSource} [wasm] wasm URL or bytes; defaults to the file beside the glue
 * @returns {Promise<any>}
 */
export function loadGeometryEngine(glueUrl, wasm) {
  _engine ??= import(/* @vite-ignore */ glueUrl)
    .then(async glue => {
      const module_or_path = wasm ?? new URL(GEOMETRY_WASM, glueUrl);
      if (ArrayBuffer.isView(module_or_path) || module_or_path instanceof ArrayBuffer) {
        glue.initSync({ module: module_or_path });
      } else {
        await glue.default({ module_or_path });
      }
      assertGeometryVersion(glue.engine_version());
      return glue;
    })
    .catch(err => { _engine = null; throw err; });
  return _engine;
}
