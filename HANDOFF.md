# HANDOFF — Storage Adapter + Web/Windows-Electron split

> **ACTIVE WORK (2026-10-14): MIXOMESH overhaul — resume from `docs/handoff/overhaul-execution.md`.** Storage-adapter Phase 1a work described below is superseded by **ADR 0001 addendum (2026-10-14)** + **Blueprint.md §11** (overhaul Phase 4 complete).

> **2026-11-12 — ALL THIRTEEN findings of `docs/cia-audit-2026-11-12.md` are CLOSED, and master is
> PUSHED at `e67d09e`** (CI green: lint, typecheck, `npm test`, `i18n:check`, build; Pages deployed
> 06:28 UTC). The three HIGHs went first. MX-01: `MeshRepair.diagnoseMesh` now welds by position before it asks the engine, so a
> UV seam stops counting as a hole — the weld went into that shared seam, not into one call site, so
> all three raw-mesh diagnose callers are covered; `repairMesh` keeps getting RAW geometry on purpose
> (the engine merges for itself, `arraysToMesh` needs the original UVs). MX-02: a failed autosave
> recovery MOVES the snapshot to `autosavefailed_<projectId>` instead of deleting it; the boot scan
> ignores it, only an explicit Discard clears it — **open debt: no UI offers a salvaged snapshot
> back.** MX-03: `restoreSupports` returns `{ supports, dropped }` and the loader toasts the names it
> could not restore. Guards: `tests/diagnose-weld-mx01.test.mjs`,
> `tests/autosave-recover-keeps-snapshot-mx02.test.mjs`, `tests/load-dropped-supports-mx03.test.mjs`,
> plus a `validateMesh` case in `tests/validator.test.mjs`.
>
> **The MEDIUM/LOW findings are closed too**, each in its own commit: MX-04 `66b5ccd` (strict export
> says "model parts", because supports can never be a manifold), MX-05 `b18047f` (a bundle names its
> format, so five formats write five files), MX-06 `c4caa6c` (the exported bytes are read by
> something that is not the writer), MX-07 `bc40c9e` (the smoke allowlist is scoped by what the line
> is and reports what it silenced), MX-08 `8ff27db` (a support build that returns nothing is named,
> not skipped), MX-09/MX-10 `7394385` (the exports and state fields nothing reads are deleted),
> MX-11 `c3e1ef1` (the single read of an object's supports on load is pinned), MX-12 `b8b65bf` (the
> app route has an `h1`; the unit-suffix clip was fixed upstream in mixo-app-style `fc11115` and the
> copies re-taken in `e67d09e`), MX-13 `aac3211` (one surface for every boot failure).
>
> **What is NOT shipped: the desktop app.** `installers/` still holds only
> `MIXOMESH-Setup-0.3.1.exe` from 2026-10-23, while `package.json` is 0.3.2 — so no installer
> contains any of the thirteen fixes. `npm run dist` is runnable (electron-builder 26.15.3 is a
> devDependency) but has not been run since. The installer is also unsigned, which SmartScreen warns
> on, and `electron-builder.yml` has no `publish` key, so there is no update channel for anyone who
> already installed 0.3.1. The web app on Pages IS current.

