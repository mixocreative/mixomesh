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

let _manifold = null;

/**
 * Initialise Babylon CSG2 with the vendored Manifold — the ONE CSG2 init path
 * (BooleanService + PrintPipeline). Manifold is loaded with a plain dynamic
 * `import()` of `vendor/manifold-3d/manifold.js` and handed to Babylon as an
 * instance: Babylon's own `manifoldUrl` loader injects an INLINE
 * `<script type="module">`, which the Content-Security-Policy (task 6.1,
 * `script-src 'self'`) blocks — that init would never settle. Without a real
 * DOM (headless tests stub InitializeCSG2Async) the URL form is passed through.
 *
 * @param {any} B the Babylon namespace (window.BABYLON)
 * @returns {Promise<void>}
 */
export async function initCsg2(B) {
  if (typeof document === 'undefined' || !document.baseURI) {
    return B.InitializeCSG2Async({ manifoldUrl: vendorUrl(MANIFOLD_VENDOR_DIR) });
  }
  if (!_manifold) {
    _manifold = import(/* @vite-ignore */ vendorUrl(`${MANIFOLD_VENDOR_DIR}/manifold.js`))
      .then(async ({ default: Module }) => {
        const wasm = await Module();
        wasm.setup();
        return wasm;
      })
      .catch(err => { _manifold = null; throw err; });
  }
  const wasm = await _manifold;
  return B.InitializeCSG2Async({ manifoldInstance: wasm.Manifold, manifoldMeshInstance: wasm.Mesh });
}
