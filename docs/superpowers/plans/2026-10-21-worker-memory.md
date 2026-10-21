# Workers & Memory Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** one worker job runner for every worker, real geometry revisions with single-copy extraction, Booleans in a worker with working caps, and leaner STL export plus chunked desktop saves.

**Architecture:** `WorkerTask` (client) + `serveTask` (worker side) own the message protocol; existing worker clients keep their public functions and delegate. `GeometryStore` tracks per-mesh revisions and produces transferable copies. Boolean worker runs raw manifold-3d on welded arrays; main thread keeps mesh/material/asset work. STL encoder writes into one buffer; Electron gains begin/chunk/commit/abort save IPC.

**Tech Stack:** vanilla JS ES modules, Babylon.js 9, manifold-3d (vendored), Vite module workers, node:test, CDP smokes, Electron.

**Spec:** `docs/superpowers/specs/2026-10-21-worker-memory-design.md`

## Global Constraints

- CSP and Electron security model unchanged; 1 GiB write ceiling kept.
- Public functions of existing worker clients keep their names, signatures and observable behaviour (existing tests stay green unchanged unless a test pinned an internal detail — then rule and ledger).
- Worker message protocol: request `{ id, type: 'run', payload, revision? }`; replies `{ id, type: 'progress', ... }`, `{ id, type: 'done', result, revision? }`, `{ id, type: 'error', message }`.
- Caps: `DEFAULT_BOOLEAN_TRIANGLE_CAP` 50 000 (inline fallback); `caps.booleanTriangleCap` web 250 000, desktop 1 000 000 (worker path).
- Chunked save: chunk ≤ 16 MiB; streaming used above 64 MiB.
- STL output byte-identical to the current encoder.

## Review Focus

- A persistent worker that crashes mid-job while another job is queued → both reject, next call gets a fresh worker. (Task 1 test.)
- Abort after the worker already replied `done` → result delivered once, no late rejection. (Task 1 test.)
- Boolean operands that are not watertight (Manifold rejects) → clear error, no stuck progress, no half-registered asset. (Task 6 test + smoke.)
- Chunked save aborted half-way (renderer throws between chunks) → temp file removed, target untouched. (Task 8 test.)
- Geometry mutated while a refinement/validation job is in flight → result discarded as stale. (Task 5 test.)

---

### Task 1: WorkerTask runner

**Files:** Create `src/core/workers/WorkerTask.js`, `src/core/workers/serveTask.js`, `tests/worker-task.test.mjs`.

**Interfaces — Produces:**
- `class WorkerTask { constructor({ create: () => Worker, mode = 'persistent' | 'per-job', concurrency = 'parallel' | 'serial', timeoutMs = 120000, fallback?: (payload) => Promise<any>|any, name }) ; run(payload, { transfer = [], signal, timeoutMs, onProgress, revision } = {}) -> Promise<result>; terminate() }`
- Errors: abort → `DOMException('…', 'AbortError')`; timeout → `Error` with `code = 'timeout'`; other jobs on a restarted persistent worker → `Error` with `code = 'restarted'`; stale → `Error` with `code = 'stale'`; worker error reply → `Error(message)`.
- `serveTask(handler)` in a worker: `handler(payload, { progress(obj), revision }) -> result | { result, transfer }`.

- [ ] Tests (fake Worker class): progress forwarded; done resolves; error rejects with message; abort rejects AbortError and a later `done` is ignored; timeout terminates and recreates, other in-flight jobs reject `restarted`; crash (`onerror`) same; stale revision rejects `stale`; serial runs one at a time in order; per-job mode terminates after settle; no `Worker` → fallback used; creation throws → fallback used; transfer list passed to postMessage.
- [ ] Run → FAIL (module missing). Implement. Run → PASS. Commit `feat(workers): shared WorkerTask runner`.

### Task 2: Base64, Validate, OpfsWrite on WorkerTask

**Files:** Modify `src/core/Base64Worker.js`, `src/core/workers/Base64.worker.js`, `src/core/ValidateWorker.js`, `src/core/workers/MeshValidate.worker.js`, `src/core/storage/OpfsStorageAdapter.js`, `src/core/workers/OpfsWrite.worker.js`. Tests: existing `persistence`, `validator`, `validation-cache`, `opfs-storage-adapter` stay green; add OPFS timeout test.

- [ ] Add test: OPFS write worker that never replies → rejects with timeout after `OPFS_WRITE_TIMEOUT_MS` (60 000, overridable for tests). FAIL. Migrate all three. PASS + full `npm test`. Commit `refactor(workers): base64, validate, opfs on WorkerTask`.

### Task 3: Refine and ObjParse on WorkerTask

**Files:** Modify `src/core/MixoRefinementWorker.js`, `src/core/workers/MixoRefine.worker.js`, `src/core/WorkerImport.js`, `src/core/workers/ObjParse.worker.js`. Tests: `mixo-refinement-worker`, `worker-import` stay green (ObjParse `serial`, refine `per-job` with revision).

- [ ] Migrate; `npm test` green; `npm run test:browser` (OBJ worker path, no fallback) green. Commit `refactor(workers): refine and obj import on WorkerTask`.

### Task 4: GeometryStore

