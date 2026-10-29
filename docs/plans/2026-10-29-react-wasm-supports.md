# Plan: React UI, WASM geometry, support generation (2026-10-29)

Owner goal (2026-10-29): mixomesh moves its web UI layer to React (Babylon stays the 3D engine),
moves 3D geometry and export geometry to WASM wherever that is faster, and gains the full support
generation of mixoDental as an isolated Support Mode that works only on the selected objects,
with the extra Roof and Cage settings. The 3D gizmo is updated. The engine and the renderer-free
support editing logic move to a shared private repo both apps consume. At the end: test, fix, push
the three repos, tell the owner.

Status: **revision 3** (2026-10-29). Consolidates rev 2 (reviewed by Fable + egm design / readiness /
zoom-out) and the same-day owner decisions: shared repo `mixocreative/mixo-geocore`, `ViewportPort`
(D22), benchmark gate ≥1.1x (D18), Support Mode scope, gizmo update, push at the end (P9.3
pre-authorised). Done per ledger: P0.0, P0.1, P0.2, P0.3 (partial), P0.4a, P1.1.
Retired ids: **P1.2 → PE.2** (tests + goldens run in mixo-geocore). New ids: **P0.3b**.

Specs this plan builds on (read, do not duplicate):
- `docs/support-generation-port.md` — the support port guide (inventory 2b, ABI 3, settings 4,
  editing UX 5/5b, coordinates 6, parity tests 7, moves 9, handed-over code 10). Where this plan
  differs, this plan wins and says so (guide 8's esbuild step, `vendor/mixo-geometry/` path, 2x rule,
  `useRightHandedSystem` option are all superseded here).
- mixo-app-style skill (`~/.agents/skills/mixo-app-style/SKILL.md`) — the look. mixomesh already
  defaults to it (`data-ui-style` "new", `src/styles/style-new.css`).

Ledger: `docs/handoff/react-wasm-supports.md`. It replaces `docs/handoff/support-port.md`
(A1 done; A2→P1.1/PE.2, A3→P2, A4/A5→P3/P4, A5b→P5, A6→P4.1, A7→P8).

---

## 0. Directives (every agent, every task)

Handoff and workflow:
- D1. Three repos, one branch each, local commits only: mixomesh `master` (`S:\ai\mixomesh`),
  mixo-geocore `main` (`S:\ai\mixo-geocore`), mixoDental `main` (`S:\ai\mixodental`). No
  feature branches, no git worktrees, no `git stash`, no `git checkout --`. Never touch
  mixoDental' untracked files. Each task names the repo it edits; a task that edits two repos
  commits in each.
- D2. One editing agent at a time, except pairs marked ∥ in section 4 (file-disjoint). Read-only
  reviewers may run any time.
- D3b. Agents never kill processes by image name (`taskkill /IM chrome.exe` closed the owner's browser on 2026-10-29); stop only
  PIDs the agent started itself, and never touch the owner's editors, browsers, Codex/Claude sessions or Ollama.
- D3. Each task ends with its repo's gates green (mixomesh: tests, `npm run lint`,
  `npm run typecheck`; mixo-geocore: `cargo test`, wasm build, vitest; mixoDental: its `npm test`)
  and one commit (message ends with the session attribution lines). The agent reports back: commit,
  what is verified (commands + results), exact next step. The main session alone writes the ledger
  row and commits it. An interrupted agent reports `WIP:` with where it stopped and what is
  uncommitted.
- D4. Query the graph before reading source: `graphify query "<q>"`; mixoDental code via
  `graphify query "<q>" --graph graphify-out/port-graph.json` (refresh the merged graph first:
  `graphify update S:\ai\mixodental; graphify merge-graphs graphify-out/graph.json S:\ai\mixodental\graphify-out\graph.json --out graphify-out/port-graph.json`;
  from PE.1 on, merge `S:\ai\mixo-geocore\graphify-out\graph.json` too). Read only located lines.
  After code changes, `graphify update .` in the repo edited.
- D5. Never claim a UI works without evidence: a Playwright screenshot or smoke (`ui-screenshot.mjs`
  with `PROBE=1`, or `tests/browser-*.mjs`). Measure layouts at rest, after import settles.
- D6. No push of any of the three repos until P9.3 (pushing mixomesh deploys GitHub Pages; owner
  pre-authorised P9.3 on 2026-10-29). Until then mixomesh and mixoDental vendor from a local
  build of a committed mixo-geocore commit.

Owner product rules:
- D7. Printer-agnostic, texture-preserving export. Never build a slicer. Never name third-party
  slicers or their brands in UI, comments, docs or commit messages.
- D8. Every new string in en, ja, zh-Hant (Taiwan wording, via the Gemini skill
  `python ~/.config/gemini/gemini_chat.py`); `npm run i18n:check` green.
- D9. Export reads frozen full-resolution source bytes, never the GPU texture; never silently
  downscale textures; unit/axis math only in the import seam (ImportNormalizer), the export seam
  (ExportContext / PrintSpace) and the support frame adapter (`src/supports/frame.ts`, P2.1).
- D10. Orientation and winding are verified empirically (trimesh / PrusaSlicer CLI `--info`, cull
  on/off screenshot), never by handedness reasoning alone. The scene stays left-handed:
  `scene.useRightHandedSystem` is never set (it would invalidate ImportNormalizer, PrintSpace
  signed volume, NavCube and the orientation smokes).
- D11. The shared engine is the private repo `mixocreative/mixo-geocore` (owner decision
  2026-10-29): Rust core (`geometry-core`, `geometry-wasm`; generic and dental), `host/` (TS that
  must match the ABI), `editing/` (renderer-free support editing logic), Rust tests, generic and
  dental goldens, parity and bench tools. No UI, no renderer, no app glue. Engine changes happen
  only there and ship as a tag `v<engine_version>` with built `pkg-browser`, `pkg-node`, `host/`,
  `editing/` and `SHA256SUMS` as release assets; any ABI change bumps `engine_version()` and
  `HOST_GEOMETRY_VERSION` (in `host/`) together. Each app pins one release (`npm run vendor:geometry
  -- --release v<N>` or `--from <local checkout>`, hash-checked) and upgrades deliberately; vendored
  folders are never edited by hand; a vendor bump is one app commit.
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
- D17. New UI uses the kit `src/kit/` (CSS scoped under `.mx-kit` via the generated
  `kit.scoped.css`). A missing control is added to the kit (component, vitest, gallery entry) first.
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
- D21. One undo stack: HistoryManager. The ported `editing/session.ts` reducer is pure view/tool
  state; mixoDental' undo history (`state/history.ts`) is not ported.
- D22. mixo-geocore imports no renderer, UI framework or DOM (no babylon, three, react, react-dom,
  `document`, `window`). Apps reach `editing/` through plain data and the `ViewportPort`
  interface (screen point → ray, world point → screen, pick through the engine session, viewport
  size/DPR, pointer records); all drawing (rings, ghost tips, overlays, highlights) stays in the app.
  Enforced by lint `no-restricted-imports` and a test (PE.2).
- D23. Web first (owner 2026-10-29): the web app on GitHub Pages is the primary product; every feature is
  built and verified on the web first (dev server + production build smokes). mixomesh keeps its desktop build as
  a secondary target: one codebase, the web build plus the
  Electron wrapper with its desktop-only features (automation API / batch jobs / --open, Listbridge
  publishing, installer, heap flag). Every task keeps the Electron build and its smokes green; nothing
  is removed for being desktop-only. mixoDental is web-only (Vite, no Electron) and stays web-only.
