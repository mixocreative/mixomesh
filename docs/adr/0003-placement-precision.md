# ADR 0003 — Placement precision (kitbash assembly verbs)

Status: **Accepted (planning)** · Date: 2026-06-17 · Roadmap: `docs/roadmap-kitbash.md` Phase B.
Synthesised from a 2-agent debate panel (mate+align · mirror+array).

## Context

A pre-slice kitbash tool must place parts *accurately*, not just eyeball them. Four verbs:
**align, mirror, mate (face-snap), array**. All are reversible ⇒ Commands on HistoryManager;
must expand multi-part logical objects (`logicalObjectCommandIds`) and hold one-mesh-one-shader.

## Sequencing decision (adjudicated)

Agent B1 recommended **align first** (pure AABB math, no picking, fully headless-testable);
agent B2 recommended **mirror first** (reuse ImportNormalizer's flip). **Align wins the first
slot** — it is the only verb with NO winding/geometry-mutation/picking traps: pure positional
math, deterministic, headless-testable, ships as a plain menu command. Order:

1. **Align** (pure position deltas) — first.
2. **Mirror** (vertex-bake reflection + `flipFaces` winding correction + `makeGeometryUnique`).
3. **Mate** (face-to-face snap — pick two faces → rotate `-nB` onto `nA` + coincident centres).
4. **Array** (linear/radial N-clones in ONE atomic command).

## Per-verb design (from the panel)

- **Align** — per selected mesh, world-AABB extent on a chosen axis; target = selection's
  `min` / `center` / `max`; delta = `target − mesh_extent`, applied on that axis only.
  `AlignCommand` snapshots prev transforms, applies via `applyTransforms`. Pure math in
  `src/core/placement/AlignMath.js` (`computeAlignDeltas`).
- **Mirror** — reflect across a world/cursor/active plane as a **vertex bake** (NOT node negative
  scale — that decomposes ugly, ImportNormalizer:49). `bakeTransformIntoVertices(reflection)` +
  `flipFaces(false)` when `determinant < 0` (copy ImportNormalizer:100 verbatim) + `makeGeometryUnique()`
  first (block source aliasing). Expand `logicalObjectCommandIds`. Verify export winding.
- **Mate** — `scene.pick` two faces → `getFacetNormal`/`getFacetPosition` → `Quaternion.FromToRef(nB, -nA)`
  + translate centres coincident. Snap at pick-time (faceId unstable across re-index). `MateFaceCommand`.
- **Array** — precompute N world transforms (linear: `origin+step*i`; radial: rotate about axis),
  clone via `cloneMeshAsNewObject` + `makeGeometryUnique`, register ALL N BEFORE mutating (avoid
  partial-orphan on failure), ONE `HistoryManager.push` so undo reverses the whole array.

## Shared risks (interrogation)

- **Winding** (mirror/array-with-reflection): forgetting `flipFaces` on negative determinant leaves
  inverted geometry — ImportNormalizer:100 is the only precedent; replicate exactly + export-verify.
- **Geometry aliasing:** `makeGeometryUnique()` mandatory before any vertex bake (AssetRestore:140).
- **Logical-object partial application:** always expand via `logicalObjectCommandIds` so all parts move.
- **Pivot mid-flight:** detach (`withDetachedPivot`) before snapshotting absolute transforms.

## First slice (this operation — kept green + testable)

`src/core/placement/AlignMath.js` `computeAlignDeltas(items, mode)` — pure, headless-tested.
`AlignCommand` (reads live world AABBs, applies deltas) + UI + the other three verbs = next
(roadmap Phase B). Mirror is slice 2 of Phase B.
