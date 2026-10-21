# Heavy-Mesh Handling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 2M–10M+ triangle print meshes import without freezing the UI, within a measured memory
envelope, pick in milliseconds, free their memory when deleted, and every worker job shows
on-screen progress.

**Architecture:** pure cores (estimate, STL parse/weld, 3MF streaming SAX, BVH, job activity
registry) run under Node tests and inside Vite module workers; `WorkerTask` stays the one job
runner and gains `label` / `cancellable` plus a shared activity registry; the UI subscribes once.

**Tech Stack:** vanilla JS ES modules, Babylon.js 9, JSZip, saxes, Vite module workers,
node:test, CDP smokes, Electron.

**Spec:** `docs/superpowers/specs/2026-10-21-heavy-mesh-handling.md`

## Global Constraints

- No new dependencies. No big fixtures in git (`.tmp/heavy-mesh` or `$HEAVY_MESH_DIR`).
- CSP and Electron security model unchanged (only a `js-flags` switch is added).
- STL import keeps Babylon's axis convention (file X,Y,Z → Babylon X,Z,Y, same index order) and
  mesh naming (`stlmesh` for binary, the solid name for ASCII), so placement, export and goldens do
  not move. Triangle counts are unchanged; vertex counts drop (welded).
- Every `new WorkerTask` passes a `label`; every worker module calls `progress(...)`.
- Existing suites stay green: `npm test`, lint, typecheck, `test:browser`, `test:export`.

## Review Focus

- A 10M binary STL on web (budget 1.5M) is refused **before** the file is read.
- 3MF with a model part over 512M characters imports (no `Invalid string length`).
- Weld: two triangles sharing an edge share vertex indices; a 90° cube edge keeps flat normals.
- Cancel during import leaves no asset, no object, no blob URL.
- BVH pick returns the same mesh, face and point as Babylon's own pick on the same ray.
- Deleting a heavy mesh and pushing past the history window disposes it (registry entry gone).

---

### Task a: Fixtures + measurement harness

**Files:** Create `scripts/heavy-mesh/generate.mjs`, `scripts/heavy-mesh/measure.mjs`,
`tests/heavy-mesh-fixtures.test.mjs`.

- [ ] Generator: pillow mesh, binary/ASCII STL chunks, 3MF via streamed JSZip. Unit test: small
      grid → binary STL length = 84 + 50·T, header count = T, 3MF model triangle count = T.
- [ ] Harness: Vite + headless Chrome (D3D11), same-origin fetch from `.tmp/heavy-mesh`, metrics
      per spec §6, kills every process in `finally`.
- [ ] Record the **before** table in the spec.

### Task b: Pre-parse estimate + refusal, measured budgets

**Files:** Create `src/core/import/TriangleEstimate.js`, `tests/triangle-estimate.test.mjs`;
modify `src/core/import/ImportLimits.js`, `src/core/assets/AssetImport.js`,
`src/core/storage/capabilities.js` (comment + numbers), i18n toasts.

- [ ] `estimateTriangles({ head, size, ext, tail? })` → `{ triangles, exact }` for STL/OBJ/3MF/GLB/glTF.
- [ ] `assertPreParseCapacity(estimate, sceneTris, budget, filename, tier)` → throws the spec
      message above 4× (exact) / 4×·1.25 (estimate); returns `'warn'` above 1×.
- [ ] Call in `importWithDedupe` and `loadFromBlob` before hashing / reading.
- [ ] Budgets: keep or replace from the measurements; update the comment to cite the spec table.

### Task c: Import off the main thread, welded geometry

**Files:** Create `src/core/import/stlParse.js`, `src/core/import/weld.js`,
`src/core/workers/MeshImport.worker.js`, `src/core/MeshImportWorker.js`,
`tests/stl-parse.test.mjs`, `tests/mesh-import-worker.test.mjs`; modify
`src/core/import/ThreeMFXml.js`, `src/core/ThreeMFLoader.js`, `src/core/assets/AssetImport.js`,
`src/core/WorkerImport.js`.

- [ ] `weldPositions(positions: Float32Array)` → `{ positions, indices, remap }` via open-addressing
      hash on float bits (no strings), `-0` == `0`.
