# Plan: React UI, WASM geometry, support generation (2026-10-29)

Owner goal (2026-10-29): mixomesh moves its web UI layer to React (Babylon stays the 3D engine),
moves 3D geometry and export geometry to WASM where that is fastest, and gains the full support
generation of mixosupports as an isolated Support Mode that works only on the selected objects,
with the extra Roof and Cage settings. The 3D gizmo is updated. At the end: test, fix, push, tell
the owner.

Specs this plan builds on (read, do not duplicate):
- `docs/support-generation-port.md` — the support port guide (feature inventory section 2b, ABI
  section 3, editing UX section 5/5b, coordinates section 6, parity tests section 7).
- `docs/handoff/support-port.md` — step A1 done (engine 9 vendored with version gate).
- mixo-app-style skill (`~/.agents/skills/mixo-app-style/SKILL.md`) — the look. mixomesh already
  defaults to it (`data-ui-style` "new", `src/styles/style-new.css`).

Ledger: `docs/handoff/react-wasm-supports.md` (created by task P0.0). Every task updates it.

---

## 0. Directives (every agent, every task — non-negotiable)

Handoff and workflow:
- D1. Work on `master` in `S:\ai\mixomesh`. No branches, no git worktrees, no `git stash`, no
  `git checkout --` while other agents share the tree (a worktree removal followed the
  node_modules junction and deleted real dependencies twice).
- D2. One agent edits the tree at a time unless the task list marks tasks as file-disjoint.
- D3. Each task ends with: tests for the task green, `npm run lint`, `npm run typecheck`, a commit
  on master (message ends with the session attribution lines), and an updated ledger row in
  `docs/handoff/react-wasm-supports.md`: status, commit, what is verified, exact next step. The
  ledger is committed with the task. A task that is interrupted leaves a `WIP:` ledger row saying
  where it stopped.
- D4. Before reading source, query the graph: `graphify query "<q>"`; for mixosupports code use the
  cross-repo graph `graphify query "<q>" --graph graphify-out/port-graph.json`. Read only the
  lines the graph located. After code changes, `graphify update .`.
- D5. Never claim a UI works without evidence: a Playwright screenshot or smoke (`ui-screenshot.mjs`
  with `PROBE=1`, or a `tests/browser-*.mjs` smoke). Measure layouts at rest, after import settles.
- D6. Do not push until task P9.3. Pushing deploys GitHub Pages (owner gate, given for P9.3 only).

Owner product rules:
- D7. Printer-agnostic, texture-preserving export. Never build a slicer. Never name third-party
  slicers (or their brands) in UI, comments, docs or commit messages.
- D8. zh-Hant strings use Taiwan wording, translated through the Gemini skill
  (`python ~/.config/gemini/gemini_chat.py`); every new string exists in en, ja, zh-Hant
  (`npm run i18n:check`).
- D9. Export reads frozen full-resolution source bytes, never the GPU texture; never silently
  downscale textures; no unit or axis math outside the import seam (ImportNormalizer) and the
  export seam (ExportContext / PrintSpace).
- D10. Orientation and winding are verified empirically (trimesh / PrusaSlicer CLI, cull on/off
  screenshot), never by handedness reasoning alone.
- D11. The vendored engine in `public/vendor/mixo-geometry/` is never edited. Engine changes are made
  in mixosupports (`crates/geometry-core`), built there, and re-vendored with
  `npm run vendor:geometry`; `HOST_GEOMETRY_VERSION` changes with any ABI change.
- D12. Per-user settings persist through SettingsStore; `panelCollapsed` is tri-state (absent =
  defer to workspace); checkbox vs toggle rule (feature/mode/visibility = toggle button,
  sub-option = checkbox).

Architecture rules (new):
- D13. Three layers: React panels (UI) → commands + StateManager + logic → Babylon scene. React
  never holds meshes, textures or Babylon objects; props and store hold ids and settings only.
- D14. Per-frame values never go through React: gizmo deltas, pointer position, brush ring,
  ghost tip, camera. Babylon draws them; the store changes on commit (one undo step per drag).
- D15. Live UI → scene changes call the scene directly on input (no undo entry) and commit one
  command on release. Expensive rebuilds (support generation) are debounced, run in a worker,
  and carry a `revision`; stale results are dropped.
