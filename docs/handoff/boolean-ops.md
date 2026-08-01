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
- [ ] Debate panel dispatched (3 agents: engine, data-model, texture+UX).
- [ ] Synthesis → ADR 0002.
- [ ] Implement first slice (per ADR).
- [ ] BLUEPRINT + docs updated.
- [ ] Tests green, committed.

## RESUME POINTER

**Current:** dispatching the 3-agent debate panel (each audits the relevant code + argues a
lens). **Next:** synthesize their positions into `docs/adr/0002-interactive-boolean.md`,
then implement the first slice, update BLUEPRINT.md, test, commit. If the debate outputs are
lost, re-dispatch using the 4 axes above + the code map below.

## Code map (where the panel should look)

CSG2/export re-bake: `src/core/print/PrintPipeline.js`, `PrintPrep.js` (CSG usage).
Worker pattern: `src/core/ValidateWorker.js`, `WorkerImport.js`. Commands/undo:
`src/core/HistoryManager.js`, `src/core/commands/*`. Logical objects + split:
`src/core/LogicalObjects.js`, `src/core/assets/MeshSplit.js`. Persistence/round-trip:
`src/core/PersistenceManager.js`. Shaders/UV: `src/core/ShaderLibrary.js`. Context menu:
`src/ui/ContextMenu.js`.

## Verify: typecheck · npm test · build · test:browser · test:export
