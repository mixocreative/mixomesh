# HANDOFF — Interactive Boolean (pre-slice kitbash combine)

Durable resume tracker for the interactive Boolean feature. Read first on resume.
Workflow: solo dev — all work on `master`, no feature branches (merged 2026-06-17).

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
- [x] **Slice 2 core done:** `BooleanService.computeBoolean` (CSG2 wrapper — union=`.add()`,
      `.subtract()`, `.intersect()`, API verified in csg2.d.ts; main-thread, init cached) +
      `src/core/GeometryCodec.js` (`.mxvd` encode/decode, 8 headless asserts). ADR 0002 §"Slice 2 design"
      + BLUEPRINT §Boolean + registry updated. Green: typecheck · 104 headless · build.
- [ ] **Slice 2 remainder (NEXT):** `src/core/commands/BooleanCommands.js` `BooleanCommand` —
      execute: build operand descriptors → `evaluateBooleanEligibility` → `computeBoolean` →
      `VertexData.ExtractFromMesh(result)` → `encodeGeometry` → register a synthetic embedded asset
      (`extension:'.mxvd'`, `sourceUnit:'meters'`, `modelRatio:1`; result SceneObject `ratio:1`) →
      soft-delete operands (SmartReplace pattern, snapshot for undo). undo: remove result + synthetic
      asset, restore operands. PLUS the restore branch: in `AssetRestore.restoreContainer` (or
      ProjectLoader), `extension==='.mxvd'` → `decodeGeometry` → build mesh → bind, SKIP
      `bakeImportTransform`. Browser smoke: union two solid cubes → one watertight mesh → survives reload.
      **Field invariant (both debate agents got this wrong): `modelRatio` MUST equal `ratio` (use 1,1) —
      delta=modelRatio/ratio must be 1.**
- [ ] **Slice 3:** ContextMenu Union/Subtract/Intersect + modals (texture bake-or-cancel,
      non-manifold→validator) + i18n (en/ja/zh-Hant).
- [ ] **Slice 4:** end-to-end browser smoke (real CSG2, all 3 ops; textured→gated).

## Slice 2 debate — captured audit (do NOT re-run)

**Persistence path (agent A audit):** `@babylonjs/serializers@9.6.2` IS bundled → GLB export
available. `loadFromBlob`/`AssetImport` is the only register-from-bytes entry; it runs
`bakeImportTransform` (unit factor + RH→LH flip) + seeds `ratio=modelRatio`. **Restore
(`AssetRestore.restoreContainer` + `ProjectLoader._applyPersistedRatioBake`) re-applies BOTH →
a world-space baked result would DOUBLE-transform.** Neutralise so both are no-ops: `sourceUnit`
with unit-factor 1 + `modelRatio == ratio` ⇒ importScaleFactor=1 AND delta=1. NOTE: agent A read
`sceneRatio` from `state.print.workingRatio` — that global was REMOVED in the per-object-ratio
redesign; correct neutralisation is CONSTANTS `sourceUnit='meters'` (factor 1), `modelRatio=1`,
`ratio=1` (agent B verifying). Open Q under interrogation: GLB round-trip (flip out==flip in?) vs
serialising RAW VertexData and restoring directly (bypass import). Risks: material/shader on the
result (solid-colour → assign default), contentHash for the embedded-only recovery tier.

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
