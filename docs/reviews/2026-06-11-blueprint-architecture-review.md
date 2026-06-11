# Blueprint v4.0 Architecture Review — 2026-06-11

Scope: full read of `Blueprint.md` (2522 lines), cross-checked against the
same-day code review (`2026-06-11-deep-review.md`) and the full `src/` read
behind it. Two output categories: **A — architectural gaps in the spec
itself** (the design is missing or wrong, not just the code), and **B —
spec/code drift** (the doc asserts things the code doesn't do, or vice
versa). Ordered by leverage.

---

## A. Architectural gaps (design-level refinements)

### A1. Texture identity has no contract — root cause of the texture-loss family
The Blueprint specifies texture *handling* (readback, dedupe, export
packaging) but never specifies texture *identity*: what uniquely names a
texture across import → session → `.mixo` → reload → export. Consequences
already shipped:

- Dedupe by `name|width|height|class` (§10 Import Merge step 2) aliases
  different textures across files (review H6).
- Persistence "Accepted Scope Cut" #1 drops imported textures on reload
  (review C2) — for a product whose locked goal is *texture preservation*,
  this is not a scope cut, it's a contradiction of §15 "Mimaki targets must
  never collapse textures."
- `PrintManager` probes a phantom `asset.textures` field the AssetEntry
  schema never defined.

**Refinement:** add a §10b *Texture Identity* contract:
- Imported texture assetId derives from a **content hash** (sha256 of
  readback bytes via the shared TextureReadback seam, computed once at
  registration). Hash stored on the AssetEntry (`contentHash`), reused by
  dedupe, export filename assignment, and reload rebinding.
- `.mixo` v3.2: shader entries keep `diffuseTextureAssetId`; texture
  AssetEntries for `isImported` textures persist `{ contentHash,
  sourceAssetId, materialName }` so reload can rebind container-owned
  textures by walking the restored container's materials.
- Load step 9 changes from "assign recreated shader material" to "re-register
  container textures → rebind shader entries → then assign" (fixes C2 by
  design, not by patch).
- Schema bump 3.1 → 3.2 with `_migrate` defaulting old saves to
  colour-fallback (current behaviour, no regression).

### A2. The live-Chrome milestone keeps slipping because it's manual — automate it
Phase 6 closed with "live Chrome NOT demonstrated." Phase 7 closed with
"live + slicer round-trip NOT demonstrated." The C1 blank-texture bug lived
exactly in that blind spot: the headless Babylon shim returns sync
`readPixels`, the real browser returns a Promise. §14b explicitly lists the
live pass as "deferred human Chrome pass" — the architecture *plans* for the
gap instead of closing it.

**Refinement:** extend `tests/browser-smoke.mjs` (already CDP-driven, already
boots real Chrome + Vite) into a **functional smoke**:
1. Inject a small textured GLB fixture (`tests/fixtures/textured-cube.glb`)
   via CDP `Input.dispatchDragEvent` or a test-only `window.__mixotest.load()`
   hook gated behind `import.meta.env.DEV`.
2. Trigger Mimaki 3MF export through the same hook; capture the Blob bytes.
3. Unzip in Node; assert `3D/Textures/*.png` exists, decodes, and is not
   fully transparent/black; assert `<m:texture2dgroup>` present.
4. Wire as `npm run test:browser` step in the verification baseline (§15).

This single change converts the project's recurring "deferred live milestone"
debt into a permanent regression guard. Highest-leverage item in this review.

### A3. The §0.5 size budgets are fiction because the module *designs* exceed them
§0.5 says SceneManager < 400 LOC "enforced," but §7 assigns SceneManager
eight concerns: engine/boot, camera (presets + follow + animation + ortho
auto-revert), lighting/backdrop/tone-map, grid/bed/labels, selection
silhouette (RTT + custom shader), gizmo + pivot parenting, body drag,
overlays, 3D cursor. Specced honestly, that's 1200 lines — which is exactly
what shipped. Same for HistoryManager: "< 250, all command classes in one
file is OK" — fifteen command classes cannot fit 250 lines.

**Refinement:** make the file layout match the concern list:
- `core/scene/Camera.js` — presets, follow modes, animation, ortho revert.
- `core/scene/SelectionOutline.js` — mask RTT + post-process.
- `core/scene/BedGrid.js` — ground, labels, bed preview, overlays.
- `core/scene/PivotSession.js` — pivot parenting, gizmo wiring, body drag.
- `SceneManager.js` stays as façade + engine/lighting boot (< 300 real).
- `core/commands/` — `TransformCommands.js`, `HierarchyCommands.js`,
  `ShaderCommands.js`, `ScaleCommands.js`; `HistoryManager.js` keeps only
  the stack/batch machinery (< 120 real).