- D16. A panel subscribes only to the events and state slice it shows (`useStore` hook, P0.3).
- D17. New UI is built from the in-repo component kit `src/kit/` (P0.4). A control that is not in
  the kit is added to the kit (with its gallery entry) first, then used.
- D18. WASM moves are benchmark-led: a function moves only when the WASM path is at least as
  fast end to end (including copies) on the benchmark corpus, and its output matches the JS path
  (or the documented tolerance). A slower WASM path is reported, not shipped.

---

## 1. Architecture

```
src/kit/            React component kit (mixo-app-style look), gallery at /kit.html (dev only)
src/react/          mount adapter, store hooks, command hook, error boundary
src/panels/         React panels (one folder per panel), replace src/ui/*.js one by one
src/support-engine/ ported mixosupports logic (TypeScript, kept as .ts), engine loader (A1)
src/supports/       mixomesh support feature: model, commands, worker client, Babylon layers
src/core/           unchanged role: state, commands, scene, import/export seams
```

- Mount adapter: every legacy panel is `init(container)`. A migrated panel keeps that entry and
  renders `createRoot(container).render(<Panel/>)`, so AppShell, Workspace and PanelSheets do not
  change while panels move.
- Store hook: `useStore(events, selector, isEqual?)` on `useSyncExternalStore`, subscribing to the
  named `EVENTS` the selector depends on (StateManager has no generic change event).
- Commands: `useCommand()` returns the existing dispatcher (`createDispatcher`); React never calls
  `setState` directly.
- Language: new code is TypeScript (`.ts`/`.tsx`); legacy `.js` stays until migrated. Tests for
  `.ts`/`.tsx` run in vitest (+ jsdom, @testing-library/react); legacy `node --test` stays.
  `npm test` runs both.
- The washi "original" style is retired as panels migrate: React panels carry only the
  mixo-app-style look. The style switcher is removed when the last legacy panel is gone (P7.last).

---

## 2. Phases and tasks

Each task: goal, files, done-when. Model tier in brackets is the planned worker (section 4).

### P0 Foundation

- P0.0 Ledger `docs/handoff/react-wasm-supports.md` with every task row. [haiku]
- P0.1 Toolchain: `react@18`, `react-dom@18`, `@vitejs/plugin-react`, `vitest`, `jsdom`,
  `@testing-library/react`, `@types/react*`; tsconfig `jsx: react-jsx`, include `src/**/*.ts(x)`;
  eslint for ts/tsx (typescript-eslint, react-hooks rules); `npm test` = node tests + vitest;
  Electron build and CSP still pass (`npm run build`, `npm run test:electron`). [sonnet]
- P0.2 `src/react/mount.tsx` (mount, unmount, error boundary that reports through Status.js),
  `useStore`, `useCommand`, `useT` (i18n with LOCALE_CHANGED). Unit tests. [sonnet]
- P0.3 Perf harness: `tests/perf-gizmo-drag.mjs` — load the heavy fixture (4096² textured,
  high-poly), drag the gizmo for 3 s, record frame times; baseline numbers in the ledger. [sonnet]
- P0.4 Kit v0 `src/kit/`: Button (primary/danger/plain/icon), Segmented, Toggle, Check, Select,
  NumberField (drag-scrub, units mm/deg/×, min/max, NumberScrub behaviour), RangeField
  (slider + number, onInput/onCommit), ColorField, Section (collapsible, tri-state collapse, ↺ reset,
  ↧ copy-from-active), FieldRow, Modal, Toast (undo action), ProgressRow, KeyCaps, Notice
  (problem notice with actions row). Start from mixosupports `NumberField`, `RangeField`,
  `Segmented`, `CommandButton`, `KeyCaps`, `UndoToast`; style with mixo-app-style `tokens.css` /
  `base.css` (copied, never re-derived). Gallery `kit.html` (dev server only, not in the build) shows
  every component in every state. vitest per component. [sonnet]
- P0.5 `docs/ui.md`: the three layers, how to add a panel, how to add a kit control, the D13–D17
  rules with one example each. [sonnet]
- P0.6 Perf checkpoint: port one small panel (StatusBar) to React; perf harness shows no
  regression vs P0.3 baseline (frame-time p95 within 5%). Gate for P7. [sonnet]

### P1 Support engine logic (port step A2)

