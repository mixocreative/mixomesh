# Plan: React UI, WASM geometry, support generation (2026-10-29)

Owner goal (2026-10-29): mixomesh moves its web UI layer to React (Babylon stays the 3D engine),
moves 3D geometry and export geometry to WASM wherever that is faster, and gains the full support
generation of mixosupports as an isolated Support Mode that works only on the selected objects,
with the extra Roof and Cage settings. The 3D gizmo is updated. At the end: test, fix, push, tell
the owner.

Status: reviewed 2026-10-29 (Fable: ready-with-changes; egm design, readiness, zoom-out). All
blocking findings are folded in below. Revision 2.

Specs this plan builds on (read, do not duplicate):
- `docs/support-generation-port.md` — the support port guide (inventory 2b, ABI 3, settings 4,
  editing UX 5/5b, coordinates 6, parity tests 7). Where this plan differs, this plan wins and says so.
- mixo-app-style skill (`~/.agents/skills/mixo-app-style/SKILL.md`) — the look. mixomesh already
  defaults to it (`data-ui-style` "new", `src/styles/style-new.css`).

Ledger: `docs/handoff/react-wasm-supports.md` (P0.0). It replaces `docs/handoff/support-port.md`
(A1 done; A2→P1, A3→P2, A4/A5→P3/P4, A5b→P5, A6→P4.1, A7→P8).

---

## 0. Directives (every agent, every task)

Handoff and workflow:
- D1. Work on `master` in `S:\ai\mixomesh`. No branches, no git worktrees, no `git stash`, no
  `git checkout --`. In `S:\ai\mixosupports` (P8.3 only): commit on its `main` locally, never push
  before P9.3.
- D2. One editing agent at a time, except pairs marked ∥ in section 4 (file-disjoint). Read-only
  reviewers may run any time.
- D3. Each task ends with its tests green, `npm run lint`, `npm run typecheck`, and one commit on
  master (message ends with the session attribution lines). The agent reports back: commit, what is
  verified (commands + results), exact next step. The main session alone writes the ledger row and
  commits it. An interrupted agent reports `WIP:` with where it stopped and what is uncommitted.
- D4. Query the graph before reading source: `graphify query "<q>"`; mixosupports code via
  `graphify query "<q>" --graph graphify-out/port-graph.json` (refresh the merged graph first:
  `graphify update S:\ai\mixosupports; graphify merge-graphs graphify-out/graph.json S:\ai\mixosupports\graphify-out\graph.json --out graphify-out/port-graph.json`).
  Read only located lines. After code changes, `graphify update .`.
- D5. Never claim a UI works without evidence: a Playwright screenshot or smoke (`ui-screenshot.mjs`
  with `PROBE=1`, or `tests/browser-*.mjs`). Measure layouts at rest, after import settles.
- D6. No push until P9.3 (pushing deploys GitHub Pages; owner pre-authorised P9.3 on 2026-10-29).

Owner product rules:
- D7. Printer-agnostic, texture-preserving export. Never build a slicer. Never name third-party
  slicers or their brands in UI, comments, docs or commit messages.
- D8. Every new string in en, ja, zh-Hant (Taiwan wording, via the Gemini skill
  `python ~/.config/gemini/gemini_chat.py`); `npm run i18n:check` green.
- D9. Export reads frozen full-resolution source bytes, never the GPU texture; never silently
  downscale textures; unit/axis math only in the import seam (ImportNormalizer) and the export seam
  (ExportContext / PrintSpace).
- D10. Orientation and winding are verified empirically (trimesh / PrusaSlicer CLI `--info`, cull
  on/off screenshot), never by handedness reasoning alone. The scene stays left-handed:
  `scene.useRightHandedSystem` is never set (it would invalidate ImportNormalizer, PrintSpace
  signed volume, NavCube and the orientation smokes).
- D11. `public/vendor/mixo-geometry/` is never edited. Engine changes are made in mixosupports
  `crates/geometry-core`, built there (`npm run wasm:build`), re-vendored here
  (`npm run vendor:geometry`); `HOST_GEOMETRY_VERSION` and `VERSION` change in the same mixomesh
  commit.
