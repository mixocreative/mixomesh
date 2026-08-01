# ADR 0002 — Interactive Boolean (pre-slice kitbash combine)

Status: **Accepted (planning)** · Date: 2026-06-17 · Companion resume tracker:
`docs/handoff/boolean-ops.md`. Synthesised from a 3-agent debate panel
(engine/threading · data-model · texture/UX).

## Context

MIXOMESH is a **pre-slice kitbash** tool (not a mesh editor — we do NOT compete with
Meshmixer/Blender). Its gap to being a complete kitbash tool is the defining "combine"
verb: interactive **Boolean union / subtract / intersect** on selected parts, turning
arranged kit pieces into one printable solid (or cutting sockets). This is the single
highest-leverage feature. The Boolean engine (Babylon CSG2 / Manifold) already ships in
the export re-bake path — so this reuses proven, in-browser tech (runs on web AND
Electron; compute is identical, only memory headroom differs — ADR 0001).

## Hard constraints (AGENTS.md)

- Reversible ⇒ a **Command** on HistoryManager. State via `dispatch`; typed events.
- **One-mesh-one-shader** — a multi-material result splits into single-material siblings.
- **Babylon-first** — reuse CSG2/Manifold.
- **Color moat** — textures/UVs must survive for Mimaki color export.
- BLUEPRINT update in the same turn as the feature.

## Known prior (to verify in debate)