- P1.1 Spec in ledger: file list = guide section 8 "Logic" row minus dental (`src/editing/*`,
  `src/core/supports/settings.ts`, `zones.ts`, `src/supports/supportBuildWasm.ts`,
  `generateSupports.ts`, `contactEdits.ts`, `genericPolicy.ts`, `genericPlacement.ts`,
  `checkSupports.ts`, `islandProblems.ts`, `omittedProblem.ts`, `jobRunner.ts`, `landing.ts`,
  `unitSupports.ts`, `supportFrame.ts`, `export.ts` (support mesh part), `exportGate.ts`,
  `src/workers/meshProtocol.ts`, `meshWorker.ts`, `meshClient.ts`, `buildSessions.ts`,
  `geometryClient.ts` (engine init → `loadGeometryEngine`), `src/state/history.ts` only if needed).
  Copy as TypeScript into `src/support-engine/` keeping file names; drop dental mode, `dental.*`
  commands/keys and every `src/dental/` import; generic parts of `src/dental/` listed in guide
  section 9 come over under neutral names when a later task needs them. [sonnet]
- P1.2 Copy the matching `*.test.ts` (dental cases removed) and the generic goldens
  (`src/goldens/` cube-overhang, knot, thin-slab, v-ridge; default, tree, roof, ridge) — the goldens
  run against the vendored `pkg-browser` through `initSync` in vitest. All green. [sonnet]

### P2 Spike (port step A3)

- P2.1 One selected mesh → worker job → `generate` → tips drawn in Babylon. Decide the handedness
  rule (guide section 6; preferred: convert at one adapter `src/supports/frame.ts`), prove it with the
  cube-overhang golden (same counts) and an empirical check (D10). [opus]
- P2.2 Prove engine loading in the dev server, the production build and Electron `file://`
  (`tests/browser-support-engine-smoke.mjs`, `--electron`). [sonnet]

### P3 Support Mode (isolated mode)

Behaviour contract (owner 2026-10-29 + guide sections 5, 5b, 8):
- Enter: toolbar button "Supports" and `Ctrl+Shift+5`-free key (pick one not Chrome-reserved),
  enabled when ≥1 object is selected. The mode works on the selected objects only (logical objects,
  multi-shader groups count as one).
- Isolation: every non-selected object is hidden (visibility stored and restored on exit; not an
  undo step; not saved; never affects export); panels not used by the mode (Outliner editing,
  Shade, Scene, Print, Asset panels) are dimmed and inert (`inert` + reduced opacity), the Support
  panel opens in their place; the header shows "Support Mode — N objects" and Done / Esc exits.
  Gizmo is off inside the mode.
- Exit restores visibility, panels, camera (optional) and selection. Supports stay on their
  objects.
- Inside: the mixosupports generic UI (guide 5b A, B, C): Settings (presets Light / Middle / Heavy /
  Custom; tips, neck, pillar, foot; Tree / Auto tree; Brace; Raft; Label; **Roof**; **Cage**),
  Support area (Paint | Erase, brush mm), Edit (Add / Select tools, Click / Drag over, circle size,
  Shift flips, Delete, Esc, right-click/Ctrl+click remove, ghost tip, remove ring, crosshair while
  adding, tool name with what a click does), per-support tip overrides (reset, select customised),
  view toggles (Tips only, Bottom view, Fit view), problem list with Show and Fix, Generate /
  Regenerate, undo/redo with toasts, job progress.
- Several selected objects: each object has its own supports (unit), generated independently.

Tasks:
- P3.1 Data model: `object.supports = { settings, presetName, deleted ids, manual contacts,
  overrides, zone stamps, revision }` in state (unit-local, mm), support mesh kept in a runtime
  cache (not state). Commands for every edit (one undo step each) through HistoryManager. [opus]
- P3.2 Mode controller `src/supports/SupportMode.ts`: enter/exit, isolation (hide/restore, dim
  panels via one `data-mode="supports"` attribute on the shell), key handling from ported
  `keys.ts`, Esc order (selection → mode). [sonnet]
- P3.3 Babylon layers `src/supports/layers/`: support mesh (one material per part kind, shared,
  never recompiled per preview), tips-only mesh, ghost tip, remove ring, brush ring (screen space),
  zone stamp overlay (stamped triangles only), selection highlight; picking via the engine
  (`rustRaycast` port). [opus]
- P3.4 React panels `src/panels/supports/`: SupportPanel (settings), EditBar, ZonesBar,
  SurfaceBrushBar, ProblemList, ViewToggles — rebuilt from the mixosupports `.tsx` with the kit.
  [sonnet]