- D12. Per-user settings persist through SettingsStore; `panelCollapsed` is tri-state (absent =
  defer to workspace); toggle button for feature/mode/visibility, checkbox for sub-options.

Architecture rules:
- D13. Three layers: React panels → commands (`src/core/commands/*` + `HistoryManager.push` /
  `beginBatch` / `endBatch`) + StateManager + logic → Babylon scene. React never holds meshes,
  textures or Babylon objects. `createDispatcher` (`src/core/api/ApiDispatcher.js`) is the
  automation API, not the UI command path.
- D14. Per-frame values never go through React: gizmo deltas, pointer position, brush ring, ghost
  tip, camera. Babylon draws them; the store changes on commit (one undo step per drag).
- D15. Live UI → scene: call the scene directly on input (no undo entry), commit one command on
  release. Expensive rebuilds (support generation) are debounced, run in a worker, keep only the
  latest job per object, carry a `revision`; a job running past 20 s while a newer one waits is
  ended by terminating and respawning the worker.
- D16. A panel subscribes only to the `EVENTS` it shows (`useStore`, P0.2).
- D17. New UI uses the kit `src/kit/`. A missing control is added to the kit (component, vitest,
  gallery entry) first.
- D18. WASM moves are benchmark-led. Owner instruction 2026-10-29 ("best performance") replaces
  the guide's 2x rule: a function moves when the WASM path is ≥1.1x faster end to end (including
  copies), median of 5 runs on the corpus, and its output matches the JS path within the tolerance
  written in its parity test. A slower path is reported in the ledger, not shipped.
- D19. State stays JSON-safe (dev `getState()` deep-clones through JSON): no typed arrays in state;
  large numeric lists are plain arrays or base64 strings (>10k values).
- D20. Support-layer meshes are invisible to the rest of the app: no `meshId`,
  `isPickable=false`, excluded from WorldExtents, MeshStats, MeshValidator, SelectionOutline,
  thumbnails, BoxSelect and every export path except the support export of P4.2 (precedent: the
  cross-section indicator quad).
- D21. One undo stack: HistoryManager. The ported mixosupports `session.ts` reducer is used as pure
  state logic; its undo history and `state/history.ts` are not ported.

---

## 1. Architecture

```
src/kit/            React component kit (mixo-app-style), gallery kit.html (dev server only)
src/react/          mountPanel, useStore, useCommand, useT, error boundary
src/panels/         React panels, one folder per panel, replacing src/ui/*.js one by one
src/support-engine/ ported mixosupports logic, TypeScript kept as .ts (guide section 8's esbuild
                    step is dropped); A1 files geometryVersion.js / loadGeometry.js stay
src/supports/       the mixomesh support feature: model, commands, mode, frame adapter, layers
src/core/           unchanged role: state, commands, scene, import/export seams
```

- Mount: legacy panels export a bare `init()` and find static roots in `index.html` by id
  (`#status-bar`, `#rp-properties-body`, `#toast-container`, `#modal-root`, …; only
  `TransformSheet.init(host)` takes a host). `mountPanel(rootId, <Panel/>)` renders into that root;
  a migrated panel keeps its `init()` and `unmount()`. One shared React context provider
  (locale, style) wraps every root.
- Store: `useStore(events, selector, isEqual?)` on `useSyncExternalStore`, subscribing to named keys
  in `src/core/events.js` (there is no generic change event).
- Commands: `useCommand()` returns helpers that construct `src/core/commands/*` objects and call
  `HistoryManager.push` (batched with `beginBatch`/`endBatch`).
- React 19. New code is `.ts`/`.tsx`; legacy `.js` stays until migrated. `.ts(x)` tests run in
  vitest (+ jsdom, @testing-library/react); legacy `node --test` stays; `npm test` runs both.
- Style: the "original" (washi) option is removed at P0.6; from then on everything is mixo-app-style.

---

## 2. Phases and tasks

Format: **id** goal. Files. *Depends.* **Done when.** Worker per section 4.

