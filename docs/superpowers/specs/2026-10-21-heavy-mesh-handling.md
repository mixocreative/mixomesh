# Heavy-Mesh Handling — Design (shared spec)

Date: 2026-10-21 · Status: approved to build (owner: "optimise mixomesh for heavy print-ready
meshes (2M–10M+ triangles), and make sure ALL workers show on-screen loading/progress").
Input: `S:\ai\mixosupports\docs\migration\2026-10-21-mixomesh-perf-audit.md` (file:line
evidence), ADR 0006, `2026-10-21-worker-memory-design.md`.

**This is also the shared heavy-mesh spec mixosupports links to.** Sections 1–6 are the
cross-app contract (budgets pattern, tiers, pre-parse refusal, memory model, progress UX,
measurement). Section 7 is mixomesh's own implementation.

## 1. Budgets pattern

- A budget is a **scene-wide triangle count per runtime tier**, derived from measurement on the
  synthetic fixtures (§6), never by analogy.
- **Warn at 1× budget** (non-blocking toast; the import continues).
- **Refuse above 4× budget**, and refuse **before parsing** whenever the format lets us count or
  estimate cheaply (§3). A post-parse check stays as the backstop for formats that can only be
  estimated.
- HUD: 70 % = warn colour, 90 % = danger colour; hover picking turns off at 70 %.
- Message wording (one sentence, plain words, what to do next):
  `"<file>" has about N triangles; this <web|desktop> build handles up to M. Simplify or split the
  model, or use the desktop app.` (desktop omits the last clause).

## 2. Tiers

| Tier | Budget (warn) | Refuse above | Basis |
|---|---|---|---|
| Web (Chrome/Edge tab, Safari OPFS tier) | **2.5M** (was 1.5M) | 10M | §6: at 10M (4×) a tab peaks at ~1.8 GB renderer + ~1.1 GB GPU process; at the 2.5M warning line ~0.6 GB. A tab shares memory with everything else the user has open, so 4× stays the ceiling. |
| Desktop (Electron, V8 heap raised) | 6M (unchanged) | 24M | §6: ~160 MB renderer + ~70 MB GPU per million triangles → ~4 GB + ~2.2 GB extrapolated at 24M; the renderer gets `--max-old-space-size=4096`; the 1 GB file cap stops binary STL at ~21M anyway. Not measured inside Electron (same Chromium). |

Budgets are constants in one module (mixomesh: `src/core/storage/capabilities.js`), keyed off the
runtime tier, not reported by the shell. If a measurement on the reference machine changes the
picture, change the constant **and** the table in §6 in the same commit.

## 3. Pre-parse estimate and refusal

`estimateTriangles(head, size, ext)` is a pure function of the file size and a small head slice
(≤ 1 MiB), so it runs before any parse and before the bytes are hashed or copied:

| Format | Estimate | Exact? |
|---|---|---|
| Binary STL | `(size − 84) / 50`, cross-checked with the header count | exact |
| ASCII STL | `size / avgFacetBytes`, `avgFacetBytes` measured on the head slice (count of `endfacet`) | ±5 % |
| OBJ | face lines in the head slice × (size / headBytes); quads/n-gons count as n−2 | ± sampling error |
| 3MF | uncompressed size of the model part from the zip central directory ÷ bytes per triangle measured on the head of the decompressed part | ± sampling error |
| GLB / glTF | sum of `indices` accessor counts / 3 (or position count / 3 when unindexed) for TRIANGLES primitives, from the JSON chunk | exact (per mesh, before instancing) |

Rules: refuse only on **exact** counts (binary STL; glTF counted per referencing node, no GPU
instancing) or on sampled estimates far above the limit (`> 4× budget × 2`: ASCII STL, OBJ). 3MF
and GPU-instanced glTF estimates are **warn-only** (bytes per triangle vary with per-triangle
attributes; instancing multiplies at load). Warn on any estimate above budget. Unknown → no
pre-parse decision; the parse-time check decides.

## 4. Memory model

- **One CPU copy per mesh** in the viewer's own format (mixomesh: Babylon's vertex buffers;
  mixosupports: the immutable `TriangleMesh`). Workers get a transferred **extracted copy** per
  job and keep nothing after the job.