- P3.5 Live generation: debounced worker jobs with revision (ported `useRegenerate`), stale results
  dropped, problem list greys until the new verdict lands; repair budget ≥ 3 so brace pruning runs
  (guide 2b row "Cross-braces"); notice `brace-pruned`. [sonnet]
- P3.6 Walk smokes `tests/browser-supports-*.mjs`: guide section 7 scenarios a1–a5, c, d, e, f1–f4, g,
  i1–i3 rewritten for mixomesh, plus isolation (enter hides others, exit restores, export
  unaffected). [sonnet]

### P4 Persistence and export

- P4.1 `.mixo` save/open keeps every support edit (project version bump + migration; old files load
  with no supports). Autosave included. [sonnet]
- P4.2 Export through the export seam: per object "printable" (model + supports welded as separate
  shells in one object) and "supports only"; supports in the model's frame; ExportContext gains
  `includeSupports`; 3MF / STL / OBJ writers unchanged except taking the extra mesh; supports have
  no texture (solid colour). Export gate: unresolved problems warn (strictExport blocks).
  `test:consumers` gains a supported cube row. [opus]
- P4.3 Cost quote and triangle budget count supports. [haiku]

### P5 Remaining support features (guide 2b)

One task per row, each with its golden or walk scenario: P5.1 Tree / Auto tree / safe distance;
P5.2 Brace with pruning; P5.3 Raft; P5.4 Label (text rules: 8 chars A–Z 0–9 -); P5.5 Roof;
P5.6 Cage; P5.7 islands check + Show / Fix; P5.8 low-poly preview + `decimate_display` for heavy
models; P5.9 i18n of every support string (en/ja/zh-Hant, D8). [sonnet each]

### P6 Gizmo update

Today: `src/core/scene/PivotSession.js` uses Babylon `GizmoManager` with one exclusive mode
(translate / rotate / scale), snap via `SnapUnits.js`, undo committed in `_onGizmoDragEnd`.
- P6.1 Plane handles: enable `positionGizmo.planarGizmoEnabled` (XY, YZ, XZ squares) so a drag is
  locked to that plane. [sonnet]
- P6.2 Orbit off while any gizmo part is dragged (camera inputs detached on drag start, restored on
  drag end, also on pointer cancel / blur). [sonnet]
- P6.3 Look: axis colours and hover/active colours from mixo-app-style tokens; handle size constant
  in screen space; gizmo hidden in Support Mode. [sonnet]
- P6.4 One undo step per drag on every handle (incl. plane handles); typed input in TransformSheet
  unchanged; smoke for a plane drag (only the two plane axes change). [sonnet]

### P7 React migration of existing panels

