# ADR 0006 — Workers and memory foundation

Status: **Accepted (implemented)** · Date: 2026-10-21 · Spec:
`docs/superpowers/specs/2026-10-21-worker-memory-design.md` · Plan:
`docs/superpowers/plans/2026-10-21-worker-memory.md`.

## Context

Heavy geometry work (Booleans, big exports, and the coming support generator and
layer slicer) must not freeze the UI or multiply copies of large meshes. Before
this change: five workers with three different protocols, no geometry revision,
Booleans on the main thread capped at 50k triangles (the desktop cap was never
applied), STL built from one JS array per facet, desktop saves copied the whole
file into one IPC buffer.

## Decisions

1. **One worker job runner.** `src/core/workers/WorkerTask.js` (client) +
   `serveTask.js` (worker side) own the protocol: `{id, type:'run', payload,
   revision?}` → `progress` / `done {result, revision?}` / `error {message}`.
   Persistent or per-job workers, parallel or serial jobs, per-job timeout,
   AbortSignal, stale-revision guard, optional main-thread fallback. A failure
   on a persistent worker restarts it; other jobs reject `restarted`. Every
   worker (Base64, MeshValidate, MixoRefine, ObjParse, OpfsWrite, Boolean,
   StlEncode) uses it. New workers MUST use it.
2. **Geometry revisions.** `src/core/geometry/GeometryStore.js`: `bump(mesh)` on
   every in-place mutation (transform bakes, repair, weld, mirror, flip),
   `revisionOf`, `GEOMETRY_CHANGED`, and `extract(mesh, {space, uvs})` — the one
   way to copy geometry out of Babylon (fresh, transferable, optional world
   space). Export clones are `__geometryDetached` so prep edits never bump the
   live mesh. Babylon still owns vertex data (see Not now).
3. **Booleans in a Manifold worker.** `src/core/geometry/booleanCore.js` mirrors
   Babylon CSG2 exactly (winding reversal, normal properties, centred result);
   `computeBooleanAsync` runs it in `workers/Boolean.worker.js`, falling back to
   inline CSG2 only for jobs within the 50k main-thread cap.
   `caps.booleanTriangleCap`: 250k web, 1M desktop on the worker path.
4. **Lean export.** STL encodes straight into one buffer (`print/stlEncode.js`,
   byte-identical); 200k+ triangles encode in `workers/StlEncode.worker.js`.
5. **Chunked desktop save.** `export:beginSave` / `writeChunk` / `commitSave` /
   `abortSave`: same whitelisted dialog, opaque sender-bound session id, temp
   file renamed on commit, 1 GiB ceiling. The desktop adapter streams Blobs of
   64 MiB+ in 16 MiB slices.

## Rules for new heavy work (support generator, slicer)

- Run it through `WorkerTask`; pass geometry from `GeometryStore.extract`
  (transfer it, never the live Babylon arrays). Record `revisionOf(mesh)` before
  the job and compare it after the await; drop the result if it changed (the
  runner's `revision` option is only a request/reply echo check).
- Keep the worker's pure core in a module with no `window`/Babylon imports so
  it runs in a worker and under Node tests.
- Stream large outputs (layer by layer) instead of building whole files.

## Heavy-mesh follow-up (2026-10-21)

Spec: `docs/superpowers/specs/2026-10-21-heavy-mesh-handling.md`. Additions to the rules above:

- Every `WorkerTask` passes a translated `label` (`job.*`) and every worker reports `progress`;
  `WorkerTask` feeds the shared `JobActivity` registry, rendered by one non-blocking panel. Jobs
  run with a `signal` or `cancellable: true` get a Cancel (AbortError, worker restarted).
- STL / 3MF parse and weld in `MeshImport.worker.js`; big source blobs are hashed in
  `Hash.worker.js`; heavy meshes get a pick BVH from `TriangleBvh.worker.js`. A failed worker job is
  never retried on the main thread for files over 32 MiB, on timeout, on Cancel or on a refusal.
- History entries release the meshes only they hold (`retainedTriangles` / `release`), capped at
  the tier budget — deleted objects no longer stay alive until New/Open.

## Not now

- Babylon ownership flip (the store becoming the source of truth for restore,
  undo and export, freeing Babylon's CPU copies) — next project.
- meshfix repair and texture readback off-thread (classic-script / DOM bound).
- Streaming 3MF/zip output (JSZip builds whole archives).