> **2026-11-12, LATER - `npm run test:all` WAS RUN FOR THE FIRST TIME IN WEEKS AND IT WAS RED.**
> Three failures, none of which `npm test` or CI can see (CI runs lint, typecheck, `npm test`,
> `i18n:check`, build - not the 25 browser smokes). Two are fixed here; the third needs a decision.
> `&&` chaining means one red suite hides every suite after it, so each fix revealed the next.
>
> **1. FIXED - a mesh smaller than the weld cell was welded away and then called watertight.**
> `test:outliner-hover` imports one open triangle; the importer normalises it to 0.02 mm across and
> the weld cell is 0.1 mm, so all three vertices fell in one cell, the triangle was dropped as
> degenerate, and the engine was handed an EMPTY mesh - `boundaryEdges: 0, triangles: 0,
> isWatertight: true`. Measured live: `validation: { results: [] }`. No Repair pill, no warning,
> strict export would have passed it. **MX-01's weld caused it**: before that fix the engine read
> the raw arrays and saw three open edges, and `_checkNonManifold` welds at the same
> `MERGE_DISTANCE` and skips degenerates, so after MX-01 no reader in the app could see sub-cell
> geometry. `diagnoseMesh` now reads the raw arrays when the weld annihilates the mesh
> (`MeshRepair.js`), with two guards in `tests/diagnose-weld-mx01.test.mjs`. Forged the fix away to
> check them: the new guard fails, the four original MX-01 tests still pass.
>
> **This is a patch on a weld that is wrong by design, and the real fix is the re-vendor.**
> mixoMesh welds at an absolute `WELD_DISTANCE = 1e-4` Babylon units with no edge guard and no
> body-gap floor, so it also stitches two shells that pass within 0.1 mm. geocore solved this
> properly in `core/proximity.rs`: `Weld` is `max(1e-7 mm, 1e-6 x bounding-box diagonal)` and
> refuses any merge that joins two vertices sharing an edge or puts an edge on more than two faces,
> and it sits three orders of magnitude below a fixed 0.005 mm `BodyGap` - `repair/weld.rs` asserts
> `distance_mm * 50 < BodyGap`, so "welding never fuses two bodies" is true by arithmetic. That is
> what `docs/geocore-adherence-2026-11-12.md` means by deleting the 1,644-line repair stack.
>
> **2. FIXED - the engine smoke test pinned engine 11 as a literal while the vendor has been 12
> since 2026-10-30.** `tests/browser-support-engine-smoke.mjs` had `const EXPECTED_ENGINE = 11`, so
> it had been red for thirteen days through three Pages deploys. It now reads `engineVersion` from
> `public/vendor/mixo-geocore/SOURCE.json`: the assert exists to catch the app loading something
> other than what it vendored, and a literal cannot do that job. All three shapes pass -
> engine_version 12, 70 tips, 18004/18004/18244 support triangles.
>
> **3. OPEN, NEEDS A DECISION - `test:support-workers` asserts a golden captured for different
> settings, and only ever passed by coincidence.** It reports **68 tips** against
> `GOLDEN.tips = 70` and fails in the first (dev) mode. Do NOT change the golden number: 70 is
> correct. Checked against the authority - geocore's own
> `goldens/__snapshots__/cube-overhang.default.json` has 70 `placement.points` at the VENDORED
> commit `6cc5385` (engine 12), and at `21c7840` and `6bf349a` too. The two app paths use different
> presets: `__mxSupportEngineProbe` runs `runSupportSpike({ preset: 'LIGHT' })` and gets 70, while
> this test presses the panel's Generate button, which runs **preset MIDDLE** (the settings dump in
> the failure output confirms it). Both are asserted against the same golden. engine 11 -> 12
> (`14e4f82`, "proximity weld, no coordinate snapping") separated two counts that happened to agree
> at engine 10, which is when the golden was captured. geocore has no golden for MIDDLE (its
> variants are default / roof / tree / low-poly, which are settings variants, not presets).
> **Recommended fix: make the test generate with the settings the golden was captured from (select
> the LIGHT preset before pressing Generate) and say so in a comment**, so the number stays anchored
> to an independent source. The alternative - capturing a MIDDLE golden from mixoMesh's own run - is
> the app blessing its own output, which is what the export reader (MX-06) exists to avoid. Not
> done here because it changes what the test exercises, and that is a roadmap call. C9 (deleting `src/core/repair/` for geocore's Rust
> repair) is untouched and still gated on the 12-scan comparison.

> **2026-10-22 /cia run (`docs/reviews/2026-10-22-cia-full.md`): every owner decision is closed.**
> W-13 bda8066, A-11 84dd6ef, E-03 7a5df43, F-08 632fefe; W-00 and C-06 kept as is (recorded in
> Blueprint). Master is NOT pushed; after pushing, read the first CI run (it now runs
> lint/typecheck/tests/i18n before deploy). Open: a real iPad / iPhone measurement to raise the
> unmeasured WebKit budget (1M / 3M).