### P0 Foundation

- **P0.0** Ledger `docs/handoff/react-wasm-supports.md`: one row per task id below; mark
  `docs/handoff/support-port.md` superseded with the A→P mapping. *Depends: —.* **Done when** every
  id in section 2 has a row.
- **P0.1** Toolchain: `react@19`, `react-dom@19`, `@vitejs/plugin-react`, `vitest`, `jsdom`,
  `@testing-library/react`, `@types/react*`; tsconfig `jsx: react-jsx`, include `src/**/*.ts(x)`;
  eslint for ts/tsx (typescript-eslint version that supports TypeScript 6, react-hooks rules); a
  serve-only `transformIndexHtml` that allows the React refresh preamble under the CSP (hash or
  nonce). *Depends: —.* **Done when** `npm test` runs node + vitest, `npm run build` output's CSP is
  byte-identical to today, `npm run test:electron` and `npm run test:browser` green.
- **P0.2** `src/react/`: `mountPanel`, `useStore`, `useCommand`, `useT` (LOCALE_CHANGED), error
  boundary reporting through `Status.js`. *Depends: P0.1.* **Done when** vitest covers: a store event
  re-renders only subscribed components, a command lands one HistoryManager step, unmount removes
  listeners.
- **P0.3** Perf harness: extend `scripts/heavy-mesh/measure.mjs` with `gizmoDragFrameMs` (3 s
  scripted gizmo drag) next to `orbitFrameMs`; fixtures from `scripts/heavy-mesh/generate.mjs`
  (1M-triangle mesh, 4096² textured mesh). *Depends: —.* **Done when** median of 5 runs of both
  metrics is in the ledger as the baseline.
- **P0.4a** Kit fields: Button (primary / danger / plain / icon), Segmented, Toggle, Check, Select,
  NumberField (drag-scrub, units mm / deg / ×, min/max; NumberScrub behaviour), RangeField (slider +
  number, onInput / onCommit), ColorField. Start from mixosupports `NumberField.tsx`,
  `RangeField.tsx`, `Segmented.tsx`, `CommandButton.tsx`; CSS from mixo-app-style `tokens.css` /
  `base.css` (copied, never re-derived). *Depends: P0.1.* **Done when** vitest per component
  (render, keyboard, onInput/onCommit), gallery page shows each in default / hover / disabled /
  active, screenshot in ledger.
- **P0.4b** Kit containers: Section (collapsible, tri-state collapse, ↺ reset, ↧ copy-from-active),
  FieldRow, Modal, Toast (with undo action), ProgressRow, KeyCaps, Notice (problem notice, actions
  on their own row). *Depends: P0.1.* **Done when** as P0.4a.
- **P0.5** `docs/ui.md`: the three layers, how to add a panel, how to add a kit control, D13–D17 with
  one example each. *Depends: P0.6.* **Done when** the doc's examples match the P0.6 code.
- **P0.6** First panels in React: StatsHud and TransformSheet (live transform values), kit only;
  remove the "original" style option and its CSS (keep `style-new.css` rules as the only style).
  *Depends: P0.2, P0.3, P0.4a, P0.4b.* **Done when** their existing tests/smokes pass, the React
  profiler records zero commits of unrelated panels during a gizmo drag, and `gizmoDragFrameMs`
  p95 is within 5% of the baseline (median of 5). **Owner checkpoint 1** (kit look, perf).

### P1 Support engine logic

- **P1.1** Copy to `src/support-engine/` as TypeScript, file names kept: `src/editing/*` (minus
  dental mode, `dental.*` commands/keys, and `session.ts` undo history per D21),
  `src/core/supports/settings.ts`, `zones.ts`, `mesh.ts`, `src/supports/supportBuildWasm.ts`,
  `generateSupports.ts`, `contactEdits.ts`, `genericPolicy.ts`, `genericPlacement.ts`,
  `checkSupports.ts`, `islandProblems.ts`, `omittedProblem.ts`, `jobRunner.ts`, `landing.ts`,
  `unitSupports.ts`, `supportFrame.ts`, the support-mesh part of `export.ts`, `exportGate.ts`,
  `src/workers/meshProtocol.ts`, `meshWorker.ts`, `meshClient.ts`, `buildSessions.ts`, and the
  analysis files the goldens need (`core/analysis/types`, `core/analysis/supportCheck`,
  `meshQuery.ts`). `geometryClient.ts` is rewritten, not copied: engine exports are read from the
  module returned by `loadGeometryEngine` (no static named imports, no `?url`). No import from
  `src/dental/`. *Depends: P0.1.* **Done when** `tsc --noEmit` is clean over `src/support-engine/`
  and `grep -ri dental src/support-engine` is empty.