The export path **skips CSG2 for textured meshes** (memory: "3MF: textured mesh skips
CSG2 (preserves UVs), solid mesh re-bakes") — i.e. CSG2/Manifold as used today **loses
UVs**. So Boolean-on-textured is the central risk: the moat vs the engine limitation.

## Debate axes → decisions

> **[TO FILL after the 3-agent panel synthesises]**

1. **Engine/threading** — reuse export CSG2 as a shared `BooleanService`? Worker vs main?
   Size-gating threshold + where it lives.
   → *decision (panel 1/3):* **Extract `src/core/BooleanService.js`** owning the lazy
   `InitializeCSG2Async` cache (mirrors `PrintPipeline._ensureCSG2`) + the op
   (`CSG2.FromMesh → union/subtract/intersect → toMesh → VertexData.ExtractFromMesh`) +
   size-gate. Export's `_csgRebake` and interactive both consume it. **Main-thread first**
   — CSG2/Manifold has no proven Babylon worker path; init is one-time (~ms), per-op cost is
   ms-to-sub-second under the cap; spinner + async is enough. Worker is a DEFERRED perf knob
   (NullEngine pattern from `WorkerImport`/`ValidateWorker` is replicable later). **Size-gate**
   by summed operand triangles: web cap ~50k (precedent: 100k auto-validate skip
   `MeshValidator.js:476`, 500k thumbnail skip), desktop raises it (ADR 0001 caps); over cap →
   warn + refuse. `BooleanCommand` captures DELTAS (operand ids + result VertexData + originals),
   not full clones, to avoid undo bloat.
2. **Texture/UV preservation** — can Manifold carry UVs so parts keep their texture?
   → *panel 3/3 (VERIFIED in `@babylonjs/core/Meshes/csg2.d.ts` — `toMesh` exposes only
   `rebuildNormals`/`centerMesh`, NO UV recovery):* **CSG2/Manifold drops UVs.** The export path
   already reflects this — `PrintPrep.csgSolidOnly` runs CSG2 ONLY on solid-colour meshes
   (`isSolidColor`), skipping textured ones to preserve their UVs. UV-remap post-Boolean is
   infeasible (new topology, no bijection).
   → *decision:* interactive Boolean is **solid-colour only**. Textured operand → **modal gate**:
   "Textures can't survive a Boolean (Mimaki colour). Bake to solid colour & proceed, or cancel?"
   — Yes bakes `material.diffuseColor` + strips the texture; No cancels (originals untouched).
   NEVER a silent texture drop. This mirrors the export gate and hard-protects the colour moat:
   textured parts either stay separate or are consciously downgraded by the user.
3. **Data model** — destructive bake vs non-destructive recompute-on-load; `.mixo` round-trip;
   `BooleanCommand` shape.
   → *panel 2/3 audit (grounds the constraint):* `.mixo` **never persists geometry** — only
   source-asset bytes + metadata; SceneObjects replay ratio/geometryFixes on load
   (`ProjectSerializer` / `ProjectLoader`). Soft-delete pattern = `SmartReplaceCommand`;
   multi-material split template = `MeshSplit.splitMultiMaterialMeshes`; sourceGroupId/
   logicalObjectId remap = `DuplicateCommand`.
   → *decision (adjudicated — chose DESTRUCTIVE over the agent's non-destructive):* the agent's
   non-destructive "recompute on load" re-runs every Boolean on every project open (slow for a
   heavy kitbash), leaves the result **stale until reload** (no live dependency graph — a true
   modifier stack is out of scope for a pre-slice tool), and forces hidden-operand bookkeeping.
   Instead **bake destructively into a SYNTHETIC EMBEDDED ASSET**: compute result → serialise its
   geometry to bytes ONCE at bake (GLB/OBJ; offload with the base64 worker) → register as a normal
   asset (embedded bytes, no handle) → the result is an ordinary SceneObject that round-trips
   through the EXISTING asset pipeline unchanged. This *reuses* the "always-embed bytes" contract
   rather than fighting it, gives a real printable object (bake-once, no reload cost, never stale),
   and models the user's intent ("I combined these into one part"). Operands **soft-deleted**
   (SmartReplace pattern) so undo restores them. Result split via `MeshSplit` for
   one-mesh-one-shader; `BooleanCommand.undo` re-enables operands + removes result + its synthetic
   asset. **Caveat from texture axis below may narrow this for textured operands.**
4. **UX/gating** — invocation, non-manifold handling, progress, warnings.
   → *decision:* select 2+ → ContextMenu **Union / Subtract / Intersect** (Subtract base = active
   object, others subtract from it). **Pre-flight gates, fail BEFORE CSG2:** (a) refuse multi-part
   logical objects (reuse `SmartReplaceCommand`'s `logicalObjectPartIds>1` gate); (b) validate each
   operand manifold (existing MeshValidator/worker) → non-manifold → "Fix in validation first",
   no crash; (c) textured → the bake-or-cancel modal above; (d) over the triangle cap → warn+refuse.
   Progress toast ("Unioning…" → result name). CSG2 throw → friendly error, no broken state.

## Decision

**Solid-colour destructive Boolean**, shared engine, gated up front.

- **`src/core/BooleanService.js`** — owns the lazy `InitializeCSG2Async` cache (mirrors
  `PrintPipeline._ensureCSG2`), the op (`CSG2.FromMesh → union/subtract/intersect → toMesh →
  VertexData.ExtractFromMesh`), eligibility gating (solid-colour, manifold-required, tri-budget,
  single-part), and size-gating (web cap ~50k tris; desktop raises per ADR 0001). Export's
  `_csgRebake` can later consume it too. **Main-thread first** (no proven Manifold-in-worker path;
  init is one-time); worker is a deferred perf knob.
- **Destructive → synthetic embedded asset.** Result geometry serialised to bytes ONCE at bake
  (offload via the base64 worker), registered as a normal embedded asset → the result is an
  ordinary SceneObject that round-trips through the EXISTING pipeline (no reload recompute, never
  stale). Chosen over the data-model agent's non-destructive recompute-on-load (which re-runs every
  Boolean on every open, leaves results stale without a live dep-graph, and needs hidden-operand
  bookkeeping — a true modifier stack is out of scope for a pre-slice tool). Solid-colour results
  are cheap to serialise, so the embed cost the agent worried about is negligible.
- **`BooleanCommand`** (HistoryManager): execute = gate → validate → compute → register synthetic
  asset + result SceneObject (adopts active's transform/collection; single solid material →
  one-mesh-one-shader holds without a split) → soft-delete operands (SmartReplace pattern). undo =
  remove result + its synthetic asset, restore operands. Captures ids + result bytes (not live
  clones) to bound undo memory.

## Implementation plan (sequenced slices — each green + committed)

1. **BooleanService (this slice):** eligibility + size gating as PURE functions
   (`isBooleanEligible(objs, caps)` → {ok, reason}: solid-colour check, single-part, tri-budget)
   + the CSG2 op wrapper (main-thread, init reuse). Headless test the PURE gating (mock CSG2).
2. **BooleanCommand + synthetic-asset embed** — serialise result → bytes → asset; execute/undo;
   `.mixo` round-trip. Browser smoke: union two solid cubes → one watertight mesh, survives reload.
3. **ContextMenu Union/Subtract/Intersect** + modals (texture bake-or-cancel, non-manifold→validator)
   + progress + i18n (en/ja/zh-Hant).
4. **Browser smoke** end-to-end (real CSG2): union/subtract/intersect on solid cubes; textured→gated;
   BLUEPRINT §Boolean.

## Slice 2 design (adjudicated from a 2-agent cross-interrogation)

**Persistence — raw VertexData synthetic asset (`.mxvd`), NOT GLB.** Serialise the CSG2 result's
VertexData (positions/normals/indices; no UV — solid-colour) to a compact byte blob via a pure
`GeometryCodec` (encode/decode). Register it as an embedded asset (`kind:'mesh'`, `extension:'.mxvd'`,
embedded bytes, no handle). Restore adds ONE branch: `extension==='.mxvd'` → decode → build mesh,
**skip `bakeImportTransform`** (already world-space). Chosen over the GLB round-trip both agents
weighed — GLB rides RH↔LH conversion + the import-flip (fragile); raw VertexData restores verbatim.

**Neutral restore — field invariant (corrects BOTH agents).** Restore applies unit-factor
(`bakeImportTransform`) then `delta = modelRatio/ratio`. For a world-space result to restore 1:1:
`sourceUnit='meters'` (unit factor 1) **AND `modelRatio == ratio`**. Both agents proposed
`modelRatio=1` with `ratio=operandRatio` → that gives `delta=1/operandRatio` and SHRINKS the result.
Correct: **`modelRatio=1, ratio=1`** — the bytes ARE the displayed size; the result carries ratio
1:1; export "as shown" prints it at displayed size (consistent with the per-object-ratio model).
(The `.mxvd` restore branch skips `bakeImportTransform` anyway, so this is belt-and-suspenders, but
the SceneObject fields must still be neutral for any ratio-delta pass.)

**CSG2 compute (API verified in `csg2.d.ts`).** `_ensureCsg2()` (mirror `PrintPipeline`), then
`CSG2.FromMesh(m)` (defaults to WORLD matrix → operands combine in world space), and **union =
`.add(other)`** (NOT `.union()` — agent guess was wrong), subtract = `.subtract()`, intersect =
`.intersect()`, `.toMesh(name, scene)`, `.dispose()`. Result material = first operand's
`diffuseColor` solid, else `scene.defaultMaterial` (resin grey).

**`BooleanCommand`** (`src/core/commands/BooleanCommands.js`): execute = `evaluateBooleanEligibility`
gate → `computeBoolean` → encode → register `.mxvd` asset + result SceneObject (`ratio=1`,
`modelRatio` neutral) → soft-delete operands (SmartReplace pattern, capture snapshots). undo = remove
result + synthetic asset, restore operands.

**This-operation scope (kept green + testable):** `GeometryCodec` (pure encode/decode, headless
round-trip test) + `BooleanService.computeBoolean` wrapper (verified CSG2 API). The `BooleanCommand`
+ `.mxvd` restore branch + ContextMenu + browser smoke are the next increment (handoff) — they touch
the persistence restore core and are browser-verified, done as a careful pass so `master` stays green.

## Consequences

- Ships the defining kitbash "combine" verb for **solid-colour** parts (the common case), reusing
  CSG2 init + embed pipeline + SmartReplace + MeshValidator. Runs on web AND desktop (main-thread).
- **Textured combine is a conscious bake-to-solid** — the colour moat is protected by an explicit
  gate, never a silent loss. Textured parts otherwise stay separate (still fully printable in colour).
- Deferred (future ADR): true texture-preserving Boolean (UV atlas / per-triangle provenance),
  Manifold-in-worker for heavy meshes, non-destructive modifier stack. None block the first release.