> **2026-10-22 — Release 0.3.0 shipped (master 4e7a81e, tag v0.3.0, Pages live,
> installer `installers/MIXOMESH-Setup-0.3.0.exe`).** Heavy-mesh handling per
> `docs/superpowers/specs/2026-10-21-heavy-mesh-handling.md` (plan in
> `docs/superpowers/plans/`): STL/3MF import in a worker with weld + crease split,
> pre-parse refusal, measured budgets (web 2.5M warn / 10M refuse, desktop 6M / 24M),
> one progress surface for every worker job (NN/g timing, Cancel), BVH picking,
> faceted shading by default (shader) + per-user Smooth shading toggle, undo memory
> trim, statistics HUD (Selected n/total · Faces · Vertices, before → after),
> generated `THIRD_PARTY_NOTICES.txt` in web + desktop builds (Babylon Apache,
> Lucide ISC, env files = BabylonJS/Assets CC BY 4.0), automation sessions not
> throttled. Nothing in progress.

> **2026-10-21 — Workers & memory foundation landed (ADR 0006).** One worker
> runner (`src/core/workers/WorkerTask.js` + `serveTask.js`) for every worker;
> geometry revisions + single-copy extraction (`src/core/geometry/GeometryStore.js`);
> Booleans in a Manifold worker (`booleanCore.js`, caps 250k web / 1M desktop);
> lean STL + STL worker; chunked desktop export save (`export:beginSave` etc.).
> New heavy work (supports, slicer) follows the rules in `docs/adr/0006-workers-and-memory.md`.
> Clean builds: `npm run build` / `dist` first delete `dist/`, `release/` and
> `node_modules/.vite` (`scripts/clean.mjs`; the Vite cache is kept while a dev
> server listens on 5173). `release/` is therefore gone after a plain build —
> run `npm run dist` again before `npm run smoke:packaged`. The installer build
> keeps only the newest setup in `installers/`.

> **2026-10-21 — UI style switch (New / Original) landed.** Spec
> `docs/superpowers/specs/2026-10-21-ui-style-switch-design.md`, plan
> `docs/superpowers/plans/2026-10-21-ui-style-switch.md`. New = mixo-app-style
> Dense (default), Original = washi. Files: `src/core/uiStyleStore.js`,
> `src/core/UiStyle.js`, `src/app/ui-style-boot.js`, `src/ui/UiStyleSwitcher.js`,
> `src/styles/style-new.css`, `src/ui/Workspace.js` (per-style widths). Tests:
> `tests/ui-style*.test.mjs`, `tests/style-new-scope.test.mjs`,
> `npm run test:ui-style`. Screenshots: `UI_STYLE=new|original LOCALE=ja
> SIZES=1366x768 node scripts/ui-screenshot.mjs <dir>`.

**Purpose of this file:** durable resume point. If a session is cut off mid-operation,
THIS is the first file to read. It tracks the goal, decisions, plan, and exactly
what is done vs next. Update it at every safe boundary (before each commit).

Workflow: solo dev — **all work on `master`, no feature branches** (merged 2026-06-17).
Commit at each green boundary. This tracker persists across sessions.

---

## Goal (verbatim intent)

Audit code structure + UI design with subagents → decide the cleanest maintainable
approach to make MIXOMESH run as BOTH a web app and a Windows Electron desktop app
from one codebase → implement it. Update all architecture docs. Commit. Keep this
handoff current so a token cutoff is resumable by this or another AI.

## Locked scope decisions (do not re-litigate)

- **Targets now: Web + Windows (Electron). Mac DEFERRED** until Win+Web are production-level.
  Mac is additive later (behind the adapter), not a rewrite.
- **Electron, not Tauri** — Chromium renderer = the Chrome/CDP engine the test suite
  already targets → full engine parity, no re-test matrix (Babylon/WebGL2, WebCodecs,
  readPixels Mimaki lock, Workers, File System Access).
- **One codebase, capability-tiered `StorageAdapter`.** Runtime detected at boot
  (`window.electronAPI` → desktop, else web). App logic/UI branch on capability FLAGS,
  never on "is Electron" checks scattered around.