- **P1.2** Port the matching `*.test.ts` (dental cases removed) and the goldens: a mixomesh
  `src/support-engine/goldens/goldenImport.ts` builds fixtures with `BinaryStlSession` on the vendored
  pkg-browser (`initSync`), replacing mixosupports' `scripts/test-support/rustImport.ts` /
  pkg-node / three.js glTF types. *Depends: P1.1.* **Done when** the 4 fixtures (cube-overhang,
  knot, thin-slab, v-ridge) × 4 variants (default, tree, roof, ridge) match the mixosupports
  snapshots exactly, and every ported test is green.

### P2 Spike

- **P2.1** One selected mesh → worker job → `generate` → tips drawn in Babylon. Handedness rule
  (D10): conversion only in `src/supports/frame.ts` (negate Z of positions and normals, swap triangle
  indices 1↔2 per triangle, both directions). The adapter also sends the engine a copy welded by
  position (geometry only; UV/colour seams split mixomesh's textured meshes, and the engine's edge
  tests key edges by vertex index, so unwelded seams inside an overhang would read as region
  boundaries and get false edge reinforcement). *Depends: P1.2.* **Done when** a textured cube whose
  UV seams cross its bottom face gets the same edge anchors as the plain cube, cube-overhang tip count
  equals the golden, a cull on/off screenshot and a trimesh winding check of an exported support
  mesh are in the ledger, and the existing import/export orientation smokes are unchanged.
  **Owner checkpoint 2** (tips on a real model).
- **P2.2** Engine loading proven in the dev server, the production build and Electron `file://`:
  `tests/browser-support-engine-smoke.mjs` (`--preview`, `--electron`). *Depends: P2.1.* **Done when**
  all three modes report engine 9.

### P3 Support Mode

Behaviour contract (owner 2026-10-29 + guide 5, 5b, 8):
- Enter: header button "Supports" and key `Shift+S` (free; `S` = scale, `Shift+D`, `Shift+N` taken),
  enabled when ≥1 object is selected. Works on the selected logical objects only (multi-shader
  groups count as one; supports live on the logical-object lead, never on parts).