- D24. Memory first (owner 2026-10-29: 3D print files can be very large). Every import, geometry, support and export
  path is designed for the lowest peak memory: stream instead of building whole files (no full-file strings or
  buffers; 3MF via streamed zip, STL/OBJ written in chunks), keep mesh data in typed arrays or WASM memory (never
  arrays of objects per vertex), move buffers between threads as transferables (no copies), free WASM handles and
  caches as soon as a step ends, process large models in chunks or across workers rather than one giant buffer, and
  never hold two full copies of a large mesh when one will do. Tasks that touch heavy data report peak memory (JS heap
  + WASM + process) on the large fixtures next to time; a change that raises peak memory needs a stated reason.
- D25. Real-scan regression gate (2026-10-29: engine 10's 1 µm snap collapsed sub-micron edges and rejected valid
  customer scans; the owner found it, the gates did not). Every engine change (any mixo-geocore commit that changes
  geometry-core, geometry-wasm or host behaviour) runs ALL locally available real scans — mixoDental
  `dentalwork/fixtures/case-*/*.stl`, its `docs/dental-reference/` aligner, and mixomesh `tests/fixtures/real-scans/`
  — through both apps' pipelines (mixoDental batch review incl. run-batch-review.bat; mixomesh support generation)
  on the old and the new engine, and compares accepted/rejected, verdict, tip counts and timing. Any rejection of a
  scan the old engine accepted, or an unexplained count change, blocks the change. Scans stay local and git-ignored
  (customer data: read in place, never committed or named in commits); a run without them is reported as NOT DONE,
  never as passed. Coordinate quantisation must never change mesh topology (explicit test with sub-micron edges).
- D26. Every step is reasonably modularised (owner 2026-10-30): each new rule or algorithm lives in its own clearly
  named module with one responsibility (e.g. overlap → `core/overlap.rs`; denture → `dental/denture/`; the owner's
  orientation method → `dental/orient/` with trim plane, U ends, back direction, cross-check as separate units and
  one small orchestrator); no growing of large existing functions; each unit has doc comments (inputs, units, frame)
  and its own tests; folder README + the root "where do I look" table updated with every new module.

---

## 1. Architecture