Update §0.5 to budgets that are *true*, and drop the word "enforced" from
any number the spec's own design violates.

### A4. Command snapshot rule caused a critical bug — amend §5
§5 rule: "Commands capture `prev` state **before** `execute()`, never
inside." Followed literally by `DeleteCommand`, this captured
`mesh.parent` while the selection pivot was attached → undo re-parents to a
disposed node (review C3). The rule conflates two snapshot domains.

**Refinement:** split the rule:
- *Logical state* (JSON state slices): capture at construction, before
  execute. (Unchanged.)
- *Babylon scene-graph facts* (parents, world transforms): capture **inside
  execute, after `_withDetachedPivot` normalizes the graph** — construction
  time is a lie whenever a selection exists.
Add one sentence to the `_withDetachedPivot` paragraph naming this trap.

### A5. Dirty tracking diverges from the undo stack — §5/§11 contract risk
"Undo/redo do not mark project dirty" + event-driven `_dirty` means: save →
edit → undo leaves the file different from disk with `_dirty === false` —
close discards silently. Also the inverse: edit → undo back to saved state
still shows dirty.

**Refinement:** position-based dirty. `PersistenceManager` records the
history stack position at save (`HistoryManager.getPosition()`, a counter
that increments on push/undo/redo); dirty ⇔ `position !== savedPosition ||
nonUndoableMutationSinceSave`. Standard DCC behaviour, ~20 lines, removes a
whole class of silent data loss. Spec §5 + §11 both updated together.

### A6. The validation architecture can't feed the UI the spec promises
§13 Outliner promises validation-status row icons; §13 Properties promises a
Validation section; §9 promises clickable toasts; §12 promises a
warnings-confirm export gate. None are implementable cleanly because
validation results are **not stored anywhere** — they live in transient
toasts and a per-render recompute in PrintPanel (which re-validates the
whole scene on every selection change while the tab is open).

**Refinement:** add a `state.scene.validation` cache:
`Record<meshId | groupId, { results, validatedAt, stale }>`, written by
MeshValidator, invalidated by `TRANSFORM_COMMITTED` / `OBJECT_UPDATED` /
import. Outliner icons, the PrintPanel tab, the export gate, and toast
click-through all read the same cache. Kills the M11 perf problem and makes
three spec'd-but-unbuilt features buildable.

### A7. TS twin-file mirrors are a manual-sync liability — pick a side
§0.3b: "If a runtime JS contract changes, update its TS mirror in the same
turn." Manual same-turn sync invariants decay (that's why the review found
PrintPanel re-implementing `exportFactor` inline). The twins exist only
because Node-native tests can't import `.ts`.

**Refinement (pragmatic):** delete the `.ts` twins for `ScaleMath`,
`ExportPlanner`, `PrinterProfiles`; turn on `checkJs` for those three JS
files only (`// @ts-check` headers + JSDoc types, which they largely
already have). `npm run typecheck` then validates the *real* runtime files
and the mirror-sync rule disappears. Keep `ImportPipeline.ts` /
`ExportPipeline.ts` (pure type declarations, no runtime twin — those are
fine).

### A8. Event bus has no liveness guard — one line prevents a bug class
`subscribe(EVENTS.OBJECT_ADDED, …)` with a typo'd/nonexistent event key
registers a listener under `undefined` and silently never fires (shipped
bug, review M11). The typed-events rule (§0.1) has no enforcement.

**Refinement:** in `StateManager.subscribe`, dev-mode guard:
`if (typeof eventName !== 'string') throw new Error('subscribe: unknown event')`.
Plus a 10-line headless test that greps `subscribe(EVENTS.X)` usages against
`events.js` keys. Add both to §4 Rules.

### A9. Autosave does full asset re-embed every 60 s — spec the lighter doc
§11 Autosave writes the *full* document — every asset blob re-fetched,
re-hashed, base64'd on the main thread each interval while dirty (review
M16). Embedded bytes exist for crash recovery, but tiers 1–3 (live handles)
plus the last explicit save already cover the realistic recovery cases.

**Refinement:** autosave writes the document with `fileData: null` and a
`recoveryNote: 'autosave; bytes via live handles or last full save'`;
`recoverAutosave` resolution simply hits tiers 1–3 then falls back to the
last explicit save's embedded copy for missing assets. Also cache
`contentHash` per assetId (bytes are immutable per id) so explicit saves
stop re-hashing too. Update §11 Autosave accordingly. Note: §11's "On
startup … recovery banner" contradicts the shipped boot flow (remount
prompt replaced recovery; `recoverAutosave` is never called from
`main.ts`) — the spec should either restore the call or document the
remount-instead decision in §11, not just in the AssetPanel section.