- Isolation: a runtime `isolationMask` hides every non-selected object (separate from object
  visibility; never saved, never exported, never read by the Outliner's visibility toggles or undo);
  the shell gets `data-mode="supports"`, which dims and makes `inert` every panel the mode does not
  use; the Support panel opens; the header shows "Support Mode — N objects" with Done. Gizmo off.
- Input: InputManager context `'supports'` (via `setContext`) shadows G/R/S, X/Delete (scene
  delete), H, A, BoxSelect, body drag, Cursor3D (Shift+N) and CopyPaste. Undo/redo inside the mode
  walks only support commands; an older non-support step is not undone while the mode is open.
  Esc order: support selection → active tool → leave mode.
- Exit (Done, Esc, or `Shift+S`) restores the mask, panels, input context and selection.
- Inside: the mixosupports generic UI (guide 5b A, B, C): presets Light / Middle / Heavy / Custom;
  tips, neck, pillar, foot; Support area brush; Edit (Add / Select, Click / Drag over, circle size,
  Shift flips, Delete, right-click/Ctrl+click remove, ghost tip, remove ring, crosshair while adding,
  tool name with what a click does); per-support overrides (reset, select customised); view toggles
  (Tips only, Bottom view — hides BedGrid and floor disc —, Fit view); problem list with Show/Fix;
  Generate / Regenerate; undo toasts; job progress. Tree, Brace, Raft, Label, Roof, Cage sections
  are added by P5.
- Support area meaning: Paint = no-support zone, Erase clears it (the engine's generic policy). The
  guide's "allowed area" meaning is P5.10.
- Several selected objects: each has its own supports, generated independently.
- Stale supports: `object.supports` records `sourceHash` (geometry) and the build pose (rotation,
  scale; translation is free because contacts are object-local). Repair, refinement, scale or
  rotation outside the mode marks supports stale; stale supports are drawn greyed, block export, and
  regenerate on the next mode entry with hand work rekeyed (`rekey_hand_work`).

Tasks:
- **P3.1** Data model + commands: `object.supports = { settings, presetName, deleted, manual,
  overrides, stamps, sourceHash, pose, revision }` on the logical-object lead (D19 JSON-safe);
  support mesh in a runtime cache keyed by object id. One command class per edit (add, delete,
  stamp stroke, override, reset override, settings change, preset) in `src/supports/commands/`.
  *Depends: P2.1.* **Done when** vitest: each command does and undoes as one HistoryManager step,
  `object.supports` round-trips through JSON, stale detection fires on scale/rotate/repair.
- **P3.2** Mode controller `src/supports/SupportMode.ts`: enter/exit, `isolationMask`,
  `data-mode`, InputManager context, Esc order, mode-scoped undo. *Depends: P3.1.* **Done when**
  smoke: enter hides the others and dims panels, every shadowed key is inert, exit restores
  everything, a save and an export during the mode include all objects.
- **P3.3** Babylon layers `src/supports/layers/`: support mesh (one material per part kind, shared,
  never recompiled per preview), tips-only mesh, ghost tip, remove ring, screen-space brush ring,
  zone stamp overlay (stamped triangles only), selection highlight; picking through the engine
  (port of `rustRaycast`). D20 for every layer. *Depends: P3.1.* **Done when** smoke: layers draw,
  picking hits tips, and stats HUD / world extents / selection outline / export are unchanged by
  their presence.
- **P3.4** React panels `src/panels/supports/`: SupportPanel (presets, tips, neck, pillar, foot),
  EditBar, ZonesBar, SurfaceBrushBar, ProblemList, ViewToggles — rebuilt from the mixosupports `.tsx`
  with the kit. *Depends: P0.4a, P0.4b, P3.1.* **Done when** vitest per panel + screenshot.
- **P3.5** Live generation: debounced worker jobs (port of `useRegenerate`), latest-job-only and
  worker respawn per D15, stale results dropped, problem list greys until the new verdict lands;
  repair budget 3 so brace pruning runs; notice `brace-pruned`. *Depends: P3.3, P3.4.* **Done when**
  smoke on the 1M-triangle fixture: 10 rapid slider changes end in one result for the last value,
  UI never blocks > 100 ms.
- **P3.6** Walk smokes `tests/browser-supports-*.mjs`: guide section 7 scenarios a1–a5, c, d, e,
  f1–f4, g, rewritten for mixomesh. *Depends: P3.5.* **Done when** all green.
  **Owner checkpoint 3** (Support Mode UX).

### P4 Persistence and export

- **P4.1** `.mixo` save/open keeps every support edit: project version +1 with a migration in
  `src/core/persist/ProjectLoader.js` (old files load with `supports` absent); autosave included;
  walk i1–i3. *Depends: P3.6.* **Done when** an old-version fixture opens unchanged and i1–i3 pass.
- **P4.2** Export through the export seam. ExportContext gains `includeSupports`
  (`none` / `printable` / `supportsOnly`). Shapes: 3MF — supports are a separate solid `<object>`
  (basematerials) under the object's existing `<components>` parent, never inside the textured
  `<object>`; OBJ — a separate `g` with a solid MTL; STL — merged soup. Supports are separate shells,
  never welded to the model. Ratio rule: supports are mm-physical; exporting at a target ratio other
  than as-shown regenerates supports at that ratio (same contacts, rescaled points) or refuses with a
  notice — tip geometry is never scaled. Stale supports block export. The automation API export
  (`ApiDispatcher`, `--job`, Electron prepare) accepts `includeSupports`. `test:consumers` gains rows:
  solid cube + supports, textured model + supports (3MF, OBJ, STL). *Depends: P4.1.* **Done when**
  consumers rows green and a printable 3MF opens with model and supports as separate parts.
  **Owner checkpoint 4** (printable export).
- **P4.3** Cost quote and triangle budget include supports. *Depends: P4.2.* **Done when** unit tests
  show the support volume and triangles added.

### P5 Remaining support features (guide 2b — every row)

Each task adds its settings section to SupportPanel, its walk scenario, and asserts its golden.
*Depends: P3.6 (each).*
- **P5.1** Tree / Auto tree / safe distance — golden `tree`.
- **P5.2** Cross-braces with pruning — Rust brace tests + a crossing-model walk.
- **P5.3** Raft (outline, flared wall, drainage gaps).
- **P5.4** Label (8 chars A–Z 0–9 -, raft corner pad).
- **P5.5** Roof (`ROOF_DEFAULTS`) — golden `roof`.
- **P5.6** Cage (`ROOF_DEFAULTS.CAGE`).
- **P5.7** Islands check, problem list Show / Fix.
- **P5.8** Low-poly preview + `decimate_display` for heavy models (keep only if the P3.5 smoke on the
  1M fixture shows previews > 1 s; otherwise record "not needed" in the ledger).
- **P5.9** i18n of every support string (D8).
- **P5.10** Allowed-area paint (guide 5b B, dental meaning on any model) via the area-policy pattern
  (guide 9 `dental/policy.rs`, `paint.rs` as generic) — needs engine work → follows D11.
- **P5.11** Hard-edge finder tool (guide 2b last row; ABI `hard_edges`, `close_loop`) — engine work
  → D11; UI shows components coloured by length, click selects, a loop seeds a support area.
- **P5.12** Arrange several objects on the plate without overlap (`src/dental/arrange.ts` generic).
- **P5.13** Check `S:\ai\mixomesh\port\mixosupports\` (guide 10) for handed-over code; record the
  result.
- **P5.14** Bevel-robust edge detection in the shared engine (owner question 2026-10-29). Today the
  overhang *outline* is region-based (works on rounded edges), but internal ridges
  (`generic/placement/anchors.rs`, per-edge `angle_between > ridge angle`) and the hard-edge finder
  (`dental/topology.rs`, per-edge `|n1·n2| ≤ cos θ`) miss a turn spread over many small facets.
  Fix once in mixosupports `geometry-core` (D11): weld by position, segment faces into near-planar
  patches (normal tolerance), report patch boundaries whose patch mean normals differ by more than
  θ; anchors and `hard_edges` both use it, so dental and generic gain it together. *Depends:
  P5.11.* **Done when** a cube with a 0.5 mm fillet of 8+ segments yields the same 4 edge chains /
  anchor lines as the sharp cube, the dental reference keeps its θ 60° chains (110.2 mm, 56.1 mm),
  and the generic goldens are unchanged or re-baselined with an explained diff.
Each **done when** its golden/walk is green and the ledger row names it.

### P6 Gizmo update

Today: `src/core/scene/PivotSession.js` — Babylon `GizmoManager`, one exclusive mode
(translate / rotate / scale), snap via `SnapUnits.js`, undo committed in `_onGizmoDragEnd`.
- **P6.1** Plane handles: `positionGizmo.planarGizmoEnabled = true` (XY, YZ, XZ); a plane drag
  changes only its two axes; one undo step per drag on every handle. *Depends: P3.2.* **Done when**
  smoke: a plane drag changes exactly two axes and undoes in one step.
- **P6.2** Verify orbit stays off during every handle drag (Babylon `PointerDragBehavior`
  detaches camera controls) and add a pointercancel/blur guard if a drag can leak; gizmo colours
  (axes, hover, active) from mixo-app-style tokens; screen-constant size confirmed; gizmo hidden in
  Support Mode. *Depends: P6.1.* **Done when** smoke + screenshot. **Owner checkpoint 5** (gizmo feel).

### P7 React migration of existing panels

Order (small → large; one task each; the legacy file is deleted when its React twin passes):
Toast, Modal, ProgressOverlay, JobActivity, BootBanner, StatusBar, ViewportEmptyState,
ViewportToggles, ViewportToolbar, NavCube (DOM part), MeshStats, LocaleSwitcher, ScopeBreadcrumb,
CursorPanel, ContextMenu, ProjectMenu, SourcesModal, ImportError, Onboarding, RepairFeedback,
CopyPaste, FindMoved, ViewportDrop, SliceConnectorSession (UI part), ViewerMode, Outliner, AssetPanel,
ShaderPanel, ScenePanel, refinement/RefinementSection, print/* (ReadinessStrip, PrintSizes,
PrinterTab, ExportTab, CostBlock, PublishModel, PublishTab), PrintPanel, PropertiesPanel, Workspace,
PanelSheets, RenderFrame, AppShell. **P7.last** deletes `UiStyleSwitcher`, `src/ui/lib/*`,
`renderSafe.js` and any CSS no longer referenced (grep proof in the ledger).
Per panel, step 1: list the `index.html` root ids and the `subscribe` listeners the legacy file owns.
*Depends: P0.6 (each); serial.* **Done when** its existing tests/smokes pass (ported if they read
legacy DOM), kit-only controls, no `innerHTML`, screenshot (D5).

### P8 WASM geometry and export

Rule D18; inventory section 3.
- **P8.1** `scripts/bench-geometry.mjs`: JS vs WASM per function, corpus = cube, knot, the two
  heavy-mesh fixtures; median of 5; table in the ledger. *Depends: P1.2.* **Done when** every Tier A
  and Tier B module has a row (WASM column "n/a" until a WASM version exists).
- **P8.2** Wire functions the engine already has (see section 3 "Engine has") where P8.1 shows
  ≥1.1x. *Depends: P8.1.* **Done when** parity tests (P8.4) green for each switched path.
- **P8.3** New Rust in mixosupports `crates/geometry-core/src/generic/mesh/` (one module per op, Rust
  tests) for Tier A modules with no engine function, then Tier B loops, batched into one engine
  version bump per batch (D11). Export writers keep JS containers (zip, XML, text); only per-vertex /
  per-triangle loops move. *Depends: P8.1.* **Done when** each new function has a P8.1 row showing
  ≥1.1x and a parity test; slower ones are recorded and not wired. **Owner checkpoint 6** (P8 go/no-go
  on the benchmark table).
- **P8.4** Parity: per moved function, JS-vs-WASM equality on the corpus with its tolerance (weld
  order canonicalised, float epsilon stated). *With P8.2/P8.3.*

### P9 Close

- **P9.1** Full gates on a quiet machine: `npm test` (node + vitest), lint, typecheck, i18n:check,
  build, `test:all`, `test:electron`, `test:publish`, perf harness vs baseline. Fix failures.
- **P9.2** Final whole-diff review (Fable): correctness, D-rule compliance; findings fixed.
- **P9.3** Push mixomesh master and mixosupports main (D6), confirm CI and Pages deploy, ledger
  status done with the summary and the owner eyeball checklist; prompt the owner.
  **Owner checkpoint 7.**

---

## 3. WASM inventory

27 JS geometry modules (Codex inventory 2026-10-29; all 56 `path:line` citations verified).

Tier A — heavy, O(n log n) or worse:
| Module | Work | Engine has |
|---|---|---|
| `src/core/refinement/Topology.js` | weld + adjacency + subdivision, O(n·4^level), worker | — |
| `src/core/geometry/triangleBvh.js` | triangle BVH for picking, worker | `build_pick_index` |
| `src/core/repair/MeshRepair.js` | UV-aware rebuild after repair, components; up to O(n²) | — |
| `src/core/repair/GroupRepair.js` | union of parts, centroid owner lookup; up to O(n²) | — |
| `src/core/import/weld.js` | STL soup weld + crease normals, worker | `weld_positions_in_place`, `vertex_normals` |
| `src/core/repair/Weld.js` | distance weld + index remap | `weld_positions_in_place` |
| `src/core/repair/CapLoops.js` | boundary loops + caps | (generic topology from `dental/topology.rs`) |
| `src/core/MeshValidator.js`, `workers/MeshValidate.worker.js` | topology, orientation, thickness, groups | — |

Tier B — O(n) loops on the import/export path (move loops, keep containers/text in JS):
`src/core/import/stlParse.js` (engine has `BinaryStlSession`/`AsciiStlSession`),
`src/core/import/threeMFGeometry.js`, `src/core/print/ThreeMFWriter.js`, `PlyWriter.js`,
`ObjWriter.js`, `stlEncode.js`, `WrlWriter.js`, `PrintSpace.js` (reorient + signed volume),
`PrintCost.js`, `src/core/geometry/booleanCore.js`, `GeometryStore.js` (engine has
`transform_positions`), `src/core/print/UvTransform.js`, `src/core/scene/WorldExtents.js`,
`src/core/assets/MeshSplit.js`.

Tier C — stays JS unless the benchmark says otherwise: `src/core/GeometryCodec.js`,
`src/core/import/TriangleEstimate.js`, `src/core/scene/TriangleCount.js`,
`src/core/import/ThreeMFXml.js` (XML parsing).

Vendored MeshFix and Manifold stay.

---

## 4. Agent assignment (Fable, 2026-10-29)

| Task | Worker | Reason |
|---|---|---|
| P0.0 | haiku | ledger rows from the plan |
| P0.1 | sonnet | toolchain + CSP plugin |
| P0.2 | sonnet | store/command hooks |
| P0.3 | sonnet | extend CDP harness |
| P0.4a, P0.4b | sonnet each | kit split in two sessions |
| P0.5 | haiku | doc from existing code |
| P0.6 | sonnet | first panels + perf gate |
| P1.1 | sonnet (Ollama enumerates imports to rewrite) | copy + geometryClient rewrite |
| P1.2 | sonnet | golden harness |
| P2.1 | opus | handedness spike, empirical proof |
| P2.2 | sonnet | loader smokes |
| P3.1 | opus | data model + undo |
| P3.2 | sonnet | mode controller |
| P3.3 | opus | Babylon layers, picking |
| P3.4, P3.5, P3.6 | sonnet each | panels, worker, smokes |
| P4.1 | sonnet | migration |
| P4.2 | opus | export seam, 3MF structure, ratio rule |
| P4.3 | haiku | counts |
| P5.1–P5.8, P5.12 | sonnet each | one golden/walk each |
| P5.9 | Ollama draft → Gemini zh-Hant → haiku wiring | D8 |
| P5.10, P5.11 | opus (Rust) + sonnet (UI) | engine work |
| P5.13 | haiku | folder check |
| P6.1 | sonnet | gizmo handles |
| P6.2 | haiku | verify + tokens |
| P7 panels < 150 lines | haiku | mechanical |
| P7 others, P7.last | sonnet (Codex low for "who owns this root id") | |
| P8.1, P8.2, P8.4 | sonnet | bench, wiring, parity |
| P8.3 | opus (Rust) + sonnet (wiring) | |
| P9.1 | sonnet | gates |
| P9.2 | fable | diff review |
| P9.3 | main session | owner gate |

Parallel (∥, file-disjoint): P0.3 ∥ P0.4a ∥ P0.4b; P1.1/P1.2 ∥ P0.4a/P0.4b; P8.1 ∥ P3–P7;
P5.9 translation drafts ∥ anything. Serial: P0.1 → P0.2 → P0.6; P2.1 → P3.* → P4.* → P5.*;
P6 after P3.2; P7 after P0.6; P9 last.

Estimate: ~80 tasks → 30–40 worker sessions plus orchestration. Owner checkpoints 1–7 above; the
work continues past a checkpoint unless the owner stops it, and the checkpoint evidence is in the
ledger.
