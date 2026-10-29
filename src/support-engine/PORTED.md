# Support engine (moved to mixo-geocore)

The P1.1 port that lived here moved to the shared engine repo `S:\ai\mixo-geocore` (task PE.2 of
`docs/plans/2026-10-29-react-wasm-supports.md`) as two TypeScript packages, `host/` (ABI-bound) and
`editing/` (renderer-free, `ViewportPort` as the only 3D seam). mixomesh vendors them under
`vendor/mixo-geocore/{host,editing}` (generated; never hand-edit) and imports them as
`@mixo-geocore/host/<path>` and `@mixo-geocore/editing/<path>`.

What stays here is app glue only:

- `loadGeometry.js` - where mixomesh serves the engine from, worker URL helper, re-export of the host loader.
- `meshWorker.entry.ts` - Vite worker entry over the host mesh worker body.

Refresh the vendored copy: `node scripts/vendor-geometry.mjs --from S:\ai\mixo-geocore --packages-only`
(PE.4 adds release pinning).
