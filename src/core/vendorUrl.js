/**
 * vendorUrl — the ONE way to address a file under `public/vendor/`.
 *
 * Three copies of this three-line helper had drifted into
 * `MeshRepair._vendorUrl`, `PrintPipeline._manifoldVendorUrl` and
 * `BooleanService`'s own manifold URL (review M1).
 *
 * The URL must be absolute-from-document so both `npm run dev` (served from
 * `/`) and the Electron `file://.../dist/index.html` load resolve. A leading
 * `'/'` would break the packaged app, because `vite.config.js` sets
 * `base: './'` — hence resolving against `document.baseURI` rather than
 * hard-coding a root path. The `/${relPath}` branch is only reached with no
 * DOM at all (headless tests), where nothing fetches it.
 *
 * @param {string} relPath path under public/, e.g. 'vendor/meshfix/mesh-fix-lib.js'
 * @returns {string}
 */
export function vendorUrl(relPath) {
  return (typeof document !== 'undefined' && document.baseURI)
    ? new URL(relPath, document.baseURI).href
    : `/${relPath}`;
}

/** Directory Babylon's CSG2 init appends `/manifold.js` to. */
export const MANIFOLD_VENDOR_DIR = 'vendor/manifold-3d';
