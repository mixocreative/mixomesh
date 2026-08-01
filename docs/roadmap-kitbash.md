# MIXOMESH roadmap — pre-slice kitbash + desktop (sequenced)

Master sequence for the queued work. Solo dev, all on `master`. Each slice = green
(typecheck · npm test · build · smoke) + committed + handoff updated before the next.
Resume trackers: `docs/handoff/boolean-ops.md`, `HANDOFF.md` (storage). ADRs are canonical.

## Sequencing rationale

1. **Phase A — Interactive Boolean** first: the single defining kitbash verb (arranges → kitbashes).
   Highest user value, engine already proven (export CSG2). Deps satisfied (base64 worker on master).
2. **Phase B — Placement precision** next: makes assembly *accurate* (mate/align/mirror/array).
   Complements Boolean (place, then combine). User-facing, medium effort.
3. **Phase C — Storage adapter → Windows Electron** last: packaging/infra. Benefits from a stable
   feature set; independent of A/B so it can interleave if desired. ADR 0001.

Order = value-first (A, B are user-facing wins; C is delivery). No hard cross-deps A→B→C.

---

## Phase A — Interactive Boolean (ADR 0002)  ▸ IN PROGRESS

- **A1 ✅ Slice 1** — `BooleanService.evaluateBooleanEligibility` pure gating + tests. DONE.
- **A2 — Slice 2 (NEXT):** BooleanService CSG2 compute wrapper (main-thread, reuse
  `PrintPipeline._ensureCSG2`: `CSG2.FromMesh → op → toMesh → VertexData.ExtractFromMesh`) +
  `BooleanCommand` (execute/undo, SmartReplace soft-delete of operands) + **synthetic embedded
  asset** (serialise result → bytes → register so it round-trips). Browser smoke: union two solid
  cubes → one watertight mesh → survives `.mixo` reload. *Open Q resolved by the Slice-2 debate:
  exact serialise-to-asset path.*
- **A3 — Slice 3:** ContextMenu Union/Subtract/Intersect (subtract base = active) + modals
  (texture bake-or-cancel, non-manifold → validator) + progress toast + i18n (en/ja/zh-Hant).
- **A4 — Slice 4:** end-to-end browser smoke (real CSG2, all 3 ops; textured → gated); BLUEPRINT close.

## Phase B — Placement precision (kitbash assembly)  ▸ NOT STARTED (needs its own ADR 0003)

- **B1 — Face-to-face snap / mate:** pick a face on A, a face on B → align B's face to A's (normal
  anti-parallel, coincident). The #1 assembly gap. Reuse gizmo/pivot + picking.
- **B2 — Align-to-object:** min/max/center align on an axis across a selection (like Blender align).
- **B3 — Mirror:** mirror a part across a world/cursor/active plane (undoable; watch winding/normals).
- **B4 — Array / pattern:** linear + radial duplicate-with-count (bolts, teeth). Builds on Duplicate.

Each = a Command (undo), typed events, BLUEPRINT update. ADR 0003 to lock the mate math + UX first.

## Phase C — Storage adapter → Windows Electron (ADR 0001)  ▸ Phase 1a DONE

- **C1 — Phase 1b:** `src/core/storage/StorageAdapter.js` domain interface + `BrowserStorageAdapter`
  delegating to today's code (opaque ref = handle); boot `storage` singleton; route the LEAF call
  sites (idb, persist/*, DirMounts, TextureAssets, Download, PersistenceManager doc I/O).
- **C2 — Phase 1c:** refactor LEAKED modules (AssetImport, ObjSiblings, AssetPanel scan, ViewportDrop).
- **C3 — Phase 2:** Windows Electron shell + `DesktopStorageAdapter` (IPC → Node fs); inject caps.
- **C4 — Phase 3:** electron-builder (NSIS) installer, security hardening, optional auto-update.

---

## Global rules (AGENTS.md)

Reversible ⇒ Command on HistoryManager. State via dispatch; typed events. One-mesh-one-shader.
Babylon-first. BLUEPRINT update in the SAME turn as any new module/seam/event/schema.
Verify green before each commit. macOS deferred until Web+Windows are production-level.

## Progress

- [x] Master sequence plan (this file).
- [x] **A2 — Interactive Boolean COMPLETE** (union/subtract/intersect). 2-agent design debate +
      a 3rd integration-recipe agent → `computeBoolean` (CSG2) + `GeometryCodec` (`.mxvd`) +
      `BooleanCommand`/`performBoolean` + synthetic `.mxvd` asset + restore branch + CSG2 in boot.ts
      + ContextMenu UI + i18n. Browser-smoke round-trip verified. (Polish: textured bake modal → handoff.)
- [x] **B: ADR 0003** (2-agent debate) + **B-align slice 1** — `placement/AlignMath` pure deltas,
      tested. (Remainder: AlignCommand + UI + mirror/mate/array → `docs/handoff/placement.md`.)
- [x] **C1 Phase 1b** — `StorageAdapter` interface + `BrowserStorageAdapter` + boot singleton,
      tested. (Remainder: route LEAF sites, then 1c/2/3 → `HANDOFF.md`.)
- [ ] Remainders above · A3/A4 · B-mirror/mate/array · C1c/C2/C3.

Each phase now has: plan (roadmap) · debate+audit (subagent panels) · a first tested implementation
· docs (ADR + BLUEPRINT + handoff) · green + committed. Remainders sequenced in the handoffs.