### A10. Split Blueprint genres: contracts vs history
2522 lines mixing four genres: ground rules, design tokens, module
contracts, and build history (§15). §0.3b (new) is a *summary index* that
now partially duplicates §§7–13 — a second copy that can drift. Build
history grows monotonically and stales the doc.

**Refinement:** move §15 build history to `BUILDLOG.md` (append-only, never
needs accuracy maintenance); keep §0.3b but mark it explicitly as
*derived — regenerate from module sections when they change*; keep
everything else single-file (single-file is right for the AI-rebuild use
case). Also stop hard-coding test *counts* in §14b (the "112 tests" table
goes stale on every test commit) — list files and what they cover, no
numbers.

---

## B. Spec/code drift (doc says X, code does Y)

| # | Blueprint says | Reality | Action |
|---|---|---|---|
| B1 | §0.4 table: selection outline = `HighlightLayer` | §7 + code use custom RTT outline (HL rejected) | Fix §0.4 row |
| B2 | §6 "no `addEventListener` outside InputManager" | InputManager itself, SceneManager, every UI module use it | Rescope rule: "viewport pointer/keyboard input flows through InputManager; DOM-widget listeners live in their UI modules" |
| B3 | §6 keymap: `B` box-select, "LMB drag empty = box select" | No marquee implementation | Mark `(planned)` or delete |
| B4 | §7 "Numpad presets … `rebuildAnglesAndRadius()`"; "wheelPrecision=500, panningSensibility=5000" | Presets animate via `_animateMulti`; Babylon pan disabled, percentage wheel zoom | Rewrite stale paragraph to match §7's own later "Camera Presets" block (the doc contradicts itself) |
| B5 | §9 toasts "clickable → Print Panel" | Toast has no click-through | Mark planned (or implement with A6 cache) |
| B6 | §12 Export Gate "warnings only → confirm 'Export anyway?'" | No confirm; warnings never gate; validator emits warnings only → gate logically dead | Decide: implement confirm, or spec the warning-pass-through honestly |
| B7 | §13 Outliner: drag-to-reparent, search bar, ghost-row right-click Relink, validation icons | None implemented | Mark planned; tie icons to A6 |
| B8 | §13 Properties section 7 "Validation" list | Lives in PrintPanel tab only | Update spec or move with A6 |
| B9 | §13 PrintPanel "Tabs: Scale/Validation/Bed/Thickness(future)/Orientation(future)/Export" | Shipped tabs include **Preview** (print preview + wireframe edges) — undocumented | Add Preview tab to spec |
| B10 | §7 API `setOverlay(name)` list omits `wireframeEdges` in one of two places; state shape comment says it's "written on first toggle" | True, but `wireframeEdgeColor` is never reapplied to SceneManager on load (review M19) | Spec load step 12 already says apply both — fix code to match spec |
| B11 | §14.4 "Never call `getState()` inside `registerBeforeRender`" | `_applyFollowTarget` (onBeforeRender) calls it 3–4× per frame — in dev mode each call deep-clones+freezes the whole state | Fix code (cache via subscription per §14.4) — this also masks dev-mode perf |
| B12 | §16 "non-blocking re-grant banner" for handle permissions | Shipped as boot modal prompt (remountFolder) | Update constraint row |
| B13 | §8 API `removeAsset` "dispatches ASSET_REGISTERED{type:'removed'}" | Spec documents the smell as the contract | Add `ASSET_REMOVED` event to §3 and fix both |
| B14 | §5 lists `SmartReplaceCommand`, `TransformSwabCommand` as "stubs (real bodies in later phases)" | Both fully implemented since Phase 6 | Move to implemented list |
| B15 | §11 Load Sequence step 8 "Use `BABYLON.AssetsManager` to batch-load" | Loads sequentially via `_resolveAssetBlob` + `restoreContainer` | Update spec (sequential is fine; AssetsManager adds nothing here) |

---

## Suggested adoption order

1. **A2** (functional browser smoke) — guards everything else; do alongside
   Bundle 1's live-verify task so the manual pass gets automated the same week.
2. **A1 + A5** (texture identity, position-based dirty) — these ARE the
   design pass Bundle 2 needs; write as §10b/§5/§11 spec amendments first,
   then implement.
3. **A4 + A8** (snapshot rule, subscribe guard) — one-paragraph spec edits +
   tiny code guards; fold into Bundle 3.
4. **A6** (validation cache) — unlocks four spec'd features; schedule as its
   own small bundle after 3.
5. **A3 + A7 + A9 + A10** (module splits, TS twins, autosave, doc split) —
   structural hygiene; A3 aligns with review L29 (Bundle 5).
6. **B-items** — single Blueprint editing pass; cheap, do whenever the doc
   is next open (several fold into the above).