**Files:** Create `src/core/geometry/GeometryStore.js`, `tests/geometry-store.test.mjs`. Modify `src/core/events.js` (`GEOMETRY_CHANGED: 'geometry:changed'`).

**Produces:** `revisionOf(meshId) -> number` (0 when unknown), `bump(meshId) -> number` (dispatches `GEOMETRY_CHANGED { meshId, revision }`), `meshIdOf(mesh) -> string|null` (`mesh.metadata.meshId`), `extract(mesh, { space = 'local', uvs = false } = {}) -> { positions: Float32Array, indices: Uint32Array, uvs?: Float32Array, revision }` (fresh owned buffers; world space multiplies positions by `mesh.computeWorldMatrix(true)` on the copy; 16-bit index sources widened).

- [ ] Tests: revision starts 0, bump increments and dispatches; extract returns copies (mutating them leaves the mesh arrays unchanged); world space applies a translation+scale matrix; uvs only when asked; missing data → empty arrays. FAIL → implement → PASS. Commit `feat(geometry): GeometryStore revisions and extraction`.

### Task 5: Bump on every mutation; extract in validate/refine

**Files:** Modify mutation sites: `src/core/commands/ScaleCommands.js` (both bakes), `src/core/assets/AssetRestore.js` (ratio bake), `src/core/ImportNormalizer.js` (bake + unshare), `src/core/repair/MeshRepair.js` (`arraysToMesh`, `conformWinding`, export-only paths excluded), `src/core/repair/Weld.js`, `src/core/repair/RepairSession.js` (mirror + flip), `src/core/commands/PlacementCommands.js` (mirror). Use `extract` in `src/core/ValidateWorker.js` and `src/core/refinement/RefinementController.js` (single copy; revision = geometry revision).

- [ ] Tests: one per mutation site asserting `revisionOf` increments (duck-typed meshes with `metadata.meshId`); refinement result arriving after a bump is discarded. FAIL → implement → PASS; full `npm test`; `test:repair`, `test:group` green. Commit `feat(geometry): revisions bump on every mutation`.

### Task 6: Boolean worker

**Files:** Create `src/core/workers/Boolean.worker.js`, `src/core/geometry/weld.js` (pure: `weldByPosition(positions, indices) -> { positions, indices }`), `src/core/BooleanWorker.js` (`runBooleanInWorker(op, operands:[{positions,indices}], { signal }) -> Promise<{positions, indices}>`). Modify `src/core/BooleanService.js` (`computeBooleanAsync(op, meshes, opts)`: worker path, fallback to `computeBoolean`), `src/core/commands/BooleanCommands.js` (await async path, pass `caps.booleanTriangleCap` when worker available else default), `src/core/storage/capabilities.js` (`booleanTriangleCap`), `src/core/assets/AssetRestore.js` (`registerBakedResult` accepts `{ positions, indices, normals }` directly). Tests: `tests/weld.test.mjs` additions or `tests/boolean-weld.test.mjs`, `boolean-service` additions, `hygiene` stays green.

- [ ] Tests: weldByPosition merges duplicate positions and remaps indices; capabilities give 250k web / 1M desktop; performBoolean uses worker cap when Worker exists and 50k when not; worker failure falls back to CSG2. FAIL → implement → PASS. `npm run test:browser` (cube union smoke) green. Commit `feat(boolean): run Booleans in a Manifold worker`.

### Task 7: Lean STL encoder + worker encode

**Files:** Modify `src/core/print/StlWriter.js`; create `src/core/workers/StlEncode.worker.js`; tests `tests/export.test.mjs` byte-equality addition.

**Produces:** `encodeBinarySTLFromArrays(parts: [{positions, indices, flip?}]) -> Uint8Array` (pure); `encodeBinarySTL` delegates to it after reading meshes; `STL_WORKER_TRIANGLES = 200_000`.

- [ ] Test: new encoder output byte-equal to the previous implementation on a fixture (keep old algorithm as test oracle inside the test). FAIL → implement → PASS; `npm run test:export` green. Commit `perf(export): STL encoder without per-facet objects`.

### Task 8: Chunked desktop save

**Files:** Modify `electron/main.cjs`, `electron/preload.cjs`, `electron/OpaqueFileRegistry.cjs` (begin/append/commit/abort on a temp file), `src/core/storage/DesktopStorageAdapter.js`; tests `tests/storage-adapter.test.mjs`, `tests/electron-security.test.mjs` (new channels allow-listed / shape), new `tests/chunked-save.test.mjs` for the registry.

- [ ] Tests: registry begin → append ×N → commit writes the concatenation atomically; abort removes temp, target untouched; exceeding 1 GiB rejects and cleans up; adapter streams when blob > 64 MiB (chunk sizes ≤ 16 MiB) and uses one-shot below. FAIL → implement → PASS; `npm run test:electron` green. Commit `feat(desktop): chunked export save`.

### Task 9: Docs and full verification

- [ ] Update `HANDOFF.md`, `Blueprint.md`/ADR note for workers (short). Run `npm test`, `lint`, `typecheck`, `test:browser`, `test:export`, `test:repair`, `test:group`, `test:ui-style`, `test:electron`, `build`. Commit `docs: workers and memory foundation`.
