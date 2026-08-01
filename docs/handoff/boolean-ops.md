# HANDOFF — Interactive Boolean (pre-slice kitbash combine)

Durable resume tracker for the interactive Boolean feature. Read first on resume.
Branch: `feat/boolean-ops` (off `master`).

## Goal

Give MIXOMESH the defining pre-slice **kitbash "combine" verb**: interactive Boolean
**union / subtract / intersect** on selected objects, so arranged kit parts become one
printable solid (or cut sockets). Positioning: NOT competing with Meshmixer/Blender —
a pre-slice kitbash tool. This is the single highest-leverage feature (moves the tool
from "arranges parts" to "kitbashes").

## Hard constraints (from AGENTS.md — non-negotiable)

- Reversible ⇒ a **Command** pushed to HistoryManager (undo/redo).
- All state mutation via `StateManager.dispatch`; inter-module via typed events.
- **One-mesh-one-shader invariant** — the result must respect it (multi-material result
  → split into single-material siblings, `sourceGroupId`).
- **Babylon-first** — use Babylon CSG2 (Manifold) that already backs the export re-bake.
- **BLUEPRINT.md update in the same turn** as the feature (new module/seam/event/schema).
- Color moat: textures/UVs must survive the boolean for Mimaki color export.

## 4 design axes (the debate must resolve)

1. **Engine/threading** — reuse the export CSG2/Manifold path (extract a shared
   BooleanService) vs new; Worker (like ValidateWorker) vs main-thread; size-gating.
2. **Texture/UV/multi-material preservation** through the boolean (the color moat).
3. **Data model** — destructive bake (new mesh/asset, fits ratio/autofix bake model) vs
   non-destructive modifier; undo + logical-objects + `.mixo` round-trip (recompute on
   reload vs embed the baked result).
4. **UX/gating** — invocation (select 2+ → context menu Union/Subtract/Intersect; base =
   active for subtract), progress, failure on non-manifold inputs, web size cap.

## Progress log

- [x] Branch + handoff scaffold.
- [x] Debate panel dispatched (3 haiku agents: engine/threading, data-model/undo/persist, texture+UX).
- [x] ADR 0002 skeleton written (`docs/adr/0002-interactive-boolean.md`) — 4 axes + known prior
      (export SKIPS CSG2 for textured meshes ⇒ CSG2 loses UVs = the crux). Decisions `[TO FILL]`.
- [x] Synthesis → ADR 0002 FINAL (f0ab058): solid-colour destructive Boolean, synthetic
      embedded asset, main-thread, gated. 4-slice plan in the ADR.
- [x] **Slice 1 DONE:** `src/core/BooleanService.js` — `evaluateBooleanEligibility` (pure gating:
      needs-two / multi-part / too-large / needs-texture-bake / ready) + `DEFAULT_BOOLEAN_TRIANGLE_CAP`
      (50k); `tests/boolean-service.test.mjs` (8 asserts). BLUEPRINT §Boolean + module registry updated.
- [ ] **Slice 2 (NEXT):** CSG2 compute wrapper in BooleanService (main-thread, reuse
      `PrintPipeline._ensureCSG2` init pattern: `CSG2.FromMesh → op → toMesh → VertexData.ExtractFromMesh`)
      + `BooleanCommand` (execute/undo, SmartReplace soft-delete of operands) + synthetic embedded asset
      (serialise result → bytes → register asset so it round-trips). Browser smoke: union two solid cubes
      → one watertight mesh, survives `.mixo` reload.
- [ ] **Slice 3:** ContextMenu Union/Subtract/Intersect + modals (texture bake-or-cancel,
      non-manifold→validator) + i18n (en/ja/zh-Hant).
- [ ] **Slice 4:** end-to-end browser smoke (real CSG2, all 3 ops; textured→gated).

## RESUME POINTER

**Current:** Slice 1 (pure gating) DONE + green + committed. **Next = Slice 2** (see checklist):
add the CSG2 compute wrapper to `BooleanService.js` reusing the `PrintPipeline._ensureCSG2` init
pattern, then `BooleanCommand` + the synthetic-embedded-asset persistence path, guarded by a browser
smoke (union two solid cubes → watertight → survives reload). Read ADR 0002 §Decision + §Implementation
plan for the exact shape. Keep the suite green; commit per slice. Do NOT attempt textured Booleans
(gated by design) or a worker (deferred).

## Code map (where the panel should look)

CSG2/export re-bake: `src/core/print/PrintPipeline.js`, `PrintPrep.js` (CSG usage).
Worker pattern: `src/core/ValidateWorker.js`, `WorkerImport.js`. Commands/undo:
`src/core/HistoryManager.js`, `src/core/commands/*`. Logical objects + split:
`src/core/LogicalObjects.js`, `src/core/assets/MeshSplit.js`. Persistence/round-trip:
`src/core/PersistenceManager.js`. Shaders/UV: `src/core/ShaderLibrary.js`. Context menu:
`src/ui/ContextMenu.js`.

## Verify: typecheck · npm test · build · test:browser · test:export
