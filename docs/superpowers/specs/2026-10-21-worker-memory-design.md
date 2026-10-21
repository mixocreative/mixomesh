# Workers & Memory Foundation — Design

Date: 2026-10-21 · Status: approved to build (owner: "plan all these enhancement carefully, and
implement, submit, push")

## Intent

MIXOMESH should move heavy geometry work off the main thread and stop multiplying copies of big
meshes, so large models (and the coming support generator and layer slicer) don't freeze the UI or
run out of memory. Today: five workers with three different patterns; geometry owned only by
Babylon with no revision; Booleans on the main thread capped at 50k triangles (the desktop cap is
never applied); exporters build whole files from per-facet JS objects; the desktop save copies the
entire file into one IPC buffer.

## Staged approach (each stage ships green on its own)

A full ownership flip (Babylon stops holding CPU geometry) touches ~40 read/mutate sites and the
.mixo restore path at once. It is **out of scope here**; this work builds the foundation it needs
and takes the wins available without it.

### Stage 1 — One worker job runner

`src/core/workers/WorkerTask.js` (name avoids `electron/JobRunner.cjs`). One small class every
worker client uses:

- Lazy worker creation from a factory; `mode: 'persistent'` (one worker, many jobs) or
  `'per-job'` (fresh worker, terminated when the job settles).
- `run(payload, { transfer, signal, timeoutMs, onProgress, revision })` → Promise.
  Correlates by job id; `progress` messages go to `onProgress`; `AbortSignal` rejects with
  `AbortError`; per-job timeout; `revision` echoed back must match (stale guard).
- `concurrency: 'parallel' | 'serial'` (ObjParse must stay one-at-a-time).
- Failure isolation: a timeout or crash on a persistent worker terminates and recreates it; the
  failing job rejects with its own reason, other in-flight jobs reject with a `restarted` reason
  (today's ObjParse behaviour, made uniform).
- Optional `fallback(payload)` run on the main thread when `Worker` is unavailable or creation
  throws (keeps Base64's byte-identical fallback).
- Worker side helper `serveTask(handler)` for the message protocol
  (`{id, type:'run'|'progress'|'done'|'error'}`).

Migrate Base64, MeshValidate, MixoRefine, ObjParse and OpfsWrite clients onto it, keeping their
public functions and existing tests' observable behaviour. OpfsWrite gains a timeout (today a hung
worker hangs the save).

### Stage 2 — Geometry store (revisions + single extraction)

`src/core/geometry/GeometryStore.js`:

- `revisionOf(meshId)` / `bump(meshId)`: a real per-mesh geometry revision, bumped by every
  in-place mutation site (transform bakes in ScaleCommands / AssetRestore ratio / ImportNormalizer,
  MeshRepair / Weld / RepairSession writes, mirror). Emits `EVENTS.GEOMETRY_CHANGED`.
- `extract(mesh, { space: 'local' | 'world', uvs })` → `{ positions: Float32Array,
  indices: Uint32Array, uvs?, revision }`: one owned copy, safe to transfer, world space applied
  in place on the copy. Replaces the ad-hoc copy-then-copy-again code in ValidateWorker and
  RefinementController (refinement copies its input twice today).
- Refinement and validation stale guards use the real revision.

No arrays are cached (a cache would add a copy, not remove one).

### Stage 3 — Booleans in a worker

`src/core/workers/Boolean.worker.js` runs raw manifold-3d (same vendored `manifold.js`/`.wasm`,
URL passed in from the main thread so Electron `file://` resolves): weld each operand by exact
position, build `Manifold`s, apply union/subtract/intersect in operand order, return
positions + indices (transferred). Main thread builds the Babylon mesh, normals, colour/material
exactly as today, and `registerBakedResult` takes the arrays directly (no `ExtractFromMesh`).

- Caps: new `caps.booleanTriangleCap` — web 250k, desktop 1M when the worker path is available;
  `DEFAULT_BOOLEAN_TRIANGLE_CAP` (50k) stays the inline-fallback cap. `performBoolean` passes the
  cap (fixes the never-applied desktop cap).
- Fallback: no Worker / worker failure → today's Babylon CSG2 path, unchanged, under the 50k cap.
- Slice connectors keep calling the main-thread `computeBoolean` (their cutters are Babylon
  builders and the session preview is synchronous) — a later stage.

### Stage 4 — Lean export + chunked desktop save

- STL binary encoder writes straight into one preallocated buffer (no per-facet objects);
  byte-identical output.
- STL encoding runs in a worker from extracted world arrays when the mesh is large
  (≥ 200k triangles); inline otherwise and in Node tests.
- Electron: new IPC `export:begin` → `export:chunk` (≤ 16 MiB each) → `export:commit` /
  `export:abort`, writing to the same temp-file-then-rename target as `writeAtomic`, same dialog,
  same size ceiling, renderer never sees a path (opaque handle). The desktop adapter streams a Blob
  in chunks via `blob.slice()` when it is larger than 64 MiB; smaller saves keep the one-shot IPC.

## Non-goals

- Babylon ownership flip / freeing Babylon's CPU vertex copies (needs the store to become the
  source of truth for restore, undo and export — next project).
- Support generator and layer slicer (they will be built on Stages 1–2).
- Moving meshfix repair or texture readback off-thread (DOM / classic-script bound).
- Streaming 3MF/zip output (JSZip builds whole archives).

## Constraints

- CSP unchanged (`script-src 'self' 'wasm-unsafe-eval' 'unsafe-eval'; worker-src 'self' blob:`).
- Electron security model unchanged: contextIsolation, sandbox, opaque file handles, 1 GiB cap.
- Every existing test suite stays green: `npm test`, `test:browser`, `test:export`, `test:repair`,
  `test:group`, `test:ui-style`, `test:electron`, lint, typecheck.
- Boolean results must match today's for the browser smoke's cube union (triangle count > 0,
  undo, `.mxvd` embed, reload keeps triangle count, textured-operand gating).

## Done when

- All five workers run through `WorkerTask`; runner unit tests cover progress, abort, timeout,
  crash, stale revision, serial ordering, fallback.
- Geometry revisions bump on every mutation site (tests per site) and refinement/validation use
  `extract`.
- A 100k-triangle Boolean completes on web without blocking the main thread (worker path), desktop
  cap applied; fallback path still passes the existing smoke.
- STL output byte-identical to before; large STL encodes in a worker.
- Desktop saves above 64 MiB stream in chunks; Electron smoke + security tests green.