- [ ] `creaseNormals(positions, indices, angleDeg = 40)` → split vertices at creases, flat-ish CAD
      edges, smooth scans.
- [ ] `parseStl(buffer, { onProgress })` binary + ASCII → welded `{ name, positions, normals, indices }`
      with Babylon's axis swap.
- [ ] 3MF: `parseThreeMFXml` accepts an async iterable of string chunks; triangles in `Int32Array`;
      `_findModelXml` streams the part (`internalStream`) when available; container build without
      per-triangle JS arrays.
- [ ] Worker: `{ kind: 'stl' | '3mf', blob }` → transferable result; client builds the
      AssetContainer; `loadContainer` routes `.stl` / `.3mf`; abort → nothing registered.
- [ ] OBJ: no main-thread fallback after a timeout/crash when the file is > 32 MiB.

### Task d: Progress UX for every WorkerTask job

**Files:** Create `src/core/workers/JobActivity.js`, `src/ui/JobActivity.js`,
`src/styles/components/activity.css`, `tests/job-activity.test.mjs`; modify `WorkerTask.js`, every
`new WorkerTask` site, workers lacking `progress`, `style-new.css`, `StatusBar.js`, i18n.

- [ ] Registry: `begin({label, cancel?}) → handle`, `handle.progress({fraction, stage})`,
      `handle.end(error?)`, `subscribe(fn)`, `list()`; timing rules (400 ms delay, 500 ms
      minimum, determinate on progress or > 10 s) as a pure `viewModel(now)`.
- [ ] `WorkerTask` reports every job; UI cancel aborts the job (AbortError, worker restarted).
- [ ] UI: status-bar activity area, `aria-live`, `role=progressbar`, reduced motion, error line
      with next step, mixo-app-style classes.
- [ ] Registry test: every `new WorkerTask` in `src` has a `label`; every `*.worker.js` calls
      `progress(`; behaviour test with a fake worker.

### Task e: Picking

**Files:** Create `src/core/geometry/triangleBvh.js`, `src/core/workers/TriangleBvh.worker.js`,
`src/core/scene/HeavyPick.js`, `tests/triangle-bvh.test.mjs`, `tests/heavy-pick.test.mjs`;
modify `SceneManager.js`, `InputManager.js`.

- [ ] BVH build (binned SAH, leaf ≤ 8) + nearest two-sided ray hit with `bu`, `bv`, `faceId`.
- [ ] HeavyPick: build on registration for ≥ 200k triangles, rebuild on `GEOMETRY_CHANGED`,
      instance `intersects` override with Babylon's `PickingInfo` shape; fallback until ready.
- [ ] `scene.skipPointerMovePicking/DownPicking/UpPicking = true`; context menu one pick.

### Task f: Rendering

**Files:** Create `src/core/scene/HeavyMeshFreeze.js`, `tests/heavy-mesh-freeze.test.mjs`.

- [ ] Freeze world matrix + `doNotSyncBoundingInfo` on heavy meshes when idle; unfreeze on
      selection, transform gizmo attach, `GEOMETRY_CHANGED`, `OBJECT_TRANSFORMED`.
- [ ] Display decimation: evaluate; skip with reason if it needs a second GPU copy + plumbing.

### Task g: Memory

**Files:** modify `HistoryManager.js`, `HierarchyCommands.js`, `BooleanCommands.js`,
`MeshRegistry.js`, `GeometryStore.js`, `electron/main.cjs`; tests `history-release.test.mjs`.

- [ ] `release()` called on commands leaving the undo window or the dropped redo branch; Delete /
      Boolean / Duplicate dispose the meshes only they still hold; MeshRegistry `releaseMesh`.
- [ ] Retained-triangle cap = tier budget: trim the oldest undo entries over it.
- [ ] `extract` builds the 0..n index with a loop (no per-element callback).
- [ ] Electron `js-flags=--max-old-space-size=4096`; security test still green.

### Finish

- [ ] Full `npm test`, lint, typecheck, `test:browser`, `test:export` (no installs); **after** table
      in the spec; BLUEPRINT + ADR 0006 notes; ledger + lane report.