- **Welded, indexed geometry**, `Uint32Array` indices. STL welds by exact float bits with a
  typed-array open-addressing hash — no strings, no per-vertex objects. Vertices are split again
  only at creases (> 40° between face normals; degenerate faces never seed a split group); a smooth
  scan stays at ~T/2 vertices (~18–24 B/triangle on the CPU instead of 84).
- **Look is unchanged (decision, review I1):** welded STL still renders **faceted** by default — a
  material plugin replaces the fragment normal with the screen-space face normal
  (`cross(dFdx(p), dFdy(p))`, oriented like the interpolated normal) for meshes flagged
  `flatShading` (STL imports and Boolean results). A per-user **Smooth shading** view toggle (off by
  default, persisted per user, translated; not stored in projects and not overridden by them) shows
  the stored smooth/crease normals instead. Picking, Place Face on Bed (geometric face normal) and
  exports are independent of the toggle; OBJ export writes no `vn` for faceted meshes (mesh flag).
- **Parsing never runs on the UI thread** for STL / 3MF: the worker reads the `Blob` itself (a Blob
  crosses `postMessage` by reference, no copy) and transfers typed arrays back.
- **3MF model XML is streamed** (inflate → `TextDecoder` stream → SAX) so a 10M-triangle model
  never becomes one JS string (V8 limit ≈ 2^29 characters).
- **History never pins a big mesh forever:** a deleted / replaced mesh held for undo is disposed
  when its command leaves the undo window (stack limit, redo-branch cleared, or the retained
  triangle total going over the tier budget, which trims the oldest entries first).
- **Picking does not build per-vertex objects:** heavy meshes (≥ 200k triangles) pick through a
  flat typed-array BVH built in a worker; until it is ready the engine default is used.
- Desktop: the renderer's V8 old space is raised to 4 GiB (the pointer-compression cage limit), so
  large on-heap structures fail later; typed arrays are off-heap regardless.

## 5. Progress UX (every worker job, both apps)

NN/g response-time limits, applied to **every** worker job, in **one place** (a status-bar
activity area listing all running jobs — never stacked overlays):

1. **< ~400 ms: show nothing.** A job only appears after a 400 ms delay so fast jobs never flash
   a loader; once shown it stays at least ~500 ms.
2. **0.4–10 s: indeterminate indicator** with a plain label of what is running
   ("Loading model…", "Checking mesh…", "Building pick index…").
3. **> 10 s or whenever the job reports progress: determinate bar with %**, a staged label
   ("Reading file → Welding → Uploading to GPU"), and **Cancel** when the job is cancellable.
   Time remaining only when the estimate is stable (rate known for ≥ 3 s, ≥ 10 % done).
4. **Non-blocking:** the viewport stays usable. A blocking overlay only when the job changes the
   model the user would be editing (import into the scene, project open), and then with Cancel.
5. **Failures and timeouts are never silent:** a plain-words message with what to do next
   ("Import timed out. Try again, or simplify the model."). **Cancel returns to the prior state**
   (nothing half-added).
6. **Accessible:** `aria-live="polite"` status region; each bar `role="progressbar"` with
   `aria-valuenow` (omitted when indeterminate); the indeterminate animation respects
   `prefers-reduced-motion`.
7. Style (mixo-app-style): `.progress-track` / `.progress-fill`, **red only for the fill**, ink
   text, hairlines, 2 px radius, no shadow.

Contract for job runners: every job carries a human **label**; workers report
`progress({ fraction?, loaded?, total?, stage? })`; the runner forwards begin / progress / end /
error to one activity registry the UI subscribes to. A test enumerates every job runner and
fails when one has no label or its worker never reports progress.

## 6. Measurement

