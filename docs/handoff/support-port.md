# Support generation port: execution ledger

Spec: `docs/support-generation-port.md` (sections 2b inventory, 8 order). Update this file at every step.

## State

| Step | Status | Commit / notes |
|---|---|---|
| A0 Licence | decided (owner, mixosupports D23) | no audit |
| A1 Vendor engine + version gate | done 2026-10-29 | engine 9 from mixosupports `adbe7c3`; `npm run vendor:geometry`, `--check`; 3 node tests |
| A2 Port logic layer (esbuild once) + tests | next | |
| A3 Spike: worker generate, tips in Babylon, one golden | | prove browser + Electron file:// load here |
| A4 Support-area + edit UI | | |
| A5 Tips preview, per-support settings, export | | |
| A5b Remaining 2b rows | | |
| A6 Save/reopen hand work | | |
| A7 Benchmark-led WASM moves | | |

## Exact next step

A2: write a short spec (file list from guide section 8 "Logic" row, minus dental), transpile with
`npx esbuild <files> --outdir=src/support-engine --format=esm` (no bundling, keep names), wire
`geometryClient` onto `loadGeometryEngine`, port the matching `*.test.ts` (vitest in mixosupports;
mixomesh uses `node --test`, so convert or add a runner: decide in the spec).

## Notes

- mixosupports `pkg-browser` is git-ignored and can be older than its last engine commit: run
  `npm run wasm:build` there before `vendor:geometry` (the script refuses a stale or dirty build).
- Use graphify before reading source. For port questions query the cross-repo graph:
  `graphify query "<q>" --graph graphify-out/port-graph.json` (mixomesh + mixosupports; `.ts`/`.rs` nodes
  are mixosupports). Refresh it after either repo changes:
  `graphify update S:\ai\mixosupports; graphify merge-graphs graphify-out/graph.json S:\ai\mixosupports\graphify-out\graph.json --out graphify-out/port-graph.json`.
  mixomesh's own graph refreshes itself on commit (graphify git hooks); `.graphifyignore` keeps vendored
  minified code out.
- Paused run 2 leftovers (L2-03 etc.) are separate: `docs/handoff/2026-10-22-autonomous-run-2.md`.