```
mixo-geocore (S:\ai\mixo-geocore, private, releases v<N>)         — D11, D22
  crates/geometry-core, crates/geometry-wasm   Rust engine, generic + dental, engine_version()
  host/        ABI-bound TS: settings layout + packer, result decoder, contact/shape strides,
               geometryVersion (HOST_GEOMETRY_VERSION), engine loader (version check), worker
               protocol + worker body, buildSessions, geometryClient, support-mesh export encoder
  editing/     renderer-free support editing: session reducer, commands, keys, pick, stroke,
               strokeQueue, surfaceBrush, screenBrush, brushScheduler, selection, removal,
               regenerate/rekey, shapeEdit, add-tip snapping, zones, contactEdits, landing,
               problems (islands, omitted), arrange; ViewportPort.ts = the only 3D seam
  goldens/, host + editing vitest, scripts/ (build, smoke, bench), tools/blender-parity/

mixomesh (consumer)
  public/vendor/mixo-geocore/   pkg-browser (wasm + glue), VERSION, SOURCE.json — static, runtime-loaded
  vendor/mixo-geocore/          host/ + editing/ as built JS + .d.ts — bundled by Vite, alias @mixo-geocore/*
  src/support-engine/           app glue only (after PE.2): loadGeometry.js (engine URL per runtime:
                                dev / build / Electron file://, calls the host loader),
                                meshWorker.entry.ts (Vite worker entry over the host worker body)
  src/supports/                 the feature: frame.ts (handedness + weld), model + commands,
                                SupportMode, BabylonViewportPort + layers, live generation
  src/panels/supports/          React Support Mode panels (kit)
  src/kit/   src/react/   src/panels/   src/core/   as in P0 (kit, hooks, migrated panels, core)

mixoDental (consumer from PE.5): same vendor layout, three.js ViewportPort, dental UI stays there
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
  vitest (two projects: `.ts` node, `.tsx` jsdom + @testing-library/react); legacy `node --test`
  stays; `npm test` runs both.
- Support data flow: selected logical object → `frame.ts` (weld by position, handedness flip) →
  host worker (`generate`, revision) → host decoder → `src/supports/layers/` draw; edits go
  `editing/` reducer + commands → HistoryManager (D21) → debounced regenerate (D15).
- Style: the "original" (washi) option is removed at P0.6; from then on everything is mixo-app-style.

---

## 2. Phases and tasks

Format: **id** goal. Files. *Depends.* **Done when.** Repo = mixomesh unless the task says
`[geocore]` or `[mixodental]`. Worker per section 4.

Executable order: P0 → PE.1 → PE.2 → PE.4 → (PE.3 ∥ PE.5) → P2 → P3 → P4 → P5 → P6 → P7 → P8 →
P9. P0.4b/P0.6/P0.5 run ∥ PE.1/PE.2 (file-disjoint); P7 runs ∥ P5/P6; P8.1 runs ∥ P3–P7.

### P0 Foundation

- **P0.0** done. Ledger `docs/handoff/react-wasm-supports.md`, one row per task id, support-port
  ledger marked superseded.
- **P0.1** done (f5020db). React 19 toolchain, vitest two projects, eslint ts/tsx, serve-only CSP
  preamble; build CSP byte-identical.
- **P0.2** done (48df345). `src/react/`: `mountPanel`, `useStore`, `useCommand`, `useT`, error
  boundary through `Status.js`; 5 vitest.
- **P0.3** done partial (f2a283b). `gizmoDragFrameMs` added to `scripts/heavy-mesh/measure.mjs`;
  frame intervals for 1M/5M pillows sit at the 16.7 ms vsync cap, so they cannot show a 5%
  regression. The gate metric is P0.3b.
- **P0.3b** Gate metric. `measure.mjs` records `cpuFrameMs` (Babylon `EngineInstrumentation`
  `frameTimeCounter`, per frame, mean + p95) and `reactCommitMs` (dev-only `React.Profiler`
  `onRender` durations, summed per run) during orbit and the 3 s scripted gizmo drag;
  `generate.mjs` gains a 4096² textured fixture (UV-mapped pillow + 4096² PNG, glTF or 3MF).
  *Depends: P0.3, P0.2.* **Done when** median of 5 of `cpuFrameMs` (orbit, gizmo) and
  `reactCommitMs` on pillow-1M, pillow-5M and the 4096² textured fixture are in the ledger as the
  baseline and none sits at a vsync plateau.
- **P0.4a** done (a4a506a). Kit fields Button, Segmented, Toggle, Check, Select, NumberField,
  RangeField, ColorField; vitest each; gallery; CSS scoped under `.mx-kit` (`kit.scoped.css`,
  generated, freshness test).
- **P0.4b** Kit containers: Section (collapsible, tri-state collapse, ↺ reset, ↧ copy-from-active),
  FieldRow, Modal, Toast (with undo action), ProgressRow, KeyCaps, Notice (problem notice, actions
  on their own row). Same CSS source as P0.4a. *Depends: P0.4a.* **Done when** vitest per component
  (render, keyboard, actions), gallery shows each in default / hover / disabled / active,
  screenshot in ledger.
- **P0.6** First panels in React: StatsHud and TransformSheet (live transform values), kit only;
  remove the "original" style option and its CSS (`style-new.css` rules become the only style).
  *Depends: P0.2, P0.3b, P0.4a, P0.4b.* **Done when** their existing tests/smokes pass, the React
  profiler records zero commits of unrelated panels during a gizmo drag, `cpuFrameMs` mean (median of 5) rises by at most max(0.1 ms, 10%) over the P0.3b baseline on all three fixtures (P0.3b: timer resolution 0.1 ms makes p95 jump 8-15%), and `reactCommitMs` during
  the drag is reported. **Owner checkpoint 1** (kit look, perf).
- **P0.5** `docs/ui.md`: the three layers, how to add a panel, how to add a kit control, D13–D17
  with one example each. *Depends: P0.6.* **Done when** the examples match the P0.6 code.

### P1 Support engine logic (port into mixomesh, then re-homed by PE.2)

- **P1.1** done (624a34b). 66 files copied as TypeScript into `src/support-engine/` with
  `PORTED.md` (dental mode, `dental.*` commands/keys, undo history removed per D21;
  `geometryClient.ts` rewritten on `loadGeometryEngine`). These files are the source PE.2 moves
  into mixo-geocore; mixomesh does not build on them directly.
- ~~P1.2~~ retired → PE.2.

### PE Shared engine repo mixo-geocore (owner decision 2026-10-29: private, both apps switch)

- **PE.1** `[geocore]` Create `S:\ai\mixo-geocore` from mixoDental main (`adbe7c3` or later):
  `git subtree split --prefix=crates` keeps the engine history; then one commit adds
  `scripts/build-geometry-wasm.mjs`, `scripts/geometry-wasm-smoke.mjs`,
  `scripts/geometry-wasm-bench.mjs`, `scripts/host-example.mjs`, `tools/blender-parity/`, the golden
  snapshots and fixtures, `package.json` (wasm-pack, vitest, eslint), `README.md`, `AGENTS.md`
  (engine rules: version bump on any ABI change, never break a pinned app silently, D22). Create the
  private GitHub repo `mixocreative/mixo-geocore` (`gh repo create --private`), add the remote, do
  not push (D6). *Depends: —.* **Done when** `cargo test` and the wasm build pass in the new repo
  and `engine_version()` is 9.
- **PE.2** `[geocore]` + mixomesh. Move the P1.1 files (`src/support-engine/`, per `PORTED.md`)
  into two packages:
  - `host/` — ABI-bound: `supportBuildWasm.ts` + `settings.ts` (layout + packer),
    `generateSupports.ts` (decoder, `PolicyHandle`), strides mirroring `flat.rs`,
    `geometryVersion`, `loadGeometryEngine` (version check), `meshProtocol`, `meshWorker` (body),
    `meshClient`, `buildSessions`, `geometryClient`, `jobRunner`, `jobs`, `jobGate`, `budget`,
    `supportEngine`, `supportFrame`, `unitSupports`, `checkSupports`, `export.ts` support-mesh
    encoder, `core/analysis/*`, `meshQuery`, `transform`, `vec3`, `WorkerTask`, `serveTask`,
    `sourceCache`, `jobActivity`.
  - `editing/` — renderer-free (owner: select paint, area paint, add support, everything 3D that is
    shared): `session` reducer, `commands`, `keys`, `locks`, `pick`, `stroke`, `strokeQueue`,
    `surfaceBrush`, `screenBrush`, `brushScheduler`, `dragOver`, `hoverProbe`, `gesture`,
    `selection`, `selectionHighlight` (data only), `removal`, `regenerate`, `shapeEdit`, `check`,
    `status`, `toast` (data), `view`, `numberInput`, `project`, `types`, `errors`, `zones`,
    `contactEdits`, `landing`, `islandProblems`, `omittedProblem`, `genericPolicy`,
    `genericPlacement`, add-tip snapping (from mixoDental `App.tsx` `addTip`: click reach, snap
    to `suggested_points` + `candidate_points`, upward-face warning), `arrange` (from
    `src/dental/arrange.ts`, generic). `ViewportPort.ts` is the only way this code reaches a view
    (D22); each app implements it.
  - D22 enforcement: eslint `no-restricted-imports` + a vitest that no file in `host/` or
    `editing/` imports babylon, three, react, react-dom or references `document`/`window`.
  - Tests: the mixoDental `*.test.ts` of every moved file (dental cases removed), `editing/uiFixture.ts`,
    `genericParity.test.ts`, `supportBuildParity.test.ts`; goldens `goldens.test.ts` + `fixtures.ts`
    + `pipeline.ts` with a `goldenImport.ts` on `pkg-node` `BinaryStlSession` (replaces
    `scripts/test-support/rustImport.ts` and its three.js glTF types).
  - mixomesh side: `src/support-engine/` shrinks to `loadGeometry.js` + `meshWorker.entry.ts`;
    `PORTED.md` is replaced by a pointer to mixo-geocore; imports go through `@mixo-geocore/*`
    (vendored by a `--from S:\ai\mixo-geocore` run of the existing script; PE.4 finishes the script).
  *Depends: P1.1, PE.1.* **Done when** host + editing vitest and the 4 fixtures (cube-overhang,
  knot, thin-slab, v-ridge) × 4 variants (default, tree, roof, ridge) match the mixoDental
  snapshots exactly, the D22 test passes, and mixomesh typecheck + `npm test` are green on the
  vendored copy.
- **PE.4** mixomesh `scripts/vendor-geometry.mjs`: `--release v<N>` (`gh release download`, verifies
  `SHA256SUMS`) and `--from <local mixo-geocore>` (builds, copies, records commit); renames
  `public/vendor/mixo-geometry/` → `public/vendor/mixo-geocore/` (pkg-browser, VERSION,
  SOURCE.json with repo + tag/commit); writes `vendor/mixo-geocore/{host,editing}` (built JS +
  `.d.ts`); tsconfig/Vite alias `@mixo-geocore/*`; `--check` verifies hashes; `.gitattributes`
  marks vendored folders generated. npm script name `vendor:geometry` unchanged. *Depends: PE.2.*
  **Done when** `--from` then `--check` pass, `npm test` and `test:electron` green, no hand-edited
  file remains under either vendored folder (script output is byte-identical to the checkout).
- **PE.3** `[geocore]` CI (GitHub Actions): cargo test, wasm build (both packages), generic +
  dental goldens, host + editing vitest, D22 test; a tag `v<N>` builds and attaches `pkg-browser`,
  `pkg-node`, `host/`, `editing/`, `SHA256SUMS`. *Depends: PE.2.* **Done when** a scripted local dry
  run of every workflow step passes and the release job is reviewed (it runs for real at P9.3).
- **PE.5** `[mixosupports]` consume the shared engine: remove its `crates/` and the TS that moved
  to `host/`/`editing/`, vendor the release with the PE.4 script pattern, implement its three.js
  `ViewportPort`, point `wasm:build`/`pretest`/`prebuild`/`prewalk` at the vendored packages;
  dental Rust stays in the engine's `dental` module (one engine for both). Run its `npm test`, wasm
  smoke and walks (`scripts/walk.mjs`). Commit on its `main`. *Depends: PE.4.* **Done when**
  mixoDental' tests and walks are green on the vendored engine and its `crates/` is gone, and
  its exports are byte-identical before and after the switch (export walks c, d and a dental
  export on its reference model: hash of the written STL/3MF compared; any change is a defect).

- **PE.5b** `[geocore]` + `[mixodental]` Remove mixosupports' remaining duplicates (PE.5 found ~25
  generic modules kept locally because PE.2 stripped dental fields). (1) `host/` gains the dental
  ABI bindings (`DentalPolicy`, `dental_policy`, profile types/loading, dental job fields) — they are
  engine contract, the dental algorithms already live in geocore's `dental` module; (2) `editing/`
  gains extension points: a mode/tool registry and policy hooks so an app adds modes (mixoDental's
  dental steps, paint/erase allowed area) without forking `session`, `commands`, `keys`, `gesture`,
  `surfaceBrush`; (3) mixoDental deletes its local copies, imports the packages, keeps only
  dental flow/UI, and wires its three.js `ViewportPort` into its components. *Depends: PE.5.*
  **Done when** mixoDental holds no copy of a geocore module (a script diffs file lists and fails on
  overlap), its tests, walks and build are green, its exports are byte-identical to the PE.5
  baseline (two walk runs; PE.5 saw one pointer-timing flake in the drag-over scenario), and mixomesh
  re-vendored to the new geocore commit is green.
- **PE.6** `[mixodental]` Rename mixosupports → mixoDental (owner 2026-10-29; not distributed yet,
  so app identity may change freely). GitHub `mixocreative/mixodental` → `mixocreative/mixodental`
  (`gh repo rename`, redirects stay); local folder `S:\ai\mixodental` → `S:\ai\mixodental` (no
  process may hold it: stop its graphify watcher first); product name "mixoDental" in package.json
  `name`, page title, web app manifest / Pages URL if any, product name in docs and licence notices, locales
  (en/ja/zh-Hant via Gemini, D8), logo text; update every reference in mixomesh (plan, port guide,
  ledger, vendor script defaults, graphify commands), mixo-geocore (README, AGENTS.md) and memory
  notes; rebuild its graph and the port graph. *Depends: PE.5.* **Done when** grep finds
  "mixoDental" only in history notes, mixoDental's tests, walks and build pass under the
  new name, and both other repos' gates are green.
- **PE.7** `[geocore]` Readability (owner 2026-10-29): folders/files named by what they do (generic geometry out of
  `dental/` into neutral modules), one concept per file, a README per folder + top-level architecture map and
  "where do I look for X" table, `///` / TSDoc on every public item, inline comments on non-obvious algorithm
  steps. No behaviour change: wasm ABI and package entry points unchanged (engine 11), goldens byte-identical,
  both apps only re-vendor. Then an egm-comprehension (naive reader) review confirms a newcomer can navigate it.
- **PD.2** `[mixodental]` Batch folder review broken by PE.5/PE.5b (run-batch-review.bat checked the deleted Rust
  build; batch.ts imported a moved dental module and hung): fix all stale imports in dentalwork/** and scripts/**,
  exit non-zero on error, add an end-to-end test on the reference aligner so it cannot silently break again.
Engine work in later tasks (P5.10, P5.11, P5.14, P8.3) is done in mixo-geocore, bumps
`engine_version`, and is re-vendored into both apps in the same task (D11); they therefore depend
on PE.5.

### PW Web parity (owner 2026-10-29: web is priority over desktop)

- **PW.1** `[mixomesh]` Cults3D publishing from the web app. Measured 2026-10-29: Cults3D GraphQL
  sends no CORS headers (preflight `OPTIONS /graphql` → 404, POST → no `Access-Control-Allow-Origin`),
  so a page cannot call it directly. Add a small relay (Cloudflare Worker, owner's account, free tier)
  that forwards only to `https://cults3d.com/graphql` (and, if the presigned S3 upload also lacks CORS,
  streams the file upload), allows only the Pages origin, never stores or logs the API key, and has a
  request-size limit. The web Publish tab uses the relay; desktop keeps calling Cults3D directly.
  *Owner prerequisites: Cloudflare account access; Cults3D key for the live Secret-listing test
  (as PB.11).* *Depends: P4.2.* **Done when** a Secret listing is published from the Pages build
  through the relay, the relay rejects other origins and other targets (tests), and the desktop path
  is unchanged.
- **PW.2** `[mixomesh]` Installable web app: web app manifest + service worker (offline after first
  visit, versioned cache busted per deploy), `file_handlers` for `.stl`, `.3mf`, `.obj`, `.glb`,
  `.mixo` (Chrome/Edge), launch queue opens the files like `--open` does on desktop; CSP unchanged
  except what the worker needs. *Depends: P0.1.* **Done when** a Playwright run installs-equivalent
  (manifest + SW registered), reloads offline and opens a file via the launch queue; Lighthouse PWA
  checks pass; Electron build unaffected.
- Desktop-only by nature (stays in Electron): automation API / named pipe / batch jobs / `--job`.
### PD mixoDental requests (owner 2026-10-29)

- **PD.1** `[mixodental]` Support-area step colours and outside-area risks. In the dental step that shows the
  support area: (1) permitted area painted vermilion `#E83F25` (replaces green `#2f6f5e` for the area fill and
  outline; tip markers unchanged); (2) overhang low points OUTSIDE the permitted area painted blue `#1E50A2`: per
  downward overhang region (profile overhang angle) find its lowest points (engine island / minima detection,
  e.g. `check_support_problems` with the step's tips as contacts), keep those on faces outside the permitted
  area, paint a disc around each (radius ≈ click reach, restricted to that region's faces) and list each in the
  problem list with Show; recompute ~0.5 s after each paint/erase stroke (worker, revision, stale dropped);
  (3) the blue `#007ed3` contour line becomes ink `#3b3631` so blue means only "risk outside the area" (owner
  may veto). Colours live in `PREVIEW` (style.ts) as named entries `areaPermitted`, `riskOutside`.
  *Depends: PE.5b.* **Done when** a vitest covers the outside-low-point selection (a model with one low point
  inside and one outside the area → exactly one blue spot), the walk passes, a screenshot of the step shows
  vermilion area + blue spot, i18n en/ja/zh-Hant for any new string, exports byte-identical to the PE.5 baseline
  (visual-only change).
- **PD.6** `[geocore]` + `[mixodental]` Denture profile (owner 2026-10-30; rules from analysing the owner's
  LOW-D-37-36-46-47-_2 vs its -sup, owner-authorised; scans read in place, never committed). A separate profile
  beside the aligner one (dentures are a different product), selected by profile/type, never by guessing:
  - Orientation/angle: stand it upright (arch plane vertical, teeth side down), then search the print angle by
    tilting DOWN from upright (example settled ≈ 10°; it is the search result, not a constant).
  - Rim: open edge lines are normal (often broken at the front); never require a closed rim or a central opening.
  - Permitted area: everything except the teeth/occlusal and the polished tissue face is permitted; the large
    concave middle is ALLOWED but not a target. Tips go where the upright pose needs them: lowest points
    (leg ends, bottom border) and internal connector bars (rods); light on teeth/molar pads.
  - Supports (example values as profile defaults): tip ball 0.65 mm on a frustum (base 1.1 mm, 0.55 mm tall),
    tip pitch ≈ 1.5 mm, pillars 1.1 mm with lattice bracing, raft two layers (0.5 + 1.0 mm), lift 3.5 mm.
    Every pillar reaches the raft or the model (owner: the example's floating pillars were a mistake).
  Batch type selection (owner 2026-10-30): run-batch-review.bat asks once per run Aligner/Retainer or Denture?`n  (one key press; drag-and-drop and double-click alike); the whole run uses that profile; summary.json + viewer show the
  profile per case. Shape check only VERIFIES: a file that does not look like the chosen type gets needs-a-look
  ("looks like a denture" / "looks like an aligner"), never a silent switch. Modular (D26): profile selection and
  the shape check are their own units.
  *Depends: PD.5 (shares dental orientation/region code).* **Done when** the owner's denture scans in
  case-denture build in batch review (owner reviews in the viewer), the example's tip regions match its -sup
  (leg ends + bars, ±), aligner results unchanged, tests green; compare to the -sup files (owner-authorised).
- **P5.15** `[geocore]` + both apps. OVERLAP RULE (owner 2026-10-30, default everywhere, generic and dental):
  overlapped areas — between meshes of one object or between objects — never get supports. (1) No tip on a surface
  that lies inside another closed mesh/object or within 0.05 mm of another mesh (touching). Judged PER CANDIDATE TIP POINT
  (point + tip radius), not per face: a long face only partly intruding into another mesh keeps its supports on the free
  part and loses only the intruded part (owner 2026-10-30). Exact face splitting only for drawing the overlap in the viewer. (2) Every other mesh /
  object is an OBSTACLE: no support may pass through it (engine clearance check gets the obstacles). (3) A mesh fully
  inside another gets no supports. Today (verified in code): separate objects are invisible to each other's supports
  (supports can cross them); overlapping/nested meshes of one object get tips on buried faces that the clearance
  check then drops (wasted contacts, "blocked"). Implement in geocore (overlap classification + obstacle input),
  mixomesh passes overlapping scene objects as obstacles and warns on object overlaps. Tests: two cubes pushed
  together (as two objects and as one two-mesh object), a nested mesh, two apart meshes (unchanged) — no tip inside
  an overlap, no support inside another mesh. *Depends: PD.6.*
- **PD.7** `[geocore]` + `[mixodental]` Dental multi-mesh (owner 2026-10-30): when a dental file has several meshes, the
  LARGEST BY VOLUME (owner 2026-10-30; surface area only as fallback for an open mesh) is the main part and gets the dental profile (orientation,
  angle, area, tips); the smaller meshes get normal GENERIC supports on their non-overlapped faces only (P5.15),
  in the main part's pose, never passing through the main part. *Depends: P5.15.*
- **PD.8** `[mixodental]` Debug layers in the app UI (owner 2026-10-30): the batch viewer's evidence layers (trim
  lines, U ends, bottom plane, back arrow, support area, diagnostic strips) also available in the interactive app as a
  "Debug" section, COLLAPSED by default (state remembered per user), each layer a checkbox with its colour swatch,
  every layer following the model's transform. Modular (D26): one shared evidence module builds the layer data for
  both the batch GLB and the app (no duplicated drawing logic). *Depends: the evidence-overlay pose fix.* **Done
  when** the layers toggle in the app on case-001 + one case-aligner scan, sit on the model in every view (same
  numeric check as the overlay fix), and the section starts collapsed.
- **PD.11** `[mixodental]` Step 1 (orientation) UI, owner spec 2026-10-30: viewport shows only model + debug layers
  (no supports, no raft, adding supports disabled); bottom-right view buttons hidden in Step 1; Exit = text button "Exit" at the top right of the nav bar, always shown (owner answer); language = one dropdown; no Hide-models button anywhere (owner answer); edit bar on the right,
  as narrow as possible. Edit bar rows top→bottom: Auto orient (primary/highlighted, new orientation icon as SVG
  asset), tilt range (stable band), a dial (tilt live; full scanned range, stable band highlighted, starts at the
  chosen angle), Free transform, then Prev | Next as one full-width row at the bottom. Big tilt number with ° at the
  top left under the Step 1 badge. Free transform: confirm prompt ("you will orient it yourself") → rotation-only
  gizmo; edit bar shows only Auto orient + Prev|Next; big number hidden; Auto orient RESTORES the stored automatic pose and exits Free transform (owner answer: no re-run); the gizmo shows only in Free transform mode. Modular (D26) + designer-friendly (icons as assets, styles in CSS).
- **PD.12** `[mixodental]` Visual language + live paint (owner 2026-10-30), after PD.11:
  - Colours defined ONCE in CSS (src/ui/styles/tokens.css, named variables, e.g. --paint-support-area red,
    --paint-low-outside orange, --support-tip yellow, --support-body, plus layer colours); the 3D views read them at
    start-up and apply them to materials; the batch-review viewer loads the same tokens.css (no own colour list).
    Replaces PD.1's vermilion/blue: support-area paint = red, low points outside the allowed area = orange, everywhere.
  - Step 1 live paint: allowed-area mask computed once when Step 1 opens (worker); faces of that area facing down at the
    current pose painted red on the GPU every frame (shader: normal · down with the pose uniform), low points outside the
    area orange; engine results (tips, unsupported low points, safety) recomputed 1 s after the user STOPS moving
    (restart timer on each movement; stale results dropped).
  - Support-points step: tips drawn as YELLOW CONES. All supports (tips, pillars, braces, raft) share one "plastic"
    material (soft sheen, moderate roughness, resin-like) in the app and the viewer.
  - Every step's edit bar has the same layout: main action top, step controls middle, Back | Next full-width row
    bottom, same narrow width on the right.
  Modular (D26), designer-editable (CSS tokens, icons as assets). Sonnet writes the guide after PD.11 batch C; haiku
  builds. Done when screenshots of every step + the viewer show the colours from tokens.css, and changing one token
  changes it everywhere (test).
- **PD.13** `[geocore]` Rotation-invariant print-angle choice (found 2026-10-30, owner question "does the aligner make the
  same mistake?"): real scans rotated randomly at import orient identically (8/8: same up/back, built clear), but the
  tilt search picked 33.5° instead of 36.5° on one rotation of case-aligner #1 and tip counts varied by ±1 — scoring
  runs in import coordinates, so float noise tips close calls. Fix: score tilts in the model's own frame (from the trim
  plane / denture bottom plane) with quantised keys (core/proximity), test: ≥ 8 random rotations of real scans → identical
  angle and tips (both aligner and denture). After the denture rules land.
- **PD.14** `[mixodental]` Review layers, same for aligners and dentures (owner 2026-10-30), after the denture rules:
  (1) Support area painted (aligner: trim band policy area; denture: centre-of-box line-of-sight area + bottom edges) — ON;
  (2) lowest island / overhang points OUTSIDE the allowed area painted as risks — ON; (3) when <name>-sup.contacts.json
  exists: the owner's support area (faces ≤ 2 mm from the owner's contacts) vs ours (≤ 2 mm from our tips) painted as
  both / owner-only / ours-only, plus coverage % and extra % in the facts panel — ON. Colours from tokens.css (PD.12:
  area red, outside low points orange, comparison three distinct tokens). Batch viewer and the app's Debug section use
  the same layer data module. Haiku builds; done when screenshots of case-001 and the three dentures show all layers.
### P2 Spike

- **P2.1** One selected mesh → worker job → `generate` → tips drawn in Babylon. `src/supports/frame.ts`
  is the only handedness seam (D9, D10): negate Z of positions and normals, swap triangle indices
  1↔2 per triangle, both directions. It also sends the engine a copy welded by position (geometry
  only: UV/colour seams split mixomesh's textured meshes, and the engine keys edges by vertex
  index, so unwelded seams inside an overhang would read as region boundaries and get false edge
  reinforcement). *Depends: PE.4.* **Done when** a textured cube whose UV seams cross its bottom
  face gets the same edge anchors as the plain cube, cube-overhang tip count equals the golden, a
  cull on/off screenshot and a trimesh winding check of an exported support mesh are in the ledger,
  and the existing import/export orientation smokes are unchanged. **Owner checkpoint 2** (tips on
  a real model).
- **P2.2** Engine loading proven in the dev server, the production build and Electron `file://`:
  `tests/browser-support-engine-smoke.mjs` (`--preview`, `--electron`). *Depends: P2.1.* **Done
  when** all three modes report the pinned engine version.

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
- Inside: the mixoDental generic UI (guide 5b A, B, C): presets Light / Middle / Heavy / Custom;
  tips, neck, pillar, foot; Support area brush; Edit (Add / Select, Click / Drag over, circle size,
  Shift flips, Delete, right-click/Ctrl+click remove, ghost tip, remove ring, crosshair while adding,
  tool name with what a click does); per-support overrides (reset, select customised); view toggles
  (Tips only, Bottom view — hides BedGrid and floor disc —, Fit view); problem list with Show/Fix;
  Generate / Regenerate; undo toasts; job progress. Tree, Brace, Raft, Label, Roof, Cage sections
  are added by P5.
- Lift (decision 2026-10-29, main session; owner may override): supports are built down to the bed. Generating
  supports for an object lifts it by the preset's lift height (default 5 mm) with one undoable transform
  command "Lift for supports" (plateY = bed); changing lift re-runs it; removing all supports offers to
  drop the object back to the bed. Export matches the screen.
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
  stamp stroke, override, reset override, settings change, preset) in `src/supports/commands/`,
  each wrapping the `editing/` reducer transitions (D21). *Depends: P2.1.* **Done when** vitest:
  each command does and undoes as one HistoryManager step, `object.supports` round-trips through
  JSON, stale detection fires on scale/rotate/repair.
- **P3.2** Mode controller `src/supports/SupportMode.ts`: enter/exit, `isolationMask`,
  `data-mode`, InputManager context, Esc order, mode-scoped undo. *Depends: P3.1.* **Done when**
  smoke: enter hides the others and dims panels, every shadowed key is inert, exit restores
  everything, a save and an export during the mode include all objects.
- **P3.3** `src/supports/BabylonViewportPort.ts` implements `ViewportPort` (D22) for the Babylon
  scene (ray from screen point, project to screen, pick through the engine session — port of
  `rustRaycast` —, pointer records). `src/supports/layers/`: support mesh (one material per part
  kind, shared, never recompiled per preview), tips-only mesh, ghost tip, remove ring, screen-space
  brush ring, zone stamp overlay (stamped triangles only), selection highlight. D20 for every layer.
  *Depends: P3.1.* ∥ P3.2. **Done when** vitest for the port against a NullEngine scene; smoke:
  layers draw, picking hits tips, and stats HUD / world extents / selection outline / export are
  unchanged by their presence.
- **P3.4** React panels `src/panels/supports/`: SupportPanel (presets, tips, neck, pillar, foot),
  EditBar, ZonesBar, SurfaceBrushBar, ProblemList, ViewToggles — rebuilt from the mixoDental `.tsx`
  with the kit (check `port/mixodental/` first, P5.13). *Depends: P0.4b, P3.1, P5.13.* **Done
  when** vitest per panel + screenshot.
- **P3.5** Live generation: debounced worker jobs (port of `useRegenerate`), latest-job-only and
  worker respawn per D15, stale results dropped, problem list greys until the new verdict lands;
  repair budget 3 so brace pruning runs; notice `brace-pruned`. *Depends: P3.2, P3.3, P3.4.*
  **Done when** smoke on the 1M-triangle fixture: 10 rapid slider changes end in one result for the
  last value, UI never blocks > 100 ms.
- **P3.6** Walk smokes `tests/browser-supports-*.mjs`: guide section 7 scenarios a1–a5, c, d, e,
  f1–f4, g, rewritten for mixomesh. *Depends: P3.5.* **Done when** all green.
  **Owner checkpoint 3** (Support Mode UX).

### P4 Persistence and export

- **P4.1** `.mixo` save/open keeps every support edit: project version +1 with a migration in
  `src/core/persist/ProjectLoader.js` (old files load with `supports` absent); autosave included;
  walk i1–i3. *Depends: P3.6.* **Done when** an old-version fixture opens unchanged and i1–i3 pass.
- **P4.2** Export through the export seam. ExportContext gains `includeSupports`
  (`none` / `printable` / `supportsOnly`); the support mesh comes from the host export encoder
  (mode 1) through `frame.ts`. Shapes: 3MF — supports are a separate solid `<object>`
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

- **P4.4** `[mixomesh]` Remaining known export defects (tests/consumers.mjs KNOWN table, owner question
  2026-10-29 "should all be fixed"): (1) export repair closes an open single-sided sheet into a 0 mm³ double-sided
  shell that slicers read as manifold — an open sheet must export as-is (or be refused with a notice), never as a
  fake solid; (2) colour-group 3MF and OBJ write each colour as its own vertex set, so a closed multi-colour box
  reads as 3 open parts — share vertices across colours (3MF: per-triangle pid/p1..p3 on one vertex list; OBJ: one
  v list, per-face material), stay watertight; (3) colour-group 3MF object carries no name; (4) VRML DEF names keep
  ASCII only — encode non-ASCII safely. Also resume paused run-2 L2-03 (textured exports non-manifold: vertices split
  at UV seams; 3MF/OBJ allow per-corner UV indices) — `docs/handoff/2026-10-22-autonomous-run-2.md`,
  `.audit/pending/E-handoff.md`, `E-wip.patch`. D9 holds (texture fidelity unchanged). *Depends: P4.2.* **Done
  when** every KNOWN entry is removed from tests/consumers.mjs and `npm run test:consumers` passes with 0 KNOWN,
  textured exports read watertight in trimesh and the slicer CLI, and colours/UVs read back identical.
### P5 Remaining support features (guide 2b — every row)

Each task adds its settings section to SupportPanel, its walk scenario, and asserts its golden.
*Depends: P3.6 unless stated.* Each **done when** its golden/walk is green and the ledger row names it.
- **P5.1** Tree / Auto tree / safe distance — golden `tree`.
- **P5.2** Cross-braces with pruning — Rust brace tests + a crossing-model walk.
  Engine change first (found in P3.5): the generic policy hard-codes its repair budget (0 = report only) and the generic
  result carries no brace-pruned flag; geocore must take the budget from the host (mixomesh uses 3) and report pruning (fallback
  code 3 `brace-pruned`) for generic jobs, then re-vendor both apps (D11).
- **P5.3** Raft (outline, flared wall, drainage gaps).
- **P5.4** Label (8 chars A–Z 0–9 -, raft corner pad).
- **P5.5** Roof (`ROOF_DEFAULTS`) — golden `roof`.
- **P5.6** Cage (`ROOF_DEFAULTS.CAGE`).
- **P5.7** Islands check, problem list Show / Fix.
- **P5.8** Low-poly preview + `decimate_display` for heavy models (keep only if the P3.5 smoke on the
  1M fixture shows previews > 1 s; otherwise record "not needed" in the ledger).
- **P5.9** i18n of every support string (D8). *Depends: P5.1–P5.8, P5.10–P5.12.*
- **P5.10** `[geocore]` + mixomesh. Allowed-area paint (guide 5b B, dental meaning on any model):
  generic area-policy in `geometry-core` from `dental/policy.rs` + `paint.rs` (candidates,
  alternates, permitted faces, stamp gating), host packer/decoder, `editing/` zone kind
  `allow`; mixomesh ZonesBar gains the third switch position. *Depends: P3.6, PE.5.*
- **P5.11** `[geocore]` + mixomesh. Hard-edge finder tool (guide 2b last row): ABI
  `hard_edges(model, angle_deg)` and `close_loop(model, chain_a, chain_b, soft_angle_deg)` from
  `dental/topology.rs` + `contour.rs` under a generic module, host decoder; mixomesh tool shows
  components coloured by length, click selects, a loop seeds a support area. *Depends: P3.6, PE.5.*
- **P5.12** Arrange several objects on the plate without overlap: `editing/arrange.ts` (PE.2) +
  a mixomesh command and button. *Depends: P3.6.*
- **P5.13** Check `S:\ai\mixomesh\port\mixoDental\` (guide 10) for handed-over code; record the
  result (folder absent today). *Depends: —; before P3.4.*
- **P5.14** `[geocore]` + both apps. **HIGH priority** — edge reinforcement on high-poly models
  (owner question 2026-10-29, measured with `scripts/probes/edge-probe.mjs` on engine 9):
  - Bevelled cube: sharp box 19 edge points along its long bottom edges; same box with a 1 mm bevel
    of 16 segments or a 2 mm bevel of 32 segments: **0**. Cause: `anchors.rs` insets each edge
    sample into ONE incident triangle and needs clearance ≥ 0.05 mm inside it; bevel facets are
    ~0.1 mm wide, so every sample is silently dropped. Real scans have such facets everywhere.
  - Rounded crease inside an overhang (V ridge rounded by 8 facets): ridge points 9 → 0 (per-edge
    `angle_between > ridge angle`). The hard-edge finder (`dental/topology.rs`, per-edge
    `|n1·n2| ≤ cos θ`) has the same blindness.
  - Split (unwelded) meshes: every seam inside an overhang becomes a false boundary (rounded V:
    34 → 61 edge points). Covered by P2.1's weld-before-engine rule; geocore also welds internally.
  Fix once in `geometry-core`: (1) inset by walking the surface from the edge sample by the contact
  radius across triangles (geodesic step over the region's faces), keeping the anchor on whatever
  face it lands; never drop a sample because one facet is thin; (2) segment faces into near-planar
  patches (normal tolerance) and detect ridges / hard edges between patches by patch mean normals,
  so a turn spread over many facets counts once; anchors and `hard_edges` share it, so dental and
  generic gain it together. A gradual edge = a turn of at least the ridge / hard-edge angle completed within a surface
  distance W (max bevel width, default ~2.5 mm, a setting); smooth large-radius curvature (domes, blobs, wide fillets) is
  not an edge. Tests: 1/2 mm bevels detected; 10 mm-radius fillet, sphere and 0.02 mm jitter on a flat region not detected.
  (3) Placement must be stable under sub-micron input noise: P2.2 measured 54 vs 62 tips
  for the same cube when world coordinates carried ~1e-4 mm float32 noise (mixomesh now snaps its input to 1 µm in
  `supportJob.ts toLocal`; the engine should quantise internally so every app is safe). *Depends: PE.5b (starts right after it; it does not need P5.11).*
  **Done when** the probe shows ≥ 80% of the sharp box's edge points along the bevelled boxes'
  long edges, the rounded V keeps ridge reinforcement, split and welded inputs give the same
  anchors, the dental reference keeps its θ 60° chains (110.2 mm, 56.1 mm), the generic goldens
  are unchanged or re-baselined with an explained diff, the probe is a geocore test, and both apps
  are re-vendored and green.
### P6 Gizmo update

Today: `src/core/scene/PivotSession.js` — Babylon `GizmoManager`, one exclusive mode
(translate / rotate / scale), snap via `SnapUnits.js`, undo committed in `_onGizmoDragEnd`.
- **P6.1** Plane handles: `positionGizmo.planarGizmoEnabled = true` (XY, YZ, XZ); a plane drag
  changes only its two axes; one undo step per drag on every handle. *Depends: P0.3b.* **Done when**
  smoke: a plane drag changes exactly two axes and undoes in one step; `cpuFrameMs` mean during the drag within max(0.1 ms, 10%) of baseline.
- **P6.2** Verify orbit stays off during every handle drag (Babylon `PointerDragBehavior`
  Also (found in P6.1): pressing a gizmo handle while Ctrl is ALREADY held does not grab it, so snap-dragging only works if
  Ctrl goes down after the press. Fix so Ctrl-then-press grabs the handle and snaps (users hold the modifier first); smoke
  covers both orders.
  detaches camera controls) and add a pointercancel/blur guard if a drag can leak; gizmo colours
  (axes, hover, active) from mixo-app-style tokens; screen-constant size confirmed; gizmo hidden in
  Support Mode. *Depends: P6.1, P3.2.* **Done when** smoke + screenshot. **Owner checkpoint 5**
  (gizmo feel).

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
*Depends: P0.6 (each); serial within P7; ∥ P5/P6 (file-disjoint: P7 never touches
`src/supports/` or `src/panels/supports/`).* **Done when** its existing tests/smokes pass (ported if
they read legacy DOM), kit-only controls, no `innerHTML`, screenshot (D5).

### P8 WASM geometry and export

Rule D18; inventory section 3.
- **P8.1** `scripts/bench-geometry.mjs`: JS vs WASM per function, corpus = cube, knot, the three
  Memory (D24): the bench also records peak memory per function (JS heap via CDP, WASM memory size, process private
  bytes) on a 5M-triangle and a 10M-triangle fixture plus the 4096² textured one, and import/export of each format end
  to end (STL, OBJ, 3MF, glTF); the table lists the top memory hotspots as P8 targets alongside the speed ones.
  heavy-mesh fixtures (1M, 5M, 4096² textured); median of 5; table in the ledger. *Depends: PE.4.*
  **Done when** every Tier A and Tier B module has a row (WASM column "n/a" until a WASM version
  exists).
- **P8.2** Wire functions the engine already has (section 3 "Engine has") where P8.1 shows ≥1.1x.
  *Depends: P8.1.* **Done when** parity tests (P8.4) green for each switched path.
- **P8.3** `[geocore]` + both apps. New Rust in `geometry-core/src/generic/mesh/` (one module per
  FIRST item (owner 2026-10-29): the subdivision / refinement tool `src/core/refinement/Topology.js` (`refineTopology`:
  weld + adjacency + subdivision, output ×4 per level) moves to mixo-geocore as a shared tool. Done when its output equals
  the JS version (positions within 1e-6 mm, identical topology, UVs and colours preserved exactly incl. seams), it is
  ≥ 1.1x faster and uses less peak memory on the 1M fixture at levels 1 and 2, and the refinement UI/undo is unchanged.
  op, Rust tests) for Tier A modules with no engine function, then Tier B loops, batched into one
  engine version bump per batch; host decoders; re-vendor. Export writers keep JS containers (zip,
  XML, text); only per-vertex / per-triangle loops move. *Depends: P8.1, PE.5.* **Done when** each
  new function has a P8.1 row showing ≥1.1x and a parity test; slower ones are recorded and not
  wired. **Owner checkpoint 6** (P8 go/no-go on the benchmark table).
- **P8.4** Parity: per moved function, JS-vs-WASM equality on the corpus with its tolerance (weld
  order canonicalised, float epsilon stated). *With P8.2/P8.3.*

- **P8.5** `[geocore]` + both apps. Shared export geometry core (owner 2026-10-29: "written in WASM for
  consistency"). Move the geometry half of export into mixo-geocore so mixomesh and mixoDental produce identical
  meshes: weld by position, shared vertex lists with per-triangle colour and per-corner UV indices, winding /
  orientation in the print frame, signed volume + watertight checks, binary STL encoding, 3MF mesh-section and OBJ
  v/vt/f encoding of the vertex/index data. Containers (owner 2026-10-29, modularise for consistency and speed): a shared
  TypeScript package `formats/` in mixo-geocore assembles 3MF (content types, rels, model XML, build items, components,
  basematerials / colour groups / texture groups, thumbnail), OBJ + MTL and STL for both apps, calling the WASM encoder for
  the mesh data; the 3MF zip uses the browser's native `CompressionStream` (streamed, replaces JSZip on the export path)
  rather than a WASM deflate. Apps pass options only (textures from frozen source bytes per D9, printer 3MF flavour,
  supports as separate objects, naming). Measured on the 1M and textured fixtures: time and peak memory vs today. D18 exception: these functions move for
  consistency as long as they are not slower end to end (≥ 1.0x), not the 1.1x rule. *Depends: P4.4 (its
  consumer checks are the spec), PE.5b.* **Done when** mixomesh `test:consumers` passes unchanged (0 KNOWN), the
  same consumer harness (or its geocore port) passes for mixoDental's exports, mixoDental's dental exports are
  byte-identical or explained, P8.1 shows no slowdown, and neither app keeps its own copy of the moved code
  (duplicate check).
### P9 Close

- **P9.1** Full gates on a quiet machine. mixomesh: `npm test` (node + vitest), lint, typecheck,
  i18n:check, build, `test:all`, `test:electron`, `test:publish`, perf harness vs the P0.3b baseline.
  mixo-geocore: cargo test, wasm build, vitest, D22 test, goldens. mixoDental: `npm test`, wasm
  smoke, walks. Fix failures. *Depends: everything above.*
- **P9.2** Final whole-diff review (Fable) of the three repos: correctness, D-rule compliance;
  findings fixed. *Depends: P9.1.*
- **P9.3** Push in order: mixo-geocore `main` + tag `v<N>` (PE.3 release job runs; verify assets),
  re-vendor both apps from the published release (`--release`, hash-checked) if they were on
  `--from`, then mixomesh `master` and mixoDental `main` (D6); confirm CI and Pages deploy; ledger
  status done with the summary and the owner eyeball checklist; prompt the owner.
  *Depends: P9.2.* **Owner checkpoint 7.**

---

## 3. WASM inventory

27 JS geometry modules (Codex inventory 2026-10-29; all 56 `path:line` citations verified).
New Rust goes to mixo-geocore `geometry-core/src/generic/mesh/` (P8.3, D11).

Tier A — heavy, O(n log n) or worse:
| Module | Work | Engine has |
|---|---|---|
| `src/core/refinement/Topology.js` | weld + adjacency + subdivision, O(n·4^level), worker | — |
| `src/core/geometry/triangleBvh.js` | triangle BVH for picking, worker | `build_pick_index` |
| `src/core/repair/MeshRepair.js` | UV-aware rebuild after repair, components; up to O(n²) | — |
| `src/core/repair/GroupRepair.js` | union of parts, centroid owner lookup; up to O(n²) | — |
| `src/core/import/weld.js` | STL soup weld + crease normals, worker | `weld_positions_in_place`, `vertex_normals` |
| `src/core/repair/Weld.js` | distance weld + index remap | `weld_positions_in_place` |
| `src/core/repair/CapLoops.js` | boundary loops + caps | (generic topology from `dental/topology.rs`, P5.11) |
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

## 4. Agent assignment (rev 3)

Cheapest worker that can finish the task with its gates green; Ollama only for enumerations and
drafts that a verifier checks; Codex low for bounded "who owns this" lookups.

| Task | Worker | Reason |
|---|---|---|
| P0.0, P0.1, P0.2, P0.3, P0.4a, P1.1 | done | — |
| P0.3b | sonnet | CDP harness + Babylon instrumentation + textured fixture |
| P0.4b | sonnet | kit containers, tri-state collapse |
| P0.6 | sonnet | first panels + perf gate |
| P0.5 | haiku | doc from existing code |
| PE.1 | sonnet | subtree split + repo scaffold |
| PE.2 | opus (Ollama enumerates the import rewrites) | package split, ViewportPort design, D22 test, goldens harness |
| PE.4 | haiku | vendor script flags + rename |
| PE.3 | haiku | CI workflow from the PE.1/PE.2 scripts |
| PE.5 | sonnet | mixosupports switch + three.js ViewportPort + its walks |
| PW.1 | sonnet (+ main for owner steps) | relay + web Publish path |
| PW.2 | sonnet | manifest, SW, file handlers |
| PE.5b | opus | dental host bindings + editing extension points, mixoDental drops duplicates |
| PD.1 | sonnet | mixoDental support-area colours + outside-area risk paint |
| PE.6 | sonnet | rename mixosupports → mixoDental (web only), every reference in the three repos |
| P2.1 | opus | handedness spike, weld, empirical proof |
| P2.2 | haiku | loader smokes |
| P3.1 | opus | data model + undo |
| P3.2 | sonnet | mode controller |
| P3.3 | opus | ViewportPort for Babylon, layers, picking |
| P3.4, P3.5, P3.6 | sonnet each | panels, worker, smokes |
| P4.1 | sonnet | migration |
| P4.2 | opus | export seam, 3MF structure, ratio rule |
| P4.3 | haiku | counts |
| P4.4 | opus | known export defects + L2-03 seams |
| P5.1–P5.8, P5.12 | sonnet each | one golden/walk each |
| P5.9 | Ollama draft → Gemini zh-Hant → haiku wiring | D8 |
| P5.10, P5.11, P5.14 | opus (Rust + host) + sonnet (mixomesh UI) | engine work in mixo-geocore |
| P5.13 | haiku | folder check |
| P6.1 | sonnet | gizmo handles |
| P6.2 | haiku | verify + tokens |
| P7 panels < 150 lines | haiku | mechanical |
| P7 others, P7.last | sonnet (Codex low: "who owns this root id") | — |
| P8.1, P8.2, P8.4 | sonnet | bench, wiring, parity |
| P8.3 | opus (Rust) + sonnet (wiring) | engine work |
| P8.5 | opus (Rust) + sonnet (app wiring) | shared export geometry core |
| P9.1 | sonnet | gates, three repos |
| P9.2 | fable | diff review |
| P9.3 | main session | owner gate, pushes |

Parallel (∥, file-disjoint): P0.4b / P0.6 / P0.5 ∥ PE.1 / PE.2; PE.3 ∥ PE.5; P3.2 ∥ P3.3;
P7 ∥ P5 / P6; P8.1 ∥ P3–P7; P5.9 translation drafts ∥ anything. Everything else serial.

Dependency graph (acyclic):
```
P0.1 → P0.2 → P0.3b → P0.6 → P0.5           P0.1 → P0.4a → P0.4b → P0.6
P0.1 → P1.1 ─┐
PE.1 ────────┴→ PE.2 → PE.4 → P2.1 → P2.2 → P3.1 → {P3.2 ∥ P3.3} → P3.4 → P3.5 → P3.6
                PE.2 → PE.3                              P5.13 → P3.4
                PE.4 → PE.5 → PE.5b → {PE.6, P5.14 (first, high priority), P5.10, P5.11, P8.3}
P3.6 → P4.1 → P4.2 → P4.3        P3.6 → P5.1–P5.8, P5.10–P5.12 → P5.9
P0.3b → P6.1 → P6.2 ← P3.2       P0.6 → P7.* (serial) → P7.last
PE.4 → P8.1 → {P8.2, P8.3} + P8.4
all → P9.1 → P9.2 → P9.3
```

Owner checkpoints: 1 P0.6 (kit look, perf) · 2 P2.1 (tips on a real model) · 3 P3.6 (Support Mode
UX) · 4 P4.2 (printable export) · 5 P6.2 (gizmo feel) · 6 P8.3 (WASM go/no-go) · 7 P9.3 (push).
Work continues past a checkpoint unless the owner stops it; the evidence is in the ledger.

Estimate: ~82 tasks → 30–40 worker sessions plus orchestration.
