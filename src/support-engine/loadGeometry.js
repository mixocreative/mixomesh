// App glue for the shared engine (mixo-geocore). The version-checked loader and the engine file
// names live in the vendored host package; this file only knows where mixomesh serves the engine
// from (public/vendor/mixo-geometry/, see scripts/vendor-geometry.mjs) and how a worker is told.
// Relative import (not the @mixo-geocore alias) so plain `node --test` files can load it too.
export { loadGeometryEngine, GEOMETRY_GLUE, GEOMETRY_WASM } from '../../vendor/mixo-geocore/host/loadGeometry.js';
import { GEOMETRY_GLUE } from '../../vendor/mixo-geocore/host/loadGeometry.js';

/** Directory under public/ holding the engine glue and wasm. */
export const GEOMETRY_VENDOR_DIR = 'vendor/mixo-geometry';

/** Query parameter that carries the engine glue URL to a worker (a worker has no document.baseURI). */
export const GEOMETRY_GLUE_PARAM = 'glue';

/**
 * Absolute URL of the engine glue, resolved against `base` (document.baseURI on the main thread).
 * dev serves from `/`, the build from `./` and Electron from file://, so a root-relative path
 * would break two of the three.
 * @param {string} base
 * @returns {string}
 */
export function geometryGlueUrl(base) {
  return new URL(`${GEOMETRY_VENDOR_DIR}/${GEOMETRY_GLUE}`, base).href;
}

/**
 * URL for the mesh worker's Vite entry with the glue URL attached.
 * @param {string | URL} workerUrl `new URL('./meshWorker.entry.ts', import.meta.url)`
 * @param {string} base document.baseURI
 * @returns {URL}
 */
export function meshWorkerUrl(workerUrl, base) {
  const url = new URL(workerUrl);
  url.searchParams.set(GEOMETRY_GLUE_PARAM, geometryGlueUrl(base));
  return url;
}