Fixtures: `scripts/heavy-mesh/generate.mjs` — closed "pillow" (wavy top + flat bottom sharing the
rim; watertight, welds to ~T/2 vertices): 2M / 5M / 10M binary STL, 0.5M ASCII STL, 10M 3MF.
Never committed (`.tmp/heavy-mesh`, or `$HEAVY_MESH_DIR`).
Harness: `scripts/heavy-mesh/measure.mjs` — Vite + headless Chrome on the real GPU (ANGLE D3D11),
imports through the app's own `loadFromBlob`, samples renderer and GPU process private bytes every
100 ms. Reference machine: Windows 11, 64 GB RAM, RTX 3090 (24 GB), Chrome stable.

Columns: import wall time; longest main-thread block (long task) during import; peak renderer
private MB (page + its workers); peak GPU process MB; JS heap after; first pick (cold) and second
pick (warm) at the canvas centre; mean frame interval while orbiting; renderer MB after delete +
history trim.

### Before (master `6bcfc75`, budget overridden to unlimited)

Idle page: renderer ≈ 160–200 MB, GPU process ≈ 500 MB.

| Fixture | Import ms | Max block ms | Peak renderer MB | Peak GPU MB | Heap MB | Pick cold / warm ms | Orbit frame ms | After delete MB |
|---|---|---|---|---|---|---|---|---|
| 0.5M ASCII STL (99 MiB) | 897 | 681 | 715 | 568 | 534 | 102 / 13 | 17 | 546 |
| 2M binary STL (95 MiB) | 892 | 695 | 926 | 1074 | 702 | 383 / 45 | 16 | 1429 |
| 5M binary STL (238 MiB) | 2220 | 1767 | 1913 | 1591 | 1684 | 1030 / 82 | 17 | 2800 |
| 10M binary STL (477 MiB) | 3904 | 3019 | 3583 | 2446 | 3294 | 4645 / 186 | 16 | 5204 |
| 10M 3MF (109 MiB) | fails: `Invalid string length` after 3581 ms | 65 | 1175 | 528 | 878 | — | — | — |
| 10M STL, default web budget | refused **after** parse (1343 ms) | 561 | 1458 | 1508 | 1337 | — | — | — |

Reading: the UI is frozen for ~75 % of the import; the first pick builds Babylon's per-vertex
`Vector3` array (the heap jump: 3.3 GB at 10M) and takes 4.6 s; delete frees nothing (memory
*grows* because the soft-deleted mesh plus the pick arrays stay alive); 10M 3MF cannot load.

### After (branch `feat/heavy-mesh`, budget overridden to unlimited)

Same machine and harness. "Pick cold" is the first pick while the pick index is still building
(allocation-free scan); "warm" is after the index is ready (built in a worker: 0.8 s at 0.5M,
1.0 s at 2M, 3.1 s at 5M, 6.7 s at 10M). "After delete" includes the asset's cached source Blob
(kept for Add another copy; ~477 MB for the 10M STL in this harness, where the file is fetched into
memory rather than dropped from disk).

| Fixture | Import ms | Max block ms | Peak renderer MB | Peak GPU MB | Heap MB | Pick cold / warm ms | Orbit frame ms | After delete MB |
|---|---|---|---|---|---|---|---|---|
| 0.5M ASCII STL (99 MiB) | 1011 | 51 | 571 | 477 | 95 | 7 / 1 | 17 | 325 |
| 2M binary STL (95 MiB) | 1018 | 156 | 601 | 581 | 171 | 23 / 1 | 17 | 462 |
| 5M binary STL (238 MiB) | 2470 | 359 | 1101 | 763 | 352 | 53 / 1 | 17 | 577 |
| 10M binary STL (477 MiB) | 4316–4612 | 626–664 | 1773–1804 | 1126–1129 | 621–630 | ~100 / 1 | 17 | 949–985 |
| 10M 3MF (109 MiB) | 18270 (loads) | 1099 | 1455 | 1152 | 1257 | 88 / 1 | 17 | 774 |
| over 4× budget (10M STL vs the old 1.5M web budget) | refused **before** parse in 14 ms | 0 | 168 | 398 | 62 | — | — | — |

Headline (10M binary STL): longest UI freeze 3019 → ~640 ms; peak renderer 3583 → ~1790 MB; peak
GPU process 2446 → ~1130 MB; first pick 4645 → ~100 ms, later picks 186 → 1 ms; memory after
delete 5204 → ~970 MB; 10M 3MF fails → loads. Import wall time is unchanged (~4 s: the parse moved
to a worker, the UI stays live with progress and Cancel).