- **Web = ephemeral assets.** Import glb by picker → snapshot bytes → embed in `.mixo`.
  No asset DB, no folder mounts, no relink. `caps.persistAssets=false`.
- **Desktop = real fs, offline.** Absolute paths, live relink, folder mounts, file-watch.
- **`.mixo` is the interop/sync contract (already hybrid).** ALWAYS embed bytes; desktop
  ALSO stores path as an optional live tier. Cross-runtime open falls to embedded bytes →
  byte-identical geometry. The portable file is the sync unit (synced folder = poor-man's sync).

## Target architecture (the seam)

```
StorageAdapter (interface)
  caps: { persistAssets, relinkByPath, watchFiles, mountDirectory, writeFiles }
  pickOpen() / pickSave() / read(ref) / write(ref, bytes)
  resolveAsset(ref) / watch(ref, cb) / recentProjects()
impls:
  BrowserStorageAdapter  (File System Access + idb; current behavior)
  DesktopStorageAdapter  (Electron IPC → Node fs; Phase 2)
```
Core (render, edit, ratio, validation, export, .mixo schema) stays runtime-agnostic.
FS-only features (mount / relink / watch / recent-by-path) gate behind `caps`.

## Phased plan

- **Phase 0 — Audit + ADR (IN PROGRESS).** Subagents map storage coupling + UI capability
  gating + confirm core is FS-agnostic. Synthesize → ADR.
- **Phase 1 — StorageAdapter extraction (web-only, behavior unchanged).** Move current
  File System Access / idb / persist / assets calls behind the interface. All 101 headless
  + browser smoke + export stay green. NO Electron yet. Also cleans the asset-DB tier soup.
- **Phase 2 — Windows Electron shell + DesktopStorageAdapter (Node fs via IPC).**
- **Phase 3 — electron-builder (NSIS) installer, optional auto-update, security hardening
  (contextIsolation, no nodeIntegration, IPC allowlist).**
- **Mac — parked.**

## Progress log (update every boundary)

- [x] Branch `feat/storage-adapter` created.
- [x] HANDOFF.md scaffold written + committed (4ccca59).
- [x] Audit subagents dispatched (2 haiku agents: storage-coupling + UI-gating).
- [x] ADR skeleton written: `docs/adr/0001-storage-adapter-web-electron.md`
      (2 sections marked `[TO FILL after audit]`: StorageAdapter surface + UI gating map).
- [x] Audit findings synthesized → both ADR sections filled (263047a UI + interface after).
- [x] ADR complete: domain-level adapter w/ OPAQUE REFS (not FSA primitives), LEAF/LEAKED
      refactor order, core-agnostic confirmed. `docs/adr/0001-...md`.
- [x] Architecture docs updated: AGENTS.md + Blueprint.md pointers (74ae80d), memory
      `storage_adapter_direction.md` + MEMORY.md index.
- [x] Phase 1a: capability model `src/core/storage/capabilities.js` + `tests/capabilities.test.mjs`
      (5 asserts) (fda14cc); first UI gate = AssetPanel Mount button behind `caps.mountDirectory` (6a03deb).
- [x] De-flaked the dup round-trip smoke (settle source bounce before duplicating) (0b1a7d2)
      — 3× green. IMPORTANT: keeps the green-gate reliable for handoff.
- [x] Phase 1b (directory slice): `src/core/storage/StorageAdapter.js` domain interface +
      `BrowserStorageAdapter` delegating to today's code (opaque ref = FileSystemHandle);
      boot `storage` singleton; desktop directory refs are main-process registry tokens.
- [x] Phase 1b: route LEAF modules through the adapter (idb.js, persist/*, DirMounts,
      TextureAssets, Download, PersistenceManager doc I/O).
- [x] Phase 1b: gate remaining UI controls behind caps — ProjectMenu open/save/saveAs
      (`writeFiles`), recent (`persistAssets`), relink (`relinkByPath`); ViewportDrop OS-file handle.
- [x] Phase 1c: refactor LEAKED modules (AssetImport `_fileHandleKeyFor`, ObjSiblings dir-walk,
      AssetPanel `_scanDirectory`/`_cacheHandles`, ViewportDrop DataTransferItem) to go via adapter.
- [x] Phase 2 (directory slice): Windows Electron shell + `DesktopStorageAdapter`; mounted
      assets use allowlisted opaque-ref IPC and never expose OS paths to the renderer.
- [x] Phase 3: electron-builder (NSIS) installer (`build-installer.cmd`, `electron-builder.yml`) and security hardening. Auto-update is not built.
- Verify green (typecheck · 102 headless · build · browser smoke ×N · export) at EACH commit.

## AUDIT RESULTS (captured — do NOT re-run the agents)

- **Core seams runtime-agnostic (do not touch):** ImportNormalizer, ScaleMath,
  print/ExportContext, print/PrintPipeline (+PrintPrep/ObjWriter/ThreeMFWriter).
  PersistenceManager OWNS the I/O funnel → adapter injects there.
- **LEAF (wrap cleanly):** idb.js, PersistenceManager doc I/O, persist/AssetResolver,
  persist/RecentProjects, persist/Autosave, assets/DirMounts, assets/TextureAssets, print/Download.
- **LEAKED (pull FS out first):** assets/AssetImport (`_fileHandleKeyFor`→persistHandle),
  assets/ObjSiblings (dir walk), ui/AssetPanel (`_scanDirectory`/`_cacheHandles`), ui/ViewportDrop
  (OS DataTransferItem handles).
- **UI controls throwing-on-web today (gate behind caps):** ProjectMenu open/save/saveAs/recent/
  relink; AssetPanel Mount Directory; ViewportDrop OS-file drop; exports degrade to blob-download
  already. Full `file:line` map in the ADR §UI capability-gating.
- **caps set:** persistAssets, mountDirectory, relinkByPath, watchFiles, writeFiles.

## RESUME POINTER (read this to continue)

**Current step:** Phase 0 (audit + ADR) DONE. Phase 1a (capability model + first UI gate)
DONE + committed + green. Next = Phase 1b.
**Next action on resume:** Build `src/core/storage/StorageAdapter.js` per ADR §"StorageAdapter
surface" — the domain interface (JSDoc typedef) + `BrowserStorageAdapter` that DELEGATES to
today's functions (PersistenceManager pickers, idb.js, DirMounts, AssetResolver, Download),
with `ref` = opaque FileSystemHandle and `.mixo` descriptors `{path?,contentHash,handleKey?}`.
Export a boot `storage` singleton (browser impl for now). Then incrementally route the LEAF
call sites through it (list in Progress log + AUDIT RESULTS), one module per commit, keeping
the suite green. Then gate the remaining UI controls (ProjectMenu open/save/saveAs/recent/relink)
behind their caps like AssetPanel's mount button already does. THEN Phase 1c (LEAKED refactor).
Do NOT add Electron until Phase 1 is fully green. Behavior on Chrome must stay identical
throughout (all caps true → nothing hides, nothing changes).

**Watch-outs:**
- The browser smoke has import-bounce timing sensitivity; if a size round-trip flakes,
  the fix is `settleImportBounce()` before measuring/cloning (see 0b1a7d2), not a longer wait.
- `caps` is imported from `src/core/storage/capabilities.js`; override in tests via `setCapabilities`.
- Solo dev: work directly on `master`, commit at each green boundary (no feature branches).

## Verify commands

`npm run typecheck` · `npm test` (101 pass) · `npm run build` · `npm run test:browser` · `npm run test:export`

## Key files (storage coupling — from initial grep)

`src/core/idb.js`, `src/core/persist/*` (Autosave, ProjectLoader, RecentProjects, AssetResolver),
`src/core/assets/*` (AssetImport, DirMounts), pickers in `src/app/main.ts`, `src/ui/AssetPanel.js`,
`src/ui/ViewportDrop.js`, `src/ui/ShaderPanel.js`, `src/core/print/Download.js`, `src/core/PersistenceManager.js`.

## Open questions / risks

- Windows code-signing: optional at first (SmartScreen warning) — decide before release.
- `.mixo` size on web (always-embed) — acceptable; heavy scenes = big files (known).
- Keep `master` untouched until Phase 1 is green + reviewed.
