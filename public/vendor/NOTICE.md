# Vendored third-party code

Everything under `public/vendor/` is third-party code committed into this
repository on purpose: the repair engine and the CSG kernel must work with **no
network access** (offline desktop use, and no runtime CDN fetch in the export
path — see `Blueprint.md` § *Watertight repair (MeshFixLib)*). Nothing here is
written or maintained by this project; do not edit these files. To update one,
re-vendor it from upstream and update this file.

Provenance recorded 2026-09-18 (review M11).

## `meshfix/` — MeshFixLib

| | |
|---|---|
| Upstream | <https://github.com/hololocheck/MeshFixLib> |
| Licence | MIT — full text in `meshfix/LICENSE` |
| Library version | `3MF Mesh Fix Library v3.2 (WASM)` (the string in `mesh-fix-lib.js`) |
| Upstream revision | `2377e2ef3015e628a31815eadcba7a87bda30778` (commit dated 2026-04-26, `main` HEAD when these files were vendored on 2026-09-17 and still HEAD on 2026-09-18) |
| Vendored in | commit `2b92c6e` ("feat: vendored MeshFixLib repair engine + local Manifold (offline CSG)") |
| Files | `mesh-fix-core.js`, `mesh-fix-core.wasm`, `mesh-fix-lib.js`, `LICENSE` |

A C++17 mesh-repair engine compiled to WebAssembly via Emscripten: merge →
degenerate → winding → duplicates → normals → non-manifold edges/vertices →
hole fill. `mesh-fix-core.js` is the Emscripten glue for
`mesh-fix-core.wasm`; `mesh-fix-lib.js` is the JS wrapper (`MeshFixLib`
class) this project calls. Both are **classic scripts** that assign a
`window` global — not ES modules — which is why `src/core/repair/MeshRepair.js`
loads them by injecting `<script>` tags instead of `import()`.

The `http://schemas.microsoft.com/...` and `http://schemas.openxmlformats.org/...`
strings inside `mesh-fix-lib.js` are **XML namespace identifiers** for the 3MF
container format its (unused, see DEFER M12) own 3MF writer emits. They are
never fetched. `tests/hygiene.test.mjs` asserts that these are the only
`http(s)://` literals in any vendored file, so a future re-vendor cannot
smuggle in a runtime CDN fetch unnoticed.

## `manifold-3d/` — Manifold

| | |
|---|---|
| Upstream | <https://github.com/elalish/manifold> |
| Licence | Apache-2.0 — full text in `manifold-3d/LICENSE` |
| Version | `manifold-3d@3.4.0`, taken from `npm pack manifold-3d@3.4.0` |
| Vendored in | commit `2b92c6e` |
| Files | `manifold.js`, `manifold.wasm`, `LICENSE` |

The CSG kernel behind Babylon's CSG2. `manifold.js` is an ES module that
fetches `manifold.wasm` relative to itself, so the directory is handed to
`BABYLON.InitializeCSG2Async({ manifoldUrl })` — by `src/core/BooleanService.js`
(interactive Boolean) and `src/core/print/PrintPipeline.js` (CSG re-bake on
export), both through `src/core/vendorUrl.js`.
