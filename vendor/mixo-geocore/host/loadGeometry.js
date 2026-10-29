// Loads the mixo geometry engine and refuses a build whose engine_version() is
// not HOST_GEOMETRY_VERSION, before any geometry call can run against a
// mismatched ABI. One WASM instance per realm: the main thread and each worker
// load their own.
import { assertGeometryVersion } from './geometryVersion.js';

/** File name of the wasm-bindgen glue module in the engine package. */
export const GEOMETRY_GLUE = 'mixo_geometry_wasm.js';
/** File name of the wasm binary, looked up beside the glue by default. */
export const GEOMETRY_WASM = 'mixo_geometry_wasm_bg.wasm';

let _engine = null;

/**
 * The engine's module namespace, ready to call. A worker has no
 * document.baseURI, so the caller passes absolute URLs (vendorUrl on the main
 * thread). A host that bundles the glue itself (a static import of the vendored
 * pkg-browser) passes the imported module namespace instead of its URL. A failed
 * load or a version mismatch clears the cache so a later call can retry.
 *
 * @param {string | object} glue absolute URL of mixo_geometry_wasm.js, or its imported module namespace
 * @param {string | URL | BufferSource} [wasm] wasm URL or bytes; defaults to the file beside the glue
 * @returns {Promise<any>}
 */
export function loadGeometryEngine(glue, wasm) {
  const glueUrl = typeof glue === 'string' ? glue : undefined;
  _engine ??= (glueUrl === undefined ? Promise.resolve(glue) : import(/* @vite-ignore */ glueUrl))
    .then(async glue => {
      const module_or_path = wasm ?? (glueUrl === undefined ? undefined : new URL(GEOMETRY_WASM, glueUrl));
      if (ArrayBuffer.isView(module_or_path) || module_or_path instanceof ArrayBuffer) {
        glue.initSync({ module: module_or_path });
      } else {
        await glue.default(module_or_path === undefined ? undefined : { module_or_path });
      }
      assertGeometryVersion(glue.engine_version());
      return glue;
    })
    .catch(err => { _engine = null; throw err; });
  return _engine;
}