Order (small → large, each a separate task, legacy file deleted when its React twin passes):
StatusBar (P0.6), Toast, Modal, ProgressOverlay, JobActivity, BootBanner, ViewportEmptyState,
ViewportToggles, ViewportToolbar, NavCube (DOM part), StatsHud, MeshStats, LocaleSwitcher,
ScopeBreadcrumb, CursorPanel, TransformSheet, ContextMenu, ProjectMenu, SourcesModal, ImportError,
Onboarding, Outliner, AssetPanel, ShaderPanel, ScenePanel, print/* (ReadinessStrip, PrintSizes,
PrinterTab, ExportTab, CostBlock, PublishModel, PublishTab), PrintPanel, PropertiesPanel, Workspace,
PanelSheets, AppShell. Last task (P7.last): remove the style switcher and the "original" CSS,
delete `src/ui/lib/*`, `renderSafe.js` once unused.
Per panel, done when: same behaviour (its existing smokes and tests pass unchanged or are ported),
uses only kit controls, no `innerHTML`, screenshot evidence (D5). [sonnet each; haiku for panels
under 150 lines]

### P8 WASM geometry and export

Rule D18. Inventory (section 3) lists every JS geometry module.
- P8.1 Benchmark harness `scripts/bench-geometry.mjs`: JS vs WASM per function on the corpus
  (cube, knot, heavy textured scan, 1M-triangle mesh), output table in the ledger. [sonnet]
- P8.2 Use engine functions that already exist (weld, vertex normals, transforms, decimate, STL
  reader, pick index) for the matching mixomesh paths. [sonnet]
- P8.3 New Rust functions for the rest, added in mixosupports `crates/geometry-core/src/generic/mesh/`
  (one module per op, Rust tests, engine_version bump), built and re-vendored (D11); mixomesh
  bumps `HOST_GEOMETRY_VERSION` and switches the call. Export writers keep their JS container code
  (zip, XML); only per-vertex/per-triangle loops move. [opus for the Rust, sonnet for wiring]
- P8.4 Parity: every moved function has a JS-vs-WASM equality test on the corpus. [sonnet]

### P9 Close

- P9.1 Full gates on a quiet machine: `npm test` (node + vitest), lint, typecheck, i18n:check,
  build, `test:all`, `test:electron`, `test:publish`, perf harness vs baseline. Fix failures. [sonnet]
- P9.2 Final review of the whole diff (Fable): correctness, D-rule compliance; findings fixed.
- P9.3 Push master (D6 owner permission for this task), confirm CI and Pages deploy, update
  handoff memory, prompt the owner with the summary and the eyeball checklist.

---

## 3. WASM inventory

27 JS geometry modules (Codex inventory 2026-10-29, all 56 `path:line` citations verified against
the source). "Engine has" = a function already in the vendored engine (P8.2).

Tier A — heavy, O(n log n) or worse, largest expected win:
| Module | Work | Engine has |
|---|---|---|
| `src/core/refinement/Topology.js` | weld + adjacency + subdivision, O(n·4^level), worker | — |
| `src/core/geometry/triangleBvh.js` | triangle BVH for picking, worker | `build_pick_index` |
| `src/core/repair/MeshRepair.js` | UV-aware rebuild after repair, components; up to O(n²) matching | — |
| `src/core/repair/GroupRepair.js` | union of parts, centroid owner lookup; up to O(n²) | — |
| `src/core/import/weld.js` | STL soup weld + crease normals, worker | `weld_positions_in_place`, `vertex_normals` |
| `src/core/repair/Weld.js` | distance weld + index remap | `weld_positions_in_place` |
| `src/core/repair/CapLoops.js` | boundary loops + caps | (topology in `dental/topology.rs`, port as generic) |
| `src/core/MeshValidator.js`, `workers/MeshValidate.worker.js` | topology, orientation, thickness, group validation | — |

Tier B — O(n) loops on the import/export path (move the loops, keep containers/text in JS; WASM
must beat JS including copies, D18 — text formatting writers may stay JS):
`src/core/import/stlParse.js` (engine has `BinaryStlSession`/`AsciiStlSession`),
`src/core/import/threeMFGeometry.js`, `src/core/print/ThreeMFWriter.js`, `PlyWriter.js`,
`ObjWriter.js`, `stlEncode.js`, `WrlWriter.js`, `PrintSpace.js` (reorient + signed volume),
`PrintCost.js`, `src/core/geometry/booleanCore.js`, `GeometryStore.js` (engine has
`transform_positions`), `src/core/print/UvTransform.js`, `src/core/scene/WorldExtents.js`,
`src/core/assets/MeshSplit.js`.

Tier C — trivial or text parsing, stays JS unless the benchmark says otherwise:
`src/core/GeometryCodec.js`, `src/core/import/TriangleEstimate.js`, `src/core/scene/TriangleCount.js`,
`src/core/import/ThreeMFXml.js` (XML parsing).

Order inside P8: Tier A first (P8.2 engine-backed ones, then P8.3 new Rust), then Tier B, each with
its parity test (P8.4). Vendored MeshFix and Manifold stay as they are.

---

## 4. Agent assignment (economy)

| Work | Worker |
|---|---|
| Mechanical enumeration, counts, string extraction, translation drafts | local Ollama (`run.py`), verified |
| Repo-wide "where is X" reads with short answers | Codex `task --effort low` |
| Bounded code tasks with clear done-when (most P0, P1, P3.2/3.4–3.6, P4.1, P5, P6, P7, P8.1/8.2/8.4) | sonnet subagent |
| Tiny tasks (ledger, small panels, cost quote) | haiku subagent |
| Hard design-in-code (P2.1 handedness spike, P3.1 data model, P3.3 Babylon layers, P4.2 export, P8.3 Rust) | opus subagent |
| Plan review and final diff review | Fable |
| Verification of every result, decisions, plan changes | main session |

One editing agent at a time on the tree (D2); read-only reviewers may run in parallel.