Remaining main-thread work (CPU profile of the 10M STL import): GPU buffer upload (~95 ms), shader
compile, bounding info (~30 ms), the import unit/flip bake (`bakeTransformIntoVertices`), and GC
of the transferred arrays (~300 ms). 3MF additionally builds its container on the main thread
(~1.1 s: vertex transform, grouping, `ComputeNormals`) and its SAX pass in the worker is slow
(~17 s for 0.7 GB of XML).

Rendering experiment (task f): CPU time from `onBeforeRender` to `onAfterRender` for the 10M scene
is 0.5 ms median / 0.7 ms p90, and 0.5 / 0.6 ms after `freezeWorldMatrix()` +
`doNotSyncBoundingInfo` + `material.freeze()` — no measurable gain; shadows already render once
per change (`REFRESHRATE_RENDERONCE`). Orbit frame time is vsync-bound (16–17 ms) before and after
on the reference GPU.

## 7. mixomesh implementation

1. **Fixtures + harness** (§6).
2. **Pre-parse estimate + refusal** — `src/core/import/TriangleEstimate.js` (pure), called from
   `loadFromBlob` / `importWithDedupe` before hashing; budgets confirmed or replaced from §6.
3. **Import off the main thread** — `src/core/workers/MeshImport.worker.js` + pure cores
   `src/core/import/stlParse.js` (binary + ASCII, weld, crease normals) and streaming 3MF
   geometry parse (`ThreeMFXml.js` accepts chunk streams; Int32 triangle buffers).
   `loadContainer` routes `.stl` / `.3mf` to the worker; the SceneLoader plugins stay as the
   no-Worker fallback (Node tests). OBJ: no main-thread fallback after a worker timeout for files
   above 32 MiB. glTF/GLB stays on Babylon's loader (already binary, indexed and async; textures
   and extensions need the scene) — it gets the exact pre-parse count instead.
4. **Progress UX** — `src/core/workers/JobActivity.js` (registry, pure) fed by `WorkerTask`
   (`label`, `cancellable`), `src/ui/JobActivity.js` (status-bar activity area). Every
   `new WorkerTask` has a label; every worker reports progress.
5. **Picking** — `src/core/geometry/triangleBvh.js` (pure build + raycast), built in
   `workers/TriangleBvh.worker.js`, installed per heavy mesh by `src/core/scene/HeavyPick.js` as an
   instance `intersects` override (all `scene.pick` callers benefit, Babylon's per-vertex
   `Vector3` array is never built). Babylon's implicit pointer-down/up/move picks are skipped
   (nothing reads `pointerInfo.pickInfo`); the context menu picks once.
6. **Rendering** — measured first (§6): freezing world matrices / bounding sync / materials gives
   no measurable CPU gain for heavy meshes (render CPU is ~0.5 ms/frame at 10M) and would add a
   stale-transform risk (pivot parenting, commands that move unselected objects), so **no freeze
   is applied**. Display decimation: **not in this pass** (edits/export must always use the full
   mesh, and a proxy needs a second GPU copy plus selection/outline/shader plumbing). Next step if
   weaker GPUs show orbit stalls: a decimated proxy only while the camera moves.
7. **Memory** — history release on trim (`retainedTriangles()` / `release()` on Delete and Boolean
   commands; Duplicate clones share geometry so they hold nothing extra), retained-triangle cap =
   tier budget, `MeshRegistry.releaseMesh` keeps container slots stable, `GeometryStore.extract`
   with `slice()` and no per-element callback, big import blobs hashed in a worker, Electron
   `--max-old-space-size=4096`.

## Non-goals

- Babylon ownership flip (ADR 0006 "Not now").
- glTF parse in a worker (Babylon's loader needs the scene for materials, textures, extensions).
- Decimated display proxy (deferred; recorded in the lane report).
- World-matrix / material freezing (measured: no gain, see §6).
- Streaming 3MF/zip **output**.
