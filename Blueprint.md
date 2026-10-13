# MIXOMESH — Implementation Blueprint v4.0
### Babylon.js · Vite/TypeScript Runtime · Chrome/Edge + Safari (OPFS tier)

> **For Codex / Claude Code:** Sections are in build order. Each module section is a contract:
> *Purpose · Data Structure · Public API · Implementation Rules · Pitfalls.*
> Use Babylon.js APIs whenever available — see §0.4 "Babylon-First Rule."
> Module size targets in §0.5 are enforced to keep files reviewable.
>
> **Runtime note (2026-06-17):** "Chrome/Edge Only" is being generalised to a
> capability-tiered `StorageAdapter` so the same code runs as a Web build AND a
> Windows Electron build (Chromium — same engine). Filesystem/persistence goes
> behind the adapter; core (import/ratio/validation/export/`.mixo`) is unchanged.
> See `docs/adr/0001-storage-adapter-web-electron.md` + `HANDOFF.md`.

## What this tool exists for

MIXOMESH is a browser-based 3D model assembly tool for **full-color 3D
printing**. It keeps textured models editable, validates printability, and
exports printer-ready packages. The supported runtime is Vite + TypeScript:
`index.html` loads `src/app/boot.ts`, which builds `window.BABYLON` from
pinned Babylon npm packages and starts `src/app/main.ts`.

**Primary target: Mimaki UV-inkjet full-color 3D printers** (3DUJ-553
default, 3DUJ-2207 + variants). They consume textured 3MF via the Materials
Extension OR OBJ+MTL+PNG. Continuous-tone textures are preserved end-to-end
— Mimaki paints ~10 M colors per surface, **not** one solid color per part.

**Secondary target: filament multi-color printers** (Bambu X1C, Prusa XL,
OrcaSlicer/PrusaSlicer ecosystem). They consume 3MF with `<colorgroup>` +
per-object `pindex` for filament-zone assignment, one solid color per part.

Per-printer reference data is **data-driven** via `src/config/printers.json`
(single source of truth for display name, vendor, bed, colour capabilities,
suggested export defaults and validation hints). Selecting a printer applies
its defaults; export format remains an explicit user choice (OBJ / 3MF / STL /
PLY / WRL) and is never hidden or blocked.

---

## PART 0 — GROUND RULES

### 0.1 Absolute Rules
- **Target browser:** Chrome / Edge (desktop) = full app incl. live file links; Safari/WebKit (iPad, iPhone, macOS Safari; all iOS/iPadOS browsers) = supported via the OPFS tier (projects in the browser, import/export by file pick + share/download, no live folder links). Firefox and other engines halt on startup with a message naming the supported browsers (`detectEngine` + `engineGate`, task 8.1).
- **1 Babylon Unit = 1 Meter.** UI shows mm: `mm = BU * 1000`.
- **All state mutations go through `StateManager.dispatch()`.**
- **All reversible actions push a Command to `HistoryManager`.**
- **All inter-module communication uses typed events from `events.js`.**
- **Export format is button-driven.** The Export panel's OBJ / 3MF / STL
  buttons choose the pipeline explicitly. Printer profile selection is a
  build-area reference for bed preview, dimension checks, labels, and scale
  context; it must not hide, switch, or block a specific export format button.
  Print-readiness hard errors may disable all format buttons together while
  keeping OBJ / 3MF / STL visible and manually chosen.
- **One-mesh-one-shader is an enforced invariant.** AssetLoader splits any
  `BABYLON.MultiMaterial` mesh into N single-material siblings at import,
  stamping one shared `logicalObjectId` (the lead sibling's id) on each
  SceneObject. One sibling is the visible logical object; the rest are
  material parts used by shader/export code. Validator + exporter re-union the
  siblings by `logicalObjectId`. `sourceGroupId` is still stamped at split time
  (save-file compat) but is migrate-only at runtime (Decision 33).
- **A multi-shader object is ONE logical object** regardless of how it arrives.
  Two cases get the same `logicalObjectId` (`_registerInstantiatedMeshes`):
  (1) a `BABYLON.MultiMaterial` split (shared split-time `sourceGroupId` stamp, used only as the import grouping key); (2) a glTF
  **multi-primitive** mesh — Babylon names primitives `<stem>_primitive<N>` and
  parents them under one node, so they share a stem + `parentId`. Most
  multi-shader models export as case 2. **Separate objects are distinct nodes
  with no `_primitive` name → never merged** (regression-tested with a 2-object
  glTF). The lead part is the visible object; the rest are material parts.
- **Validation runs at import time, non-blocking.** Re-runs blocking before
  export. Topology is **logical-object-aware**: a mesh whose
  `logicalObjectPartIds` has >1 part is validated as the **welded union** of
  those parts (positions only, no data copy), so seams between material parts
  are not mistaken for holes and a real hole across the whole object IS caught.
  Single-part objects validate directly. Integrity checks (zero verts, missing
  registry) stay per-mesh.

### 0.2 Runtime

`index.html` is the single supported app shell. It is served by Vite and loads
`/src/app/boot.ts` through an inline dynamic `import()` wrapper. `vite.config.ts`
sets `root` to the config file's directory and uses an absolute Rollup
`index.html` input, so Vite serves the repo root even if a tool launches it
from the wrong working directory. The wrapper does not make static file servers
supported; it exists so VS Code/Live Server style hosts that serve `.ts` as
`video/mp2t` fail visibly in `#boot-status` with the Vite command instead of
hanging forever on "Loading MIXOMESH...".

The static shell also contains `#viewport-size-guard`, a localized full-screen
status overlay shown by CSS below 900 px width. MIXOMESH is a dense desktop
3D/print workspace; below that width the 3D viewport and inspector columns are
not usable, so the app declares the minimum instead of clipping controls.
**PWA (task 8.7).** The hosted build is installable/offline: `public/manifest.webmanifest` (standalone, `start_url`/`scope` `./`, washi `#efe7d8` theme/background, PNG icons generated from the logo mark in `public/icons/`), `apple-touch-icon` + `apple-mobile-web-app-capable` in `index.html`, and `public/sw.js` (network-first for navigations/`index.html`; cache-first, filled on use, for hashed `./assets/*`, vendored `vendor/*` WASM, `env/*` HDRI and icons; versioned cache `mixomesh-<CACHE_VERSION>`, old caches deleted on activate; bump the version when vendored files change). `src/app/pwa.js` `shouldRegisterServiceWorker` registers it ONLY for http(s) + production build + non-Electron: never the Vite dev server, never `file://`/Electron. CSP needs no change (`worker-src 'self'`, manifest falls back to `default-src 'self'`).

`#renderCanvas` is focusable and carries `role="application"` plus an
accessible label because it owns custom 3D keyboard/pointer interaction.

`src/app/boot.ts` imports the pinned Babylon npm packages, assembles the legacy
`window.BABYLON` namespace expected by the existing JS modules, registers
materials/loaders/serializers, then imports `src/app/main.ts`. Runtime modules
that need Babylon continue to read it from the global:

```js
const BABYLON = window.BABYLON;
if (!BABYLON) throw new Error('Babylon.js failed to load');
```
Babylon npm package versions are pinned to the same version so
loader/material/serializer APIs cannot drift independently of the core engine.

Runtime contract:

- `package.json` declares Vite, TypeScript, JSZip, mp4-muxer (turntable
  video container — WebCodecs chunks → mp4, zero-dependency; loaded via
  dynamic `import()` in render/VideoRecorder.js so it builds as its own lazy
  chunk), and Babylon npm packages. Tests use Node's built-in test runner
  unless a future feature explicitly needs Vitest.
- `public/env/` holds the three prefiltered HDRI presets (`studio.env`,
  `neutral.env`, `outdoor.env` — copies of Babylon CDN environment assets,
  served at `/env/*` by Vite and copied into `dist/`).
- Dependency install is npm-first via `node scripts/install-deps.mjs`, which
  forces repo-local `.tmp/` and `.npm-cache/` paths and bypasses broken
  user-level npm shims on Windows by invoking the system npm CLI through Node.
  Bun may run npm-compatible scripts, but it is optional tooling and must not
  be a project dependency.
- Vite 8 requires Node `>=22.12.0` on the Node 22 line; the package engine
  encodes that minimum.
- `vite.config.ts` temporarily sets `build.chunkSizeWarningLimit = 5000`
  while `src/app/boot.ts` + `src/app/main.ts` bundle Babylon plus the migrated
  JS modules into one Vite entry. Lower/remove that budget when domain-level
  code splitting lands. ⚠ Do NOT force a `@babylonjs` `manualChunks` vendor
  chunk under rolldown (Vite 8): it defeats tree-shaking — measured 7.3 MB
  vendor vs the 4.2 MB tree-shaken boot chunk (2026-06-13).
- `tsconfig.json` temporarily enables `allowJs` with `checkJs: false` so the
  typed Vite bootstrap can import the migrated JavaScript modules before the
  entire app is converted to TypeScript. Remove both flags when those modules
  are typed.
- `src/` owns application code and data: app bootstrap, core managers, UI,
  config JSON, styles, typed contracts, import pipeline, and export pipeline.

### 0.2a UI i18n Contract

All authored visible UI copy lives in `src/i18n/locales/{en,ja,zh-Hant}.json`.
UI modules render copy through `t(key)` or `applyTranslations(root)` from
`src/i18n/index.js`; `applyTranslations` owns the static DOM convention:
`data-i18n-key` for textContent plus `data-i18n-title`,
`data-i18n-aria-label`, and `data-i18n-placeholder` for attributes. Dynamic
render helpers may wrap `t()` (for example `_txt()` / `_attr()`) but must still
escape before inserting into HTML strings. User/project data (object names,
shader names, printer profile display names, filenames) is not translated.

Locale switches dispatch `LOCALE_CHANGED`; components with persistent static
DOM call `applyTranslations`, while components that generate dynamic labels
re-render or update their text on that event. `npm run i18n:check` is part of
the verification gate: it checks literal `t()` / wrapper calls, `data-i18n-*`
attributes, `labelKey` constants, EN key coverage, JA/zh-Hant gaps, and
hardcoded visible English text inside `src/ui` markup strings.

### 0.3 File Layout
```
index.html                 ← Vite app shell
public/manifest.webmanifest ← PWA manifest (task 8.7); public/sw.js ← service worker; public/icons/ ← app icons
package.json               ← npm scripts, runtime deps, Vite deps
.npmrc                     ← local npm cache and install policy
vite.config.ts             ← Vite dev/build config
tsconfig.json              ← TypeScript migration config
DESIGN.md                  ← UI design reference for Stitch mockups (mirrors tokens.css + blender.css; CSS wins)
docs/design/stitch-capture.md ← Stitch capture recipe (prod build on :5180, fixture scenes only, owner OK to bind/upload)
scripts/
  install-deps.mjs         ← dependency bootstrap with local cache/temp paths
  ui-screenshot.mjs        ← headless 4-workspace capture harness (PROBE=1 dumps geometry)
  i18n-check.mjs           ← validates locale key coverage (en vs ja/zh-Hant)
public/
  env/                     ← HDRI presets: studio/neutral/outdoor .env (prefiltered cube textures)
  vendor/
    NOTICE.md              ← provenance for every vendored file: upstream URL, licence, version /
                             commit SHA (2026-09-18, review M11). tests/hygiene.test.mjs asserts all
                             7 vendored files exist, each .js carries an attribution header, and the
                             only http(s) literals anywhere in them are 3MF XML NAMESPACE hosts —
                             so a re-vendor cannot smuggle in a runtime CDN fetch
    meshfix/               ← MeshFixLib (MIT) — mesh-fix-core.js/.wasm + mesh-fix-lib.js, vendored
                             classic scripts (UMD/global-assignment, NOT ES modules); loaded by
                             script-tag injection, never a runtime CDN — see §9 Watertight repair
    manifold-3d/           ← Manifold (Apache-2.0) — manifold.js + manifold.wasm, vendored so
                             InitializeCSG2Async({ manifoldUrl }) resolves offline (Boolean + CSG
                             re-bake); both vendor dirs resolve via `new URL(rel, document.baseURI)`
                             so they load under `npm run dev`, GitHub Pages, AND Electron `file://`
                             — through the ONE helper `core/vendorUrl.js` (2026-09-18, review M1;
                             three copies of it had drifted across MeshRepair/PrintPipeline/BooleanService)
src/
  app/boot.ts              ← Babylon npm namespace bridge
  app/main.ts              ← app bootstrap + dependency wiring
  app/entry.js             ← pre-boot (no Babylon) check for IndexedDB / showDirectoryPicker
  app/pwa.js               ← service-worker registration predicate (task 8.7; hosted prod build only)
  import/                  ← typed import pipeline contracts
  export/                  ← typed export pipeline contracts + export planner
  config/                  ← editable data, no code change (JSON import attrs)
    printers.json          ← printer profiles (single source of truth)
    scale-presets.json     ← SCALE_PRESETS (PrintManager)
    swatches.json          ← DEFAULT_SWATCHES (ShaderLibrary)
    default-settings.json  ← factory per-user PANEL settings (StateManager INITIAL_STATE + SettingsStore)
  styles/
    tokens.css             ← CSS variables (neutral Blender-gray surfaces, --ctl-* control tokens)
    layout.css             ← panel grid, splitters, per-workspace section visibility
    blender.css            ← Blender-inspired control language overrides (loaded LAST)
    components.css         ← compatibility note; subsystem CSS is split below
    components/
      asset.css
      outliner.css
      shell.css
      properties.css
      shader.css
      context-modal.css
      print.css
      viewport.css
      project.css
      progress.css
  core/
    events.js              ← imported by everything
    StateManager.js
    HistoryManager.js      ← undo/redo stack + façade re-exporting commands/*
    commands/
      support.js           ← shared command helpers (pivot detach, transforms, state patch)
      TransformCommands.js ← Transform / TransformSwab
      HierarchyCommands.js ← Visibility/Lock/Rename*/Delete/Duplicate/SmartReplace/PrintPart
      ParentCommands.js    ← Reparent/Unparent/CreateGroup/Group/Ungroup
      ShaderCommands.js    ← ShaderCreate/Assign/Update/Duplicate/Delete, UVOverride, ColorApply
      ScaleCommands.js     ← RescaleWorld + SourceUnit
      AssetCommands.js     ← RelinkAssetCommand (undoable file refresh/find-moved)
      BooleanCommands.js   ← CombineCommand (kitbash combine with CSG2 + embed codec)
      PlacementCommands.js ← AlignCommand + bed-snap + drop-stagger (placement verbs)
      SliceConnectorCommands.js ← geometry planning commands for slice + connector preview
    InputManager.js
    SceneManager.js        ← engine/lighting/overlays orchestrator (camera/pivot split into scene/)
    WorkerImport.js        ← main side of worker OBJ parse: rebuild meshes from transferables
    ValidateWorker.js      ← main side of worker topology validation (transfer pos/idx, get counts)
    workers/
      ObjParse.worker.js   ← Babylon OBJ/MTL loader in a NullEngine worker (no UI freeze)
      MeshValidate.worker.js ← pure-math topology check (weld + non-manifold + signed-volume), off-thread
      Base64.worker.js     ← base64 codec worker for large asset round-trip (load/save)
      base64Codec.js       ← shared b64 codec (main + worker)
    Selection.js           ← selection set + active id + pivot mode (§4b)
    LogicalObjects.js      ← multi-part object grouping by logicalObjectId + print-unit collection
    UnloadGuard.js         ← beforeunload hook + async import flight detection (F20)
    CursorTools.js         ← 3D cursor manipulation: pick, move, selection↔cursor swap (undoable via command)
    BoxSelect.js           ← marquee/rubber-band select: pure screen-rect hit-test + DOM overlay (§7 Mouse)
    Hover.js               ← hover highlight driver: ≤1 pick/frame, click-depth target, budget gate, cursor (§6 Mouse, §7 outline)
    SnapUnits.js           ← snap steps in mm/deg/× → BU/rad, gizmo snap distances, arrow-nudge step + direction (§6)
    SettingsStore.js       ← per-user PANEL settings: localStorage persist + seed + per-section/all reset (§ Settings persistence)
    AssetLoader.js         ← mesh-asset façade + release/remove/reset lifecycle (impl in assets/)
    import/
      ImportMetadata.js    ← glTF extras reader: ratio + Mixomesh import mode
      ImportHierarchy.js   ← group node extraction from glTF empty parents + multi-primitive stems
      ImportLimits.js      ← per-file size/triangle budget gates (auto-skip validation on huge meshes)
    ImportNormalizer.js    ← import-normalization seam (units/ratio/RH→LH bake)
    ShaderLibrary.js
    vendorUrl.js           ← the ONE public/vendor/ URL resolver (document.baseURI-relative)
    Base64Worker.js        ← entrypoint for Base64.worker.js (encoder/decoder for large assets)
    MeshValidator.js       ← what is WRONG with a mesh: topology via worker (inline fallback)
                             + group-union + result cache. Repair orchestration lives in
                             repair/RepairSession.js (2026-09-18, review I9) and is re-exported
                             from here so the public API surface is unchanged
    repair/
      MeshRepair.js        ← the ENGINE seam: vendored MeshFixLib (merge → degenerate → winding →
                             duplicates → normals → non-manifold → hole fill), REPAIR_TRIANGLE_CAP
                             on both repair AND diagnose, REPAIR_TIMEOUT_MS, engine-output
                             validation, corner-accurate UV re-attachment — see §9 Watertight repair
      RepairSession.js     ← repair ORCHESTRATION: applyGeometryFix / autoFix / repairObject (walks
                             a multi-part object's parts) / repairObjects / replayGeometryFixes
                             + the geometryFixes bookkeeping (2026-09-18, review I9)
      Diagnose.js          ← the ONE guarded engineDiagnose() call: classifies no-engine /
                             too-large / real failure and logs it with the mesh name (review I5)
      Weld.js              ← the ONE vertex weld (weldMesh): merges only vertices sharing BOTH
                             position and UV, so the unconditional `weld` export prep step cannot
                             tear a textured part's seams (review I6 + C1)
      CapLoops.js          ← reusable hole-cap algorithm for repair + export preview
      GroupRepair.js       ← multi-part object repair (walks parts, reduces per-part result to single summary)
    BooleanService.js      ← interactive Boolean (kitbash combine): eligibility gating + CSG2 compute — §Boolean + ADR 0002
    SliceConnectorService.js ← viewport Slice & Connector geometry planning — §Slice Connector
    hierarchy/
      HierarchyIntegrity.js ← cycle detection + parent change validation (safe reparenting)
    storage/
      StorageAdapter.js    ← unified KV + mount/list/read interface for web (IDB) + desktop (Electron main)
      DesktopStorageAdapter.cjs ← Electron-side file/mount implementation (main process via IPC)
      capabilities.js      ← platform capability detection (persistAssets / relinkByPath / writeFiles / watchFiles)
      AssetSource.js       ← asset source-descriptor builder (file handle / mount ref / embedded URI)
    GeometryCodec.js       ← compact .mxvd geometry codec for baked Boolean results (synthetic embedded asset)
    placement/AlignMath.js ← pure align-delta math for placement verbs — see §Placement + ADR 0003
    placement/BedPlacement.js ← pure drop/centre/face-normal quaternion math
    PersistenceManager.js  ← persistence façade + file-handle lifecycle: save/saveAs/open/newProject/openRecent (impl in persist/)
                             open/openRecent/newProject call assertNoImportInFlight BEFORE the dirty confirm;
                             AssetImport flags the import (_importBegin) before its first await (F20, task 0.5)
    persist/
      constants.js         ← schema version, file types, recent/autosave keys, scan cap, SILENT
      ProjectIntegrity.js  ← portable .mixo save gate: required asset refs + missing-byte error shape
      ProjectSerializer.js ← buildDocument + asset/object/group serialise, b64 codecs, transform (de)compose
      ProjectValidator.js  ← post-load state integrity check (no orphan refs, valid ids)
      ProjectLoader.js     ← loadProject pipeline: migrate, world reset, ghost meshes, groups, relinkAsset
      AssetResolver.js     ← tiered byte resolve: live path → file handle → embedded → null (hash-scan only user-invoked; task 4.3)
      RecentProjects.js    ← recent-projects list (storage adapter kv key `recent_projects`) + save-time viewport thumbnail
      Autosave.js          ← interval autosave (skipEmbed A9) + boot crash recovery, keyed by project.id
      AutosaveKeys.js      ← autosave key layout + deleteAutosave (snapshot + per-hash images)
      ProjectId.js         ← mintProjectId() — stable project identity (0.11)
      DirtyTracker.js      ← position-based + sticky dirty, isDirty/clearDirty, dirty-confirm modal
      LoadGate.js          ← pre-load async gate (import flight check, unload guard, browser perms)
    PrintManager.js        ← thin façade (~50 lines; size budget in §file-size-budget) — re-exports the API surface; named exports + namespace come from one frozen API object so they cannot drift
    print/
      ExportContext.js     ← THE ONE typedef + builder; owns BU_TO_MM; previewExportContext + getExportedDimensions + getExportReference live here
      PrintPipeline.js     ← export orchestrator + STL/3MF inline serializers; CSG/weld/validate; no module-level mutable state
      BedFit.js            ← pure positive-XYZ build-volume bounds/overflow check
      PrintReadiness.js    ← stable format-independent readiness issues + live export-bounds projection
      ObjWriter.js         ← OBJ + MTL serializer + Mimaki solid-PNG synthesis (format-specific code, NOT in the orchestrator)
      ThreeMFWriter.js     ← 3MF colorgroup + Materials Extension package writers
      ThreeMFBambu.js      ← Bambu 3MF with Production ext + per-object extruder (split-by-material delegate)
      PrintNaming.js       ← filename helpers (take ctx; no getState)
      PrintPrep.js         ← reusable clone prep steps (THROW on missing ctx.pivot/ratioFactor/unitFactor)
      PrintSpace.js        ← THE axis + winding seam (Babylon LH Y-up ↔ print RH Z-up); used by 3MF/STL writers + 3MF loader
      StlWriter.js         ← binary little-endian STL through PrintSpace (Babylon STLExport rejected)
      PlyWriter.js         ← binary LE PLY, per-vertex colour (bilinear from full-res source texture), PrintSpace (1.6)
      WrlWriter.js         ← VRML 2.0 IndexedFaceSet + ImageTexture, mm in PrintSpace Z-up frame (1.6)
      PrintFormats.js      ← format registry: labels, prep order, serializers
      PrintPackaging.js    ← zip/blob packaging + download dispatch
      PrinterProfiles.js   ← current/explicit printer profile resolution + bed helpers
      MaterialPresets.js   ← preset material defs by printer (not yet used; future color/filament picker)
      ExportPlanner.js     ← pure filename math (consumed by PrintNaming)
      ExportTextures.js    ← export-side texture collection (OBJ + Mimaki shared); texture file names unique case-INsensitively (first keeps casing, later get _N)
      Download.js          ← save picker + anchor fallback
      PrintCost.js         ← per-unit volume (never Boolean-unioned) × density × price +
                             support premium; overlap = AABB flag only, never subtracted —
                             see §12 Cost quote
    scale/
      ScaleMath.js         ← per-object ratio, effective scale, print-size target math
      ScaleTypes.ts        ← type-only: SourceUnit, AuthoredScale, SceneScale, PrintScale shapes
    shaders/
      ShaderSignature.js   ← exact supported appearance identity + duplicate candidates
      ColorSpace.js        ← sRGB/linear texture meta reading (not in-shader — authoring metadata)
    assets/
      AssetTypes.js        ← supported extensions + extension parser
      AssetIndex.js        ← immutable mounted-file index + scoped query/refresh fallback
      DisplayNames.js      ← asset → user-visible name (escape, dedupe, locales)
      TextureReadback.js   ← shared GPU readback: Promise readPixels, float/RGB, Y-flip
      TextureAssets.js     ← texture-asset registry: user/imported, §10b dedupe + rebind, recap-all
      TextureImageStore.js ← SHA-256 → one immutable canonical encoded image blob
      TextureView.js       ← sampling/color-space view normalization + stable identity key
      TextureSource.js     ← full-res export-PNG per assetId, frozen pre-cap (export fidelity)
      TextureCap.js        ← viewport texture cap: capture-then-downscale GPU, export reads source
      MeshSplit.js         ← split-on-import invariant (pure planner + Babylon factory)
      BlobUrls.js          ← shared assetId → object-URL registry
      MeshRegistry.js      ← module-local container/mesh/orphan registries + id minting
      DirMounts.js         ← adapter-owned directory refs: browser IDB restore; desktop session token
      ObjSiblings.js       ← OBJ mtllib/texture sibling map + PreprocessUrl swap + revoke
      AssetRegistration.js ← SceneObject/collection minting, unique names, logical-object grouping, validation queue
      AssetThumbnail.js    ← idle asset thumbnail (THUMB_LAYER camera-mask isolation)
      AssetImport.js       ← live import: blob/handle → container → scene, overlay, library-GLB path, re-instantiate
      AssetRestore.js      ← project restore + clones: restoreContainer, cloneMeshAsNewObject, asset bytes
    scene/
      SceneConstants.js    ← viewport/grid/camera/outline constants (+ dark bg pair)
      SelectionOutline.js  ← custom mask-RTT selection silhouette + post-process (GLSL + WGSL twin, picked by engine)
      Cursor3D.js          ← 3D cursor visual: ball + billboard crosshair + ring + snap preview
      BedGrid.js           ← printer-bed floor, grid styling, FRONT tag, bed preview
      CameraRig.js         ← camera creation, CAD pointer nav, presets, framing, follow, optics
      PivotSession.js      ← GizmoManager + selectionPivot parenting + drag→TransformCommand
      EnvironmentRig.js    ← 3-light studio + RENDERONCE shadows, shadow-catcher floor, HDRI IBL
      ViewEffects.js       ← SSAO + cross-section: clip plane + back-face fill (solid interior) + cut-plane border
      BackfaceCheck.js     ← inverted/back-face highlight (red back-face clones, viewport overlay)
      ImportBounce.js      ← scale-pop on ASSET_INSTANTIATED (exact-restore, reduced-motion aware)
      EdgeOverlay.js       ← wireframe-edges overlay clones + emissive wire material
      AdaptiveResolution.js ← capped DPR + safety-valve dynamic downscale for heavy scenes
      TriangleCount.js     ← scene budget tracking: cap + color-coded budget bar
    RenderOutput.js        ← Scene ▸ Rendering façade over render/* (frozen export names)
    render/
      RenderMath.js        ← pure: turntable easing, video format pick, frame fit, filenames
      FrameCapture.js      ← RTT pipeline: capturePng (WebGL+WebGPU), captureFrameRGBA, offline frame renderer, furniture hide
      RenderLock.js        ← concurrent render guard (export disables live preview, etc.)
      SweepRig.js          ← rigid camera/lights/env turntable rotation (shared by preview + recorder)
      TurntablePreview.js  ← live viewport sweep (Esc / tab-hide cancel), owns preview handle
      VideoRecorder.js     ← offline WebCodecs encode → mp4 (mp4-muxer lazy), owns recording flag
    ThreeMFLoader.js       ← `.3mf` SceneLoader plugin = inverse of 3MF export
    SnapUnits.js           ← snap steps in mm/deg/× → BU/rad, gizmo snap distances, arrow-nudge step + direction (§6)
    Hover.js               ← hover highlight driver: ≤1 pick/frame, click-depth target, budget gate, cursor (§6 Mouse, §7 outline)
    idb.js                 ← IndexedDB layer for FileSystemHandles + kv store (§11b)
    hash.js                ← sha256Hex — shared §10b identity hash (AssetLoader + persistence)
    Icons.js               ← Lucide wrapper: returns SVG strings by name
    GeometryCodec.js       ← compact .mxvd codec for baked Boolean results (synthetic embedded asset)
  i18n/
    index.js               ← locale API (t, applyTranslations, LOCALE_CHANGED event)
    detect.js              ← browser language detection (fallback to en)
    interpolate.js         ← simple message interpolation (no named params)
    plural.js              ← plural/singular form selector
    locales/
      en.json              ← English UI text (canonical source)
      ja.json              ← Japanese localization
      zh-Hant.json         ← Traditional Chinese localization
  ui/
    lib/                     ← shared panel-wiring helpers (2026-07-17 restructure)
      fields.js              ← escEnter / wireNumbers / wireSelects / wireToggles / reflectToggle
      sections.js            ← createCollapseController (session Set or per-user localStorage)
    Outliner.js
    PropertiesPanel.js
    ShaderPanel.js
    AssetPanel.js
    ContextMenu.js
    PrintPanel.js
    print/
      CostBlock.js         ← Export tab ▸ Cost block: renders + wires the live material-cost
                             quote (§12 Cost quote); reads PrintCost.js, kept out of PrintPanel.js
    StatusBar.js
    MeshStats.js           ← status-bar centre: scene-wide triangle budget (always-on, cached) + selection tris/mm/watertight (2026-09-18)
    RepairFeedback.js      ← the ONE repair-result → toast mapping: nothing applied → info
                             "nothing to repair", applied-but-still-open → warning, clean →
                             success with the ENGINE's counters; a batch with failures reports
                             the failures INSTEAD of success (2026-09-18, review I7b/I7c)
    Toast.js
    Status.js              ← centralized error + loading policy (reportError / guard / runTask / safeAsync)
    Modal.js               ← generic modal helper  [5.8: non-blocking MODAL_OPEN while a modal is up QUEUES (FIFO); `blocking:true` still takes over; each onClose fires once]
    AppShell.js            ← shell controls: panel collapse/resize + boot status
    renderSafe.js          ← escaping helpers + validated image data URLs
    ProjectMenu.js         ← header toolbar (new/open/save/recent) + persistence modals (§13b)
    SliceConnectorSession.js ← viewport-first cut plane + connector placement session — §Slice Connector
    ProgressOverlay.js     ← full-screen blocking overlay during exports (§13b); optional Cancel (show(title,{onCancel|controller}), Esc/Cancel fire once → "Cancelling…"; hidden overlay never blocks keys — 5.8)
    ViewportDrop.js        ← drag-and-drop onto viewport (asset panel + OS files)
    ViewportEmptyState.js  ← zero-object Import Model / Open Project entry point
    ImportError.js         ← safeImport wrapper + importError detail modal (import failures)
    ViewportToolbar.js     ← floating bottom toolbar (Fusion 360-style)
    ViewportToggles.js     ← display-mode selector (Shaded/Matte/Base Color) + wireframe-edges overlay, under the NavCube
    ScenePanel.js          ← Scene workspace panel: grid / environment (incl. floor) / camera / Rendering output
    RenderFrame.js         ← Render-view compose overlay (aspect frame + darkening)
    Workspace.js           ← workspace presets (PART 13b): pill, hotkeys, scroll memory
    NumberScrub.js         ← wheel-scrub on number inputs (delegated, panel never scrolls)
    NavCube.js             ← top-left orientation widget
    CursorPanel.js         ← N-key 3D cursor position/snap panel (Shift+N)
    CopyPaste.js           ← Ctrl+C/V modal: aspect chooser (Location/Rotation/Scale/Loc+Rot/All)
    LocaleSwitcher.js      ← locale picker (header button, client-side only)
    FindMoved.js           ← file-not-found finder UI (relink modal)
electron/                  ← Electron app shell (Windows + Linux desktop build, macOS deferred)
  main.cjs                 ← Electron main process: window lifecycle, IPC bridges, protocol handlers
  preload.cjs              ← Electron preload script: IPC API surface for renderer context
  WindowSecurity.cjs       ← sandbox + CSP + BrowserWindow security config
  DesktopStorageAdapter.cjs ← file/directory handle bridge from main → renderer via IPC
  KvStore.cjs              ← key-value store for desktop (file-based, not IDB)
  OpaqueFileRegistry.cjs   ← file handle persistence layer (opaque tokens for renderer)
tests/                     ← headless harness — Node-native, no build (§14b)
  register-hooks.mjs       ← `node:module.register` entry; runner uses --import
  cdp-harness.mjs          ← Chrome DevTools Protocol CDP launch + teardown (shared by all browser smokes)
  browser-smoke.mjs        ← Vite-backed local Chrome/Edge CDP smoke test; no package deps.
                             Beyond shell/UI checks it functionally pins the rendering stack:
                             transparent (alpha 0) + opaque (alpha 255) PNG capture, the
                             floor shadow-only swap (lower-frame alpha < 255 with floor on),
                             a real 1 s offline-WebCodecs mp4 recorded headless, the rigid
                             turntable invariants (|position| AND |target| on origin circles
                             mid-sweep with a panned composition), the HDRI mirror-sphere
                             rotation probe (mid-sweep capture ≈ baseline, camera-only ≠),
                             render-frame overlay + crosshair, and Scene-panel controls
  browser-video-check.mjs  ← HEADED full-size turntable check (`test:video`, manual)
  browser-webgpu-check.mjs ← WebGPU backend + WGSL outline-shader check (`test:webgpu`;
                             headless SKIPs — no adapter; `WEBGPU_HEADFUL=1` for real GPU)
  browser-export-smoke.mjs ← CDP smoke: export pipeline round-trip (3MF/OBJ/STL byte-identical checks)
  browser-repair-smoke.mjs ← CDP smoke: import + repair + export watertight validation
  browser-group-repair-smoke.mjs ← CDP smoke: multi-part group repair edge cases
  electron-smoke.mjs       ← Electron app smoke (window open, project load, headless)
  electron-security.test.mjs ← CSP + sandbox policy validation
  webcodecs-probe.mjs      ← headless VideoEncoder sanity probe (diagnostic, not in npm scripts)
  scan-probe.mjs           ← empirical orientation verification (trimesh / PrusaSlicer CLI compare)
  render-output.test.mjs   ← RenderMath: easing/format/frame-fit/filename contracts
  hooks.mjs                ← resolver hook: 'jszip' → stub, './idb.js' → stub
  jszip-stub.mjs           ← minimal JSZip for export tests
  idb-stub.mjs             ← in-memory mirror of src/core/idb.js
  env.mjs                  ← installEnv(): Babylon shim, atob/btoa, DOMParser
  export.test.mjs          ← PrintManager export pipeline
  export-context.test.mjs  ← ExportContext builder + freezing contracts
  export-planner.test.mjs  ← filename/profile/scale planner
  export-gate.test.mjs     ← exportGate button set/order/actions; Auto-fix absent when nothing is fixable
  print-readiness.test.mjs ← readiness issue detection + live export-bounds
  print-space.test.mjs     ← axis + winding seam contracts (LH↔RH, Y-up↔Z-up)
  print-packaging.test.mjs ← zip/blob packaging + filename dedup
  print-cost.test.mjs      ← PrintCost volume/overlap/quote contracts
  threemf-materials-ext.test.mjs ← textured 3MF Materials Extension writer/loader
  threemf-components.test.mjs ← 3MF component hierarchy import/export
  threemf-loader-materials.test.mjs ← 3MF Materials Ext loader round-trip
  threemf-bambu.test.mjs   ← Bambu flavour 3MF with Production ext
  hierarchy.test.mjs       ← hierarchy parent commands + cycle rejection
  hierarchy-integrity.test.mjs ← cycle detection + parent change validation
  parent-commands.test.mjs ← Reparent/Ungroup/Duplicate/Delete/Group
  transform-commands.test.mjs ← Transform/Scale/Rotation command contracts
  safety-commands.test.mjs ← safe Undo/Redo/History on malformed state
  history-pivot.test.mjs   ← pivot mode persistence through undo/redo
  selection-scope.test.mjs ← click-depth scope navigation (click/double-click/Esc)
  selection-groups.test.mjs ← group selection behavior
  logical-objects.test.mjs ← multi-part object grouping by logicalObjectId
  validator.test.mjs       ← MeshValidator severity + position-welded manifold
  validator-group.test.mjs ← logicalObjectId union topology checks (welded seams)
  validation-cache.test.mjs ← result cache + repaint gate + severity filtering
  split-on-import.test.mjs ← MultiMaterial split invariant
  split-join.test.mjs      ← Separate by material + Merge into one object commands
  mesh-repair.test.mjs     ← MeshRepair engine wrapper contracts (fake-engine __test)
  weld.test.mjs            ← the shared weldMesh: shared edges merge, (position, uv) SEAMS never do
  persistence.test.mjs     ← PersistenceManager `__test` helpers + 5-tier resolve
  persistence-open.test.mjs ← project open + migrate + load pipeline
  persistence-saveas.test.mjs ← save / saveAs / newProject workflows
  persistence-load-guards.test.mjs ← async import flight detection (LoadGate)
  persistence-abort.test.mjs ← write abort + recovery on browser perms revoked
  portable-project.test.mjs ← .mixo portable sealing (no asset paths)
  project-validator.test.mjs ← post-load state integrity checks
  printer-profile.test.mjs ← profile resolution + default application
  scale.test.mjs           ← ScaleMath contracts + compatibility helpers
  per-object-ratio.test.mjs ← per-object ratio + effective scale + target printing
  state-shape.test.mjs     ← default state and migration invariants
  storage-adapter.test.mjs ← unified KV/mount interface for web + desktop
  adapter-routing.test.mjs ← FSA/IDB routing through adapter
  kv-store.test.mjs        ← desktop KV store (Electron main)
  opaque-file-registry.test.mjs ← file handle token persistence
  capabilities.test.mjs    ← platform capability detection
  asset-index.test.mjs     ← mounted-file index + query/refresh
  asset-resolve.test.mjs   ← 5-tier asset resolve (live/file-handle/hash/embedded/ghost)
  asset-resolver-unit.test.mjs ← hash scan + tier priority
  display-names.test.mjs   ← asset name dedup + escaping
  library-import.test.mjs  ← GLB library mode (library=1 marker)
  import-metadata.test.mjs ← glTF extras reader (ratio, library mode)
  import-normalizer.test.mjs ← units/ratio bake into vertices
  import-limits.test.mjs   ← size/triangle budget gates
  geometry-codec.test.mjs  ← .mxvd codec (baked Boolean embed)
  boolean-service.test.mjs ← CSG2 eligibility + combine safety
  bed-fit.test.mjs         ← positive-XYZ bounds/overflow check
  bed-placement.test.mjs   ← drop/centre/face-normal snap math
  align-math.test.mjs      ← placement verb math
  slice-connector-service.test.mjs ← cut plane + connector geometry
  color-space.test.mjs     ← sRGB/linear metadata reading
  shader-identity.test.mjs ← appearance identity + duplicate detection
  shader-live-update.test.mjs ← live material edits + undo
  texture-identity.test.mjs ← texture dedupe + rebind
  texture-image-identity.test.mjs ← SHA-256 canonical store
  texture-readback.test.mjs ← GPU readback (float/RGB/Y-flip)
  texture-cap.test.mjs     ← viewport cap + export reads source
  texture-source.test.mjs  ← full-res export-PNG per assetId
  render-safe.test.mjs     ← HTML escaping + image data URLs
  render-math.test.mjs     ← turntable easing/format/frame-fit
  mesh-stats.test.mjs      ← HUD cache/format (tris/mm/watertight)
  box-select.test.mjs      ← marquee hit-test + hover target/cursor
  snap-units.test.mjs      ← mm snap steps + nudge directions
  modal-queue.test.mjs     ← non-blocking MODAL_OPEN queueing (5.8)
  progress-overlay.test.mjs ← blocking overlay + Cancel + modal priority
  unload-guard.test.mjs    ← beforeunload hook + async import flight
  dirty-tracking.test.mjs  ← position-based + sticky dirty
  settings-store.test.mjs  ← per-user settings persistence
  workspace.test.mjs       ← workspace presets + panel collapse
  i18n.test.mjs            ← i18n API + locale detection
  i18n-detect.test.mjs     ← browser language detection
  i18n-plural.test.mjs     ← plural/singular form selector
  pivot-session.test.mjs   ← GizmoManager + pivot parenting
  triangle-budget.test.mjs ← caps.triangleBudget import gate
  hygiene.test.mjs         ← vendor file provenance + no CDN literals
  worker-import.test.mjs   ← ObjParse worker + mesh rebuild
  fixtures/
    make-textured-quad.mjs ← generates textured-quad.glb (2×2 PNG baseColor)
    make-open-tetra.mjs    ← generates open-tetra.glb: 4-vertex tetrahedron with 3 of 4
                             faces (one open boundary loop) for the repair smoke above
                             Both export their bytes as well as writing the file, so
                             `hygiene.test.mjs` can assert the COMMITTED .glb still matches its
                             generator; `npm run fixtures` regenerates both (2026-09-18, review T7)
```

**npm test scripts.** `npm test` is the headless node:test suite ONLY — the
browser smokes launch a real Chrome/Edge plus a Vite server, so they must
never be reachable from it. `npm run test:all` chains them in order:
`test && test:browser && test:export && test:repair` (2026-09-18, review
CIA F8). `npm run fixtures` regenerates the committed `.glb` fixtures.

### 0.3b Rebuild Architecture Map

This section is the short path for reconstructing the app if `src/` is lost.
Module sections later in the file own the deeper contracts; this map records
who creates data, who owns live resources, and which names must stay stable.

#### Boot and Dependency Order

`index.html` is the only shell. It contains static roots for the viewport,
header, panels, modals, toasts, and progress overlay, then dynamically imports
`/src/app/boot.ts`. A server that serves `.ts` with the wrong MIME type is not
supported; the shell only turns that failure into a visible boot message.

Boot order:
1. `src/app/boot.ts` imports pinned Babylon packages, `@babylonjs/loaders`,
   `@babylonjs/materials`, and `@babylonjs/serializers`.
2. `boot.ts` builds `window.BABYLON` with the exact symbols used by the JS
   modules: core scene/mesh/camera/math/material classes, `CubeTexture`
   (HDRI prefiltered env load), `Plane` (section clip plane),
   `SSAO2RenderingPipeline` (viewport AO), `GridMaterial`,
   `ShadowOnlyMaterial` (transparent-PNG floor swap), `OBJExport`, and
   `STLExport`.
3. `boot.ts` imports `src/app/main.ts`.
4. `main.ts` boot gate (task 8.1): `engineGate(engine)` blocks gecko/other
   engines (chromium + webkit pass), then `storage.ready()` for the selected
   tier.
5. `main.ts` initialises modules in this order: `Toast`, `StatusBar`,
   `SceneManager`, `InputManager`, transform-commit history hook, `Modal`,
   `Outliner`, `PropertiesPanel`, `ShaderPanel`, `PrintPanel`, `ContextMenu`,
   `AssetPanel`, `ViewportToolbar`, `NavCube`, `PersistenceManager`,
   `ProjectMenu`, `AppShell`, `ViewportDrop`.
6. `main.ts` registers global project shortcuts (`Ctrl+S`,
   `Ctrl+Shift+S`, `Ctrl+O`, `Ctrl+N`), reapplies overlay defaults, starts
   autosave, focuses the canvas, then asks the Asset Panel to remount the last
   folder and, after that prompt resolves, offers the newest autosave if it is
   newer than its project's last save (`recoverAutosave`, task 0.11).

No module except `boot.ts` imports Babylon npm packages directly. Runtime JS
modules read `window.BABYLON`; TypeScript-only contract modules may import
types.

#### Source of Truth by Concern

| Concern | Source of truth | Runtime owners |
|---|---|---|
| App state | `src/core/StateManager.js` initial state and dispatch bus | all modules read via `getState()` and mutate via `setState()`/commands |
| Events | `src/core/events.js` | callers import `EVENTS`; no raw strings in calling code |
| Live Babylon meshes | `AssetLoader` `_meshRegistry` | state stores mesh ids only |
| Live Babylon containers/textures/blob URLs | `AssetLoader` module-local maps | persistence asks `AssetLoader` for bytes; reset revokes URLs |
| Selection visuals | `Selection` plus `SceneManager` highlight/gizmo APIs | state selection is silent against dirty |
| Undo/redo | `HistoryManager` command stack | reversible scene/user edits push commands |
| Printer behavior | `src/config/printers.json` | `PrinterProfiles`, `PrintPanel`, `SceneManager`, `PrintManager` |
| Scale math | `src/core/scale/ScaleMath.js` (types in `ScaleTypes.ts`) | import normalization, print planner, tests |
| Editable presets | `src/config/scale-presets.json`, `src/config/swatches.json` | `PrintPanel`, `ShaderPanel` |
| Default panel settings | `src/config/default-settings.json` | `StateManager` INITIAL_STATE, `SettingsStore` (seed/save/reset) |
| Per-user settings persistence | `SettingsStore` + `localStorage['mx-settings-v1']` | seeds boot/New; File-wins on `.mixo` open; reset buttons |
| Persistence | `.mixo` v3.4 JSON plus storage adapter (IndexedDB/KV on web, main-only refs on desktop) | `PersistenceManager`, `StorageAdapter`, `idb.js` |
| Export packaging | `PrintManager` orchestrator plus `src/core/print/*` seams | `PrintPanel` invokes public export entry points |
| UI markup safety | `src/ui/renderSafe.js` | every string-template UI renderer |

#### Runtime Dataflow

Import path:
1. `AssetPanel` or `ViewportDrop` obtains a `File`, `Blob`, or
   File System Access handle.
2. `AssetLoader.loadFromBlob/loadFromHandle` validates the extension via
   `src/core/assets/AssetTypes.js`, loads an `AssetContainer`, and reads glTF
   custom properties through `src/core/import/ImportMetadata.js`.
3. If a GLB/glTF has `library = 1` in glTF node `extras`, the loader registers
   each direct child of the marked object that contains geometry as a separate
   Asset Panel entry and returns without adding anything to the scene. If
   library splitting fails, the same file falls back to normal GLB import.
4. Normal scene imports call `splitMultiMaterialMeshesInContainer()` before
   shader registration. If the GLB scene graph contains meshless transform
   nodes with geometry descendants (Blender Collections exported with "Full
   Collection Hierarchy", manual Empty parents, or 3MF component assemblies),
   `ImportHierarchy` captures those nodes as Outliner groups before
   import-transform baking — **only nodes with two or more structural
   children** (logical objects, a multi-primitive mesh counting once, and/or
   surviving sub-groups; decided deepest-first). A single-child wrapper (the
   glTF node that merely holds one mesh, or a chain of empties around one
   assembly) collapses, so a scan is one Outliner row, not file → node → mesh
   (owner decision 2026-09-18; one row per object, hierarchy only where it
   was authored with several objects). Multi-primitive siblings are keyed on
   their authored ORIGIN node (`hierarchy.originNodeKey(mesh)`), never on the
   Outliner group, so same-named primitives of different nodes never merge.
   In the Outliner a file that yielded exactly one object renders as that
   object at top level with a file badge (provenance stays on the SceneObject
   for relink); files with several objects keep their collection row.
   **File-group rule (overhaul 3.1):** a file with MORE THAN ONE logical
   object (material parts — MultiMaterial split siblings sharing a
   `sourceGroupId`, or glTF `_primitive<N>` siblings of one node — count as
   ONE object) arrives as a single user group (`origin: 'user'`) named after
   the file without extension, uniquified among groups AND objects
   (`kit`, `kit.001`). Authored sub-assemblies stay nested inside it. Its
   origin is the bottom-centre of the content (same rule as group creation),
   applied after the import bake (`hierarchy.attachFileGroup`), so nothing
   moves in world space. A one-object file gets no wrapper. The new group
   (or the single object) becomes the selection. Re-instantiating an asset
   follows the same rule.
   The bake folds loader/unit/reflection transforms
   into mesh vertices, then keeps only the promoted group nodes as clean
   identity `TransformNode` parents and reparents baked meshes under them, so
   the runtime hierarchy is editable instead of state-only.
   Blender modeler/export rule:
   `export_hierarchy_full_collections=True`,
   `export_hierarchy_flatten_objs=False`, and `export_extras=True` when custom
   properties such as `ratio` or `library = 1` are needed.
5. `ShaderLibrary.registerFromContainer()` creates or merges shader entries.
   **Resin-grey for shaderless geometry — ONE material, never overrides imports:**
   - SINGLE SOURCE = `scene.defaultMaterial`, greyed once in `SceneManager.init`
     (albedo **0.4** + a SUBTLE satin sheen — small specular 0.10 / specularPower
     48 — so it reads like cured resin, not flat matte or glossy plastic; lighter
     greys wash to near-white under the bright studio + ACES). Tune it THERE and
     both cases below follow — unity.
   - Shaderless FACES (submesh slots with no material) render with it
     automatically (Babylon's render-time fallback).
   - Shaderless OBJECTS (STL / missing — no material at all) are ASSIGNED that
     SAME instance by `_applyResinDefault()` (runs AFTER `addAllToScene` so
     geometry is bound; guard `!mesh.geometry`) — so the mesh has a concrete,
     selectable, exportable material that IS `scene.defaultMaterial`.
   - Imported materials are NEVER touched, white or not (no recolour branch).
     Browser smoke imports a real ASCII STL and asserts its material IS
     `scene.defaultMaterial` at 0.5. (Earlier bugs: a `getTotalVertices()` guard
     returned 0 on container meshes pre-`addAllToScene` → STL skipped; and the
     old 0.72 washed white — both fixed.)
6. `AssetLoader` adds the container to the scene, bakes source unit and
   authored ratio into scene scale, persists an `AssetEntry`, creates a
   display-only `CollectionEntry`, and registers each geometry mesh as a
   `SceneObject`. Split siblings remain in state, but only the lead sibling is
   rendered as the user-facing object; internal siblings are selected,
   transformed, hidden/locked, duplicated/deleted, grouped, validated, and
   exported through the lead.
7. `assets/AssetThumbnail` generates an idle thumbnail and
   `assets/AssetRegistration.queueValidation` queues non-blocking validation.

Edit path:
1. Pointer/keyboard input goes through `InputManager` or delegated UI handlers.
2. Reversible changes instantiate a `HistoryManager` command and call
   `push(command)`.
3. Commands update JSON state with `setState(..., { silent: true })` when they
   also mutate Babylon objects, then call `markDirty()` once.
4. Commands dispatch typed events so UI and scene modules refresh themselves.

Save/load path:
1. `PersistenceManager.save/saveAs` serialises JSON state, dehydrates Babylon
   transforms, embeds asset bytes when available, writes `.mixo`, records a
   recent-project entry, and clears autosave.
2. `PersistenceManager.open/openRecent/recoverAutosave` clears history and
   live resources, restores state first, restores shaders, resolves each asset
   by the five-tier priority table in §11, binds meshes back to saved ids, then
   restores groups, camera, overlays, selection, linked-shader index, and dirty
   state.

Export path:
1. `PrintPanel` exposes explicit OBJ / 3MF / STL export buttons and invokes
   `PrintManager.exportOBJ/exportSTL/exportThreeMF` from the clicked button.
2. `PrintPipeline._runExport` collects printable meshes, awaits CSG2 init,
   builds one `ExportContext` per target ratio (referenceRatio, targetRatio,
   pivot, factors, projectName, all frozen), clones meshes with unique
   geometry, runs ordered prep steps on clones, validates the prepared clones,
   dispatches to the format serializer (ObjWriter / ThreeMFWriter / inline STL),
   packages, and downloads.
3. Export never mutates live scene meshes. Format buttons choose the requested
   file type; printer profile selection is a build-area/reference setting.

#### Typed Contract Modules (type-only — NO runtime twins)

The runtime is JavaScript; a small set of TYPE-ONLY TypeScript files lock
schemas at compile time. The earlier runtime-mirror files (`ScaleMath.ts`,
`printers/PrinterProfiles.ts`, `export/ExportPlanner.ts`) were deleted
2026-06-11 (arch review A7) — a manual "keep the twin in sync" rule is a
drift liability, and the headless tests already pin the runtime behaviour.

- `src/core/scale/ScaleTypes.ts` — SourceUnit / AuthoredScale / SceneScale /
  PrintScale shapes. Runtime math lives in `ScaleMath.js`.
- (Printer profile typedef lives as a JSDoc `@typedef` in
  `src/core/print/PrinterProfiles.js`; `PrinterProfile.ts`, `ImportPipeline.ts`
  and `ExportPipeline.ts` were deleted in overhaul task 1.1.)

These files contain types and `import type` only — never executable mirrors
of runtime functions.

### 0.4 Babylon-First Rule
Before writing custom logic, check if Babylon provides it. **Required uses:**

| Need | Use this |
|---|---|
| OBJ + MTL export | `print/ObjWriter.encodeOBJ` (own writer through `PrintSpace` + per-printer axis, task 1.7). `BABYLON.OBJExport` RETIRED 2026-10-14: it could not take the per-printer Y-up/Z-up choice and wrote `usemtl undefined` for id-less materials; Y-up output proven identical to it (`tests/scan-probe.mjs --writers`) |
| STL export | `print/StlWriter.js` (own little-endian binary writer through `PrintSpace`). `BABYLON.STLExport` REJECTED 2026-09-17: it applies its own Y/Z swap (a mirror) and the call shipped `isLittleEndian=false` — slicers read a garbage triangle count |
| Selection outline | custom mask-RTT silhouette (`scene/SelectionOutline.js`) — HighlightLayer REJECTED: its stencil leaks onto PBR faces reporting any alpha mode (§7) |
| Asset thumbnails | `BABYLON.Tools.CreateScreenshotUsingRenderTarget(engine, camera, size, cb)` |
| World axes overlay | `new BABYLON.AxesViewer(scene, size)` |
| Grid overlay | `BABYLON.GridMaterial` on a ground plane |
| Gizmos | `BABYLON.GizmoManager` |
| Pointer input | `scene.onPointerObservable` |
| Keyboard input | `scene.onKeyboardObservable` |
| Batch loading | `BABYLON.AssetsManager` with `ContainerAssetTask` |
| Asset caching | `BABYLON.AssetContainer` |
| Ray casting (pointer → 3D) | `scene.createPickingRay()` / `scene.pick()` |
| Bounding box | `mesh.getBoundingInfo()` |
| Camera | `BABYLON.ArcRotateCamera` (perspective + ortho) |

If you find yourself writing > 30 lines of geometry / scene management code, stop and search the Babylon docs for an equivalent.

### 0.5 Module Size Targets (soft limits — split if exceeded)
Revised 2026-06-11 after the L29 split pass; budgets below are HONEST — they
match what the specced responsibilities actually cost.

| Module | Target LOC |
|---|---|
| `events.js` | < 80 |
| `StateManager.js` | < 200 |
| `HistoryManager.js` | < 200 (stack machinery + façade only; commands live in `core/commands/`) |
| each `core/commands/*.js` | < 500 (parent/group transform commands live in `ParentCommands.js`) |
| `InputManager.js` | < 750 (incl. modal G/R/S; extract `input/ModalTransform.js` if it grows) |
| `SceneManager.js` | < 450 (engine/lighting/overlays orchestrator; camera, pivot, outline, bed/grid all split into `core/scene/`) |
| each `core/scene/*.js` | < 250 (`CameraRig.js` < 550 — creation + custom nav + presets + framing + follow + optics + pose save/restore are one cohesive rig) |
| `AssetLoader.js` | < 150 (thin façade + release/remove/reset lifecycle — import/restore/minting all in `core/assets/`) |
| each `core/assets/*.js` | < 400 (AssetImport ≈ 380 — both live-import paths + library-GLB registration) |
| `ImportNormalizer.js` | < 150 |
| `ShaderLibrary.js` | < 1100 (registry + merge + UV clones + type rebuild; split candidate if it grows) |
| `MeshValidator.js` | < 550 (topology worker plumbing + group-union + result cache; pure topology lives in `workers/MeshValidate.worker.js`, repair orchestration in `core/repair/`) |
| each `core/repair/*.js` | < 400 (MeshRepair ≈ 385 — engine load + output validation + UV-preserving write-back; RepairSession ≈ 290; Weld ≈ 110; Diagnose ≈ 50) |
| `PersistenceManager.js` | < 200 (thin façade + file-handle lifecycle — serialise/resolve/load/autosave/dirty all in `core/persist/`) |
| each `core/persist/*.js` | < 400 (ProjectLoader ≈ 380 — the whole load pipeline is one cohesive sequence) |
| `PrintManager.js` | < 80 (thin façade only — orchestrator/serializers/ctx all in `core/print/`) |
| each `core/print/*.js` | < 600 (measured 2026-09-18: PrintPipeline ≈ 555 — orchestration + repair/CSG/weld prep helpers + 3MF dispatch; ThreeMFWriter ≈ 465; ExportContext ≈ 315; PrintCost ≈ 285; ObjWriter ≈ 210. Split the next writer out of PrintPipeline if it grows again) |
| each `src/ui/print/*.js` | < 300 (CostBlock ≈ 230 — Export-tab cost block render + wiring + live preview) |
| `RenderOutput.js` | < 80 (thin façade only — capture/sweep/preview/recorder in `core/render/`) |
| each `core/render/*.js` | < 300 (FrameCapture ≈ 230 — both engines' PNG paths + offline frame renderer) |
| `ThreeMFLoader.js` | < 300 (3MF import = inverse of 3MF export) |
| Each `src/ui/*.js` | < 900 (PropertiesPanel/ShaderPanel are section stacks; split per-section when a panel exceeds this) |
| each `src/ui/lib/*.js` | < 100 (shared wiring helpers only — no panel-init/locale framework) |
| `AppShell.js` | < 300 (shell controls + resize/collapse wiring) |
| `src/app/main.ts` | < 220 (bootstrap + dependency wiring only) |

If a file grows past 1.5× target, split by responsibility. Smaller files → faster AI review.

### 0.6 Code Style
- ES modules. Named exports preferred.
- Functions over classes, except for Commands and shaders.
- JSDoc only on public API functions (anything other modules import).
- No `// TODO` left in committed code.
- No console.log in committed code (`console.error` for actual errors only).
- Constants at top of file, UPPER_SNAKE_CASE.
- Async functions wrapped in `safeAsync` (see §13.1) when invoked from UI.

---

## PART 1 — UI DESIGN TOKENS

**File: `src/styles/tokens.css`**

Single theme. Pro-tool aesthetic. No theme switcher in v1.

**Washi pass (2026-06-14):** the original Blender-style dark theme was retuned
to a warm off-white "washi paper" palette. Surfaces are a 5-step cream ladder
(`--bg-0..4`), text is "sumi" warm-black, the primary accent is a quiet stone
brown (`--accent: #3e2c1e`) paired with a bengara red-orange "active" cue
(`--active: #a23a2a`) because brown-on-washi is too low-contrast for
selection state on its own. A vibrant accent (`--accent-vibrant: #e4c094`) is
reserved for high-energy moments (selection silhouette, charts) where the
stone brown reads too quiet. Borders use kasumi cloud tones, control fields
sit slightly inset against the panel.

**Blender-inspired pass (2026-06-12, pre-washi):** introduced the fixed-
assignment elevation ladder, inset-pill control language, right-aligned
property labels, sentence-case section headers, and segmented-control tab
strips. The component-level overrides live in `src/styles/blender.css`,
loaded LAST in index.html; the tokens below are the current (washi) values.

```css
:root {
  /* Washi surfaces — warm off-white paper, slight cream undertone. The
     5-step ramp keeps the same fixed-assignment elevation roles as the
     original dark theme so components reading --bg-0..4 stay correct. */
  --bg-0: #efe7d8;          /* viewport / app background */
  --bg-1: #f3ecdf;          /* top-level panel surface (Outliner, Properties, Shader, Asset, Print) */
  --bg-2: #f7f1e5;          /* section surface inside a panel (.pp-section, .sp-section, .ap-card) */
  --bg-3: #fbf6ec;          /* control surface — inputs, default buttons, selected rows */
  --bg-4: #fffaf0;          /* hover / pressed elevation on top of --bg-3 */

  /* Sumi text — never pure black, slightly warm. */
  --text-0: #1a1612;        /* primary */
  --text-1: #4a3f33;        /* secondary */
  --text-2: #7a6a58;        /* tertiary, hints */
  --text-disabled: #a99e8c;

  /* Dark stone accent — quiet wabi-sabi brown. Paired with --accent-vibrant
     for high-energy moments (selection silhouette, charts) where stone is
     too quiet against washi. */
  --accent:          #3e2c1e;
  --accent-hi:       #5c4633;
  --accent-fg:       #fbf6ec;
  --accent-vibrant:  #e4c094;

  /* Secondary "active" cue — bengara red-orange. Required because brown-on-
     washi is low-contrast for selection state; pairing the stone border with
     a bengara left-edge + faint bg tint restores the readable affordance. */
  --active:    #a23a2a;
  --active-bg: rgba(162, 58, 42, 0.10);

  /* Hairlines — kasumi cloud tones, softer than 1px solid. */
  --border:         #d4c9b3;
  --border-strong:  #b8a98c;
  --border-section: #c9bda2;
  --border-focus:   var(--active);
  --ring-focus:     rgba(162, 58, 42, 0.28);  /* 2px box-shadow ring on input :focus — keyboard a11y */

  /* Control language — fields sit slightly inset against the panel. */
  --ctl-bg:        #fbf6ec;
  --ctl-bg-hover:  #fffaf0;
  --ctl-bg-active: #e9dfc8;
  --ctl-border:    #c9bda2;
  --ctl-h: 22px;

  /* Status — retuned for light bg readability. */
  --danger:  #c0392b;
  --warning: #b8860b;
  --success: #2e7d32;
  --info:    #1e3a5f;

  /* Viewport HUD overlays — fake-glass recipe. backdrop-filter does NOT
     paint over the WebGL canvas in Chromium for this scene, so real blur
     is unavailable. The look is rebuilt with a multi-stop sheen + soft
     tint + bright top highlight; --hud-blur stays as a token set to `none`
     so HUD rules can keep referencing it without removal. SVG fractalNoise
     grain (macOS Vibrancy trick) adds a frosted micro-texture so the panel
     reads as glass even when nothing is behind it to blur. */
  --hud-tint:        rgba(245, 247, 252, 0.38);
  --hud-tint-strong: rgba(245, 247, 252, 0.55);
  --hud-sheen:       linear-gradient(180deg,
                       rgba(255, 255, 255, 0.55) 0%,
                       rgba(255, 255, 255, 0.18) 45%,
                       rgba(255, 255, 255, 0.06) 100%);
  --hud-noise:       url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='180' height='180'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 0.05 0'/></filter><rect width='100%25' height='100%25' filter='url(%23n)'/></svg>");
  --hud-bg:          var(--hud-sheen), var(--hud-noise), var(--hud-tint);
  --hud-bg-strong:   var(--hud-sheen), var(--hud-noise), var(--hud-tint-strong);
  --hud-text:        #1a1d24;
  --hud-text-hi:     #0a0c12;
  --hud-text-dim:    rgba(26, 29, 36, 0.72);
  --hud-text-shadow: 0 1px 1px rgba(255, 255, 255, 0.55),
                     0 0 2px rgba(255, 255, 255, 0.35);
  --hud-border:      rgba(255, 255, 255, 0.45);
  --hud-highlight:   inset 0 1px 0 rgba(255, 255, 255, 0.55),
                     inset 0 -1px 0 rgba(255, 255, 255, 0.12);
  --hud-shadow:      0 8px 24px rgba(0, 0, 0, 0.24),
                     0 1px 2px  rgba(0, 0, 0, 0.16);
  --hud-blur:        none;        /* backdrop-filter unsupported over WebGL canvas */
  --hud-hover-bg:    rgba(255, 255, 255, 0.14);

  /* X/Y/Z axis colours — standard CAD/Blender convention. Paired by hand
     with the Babylon-side gizmo hexes in src/core/scene/SceneConstants.js. */
  --axis-x: #e0584f;
  --axis-y: #6fb04a;
  --axis-z: #4a86d6;

  /* Typography */
  --font-display: "Yuji Syuku", "Shippori Mincho", serif;
  --font-sans:    system-ui, -apple-system, "Segoe UI", "Hiragino Sans",
                  "Yu Gothic UI", "Noto Sans CJK TC", sans-serif;
  --font-mono:    ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  --fs-xs: 11px;
  --fs-sm: 12px;
  --fs-md: 13px;            /* default UI size */
  --fs-lg: 15px;
  --fs-xl: 18px;

  /* Spacing — compact pro-tool scale (unchanged from Blender baseline). */
  --sp-1: 2px;
  --sp-2: 4px;
  --sp-3: 6px;
  --sp-4: 8px;
  --sp-5: 12px;
  --sp-6: 16px;
  --sp-7: 24px;

  /* Radii (unchanged). */
  --r-sm: 4px;
  --r-md: 6px;
  --r-lg: 8px;

  /* Motion (unchanged). */
  --ease: cubic-bezier(0.4, 0, 0.2, 1);
  --dur-fast: 120ms;
  --dur-med:  200ms;

  /* Shadows — lifted off light bg, warmer brown tone, less heavy than dark theme. */
  --shadow-md: 0 4px 12px rgba(62, 44, 30, 0.18);
  --shadow-lg: 0 12px 32px rgba(62, 44, 30, 0.28);
}

html, body {
  background: var(--bg-0);
  color: var(--text-0);
  font: var(--fs-md)/1.5 var(--font-sans);
  margin: 0;
  height: 100vh;
  overflow: hidden;
  -webkit-font-smoothing: antialiased;
}
```

**Layout (`src/styles/layout.css`):**
```
┌────────────────────────────────────────────────┐
│  Header (40px) — project name, save indicator  │
├──────────┬──────────────────────┬──────────────┤
│ Outliner │                      │  Properties  │
│  (260)   │      Viewport        │    Shader    │
│          │                      │     Print    │
│          │                      │   (300px)    │
├──────────┴──────────────────────┴──────────────┤
│  Asset Panel (220px, resizable up to 50% vp)   │
├────────────────────────────────────────────────┤
│  Status Bar (28px)                             │
└────────────────────────────────────────────────┘
```
Use CSS Grid for the outer layout. Resizable splitters between Outliner / Viewport / right panel column, and on top edge of Asset Panel.

---

## PART 2 — ICONS

**File: `src/core/Icons.js`**

Inline SVG registry. Returns SVG strings; no DOM dependencies, no CDN dependency.

The original blueprint intended to import the `lucide` npm package, but
that package was abandoned at v1.14.0 with an incompatible data format —
the modern Lucide is published under framework-specific names (`lucide-react`,
`lucide-vue-next`, etc.) which don't suit a no-build vanilla JS project.
Inline paths are simpler, version-stable, and tiny.

```js
const DEFAULT_ATTRS = { width: 16, height: 16, 'stroke-width': 1.75 };

const ICON_PATHS = {
  // Phase 1 — status bar + toast
  Circle:        '<circle cx="12" cy="12" r="10"/>',
  Check:         '<path d="M20 6 9 17l-5-5"/>',
  Info:          '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>',
  CheckCircle:   '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><path d="m9 11 3 3L22 4"/>',
  AlertTriangle: '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
  XCircle:       '<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6M9 9l6 6"/>',
  Loader2:       '<path d="M21 12a9 9 0 1 1-6.219-8.56"/>',
  // Add new icons as later phases need them. Copy paths from lucide.dev/icons.
};

/**
 * @param {string} name  PascalCase icon name (must exist in ICON_PATHS)
 * @param {object} [attrs]  Optional SVG attribute overrides
 * @returns {string} SVG markup, or '' if unknown
 */
export function icon(name, attrs = {}) {
  const body = ICON_PATHS[name];
  if (!body) return '';
  const finalAttrs = { ...DEFAULT_ATTRS, ...attrs };
  const attrStr = Object.entries(finalAttrs).map(([k, v]) => `${k}="${v}"`).join(' ');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" ${attrStr}>${body}</svg>`;
}
```

When a later phase needs a new icon, grab its `d` / child markup from
[lucide.dev/icons](https://lucide.dev/icons) (view source on the icon's
SVG) and add an entry to `ICON_PATHS`.

### `sectionIcon(name)` — header glyph chip (2026-06-13 icon pass)

Every panel header (top-level panels, sub-section headers, Scene sub-group
labels, Print tabs) carries a leading 13 px glyph via:

```js
export function sectionIcon(name) {
  return `<span class="sec-icon" aria-hidden="true">${icon(name, { width: 13, height: 13 })}</span>`;
}
```

`.sec-icon` styling is in `blender.css` §8b (inline-flex, slots after the
collapse chevron, brightens with the header on hover). The four top-level
right-panel headers are static in `index.html`, so their glyphs are inlined
SVG (same paths) rather than a `sectionIcon` call.

**Icon-uniqueness contract (2026-06-13): no two *identity* glyphs repeat.**
Every panel / section / sub-group / Print tab / viewport toggle uses a
DISTINCT symbol so the chrome is scannable. *Functional* glyphs that should
stay consistent are exempt and intentionally repeat: copy buttons (`Copy`),
the export action buttons (`Download`), warning badges (`AlertTriangle`),
accordion chevrons, texture-slot thumbnails (`Image`), visibility (`Eye`).
When adding a header/tab/toggle glyph, pick one not already in the identity
map below.

Identity map (each unique):
- **Right-panel top-level** (index.html inline): Properties=`SlidersHorizontal`, Shader Library=`Palette`, Scene=`Boxes`, Print=`Printer`
- **Properties sections**: Object=`Shapes`, Transform=`Move`, Imported scale=`Ruler`, Shader=`Brush`, UV Override=`Map`, Print=`Tag`
- **Shader sections**: Scene Shaders=`Layers`, Editor=`Edit3`, Swatches=`Swatches`
- **Scene sections**: Grid=`Grid3x3`, Environment=`Sun`, Camera=`Camera`, Cross Section=`Scissors`, Rendering=`Clapperboard`
- **Scene sub-groups**: HDRI=`Globe`, Grade=`Wand2`, Floor=`FloorPlane`, Lights=`Lightbulb`, Ambient occlusion=`Aperture`, Performance=`Gauge`, Still=`ImageDown`, Turntable=`Disc3`
- **Print tabs**: Scale=`Percent`, Validation=`CheckCircle`, Bed=`Maximize`, Export=`FileDown`
- **Viewport toggles**: wireframe edges=`MeshTriangle` (irregular scalene triangle + one internal edge — a wireframe facet), matte/flat=`Contrast` (half-filled disc)
- **Viewport toolbar** (own cluster): `Move3D`/`RotateCcw`/`Scale3D` gizmo modes, `CircleDot`/`Box`/`Crosshair`/`Circle` pivots, `Orbit`/`Eye`/`LocateFixed` camera modes, `RotateCw` gizmo-space toggle
- Other functional: Outliner `Eye`/`EyeOff`/`Lock`/`Unlock`/`Printer`/`Folder`(Open)/`Box`; Header `Save`/`FolderOpen`/`FilePlus`/`FilePenLine`/`Clock`; Status bar `Circle`/`Check`; Asset panel `Upload`/`Image`/`RefreshCw`/`ChevronDown`; Toast `Info`/`CheckCircle`/`AlertTriangle`/`XCircle`/`Loader2`; Shader `Plus`/`Copy`/`Image`/`AlertTriangle`; Context menu `Focus`/`Pipette`/`Copy`/`FilePenLine`

**Toggle buttons vs checkboxes (checkbox→toggle audit 2026-06-13).** Boolean
**feature / mode / visibility** switches are pressable toggle buttons (`.pp-toggle`
+ status dot, `aria-pressed`; blender.css §8c) — they read state at a glance and
match the viewport `.vt-btn` language. Native checkboxes are kept only for
**sub-options nested under an already-enabled feature** (a checked option among
inputs, not a live switch). Current split:
- **Toggle buttons** — Scene: HDRI, Vignette, Floor, Shadows, SSAO, Grid, Axes,
  Cut view (Cross Section), Render view. Properties: Visible (`Eye`/`EyeOff`),
  Locked (`Lock`/`Unlock`), Export as print part. Print: Show bed volume.
- **Stay checkboxes** — Scene: Transparent background (PNG), Ease in/out, Flip
  side. Print export tab: Selected only, Each individually, Bake solid colors.
- **Wiring contract:** `data-*` hooks are unchanged; only the event differs
  (button = `click`, checkbox = `change`). ScenePanel's `_evt`/`_nextVal`/
  `_reflectToggle` helpers branch on `el.tagName`. A toggle that gates dependent
  rows triggers a panel `_render()` (which re-paints the pressed state); a toggle
  that doesn't reflects its pressed state in place.

Render in DOM:
```js
element.innerHTML = icon('Eye', { class: 'icon-sm' });   // raw glyph
header.innerHTML  = sectionIcon('Box') + 'Object';        // header chip + label
```

---

## PART 3 — EVENTS

**File: `src/core/events.js`** (write first)

```js
export const EVENTS = {
  // Asset lifecycle
  ASSET_REGISTERED:        'asset:registered',
  ASSET_REMOVED:           'asset:removed',
  ASSET_INSTANTIATED:      'asset:instantiated',
  ASSET_MISSING:           'asset:missing',
  ASSET_RELINKED:          'asset:relinked',

  // Scene object lifecycle
  OBJECT_REMOVED:          'object:removed',
  OBJECT_RESTORED:         'object:restored',
  OBJECT_UPDATED:          'object:updated',

  // Validation
  VALIDATION_STARTED:      'validation:started',
  VALIDATION_COMPLETE:     'validation:complete',

  // Selection
  SELECTION_CHANGED:       'selection:changed',
  SCOPE_CHANGED:           'selection:scopeChanged',   // { scopeId } click-depth scope (task 3.2); null = root
  ACTIVE_OBJECT_CHANGED:   'selection:activeChanged',

  // Transform
  TRANSFORM_COMMITTED:     'transform:committed',

  // Shaders
  SHADER_CREATED:          'shader:created',
  SHADER_UPDATED:          'shader:updated',
  SHADER_DUPLICATED:       'shader:duplicated',
  SHADER_ASSIGNED:         'shader:assigned',
  UV_OVERRIDE_CHANGED:     'shader:uvOverrideChanged',
  COLOR_APPLIED:           'shader:colorApplied',

  // Hierarchy
  GROUP_CREATED:           'hierarchy:groupCreated',
  GROUP_DISSOLVED:         'hierarchy:groupDissolved',
  PARENT_CHANGED:          'hierarchy:parentChanged',
  OBJECT_RENAMED:          'hierarchy:renamed',
  VISIBILITY_CHANGED:      'hierarchy:visibilityChanged',
  LOCK_CHANGED:            'hierarchy:lockChanged',

  // Collections (file-import display buckets in the outliner; see §13 Outliner)
  COLLECTION_CREATED:      'collection:created',
  COLLECTION_REMOVED:      'collection:removed',
  COLLECTION_RENAMED:      'collection:renamed',
  COLLECTION_MEMBERSHIP:   'collection:membership',

  // History
  HISTORY_PUSHED:          'history:pushed',
  HISTORY_UNDONE:          'history:undone',
  HISTORY_REDONE:          'history:redone',

  // Print
  EXPORT_STARTED:          'print:exportStarted',
  EXPORT_COMPLETE:         'print:exportComplete',

  // Project
  PROJECT_NEW:             'project:new',
  PROJECT_LOADED:          'project:loaded',
  PROJECT_SAVED:           'project:saved',
  PROJECT_DIRTY:           'project:dirty',
  PROJECT_RENAMED:         'project:renamed',
  AUTOSAVE_WRITTEN:        'project:autosaved',

  // Camera
  CAMERA_PRESET_CHANGED:   'camera:presetChanged',

  // Environment
  HDRI_STATUS:             'env:hdriStatus',   // { status: 'loaded'|'error', preset } — ScenePanel toasts user-initiated changes

  // UI
  TOAST:                   'ui:toast',
  MODAL_OPEN:              'ui:modalOpen',
  MODAL_CLOSE:             'ui:modalClose',
  UI_PANEL_CHANGED:        'ui:panelChanged',
  UI_CONTEXT_MENU:         'ui:contextMenu',
};
```

---

## PART 4 — STATE MANAGER

**File: `src/core/StateManager.js`**

### Public API
```js
StateManager.subscribe(eventName, fn)             → unsubscribeFn
StateManager.dispatch(eventName, payload)         → void
StateManager.getState()                           → ReadonlyState (deep-frozen in DEV)
StateManager.setState(updaterFn, {silent}?)       → void  // silent:true suppresses PROJECT_DIRTY
StateManager.withoutDirty(fn)                     → void  // block-scope silent for direct-Babylon ops
StateManager.markDirty()                          → void  // dispatch PROJECT_DIRTY without state mutation
StateManager.replaceState(next)                   → void  // atomic swap (project load / undo); used verbatim, not cloned
StateManager.freshState()                         → State // deep clone of INITIAL_STATE (New Project)
```
Module-local `_suppressDirty` flag drives `withoutDirty` and gates both `setState({silent})` and `markDirty()`. Persistence load wraps its restore phase in `withoutDirty` so dispatching individual restores doesn't repeatedly flag the project dirty.

### State Shape (full schema — see Part 10 for persisted form)
```js
const initialState = {
  project: { name: 'Untitled', isDirty: false, lastSavedAt: null, version: '3.1' },
  scene: {
    objects: {},        // Record<meshId, SceneObject> — each has collectionId tag
    groups: {},         // Record<groupId, GroupNode>
    collections: {},    // Record<collectionId, CollectionEntry> — outliner-only buckets
    assetLibrary: {},   // Record<assetId, AssetEntry>
    shaders: {},        // Record<shaderId, ShaderEntry>
    uvOverrides: {},    // Record<meshId, UVOverride>
    userSwatches: [],
    // Default pose: 30 cm above origin, 45° downward, front-right-3/4. Babylon
    // ArcRotateCamera positions camera at target + R·(sinβ cosα, cosβ, sinβ sinα).
    // β = π/4 (45° elevation), α = π/3 (front-right quadrant), R = 0.3 / cos(π/4).
    camera: { preset: 'perspective', alpha: Math.PI/3, beta: Math.PI/4, radius: 0.4243, target: {x:0,y:0,z:0}, isOrthographic: false, followMode: 'free' /* 'free'|'followActive'|'worldOrigin' */ },
    overlays: { grid: true, axes: true, wireframe: false, printPreview: true, baseColorView: false, uvCheckerView: false, invertedFaces: false, bedPreview: false },
    // wireframeEdges + wireframeEdgeColor are written on first viewport-toggle
    // use (not in INITIAL_STATE); persistence restores them when present.
    // Viewport render look (Scene panel) — defaults mirror SceneConstants;
    // applied via SceneManager.applyRenderSettings on boot/load/new.
    // fovDeg 45.8 = Babylon's 0.8 rad default; clipNearMM 1 = 1 mm near plane.
    render: { exposure: 1.05, contrast: 1.10, shadowsEnabled: true, shadowDarkness: 0.62,
              background: 'light' /* |'dark' */,
              keyIntensity: 0.70, fillIntensity: 0.25, hemiIntensity: 0.85,
              fovDeg: 45.8, clipNearMM: 1,
              // Grade — tone-map curve + colour (Babylon imageProcessing).
              toneMapping: 'aces' /* |'standard'|'neutral'|'off' */,
              saturation: 0 /* colorCurves.globalSaturation, -100..100 */,
              vignette: false, vignetteWeight: 1.5,
              // Environment floor — round shadow-catcher DISC (Z in print-space
              // mm). floorDiameterMM: 0 = auto (4× largest bed dim).
              floorEnabled: false, floorColor: '#9a9a9a', floorZMM: 0, floorDiameterMM: 0,
              // HDRI IBL — prefiltered .env presets in public/env/ (lighting
              // only, gradient backdrop stays; PBR materials).
              hdriEnabled: true, hdriPreset: 'studio' /* |'neutral'|'outdoor' */,
              hdriIntensity: 0.6,
              // SSAO contact darkening (scene/ViewEffects.js) — VIEWPORT-ONLY
              // post effect: RTT export paths skip the camera post chain by
              // design (same rule that keeps the silhouette out of renders).
              ssaoEnabled: false, ssaoStrength: 1 /* 0..2 — default OFF, heavy prePass */ },
    // Cross Section inspection plane (scene/ViewEffects.js; UI label "Cross
    // Section", internal key stays `section`). SESSION-ONLY — deliberately NOT
    // persisted. axis/offset are print-space (Z = up, mm); flip keeps the other
    // side. Cuts CONTENT meshes only (per-mesh scene.clipPlane set/cleared in
    // render observables) — grid/floor/axes/backdrop never sliced. Two
    // Two VIEWPORT inspection aids accompany the cut (NO real geometry — that
    // would be CSG2, the export path; these are preview-only and reliable on
    // every GPU). A stencil cap was tried and REJECTED: its even-odd parity is
    // depth-gated and GPU-dependent → showed the hollow back-face shell on some
    // drivers. Instead:
    //  (a) FILL — per clipped solid, a shared-geometry CLONE (parent=null with
    //      the source world matrix baked, no metadata.meshId) renders the
    //      source's BACK faces with a `CustomMaterial` (StandardMaterial
    //      subclass → clip-plane + alpha handled for free). Amber EMISSIVE
    //      (#f59e0b, exact); diagonal stripes are computed PER-FRAGMENT from
    //      WORLD position in `Fragment_Before_FragColor` (~4 mm period; body
    //      α0.32, stripe α0.92) — NOT a texture: UVs / coordinatesMode never
    //      drove the stripe alpha on textured/UV-less meshes, so it was moved to
    //      a fragment computation. Clone shares geometry (no RAM dup), gets its
    //      own clip observers so its front half is cut to match, idempotent per
    //      mesh. (CustomMaterial emits GLSL → the stripe injection needs
    //      transpilation on the opt-in WebGPU backend; acceptable.)
    //  (b) BORDER — a thin accent rectangle OUTLINE (LinesMesh) at the plane
    //      extent so the plane is visible even where the cut misses the solid.
    // Both carry no metadata.meshId (auto-excluded from clip/shadow/mask). The
    // geometric cut DOES appear in PNG/video exports; the fill + border are
    // viewport furniture — render/FrameCapture.hideFurniture hides them during capture.
    // The shadow-map pass renders depth directly, so shadows stay uncut (limit).
    // NOTE for a color-print tool: a REAL cut face for export/print is geometry,
    // not visual — that is the CSG2 path (PrintPipeline._csgRebake already uses
    // CSG2); a future "apply cut" would intersect the solid with the half-space.
    section: { enabled: false, axis: 'z' /* |'x'|'y' */, offsetMM: 0, flip: false },
    // Render output (Scene ▸ Rendering — core/RenderOutput.js): PNG stills +
    // turntable video. pose = stored render-camera composition (null until
    // first Render-view use; auto-updated while the mode is on). When a pose
    // exists, Export PNG / Export video SHOOT FROM IT — the saved composition
    // is the source of truth, not wherever free navigation happens to be;
    // free navigation is restored afterwards.
    renderOut: { width: 1920, height: 1080, transparent: false,
                 pose: null /* { alpha, beta, radius, target, isOrthographic } */,
                 turntable: { durationS: 8, fps: 30, direction: 'left' /* |'right' */, ease: true } },
    grid: { cellMM: 10, subdivisions: 10 },  // line styling only; floor footprint = print.bedDimensions XY
    cursor3d: { x: 0, y: 0, z: 0 },
  },
  selection: { selectedIds: [], activeId: null, pivotMode: 'active' /* world|median|active|individual|cursor */ },
  print: {
    workingRatio: 1,            // denominator of the scene display ratio (1 = 1:1)
    targetRatio:  1,            // denominator of the final print export ratio
    targetPrinterId: 'mimaki-3duj-553',
    bedDimensions: { x: 508, y: 508, z: 305 },
    objBakeSolidTextures: false,
    strictExport: false,        // watertight-repair-and-cost task 4 — §9 Pre-Export Gate
    repairOnImport: false,      // watertight-repair-and-cost task 5 — opt-in, §9 Watertight repair.
                                // PER-USER only (SettingsStore): excluded from the .mixo document
                                // AND from the load merge (2026-09-18, review I8)
  },
  cost: {                       // watertight-repair-and-cost task 6 — §12 Cost quote; own top-level
                                 // slot (not print.*) so its own settings-section reset is independent
    materialId: '', pricePerGram: 0, supportPricePerGram: 0, supportPercent: 0, currency: 'USD',
  },
  ui: {
    activePanel: 'properties', outlinerCollapsed: {}, assetPanelHeight: 220, scaleLocked: true,
    // Workspaces (PART 13b) — per-user (localStorage v2), NEVER in .mixo.
    workspace: 'layout',     // 'layout' | 'shade' | 'scene' | 'print'
    // TRI-STATE per side: true = force-hide, false = force-show, ABSENT =
    // defer to the workspace default. Must start EMPTY — a concrete false is
    // a force-show override that defeats every workspace preset.
    panelCollapsed: {},
  },
  // snap units (overhaul 5.6): translate = MILLIMETRES (default 1 mm), rotate = degrees,
  // scale = × step. Converted to BU only in src/core/SnapUnits.js.
  gizmo: { mode: 'translate', space: 'world', snap: { translate: 1, rotate: 15, scale: 0.1 } },
};
```

### Rules
- `setState(updaterFn)` — updater receives current state, returns new state (treat as immutable; don't mutate input).
- After every `setState`, automatically dispatch `EVENTS.PROJECT_DIRTY` (skip during load/undo).
- `getState()` returns the live state object; **freeze it only in dev mode**:
  ```js
  const DEV = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  if (DEV) return deepFreeze(state);
  return state;
  ```
- Never store Babylon objects in state. State is JSON-serializable.
- Subscribers are called synchronously in registration order. If a subscriber throws, log and continue.

---

## PART 4b — SELECTION

**File: `src/core/Selection.js`**

Owns `state.selection`. All selection writes are **silent against `PROJECT_DIRTY`** (clicking around must not mark the project dirty) but are still persisted in §11 schema.

**Selection entries are objects OR groups** (overhaul task 2.1, Decision 1). `selectedIds` / `activeId` may hold object ids (always the logical-object lead) and user-group ids (keys of `state.scene.groups`). A group is a first-class entry: it is **never expanded into its children at selection time**. Canonicalisation lives in `LogicalObjects.canonicalSelectableId(id, scene)` (object id → lead via `canonicalObjectId`; group id → itself; unknown / ghost → `null`; on an id collision the object wins) and `LogicalObjects.isGroupId(id, groups)`.

### Public API
```js
Selection.set(ids, activeId?)        → void   // replace; active defaults to last id (or null)
Selection.add(id)                    → void   // idempotent; added id becomes active
Selection.remove(id)                 → void
Selection.toggle(id)                 → void
Selection.setActive(id)              → void   // must already be in selectedIds
Selection.clear()                    → void
Selection.selectAll()                → void   // visible non-ghost; Blender-A toggle (all → clear)
Selection.setPivotMode(mode)         → void   // 'world'|'median'|'active'|'individual'|'cursor'
Selection.cyclePivotMode()           → void   // in the order above
Selection.refresh()                  → void   // re-sync visuals after scene gain/loss
Selection.getSelectedIds()           → string[]
Selection.getActiveId()              → string|null
Selection.contains(id)               → boolean
Selection.getSelectedResolved()      → { id, mesh }[]   // OBJECTS only, every material part; ghost/missing/groups dropped
Selection.getSelectedNodes()         → { id, node, kind: 'object'|'group' }[]  // every entry in selection order
Selection.getTransformTargets()      → { targets: { id, node, kind }[], activeNode, activeGeometry }  // gizmo / G-R-S targets (2.2)
Selection.getScope()                 → string|null      // click-depth scope group (null = root); stale group reads as root
Selection.setScope(groupId|null)     → void             // non-group id = no-op; emits SCOPE_CHANGED {scopeId} on change
Selection.targetAtScope(id)          → string|null      // pure depth mapping at the current scope (no side effects)
Selection.resolveClick(id)           → string|null      // viewport click: depth-map; outside scope → exit to root, then map
Selection.enterScope(groupId, pickedId?) → boolean      // double-click: scope = group, select the child containing pickedId
Selection.exitScope()                → boolean          // Esc: scope = parent of scope, selection = exited group; false at root
Selection.scopeToParentOf(id)        → void             // Outliner row click: scope = the row's parent group (root if none)
```

### Click-depth scope (overhaul task 3.2, plan §4.5 — Figma/Keynote)
- **Scope** = the group the user has entered (`null` = root). Session-only (Decision 12): a module variable in `Selection.js`, deliberately **not** in `state.selection` (which `ProjectSerializer` persists wholesale). A scope whose group no longer exists reads as root.
- **Depth mapping** = `LogicalObjects.selectableAtDepth(id, scene, scopeId)`: canonicalise (part → logical lead, group → itself, ghost/unknown → null), walk the lead's `parentId` chain through `scene.groups`; at root return the top-most ancestor (top-level group, or the bare object); inside a scope return the direct child of the scope on that chain; not inside the scope → `null`.
- **Click** (LMB, Shift-add, Ctrl-toggle, and the RMB context-menu pick) selects `resolveClick(meshId)`: the item at the current depth; a click on an item outside the scope exits to root first. **Empty click** (sub-3 px marquee, non-additive) clears the selection AND exits to root.
- **Double-click** = two LMB POINTERDOWNs < 350 ms and < 4 px apart whose depth target is the same (`InputManager._isDoubleClick`). On a group → `enterScope(group, meshId)` (no body drag); on an object it is a plain click. Detected on POINTERDOWN (not DOM `dblclick`) so it composes with body-drag and marquee.
- **Esc** priority: modal G/R/S cancel > body-drag cancel > marquee cancel > `exitScope()` (one level up, the exited group becomes the selection) > nothing (Esc never cleared the selection at root).
- **Marquee** (`BoxSelect.itemIdsInRect`): every pickable, enabled content mesh is mapped to its item at the current depth (outside scope → ignored); an item is hit when the centre of the COMBINED world AABB of its meshes projects inside the rect.
- **Outliner** plain row click (object or group) sets scope to that row's parent group (`scopeToParentOf`); modifier clicks leave the scope. The breadcrumb UI is task 3.3.

`set/add/toggle/remove/setActive` accept object ids and group ids. `getSelectedResolved()` keeps its historical mesh-only contract (callers that transform/validate/export meshes are unaffected by group entries). `getSelectedNodes()` resolves each entry once: an object to its lead Babylon mesh (no part expansion), a group to its runtime `TransformNode` (found by `metadata.groupId` in `scene.transformNodes`); entries without a live node are skipped but stay selected.

### Behaviour rules
- Resolution drops `obj.isGhost === true` and meshes `AssetLoader.getBabylonMesh` cannot find. Ghosts are *selectable in the outliner* but never receive gizmo / silhouette attention.
- Private `_resolve(id)` → `{ id, node, kind }` or `null` (ghost, unknown, no live node). Writes (`set/add/toggle/setActive`) drop ids that canonicalise to `null`; `setActive(unknown)` is a no-op (it does not clear the active id); `setActive(null)` clears it.
- The active id may be a group id. Event payloads are unchanged in shape (`SELECTION_CHANGED {selectedIds, activeId}`, `ACTIVE_OBJECT_CHANGED {activeId}`).
- **Transform targets (task 2.2).** `getTransformTargets()` lists, in selection order, every material-part mesh of each selected object (`id` = part meshId) and each selected group's `TransformNode` (`id` = groupId). It is NOT ancestor-filtered: the consumer (pivot / G-R-S modal) calls `PivotSession.topmostTransformTargets` once the pivot is detached and every node sits in its canonical parent, dropping any node that has a selected ancestor — so an object selected together with its group (or a subgroup with its parent group) is transformed exactly once, rigidly, by the topmost node. `activeNode` = the active group node or the active object's lead mesh; `activeGeometry` = the nodes whose geometry defines the `'active'` pivot (every part of the active object, or the active group node). Click-depth scope: see "Click-depth scope" below (task 3.2). **Lock enforcement (task 2.5):** lock = transform-lock and cascades DOWN (`Selection.isEffectivelyLocked(id)` = the item or any ancestor group has `locked`; groups carry `scene.groups[id].locked`). Locked items stay selectable and outlined, but `getTransformTargets()` omits them (`lockedSkipped` counts them; `{ includeLocked: true }` is for outlines only), so they never reach the pivot/gizmo or the G/R/S modal (toast `toast.lockedNoTransform` when nothing transformable remains). Properties transform fields (ratio, size, pos, rot, scale) are disabled with a tooltip via `isTransformReadOnly(ids)`; Delete of a selection containing locked items ASKS first (Decision 9; generic `confirmAction` modal in ProjectMenu — cancel keeps, confirm deletes); group `locked` persists in the `.mixo` groups array; Duplicate/Group/Ungroup stay allowed; `L` / `LockCommand` toggles objects and groups, undoably.
- `_applyVisuals` (private) hands `getTransformTargets()` to the pivot: `SceneManager.attachToSelection(targets.map(t => t.node), pivotMode, activeNode, activeGeometry)`. Outline: object parts are outlined directly; a selected group outlines its member meshes (`node.getChildMeshes(false)` with `metadata.meshId`); the active entry's meshes (all parts of the active object / all members of the active group) go to `SceneManager.setActive`, the rest to `SceneManager.setSelected`. A selected group therefore shows the gizmo and outline.
- Every selection-write call emits `EVENTS.SELECTION_CHANGED` (with `{selectedIds, activeId}`); an active-id change additionally emits `EVENTS.ACTIVE_OBJECT_CHANGED`.
- The gizmo's pivot follows `state.selection.pivotMode` (see §7 Gizmo for the per-mode pivot rule).
- `setPivotMode('cursor')` also flips `SceneManager.setCursorVisible(true)`; switching away hides it.

---

## PART 5 — HISTORY MANAGER

**File: `src/core/HistoryManager.js`**

### Command Interface
```js
{ label: string, execute(): void, undo(): void }
```

### Public API
```js
HistoryManager.push(command)        → void  // calls execute(), adds to stack, clears redo
HistoryManager.undo()               → void
HistoryManager.redo()               → void
HistoryManager.clear()              → void
HistoryManager.getUndoLabel()       → string|null
HistoryManager.getRedoLabel()       → string|null
HistoryManager.beginBatch(label)    → void  // start collecting into a BatchCommand
HistoryManager.endBatch()           → void  // finish and push the batch as one entry
```

### Standard Commands (in `src/core/commands/` — Transform / Hierarchy /
### Parent / Shader / Scale modules + shared `support.js`; HistoryManager re-exports all)
Implemented in Phase 3:
- `TransformCommand` — `{ prev, next, alreadyApplied? }` keyed by **node id**: an object meshId or a user groupId (overhaul 2.2; resolved by `support.findNodeForId`, mesh first). Sets absolute world transforms via a `setParent(null)` cycle so the world position survives the change; a group entry moves the group `TransformNode` rigidly and its children keep their local transforms, so undo/redo restore group nodes exactly. Snapshots never hold both a node and one of its descendants (the pivot / modal filter with `topmostTransformTargets`). Dispatches `TRANSFORM_COMMITTED { meshIds, nodeIds }` — `nodeIds` = the snapshot keys, `meshIds` = every object mesh whose world transform changed (group ids expanded to member meshes via `support.transformedMeshIds`), so validation/outliner staleness keeps its mesh-id contract. Used by gizmo drag-end, body drag, keyboard G/R/S and Properties Panel input commits.
- `VisibilityCommand`, `LockCommand`, `RenameCommand`
- `DeleteCommand` — soft-deletes (`setEnabled(false)` + remove from state) so
  undo restores instantly without re-instantiating from the asset container.
  The same command removes deleted ids from every `GroupNode.childIds`, prunes
  recursively empty `origin:'import'` ancestors from state, and disables their
  retained TransformNodes. Undo restores the exact group snapshot, nodes,
  memberships, and mesh parents; `origin:'user'` empty groups remain.
- `DuplicateCommand` — clones via `AssetLoader.cloneMeshAsNewObject`, offsets +10 mm in X so the clone is visible, auto-selects new meshes. Sharing geometry on redo: clones are kept disabled in memory and re-enabled on redo (same pattern as DeleteCommand).
- `ReparentCommand` / `UnparentCommand` — moves a SceneObject leaf or GroupNode under another GroupNode, or back to scene root. The shared `HierarchyIntegrity.validateParentChange()` helper rejects missing parents, self-parenting, descendant-parent cycles, and any existing cycle encountered while walking ancestors. Commands snapshot before/after parent ids and world transforms inside `execute()` after `_withDetachedPivot` normalizes the graph, then use Babylon `setParent()` plus matrix decomposition/re-application so world transforms do not jump.
- `CreateGroupCommand` / `GroupCommand` — creates a meshless `TransformNode` pivot at the selected meshes' median world position, reparents every selected logical part into it, removes those object ids from previous parent `childIds`, and records the new group as `origin:'user'`. `GroupCommand` remains the compatibility export; `CreateGroupCommand` is the formal command name.
- `UngroupCommand` — dissolves one GroupNode. Direct SceneObject children and direct subgroup children move to the dissolved group's parent (or root), state `childIds` / subgroup `parentId` are updated together, and undo recreates the original TransformNode with the captured world transform before restoring the exact group snapshot. All parent-touching commands wrap their work in `_withDetachedPivot` so meshes are in canonical parents during mutation.

Phase 4 implementations (Shader System):
- `ShaderCreateCommand` — `{ shaderId }` — creates new Babylon material, entry in state, pushes with `getNewId()`.
- `ShaderAssignCommand` — `{ shaderId, meshIds[] }` — reassigns material to multiple meshes, dispatches `SHADER_ASSIGNED` per mesh. Undo restores each mesh's previous shader and clears the shader when the previous value was `null`.
- `ShaderUpdateCommand` — `{ shaderId, field, prevValue, newValue }` — mutates Babylon material + state entry (color, opacity, UV base, etc.). Texture swaps go through `diffuseTextureAssetId`.
- `ShaderDuplicateCommand` — `{ shaderId, newShaderId }` — clones entry + Babylon material, linked meshes remain with original, pushes with `getNewId()`.
- `ShaderDeleteCommand` — `{ shaderId }` — checks `linkedMeshIds === []` before delete, disposes Babylon material.
- `UVOverrideCommand` — `{ meshId, isClearing, ...uvFields }` — applies or clears per-mesh UV offset/scale/rotation, clones material + texture on apply.
- `ColorApplyCommand` — `{ shaderId, hex }` — applies swatch color to a shader's diffuse, dispatches `COLOR_APPLIED`.

Phase 5 implementations:
- `PrintPartCommand` — `{ meshId, prev, next }` — toggles `isPrintPart` boolean on a scene object, dispatches `OBJECT_UPDATED`.
- `RescaleObjectCommand` — `{ objectIds, nextRatio }` — per-object ratio rescale, re-bakes vertex data by the ratio factor, scales the object's position about its origin. Undo runs the inverse factor (Phase 6 overhaul 2026-06-16: replaces global `RescaleWorldCommand` with per-object rescaling).
- `BakeTransformCommand` — REMOVED 2026-06-16. Baking a user rotation/scale into vertices + zeroing the node destroyed the editable, persisted Scale/Rotation properties and was lost on `.mixo` reload. User rotation/scale now always live on the node (`TransformCommand`), editable in Properties + saved via `_decompose`; export still flattens the world matrix so printed geometry is unchanged.

Phase 6+ implementations:
- `SmartReplaceCommand`, `TransformSwabCommand` — fully implemented (context
  menu "Replace with active" / "Copy placement from active").
- `SourceUnitCommand` — per-asset unit re-bake (inverse-factor undo), pushed
  by Properties ▸ File units (review M12).
- `RenameCollectionCommand` — undoable outliner collection rename (L30).

**GroupCommand / CreateGroupCommand (Ctrl+G, task 2.3).** Members may be
objects and/or groups; a member already inside another selected group is
dropped (the outer group carries it). The new group's parent is the lowest
common ancestor of the members (root if they span branches); its name is
unique among all groups ("Group", "Group.001", …), fixed at first execute so
redo reuses it; its origin is the bottom-centre (centre X/Z, min Y — scene is
Y-up) of the members' combined world AABB, identity rotation/scale. Members
are reparented preserving world transforms. Undo restores group state, member
parents and world transforms and disposes the node. After Ctrl+G the new
group is the selection. Group transforms persist as world `{p,q,s}` and
restore parent-first via `setParent` (world-preserving) — exact round trip.

**Ungroup / Delete / Duplicate on groups (task 2.4).** `UngroupCommand`
takes one group id or an array (`UngroupCommand.targetsFor(selection)` = every
selected group plus the parent group of each selected object); each group is
dissolved in turn, children move to its parent preserving world transforms and
the freed children become the selection (undo re-selects the groups).
`DeleteCommand` with a group selected deletes the group, nested groups and all
objects beneath as ONE step (objects/groups already covered by a selected
group are not processed twice; mixed selections are the union); undo restores
objects, group state, parents and world transforms. `DuplicateCommand` with a
group selected clones the whole subtree as a new group tree (names uniquified
like 2.3, e.g. "Group.001"), keeps the original parent, applies the standard
10 mm duplicate nudge, remaps `logicalObjectId` to the new lead ids, and
selects the new root group(s); undo removes the copy, redo restores it.

### Rules
- Stack limit 200. Drop oldest when exceeded.
- New push clears redo stack.
- Snapshot domains differ (2026-06-11 review C3): **logical JSON state** is
  captured at construction, before `execute()`. **Babylon scene-graph facts**
  (parents, world transforms) are captured *inside* `execute()`, after
  `_withDetachedPivot` normalizes the graph — at construction time a live
  selection parents meshes under the temporary pivot, which is disposed
  during detach.
- `undo()` must perfectly reverse `execute()`.
- **Dirty is position-based** (review A5). `HistoryManager.getPosition()`
  returns the serial of the current undo-stack top (0 when empty); push
  assigns a monotonic serial per command. PersistenceManager records the
  position at save/load/new; the project is dirty iff
  `position !== savedPosition` OR a non-history mutation fired
  `PROJECT_DIRTY` since the last save (sticky flag —
  `HistoryManager.isApplying()` distinguishes command-driven dirty events,
  which the position diff already covers). Undoing back to the saved
  position therefore reads clean; editing after save then undoing past the
  save reads dirty.
- **Silent-vs-dirty rule for state writes** (Stage 7, 2026-07-17):
  a slice covered by a `SettingsStore` schema entry (per-user boot defaults —
  `render`, `grid`, `overlays.grid/axes/printPreview`, `print` prefs, `gizmo`,
  `pivotMode`) MUST be written with `{silent: true}` — those are personal
  settings that follow the user across projects, not project state.
  Conversely, a slice persisted only in the .mixo (by ProjectSerializer) MUST
  be non-silent so it dirties, otherwise a `save?` prompt loses the change
  the user just made. Session-only slices (`scene.section`, live selection,
  live camera pose) stay silent — nothing persists them anywhere.
  Concrete cases: `scene.renderOut` is dual-role — its allow-listed fields
  (w/h/transparent/turntable) go to `SettingsStore` in parallel as boot
  defaults, but the whole object (including `pose`, the render composition)
  goes to .mixo, so `_setRenderOut` writes non-silently (Stage 7 fix, was
  the ScenePanel.js:563 bug). ⚠ `scene.userSwatches` is a live conflict —
  the intent comment (ShaderPanel.js:723) calls it "personal presets, not
  project state" and `_addUserSwatch` writes with `{silent: true}`, but
  ProjectSerializer L200 currently embeds it in the .mixo. Pick one: either
  drop the serializer line (per-user) or drop the SILENT (per-project). Not
  touched in Stage 7 to keep behavior; flag on the next persistence pass.

---

## PART 6 — INPUT MANAGER

**File: `src/core/InputManager.js`**

Owns viewport pointer/keyboard input via `scene.onPointerObservable` plus
document-level shortcut routing. DOM-widget listeners (panel buttons, inputs,
drag targets) live in their own UI modules — the rule is "viewport input
flows through InputManager", not "no addEventListener anywhere" (B2).

### Public API
```js
InputManager.init(scene)
InputManager.register(shortcut, context, callbackFn)
InputManager.unregister(shortcut, context)
InputManager.setContext(context)   // 'global' | 'viewport' | 'outliner' | 'properties'
```

### Keyboard Shortcuts (full map)

**Global:**
```
Ctrl+Z          → undo
Ctrl+Shift+Z    → redo
Ctrl+Y          → redo
Ctrl+S          → save
Ctrl+Shift+S    → save as
Ctrl+N          → new project (confirm if dirty)
Ctrl+O          → open
Ctrl+I          → import model (same picker as context menu ▸ Import)

Ctrl+Shift+1    → workspace: Layout     (see PART 13b — Ctrl+digit is Chrome-reserved)
Ctrl+Shift+2    → workspace: Shade
Ctrl+Shift+3    → workspace: Scene
Ctrl+Shift+4    → workspace: Print
```

**Panel toggles** (single keys; suppressed when an `<input>/<textarea>/<select>` has focus):
```
N              → toggle right column (Properties + Shader + Print stack)
T              → toggle bottom region (Asset Panel)
\              → max viewport — collapse right + bottom together
```

Shortcut suppression applies to every global and viewport shortcut while focus
is inside an `<input>`, `<textarea>`, `<select>`, or `contentEditable` element,
except `Escape`. Panel dropdowns and inline editors therefore cannot leak
transform, delete, or panel-collapse commands while the user is editing.
Viewport shortcuts fire when focus is on `body`, the canvas, or inside the
Outliner (`InputManager.__test.isViewportKeyTarget`); body focus under an open
`.modal-overlay` does not count.

**Viewport:**
```
G              → grab (translate); axis with X/Y/Z; plane with Shift+X/Y/Z
R              → rotate; axis with X/Y/Z
S              → scale; axis with X/Y/Z
Escape / RMB   → cancel current op (restore pre-op transform); with no op: marquee
                 cancel, else step out one click-depth scope level (PART 4b)
Enter / LMB    → confirm op

A              → select all (toggle: all → none if all already selected)
Alt+A          → deselect all
LMB drag empty → box select (drag marquee); Shift+drag = additive (see Mouse)
Shift+LMB      → add to selection; Ctrl+LMB → toggle (same in viewport and Outliner)

F              → frame selected
Home           → frame all
F2             → rename active (inline, in the Outliner)
L              → lock / unlock selection
Numpad 0       → restore perspective camera
Numpad 1       → front ortho;   Ctrl+Numpad 1 → back
Numpad 3       → right ortho;   Ctrl+Numpad 3 → left
Numpad 7       → top ortho;     Ctrl+Numpad 7 → bottom
Numpad 4 / 6   → orbit ±15° horizontal
Numpad 8 / 2   → orbit ±15° vertical
Numpad 5       → toggle perspective / orthographic

H              → hide selected
Alt+H          → unhide all
Ctrl+G         → group
Ctrl+Shift+G   → ungroup
Shift+D        → duplicate
Delete / X     → delete (confirm)
~              → toggle gizmo space (world/local)
. (period)     → cycle pivot mode (world → median → active → individual → cursor)
Arrow keys     → nudge selection 1 mm; Shift = 10 mm; Alt = 0.1 mm (overhaul 5.6).
                 Left/Right follow the camera's right vector, Up/Down move away
                 from / toward the viewer on the bed (camera forward; camera up
                 in a straight-down view) — each snapped to the dominant world
                 axis. Ctrl+Up/Down = world ±Y. Locked items skipped (toast when
                 everything is locked); selection already respects the click-
                 depth scope; one undoable TransformCommand per press; ignored
                 while an Outliner row has focus (its arrows expand/collapse),
                 during a modal op, body drag or marquee. Pure step/direction
                 rules: `src/core/SnapUnits.js` (`nudgeStepMM`, `nudgeDirection`).
```

**Laptop fallback:** If keyboard has no numpad, the user can use `Alt+1/3/7` etc. as alternates. Register both.

### Modal Operation Pattern (G / R / S)
1. Key pressed → snapshot pre-op transforms for all selected meshes.
2. Cursor delta drives transform.
3. Axis key constrains.
4. Number typed → exact value (parse and apply).
5. `Esc` / RMB → restore snapshots, no history push.
6. `Enter` / LMB → push one `BatchCommand` containing one `TransformCommand` per affected mesh.
7. Status bar shows live delta: `Grab X: 14.2 mm`.
8. Ctrl held → snap. Steps come from `state.gizmo.snap` in user units —
   translate **mm** (factory 1 mm, `config/default-settings.json`), rotate
   degrees, scale × step — converted once in `src/core/SnapUnits.js`
   (`translateSnapBU`, `rotateSnapRad`, `scaleSnapStep`, `snapToStep`). The
   pre-5.6 translate step was in BU (1.0 = 1 m) and never snapped usefully.
   Gizmo drags use the same steps (PART 7 *Gizmo*).

### Mouse
```
LMB click           → pick + select the item at the click-depth scope (PART 4b
                      "Click-depth scope": root = top-level group / bare object;
                      outside the scope → back to root; parts → lead)
LMB double-click    → two presses < 350 ms / < 4 px on the same depth target: a
                      group → enter it + select the child under the cursor;
                      an object → plain click
Esc (no op)         → priority: modal G/R/S > body drag > marquee > step out one
                      scope level (exited group selected); no-op at root
LMB drag on mesh    → translate selection on the horizontal plane
                      (locked to the active mesh's current Y; Bambu-Studio /
                      Tinkercad style). A drag has to clear ~4 px to engage —
                      shorter LMB presses are still a plain click.
Shift+LMB           → add / remove from selection (no drag)
LMB drag empty      → box / marquee select (core/BoxSelect.js). Starts only on
                      an EMPTY left-down, so it never competes with body-drag
                      (left-down on a mesh) or camera nav (left button unused by
                      the camera). Every item at the current click-depth scope
                      whose COMBINED world-AABB centre projects inside the rect
                      is selected (BoxSelect.itemIdsInRect); Shift+drag ADDS to
                      the current selection. A sub-3 px drag falls back to a
                      plain empty click (clears + exits the scope, unless additive). Esc / RMB
                      mid-drag cancels. Overlay is a plain <div> (.box-select) —
                      never touches the RTT, so exports stay byte-identical.
RMB during body drag → cancel (pivot snaps back, no history push)
RMB click            → context menu (deferred to UP; suppressed if drag > 4 px)
RMB drag             → pan camera target
MMB drag             → orbit
Wheel                → zoom TO CURSOR (default on; CameraRig `setZoomToCursor`)
Hover (no button)    → subtle outline on the item a click would select + cursor
                       `move` (draggable) / `pointer` (locked) — `core/Hover.js`,
                       ≤1 pick per frame, off ≥ 70 % triangle budget (PART 7)
Shift+RMB            → place 3D cursor at hit point
Shift+N              → toggle the 3D-cursor N-panel (plain N = right-panel toggle, taken)
Ctrl+C / Ctrl+V      → copy / paste with an aspect chooser (Object/Location/Rotation/Scale/Loc+Rot/All)
```

### Touch (overhaul 8.4 — iPad full app)
Only `pointerType === 'touch'` takes this path; mouse and pen are untouched.
`_onPointer` hands touch events (after the viewport-tool handler) to a pure
recogniser, `src/core/TouchGestures.js` (`createTouchGestures({now})` →
`down/move/up/cancel/poll` with `{id,x,y,t}` in, gesture records out; no DOM,
no timers — InputManager arms a `TOUCH_LONG_PRESS_MS` timer that calls
`poll`). Babylon's camera pointer input never sees touch (`buttons = []`), and
a touch that lands on a gizmo handle is swallowed by the utility layer
(`skipOnPointerObservable`), so gizmo drags never orbit.
```
1 finger drag (≥ 8 px) on empty space / unselected item → orbit (NO marquee on touch)
1 finger drag starting on a SELECTED, not-effectively-locked item
                  → body drag (same horizontal-plane drag + TransformCommand as the
                    mouse; the item becomes active); beginBodyDrag refusing → orbit
                    A second finger during the body drag CANCELS it (≙ RMB)
2 finger drag     → pan (centroid delta, same grab-pan as MMB)
pinch             → zoom by finger-distance ratio TOWARDS THE PINCH CENTRE
                    (CameraRig.touchPinch: homothety about the point on the
                    target-facing plane, `zoomAboutPoint`; zoom-to-cursor +
                    follow-mode rules as the wheel; ortho extents follow radius;
                    flagged like a wheel step so a face preset does not auto-revert)
tap               → click: click-depth mapping (PART 4b); empty tap clears + exits scope
double-tap        → double-click: 2nd tap < 350 ms and < 12 px on the same depth
                    target → enter group + select the child under the finger
long-press        → ≥ 500 ms moving < 8 px → context menu at that point (same as
                    RMB-up: selects the hit item; empty = scene menu); never a tap
3rd finger        → ignored; lifting to 1 finger after 2 never resumes orbit
modal G/R/S       → tap confirms, long-press cancels, other gestures ignored
hover             → none for touch (Hover is only fed by mouse/pen moves)
```
Two-finger tap = undo is NOT mapped (not in plan 8.4). The canvas gets
`touch-action: none`, `user-select`/`-webkit-touch-callout: none`, Safari
`gesturestart/change/end` preventDefault (no page zoom/scroll/callout), and a
`pointercancel` listener that aborts the gesture (a cancelled body drag snaps
back). Pinned by `tests/touch-gestures.test.mjs`.

---

## PART 7 — SCENE MANAGER

**File: `src/core/SceneManager.js`**

### Render backend (WebGL default, WebGPU opt-in)
`init()` is **async** — it calls `_createEngine()`, which prefers WebGPU only
when opted in (`?engine=webgpu` URL param, or a persisted
`localStorage.mxEngine='webgpu'`; the URL param wins, so `?engine=webgl` is a
force-off escape hatch) and otherwise uses WebGL. The whole WebGPU
attempt (support probe + `initAsync`) is raced against an 8 s timeout; any
failure/timeout falls back to `new BABYLON.Engine` so boot never bricks.
`SceneManager.isWebGPU()` reports the live backend; `main.ts` mirrors it to
`window.__MX_ENGINE` for DevTools / the smoke harness.

**Why WebGPU is opt-in, not default:** it's fully functional — the one custom
shader (the selection outline) has a WGSL twin that compiles, and ALL capture
(PNG / turntable video / project thumbnail, opaque + transparent + orientation)
is verified correct on a real adapter by `WEBGPU_HEADFUL=1 npm run test:webgpu`.
The original blocker (offline render-target → `readPixels` returned **empty** on
WebGPU) was the missing command-buffer flush — WebGPU batches GPU commands and
submits at frame boundaries, so a manual out-of-loop render left nothing to read;
`render/FrameCapture` now calls `engine.flushFramebuffer()` after the manual render, and
`capturePng`/thumbnail use a manual render→flush→readback→encode path on WebGPU
(WebGL keeps the proven `CreateScreenshotUsingRenderTargetAsync`). It stays
opt-in only because it's been verified on a single GPU/driver so far — flipping
the default to prefer WebGPU is now a safe one-liner in `_tryWebGPU`. The print
export is engine-independent regardless (textures read stored source bytes,
geometry reads mesh data — neither touches the GPU), so WebGPU never threatens
the Mimaki LOCK.

### Public API
```js
SceneManager.init(canvas)                     // async — see "Render backend" above
SceneManager.isWebGPU()                       → boolean (false unless ?engine=webgpu and WebGPU came up)
SceneManager.setTransformCommitHandler(fn)    // injected by src/app/main.ts to push TransformCommand on gizmo drag-end
SceneManager.getScene()                       → BABYLON.Scene
SceneManager.getEngine()                      → BABYLON.Engine | WebGPUEngine

// Camera
SceneManager.setCameraPreset(preset)          // 'perspective'|'top'|'bottom'|'front'|'back'|'left'|'right' — animates + frames all + auto-reverts to perspective on pan
SceneManager.frameSelected(meshes)            // animate to fit bounding box of meshes
SceneManager.frameAll()                       // frame every registered mesh — used by NavCube Home button
SceneManager.saveCameraState()                → CameraState
SceneManager.restoreCameraState(state)
// Touch camera (overhaul 8.4) — exported by scene/CameraRig.js, called by InputManager's touch path (PART 6 "Touch")
touchOrbit(dx, dy)                            // 1-finger orbit, same factor as RMB orbit
touchPan(dx, dy)                              // 2-finger grab-pan, same as MMB pan
touchPinch(scale, x, y)                       // zoom towards canvas px (x,y); zoom-to-cursor/follow/ortho rules as the wheel

// Gizmos
SceneManager.setGizmoMode(mode)               // 'translate'|'rotate'|'scale'|'none'
SceneManager.setGizmoSpace(space)             // 'world'|'local'
SceneManager.setScaleLock(locked)             // hide per-axis scale arrows when true; only uniform handle remains
SceneManager.setFollowMode(mode)              // 'free'|'followActive'|'worldOrigin' — camera target tracking
SceneManager.attachToSelection(nodes, pivotMode, activeNode, activeGeometry?)  // nodes = object meshes and/or group TransformNodes (2.2)
SceneManager.topmostTransformTargets(nodes, nodeOf?)   // drop nodes with a listed ancestor (run with pivot detached)
SceneManager.computePivotPosition(nodes, mode, activeNode, activeGeometry?)  // shared gizmo + G/R/S pivot rule

// Selection visuals (custom mask + post-process — see "Selection silhouette" below)
SceneManager.setActive(mesh)                  // full-intensity amber ring
SceneManager.setSelected(meshes)              // dim amber ring (kind='selected')

// Body drag (LMB drag on mesh to translate on horizontal plane)
SceneManager.getBodyDragPlaneY()              → number  (active mesh's current Y, locked during drag)
SceneManager.beginBodyDrag(meshes, startWorldPos)
SceneManager.setBodyDragOffset(worldPos)     // updates pivot position
SceneManager.endBodyDrag()
SceneManager.cancelBodyDrag()                // restores pivot to pre-drag position

// Overlays
SceneManager.setOverlay(name, on)             // 'grid'|'axes'|'wireframe'|'printPreview'|'bedPreview'|'wireframeEdges'
SceneManager.setWireframeEdgeColor(hexColor)  // live-update edge color while wireframeEdges is on (scene/EdgeOverlay.js)
SceneManager.setGrid({cellMM,subdivisions})   // re-skins grid lines (footprint unchanged)
SceneManager.rebuildBed()                     // rebuilds ground to current print.bedDimensions XY
SceneManager.updateBedPreview(dims)

// Environment / effects (delegates — scene/EnvironmentRig.js + scene/ViewEffects.js)
SceneManager.applyRenderSettings(render)      // partial-safe: grade + lights/shadows/floor/HDRI + SSAO + camera optics
SceneManager.setBackgroundEnabled(on)         // gradient Layer + clearColor alpha — transparent PNG capture
SceneManager.setFloorShadowOnly(on)           // floor ↔ ShadowOnlyMaterial swap during transparent capture
SceneManager.setSectionPlane(section)         // cross-section clip plane ({enabled, axis, offsetMM, flip})
SceneManager.getSectionExtentMM(axis)         → { minMM, maxMM, hasContent } — content extent along axis ±1cm buffer (offset-slider range)
SceneManager.invalidateShadows()              // re-arm the RENDERONCE shadow map for one render
SceneManager.getShadowGenerator()             → BABYLON.ShadowGenerator

// 3D Cursor (impl in scene/Cursor3D.js, re-exported here)
SceneManager.getCursor()                      → Vector3
SceneManager.setCursor(v3)                    // also writes state.scene.cursor3d (silent) + fires CURSOR_CHANGED
SceneManager.setCursorVisible(on)             // hidden by default; shown for pivotMode='cursor' or while the N-panel is open
SceneManager.isCursorVisible()                → bool
SceneManager.setCursorFromState(c)            // apply a loaded cursor3d without echoing an event (PersistenceManager load)

// Picking
SceneManager.pickMeshIdAt(x, y)               → meshId | null  (filters out gizmo arrows / overlays)
```

### Implementation Notes
- **Adaptive resolution (`scene/AdaptiveResolution.js`, perf 2026-06-13):** the engine does NOT use raw `adaptToDeviceRatio` — full devicePixelRatio on a 2×/4K display is 4× the fragments and tanks heavy 4096²/high-poly print scenes. `initAdaptiveResolution(engine)` sets a CAPPED base hardware-scaling level (effective DPR ≤ 1.5) and runs a safety-valve controller on `onEndFrameObservable`: rolling-avg frame time > 45 ms for a window steps scaling UP (fewer pixels, clamp ≤ 2.0 = half-res/axis); < 28 ms eases back toward base. Exports/turntable render into their own RTT at an explicit size (`CreateScreenshotUsingRenderTarget` overrides the engine render size), so canvas scaling never affects output quality.
- **Viewport texture cap + export-from-source (`assets/TextureSource.js` + `assets/TextureCap.js`, perf 2026-06-13):** the one lever left for genuinely large texture counts. THE LOCK it works around: Mimaki export reads pixels off the LIVE GPU texture (`print/ExportTextures.js` → `TextureReadback.readTextureRGBA`), so any viewport-side texture downscale would silently degrade the export. The fix decouples the two. **Capture:** at the texture-asset registration seam (`TextureAssets.js` — user-loaded, imported, and restored paths all schedule it at idle) `captureAndCap(assetId, texture)` freezes the full-res, export-ready PNG into `TextureSource` via the SAME `textureToPngBlob()` the export uses — so it is orientation/encoding identical by construction (the glTF↔3MF Y-flip lives only in `TextureReadback.EXPORT_FLIP_Y`). Capture happens BEFORE any downscale. **Cap:** `applyCapToTexture` re-decodes the stored source to a canvas at `min(capPx, srcMax)` and `Texture.updateURL`s the GPU copy (same instance, so material bindings + the export assetId→texture map stay valid; raising the cap restores detail from source — a downscale is never permanent). **Export:** `ExportTextures.textureToBlob(tex, assetId)` returns the captured source blob verbatim when present (full-res, regardless of the viewport cap), falling back to a live GPU readback only when no source was captured. A failed capture sets a runtime `captureFailed` flag (`TextureCap.hasCaptureFailed`, never persisted): with the cap Off the readback is full-res and allowed; with the cap On export ABORTS naming the texture rather than print a downscaled copy (task 0.8). State: `scene.render.textureCapPx` (0 = off/full, default; 4096/2048/1024), persisted with the render look; the Scene ▸ Environment ▸ Performance select writes it and calls `AssetLoader.recapAllTextures(px)`. Default OFF — opt-in VRAM relief. Pinned by `tests/texture-source.test.mjs` (first-writer-wins capture, export-prefers-source, GPU fallback) and the export Y-flip smoke (source path is byte-correct).
- **Texture colour space (task 1.9):** exported texture PNGs are sRGB. Captured full-res source bytes are exported byte-for-byte (no conversion), and source CAPTURE stays raw because the viewport cap re-uploads those bytes (converting a linear normal/roughness map would corrupt it). Only the export GPU-readback fallback (`textureToPngBlob(tex, { toSrgb: true })`, called by `ExportTextures.textureToBlob`) converts a texture flagged `gammaSpace === false` through the exact sRGB OETF per RGB channel (alpha untouched); sRGB textures, incl. `_useSRGBBuffer` ones, pass unchanged. Helpers in `shaders/ColorSpace.js` (`linearToSrgbByte`, `linearRgbaToSrgbInPlace`, `isLinearTexture`); pinned by `tests/color-space.test.mjs`.
- Camera: `BABYLON.ArcRotateCamera` with `mode` switched between `PERSPECTIVE_CAMERA` and `ORTHOGRAPHIC_CAMERA`. Babylon's pointer orbit/pan is fully DISABLED (`buttons=[]`, `panningSensibility=0`); custom orbit/pan lives in `_onCameraPointer`, wheel zoom is percentage-based (`wheelDeltaPercentage=0.08`) and **zooms to the cursor** (overhaul 5.6): Babylon's `ArcRotateCameraMouseWheelInput.zoomToMouseLocation`, ON by default (`setZoomToCursor(on)` / `isZoomToCursor()`), forced off in follow modes (the target is re-locked every frame there). A capture-phase canvas `wheel` listener refreshes the input's hit plane before each step (Babylon only refreshes it during inertial motion, and the custom orbit/pan have none) and flags the step so the ortho face-preset auto-revert re-bases `_lastAppliedTarget` instead of treating the zoom's target shift as a pan. Ortho bounds recompute from `camera.radius` + aspect every frame the camera is orthographic.
- Numpad face presets route through `setCameraPreset` (animated, bbox-fit — see *Camera Presets* below). Numpad5 toggles projection IN PLACE via `toggleOrthographic()`, preserving the current view direction.
- **Selection silhouette (`scene/SelectionOutline.js`):** custom mask render-target + post-process — NOT `HighlightLayer`. HL's stencil mask leaks onto PBR mesh faces on any material reporting an alpha mode. The replacement renders selected meshes into a half-res RTT with an emissive override material, then a fullscreen shader dilates the mask, subtracts the silhouette, and adds `colour × ring` to the scene. By construction the ring exists only outside the mesh. **Two-tone (2026-06-14):** the mask is TWO-CHANNEL — the ACTIVE object writes emissive `(1,0,0)` (carries in R), the other SELECTED objects write `(0,1,0)` (carries in G). The shader dilates both channels and tints R→`OUTLINE_ACTIVE_HEX` (`#c2410c`, darker orange), G→`OUTLINE_SELECTED_HEX` (`#f59e0b`, amber), active drawn over selected where rings overlap — so the active object reads apart from the rest of the selection. A single intensity channel couldn't carry which-is-which without a threshold that misfires on the dilation fringe; the GLSL **and** WGSL twins both consume `activeColor`/`selectedColor`. Dials in `scene/SceneConstants.js`: `OUTLINE_RADIUS_PX = 4.5`, `OUTLINE_INTENSITY = 2.0`, `OUTLINE_ACTIVE_HEX`, `OUTLINE_SELECTED_HEX`. **Gated (perf 2026-06-13):** the mask RTT and the 64-tap fullscreen pass are DETACHED whenever the selection is empty (`_setOutlineEnabled`) — they were running every frame for zero benefit, a real cost at 4K over heavy scenes; re-attached on the first selection. Browser smoke pins detach-when-empty / attach-when-selected. **Hover channel (overhaul 5.6, Decision 22):** a third mask channel — the hovered item's meshes write `(0,0,1)` (B); the shader draws it as the SELECTED tint at `HOVER_WEIGHT = 0.45` and only where no active/selected ring sits (`setHover(meshes)`; `outlineEntries` gives each mesh ONE role, active > selected > hover). The pass is attached whenever any of the three lists is non-empty. Driver: `src/core/Hover.js` — pointer moves only record the latest position, the pick runs once in `onBeforeRenderObservable` (≤1 pick/frame); target = the item a click would select (`hoverTarget`: click-depth scope, outside-scope → root item); any held button, a modal G/R/S op (`setSuspended`), pointer-leave, or a scene at ≥ 70 % of `caps.triangleBudget` (`setBudgetExceeded`, fed by MeshStats' cached total) clears it; geometry/project/scope/visibility/lock events clear it. Canvas cursor `move` over a draggable item, `pointer` over a locked one; the hovered id is mirrored as `canvas.dataset.hoverId` (smoke flag).
- **Wireframe edges (`scene/EdgeOverlay.js`):** `SceneManager.setOverlay('wireframeEdges', on)` builds a per-mesh CLONE sharing the source geometry, drawn with a wireframe emissive `StandardMaterial` (`zOffset −1`) over the textured base — `enableEdgesRendering` at any epsilon only showed sharp creases (field report). Clones carry `metadata.edgeOverlay` so they never pick, cast, or register. `setWireframeEdgeColor(hex)` live-updates the shared material.
- **Gizmo:** `BABYLON.GizmoManager(scene)` with a temporary `TransformNode` pivot (`PivotSession`) that parents the selected **transform nodes** — object meshes and, since overhaul 2.2, whole user-group `TransformNode`s. A group node is parented as one unit, so the group moves/rotates/scales rigidly and its children keep their local transforms; any node with a selected ancestor is dropped (`topmostTransformTargets`, evaluated after detaching so parents are canonical). Drag snapshots are keyed by node id (meshId / groupId). Pivot position (`computePivotPosition`, also used by the keyboard G/R/S modal): `world` = origin; `cursor` = 3D cursor (`getCursorPosition`); `median` = centre of the union of world AABBs of every enabled mesh under the selected nodes; `active` = AABB centre of the active entry's geometry (`activeGeometry`: all parts of the active object, or the active group's member meshes); `individual` = centroid of the selected nodes' own origins (a group contributes its group node origin). Geometry-less selections fall back to the origin centroid / active origin. `local` gizmo space copies the active node's world rotation (group node when a group is active). **Gizmo Ctrl-snap (overhaul 5.6):** `PivotSession.setGizmoSnap(on)` writes Babylon `snapDistance` on the position (BU), rotation (rad) and scale (×) gizmos from `state.gizmo.snap` via `SnapUnits.gizmoSnapDistances` (0 = free), re-applied whenever sub-gizmos are recreated; InputManager drives it from Ctrl/Meta keydown/keyup, live pointer-event modifiers, and window blur (off). **Touch (overhaul 8.5):** `PivotSession` tracks the live input kind (`(pointer: coarse)` at init, then the last `pointerdown`'s `pointerType`: touch/pen = coarse, mouse = fine), toggles `body.touch-input`, and sets every sub-gizmo's `scaleRatio` to `TOUCH_GIZMO_SCALE` (1.7; mouse = Babylon default 1, re-applied whenever sub-gizmos are recreated). `src/ui/TransformSheet.js` is the numeric Transform sheet (toolbar button shown only under `.touch-input`): Move X/Y/Z mm, Rotate X/Y/Z deg (world axes), Scale % (uniform), all relative to the active pivot, blank = no change; targets from `Selection.getTransformTargets()` (locks + groups honoured), applied as ONE `TransformCommand`. Parsing/maths (`parseSheetValues`, `planSheetTransform`) are pure and tested in `tests/transform-sheet.test.mjs`.
- **Multi-control state sync rule (2026-06-14):** any state with MORE THAN ONE UI control or entry point MUST dispatch an event on change — a silent `setState` only stays consistent when a single owner re-reads it. Concretely: `Selection.setPivotMode` → `PIVOT_MODE_CHANGED` (toolbar pivot group ↔ N-panel "Use Cursor as Pivot"); `PivotSession.setGizmoMode`/`setGizmoSpace` → `GIZMO_CHANGED` (toolbar World/Local button ↔ the `` ` ``/`~` space-toggle hotkey + G/R/S); `Cursor3D.setCursor` → `CURSOR_CHANGED` (N-panel XYZ inputs + Show/Hide button ↔ Shift+RMB placement + context-menu snap ops). `ViewportToolbar` subscribes `PIVOT_MODE_CHANGED` + `GIZMO_CHANGED`; `CursorPanel` subscribes `CURSOR_CHANGED` + `PIVOT_MODE_CHANGED`. Overlays need no such event because each overlay has exactly ONE control surface (shading-mode/wireframe/inverted = `ViewportToggles`, grid/axes = `ScenePanel`, bedPreview = `PrintPanel`); `followMode` is toolbar-only. Drag-start snapshots absolute transforms; drag-end snapshots again and the bridge in `src/app/main.ts` pushes one `TransformCommand` with `{ alreadyApplied: true }`.
- **Axes overlay:** three `MeshBuilder.CreateLines` meshes (red X, green Y, blue Z) at length `0.05` BU. 1-pixel GL line stroke, no arrowheads. Toggled via `mesh.isVisible`.
- **Bed (grid):** ground plane footprint = the printer bed XY (`state.print.bedDimensions.x` × `.y`, mm → BU; default Mimaki 3DUJ-553 508 × 508 mm), rectangular. Lines drawn with `BABYLON.GridMaterial`, styled from `state.scene.grid` (`cellMM` minor cell size, `subdivisions` minor cells per major line; default 10 mm / 10). `SceneManager.rebuildBed()` resizes the floor when bed dimensions change (called from Print ▸ Bed); `SceneManager.setGrid({cellMM,subdivisions})` re-skins the lines (called from Properties ▸ Scene). The single flat `FRONT` tag sits at the `+Z` bed edge and scales with `min(width,depth)`. Old v3.1 saves with a scalar `scene.gridSize` are ignored; `scene.grid` falls back to the 10/10 default.
- **Bed FRONT tag:** a single `MeshBuilder.CreatePlane` mesh with `DynamicTexture` text `FRONT`, laid **flat on the bed** (`rotation = (π/2, π, 0)`, no billboard) hugging the +Z edge, 4 mm above the bed, textured face up with glyphs readable from the front-elevated camera (verified live; `rotation.x = -π/2` mirrors the text, `+π/2` alone is upside-down). Drawn in the muted grid-line colour (`rgba(97,97,117,0.55)` ≈ grid `Color3 0.38,0.38,0.46`) so it reads as part of the bed, not a UI accent. Only FRONT is shown — once the front edge is known the rest is implied; the old four upright billboarded tags (FRONT/BACK/LEFT/RIGHT) were dropped as visual noise. Size scales with bed extent (`max(0.03, extent * 0.10)` × 0.32 ratio). Rebuilt by `_rebuildGroundMesh` whenever bed extent changes. Visibility tracks `state.scene.overlays.grid` (toggled together with ground plane).
- **Bed preview:** `MeshBuilder.CreateBox` sized to bed dims, semi-transparent material, wireframe outline overlay.
- **3D cursor (`scene/Cursor3D.js`, 2026-06-14):** the original yellow translucent ball (a fixed world anchor) PLUS a Blender-style crosshair + dashed ring that billboard to the camera and hold a roughly constant on-screen size (scaled per-frame by `camera.radius × SCREEN_K`, ring/crosshair drawn in `renderingGroupId 1` so they're never occluded). Shown for `pivotMode === 'cursor'` or while the N-panel is open. `setCursor` writes `state.scene.cursor3d` (silent — placing the cursor doesn't dirty the project, same rule as selection) and fires `CURSOR_CHANGED`; `PersistenceManager` restores it on load via `setCursorFromState`.
  - **N-panel (`ui/CursorPanel.js`):** a slide-out sidebar docked to the viewport's right edge (clipped by `#viewport { overflow:hidden }`, so the closed body hides and only a 26 px tab peeks), toggled by **Shift+N** (plain N is the docked right-panel toggle). Holds a 3D-Cursor tab: live two-way XYZ inputs in mm (`× MM_PER_BU`), a "Show 3D cursor" checkbox, and a "Use Cursor as Pivot" checkbox. It does not contain cursor snap buttons. Visible labels and the tab tooltip use `cursor.*` i18n keys and update on `LOCALE_CHANGED`.
  - **Snap ops (`core/CursorTools.js`):** `selectionToCursor()` rigid-translates the whole selection so its median lands on the cursor (one undoable `TransformCommand`); `cursorToSelection()` moves the cursor to the selection median; `cursorToWorldOrigin()` resets it to (0,0,0). All snap ops are exposed from the context menu, not the N-panel. Cursor moves are NOT in the undo stack (Blender-parity — the cursor is a tool, not scene content).
- **Copy / Paste with aspect chooser (`ui/CopyPaste.js`, 2026-06-14):** Ctrl+C opens a popup menu (Object / Location / Rotation / Scale / Location+Rotation / All) and stores the ACTIVE object's chosen data in an in-app clipboard; Ctrl+V opens a menu filtered to what the clipboard holds and applies it to every selected object as one undoable `TransformCommand` ("Object" duplicates the source via `DuplicateCommand`). Multi-select "copy active → others" falls out for free (select N, Ctrl+C All, Ctrl+V All). Complements the always-on Properties `↧` copy-from-active buttons.
- **Camera Follow Modes:** `state.scene.camera.followMode` ∈ `{'free','followActive','worldOrigin'}`. A `scene.onBeforeRenderObservable` hook (`_applyFollowTarget`) overrides `_camera.target` every frame in non-free modes — `worldOrigin` pins it to `(0,0,0)`; `followActive` reads the active object id via `state.selection.activeId`, finds the Babylon mesh through `_scene.meshes.find(m => m.metadata?.meshId === activeId)`, and pins target to its hierarchy bbox centre. Pan input is effectively disabled in non-free modes — to regain pan, switch back to `'free'`.
- **Default pose + first-asset auto-frame:** Initial `state.scene.camera` puts the camera ~30 cm above origin looking down 45° from the front-right quadrant. With an empty scene this is the user's "neutral tabletop" pose. On the **first** `ASSET_INSTANTIATED` event of a session (or after `PROJECT_NEW`), SceneManager debounces 50 ms and calls `frameAll()` so all submeshes of a multi-mesh import (e.g. 5-node glTF) frame as a union, not one-by-one. A `_initiallyFramed` latch is then set to `true` so subsequent drops do not re-frame — the user is past initial orientation. `PROJECT_LOADED` also sets the latch (saved camera state wins). `PROJECT_NEW` resets it.
- **Preset face → α/β convention:** Babylon ArcRotateCamera position = `target + R·(sinβ cosα, cosβ, sinβ sinα)`. The NavCube / preset map below uses this so each clicked face shows that face of the scene:

  | Preset  | α           | β        | Camera sits at |
  |---------|-------------|----------|----------------|
  | front   | π/2         | π/2      | +Z |
  | back    | -π/2        | π/2      | -Z |
  | right   | 0           | π/2      | +X |
  | left    | π           | π/2      | -X |
  | top     | (any)       | 0        | +Y |
  | bottom  | (any)       | π        | -Y |
  | perspective | π/3 | π/4 | front-right-3/4-elevated (matches initial load) |
- **Camera Presets — animate + fit + auto-revert:** `setCameraPreset(name)` animates `alpha`, `beta`, `target`, `radius` simultaneously (320 ms, quadratic ease-in-out) toward the named view. Before animation it computes the scene's hierarchy bbox over every `metadata.meshId`-tagged mesh and sets the target to that centre plus a radius of `diag × 1.2` so all content fits. For an ortho preset (top/bottom/front/back/left/right) the camera switches to `ORTHOGRAPHIC_CAMERA` only *after* the animation finishes — interpolating through ortho mid-flight looks broken. For `'perspective'` the mode goes back to `PERSPECTIVE_CAMERA` post-anim. The settled `target` is snapshotted in `_lastAppliedTarget`. **Auto-revert:** inside `_applyFollowTarget`, when the camera is in ortho mode and the preset is not perspective, any divergence of `_camera.target` from `_lastAppliedTarget` (squared distance > `1e-6`, i.e. ~1 mm pan) flips the preset back to `'perspective'` and dispatches `CAMERA_PRESET_CHANGED`. The `_animating` flag suppresses revert during the preset animation itself. Camera input: Babylon's pointer orbit/pan is fully disabled (`ArcRotateCameraPointersInput.buttons = []`, `panningSensibility = 0`) because Babylon hard-classifies RMB(2) as its pan button — RMB could never orbit through Babylon. All mouse orbit/pan is custom in `_onCameraPointer` (scene `onPointerObservable`); Babylon keeps only the wheel-zoom input. CAD convention, all modes: **RMB drag = orbit**, **MMB drag = grab-pan** target in view plane (speed ∝ radius), **Shift+MMB drag = orbit**. LMB(0) is ignored by the camera so selection/gizmo/body-drag own it. The context-menu RMB stays usable because `InputManager` defers `_onContextMenuRMB` to RMB-UP and cancels it if movement exceeds 4 px (an RMB drag both orbits and suppresses the menu). In follow modes `_applyFollowTarget` re-locks the target each frame so a pan only persists in `free` (intended). Middle-click autoscroll suppressed via `mousedown`/`auxclick` `preventDefault` on the canvas. Net: **RMB = orbit, MMB = pan, Shift+MMB = orbit, wheel = zoom, LMB = select/gizmo**.

### Lighting & viewport look (Fusion 360-style)
Neutral studio look — flat, even, slightly punchy, like Fusion's default env.
- **Backdrop:** soft vertical gradient (`BG_GRADIENT_TOP` light cool grey →
  `BG_GRADIENT_BOTTOM` steel) painted into a 4×512 `DynamicTexture` on a
  fullscreen background `BABYLON.Layer` (`isBackground=true`). Screenshot-safe,
  no engine alpha. `scene.clearColor` = the gradient base so no black flash.
- **Tone mapping:** `scene.imageProcessingConfiguration` ACES, `contrast`
  `TONE_CONTRAST` (1.10), `exposure` `TONE_EXPOSURE` (1.05). Applied at
  material shading so it bakes into the frame the selection-silhouette
  post-process samples — no post-chain conflict.
- **3-light studio (`scene/EnvironmentRig.js`):** `HemisphericLight`
  (`HEMI_INTENSITY` 0.85, white sky, `HEMI_GROUND_COLOR` soft floor bounce so
  undersides never go black) + `DirectionalLight` "key" (`KEY_INTENSITY`
  0.70) + opposite low `DirectionalLight` "fill" (`FILL_INTENSITY` 0.25,
  **zero specular** so no second highlight). The key drives a
  `ShadowGenerator` 2048², kernel-blurred (`SHADOW_BLUR_KERNEL` 32),
  `darkness` `SHADOW_DARKNESS` 0.62 (soft contact, not inky).
  `getShadowGenerator()` returns this. **Casters:** `ensureShadowCasters()`
  (ASSET_INSTANTIATED + PROJECT_LOADED) adds every content mesh —
  ancestor-chain meshId walk, same as picking — tracked by a `uniqueId` Set
  (O(n), audit C3); disposal self-removes. (The generator's renderList starts
  empty; before 2026-06-13 nothing ever cast, so the bed's `receiveShadows`
  was a no-op.)
- **Shadow map is RENDERONCE** (perf audit): the 2048² blurred ESM was the
  largest fixed per-frame GPU cost, so it renders only when invalidated —
  `invalidateShadows()` re-arms one render via `resetRefreshCounter()`.
  Invalidation sources: caster `onAfterWorldMatrixUpdateObservable` (gizmo
  drags, bounce-in, programmatic transforms), caster add/dispose, shadow
  setting changes, and the turntable sweep's per-frame key-light rotation
  (`render/SweepRig.createSweepRig().applyDelta`). Browser smoke pins soft (0<α<255)
  shadow pixels with a real caster — a stale map fails it.
- Tunables are UPPER_SNAKE constants in `scene/SceneConstants.js`; the
  environment half of `applyRenderSettings` (lights/shadows/floor/HDRI)
  delegates to `EnvironmentRig.applyEnvironmentSettings`, the effects half
  (SSAO/section) to `ViewEffects.applyViewEffects`.
- **SSAO (`scene/ViewEffects.js`, 2026-06-13):** `SSAO2RenderingPipeline`
  attached to the nav camera while `render.ssaoEnabled` (**default OFF** —
  see perf note; `ssaoStrength` 0..2 → `totalStrength`). Half-res AO,
  `radius` 0.009 BU (~9 mm contact reach at the 300 mm working area), 12
  samples. Lazily constructed; disabling DISPOSES the pipeline. Construction
  is try/catch-feature-detected — unsupported GPU/driver ⇒ stays off silently
  (`isSsaoActive()` is the probe hook). **Viewport-only:** RTT export paths
  skip the camera post chain, which is also what keeps the selection
  silhouette out of renders — the silhouette post-process coexists with the
  pipeline (smoke + screenshots verified). `DefaultRenderingPipeline` remains
  deliberately unused.
  ⚠ **Perf / why default OFF (2026-06-13):** SSAO2 enables a geometry
  prePass that re-renders ALL scene geometry into MRT (color/normal/depth)
  targets every frame. On a heavy import (the `claude.glb` repro: ~80k tris
  + a 4096² base-colour texture) this pushed worst-frame from ~24 ms to
  ~250–330 ms (measured in SwiftShader via `tests/tmp-import-repro.mjs`
  pattern) — recurring stalls that read as a frozen import, and enough to
  wedge a TDR-prone GPU/driver (this machine's Chrome 149). The custom
  selection-mask RTT sets `noPrePassRenderer = true` so the prePass doesn't
  ALSO double-render geometry into it, but the main-camera prePass cost is
  inherent to SSAO2 — hence opt-in, not default.
- **Bounce-in (`scene/ImportBounce.js`, 2026-06-13):** freshly instantiated
  meshes scale-pop into place (260 ms, 0.6→easeOutBack overshoot→1). Pure
  visual feel: the animation multiplies the mesh's own scaling and ends with
  an EXACT `copyFrom` of the original vector (smoke pins the landing) — state
  transforms never touched. Skipped under `prefers-reduced-motion`; project
  loads never fire ASSET_INSTANTIATED (restore path uses `bindRestoredMesh`),
  so bulk loads don't bounce by construction. Imports, drops, duplicates and
  primitives do.

---

## PART 8 — ASSET LOADER

**File: `src/core/AssetLoader.js`** — thin façade; implementation lives in
`src/core/assets/` (`AssetImport` live imports, `AssetRestore` project
restore + clones, `AssetRegistration` SceneObject/collection minting,
`AssetThumbnail` idle thumbnails, `MeshRegistry` registries + id minting,
`DirMounts` mounted-directory opaque refs, `ObjSiblings` OBJ sibling resolution).
The façade owns only release/remove/reset lifecycle; the `AssetLoader` object
is deliberately NOT frozen — monkey-patching it is the headless-test seam.

### Public API
```js
AssetLoader.mountDirectory()                          → Promise<DirectoryEntry>
AssetLoader.loadFromHandle(fileHandle, position)      → Promise<MeshId[]>
AssetLoader.loadFromBlob(blob, filename, position)    → Promise<MeshId[]>
AssetLoader.loadTextureFromHandle(fileHandle)         → Promise<void>  // async thumbnail gen
AssetLoader.loadTextureFromBlob(blob, filename)       → Promise<void>
AssetLoader.registerImportedTexture(babylonTexture)   → Promise<assetId>  // glTF-embedded texture → asset entry + data URL thumbnail
AssetLoader.releaseAsset(assetId)                     → void
AssetLoader.removeAsset(assetId)                      → void  // removes from state + dispatches ASSET_REMOVED
AssetLoader.instantiateAsset(assetId, position)       → Promise<MeshId[]>  // re-loads from cached blob URL; each call = independent scene objects
AssetLoader.getContainer(assetId)                     → BABYLON.AssetContainer | null
AssetLoader.getContainerGeomMeshes(assetId)           → BABYLON.AbstractMesh[]  // stable geometry-only order
AssetLoader.getAssetBytes(assetId)                    → Promise<ArrayBuffer|null>
AssetLoader.restoreContainer(assetId, blob, ext)      → Promise<BABYLON.AbstractMesh[]>  // project load; no state mutation
AssetLoader.bindRestoredMesh(meshId, mesh, assetId, sourceUnit?) → void
AssetLoader.restoreTexture(entry, blob)               → Promise<assetId>
AssetLoader.registerAssetEntry(entry)                 → void
AssetLoader.cacheAssetBlob(assetId, blob)             → void  // library asset restore without scene load
AssetLoader.resetAll()                                → void
AssetLoader.getBabylonTexture(assetId)                → BABYLON.Texture | null
AssetLoader.getBabylonMesh(meshId)                    → BABYLON.AbstractMesh | null
AssetLoader.cloneMeshAsNewObject(sourceMeshId, worldOffset) → MeshId | null
AssetLoader.restoreCloneToScene(meshId, savedObj, mesh) → void
AssetLoader.splitMultiMaterialMeshes(meshes, makeChild, genGroupId) → split plan
AssetLoader.splitMultiMaterialMeshesInContainer(container) → void
```

### AssetEntry
```js
{
  id, name, displayName, filename, originalPath, extension,
  kind,                        // 'mesh' | 'texture' — new in Phase 4
  isImported,                  // boolean — true if texture from glTF, false if user-loaded
  sourceUnit,                  // 'meters'|'centimeters'|'millimeters'|'inches'|'feet' — default 'millimeters' (mesh only)
  unitConfirmed,               // boolean — true by default; false only when the user flagged for review (mesh only)
  modelRatio,                  // denominator of the ratio the asset was authored at (1 = full real-world size, 72 = 1:72).
                               //   Default 1 unless a glTF "ratio" extra overrides (mesh only).
  directoryHandleKey,          // IndexedDB key for FileSystemDirectoryHandle (folder-mounted assets)
  fileHandleKey,               // IndexedDB key for a single FileSystemFileHandle (loose drag-drop, Chrome only).
                               //   Mutually optional with directoryHandleKey — an asset has at most one of either.
                               //   Either field present ⇒ "Linked"; neither ⇒ "Snapshot" (frozen embedded copy only).
  blobUrl,                     // module-local Map, not in state
  thumbnailDataUrl,
  contentHash,                 // sha256 of source file bytes (set at import; reused at save)
  libraryItem,                 // null or { sourceFilename, rootName, rootPath } for GLB library children
  sourceFileHash,              // texture identity scope — §10b (texture entries)
  sourceAssetId,               // owning mesh asset for imported textures — §10b
  babylonTextureName,          // loader-minted texture.name for reload rebind — §10b
  imageContentHash,            // SHA-256 of canonical encoded image bytes; filename excluded
  textureView,                 // {imageContentHash,colorSpace,invertY,wrapU,wrapV,samplingMode}
}
```

### SceneObject (per visible mesh, in `state.scene.objects[meshId]`)
```js
{
  id,                          // meshId
  name,                        // mesh name from import or rename — unique across
                               //   state.scene.objects + state.scene.groups
                               //   (see "Name uniqueness invariant" below)
  assetId,                     // back-reference to AssetEntry
  collectionId,                // outliner/import display bucket; never scene-graph parentage
  parentId,                    // transform-parent GroupNode id, else null
  shaderId,                    // shader currently assigned (null = scene default)
  visible, locked, isGhost,    // booleans
  isPrintPart,                 // include in OBJ/STL export
  sourceGroupId,               // LEGACY / migrate-only (Decision 33): uuid
                               //   stamped at split time, kept in .mixo for
                               //   compat. Runtime NEVER reads it; the loader
                               //   seeds logicalObjectId from it once
                               //   (LogicalObjects.seedLogicalObjectIds).
  logicalObjectId,             // lead meshId for a multi-part logical object.
                               //   The linkage validator + exporter re-union by.
                               //   Set for BOTH a MultiMaterial split AND a glTF multi-primitive
                               //   mesh (parts named `<stem>_primitive<N>`
                               //   sharing a stem + parentId). Null for ordinary
                               //   single-mesh objects. logicalObjectPartIds()
                               //   resolves the full part set; validation welds
                               //   it. Separate objects (distinct nodes) never
                               //   share one.
  isInternalPart,              // true for hidden parts (split sibling or extra
                               //   primitive). They remain in state for shader
                               //   binding/export, but Outliner/selection store
                               //   the lead id.
}
```

`collectionId` and `parentId` are intentionally independent. Moving an object
between collections changes only display routing; reparenting changes only the
transform hierarchy. A mixed-collection group is legal and renders at the
Outliner root with a badge rather than rewriting member collections.

Selection stores only visible logical-object lead ids. Any command that changes
the object lifecycle or transform surface (`DeleteCommand`, `DuplicateCommand`,
`GroupCommand`, `ReparentCommand`, `UnparentCommand`, hide/lock toggles,
copy/paste transform, Properties transforms, and export collection) expands
those leads to every internal material-split part before mutating state or
Babylon meshes. A duplicated split object receives its own lead `logicalObjectId`
(and no `sourceGroupId`); it must never point back to the original logical
object.

### GroupNode (transform hierarchy, in `state.scene.groups[groupId]`)
```js
{
  id, name,
  parentId,                     // parent GroupNode id, or null
  childIds: [],                 // direct SceneObject ids; subgroups link by parentId
  origin,                       // 'import' | 'user'
}
```

GroupNodes are the first-class transform parents in the runtime and map to
Babylon `TransformNode`s. Mesh SceneObjects are leaf geometry; object-as-parent
is not part of the current runtime contract.

`origin` controls empty-group lifecycle, not rendering. Deleting objects always
removes their ids from every `childIds` array. Imported groups that then have no
direct objects or live subgroups are pruned recursively in the same undoable
command; user groups remain as intentional organization. Documents written
before `origin` existed normalize missing values to `'user'`, which avoids
silently deleting a user's group.

**Name uniqueness invariant.** `name` must be unique across the union of
`state.scene.objects` and `state.scene.groups`. Two sites enforce it:

- **`AssetLoader._uniqueObjectName(baseName)`** — called when a new
  SceneObject is registered (import, duplicate, instantiate). If `baseName`
  is already taken, the helper appends `.NNN` (zero-padded, scanned
  upward) until it finds a free slot. The first `.NNN` collision is
  parsed off the stem so collisions of collisions stay readable.
- **`HistoryManager._setName(id, prev, next)`** — rename collisions are
  resolved by the same `.NNN` scheme, excluding `self` from the taken
  set so renaming to the current name is a no-op. The command dispatches
  the *final* (post-uniquify) name so Outliner / Properties never display
  the raw input.

Why: per-mesh export filenames are `${projectName}_${name}_r{ref}to{target}.${ext}`
(see §12 *Export filenames*). Two SceneObjects with the same name would
silently overwrite each other inside the outer zip. The invariant turns a
quiet data-loss footgun into a guaranteed visible suffix.

### CollectionEntry (per imported file, in `state.scene.collections[id]`)
```js
{
  id,                          // 'col_<timestamp>_<counter>'
  name,                        // filename + .NNN if collision (display-mutable)
  sourceFile,                  // original filename (immutable)
  sourceAssetId,               // assetId this collection was minted for
  createdAt,                   // ISO8601
}
```
Each `AssetLoader.loadFromBlob` / `instantiateAsset` mints exactly one CollectionEntry. Mesh-to-collection link lives on `SceneObject.collectionId`, never on the collection side, so groups can freely span collections (see §13 Outliner render rules).

### Load Flow
```
1. Receive FileHandle or Blob.
2. Create Blob URL via URL.createObjectURL.
3. BABYLON.SceneLoader.LoadAssetContainerAsync(blobUrl, '', scene, null, extension).
   `.obj` EXCEPTION: parses in a worker when `Worker` exists
   (`src/core/workers/ObjParse.worker.js` runs the SAME Babylon OBJ/MTL loader
   against a NullEngine scene — no parser drift; geometry returns as
   transferable buffers and `src/core/WorkerImport.js` rebuilds real
   meshes/StandardMaterials/textures into an AssetContainer). Babylon's OBJ
   parse is synchronous text — big files froze the UI when parsed on the main
   thread. MTL/texture sibling resolution uses the same filename→objectURL map
   inside the worker. Any worker failure falls back to the main-thread
   SceneLoader path (headless tests always take the fallback; the worker path
   is pinned by the browser export smoke's OBJ block).
   Supported: `.glb .gltf .obj .stl` (Babylon loaders package) + `.3mf`
   (`src/core/ThreeMFLoader.js`, a self-registered SceneLoader plugin — Babylon
   ships none). 3MF import is the exact INVERSE of `PrintManager.exportThreeMF`
   for files we write, plus the production-extension component layout emitted
   by slicers such as Bambu Studio:
   unzip OPC → `_rels/.rels` target / `3D/3dmodel.model` → mesh `<object>`
   resources become Babylon meshes; component `<object>` resources become
   meshless TransformNodes for import hierarchy; `<component objectid transform>`
   and `<build><item>` form the placement tree. If a component carries
   `p:path` / `path`, the loader resolves that OPC path relative to the current
   model part, parses the related `.model` part, and instantiates the referenced
   `objectid` from that part. Component/build transforms are composed in 3MF
   space and baked into child mesh vertices, then each vertex goes through
   `print/PrintSpace.fromPrintSpace` (3MF right-handed Z-up → Babylon
   left-handed Y-up: `(x, y, z) → (-x, z, -y)`, a reflection — the exact
   inverse of the writer's `toPrintSpace`). The model `unit` attribute scales
   to mm (micron/millimeter/centimeter/inch/foot/meter; anything else throws);
   triangle indices outside the vertex range and non-numeric coordinates
   throw instead of producing a garbage mesh. Triangle order is kept as
   written (the reflection already makes 3MF's CCW-outward read as Babylon's
   default CounterClockWise front). Verified 2026-09-17 against a
   PrusaSlicer-authored file (`tests/fixtures/prusa-tetra.3mf`, embedded in
   `tests/threemf-components.test.mjs`). The loader maps
   `m:colorgroup`+`pid/pindex` to
   `StandardMaterial.diffuseColor`, or `m:texture2dgroup` to
   `StandardMaterial.diffuseTexture`. Repeated component references instantiate
   editable mesh copies rather than shared geometry. Returns an AssetContainer
   so every downstream path (shaders, re-instantiate, project restore) is
   identical to other formats. Vertices are raw mm → handled by the normal
   import-scale model exactly like STL (so scale is NOT bit-identical across a
   working≠target ratio — same inherent behaviour as re-importing an exported
   OBJ/STL).
4. Read import metadata via `src/core/import/ImportMetadata.js`. It scans
   Babylon's `node.metadata.gltf.extras` on meshes and transform nodes with
   normalized key matching.
5. If import mode is library, derive item roots from the first real top-level
   object below Babylon `__root__` or the marker empty. Register one mesh
   AssetEntry per root with `libraryItem`; do not call `addAllToScene()` and do
   not create SceneObjects. Project restore caches the source blob for
   library-only assets without loading geometry into the viewport.
6. For normal scene import or library-child instantiation, split MultiMaterial
   meshes, then register all materials → ShaderLibrary.registerFromContainer
   (merge strategy).
7. Store AssetContainer in module-local Map<assetId, container>.
8. addAllToScene() for the container.
9. Resolve modelRatio: read glTF "ratio" extra (Blender custom property);
   parse '1/N', '1:N', or bare 'N' as denominator N. Default 1 when absent.
10. Apply import scaling — see "Import Scale Model" below. Drop offset on top.
11. Register AssetEntry (sourceUnit='millimeters', unitConfirmed=true, modelRatio).
12. Create SceneObject entries for each visible mesh.
13. Generate thumbnail via Tools.CreateScreenshotUsingRenderTargetAsync (async).
14. If vertexCount <= 100_000 → queue MeshValidator.validateMesh; else skip
    auto-validate with toast.
15. Dispatch EVENTS.ASSET_INSTANTIATED for each mesh.
```

### Import Scale Model

> **⚠ SUPERSEDED (2026-06-16):** `workingRatio` is gone — scale is now a
> **per-object `ratio`** (see *Per-Object Ratio Redesign* at the end of §12, the
> LIVE behaviour). The import formula below is unchanged — only `R`'s scope moved
> to the object (seeded `= modelRatio`). The `workingRatio`-based prose below is
> historical; read it only for the unit/bake mechanics.

We assume the **Blender default export workflow**: `Metric / unit-scale 0.001 / length mm`. Raw values in the file are interpreted as **millimetres of whatever-size the model was authored at**. STL and OBJ have no unit metadata; the same assumption applies.

Four numbers drive the math:

| Symbol | Where | Default |
|---|---|---|
| `sourceUnit` | per-asset (AssetEntry) | `'millimeters'` |
| `modelRatio` | per-asset (AssetEntry), read from glTF `extras.ratio` | `1` |
| `workingRatio` | scene (`state.print.workingRatio`) | `1` |
| `targetRatio`  | scene (`state.print.targetRatio`)  | `1` |

Runtime code exposes these with clearer architecture names in
`src/core/scale/ScaleMath.js`: `sourceUnit` + `modelRatio` form
**Imported scale**, `workingRatio` is **Scene Scale**, and `targetRatio` is
**Print Scale**. The persisted `.mixo` schema keeps the v3.1 names until a
deliberate schema migration is introduced.

**On import**, the loader scales every parent-less node (and its position) by:

```js
importFactor = SOURCE_UNIT_FACTORS[sourceUnit] * (modelRatio / workingRatio);
// SOURCE_UNIT_FACTORS: meters=1, centimeters=0.01, millimeters=0.001, inches=0.0254, feet=0.3048
```

The implementation name for this formula is
`computeSceneNormalizationScale(authoredScale, sceneScale)`.

After scaling, **1 BU in the scene == 1 m at the working ratio's print size**. The drop offset is added on top of the scaled position so the world-space anchor lands where the user dropped it.

> ### Implementation note — vertex baking
> `importFactor` is **baked into the vertex data** with `mesh.bakeTransformIntoVertices(Matrix.Scaling(importFactor))`, *not* stored in `mesh.scaling`. Every node ends with `scaling = (1, 1, 1)` so the Properties panel reads scale `1` after import (matching the user's mental model: "1 mm in Blender is scale 1 here").
>
> **This is a Babylon-software-compatibility concern, not part of the workingRatio / targetRatio / modelRatio scale math.** The ratio math (above) decides *how big* the model is in BU. The bake decides *where that size lives* — on the vertices or on the transform. We chose vertices because:
> 1. Reads naturally in the UI (scale = 1, not 0.001).
> 2. Babylon's HighlightLayer stencil + gizmo passes lose precision when world transforms operate at sub-mm scale, manifesting as halo bleed onto mesh faces. Normalising scale to 1 fixes it.
>
> Source-unit changes (Properties Panel) re-bake the **delta** (`newFactor / oldFactor`) into vertices; non-root local positions are scaled by the same delta so within-asset spacing follows. The world drop anchor (root node position) is left alone so the asset doesn't jump when the user corrects a unit.
>
> **Babylon instance materialization.** Before building the geometry list,
> `bakeImportTransform` must replace any geometry-bearing `InstancedMesh`
> (or equivalent node with `sourceMesh` but no `bakeTransformIntoVertices`)
> with a real `Mesh` cloned from its `sourceMesh`, copying the instance's local
> transform/visibility/metadata/material, calling `makeGeometryUnique()`, and
> disposing the instance. This keeps GLB files that reuse mesh data importable
> while preserving the downstream invariant that every SceneObject owns bakeable
> vertex data for source-unit changes, ratio changes, validation, and 3MF/OBJ/STL
> export. If a geometry node still cannot be materialized into a bakeable mesh,
> import fails with a clear unsupported-geometry error instead of a raw Babylon
> method error.

```js
function applyImportScaling(container, factor, dropPos) {
  materializeInstancedGeometry(container);
  const scaleMat = BABYLON.Matrix.Scaling(factor, factor, factor);
  for (const m of container.meshes) {
    if (m.geometry) m.bakeTransformIntoVertices(scaleMat);
  }
  for (const n of [...container.meshes, ...container.transformNodes]) {
    n.position.scaleInPlace(factor);
  }
  const roots = [...container.meshes, ...container.transformNodes].filter(n => !n.parent);
  if (dropPos) for (const r of roots) r.position.addInPlace(dropPos);
  for (const m of container.meshes) m.refreshBoundingInfo?.();
}
```

**Blender custom property convention.** In Blender, add a custom property on the object or the scene named `ratio`, type String, value `"1/72"` (or `"1:72"`, or `"72"`). The glTF exporter emits this to the node `extras` bag, which Babylon's loader exposes at `mesh.metadata.gltf.extras`. Without the property, `modelRatio` defaults to `1` (i.e. authored at 1:1, full real-world size).

**GLB library convention.** To make a GLB behave as a reusable object pack
instead of an immediate scene import, add one Blender Empty/object as the
library container, set custom property `library` to `1`, and export with custom
properties enabled. Collections may still organize the file, but collection
names/properties are not part of the import contract. The marker is object-level
only; Scene custom properties are not used for library mode because they do not
define an object boundary and may be omitted from selected-object export flows.
Each direct child object below the marked container that contains geometry
becomes a separate Asset Panel entry (`libraryItem.rootName/rootPath`). Geometry
outside the marked container is ignored for library splitting. Nothing is added
to the viewport until the user double-clicks or drags one of those child assets.
If the marker exists but no usable object roots can be resolved, import falls
back to the normal GLB scene path.

**External (non-Blender) glTF files** that follow the spec's meters convention will import 1000× too small at the mm default. The user can then override `sourceUnit` to `'meters'` in the Properties Panel (Phase 3), and the loader re-applies the scaling.

Export-time rescaling from `workingRatio` to `targetRatio` happens in `PrintManager` — see §12.

### Thumbnail Generation
**Off-screen captures are serialised (`src/core/render/RenderLock.js`,
2026-09-18).** Babylon's `CreateScreenshotUsingRenderTarget` and
`FrameCapture.renderSceneToTarget` both temporarily override
`engine.getRenderWidth/Height` and restore the PREVIOUS function when
done. Two captures in flight nest the overrides: A saves the real function,
B saves A's override, A restores the real one, B "restores" A's override —
and the engine reports A's capture size forever. Seen live: two files
dropped together queued two 128×128 thumbnails and the whole viewport
rendered into a 128×128 corner of the canvas until reload. Every capture
(asset thumbnails, `capturePng`, `captureFrameRGBA`, the turntable
recording, the save-time recent-projects thumbnail via `capturePng`) runs
through `withRenderLock(fn)` — one promise chain, errors never break it.
Any NEW off-screen render must go through the same lock.
```js
import * as BABYLON from 'babylonjs';

async function generateThumbnail(meshes, size = 128) {
  const engine = SceneManager.getEngine();
  const tmpScene = new BABYLON.Scene(engine);
  // Clone meshes into tmpScene, frame camera, render to RT
  // Use BABYLON.Tools.CreateScreenshotUsingRenderTargetAsync
  const dataUrl = await BABYLON.Tools.CreateScreenshotUsingRenderTargetAsync(
    engine, tmpCamera, { width: size, height: size }
  );
  tmpScene.dispose();
  return dataUrl;
}
```
Run inside `requestIdleCallback` to avoid jank.

### Capability-tiered Directory Mount
```js
async function mountDirectory() {
  const mounted = await storage.mountDirectory(); // {ref,name}; ref is opaque
  const key = `dir_${mounted.name}_${Date.now()}`;
  if (storage.kind === 'browser') await putHandle(key, mounted.ref);
  return { ref: mounted.ref, key, name: mounted.name };
}
```
Browser refs are `FileSystemDirectoryHandle`s kept private to the adapter boundary. On project load, retrieve the handle via `getHandle(key)` and call `requestPermission({ mode: 'read' })`; denial shows a non-blocking re-grant banner and ghost objects remain until resolved. Desktop refs are random main-process registry tokens (`mount_*` / `ref_*`), never absolute paths, and are session-scoped: a new desktop session asks the user to mount again. `listDirectory(ref, displayParent)` returns normalized `{name,path,kind,ref}` entries; `path` is display-relative only. `readFile(ref)` is the only renderer read operation. Invented or stale tokens are rejected by the main process.

### Imported vs User-Loaded Textures (Phase 4)
glTF-embedded textures register via `registerImportedTexture(babylonTexture)`. Babylon's glTF loader does not populate `texture.url` with a usable path for embedded images — it sets bookkeeping names like `"data:tex_1"`. Thumbnails must be generated asynchronously via GPU readback:

```js
async function readTextureToDataUrl(texture, targetSize = 128) {
  // 1. Wait for texture.isReady()
  // 2. texture.readPixels() → Uint8Array
  // 3. Normalize to RGBA if needed (handle RGB, Float32, etc.)
  // 4. Put to canvas, downscale to 128×128
  // 5. Y-flip (glTF uses invertY=false; readback is GL bottom-up)
  // 6. Return canvas.toDataURL('image/png')
}
```

Asset entries tagged with `kind: 'texture'` and `isImported: true` prevent `releaseAsset` from disposing the texture — lifetime is owned by the source `AssetContainer` or session.

User-loaded textures (via drag/drop or load-from-file) use blob URLs directly; no readback needed.

### Session Re-instantiation
`instantiateAsset(assetId, position)` re-loads the asset from the cached blob URL (stored in a module-local `Map<assetId, objectURL>` set on first load). Each call goes through the full load path — fresh `AssetContainer`, new mesh registration, independent SceneObject entries — so re-dragged copies appear as separate items in the Outliner and are independently selectable. For `AssetEntry.libraryItem`, the reloaded GLB is filtered to that one root object before material registration and scene insertion.

Session assets dragged from the Asset Panel carry `mountKey === '__session__'`; `ViewportDrop` detects this and calls `instantiateAsset(path, position)` rather than attempting to retrieve a `FileSystemFileHandle` (which session assets don't have).

### Loose OS Drag-Drop: File-Handle Capture
When the user drops a file from the OS file explorer (not from the Asset
Panel), `ViewportDrop` must capture the file handle **synchronously inside the
drop event** — `DataTransferItem.getAsFileSystemHandle()` is only valid in
that frame. The handler:
1. Walks `dt.items`, snapshots `{ file, handleP }` where `handleP =
   it.getAsFileSystemHandle().catch(() => null)`.
2. Falls back to `dt.files` (and `handleP = Promise.resolve(null)`) when
   `items` is unavailable.
3. Inside `safeAsync`, awaits `handleP`; if it resolved to a `kind === 'file'`
   handle, passes `{ fileHandle: h }` into `AssetLoader.loadFromBlob`.

`AssetLoader.loadFromBlob` then persists the handle into IndexedDB under
`fh_<assetId>` and writes that key to the AssetEntry as `fileHandleKey` — the
key is only set when `fileHandle` was passed AND `directoryHandleKey` was not
(an under-mount drop already has dir-level relink, so the per-file handle would
be redundant). This makes loose-dropped files **Linked, not Snapshot**, and
they relink across reloads via resolution tier 3 (see §11 Asset Resolution
Priority). Browsers without `getAsFileSystemHandle` (none of our supported
ones, but the API is recent) fall through to the embedded snapshot path —
no regression.

### Memory Rules
- `releaseAsset(assetId)`: only dispose container if `linkedMeshIds.length === 0`. Skip disposal if `isImported: true`.
- Track blob URLs in `Map<assetId, blobUrl>` for explicit revocation.
- On `PROJECT_NEW` / `PROJECT_LOADED`: revoke all blob URLs, dispose all containers, clear map.

---

## PART 9 — MESH VALIDATOR

**File: `src/core/MeshValidator.js`**

### Scope (v1 + watertight-repair-and-cost)
Topology is pure JS (no WASM) EXCEPT the `holes` check's Repair, which
diagnoses/repairs through the vendored MeshFixLib WASM engine (§ *Watertight
repair* below).

| Check | Severity | Method | Repair |
|---|---|---|---|
| Non-manifold edges | **warning** (Phase 6) | Edge-face count map over **position-welded** indices (Phase 6 — raw indices false-flag unwelded imports); flag edges with count ≠ 2 | MeshFixLib `repairMesh`; offline → the shared `repair/Weld.js` weld. `autoFixAvailable` is gated on `REPAIR_TRIANGLE_CAP` (2026-09-18, review I3 — a button whose only outcome is "too large to repair" is not a fix), and the message then says so (review CIA F6) |
| Inverted normals | **warning** (Phase 6) | **Signed mesh volume** (one O(tris) pass; V<0 ⇒ inward winding) — replaced the old 64-ray heuristic (O(tris) PER ray) 2026-06-13 | Flip winding |
| Open boundary edges (`holes`) | **warning** | MeshFixLib `diagnose()` boundary-edge count — **emitted ONLY when the engine actually answered** (2026-09-18, review I4). There is no fallback: the validator's own `badEdgeCount` is boundary edges PLUS non-manifold edges, so using it here reported the very same edges twice, once as `nonManifold` and once as `holes`. Offline (or above the cap), only `nonManifold` speaks. | MeshFixLib `repairMesh` — hole fill; no engine-free equivalent (a weld cannot close a hole). `autoFixAvailable` requires an engine answer AND `triangles ≤ REPAIR_TRIANGLE_CAP`; a GROUP-scope result never offers it (the fix applies per part, not to the synthetic union) and says "repair each part" instead of promising a button that is not there (review CIA F6) |

> **Topology runs in a Web Worker (perf goal 2026-06-13).** The non-manifold
> + inverted-winding pass is the heavy part on dense print meshes (80k+ tris
> ≈ 450 ms of weld + edge-map on the main thread — a felt freeze when several
> heavy models import). `MeshValidator._topology` posts a COPY of
> positions/indices to `workers/MeshValidate.worker.js` (via `ValidateWorker.js`,
> transferables) and awaits the counts; the UI thread never blocks (measured
> ~12 ms wall, warm worker). The worker uses NUMERIC packed keys for the weld
> + edge maps (no per-vertex/edge string allocation) and signed-volume
> inverted-normals (no rays/octree). Inline pure-JS fallback runs when Worker
> is unavailable (Node tests). Group-union topology (split shells) is built on
> the main thread then posted the same way. Build-volume checks belong to the
> per-export-ratio `PrintReadiness` projection, not this mesh cache.

> **Phase 6 severity change.** Non-manifold + inverted-normals were `error`
> (hard-blocked export). A colour-print *assembly* tool works with downloaded
> display models that are routinely non-watertight, and slicers
> (Bambu / Lychee / Cura) auto-repair these — so they are now non-blocking
> warnings, still surfaced. The non-manifold check also welds by position
> first; without that, unwelded glTF/STL imports (per-triangle vertex copies)
> report nearly every edge as non-manifold even when perfectly closed.

Deferred to future versions: thin-wall heatmap, self-intersection, overhang analysis.

### Public API
```js
MeshValidator.validateMesh(babylonMesh)            → Promise<ValidationResult[]>
MeshValidator.autoFix(mesh, results, report?)      → Promise<ValidationResult[]>  // `report` collects the ENGINE's counters (review M2)
MeshValidator.hasErrors(results)                   → boolean
MeshValidator.hasWarnings(results)                 → boolean
MeshValidator.validateAllPrintParts()              → Promise<Map<meshId, ValidationResult[]>>
MeshValidator.validateGroup(logicalObjectId)        → Promise<ValidationResult[]>  // welded union of that logical object's parts (validateMesh uses the same routine)
MeshValidator.repairObject(meshId)                 → Promise<{holesFilled, nmFixed, applied, remaining}>  // ONE-CLICK repair; walks EVERY part of a multi-part object
MeshValidator.repairObjects(meshIds, {onProgress}) → Promise<{holesFilled, nmFixed, repaired, failed}>      // sequential batch; one failure never loses the rest
MeshValidator.applyGeometryFix(mesh, type, report?) → Promise<boolean>  // 'holes'/'nonManifold' → MeshFixLib.repairMesh; nonManifold falls back to the shared weld offline
MeshValidator.replayGeometryFixes(mesh, fixes)     → Promise<void>      // re-applies persisted `geometryFixes` on `.mixo` reload
                                                                        // a replay that throws is fault-isolated: original geometry stays, that object's
                                                                        // geometryFixes are DROPPED from loaded state + a warning toast names it (task 0.5)
```

**Implementation split (2026-09-18, review I9).** Everything above the line
`repairObject` downwards lives in `src/core/repair/RepairSession.js` and is
re-exported from `MeshValidator.js`: the validator decides what is wrong, the
session carries out repairs. Callers and tests keep using the
`MeshValidator.*` names.

**`applied` / `repaired` are the honesty signal (review I7b/I7c).**
`repairObject` returns `applied: string[]` (the fix types that actually
changed geometry) and `repairObjects` returns `repaired: number` (objects
changed). Empty/zero means **nothing to repair** — never success.
`src/ui/RepairFeedback.js` is the ONE place that maps a result to a toast
(info "nothing to repair" / warning "still not watertight" when `remaining`
is still open / success with the engine's own counters), and a batch with
`failed.length` reports the failures INSTEAD of a success toast. Every repair
surface routes through it.

**`holesFilled` / `nmFixed` are the ENGINE's counters (review M2).** They
come from MeshFixLib's own report, threaded through the optional `report`
argument of `applyGeometryFix`/`autoFix`. They used to be the validation
result's boundary-edge COUNT, which is a different number entirely (the
live-verified open tetra reports `holesFilled: 1` — one hole — where the
old code said `3`, its three boundary edges).

**Multi-part objects (review I7a).** A logical object with more than one live
part (MultiMaterial split, glTF multi-primitive) validates as the welded
UNION, and group-scope results carry `autoFixAvailable: false` because no fix
can be applied to synthetic geometry — so the old validate→autoFix route left
these objects permanently unrepairable. `repairObject` now diagnoses and
repairs each sibling directly, skipping the healthy ones, and records
`geometryFixes` per part.

`repairObject` is the ONE shared entry point behind every repair surface in
the app — the import toast's fix action, the Outliner row badge, the
viewport context menu's "Repair geometry" (`repairObjects` for a multi-
selection), and the Print panel's "Repair all" button — so an applied fix is
recorded identically (`geometryFixes` on the object, `markDirty()`, then
persisted through `.mixo` and replayed on reload) no matter which surface
triggered it.

### Logical-object-aware topology checks

A multi-shader object makes individual parts non-watertight by construction —
a 6-face cube with 3 shaders becomes 3 meshes of 2 faces each, each with
boundary edges by definition, whether the parts came from a MultiMaterial split
OR a glTF multi-primitive mesh (§8 *Load Flow* — both share a `logicalObjectId`).
Per-part topology checks lose all signal in this case.

**Rule:** `validateMesh` computes `logicalObjectPartIds(meshId)`. When >1 live
part, topology (`nonManifold`) runs on the **welded union of those parts**, not
the individual mesh:

1. Collect the logical object's live, non-ghost parts.
2. Concatenate their world position arrays; index buffers shift by the running
   vertex offset so concatenated indices stay valid.
3. Weld concatenated positions by distance (the §9 non-manifold weld) — parts
   share coplanar seams, so welding stitches them into one watertight surface.
   **No data copied back into Babylon meshes**; the welded buffers live only in
   the validator.
4. Run topology on the welded union. The `scope:'group'` result attaches to
   **every** part's `ValidationResult[]` so the Outliner shows it on any row.

This is why a multi-shader model now reports the *object's* true watertightness
(and stops crying false non-manifold at every material seam). Single-part
objects validate directly. **Separate objects are never welded together** — only
parts that share a `logicalObjectId` (split group or glTF primitive set).

**Export collection checks** reject zero-vertex and missing live registry
meshes. `PrintReadiness` separately reports missing sources/textures and
per-target build-volume fit; these are export-context concerns, not topology.

**Pre-export gate** (§9 *Pre-Export Gate*) iterates print parts, but
deduplicates by `canonicalObjectId` (results keyed by the lead) so each logical object runs once even if it has 12
siblings. Block / confirm-anyway semantics unchanged.

### ValidationResult
```js
{
  type: 'nonManifold'|'invertedNormals'|'holes'|'exceedsBed',
  severity: 'error'|'warning'|'info',
  count: number,
  autoFixAvailable: boolean,
  fixed: false,
  message: string,
}
```

### Import-time UX
- Validation runs async after mesh becomes visible.
- Toast progression:
  - `loading` "Validating [name]…"
  - `success` "✓ [name]" (auto-dismiss 3s) — if clean
  - `warning` "⚠ [name]: 2 warnings" (persistent; click → Print Panel Validation tab)
  - `error` "✗ [name]: 3 errors" (persistent; click → Print Panel Validation tab)
- Click-through wiring (B5): the toast's `onClick` dispatches
  `EVENTS.VALIDATION_FOCUS_REQUESTED` (event, not import — avoids a
  core→ui→core cycle); PrintPanel handles it by switching to the Print
  workspace, clearing a manual right-panel collapse, expanding the section,
  and activating the Validation tab.
- Outliner row icon updates correspondingly.
- **DO NOT** open a modal on import.

### Validation result cache (A6)
Results are cached in `state.scene.validation` —
`Record<meshId, { results, validatedAt, stale }>` — written by
`validateMesh` for the LIVE registered mesh only (export clones carry the
source meshId in metadata and must not pollute the cache). Group-scoped
topology results attach to every split sibling. Invalidation:
`TRANSFORM_COMMITTED` / `OBJECT_UPDATED` → stale (results kept for greyed
display), `OBJECT_REMOVED` → dropped, `PROJECT_NEW/LOADED` → cleared, bed
dims / targetRatio changes → `MeshValidator.invalidateAll()`. Never
persisted — derived per session. Wire `MeshValidator.init()` at boot.
Consumers: PrintPanel Validation tab (cache + "Validate All" button — no
re-validation per render), Outliner row status badges, export warning gate.

### Pre-Export Gate (three-way, watertight-repair-and-cost task 4)
Readiness is traffic-lighted, and export never silently degrades geometry:

| State | Trigger | Behaviour |
|---|---|---|
| 🟢 **Green** | No cached errors or warnings on any print part | Export proceeds immediately. |
| 🟡 **Amber** | Cached non-stale **warnings** only (`nonManifold` / `invertedNormals` / `holes`) | `exportGate` modal (`PrintPanel._renderExportGateModal`). **Three buttons only when something is actually fixable** (2026-09-18, review I12): **Fix & Export** appears iff `exportGateCanAutoFix(issues)` — at least one `geometry-warning` object whose cached results carry an unapplied `autoFixAvailable` — then **Export Anyway** (unchanged geometry: display models are routinely non-watertight and slicers auto-repair) and **Cancel**. Otherwise it is a TWO-way Export Anyway / Cancel with `print.exportGate.bodyNoFix` copy, because the old unconditional button ran a repair batch that provably could not change anything (a group-scope `holes` result, an over-cap mesh, a bed-overflow warning) and then exported — which reads as "we fixed it". ESC/backdrop = Cancel. The markup comes from the pure `exportGateHtml(issues, canAutoFix)` so the button set, order and resolved actions are covered headlessly by `tests/export-gate.test.mjs` (review CIA F7). |
| 🔴 **Red** | Hard **errors** caught inside `PrintPipeline._runExport` (post auto-fix) | Blocks with the error-list modal — no export. |

`print.strictExport` (Print panel checkbox, persisted via SettingsStore)
changes what counts as a hard stop: when **on**, a print-clone that a repair
attempt CONFIRMED still not-watertight (`repairReport[].isWatertight ===
false`) throws and blocks the export, naming the parts — never on an
*unknown* result (repair engine unavailable, or the clone was above
`REPAIR_TRIANGLE_CAP`), which is a repair-engine problem, not a geometry one
(that case still surfaces via `toast.exportedWithWarnings`). When **off**
(default), a confirmed-still-open export clone still exports, with the same
warning toast. Every export clone is repaired on the fly regardless of this
setting (§12 *Export Gate repairs clones*) — `strictExport` only decides
whether a confirmed failure blocks or just warns.

### Watertight repair (MeshFixLib)

**Engine:** [MeshFixLib](https://github.com/hololocheck/MeshFixLib) (MIT
licence — the repo name was wrong here until 2026-09-18, review M11; exact
provenance, including the upstream commit SHA and the `manifold-3d@3.4.0`
version, is recorded in `public/vendor/NOTICE.md` and asserted by
`tests/hygiene.test.mjs`), a WASM mesh-repair library, vendored under
`public/vendor/meshfix/` (`mesh-fix-core.js/.wasm` + `mesh-fix-lib.js`) —
reused rather than reinvented (task spec: "reuse not reinvent"). The files
are classic UMD/global-assignment scripts, **not ES modules** (neither has
an `export` statement), so `src/core/repair/MeshRepair.js` loads them by
injecting `<script>` tags rather than dynamic `import()`. No runtime CDN
fetch anywhere in the repair path.

**Offline CSG (related, same task set):** the local
[Manifold](https://github.com/elalish/manifold) build (Apache-2.0) under
`public/vendor/manifold-3d/` (`manifold.js` + `manifold.wasm`) is passed to
Babylon's `InitializeCSG2Async({ manifoldUrl })` by both `BooleanService.js`
(interactive Boolean) and `PrintPipeline.js` (CSG re-bake on export) — CSG2
now works with no network access, matching the repair engine's offline
posture.

**URL resolution (works under `npm run dev`, GitHub Pages, AND Electron
`file://dist/index.html`):** both loaders resolve their vendor path with
`new URL(relativePath, document.baseURI).href` rather than an absolute
`/vendor/...` URL or Vite's `import.meta.env.BASE_URL` — `vite.config.ts`'s
`base: './'` already makes every other asset URL page-relative, and this
keeps the two WASM loaders consistent with that. Live-verified 2026-09-18: a
headless-Electron probe loaded `dist/index.html` over `file://` and fetched
all five vendor files (`mesh-fix-core.js`, `mesh-fix-core.wasm`,
`mesh-fix-lib.js`, `manifold.js`, `manifold.wasm`) through this exact
resolution — every one returned `ok:true, status:200` — and `npm run
test:electron` (which boots the built app the same way) passes.

**`repairMesh(mesh)` pipeline (`MeshRepair.js`):** merge → degenerate
removal → winding fix → duplicate removal → normal recompute →
non-manifold edge/vertex fix → hole fill. Runs on the main thread inside
the `ProgressOverlay` (capped so a tab cannot be blown — see
`REPAIR_TRIANGLE_CAP` below). `changed` is derived by comparing the
engine's output positions/indices to the input (tolerance `1e-9` on
positions, exact on indices) — **not** from the report's counter fields
(`holesFilled`/`nmFixed`/…), because a winding-only or self-intersection
repair can return a different mesh while every counter stays zero; gating
the write-back on counter names would silently discard that output.

**Engine options (2026-09-18, review M7):** the engine's own static
`defaultOptions()` is spread FIRST, then our two overrides
(`removeSmallShells: false`, `repairSelfIntersections: false`), then the
caller's `opts.engine` — so an upstream default this project never names
still reaches the WASM call.

**Winding is CONFORMED to the side flag, never re-tagged (2026-09-18,
corrects review I1).** Measured, not assumed: MeshFixLib normalises its
output to a POSITIVE right-handed signed volume whatever the input winding
was (it flipped every face of a negative-wound tetra and kept every face of
a positive one). Babylon is left-handed, so an outward CounterClockWise mesh
has a NEGATIVE signed volume (`PrintSpace.frontFaceIsClockwise`) — the
engine's native output is outward only under a ClockWise flag. The earlier
rule ("completed repair ⇒ re-tag ClockWise clones CounterClockWise, leave
CounterClockWise alone") therefore shipped BOTH kinds inside-out: the live
repaired tetra rendered back-face and the validator flagged "inverted
normals" right after a "successful" repair. `MeshRepair._conformWinding`
now leaves `mesh.sideOrientation` exactly as it was (other code keys on it:
the cross-section cap, `PrintSpace.printIndices`) and REVERSES THE INDICES
when the written-back geometry's signed-volume sign disagrees with that
flag (`createNormals` re-run after). A zero signed volume (sheet /
degenerate) is no evidence and leaves the geometry untouched. Applies to
partial repairs by the same rule (the engine orients globally either way).
Pinned by `tests/mesh-repair.test.mjs` "I1" cases + the live
`npm run test:repair` (validator reports no `invertedNormals` after repair,
print-space volume positive).

**Multi-part objects are repaired as ONE solid (`src/core/repair/GroupRepair.js`,
2026-09-18).** A glTF multi-primitive / MultiMaterial-split import is one
surface cut into parts along material seams; every part is open along those
seams by construction. The previous rule ("group-scoped validation reports
the welded union; repair each part") capped every seam: a perfectly closed
cube split into two materials came back as 12 + 4 triangles with an internal
wall, and the export pipeline's per-clone `repair` step did the same to the
shipped file — this is what the owner saw as "still not watertight after the
fix" on a scanned bowl. `repairGroup(parts)` welds the parts into one union
(lead-local space via `toLead` = W_part · W_lead⁻¹, identity for glTF
primitives; export clones are already in one space), diagnoses it
(closed + manifold ⇒ untouched), runs the engine once, decides the WINDING
ONCE on the whole union (a part's partial signed volume has an arbitrary
sign — conforming per part re-wound seams inconsistently), then hands every
output triangle back to its part: original triangles by corner-key match
(any rotation / winding, union indices), fill triangles to the majority
owner of their corners (nearest original vertex for new ones). Each part is
rewritten through `arraysToMesh` with ITS OWN UVs; materials never mix. A
part that would end up empty aborts the whole repair before anything is
written. Recorded as the `groupRepair` fix type on every part; `ProjectLoader`
replays it ONCE per logical object after every part is bound (per-mesh
replay skips it; `record:false` keeps a load clean). Live path:
`RepairSession.repairObject` → `_repairGroupParts`; export path:
`PrintPipeline._tryRepairGroup` — the per-clone prep loop is split around
the `repair` step (pre-steps per clone → repair per UNIT → post-steps per
clone; the per-clone `csg`/`csgSolidOnly` post-steps are SKIPPED for a
multi-part unit — its parts are open patches by design and Manifold would
reject them, landing every part in csgSkipped with a spurious "not
watertight" toast). `MeshValidator._validateUnion` (shared by `validateGroup` and the
`validateMesh` logical-object branch — they used to be two copies) WELDS the
union (`Weld.weldArrays`) before the engine diagnose: unwelded, every seam
counted as a hole (a closed split cube reported 16). Group results now carry
`autoFixAvailable` (engine answered + union under the cap) and the Print
panel / Repair all / status-bar Fix route them through `repairObjects`.
Proof: `npm run test:group` (real Chrome: closed split cube validates clean,
open split cube → 7 + 5 = 12 triangles, exported 3MF watertight, +1000 mm³).

**Real-scan hardening (12 photogrammetry scans, 2026-09-18 —
`node tests/scan-probe.mjs [dir]` runs import → validate → repair →
re-validate → 3MF → manifold/volume check per file and prints one row each;
`PROBE_ONLY`, `PROBE_DIAG=1`, `PROBE_SHOT=<dir>`, `PROBE_ENGINE_OPTS`,
`PROBE_PASSES` steer it; the scans live outside git under
`tests/fixtures/real-scans/`).** Every one of these was measured, not
guessed:
- **Write-back carries every vertex attribute.** Scans carry normals (often
  tangents, uv2, colour); the fixtures carried none, so `arraysToMesh` left
  `normal` at the OLD vertex count and Babylon threw "Invalid typed array
  length" on the first render/export. uv / uv2 / colour follow the same
  original-vertex mapping; normals are recomputed; tangents dropped.
- **Ownership by nearest original centroid** (grid-hashed) for triangles
  the engine re-cut — "first part that touched the vertex" starved a small
  part of every triangle and the repair aborted.
- **Repair runs PER CONNECTED COMPONENT** (`repairArraysByComponent`,
  position-welded connectivity so a UV seam does not split a shell): handed a
  multi-shell mesh the WASM core discards shells whatever the options say (a
  54-shell union came back as its largest shell, 17,252 → 6,426 triangles).
  Per shell the engine has nothing to choose between; a shell it returns
  empty keeps its original triangles.
- **Fresh WASM instance per repair call** (`createRepairEngine`): cheap, and
  removes the engine's own cross-call state from the equation.
- **Leftover boundary loops are capped** (`CapLoops.capBoundaryLoops`, fan
  from the loop centroid, winding from the owning triangle, position-welded
  topology): what the engine declined were the unscanned undersides / rims
  (300–750-edge loops) and stray 3-edge holes, whatever `holeAreaMultiplier`
  / `oversizeMultiplier` said. The cap is what a slicer would otherwise guess
  at; its texture is nearest-vertex smear on a face that sits on the bed.
- **Automatic second pass** in `repairObject` when pass 1 changed geometry
  but left open / non-manifold edges (the engine converges in two passes on
  scans; a cap gives it something to weld).
- **Geometry is read at REST transform** (`ImportBounce.withRestTransform`)
  in the validator's union, the repair's part→lead matrices, and the cost
  quote's volumes; the export pipeline settles the pop outright. The 260 ms
  bounce-in animates `mesh.scaling`, sibling parts start their pops at
  different instants, and every reader inside that window (import
  auto-validate, my smokes) saw parts at DIFFERENT scales: hundreds of bogus
  holes on every multi-part import, and a repair whose union had one part
  shrunk by 2.3 %. Settling on every read would cut the animation short
  (the Print panel re-renders on import), hence read-at-rest.
- **One import validation flow per logical object** (`queueValidation` skips
  material parts): toasting / auto-repairing each primitive duplicated every
  message and ran the group repair once per part.
Result on the 12 scans: 9 fully watertight (holes 4,619 → 0 on the worst),
3 with 1–3 non-manifold edges and no holes; volumes positive; exports
manifold except those edges; textures intact along atlas seams (eyeballed
from above and below). Remaining non-manifold edges are reported honestly
("slicer-repairable") and never block export.

**Engine output is validated before ANYTHING reads it (review CIA F2):**
every coordinate finite, every index an integer in `[0, V.length)`, else
`throw new Error('engine returned malformed geometry: …')` and the mesh is
left untouched. Checking only at write-back time was not enough — a NaN
compares "equal" to everything, so the `changed` comparison silently
DISCARDED malformed output instead of reporting it.

**`REPAIR_TIMEOUT_MS = 60_000` (review CIA F4):** one `repairMesh` call is
wall-clock bounded (`opts.timeoutMs` overrides). The vendored
`repairObject` accepts an `{ signal }` extra and checks it around the WASM
call, so the abort actually shortens the run where the engine can honour it;
a `Promise.race` releases the caller either way with a `/timed out/`
rejection that the existing `reportError` / `_tryRepair` paths surface with
the mesh name. A cancel BUTTON is still deferred.

**UV preservation — corner-accurate (rewritten 2026-09-18, review C1).**
MeshFixLib re-indexes the mesh AND (stage 1) merges duplicate positions,
which is exactly what a UV seam is made of: two vertices at one position
carrying different UVs. Re-attaching UVs by POSITION alone therefore
collapsed both sides of every seam onto one UV and smeared the texture across
the part. Two fixes, both required:

1. **A healthy clone is never repaired at all.** `PrintPipeline._tryRepair`
   diagnoses first and SKIPS the whole step when the engine reports
   `boundaryEdges === 0 && nonManifoldEdges === 0 && isWatertight`, recording
   `{ name, isWatertight: true, skipped: true }` on `ctx.repairReport`. A
   hole-free textured part's geometry is not rewritten, so its UVs cannot be
   damaged for no gain.
2. **A repair that DOES run carries seam UVs through it.**
   `arraysToMesh(mesh, V, T, originalPositions, originalUvs, originalTriangles)`
   matches each OUTPUT triangle back to its original triangle by the position
   keys of its three corners (all 3 rotations and both windings, since the
   engine may re-wind) and gives every corner the UV of its OWN original
   vertex; the output vertex buffer is then rebuilt per corner, de-duplicated
   on `(output vertex, uv)`, which SPLITS a merged seam vertex back apart with
   both UVs intact. Corners with no matching original triangle — the new
   hole-fill triangles — keep the nearest-original-vertex UV (a smear inside
   the former hole is acceptable; a lost texture on the rest of the part is
   not).

The same rule governs the export `weld` prep step: `repair/Weld.js` merges
only vertices sharing BOTH position and UV (review I6), which is what makes
it safe to run unconditionally on the textured OBJ/STL paths. This costs
nothing in topology terms — the non-manifold check already counts edges over
a POSITION-welded index map, so a seam duplicate was never a reported defect.

**Verified end-to-end** in real Chrome by `npm run test:export`: the textured
quad's `(position → uv)` pairing is compared between the live mesh and the
exported 3MF's `<vertex>` / `<m:tex2coord>` lists (centroid-relative in
print-space mm, so `optimizeIndices`' legitimate vertex reordering and the
export translation do not matter), and the live mesh's UV buffer is asserted
untouched. Headlessly, `tests/mesh-repair.test.mjs` pins both the
merging-repair and the hole-filling-repair cases on a seamed textured quad.

**`REPAIR_TRIANGLE_CAP = 300_000`** (`MeshRepair.js`) — BOTH `repairMesh`
and `diagnoseMesh` reject above it rather than let the browser tab lock up.
`diagnoseMesh` was uncapped until 2026-09-18 (review I2) even though it is a
synchronous WASM call on the main thread that ran on EVERY validation pass;
its rejection message says `too large to diagnose` so callers can tell
"cannot answer" from "answered: broken", and `repair/Diagnose.js` treats it
exactly like an unavailable engine. Both messages name the cap that was
actually APPLIED (`opts.triangleCap`), not the module default (review M8).
Off-thread diagnose/repair stays DEFERRED: the vendored engine is a classic
script that registers a window global and fetches its own `.wasm` relative to
itself, so it cannot be imported into a module Worker as-is.

`PrintCost` no longer shares this constant: the cost gate is a
UI-responsiveness limit (the quote recomputes on every keystroke), not a
repair-engine limit, so it has its own `costTriangleCap()` tracking
`caps.triangleBudget` (review M9, §12 Cost quote).

**Entry points (all route through `MeshValidator.repairObject` /
`repairObjects` — §9 Public API):**
1. Import-time toast — a warning toast with an auto-fixable result IS the
   fix action (click repairs); see §9 *Import-time UX*.
2. Outliner row badge — click to repair that object.
3. Viewport context menu — "Repair geometry" on the current selection
   (`repairObjects`, tolerant of a per-object failure).
4. Print panel — "Repair all" button over every print part.
5. Export Gate's "Fix & Export" button (§9 *Pre-Export Gate* above) —
   repairs only the objects the readiness check flagged, then exports.
6. **Export clones, always** (§12 *Export Gate repairs clones*) — every
   export clone is repaired on the fly regardless of any setting; this is
   what `ctx.repairReport` / `ctx.repairSkipped` / `strictExport` gate on.
7. `print.repairOnImport` (Print panel checkbox, opt-in, default OFF) —
   skips the click-to-fix toast and repairs automatically on import. It is a
   per-USER preference (SettingsStore / localStorage) and is deliberately
   EXCLUDED from the `.mixo` document and from the load merge (2026-09-18,
   review I8): `print` is merged wholesale on open, so a document carrying
   this field used to flip the opener's own setting, "file wins".

**Live verification (2026-09-18, `tests/browser-repair-smoke.mjs` /
`npm run test:repair`):** an OPEN tetrahedron (3 of 4 faces,
`tests/fixtures/open-tetra.glb`, generated by
`tests/fixtures/make-open-tetra.mjs`) imported through the real
`AssetLoader.loadFromBlob` path —
- Validation cache carried a `holes` result before repair.
- `MeshValidator.repairObject(meshId)` → `holesFilled: 1, nmFixed: 0` —
  the ENGINE's own report: ONE hole filled, closing the shell to 4 vertices /
  4 triangles. (Re-measured 2026-09-18 after review M2: this used to read
  `holesFilled: 3, nmFixed: 3`, which was the validation result's
  boundary-edge COUNT re-labelled as a hole count, not anything the engine
  said.)
- Real 3MF export (`PrintManager.exportThreeMF`), unzipped and checked with
  an INDEPENDENT signed-volume implementation in the test script (not
  `PrintSpace.js`'s own): **volume = 1000.0000 mm³ against an expected
  +1000 mm³ — 0.000% error** (right tetrahedron, legs 10/20/30 mm,
  `(1/6)·10·20·30 = 1000`).
- Edge→face map: **6 unique edges, every one used exactly twice** (a closed
  2-manifold; Euler check V−E+F = 4−6+4 = 2 ✓).
- **PrusaSlicer 2.9.3** (`prusa-slicer-console.exe --info`) on the same
  exported file, independently: `manifold = yes`, `number_of_facets = 4`,
  `volume = 1000.000000`.
- HUD (§13 MeshStats) reads `tris 4 / 1.5M` — the budget denominator is the
  web tier's `caps.triangleBudget`.
- Cost block (§12 Cost quote) `#pp-cost-total` read
  `1.00 cm³ · 1.1 g · 0.55 + support 0.09 = 0.64 USD` — a live, non-null
  quote for the now-watertight solid, with no `approximate` badge (the
  `holes` cache entry cleared on re-validate after repair).

**Fix round 1 (2026-09-18, same-day follow-up):** the first pass of this
probe read the HUD as `tris 8 / 1.5M` for this exact 4-triangle solid — a
real defect, not a fixture issue. Root cause: `MeshStats.countSceneTriangles`
(`src/ui/MeshStats.js`) summed every scene mesh carrying a truthy
`mesh.metadata?.meshId`, but `Mesh.clone()` copies the metadata REFERENCE, so
a transient `PrintPipeline` export clone (`${mesh.name}__export`) carries the
SAME source `meshId` while it is briefly alive in the scene during its own
`MeshValidator.validateMesh` pass (which the export pipeline runs on every
clone, and which dispatches `VALIDATION_COMPLETE` — one of `MeshStats`'s
recompute triggers) — so the live mesh's 4 triangles were counted twice.
The live mesh itself was never wrong (`diagnoseMesh` on it confirmed
`isWatertight: true`, `boundaryEdges: 0`, exactly 4 triangles / 4 vertices,
and exactly ONE registered mesh existed for the id) — this was purely a
scene-walk double-count, not a repair or export defect. Fixed by reusing the
exact guard `MeshValidator.js`'s own cache-write path already uses for the
identical hazard (`AssetLoader.getBabylonMesh(meshId) === mesh`, its
`isLive` check): `countSceneTriangles` now only sums a mesh if it IS the
currently-registered live mesh for its id, not merely a mesh that carries
that id. Covered by two new `tests/mesh-stats.test.mjs` cases (a
live-mesh-plus-metadata-sharing-clone scene counts the live mesh's
triangles exactly once; an unregistered `meshId` counts as zero) and by
tightening `tests/browser-repair-smoke.mjs` itself, which now asserts the
HUD's numeric prefix is exactly `4` (not merely `/tris \d/`), the live mesh
has exactly 4 triangles/vertices, exactly one mesh is registered for the
id, and `diagnoseMesh` reports `isWatertight: true` with 0 boundary edges —
all immediately after `repairObject`, independent of export.
`tests/triangle-budget.test.mjs`'s synthetic "pre-existing scene mesh"
helper was updated to register through `AssetLoader.bindRestoredMesh` (it
was constructing a mesh with a `metadata.meshId` but never actually
registering it as live — accidentally relying on the very bug this fix
closes; now it matches how a real print part actually gets into the scene).

---

## PART 10 — SHADER LIBRARY

**File: `src/core/ShaderLibrary.js`**

### Public API
```js
ShaderLibrary.createShader(partial)                    → shaderId
ShaderLibrary.updateShader(shaderId, field, value)
ShaderLibrary.duplicateShader(shaderId)                → newShaderId  (returns id via getNewId())
ShaderLibrary.deleteShader(shaderId)                   // only if linkedMeshIds is empty
ShaderLibrary.assignToMesh(shaderId, meshId)
ShaderLibrary.clearMeshShader(meshId)                  // undo path for prior null assignment
ShaderLibrary.setUVOverride(meshId, uv)               // clones material AND texture
ShaderLibrary.clearUVOverride(meshId)
ShaderLibrary.applySwatchColor(shaderId, hex)
ShaderLibrary.getBabylonMaterial(meshId)               → BABYLON.Material
ShaderLibrary.registerFromContainer(container)         → Promise<shaderId[]>  // async; handles merge modal on collisions
ShaderLibrary.rebuildLinkedIndex()                     // on project load
```

### ShaderEntry
```js
{
  id, name, type,                       // type: 'standard'|'pbr'|'unlit'
  diffuseColor,                         // '#RRGGBB'
  diffuseTextureAssetId,                // texture asset id, or null
  uvBase: { offsetX, offsetY, scaleX, scaleY, rotation },
  opacity, roughness, metallic,
  linkedMeshIds: [],                    // maintained at runtime, rebuilt on load
}
```
`name` for an imported material is `ShaderLibrary._importedMaterialName`:
the file's own material name, except loader-internal tokens — Babylon's
glTF loader names the material it synthesises for material-less primitives
`__GLTFLoader._default` (any `__`-prefixed name) — which become `Default`.
That token used to appear verbatim in the Shader Library (2026-09-18).

**Colour-space contract (2026-09-17).** `diffuseColor` is **always sRGB** —
the hex the user picks/sees and the value every exported file carries
(MTL `Kd`, 3MF `#RRGGBBFF`, solid-PNG synthesis). Babylon binds a PBR
material's `albedoColor` / `baseColor` **raw** to a shader that treats it as
**linear** (the glTF loader stores the linear `baseColorFactor` there
unchanged), so ShaderLibrary converts exactly once at every hex↔PBR seam:
writing a record to a PBR material decodes `srgbToLinear01` per channel;
reading an imported PBR material into a record (`registerFromContainer`)
encodes `linearToSrgb01`; export writers read PBR colour via
`materialSrgbColor()` (`src/core/shaders/ColorSpace.js`, pure — no Babylon
dependency so headless tests match runtime). Standard/unlit `diffuseColor`
is gamma-space by Babylon convention and is copied raw both ways. Never
convert twice: a material that came from glTF is already linear; a record
hex is already sRGB.

### UVOverride (per-mesh, stored in `state.scene.uvOverrides`)
```js
{ meshId, shaderId, offsetX, offsetY, scaleX, scaleY, rotation }
```

### Material Management
- Maintain private `Map<shaderId, BABYLON.StandardMaterial>` (or PBRMaterial).
- On `updateShader`, mutate the Babylon material directly → all linked meshes update.
- On `setUVOverride`, **clone both the material and its texture** (via `material.clone()` + `texture.clone()` on each of `diffuseTexture`, `albedoTexture`, `baseTexture`). Apply UV offset to the cloned material, store in `Map<meshId, BABYLON.Material>`. Assign clone to that mesh only. **Rationale:** Babylon's `material.clone()` copies texture *pointers*, so UV offsets would leak across meshes. Cloning the texture ensures per-mesh overrides are truly independent.
- On `clearUVOverride`, dispose clone + its cloned textures, re-assign shared material.
- Do **not** clone-per-frame. Clone once on override creation.

### Shader Duplication
- New ShaderEntry with copied fields, `linkedMeshIds: []`, new id and auto-incremented name (e.g. `Hull_Metal` → `Hull_Metal.001`).
- Babylon material cloned via `mat.clone(newId)`. Same texture **reference** (not a copy).
- **Make Unique** batches duplication plus assignment of selected linked objects
  into one undo entry; future edits propagate only inside the new sharing set.

### Import Merge Strategy
On material-name collision during `registerFromContainer`:
1. **Auto-dedupe first.** `ShaderSignature` compares every supported appearance
   field exactly: type, diffuse color, opacity, roughness, metallic, UV base,
   and content-addressed texture-view identity. Names, shader ids, and linked
   counts are excluded. Unsupported active features (clear coat, sheen,
   subsurface, anisotropy, iridescence, or unsupported texture slots) make a
   material ineligible rather than silently losing appearance. An eligible
   exact match reuses the existing shaderId, redirects the imported mesh's
   material pointer, disposes the duplicate material, and skips the merge modal.
2. **Texture resource identity is separate from its view.**
   `TextureImageStore` keys canonical encoded bytes by SHA-256, so equal bytes
   share one stored blob regardless of filename. `TextureView` separately
   normalizes color space, invert-Y, wrap U/V, and sampling mode. UV transform
   remains a ShaderEntry field. Same-name/different-byte images never merge;
   equal bytes with different view keys share storage but not a mutable Babylon
   texture. GPU-only imported images use the full-resolution capture-before-cap
   PNG as their canonical bytes.
3. **Only remaining conflicts hit the modal.** If a name still collides AND content differs, dispatch `EVENTS.MODAL_OPEN` with id `shaderMerge`, payload `{ conflicts }`.

Existing user-authored shaders are never continuously merged after edits.
`findDuplicateShaderGroups` projects exact candidates in the Shader Library,
including names and linked-object totals. **Consolidate Duplicates** pushes one
`ShaderConsolidateCommand`: it rewires duplicate-linked objects to the first
canonical shader, removes now-unlinked duplicate entries/materials, and
snapshots all links and entries so one Undo restores the previous identities.
4. Modal options per conflict: **Use existing** / **Rename import** / **Replace scene shader**. Default: Rename. Checkbox "Apply to all conflicts in this import."
5. On confirm: apply choices, continue load.

### Default Swatches
Maintained in **`src/config/swatches.json`** (single source of truth — edit the
JSON, no code change). `ShaderLibrary.js` re-exports it unchanged:
```js
import swatchData from '../config/swatches.json' with { type: 'json' };
export const DEFAULT_SWATCHES = swatchData;
```
Each entry: `{ id, name, hex:'#RRGGBB', category }`. Categories render as
headed sections (`Primer` / `Military` / `Metals` / `Miniatures`, 20 entries
at time of writing). User swatches live in `state.scene.userSwatches` and are
appended after these.

---

## PART 10b — TEXTURE IDENTITY

What uniquely names a texture across import → session → `.mixo` → reload →
export. Without this contract, dedupe aliases unrelated textures and reload
drops them (2026-06-11 review C2/H6).

**Identity fields** (on every `kind: 'texture'` AssetEntry):
- `sourceFileHash` — sha256 of the *source file bytes* the texture arrived in
  (the glTF/3MF container for imported textures; the image file itself for
  user-loaded ones). Computed once at import in `AssetLoader.loadFromBlob`;
  reused by `instantiateAsset` from the AssetEntry.
- `sourceAssetId` — the mesh AssetEntry whose container owns an imported
  texture's lifetime (null for user-loaded textures).
- `babylonTextureName` — `texture.name` as the loader minted it. Deterministic
  for identical source bytes, so it re-identifies the texture inside a
  restored container.

**Dedupe rule:** imported textures get an immediate conservative signature of
`sourceFileHash | babylonTextureName | width | height | class | textureView` so
same-source re-imports reuse an asset without merging different sampler views.
Original encoded image bytes are then SHA-256 content-addressed in
`TextureImageStore`: equal bytes from different files share one immutable image
payload, while each `TextureView` independently preserves colour space, invertY,
wrap U/V, and sampling mode. No name-only or perceptual matching is allowed.

**Reload rebind rule** (PersistenceManager load): after `restoreContainer`
succeeds for mesh asset `A`, every persisted imported-texture entry with
`sourceAssetId === A.id` is rebound by looking up `babylonTextureName` in the
restored container's textures and registering the instance under its
persisted assetId (`AssetLoader.bindRestoredTexture`). Shaders are restored
AFTER assets (see §11 Load Sequence) so `restoreShader` finds both user and
imported textures live and keeps `diffuseTextureAssetId`; the colour-only
fallback now triggers only when the texture is genuinely gone.

---

## PART 11 — PERSISTENCE MANAGER

**File: `src/core/PersistenceManager.js`** — thin façade over `src/core/persist/*`
(house pattern: AssetLoader over `assets/*`, PrintManager over `print/*`). The
façade owns only the open-file handle and the save/saveAs/open/newProject/
openRecent flows; document assembly lives in `persist/ProjectSerializer.js`,
tiered asset resolution in `persist/AssetResolver.js`, portable-save required
asset detection/error shaping in `persist/ProjectIntegrity.js`, the load
pipeline + relink in `persist/ProjectLoader.js`, recents in
`persist/RecentProjects.js`, autosave in `persist/Autosave.js`, and dirty tracking in
`persist/DirtyTracker.js`. The `PersistenceManager` API object is deliberately
NOT frozen — monkey-patching it is the established headless-test seam (same
rationale as AssetLoader) — and `__test` is re-assembled from the persist
modules under its original underscore key names so the headless tests and
browser smokes stay pinned to one surface.

### Public API
```js
PersistenceManager.init()                  → void   // call from src/app/main.ts: registers project modals on Modal
PersistenceManager.save()                  → Promise<void>
PersistenceManager.saveAs()                → Promise<void>
PersistenceManager.open()                  → Promise<void>
PersistenceManager.newProject()            → Promise<void>
PersistenceManager.getRecentProjects()     → RecentProject[]
PersistenceManager.openRecent(rec)         → Promise<void>
PersistenceManager.relinkAsset(assetId)    → Promise<void>   // user-driven re-pick of a single file
PersistenceManager.startAutosave(ms=60000) → void
PersistenceManager.stopAutosave()          → void
PersistenceManager.recoverAutosave()       → Promise<boolean>
PersistenceManager.requestClose()          → Promise<{action:'save'|'discard'|'cancel',saved?:boolean}>
// Test surface — pure helpers exported for headless tests; do NOT import from app code.
PersistenceManager.__test = {
  _b64FromBuf, _bufFromB64, _sha256Hex, _extOf,
  _resolveAssetBlob, _scanDirForHash, _fileHandleAtPath,
  _arrToMap, _migrate, _resolveLoadedExportRatios,
  _buildDocument, _loadProject,
}
```
Constants (in `src/core/persist/constants.js`): `SCHEMA_VERSION = '3.4'` (3.4 adds
the AssetEntry `source` descriptor + `displayName` and formalises `project.id`;
3.3 added top-level content-addressed `textureImages` plus `imageContentHash` /
`textureView` on texture AssetEntries; 3.2 and older per-asset `fileData` still
loads — see §11 Schema Migration Ladder),
`FILE_EXT = '.mixo'`, `RECENT_KEY = 'recent_projects'`, `RECENT_MAX = 10`,
`AUTOSAVE_PREFIX = 'autosave_'` (autosave keys are `AUTOSAVE_PREFIX + project.id`
since task 0.11 — pre-0.11 keys used the project name and still recover),
`AUTOSAVE_IMG_PREFIX = 'autosaveimg_'` (per-hash texture images of a snapshot;
deliberately NOT prefixed by `autosave_`), `SCAN_FILE_LIMIT = 4000` (hash-relink safety cap — see §11 Asset Resolution Priority).

### Full Project Schema (v3.4)
Every field persisted. Restored exactly.

```jsonc
{
  "version": "3.4",
  "savedAt": "ISO8601",
  "project": { "name": "...",
               "id": "uuid",            /* formal since 3.4 (minted by 0.11 on new / Save As /
                                           load of a doc without one); autosave key */
               "lastSavedAt": "ISO8601" /* or null */ },
  "sceneSettings": {
    "camera": { "preset": "perspective", "alpha": 1.57, "beta": 1.1, "radius": 10,
                "target": {"x":0,"y":0,"z":0}, "isOrthographic": false,
                "followMode": "free" /* 'free' | 'followActive' | 'worldOrigin' */ },
    "overlays": { "grid": true, "axes": true, "wireframe": false, "printPreview": true,
                  "bedPreview": false, "wireframeEdges": false, "wireframeEdgeColor": "#f59e0b" },
    "render": { "exposure": 1.05, "contrast": 1.10,
                "shadowsEnabled": true, "shadowDarkness": 0.62,
                "background": "light", "keyIntensity": 0.70,
                "fillIntensity": 0.25, "hemiIntensity": 0.85,
                "fovDeg": 45.8, "clipNearMM": 1,
                "toneMapping": "aces", "saturation": 0,
                "vignette": false, "vignetteWeight": 1.5,
                "floorEnabled": false, "floorColor": "#9a9a9a", "floorZMM": 0, "floorDiameterMM": 0,
                "hdriEnabled": true, "hdriPreset": "studio", "hdriIntensity": 0.6 },
    "renderOut": { "width": 1920, "height": 1080, "transparent": false,
                   "pose": null, /* or saved camera pose for the Render view */
                   "turntable": { "durationS": 8, "fps": 30, "direction": "left", "ease": true } },
    "grid": { "cellMM": 10, "subdivisions": 10 },  /* line styling only; footprint = print.bedDimensions XY */
    "cursor3d": { "x":0, "y":0, "z":0 }
  },
  "print": {
    "workingRatio": 12, "targetRatio": 35,         // any positive float (e.g. 0.5 for 2:1 upscale)
    "targetPrinterId": "mimaki-3duj-553",
    "bedDimensions": {"x":508,"y":508,"z":305},
    "objBakeSolidTextures": false,
    "strictExport": false                          // watertight-repair-and-cost task 4
    /* `print.repairOnImport` is NOT in this document (2026-09-18, review I8):
       it is a per-user preference (SettingsStore / localStorage) like the
       `cost` slice below. `print` is merged WHOLESALE on open, so a document
       carrying it would flip the opener's own setting, "file wins".
       ProjectSerializer strips it on save and ProjectLoader on load. */
  },
  /* state.cost (§12 Cost quote) is NOT in this document — material price
     assumptions are a per-user SettingsStore section (localStorage), never
     travel with the .mixo file, and are not FILE-WINS on open like the
     `print` fields above. */
  "assetLibrary":  [ /* AssetEntry without container or blobUrl — see 3.4 AssetEntry fields below */ ],
  "textureImages": [ /* unique {hash,width,height,mimeType,fileData}; one per SHA-256 */ ],
  "collections":   [ /* CollectionEntry[] — outliner display buckets */ ],
  "shaders":       [ /* ShaderEntry without linkedMeshIds */ ],
  "uvOverrides":   { /* Record<meshId, UVOverride> */ },
  "userSwatches":  [ /* SwatchEntry[] */ ],
  "sceneObjects":  [ /* SceneObject[] — each carries collectionId tag */ ],
  "groups":        [ /* GroupNode[] */ ],
  "selection":     { "selectedIds": [], "activeId": null, "pivotMode": "median" },
  "gizmo":         { "mode": "translate", "space": "world", "snap": {...} },
  "ui":            { "activePanel": "properties", "outlinerCollapsed": {},
                     "assetPanelHeight": 220, "scaleLocked": true }
}
```

Unknown top-level keys of a NEWER-minor document (3.5+) are preserved on load
and written back verbatim on the next save (`ProjectValidator.preservedTopLevelKeys`
→ `ProjectSerializer.setPreservedTopLevelKeys`, cleared by `resetWorld`). Older or
same-minor documents' unknown keys are legacy noise and are dropped. A newer
MAJOR is still refused before the world is reset (`validateDocument`).

#### AssetEntry fields added in 3.4 (overhaul §4.4)
```jsonc
{
  "displayName": "chair.glb",   // ours; never renames the user's file. Written on
                                // every save: displayName || filename || name || id
  "source": null | {            // where the bytes came from (null = loose drop /
    "kind": "folder" | "file",  //   embedded-only: bytes live only in the .mixo)
    "refKey": "dir_…",          // opaque mount / file-handle key
    "path": "sub/chair.glb",    // path within the folder (folder) or the file name (file)
    "label": "Parts"            // human label (folder name / file name)
  },
  "contentHash": "sha256-hex"   // unchanged — identity of the bytes
}
```
`source` is derived (`ProjectSerializer.deriveAssetSource`) from the legacy
provenance keys — `directoryHandleKey` + `originalPath` → `folder`,
`fileHandleKey` → `file` — which remain the runtime resolver inputs until the
StorageAdapter tasks (4.2+) make `source` authoritative. The legacy keys
(`directoryHandleKey`, `fileHandleKey`, `originalPath`, `sourceFileHash`) are
still WRITTEN for one minor so 3.3 readers keep resolving live files, exactly
like the `print.exportRatios` mirror of `print.exportTargets`.

### Schema Migration Ladder (`ProjectLoader.migrate`, task 4.1)
`migrate(doc)` runs after `validateDocument` and before `resetWorld`. It is
pure: it returns a NEW top-level object (rewritten arrays/entries are copied;
`fileData` strings are shared, never copied) and never mutates the caller's doc.
A missing `version` reads as 3.0. Each step runs when the document is older
than the step's target; every step is idempotent (a 3.3 file that already
carries `exportTargets` migrates cleanly). After the ladder an older doc's
`version` reads `SCHEMA_VERSION`; a newer-minor doc keeps its stamp and runs no
steps (best-effort load).

| Step | Rewrites |
|---|---|
| 3.0 → 3.1 | nothing — scalar `scene.gridSize` is ignored (footprint = printer bed) |
| 3.1 → 3.2 | nothing — assets-before-shaders is a load-order change |
| 3.2 → 3.3 | nothing — `textureImages` is additive; per-asset `fileData` still resolves |
| 3.3 → 3.4 | asset `source` + `displayName` (4.1); `print.exportTargets` from legacy `exportRatios` / `targetRatio` via `resolveLoadedExportTargets` (1.17); `print.referenceObjectId` default `null` (1.15); objects without a valid `ratio` take the pre-redesign global `print.workingRatio`; `seedLogicalObjectIds(sceneObjects)` from `sourceGroupId` (2.7 / Decision 33 — the ONLY runtime read of `sourceGroupId`); **hook** for `ratioSource` (1.13, not yet implemented) |

`project.id` is not minted by `migrate` (it stays pure): the loader assigns
`mintProjectId()` when the document has none. `loadProject` still calls
`resolveLoadedExportTargets` on every load to normalise the typed list.

### Portable Project Integrity (manual save gate)
`.mixo` is the editable Mixomesh project snapshot, not a pointer file to the
user's current mounted asset library. `ProjectSerializer.buildDocument()` must
abort before bytes are written if required scene assets cannot be embedded or
resolved into content-addressed texture payloads.

`ProjectIntegrity.collectRequiredAssetRefs(state)` defines **required assets**
as:
- every `SceneObject.assetId`;
- every `shader.diffuseTextureAssetId` assigned to a SceneObject;
- for required imported/container-owned texture AssetEntries, their
  `sourceAssetId` mesh container, because that container owns the texture bytes.

Manual `save()` / `saveAs()` uses `buildDocument({skipEmbed:false})`; every
required non-container asset must produce `fileData` or a
content-addressed `textureImages[]` entry in the same document. A live
`directoryHandleKey` / `fileHandleKey` is useful for relinking, but it is not
sufficient for portability because a clean browser profile or another machine
will not have that handle. Missing required entries or bytes throw
`Error("Cannot save portable .mixo; ...")` with `err.portableIssues[]`, and the
caller must not write a partial project file.

Unused Asset Panel library entries are conveniences: they may remain linked or
unembedded without blocking save, because they do not determine whether the
saved scene reopens or exports. Export/readiness still blocks on ghosts and
missing assigned textures.

**Import caps (task 6.4, Decision 19, `import/ImportLimits.js`).** Max file
size 1 GB (checked before hashing/reading); zip packages (3MF): ≤ 256
entries, ≤ 2 GB total DECLARED uncompressed size (checked from the central
directory before any entry is inflated), and any entry with a `..` segment,
an absolute or drive path, or a NUL is rejected. Violations throw a
user-readable Error → import-error modal. The mesh-validation worker has a
120 s per-request timeout (`setValidateWorkerTimeout`); on expiry it is
terminated, warned, and validation falls back to the inline path.

**Name clashes (task 4.8, Decisions 16-17).** Identity = `contentHash`.
`importWithDedupe(blob, name, pos, opts)` (AssetImport) is the single new-file
import entry (OS drop, picker, folder file). It hashes before the progress
overlay; `findByHash` returns the first instantiable mesh asset (library
order; no libraryItem, no ghosts). A match raises `confirmAction` — "Add
another copy" (default, re-instantiates the existing asset) / "Import as
separate asset" (second asset, same hash) / dismiss = nothing. Project-tab
instantiation and project load never prompt. Display names
(`assets/DisplayNames.js`, pure, persisted fields + library order → stable
across reload): ambiguous labels (case-insensitive) get the shortest
distinguishing parent-folder qualifier (`chair.glb · downloads`), remaining
ties `#N`; generic texture names (`baseColor`, `Image_0`…) display as
`<model> · baseColor`. Stored names are never rewritten; cards/rows adopt
`qualifiedDisplayName` with the gated Source UI. Export texture names
(Decision 17, `ExportTextures._planTextureNames`, shared by OBJ/3MF/PLY/WRL):
one owning object → `<object>_baseColor.png`; shared → material name;
case-insensitively unique (`_N`); MTL `map_Kd` keyed by the same `usemtl`
token (fixes materials with spaces losing their map).

**Relink / Refresh (task 4.5).** Relinking a ghost/missing asset and
refreshing a `changed` one are ONE undoable `RelinkAssetCommand`
(`commands/AssetCommands.js`). `await RelinkAssetCommand.create(assetId,
{blob, filename, link?, siblingFiles?, label?})` hashes the bytes and loads the
replacement through the normal `restoreContainer` path (import normalisation +
per-object ratio bake) into a detached, disabled set — live state untouched; a
failed load throws before any change. `execute`/`undo` are synchronous swaps of
the per-asset registry slots (AssetContainer, source blob URL, OBJ sibling map)
and the asset entry (filename, extension, `contentHash`, `sourceFileHash`,
`isGhost:false`, `libraryItem:null`; link fields replaced only when `link` is
given = Relink, kept = Refresh). The next save embeds the new bytes under the
new hash. Every object of the asset is re-bound keeping transform, parent,
ratio, material; undo restores the previous set/entry/ghost flags exactly.
Events `OBJECT_UPDATED` + `ASSET_RELINKED` (never `PROJECT_LOADED`). Entry
points: `ProjectLoader.relinkAsset` (picker → `persistRef` → command) and
`refreshAsset` (re-read the linked source via `storage.resolveAsset`). A
Refresh button and wrapping 4.3's `applyFoundSource` in the command land with
the gated Source UI (4.6). Async-prepared command pattern: async work in a
static `create()`, then sync execute/undo (see PART 5).

### Asset Resolution Priority (locked — `_resolveAssetBlob`)
Every asset has one resolution attempt on load. Walk top-down; first hit wins.

**Adapter seam (task 4.2).** Live tiers go through
`storage.resolveAsset(source,{contentHash})` → `{status, blob}`, status
`embedded | linked | changed | missing` (UI: Embedded copy / Linked / Changed
on disk / Missing). `source = {kind:'folder'|'file', refKey, path, label}`
(`storage/AssetSource.js`); legacy `directoryHandleKey+originalPath` /
`fileHandleKey` map onto it (`sourcesOf`). `resolveAsset` reads ONE source and
never scans (Decision 3). `findMoved(source,{contentHash,onProgress,limit,refKey})`
is the only hash walk and is user-invoked only. Refs: `persistRef(ref)` →
stable key (`dir_`/`file_` + 32 hex); `restoreRef(key)` → re-validated session
ref or null; `deleteRef(key)`. Browser: handles in IndexedDB `handles`; dir key
= sha256(name + first sorted entry), file key = sha256(name + size +
lastModified), `_n` suffix on collision. Desktop: key = sha256(normalised
absolute path); `{kind, absolutePath, name}` lives in main-only
`<userData>/mixo-refs.json` (NOT the renderer-readable KV); restore checks
exists + kind + R_OK and mints a fresh token; relative reads cannot escape the
folder; symlinks skipped. `caps.watchFiles=false` until `watchAsset` ships.
Load never scans (task 4.3, Decision 3): `resolveAssetBlob` makes one
`resolveAsset` per link and returns `{blob, live, status}`. A `missing` or
`changed` link resolves to the EMBEDDED copy (status recorded, queryable via
`getAssetStatus`; a `changed` live file is used only when no embedded bytes
exist). The explicit "Find moved file..." action (asset card + Properties) calls
`findMovedForAsset` (adapter `findMoved`, progress overlay) and on a hit
`applyFoundSource(assetId, result)` repoints `source` (4.5 wraps it in a
command). TRANSITIONAL until 4.5: Refresh of a `changed` asset is not yet
wired. AssetResolver no longer touches FSA/idb directly.

**Routing + boot gate (task 4.4).** Every renderer picker, file write, ref and
KV operation goes through `storage.*`; direct File System Access / IndexedDB
lives only in `storage/StorageAdapter.js` and `idb.js`
(`tests/adapter-routing.test.mjs` scans `src/` against an allowlist). Added on
both impls: `ready()`, `hasRef(key)`, `pickOpenProject()`,
`pickSaveProject(name)`, `writeFile(ref, data)` (atomic: browser
createWritable + abort; desktop temp file + rename in main),
`pickImportAssets({multiple})`, `saveExport(blob, name, hint)` (browser falls
back to an anchor download; desktop has no fallback), `refForDrop(item)`
(synchronous in the drop event; desktop preload `webUtils.getPathForFile` →
read-only token). PersistenceManager keeps an opaque `_fileRef`; recents store
`persistRef(projectRef)` (stable `file_` key; replaced entries `deleteRef`);
openRecent = `hasRef` → `restoreRef` → `readFile` with distinct "lost" vs
"permission denied" toasts. Desktop: main opens every dialog and returns only
`{ref,name}`; project open/save tokens are WRITABLE (flag persists for
recents), import/mount/drop tokens read-only; `fs:writeFileRef` refuses
read-only/unknown tokens and > 1 GiB. Boot gate (`main.ts`): `await
storage.ready()` before UI init — browser without FSA → blocking "Browser not
supported"; IndexedDB not open in 5 s → continue with `persistAssets=false`;
desktop bridge missing methods or `storage:ready` > 10 s → blocking "Desktop
storage unavailable". `MIXO_SMOKE=save` (unpackaged only) exercises a real
save in the Electron smoke.

**Electron security (tasks 6.1/6.2, Decision 19).** BrowserWindow uses
`SECURE_WEB_PREFERENCES` (`electron/WindowSecurity.cjs`: sandbox,
contextIsolation, no nodeIntegration/webview, webSecurity). Every
webContents: `will-navigate`/`will-redirect` cancelled unless `isAppUrl`
(exactly `dist/index.html` or the `MIXO_DEV_URL` origin);
`setWindowOpenHandler` → deny; webviews prevented. Session permissions denied
except `clipboard-sanitized-write`. Every IPC handler requires
`isTrustedSender` (the app's top frame). CSP = `index.html` meta tag (web +
desktop): `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'
'unsafe-eval'; style-src 'self'; style-src-attr 'unsafe-inline'; img-src
'self' data: blob:; connect-src 'self' data: blob:; worker-src 'self' blob:;
object-src 'none'; base-uri 'self'; form-action 'none'` ('unsafe-eval' =
Embind `new Function` in the vendored manifold/meshfix glue — droppable after a
`-sDYNAMIC_EXECUTION=0` rebuild; `style-src-attr` = template `style=`
attributes). No inline scripts (`src/app/entry.js`). CSG2 initialises only
via `initCsg2(B)` (`vendorUrl.js`: dynamic import + `manifoldInstance`;
Babylon's `manifoldUrl` path injects an inline module the CSP blocks). Save
dialogs take descriptors only: `sanitizeSuggestedName` (bare, Windows-safe)
and `exportDialogOptions` (extensions 3mf obj stl ply wrl zip png mp4 webm).
Writability is part of token identity (a dialog grant never upgrades a
read-only token); export writes go through main-only `writeDialogTarget`
(no token). `MIXO_SMOKE=1` runs a security probe; any CSP violation fails
the Electron smoke. Known gap: `fs:registerDropped` trusts the preload's
drop path (read-only; Electron offers no main-side verification).

| # | Tier | Condition | Live? | Source |
|---|---|---|---|---|
| 1 | Live exact path | `directoryHandleKey` granted **and** file exists at `originalPath` | yes | file on disk |
| 2 | ~~Hash relink~~ | RETIRED on load (Decision 3) - only the user-invoked "Find moved file..." walks (cap `SCAN_FILE_LIMIT` 4000) | - | - |
| 3 | Single-file handle | `fileHandleKey` resolves and permission is granted (loose drag-drop relink — Chrome only, only set when caller passed `fileHandle:` without a `directoryHandleKey`) | yes | file on disk |
| 4 | Embedded snapshot | `fileData` (base64) present | no (Snapshot) | embedded in `.mixo` |
| 5 | None | nothing left | — | → ghost wireframe |

Liveness rule: tier 1–3 ⇒ live (badge: **Linked**); tier 4 ⇒ frozen (badge: **Snapshot**); tier 5 ⇒ ghost. Tier 3 sits below the directory because a dir also gives the hash-relink rescue (tier 2) — folder-mounted assets have a richer recovery path than loose drops. **Unmatched modal** (post-load) lists only assets where a live source was *expected but failed*: `status==='static' && (directoryHandleKey || fileHandleKey)`. Assets that were always frozen (no link at all) never surface — they're not lost, they're snapshots by design.

### Load Sequence (order critical)
```
1. Parse JSON, check version compatibility (validateDocument), then
   migrate(doc) — the §11 Schema Migration Ladder.
2. HistoryManager.clear()
3. Dispose all current Babylon meshes/materials/containers, revoke blob URLs.
4. Restore print, sceneSettings, ui, gizmo, uvOverrides, userSwatches,
   collections into state (no Babylon work).
5. Decode and hash-validate `textureImages` into TextureImageStore.
8. Resolve + restore every assetLibrary entry sequentially:
   - For each: run `_resolveAssetBlob` (see priority table above).
   - Mesh assets: restoreContainer, then REBIND imported textures owned by
     this container (§10b reload rebind rule: match persisted
     babylonTextureName, register under the persisted texture assetId).
   - User-loaded texture assets: resolve `imageContentHash` from the image
     store first (legacy `fileData`/live tiers remain fallback), then create its
     independent texture view under the persisted id.
   - Unresolved → create ghost (state.scene.objects entry with isGhost: true).
5. Restore shaders into state + create Babylon materials in ShaderLibrary.
   MUST run AFTER step 8 — restoreShader rebinds diffuseTextureAssetId via
   AssetLoader.getBabylonTexture, which only resolves once textures are
   restored. (Pre-3.2 builds ran shaders first, which silently dropped every
   texture binding on reload.)
9. For each sceneObject:
   - If asset loaded → instantiate at transform, assign shader, apply UV override if exists.
   - If ghost → create wireframe bounding box at transform.
   - Preserve `collectionId` on the restored object so Outliner re-routes correctly.
10. Restore groups (TransformNodes), re-parent children in order.
11. SceneManager.restoreCameraState() from saved camera.
12. Apply overlay states (including `wireframeEdges` + `wireframeEdgeColor`).
12b. Apply `SceneManager.setScaleLock(state.ui.scaleLocked)` so the viewport scale gizmo matches the saved lock preference on first activation.
13. ShaderLibrary.rebuildLinkedIndex().
14. Queue validation for all non-ghost meshes (async, non-blocking).
15. Dispatch PROJECT_LOADED. Set isDirty=false.
```

### Autosave
- Interval 60s when dirty (position-based — see §5 dirty contract).
- Keyed by a stable `project.id` (uuid, `persist/ProjectId.js`; task 0.11):
  minted on New, on Save As (the copy is a new document), on loading a doc
  without one, or lazily by the first tick; written into `.mixo`
  `project.id` together with `project.lastSavedAt`. Renames and same-named
  projects can no longer cross-wire recovery.
- Writes `{savedAt, name, doc}` to kv key `autosave_<id>` through the storage
  adapter (web IndexedDB / Electron kv file). The snapshot's `textureImages`
  is `[]`; each referenced texture image is stored ONCE per hash under
  `autosaveimg_<id>_<hash>` (`persist/AutosaveKeys.js`) instead of being
  re-encoded every 60 s. `deleteAutosave(id)` removes both.
- One tick at a time; the loading/importing check runs before AND after the
  async build (and the project id must be unchanged), so a load/import/New
  that starts mid-build drops the snapshot instead of writing a torn one.
- Boot: after the folder-remount prompt, `recoverAutosave()` offers the
  newest snapshot only if its `savedAt` is newer than the snapshot doc's
  `project.lastSavedAt` (otherwise it is deleted silently). A recovered
  project re-attaches its stored images, stays DIRTY (it is unsaved work)
  and is re-snapshotted at once. (Supersedes the Phase 6 "no boot offer"
  decision — overhaul task 0.11.)
- Cleared (snapshot + images) after a successful explicit save and after any
  successful load (for both the loaded and the previous project id).
- Autosave uses `buildDocument({skipEmbed:true})`: handle-backed assets keep
  their live/hash tiers lightweight, while handleless loose-drop assets must
  still embed bytes or the autosave is discarded by the catch path. This keeps
  crash recovery from replacing a loose drag-drop with an unrecoverable ghost.

### Recent Projects
- Max 10. Stored via storage adapter KV under key `recent_projects` (task 4.4).
- Entry: `{ name, path, savedAt, thumbnailDataUrl }`. Thumbnail = viewport screenshot at save time (use `BABYLON.Tools.CreateScreenshot`).

---

### OPFS tier — Safari / iPadOS / iOS (overhaul 8.2)

Target: Blueprint §11, after **Routing + boot gate (task 4.4)**; ADR 0001 addendum (tier list).

**OPFS tier (task 8.2).** Third StorageAdapter impl, `storage/OpfsStorageAdapter.js`
(`kind:'opfs'`), for WebKit (Safari; every iOS/iPadOS browser): no File System
Access pickers / `getAsFileSystemHandle`, but OPFS + IndexedDB. Selection is
pure: `detectStorageTier(env)` (capabilities.js) → `desktop` (Electron
`window.electronAPI`) > `browser` (FSA `showOpenFilePicker` present: Chrome/Edge)
> `opfs` (`navigator.storage.getDirectory` present) > `browser` (its `ready()`
blocks "Browser not supported"). Live `storageTier` + `ADAPTERS[tier]` pick
`storage`. Firefox also has OPFS-without-FSA and so maps to `opfs`; which
engines may boot is the 8.1 gate's call. **Engine gate (task 8.1):**
`detectEngine(ua, {maxTouchPoints, desktop})` returns `chromium` (Chrome/Edge/
Opera/Electron), `webkit` (any iPhone/iPad/iPod UA incl. CriOS/FxiOS/EdgiOS;
iPadOS "Macintosh" UA with `maxTouchPoints>1`; macOS Safari), `gecko`
(`Firefox/`) or `other`. `engineGate(engine)` is null for chromium/webkit and a
blocking title+message naming Chrome/Edge/Safari for gecko/other (rendered by
main.ts `renderBlockingMessage` before `storage.ready()`); `detectStorageTier`
maps gecko/other to `browser` so they never pick OPFS.
Caps (opfs): `mountDirectory/relinkByPath/watchFiles:false`, `writeFiles:true`
(in-place OPFS writes, no picker), `persistAssets = IndexedDB opens`.

- Projects live in OPFS `Projects/*.mixo`. `pickSaveProject(name)` has no OS
  dialog: optional in-app name hook `setSaveNamePrompt(fn)` (answer string |
  `{name, overwrite:true}` | null=cancel; no hook = suggested name), name
  sanitised (`sanitizeProjectName`), collision → `Name (2).mixo`, `(3)`…; the
  name is reserved immediately (empty file, hidden by `listProjects`).
- `listProjects()` → `[{name, ref, size, lastModified}]` newest first (.mixo,
  non-empty) for the in-app chooser; `pickOpenProject({ref}|{name})` opens one;
  `pickOpenProject()` (no target) = hidden `<input type=file accept=.mixo>`,
  the picked file is COPIED into Projects/ (`importProjectFile(file, name?)`,
  collision-safe) and the OPFS copy becomes the save target. `deleteProject(refOrName)`.
- Imports: hidden `<input type=file multiple>` (`cancel` event = []); refs are
  the picked `File`s — read-only (`writeFile` refuses), `persistRef` throws
  (callers already treat that as embedded-only). `refForDrop` → null.
- Exports: `saveExport` uses the Web Share sheet (`navigator.share({files})`)
  when `canShare({files})` and the device is touch Apple (iPhone/iPad incl.
  iPadOS "MacIntel"+touch UA) — else anchor download (object URL revoked after
  60 s for iOS). `hint.share` true/false forces; `forceDownload` skips share.
  Share AbortError → false (cancel); any other share error → download.
- Links: none. `resolveAsset` always `{status:'embedded', blob:null}`;
  `findMoved` → `{source:null, blob:null, scanned:0}`; `mountDirectory` throws.
- Refs: OPFS handles only. Key = `stableKeyFor(kind, ['opfs', ...opfsPath])`
  (path via `root.resolve(handle)`), record `{opfs:1, kind, path}` in the IDB
  `handles` store; `restoreRef` re-walks the path (null when gone/denied);
  `hasRef` = record stored.
- `writeFile`: `createWritable()` (atomic) when present; older WebKit without
  main-thread createWritable → `workers/OpfsWrite.worker.js`
  (`createSyncAccessHandle`, truncate+write+flush — NOT atomic).
- `ready()`: no OPFS → "Browser not supported"; OPFS/Projects open fails →
  "Storage unavailable" (Private Browsing); then `navigator.storage.persist()`
  best-effort (OPFS is the only copy; WebKit evicts idle origins) and the
  5 s IndexedDB probe (failure → `persistAssets=false`, non-blocking).
- Tests: `tests/storage-adapter.test.mjs` runs the shared conformance suite as
  `[opfs]` (live-link cases gated by `{liveLinks:false}`, replaced by an
  embedded-only case) over `tests/opfs-stub.mjs` (in-memory OPFS + input/
  anchor/share stubs); `tests/opfs-storage-adapter.test.mjs` covers tier
  mapping, listProjects, collisions, open-fallback import, share-vs-download,
  embedded-only resolve, worker write path.
- NOT verified on a real device: WebKit `cancel` event on file inputs,
  share-sheet user-activation after long exports, sync-access-handle worker.

## PART 11b — IDB (IndexedDB Layer)

**File: `src/core/idb.js`**

Thin wrapper over IndexedDB. Single DB `'mixomesh'` v1 with two object stores:
- `handles` — structured-clonable `FileSystemDirectoryHandle` / `FileSystemFileHandle`. Survives reloads (Chrome only). Keys: `last_mount_dir` (rec `{key, name}`), `fh_<assetId>` (loose-drop file handles, see §11 tier 3), `<mountKey>` (per-mount dir handles minted by `AssetLoader.mountDirectory`).
- `kv` — generic JSON-serialisable values. Keys: `recent_projects` (max 10, see above), `autosave_<projectId>` (project JSON without inline texture images, 60 s while dirty), `autosaveimg_<projectId>_<hash>` (one texture image each, written once).

### Public API
```js
// Handle store
putHandle(key, handle)        → Promise<void>
getHandle(key)                → Promise<Handle|undefined>
deleteHandle(key)             → Promise<void>
listHandleKeys()              → Promise<string[]>
// Re-exports — file handles share the store
putFileHandle, getFileHandle, deleteFileHandle  // === putHandle, getHandle, deleteHandle

// kv store
kvSet(key, value)             → Promise<void>
kvGet(key)                    → Promise<any>
kvDelete(key)                 → Promise<void>
kvKeys()                      → Promise<string[]>   // autosave-recovery scan
```

The DB connection is opened lazily and memoised (`_dbPromise`). Upgrades create missing stores. The headless test harness swaps the whole module via the `./idb.js` resolve hook to `tests/idb-stub.mjs` (same export surface, Map-backed).

---

## PART 12 — PRINT MANAGER

**File: `src/core/PrintManager.js`** (façade — ~50 lines; treat the count as illustrative, the size budget is enforced in §file-size-budget).

The façade re-exports the API surface used by UI and tests. Both named
exports AND the `PrintManager` namespace derive from one frozen `API`
object so they cannot drift — adding a method touches one place. This
structural rule closed a 🔴 crash in 2026-06-18 where a name was named-
exported but missing from the namespace.

### Public API
```js
PrintManager.exportOBJ(options)                  → Promise<void>  // triggers download
PrintManager.exportSTL(options)                  → Promise<void>
PrintManager.exportPLY(options)                  → Promise<void>  // binary LE PLY, per-vertex colour
PrintManager.exportWRL(options)                  → Promise<void>  // VRML 2.0 + ImageTexture
PrintManager.exportThreeMF(options)              → Promise<void>  // content-selected 3MF sub-flavor
PrintManager.previewExportContext(options)       → ExportContext|null  // UI preview entry — single source of truth
PrintManager.getExportReference(options)         → {logicalId, ratio}  // print.referenceObjectId unit, else first printable unit (never the selection — 1.15)
PrintManager.getExportedDimensions(meshId, ctx?) → {x,y,z} in mm  // accepts a preview ctx to avoid rebuild
PrintManager.SCALE_PRESETS                       → scale-presets.json passthrough

// options = { selectedOnly?:bool, individually?:bool, onProgress?:fn }
//   selectedOnly  — restrict to current selection (default: all isPrintPart meshes)
//   individually  — one file per mesh on disk (see "Export filenames" below)
//                   (default: one combined file per format)
```

Print sizes are `state.print.exportTargets: [] | [{kind:'ratio',value} |
{kind:'factor',value} | {kind:'height',mm}]` (task 1.17, Decision 27); `[]` =
as shown. Edits go through the undoable `AddExportTargetCommand` /
`RemoveExportTargetCommand` / `ReplaceExportTargetCommand` /
`SetExportTargetsCommand` (`ScaleCommands.js`, whole-list snapshot undo).
`ScaleMath.exportTargetsFromState` is the only reader (normalises, drops
invalid, collapses duplicates). `targetRatio` / `exportRatios` are read only by
`.mixo` migration.

### Export filenames

Every export filename follows one recipe so two exports at different scales
never collide on disk and the user can read the scale from the filename
without opening the file. **The ratio suffix is always present, even at
1:1** — consistency beats brevity here:

```
suffix         = `_r${referenceRatio}to${targetRatio}`   // e.g. `_r1to144`, `_r1to1` (per-object redesign §12)
combined       = `${projectName}${suffix}.${ext}`        // e.g. `Saturn_r1to1.3mf`
individually:
  outer zip    = `${projectName}${suffix}.zip`           // e.g. `Saturn_r1to1.zip`
  inner entry  = `${projectName}_${meshName}${suffix}.${ext}`
                                                          // e.g. `Saturn_hull_r1to1.3mf`
```

For OBJ, the OBJ payload's `mtllib` reference points at the **matching**
`.mtl` filename (per-mesh in individually mode, combined otherwise) — never
a project-scoped name, so a per-mesh OBJ is independently usable.

`projectName` comes from `state.project.name`, set by `PersistenceManager.saveAs`
(File System Access save picker) and by `_loadProject` on opening a `.mixo`.
Defaults to `'Untitled'`.

**Save dialog.** `src/core/print/Download.js::triggerDownload(blob, suggestedName, hint)` is the single
disk-write seam. On Chrome/Edge it uses `window.showSaveFilePicker({ suggestedName, types })`
so the user sees a Save-As dialog with the computed name pre-filled and can
accept with one click. `AbortError` (user cancel) is silent — not an error,
no toast. If the API is missing (headless tests only — Chrome always has it),
the function falls back to the classic anchor `download` attribute. Both
paths receive the same `suggestedName`, so the filename contract is identical
regardless of save mode.

### OBJ solid-colour PNG synthesis

Mimaki UV-inkjet slicers are texture-first: a shader with a flat diffuse
colour and no map may be ignored or interpreted as plain white by some OBJ
consumers. OBJ export therefore offers an **opt-in** fallback that synthesises
a 4×4 RGBA PNG per unique solid-colour material and injects a `map_Kd` line
into the MTL pointing at it. Tiled sampling makes 4×4 sufficient — every texel
is the same colour, so any UV (or none) resolves to the same pixel. Concept-only
fallback: this is OBJ-specific; 3MF Materials Extension preserves real textures
and falls back to `<m:colorgroup>` for solid materials.

Filenames + dedup:
- Per-material hex key `RRGGBBAA` where `A = round(material.alpha × 255)`.
- File path inside the export zip: `textures/solid_${HEX_RRGGBBAA}.png`.
- One PNG per unique key — N materials of the same (rgb, α) → one PNG.
- MTL line appended per matching `newmtl` block: `map_Kd textures/solid_${HEX_RRGGBBAA}.png`.

Transparency:
- The α byte lives **in the PNG** (modern slicers, Mimaki especially, read
  this).
- MTL `d` (dissolve) is generated by Mixomesh from `material.alpha`, so legacy
  slicers that only read MTL opacity still get the right value. The PNG alpha
  and MTL dissolve channels match by construction.

Toggle:
- `state.print.objBakeSolidTextures` (default **false**). Persisted in
  `state.print` like every other print option; survives save/load via
  `PersistenceManager`'s shallow-merge — old saves without the key auto-
  default to `false` on load. The export path reads it via
  `ctx.prefs.objBakeSolidTextures` (captured at ctx-build time by
  `ExportContext._capturePrefs`) so preview and actual export can
  never disagree if the user toggles mid-flight.
- Surfaced as the **"Bake solid colors to texture (OBJ, Mimaki-friendly)"**
  checkbox on the Export tab. Toggling dispatches a silent `setState` (no
  history entry — it's an export option, not a scene mutation).
- Disabling skips synthesis entirely: no PNG entries, no `map_Kd`
  injection. OBJ ships as classic vertex-coloured material — chosen
  explicitly when an FDM workflow or a downstream tool prefers it.

Code seams (all in **`src/core/print/ObjWriter.js`** — extracted from
PrintManager 2026-06-18 so the orchestrator no longer hosts format-specific code):
- `serializeOBJ(ctx)` — the format entry point.
- `_synthesizeSolidShaderTextures(meshList)` — returns
  `{ blobByName, filenameByMaterialName }`. Skips materials with a real
  diffuse/albedo/base texture (the `collectTextureExportData` path owns those).
- `_solidColorBlob(r,g,b,a)` — 4×4 RGBA PNG via canvas.
- `_buildOBJMtl(meshEntries, filenameByMaterialName)` generates MTL blocks
  using Mixomesh material ids/names, diffuse/albedo/base colour, alpha, and
  optional `map_Kd` lines. Mixomesh does not call `BABYLON.OBJExport.MTL`
  because Babylon's MTL helper accepts one mesh, emits `newmtl mat1`, and
  can mismatch OBJ `usemtl <material.id>`.
- All three are private to `ObjWriter.js`; STL and 3MF are unaffected.
> **Pipeline (Phase 6 + 2026-06-18 restructure).** All three entry points
> are thin wrappers around `src/core/print/PrintPipeline.js::_runExport`.
> Per target: build one `ExportContext` (frozen — see ExportContext.js),
> collect → clone (+ `makeGeometryUnique` so the shared-geometry clone can't
> corrupt the scene) → ordered prep (`fallbackMaterial` / `flattenWorld`
> (W·T(-pivot)·S(ratio)·T(pivot)·S(BU→mm) bake) / weld / optimizeIndices /
> createNormals / CSG2) → re-validate the fixed clones → serialize → package.
> The live scene is never mutated. Validation runs *after* prep; export only
> blocks on errors that survive the auto-fix (`err.validationErrors`).
> `options.onProgress(frac,msg)` feeds the blocking `src/ui/ProgressOverlay`.
> See §15 *Phase 6* for the full surface (CSG2-needs-watertight, 3MF Z-up +
> baked viewer-invariant placement, etc.).

### Split Print Modules

Every concern owns ONE file. The orchestrator (`PrintPipeline`) never
hosts format-specific code; format writers (`ObjWriter`, `ThreeMFWriter`)
never reach into orchestration. Filename naming (`PrintNaming`) takes a
ctx and reads no global state.

- `ExportContext.js` — typedef + `buildExportContext({state, units, target,
  options, csgReady})` + `previewExportContext(options)` +
  `getExportReference(options)` + `getExportedDimensions(meshId, ctx?)`.
  Owns `BU_TO_MM = 1000`. Returns a frozen object; the four list fields
  (`csgSkipped`, `meshes`, `cloneGroups`) keep mutable contents but
  immutable references. `csgReady` is a build-time INPUT (caller awaits
  CSG2 init first) so the ctx is build-once for the whole target.
- `PrintNaming.js`
  - `exportBaseName(ctx)` returns safe `${project}_r{ref}to{target}`.
  - `perMeshBaseName(ctx, meshName)` returns safe `${project}_${mesh}_r{ref}to{target}`.
  - The suffix is appended internally via `ExportPlanner.scaleFilenameSuffix`; no standalone `ratioSuffix` accessor (no caller ever needed one).
- `PrintPipeline.js`
  - `exportOBJ`/`exportSTL`/`exportThreeMF` entry points.
  - `_runExport(formatKey, options)` loops `exportTargetsFromState`
    (`[null]` for "as shown"), one ctx + one file per typed target. No mutable
    module global, no `setExportTargetOverride` — target is a function
    parameter.
  - STL + 3MF inline serializers (`_serializeSTL`, `_serialize3MF` +
    colorgroup / Materials-Ext variants).
  - CSG2 init, weld, validation gate.
- `PrinterProfiles.js`
  - imports `printers.json`.
  - exports `DEFAULT_PRINTER_ID = 'mimaki-3duj-553'`,
    `getPrinterProfile(id?)`, `listPrinterProfiles()`, and
    `printerProfileExists(id)`.
  - Unknown ids fall back to the Mimaki default.
  - `normalizePrinterProfile(id, row)` fills v2 defaults for v1 rows; enum
    lists (`PRINTER_FORMATS` etc.) are exported for hygiene.
- `ExportPlanner.js`
  - `scaleFilenameSuffix(sceneScale, printScale)` returns `_r{scene}to{print}`;
    non-integer tokens replace `.` with `p`.
  - `exportBaseName(projectName, sceneScale, printScale)`,
    `perMeshBaseName(projectName, meshName, sceneScale, printScale)`, and
    `safeFilenameStem(value)` implement the filename contract.
- `PrintPrep.js`
  - `createPrepSteps({ BABYLON, weld, isSolidColor, tryCsg })` returns the
    callable prep registry used by `PrintManager`.
  - Step semantics: `fallbackMaterial` creates a neutral StandardMaterial when
    missing; `flattenWorld` bakes world matrix plus export factor and resets
    transform; `weld` delegates to the injected weld; `weldSolidOnly` skips
    textured meshes; `optimizeIndices` calls Babylon when present;
    `createNormals` calls `mesh.createNormals(true)`; `csg` delegates to
    injected CSG; `csgSolidOnly` skips textured meshes.
- `PrintFormats.js`
  - `createFormats({ serializeOBJ, serializeSTL, serialize3MF, serializePLY, serializeWRL })`
    returns `{ obj, stl, '3mf', ply, wrl }`.
  - OBJ prep: `fallbackMaterial`, `flattenWorld`, `weld`,
    `optimizeIndices`, `createNormals`; CSG not required.
  - STL prep: `flattenWorld`, `weld`, `optimizeIndices`, `csg`,
    `createNormals`; CSG required.
  - 3MF prep: `fallbackMaterial`, `flattenWorld`, `weldSolidOnly`,
    `optimizeIndices`, `csgSolidOnly`, `createNormals`; CSG required, but
    textured meshes keep UV seams.
  - PLY / WRL prep: `fallbackMaterial`, `flattenWorld`, `weld`, `repair`,
    `optimizeIndices`, `createNormals`; CSG not required (it would drop UVs /
    flatten vertex colour), same as OBJ.
- `PlyWriter.js` (task 1.6) — `serializePLY(ctx)`, `encodeBinaryPLY`,
  `decodeImageRGBA(blob)`, `sampleBilinear(img,u,v)`. Binary little-endian:
  vertex `float x y z nx ny nz`, `uchar red green blue alpha`, + `float s t`
  when any mesh in the file is textured; face `list uchar int vertex_indices`.
  Geometry/normals via PrintSpace (`positionsToPrintSpace` + `printIndices`).
  Textured vertices = BILINEAR sample (REPEAT wrap, bottom-left UV origin) of
  the export PNG from `collectMimakiTextures` (full-res source, fail-closed),
  PNG decoded in pure JS so samples are the file bytes. Solid =
  `materialSrgbColor` + alpha. Combined → one merged `${base}.ply`;
  individually → zip (STL shape). No texture files shipped.
- `WrlWriter.js` (task 1.6) — `serializeWRL(ctx)`. `#VRML V2.0 utf8`; one
  `DEF <name> Shape` per clone, `IndexedFaceSet` (+ `texCoord`/`texCoordIndex`
  when textured); textured → `ImageTexture { url "textures/<name>.png" }`,
  solid → `Material { diffuseColor transparency }`. Units mm in the PrintSpace
  Z-up frame (not VRML's nominal Y-up metres — stated in a header comment).
  Textured → zip `${base}.wrl` + `textures/*.png` (OBJ layout); solid-only →
  single `.wrl`. PLY and WRL keep world placement (`WORLD_PLACED_FORMATS`).
  Writer check without a browser: `node tests/scan-probe.mjs --writers`
  (trimesh volume ≈ +1000 mm³ for a 10 mm box).
- `PrintPackaging.js`
  - `packageAndDownload(out, fmtLabel, progress)` converts a blob package or
    zip-entry package into a Blob. Zip packages use JSZip at call time. It
    reports `0.9` packaging and `0.98` downloading before calling
    `triggerDownload`.
- `Download.js`
  - `triggerDownload(blob, suggestedName, hint?)` uses
    `showSaveFilePicker` first, treats `AbortError` as silent cancel, logs and
    falls back to an anchor download for other picker failures.

Keep these helpers small. If a new export target needs a new writer mode,
add a serializer in `PrintPipeline.js` (STL/3MF inline) or extract it to a
sibling like `ObjWriter.js` (when format-specific code grows >100 lines).
Wire it into `PrintFormats.js`. Only generic reusable prep/packaging logic
belongs in the helper modules.

### Scale Math

> **⚠ SUPERSEDED (2026-06-16):** export factor is now
> `(activeObjectRatio / T) × 1000` with an "as shown" default (empty target list
> ⇒ print displayed size) and a **list** of absolute export targets (one file
> each). The global `(workingRatio / targetRatio)` prose below is historical —
> see *Per-Object Ratio Redesign* below for the LIVE behaviour.

The asset loader has already baked unit conversion and the working ratio into the mesh's in-scene transform (see §8 *Import Scale Model*). The Print Manager only has to rescale from the **working ratio** to the **target ratio** and convert metres → millimetres:

#### Working-ratio re-bake (live)

Changing `state.print.workingRatio` after objects are already in the scene re-bakes **every** registered mesh so the scene's BU ↔ metres mapping stays consistent. PrintPanel routes the workingRatio input through `push(new RescaleWorldCommand(prev, next))` (defined in `src/core/HistoryManager.js`). The command:

1. `factor = prev / next`.
2. For every meshId in `state.scene.objects`: `mesh.bakeTransformIntoVertices(Matrix.Scaling(factor))`.
3. Walks each registered mesh up the parent chain (group TransformNodes, glTF `__root__`, etc.) and scales every ancestor's local `position` by `factor` — exactly once per node (deduped via a `WeakSet`). Result: world transforms scale relative to the world origin, every mesh keeps `scaling = (1,1,1)`, Properties Panel scale field still reads `1`.
4. Scales `state.scene.cursor3d` by `factor`.
5. Sets `state.print.workingRatio = next`.

`targetRatio` is **export-only metadata** and is not part of the rescale — it changes via plain `setState`.

Undo restores by running the inverse factor; overlays (grid, axes, gizmos, selection RTT) are unaffected because they're not on any registered mesh's ancestor chain.

```js
function exportFactor() {
  const wr = state.print.workingRatio;
  const tr = state.print.targetRatio;
  return (wr / tr) * 1000;          // BU (m at workingRatio) → mm at targetRatio
}

function exportedPositionMM(v3) {
  const f = exportFactor();
  return { x: v3.x * f, y: v3.y * f, z: v3.z * f };
}
```

The implementation name for this formula is
`computePrintExportScale(sceneScale, printScale)`. UI labels call
`workingRatio` **Scene Scale** and `targetRatio` **Print Scale** while keeping
the persisted v3.1 field names.

Worked examples (all assuming `1 BU == 1 m` at the working ratio):

| working | target | factor | a 0.1 BU mesh → |
|---|---|---|---|
| 1   | 1   | 1000 | 100 mm at 1:1 (full size) |
| 72  | 72  | 1000 | 100 mm at 1:72 |
| 12  | 2   | 6000 | 600 mm at 1:2  (6× larger output) |
| 35  | 72  | 486… |  48.6 mm at 1:72 (shrunk) |
| 0.5 | 1   | 500  |  50 mm at 1:1   (scene was authored 2:1; exported back to real) |
| 1   | 0.5 | 2000 | 200 mm at 2:1   (export an oversized 2× fit-test copy) |

`sourceUnit` and `modelRatio` are **not** referenced at export time — they were already consumed at import to position the mesh in scene-metres.

### Per-Object Ratio Redesign (SHIPPED 2026-06-16)

Full spec: `docs/superpowers/specs/2026-06-16-per-object-ratio-design.md`.
Plan: `docs/superpowers/plans/2026-06-16-per-object-ratio.md`.
BUILDLOG: "Per-object scale ratio" entries. **This subsection now describes the
LIVE behaviour and supersedes the global `workingRatio` text earlier in §8/§12.**

**Why.** Global `workingRatio` forced every object to one scale. Kitbashing
mixes source models authored at different scales into one print. Scale is now
**per-object** — each object remembers its own ratio (persisted, never lost),
imports at the ratio its file suggests, resizes live, and exports at the size
shown (or a chosen target).

**Two numbers.** The per-object `ratio` *is* the old global `workingRatio`
promoted to object scope; `modelRatio` is unchanged.

| Number | Scope | Role | Seed |
|---|---|---|---|
| `modelRatio` | per-asset | authoring anchor (file→real) | glTF `extras.ratio`, else `1` |
| `ratio` | **per-object** (`state.scene.objects[id]`) | display + print scale | `= modelRatio` at import |

**Flow.**

```
glTF extras.ratio ─┬─► modelRatio (asset, fixed)
                   └─► ratio      (object, seeded = modelRatio, mutable)

IMPORT  : bake  unit × modelRatio / ratio  into vertices   (seed ratio==modelRatio ⇒ file as authored)
DISPLAY : object shown at its own ratio; mixed ratios look correct automatically
EDIT    : ratio R_old→R_new ⇒ rescale ×(R_old/R_new) about the object's own origin, bake, store ratio   [RescaleObjectCommand]
EXPORT  : ratioFactor = referenceRatio / T,   unitFactor = BU_TO_MM (1000),
          factor      = ratioFactor * unitFactor
          referenceRatio = (print.referenceObjectId unit, else first printable unit).ratio
            — explicit per-project state, NEVER the selection (task 1.15 / Decision 25)
          referenceRatio is the reference's EFFECTIVE ratio (task 1.16 / Decision 26):
            effectiveRatio(obj, mesh) = ratio / s, s = uniform WORLD scale of the
            object's node incl. parent groups (ScaleMath.nodeScaleOf: world-matrix
            basis lengths). Import bakes all transforms (node scale 1), so only a
            user's hand-scaling changes it: 1:72 at node scale 2 → 1:36, factor at
            T=72 = 500, as-shown suffix _r36to36. Non-uniform scale → declared ratio
            + effectiveRatioInfo(...).uniform === false.
            — built into ctx.referenceRatio by ExportContext.buildExportContext;
            consumed by PrintNaming.exportBaseName(ctx) + PrintPrep.flattenWorld(ctx)
            + ObjWriter.serializeOBJ(ctx) + ThreeMFWriter so factor / filename / pivot
            never diverge.
          • DEFAULT "as shown": empty print.exportTargets ⇒ ratioFactor 1
            ⇒ factor 1000 ⇒ prints EXACTLY the size on screen
          • ratio T: ratioFactor = ref/T (1:144 on a 1:72 object = 0.5×)
          • factor N: ratioFactor = N (Figma-style @2x)
          • height N mm: ratioFactor = N / referenceHeightMM, referenceHeightMM =
            the reference unit's PRINT-SPACE Z extent (bed-up axis) at as-shown
            size (ExportContext.referenceHeightMMOf); zero height throws
          • ctx.targetRatio = ref / ratioFactor; ctx.target = typed target
          • mixed selection scales uniformly by the reference ratio (WYSIWYG)
            about ctx.pivot (the reference unit's world origin), then ×BU_TO_MM
          • print.exportTargets = LIST ⇒ one output file per target
          • filename suffix: ratio/as-shown _r{ref}to{T} · factor _x{N} ·
            height _h{N}mm (non-integer: '.' → 'p', e.g. _x0p5)
PERSIST : object.ratio + print.exportTargets in .mixo, plus a ratio-only
          print.exportRatios mirror for one minor version (3.3 readers)
MIGRATE : exportTargets wins; else exportRatios:[n] → [{kind:'ratio',value:n}];
          else targetRatio → [{kind:'ratio',value}]; workingRatio → object.ratio
RESTORE : restoreContainer reloads RAW bytes, then re-runs the SAME
          bakeImportTransform as a fresh import (unit + glTF flip + winding, at
          ratio=modelRatio seed); _loadProject bakes the per-object DELTA
          (modelRatio/ratio) via _applyPersistedRatioBake → size + ratio + flip
          all survive reload (byte-identical to a fresh import + saved placement)
```

`PrintPipeline._runExport` resolves targets from `exportTargetsFromState` and
loops `buildExportContext({state, units, target, options, csgReady})` once
per target — no mutable module global, no `setExportTargetOverride`. Empty
list ⇒ targets = `[null]` ⇒ `targetRatio = referenceRatio` ⇒ factor 1000
"as shown". `PrintPanel.previewExportContext()` builds the SAME ctx shape
so the panel preview and the real export are guaranteed to agree (same
referenceRatio, same factor, same pivot, same filename).

**Audit fixes — all DONE:**

- **Geometry sharing** — `cloneMeshAsNewObject` calls `makeGeometryUnique()` so a
  per-object vertex bake can't corrupt the source through Babylon's shared
  `Geometry`.
- **Rescale about own origin (task 1.14)** — `RescaleObjectCommand` bakes only
  the object's own geometry and never touches a shared group/collection
  ancestor. A top-level mesh keeps its position (it scales about its own
  origin); a child's LOCAL position (relative to its parent) is multiplied by
  the factor so intra-group spacing follows; top-level sibling parts of a
  logical object scale their offset from the lead part so they stay
  assembled. Undo applies the inverse factor (exact restore).
- **Logical objects** — the Properties Ratio dropdown expands the selection to
  `logicalObjectPartIds` so a multi-mesh object scales as one unit.
- **Bed validation removed** — `_checkExceedsBed` + `exceedsBed` + its invalidate
  triggers deleted (bed/grid/camera *visuals* stay).
- **3MF export-only for ratio** — re-importing a 3MF cannot recover per-object
  ratio (geometry flattened); loader mirrors axis/unit only, `ratio = 1`.
- **Legacy removal** — `state.print.workingRatio` / `targetRatio` deleted from
  `default-settings.json` + state (only read in `.mixo` migration);
  `RescaleWorldCommand` + `_applyWorldRescale` removed; `SettingsStore.SCENE_PROTECTED`
  is now `{}` (scale is content, not a setting).
- **Restore re-bake (audit #1)** — restore reloads RAW bytes, so `restoreContainer`
  re-runs the SAME `bakeImportTransform` as a fresh import (unit + glTF RH→LH flip
  + winding, at ratio = modelRatio seed) and `_loadProject` then bakes the
  per-object ratio DELTA (`modelRatio/ratio`). Restore is byte-identical to a
  fresh import + the saved placement. Guarded by TWO browser-smoke round-trips:
  STL (per-object ratio size survives) and a minimal asymmetric glTF (restored
  AABB == fresh import AABB, proving the RH→LH flip survives).

**Scale round-trip — what survives .mixo save/reload (audited 2026-06-16):**

The `.mixo` embeds the RAW original asset bytes; restore reloads them and
replays only what is reconstructable from state. So a transform survives reload
**iff** it lives on the node transform OR in a state field:

| Scale operation | Stored as | Survives reload? |
|---|---|---|
| Position / Rotation / Scale / Size (mm) (`TransformCommand`) | node transform → saved `_decompose` | ✅ yes |
| Ratio dropdown (`RescaleObjectCommand`) | baked, but the `ratio` number replays it | ✅ yes |
| File units change (`SourceUnitCommand`) | `asset.sourceUnit` → restore seed | ✅ yes |

**RESOLVED 2026-06-16:** the former "Apply Scale / Apply Rotation"
(`BakeTransformCommand`) baked a user transform into vertices and zeroed the
node, leaving nothing in state to replay → lost on reload (probe: 20 mm → Apply
2× → 40 mm → reload → 20 mm). It was **removed**. User rotation/scale now always
live on the node (`TransformCommand`) — editable in Properties and saved via
`_decompose` — so they survive reload. Export still flattens the world matrix, so
printed geometry is unchanged. Guarded by the browser-smoke round-trip (sets a
node scale + ratio, reloads, asserts both survive). Principle: **system
transforms (import unit/flip, ratio) bake + replay on restore; user transforms
stay on the node and are saved directly — never baked.**

**RESOLVED 2026-06-17:** the former "as shown" target/reference split is gone
from the export path. Export, filename suffixes, Print panel scale preview, and
`PrintManager.getExportedDimensions` all use the export reference unit.
**Changed 2026-10-14 (task 1.15, Decision 25):** the reference is the saved
per-project `print.referenceObjectId` (default `null` in
`config/default-settings.json`, persisted in the `.mixo` `print` slice, NOT a
per-user setting), matched by logical id or part mesh id, falling back to the
first printable unit when unset or not exported — never the active selection,
so one project always exports the same sizes and filenames. A dangling id is
dropped on load and on save. Readiness adds an `info` issue `mixed-scales`
(`data: { referenceId, referenceRatio, ratios }`) when printable objects
differ in scale; info never changes status or needs acknowledgement. The
"Reference: … [change]" UI lands with task 1.3.

**RESOLVED 2026-06-18 (structural restructure):** the three competing export-
factor sources of truth (PrintManager inline, PrintScale adapter, PrintPanel
calling ScaleMath directly) collapsed into ONE `ExportContext.buildExportContext`.
The mutable module global `_targetOverride` is gone — target is a function
parameter. `PrintPrep.flattenWorld` now throws on missing `pivot`/`ratioFactor`/
`unitFactor` instead of falling back to world-origin scaling (silent wrong
position). `PrintManager.js` shrank from 682 → ~50 lines as a frozen-API façade so
named exports and namespace cannot drift (closing a 🔴 crash class). `PrintPanel`
imports only from `PrintManager` for export concerns. Spec:
`docs/superpowers/specs/2026-06-18-print-export-restructure-design.md`.

### Presets
Maintained in **`src/config/scale-presets.json`** (edit the JSON, no code change).
`PrintManager.js` re-exports it unchanged:
```js
import scalePresetData from '../../config/scale-presets.json' with { type: 'json' };
export const SCALE_PRESETS = scalePresetData;
```
Each entry: `{ category, label, ratio }`. `ratio: null` marks the free-form
**Custom** row (user types any `M:N`).

### Printer Profiles (`src/config/printers.json`) — build-area reference

Per-printer reference data is data-driven. `src/config/printers.json` is the
**only** place to add/edit printer display metadata and build-area dimensions.
Replaces the earlier `src/config/bed-presets.json` (deleted) — bed dims live
inline per row.

**Printer profile = defaults, hints, limits, bed (overhaul task 1.1, Decision 32).**
Export format is an explicit user choice. Selecting a printer APPLIES its
suggested defaults (export format, split-by-material, OBJ axis, 3MF flavour,
bed) as one undoable step; each is then an ordinary per-project setting the
user may change, and **Printer default** reverts them. A profile may raise
readiness hints but never hides, disables or blocks a format. (Apply/revert
command + UI land in tasks 1.2/1.3; this section is the data contract.)

Schema v2 (one entry per printer, keyed by id; v1 rows with only
`displayName/vendor/bed/defaultMaterialId` still load - `getPrinterProfile(id)`
normalises missing fields to plain single-colour FDM defaults, all formats):
```js
{
  "<id>": {
    displayName: string, vendor: string,
    process: 'uv-inkjet'|'polyjet'|'mjf'|'fdm'|'fdm-multi'|'resin'|'sls',
    bed: { x: number|null, y: number|null, z: number|null },  // mm; null (Custom only) falls back to Mimaki default helper
    colour: { mode: 'texture'|'vertex'|'per-part'|'paint'|'none',
              maxTextureSize: number, maxTexturesPerObject: number,
              alpha: boolean, vertexColour: boolean },
    export: { recommended: <format>, formats: <format>[],   // formats = suggested list; UI still offers every writer
              splitByMaterial: boolean,
              obj: { axis: 'y-up'|'z-up' },
              threeMF: { flavour: 'core'|'bambu'|'prusa', seatOnBed: boolean, metadata: boolean } },
    validation: { requireWatertight: boolean, minWallMM: number, minFeatureMM: number, maxTrianglesHint: number },
    defaultMaterialId: string,      // must exist in public/config/materials.json
    verified: 'unverified'|'verified'
  }
}
// <format> = obj-mtl | 3mf-textured | 3mf-colorgroup | 3mf-bambu | 3mf-prusa | stl | ply | wrl
```
`tests/hygiene.test.mjs` validates every row (required fields, numeric bed,
known enums) and asserts AGENTS.md rule 6 mentions "Printer default".
Every row ships `verified: 'unverified'` until the owner records verification.

Current profile ids:
- `mimaki-3duj-553`: default, `508 × 508 × 305` mm.
- `mimaki-3duj-2207`: `203 × 203 × 76` mm.
- Also: `stratasys-j55`, `stratasys-j850`, `hp-mjf-580`, `bambu-x1c`, `bambu-h2d`,
  `bambu-a1`, `bambu-a1-mini`, `prusa-mk4`, `prusa-xl`, `creality-k1`,
  `creality-ender-3`, `elegoo-centauri-carbon`, `elegoo-saturn-4-ultra`,
  `anycubic-kobra-3`, `anycubic-photon-mono`, `formlabs-form-4`.
- `generic-obj-mtl-png`: generic `300 × 300 × 400` mm reference.
- `custom`: null bed dimensions; user types XYZ manually.

Consumers:
- `PrintPanel.js` reads `state.print.targetPrinterId` → looks up row → drives
  printer labels and bed-size readout. Export calls still come from the
  explicit OBJ / 3MF / STL buttons.
- `SceneManager.js` reads the same row's `bed` for the floor/bed preview
  geometry (replaces the old `bedPresets` lookup).
- `PrintManager` entry points remain explicit by requested format:
  `exportOBJ`, `exportThreeMF`, and `exportSTL`. 3MF sub-flavor is chosen by
  export content: textured meshes with UVs use Materials Extension; solid-only
  exports use colorgroup. Build-area printer selection does not switch flavor.
- `src/core/print/ExportPlanner.js` is pure filename math (suffixes, safe
  stems), tested by `tests/export-planner.test.mjs`.

Default seeded entry: `mimaki-3duj-553`. State default
`state.print.targetPrinterId === 'mimaki-3duj-553'`. Each printer's `bed`
also seeds `state.print.bedDimensions` at project create / printer-switch
time (still a state field; printers.json is the *source*, state is the
*current value*, mirrors how `scale-presets.json` seeds initial scale defaults).

Ratio inputs in PrintPanel accept any positive `M:N` (or `M/N`) — both numerator and denominator parsed as floats. A bare `N` is shorthand for `1:N`. The stored value is `N / M`, so `1:72 → 72`, `2:1 → 0.5`, `3:5 → 5/3 ≈ 1.667`. Display:
- value `> 1` → `1:N` (N rounded, decimal if non-integer)
- value `< 1` → `M:1` (M = 1/value, decimal if non-integer)
- value `≈ 1` → `1:1`

This lets the user scale **up** (e.g. 2:1 for an oversized fit-test print) as well as **down** (1:72 model). Per-object `RescaleObjectCommand` and the export `exportFactor()` formula already operate on plain positive numbers, so no math changes are needed downstream.

### Cost quote (watertight-repair-and-cost task 6)

**File: `src/core/print/PrintCost.js`** (pure functions of an `ExportContext`
+ settings — never calls `getState()` itself) **+ `src/ui/print/CostBlock.js`**
(Export tab UI, kept out of `PrintPanel.js` to bound that file's growth).

**Export-tab presentation (2026-09-18).** A breakdown card, not a one-line
sentence: Volume · Weight (model g + support g) · Material (cost, with the
price/g actually used) · Support (cost, with the % used) · **Estimated
total** · **Packaging (W×D×H)** — the combined bounding box of every exported
object at the export ratio in print-space mm (`boundsForExportContext`, the
same bounds the readiness card and bed fit use; read at rest transform), so
the user can pick a mailing box — then an "Approximate · <reasons>" note VISIBLE in the card (the
reasons were a tooltip nobody hovered). Price / support-price / support-%
fields show the material default as their PLACEHOLDER when the stored value
is 0 and render blank — a field reading "0" while the quote charged 0.50/g
from the material default was the confusion; clearing a field returns to
the default (stores 0). `#pp-cost-total [data-cost="total"]` is the smoke
probe. No print parts ⇒ a plain "no print parts to quote" note.

**Material presets live in an EDITABLE FILE, never the bundle (2026-09-18,
`src/core/print/MaterialPresets.js`).** Web/dev: `public/config/materials.json`
(fetched at boot from `<base>/config/materials.json`, `cache: no-store`).
Desktop: `<userData>/config/materials.json`, seeded from the shipped copy on
first run by `electron/main.cjs` `config:read` (allowlisted names only;
`preload.readUserConfig`). The Cost block shows the resolved path with a copy
button and says which action applies (reload page / restart app). Values typed
into the panel change `state.cost` only and are never written back. The file
is validated (`parseMaterialPresets`: unique ids, density > 0, numeric
prices); a missing or malformed file loads a one-entry built-in fallback, logs
the reason and shows it under the path — never silent. Presets carry
`process` (FDM / Resin / SLS / Full-colour / Custom → `<optgroup>`), a `note`
(shown under the select) and the usual density / price / support fields.
`config/printers.json` no longer carries `materials[]` — only a
`defaultMaterialId` that must name a preset (`tests/hygiene.test.mjs`). The
shipped list: PLA, PLA+, PETG, ABS, ASA, TPU 95A, Nylon, CF blends, standard /
tough / water-washable / 8K resin, PA12 SLS, Mimaki MH-100 (placeholder
price — dealer-quoted), Custom.

**Pricing basis = conservative PRINT-SERVICE rates (owner decision
2026-09-19: "as a printer I must not lose money").** Not raw spool/litre
cost — that is 5–10× lower and is kept in each preset's `note` for reference.
Upper-middle of the 2026 survey: FDM 0.10–0.30 USD/g + 3–10 USD setup, nylon
/ CF +50–100 %, resin 0.20–0.50 USD/g + setup, SLS PA12 ~0.40 USD/g, full
colour 1–10 USD/cm³ at bureaus. Each preset also carries a **`setupFee`**
(flat per export job, added to the total, shown as its own row) — the
service minimum that a per-gram figure hides on small parts; `cost.setupFee`
in settings overrides it like the other fields (0 = preset's).

**Formula:** `total = volume(cm³) × density(g/cm³) × pricePerGram +
supportVolume × supportDensity × supportPricePerGram`, where
`supportVolume = volume × (supportPercent / 100)`. Per-unit density/price
resolve from the selected printer's `materials[]` row (§12 Printer
Profiles), overridden by any non-zero `state.cost.*` field (`0` means "use
the material default" — never "free"; see `config/default-settings.json`
`cost` section). `total` is `null`, not `0`, whenever density or price
cannot be resolved — a missing price must never read as free.

**Volume — summed per logical unit, NEVER Boolean-unioned:**
`unitVolumesMM3(ctx)` transforms each part's positions through its own world
matrix (mirroring `PrintPrep.flattenWorld`'s exact bake math) into print
space and takes the divergence-theorem signed volume (`PrintSpace.
signedVolume`), summing a unit's parts BEFORE `Math.abs()` (consistently
wound parts of one logical object accumulate correctly; the abs() only
guards the unit total). No CSG subtraction runs here — that is a
deliberate scope boundary from the task spec ("overlap = flag only, no
Boolean").

**Volume basis toggle (`cost.volumeMode`, 2026-09-19):** a two-button
segmented control above the result card switches the quote between
**`mesh`** (default — the enclosed volume above, what the printer actually
deposits) and **`bbox`** (each logical unit's own print-space AABB, W×D×H,
summed — how SLS / MJF nesting and many full-colour bureaus bill build
space). `unitBoxVolumesMM3(ctx)` reuses `_unitBoundsMM` (same pivot / ratio
/ unit math as the packaging row) and returns the same map shape as
`unitVolumesMM3` so `quote()` swaps them on `s.volumeMode`; the geometry
cache in CostBlock carries both (`vols` + `volsBox`) so the switch is
instant and never re-walks vertices. A box needs no watertight mesh, so
`bbox` reports `watertight`/`validated` true and never adds those reasons;
the overlap flag still applies (two boxes that interpenetrate are counted
twice, on purpose, like meshes). The Volume row relabels to "Volume
(bounding box)" and `quote()` returns `volumeMode` so the card can say
which basis produced the number. Per-user setting like the other cost
fields (SettingsStore), never written to `materials.json`.

**Overlap policy:** `overlappingPairs(ctx)` flags pairs of logical units
whose print-space AABBs intersect (0.01 mm epsilon) and marks the quote
`approximate` with an `overlap:N` reason — it is NEVER used to subtract
volume. Two overlapping parts are counted twice on purpose; the badge tells
the user the number is an over-estimate rather than silently under- or
over-correcting with a Boolean union.

The epsilon EXCLUDES merely touching boxes (`a.max - eps < b.min ⇒
separated`). Its sign was inverted until 2026-09-18 (review M6), so two
parts placed flush against each other — the normal kitbash / bed-layout case
— counted as an overlapping pair and marked every such quote approximate for
nothing. Boxes must interpenetrate by more than the epsilon to count.

**`approximate` reasons** (`quote(ctx, settings, material).reasons`, shown
as the `title` on an "Approximate" badge next to the total):
- `notWatertight:N` — N unit(s) carry an open `holes` or `nonManifold`
  result in the validation cache (`state.scene.validation`); dirty meshes
  still get a volume estimate, just a flagged one — repairing them first
  (§9 Watertight repair) both improves the number and clears the flag.
- `notValidated:N` — N unit(s) have NO cache entry, or a STALE one
  (2026-09-18, review CIA F5 / I11). "Never validated" was previously
  treated as watertight, so the quote presented an exact-looking number for
  geometry nobody had checked — and an open shell's signed volume is
  arbitrary. Same semantics as `PrintReadiness`' `validation-pending`, and
  its OWN reason so it is never double-counted as `notWatertight`.
- `overlap:N` — N AABB-overlapping unit pairs (see above).
- `noDensity` / `noPrice` — the resolved material is missing that field.
- `tooBig` — total triangle count exceeds `costTriangleCap()`, which tracks
  `caps.triangleBudget` (review M9 — this is a UI-responsiveness limit, since
  the quote recomputes on every keystroke, NOT the repair engine's
  `REPAIR_TRIANGLE_CAP`, which it used to borrow by coincidence). `quote()`
  bails out on `totalTriangles(ctx)` — an index-length read only — BEFORE
  `unitVolumesMM3`/`overlappingPairs` ever touch a vertex buffer, so a huge
  scene never pays for the full per-vertex pass just to show "—".

**Live recompute:** `CostBlock.js` re-renders on the same Export-tab refresh
events as the readiness block, plus an `input`-driven instant preview (reads
uncommitted field values straight off the DOM, no `setState`/save) so typing
a new price/support-% updates `#pp-cost-total` on every keystroke; `change`
(blur/Enter) commits via `SettingsStore.save()`.

**Per-size cost lines (task 1.18).** With two or more print sizes
(`print.exportTargets.length >= 2`) the cost card shows one
`.pp-cost-target-row` per size, labelled with `exportTargetLabel` and quoted
from `previewExportContext({targetIndex})` (volume · weight · total). Sizes
are alternatives, so there is no grand total and no packaging row; one size
or "as shown" keeps the single detailed quote.

### OBJ + MTL Export (Primary)

**OBJ geometry is written by `ObjWriter.encodeOBJ` (task 1.7) — no Babylon OBJExport.**
It goes through PrintSpace like every writer: `positionsToPrintSpace` +
`printIndices` (right-handed, Z-up, mm, CCW-outward), then, when the resolved
axis is `'y-up'`, `PrintSpace.zUpToYUp` ((x,y,z) → (x, z, −y); proper rotation,
det +1, so winding/chirality preserved). Normals use the same maps; UVs raw
(bottom-left origin). Axis = `ctx.prefs.objAxis` ∈ {'y-up','z-up'}, else
`getPrinterProfile(targetPrinterId).export.obj.axis`, else `'y-up'`
(`ObjWriter.resolveObjAxis`). For Y-up the composed Babylon→file map is
(−x, y, z) — identical to the former OBJExport output (verified against the
real serializer + trimesh +1000 mm³ for both axes). The file carries a
`# mixomesh export: millimetres, right-handed, <axis>` comment; `usemtl` uses
the same `objToken` name as the MTL `newmtl`; empty meshes are skipped.

Current implementation (orchestrator: `print/PrintPipeline.js`; serializer:
`print/ObjWriter.js`):
1. `_runExport('obj', options)` collects logical print units. A unit may contain
   one mesh or several internal material-split meshes from one Blender object.
   Every mesh clone still gets its own prep/validation pass.
2. Each clone gets `makeGeometryUnique()` before prep.
3. Format prep runs: `fallbackMaterial`, `flattenWorld`, `weld`,
   `optimizeIndices`, `createNormals`.
4. `ObjWriter.serializeOBJ(ctx)` calls `encodeOBJ(meshEntries, {axis, mtllib})`
   (see above); `mtllib` names exactly the paired `.mtl` entry.
5. Mixomesh generates the MTL file so `newmtl` names match OBJ `usemtl`
   material ids and PBR/albedo materials do not depend on Babylon
   StandardMaterial-only fields. Directive arguments (`o`/`g`/`usemtl`/
   `mtllib`/`newmtl`) are single tokens: `ObjWriter.objToken` collapses
   whitespace to `_` on BOTH files (parsers split on whitespace; "Base
   Color" used to lose its texture). MTL opacity is `d` only — never `Tr`
   (parsers disagree on its sense) — and `Kd/Ka/Ks/Ke` are clamped to
   [0,1]. Locked 2026-09-17 (Mimaki practice: OBJ+MTL+PNG is the primary
   hand-off; textured 3MF second).
   Winding: `printIndices` (same rule as STL/3MF/PLY) — verified outward
   (+volume) in trimesh for both axes (2026-10-14).
6. Real diffuse/albedo/base textures are encoded as PNG blobs under
   `textures/` from `collectTextureExportData`; user-loaded and restored
   textures resolve by `texture.metadata.mixoAssetId` so export prefers the
   captured full-resolution source instead of a capped GPU copy.
7. If `state.print.objBakeSolidTextures` is true, solid-color materials also
   get synthetic 4×4 PNGs and matching `map_Kd` MTL lines.
8. Output is always an outer `.zip`. Combined mode contains one OBJ, one MTL,
   and texture entries. Individual mode contains one OBJ/MTL pair per logical
   object, not per internal material split, plus shared texture entries.
9. Live scene meshes are never scaled or rewritten.

### 3MF Export

`exportThreeMF()` is selected by the explicit **3MF** export button. The
printer dropdown does not choose the 3MF sub-flavor.

Current implementation (orchestrator + dispatcher: `print/PrintPipeline.js`;
package writers: `print/ThreeMFWriter.js`):
1. `_runExport('3mf', options)` collects logical print units and clones every
   mesh inside each unit.
2. Format prep runs: `fallbackMaterial`, `flattenWorld`, `weldSolidOnly`,
   `optimizeIndices`, `csgSolidOnly`, `createNormals`.
3. `_serialize3MF(ctx)` inspects the prepared export clones:
   - if any mesh has a diffuse/albedo/base texture and UVs, it calls
     `buildMaterialsExtEntries()` so real image textures and UVs are preserved;
   - if the export is solid-only, it calls `buildColorGroupEntries()` for the
     lean filament-style `<m:colorgroup>` package.
4. Mixed exports use Materials Extension for textured meshes and colorgroup
   resources for solid meshes inside the same package.
5. Texture blobs resolve through `ExportTextures.getAssetIdForTexture()`;
   tagged user/restored textures use `texture.metadata.mixoAssetId` so captured
   full-resolution sources win over viewport-capped GPU copies.
6. A multi-material logical object writes as one 3MF `<object>` / build item.
   The writer concatenates the internal mesh vertex buffers and writes
   per-triangle material attributes (`pid` + `p1/p2/p3`) so shader boundaries
   survive without exposing split siblings as separate printer objects.
7. If the exported logical units still have `parentId` ancestry in
   `state.scene.groups`, `ThreeMFWriter` emits additional component objects:
   each logical unit remains a mesh resource, each included GroupNode becomes
   an `<object><components>…</components></object>`, and root build items point
   at the top component objects instead of every leaf mesh. Component transforms
   are explicit identity matrices because the existing prep pipeline already
   baked world-space millimetre placement into vertices. Component-object
   resources are emitted in dependency postorder (mesh resources, then child
   groups, then parent groups) so every `<component objectid="…">` references
   an object that is already defined, matching the 3MF Core producer contract.
   Topology is preserved without making the printer profile choose flattening.
   Individual-per-part 3MF export stays standalone by design and does not carry
   cross-part hierarchy.

**3MF package options (task 1.5).** PrintPipeline resolves writer options
from `ctx.prefs` + the selected printer profile (`_threeMFWriterOptions`);
ThreeMFWriter never reads state. **Split by material**: `ctx.prefs.splitByMaterial`
(boolean) wins, else `profile.export.splitByMaterial`, else ON for
`colour.mode` `per-part`/`paint`. On → a logical object with >1 material part
is one `<object type="model" name=part>` per part (colour/texture bound at
object level) plus a parent `<object name=object><components>` at identity
transforms; the build item / group component targets the parent. Off = one
merged `<object>` with per-triangle `pid/p1..p3` (Mimaki default).
**Metadata**: `<metadata>` Title (project), Application (`MIXOMESH`),
CreationDate (`YYYY-MM-DD`) unless `profile.export.threeMF.metadata === false`.
**Thumbnail**: one 256×256 viewport capture per export batch
(`FrameCapture.capturePng`, before clones exist, 5 s timeout; tests inject
`options.captureThumbnail`, `false` disables) → `Metadata/thumbnail.png` +
root rel of type `http://schemas.openxmlformats.org/package/2006/relationships/metadata/thumbnail`
+ png content type; any failure ⇒ no thumbnail, never an export error.
**Alpha**: when `profile.colour.alpha`, colorgroup colours are `#RRGGBBAA`
(AA = material alpha, absent ⇒ FF); else AA = FF. The loader ignores
metadata/thumbnail, accepts 8-digit colours, and imports a split parent as a
TransformNode holding the part meshes.

**Bambu/Orca flavour (task 1.11).** `flavour` = `ctx.prefs.threeMFFlavour ??
profile.export.threeMF.flavour ?? 'core'` (`_threeMFWriterOptions`); `'prusa'`
currently writes core. `'bambu'` (`ThreeMFBambu.js`, post-pass over the core
package): split-by-material forced ON and EVERY logical object written as a
parent `<object><components>` + one part object per material (even
single-material); no group hierarchy (flat build, one item per logical
object). Model: `requiredextensions="p"`, `xmlns:p` (Production 2015/06),
deterministic `p:UUID` on every `<object>`, `<component>`, `<build>`, `<item>`.
`Metadata/model_settings.config` (Bambu XML: object `name`/`extruder`, parts
`subtype="normal_part"` with `name`/`extruder`, one `<plate>`). Extruder slots:
first 4 distinct material keys (solid `#RRGGBBAA`, textured → texture path) in
first-appearance order → slots 1–4; more share slot 4 and raise
`onWarning({code:'3mf-bambu-slot-overflow'})` (→ console.warn).
`Metadata/project_settings.config` = JSON `{"filament_colour":[…]}`; thumbnail
also as `Metadata/plate_1.png`; `[Content_Types]` gains `config` (text/plain).
Textured content keeps the Materials Extension (rule 6); no per-triangle paint
(7.1). The loader ignores UUIDs/config; re-import = parent node + part meshes.

### Print-space axis + winding contract (ALL writers + the 3MF loader)
`src/core/print/PrintSpace.js` is the ONE seam between Babylon (left-handed,
Y-up) and print files (right-handed, Z-up, mm). Locked 2026-09-17 after the
audit found three writers using three conventions (3MF mirrored + upside-down,
STL mirrored + big-endian, OBJ inside-out) and every glTF import rendered
inside-out:
- `toPrintSpace(x,y,z) = (-x, -z, y)`, `fromPrintSpace(x,y,z) = (-x, z, -y)`.
  Both are reflections (det -1): Babylon's glTF loader bakes `(-x, y, z)` for
  the left-handed scene and slicers want `(x, -z, y)` of the glTF source.
- Winding is per mesh, never a blanket flip: `printIndices(mesh)` reverses
  only when Babylon's effective side orientation is ClockWise (glTF imports;
  material flag overrides mesh flag). A native/OBJ/STL/3MF-loaded mesh
  (CounterClockWise) is written as-is. Same rule as Babylon's own OBJ
  serializer. `PrintPipeline._csgRebake` resets the clone to CounterClockWise
  because Manifold output is native winding.
- `ImportNormalizer` bakes the reflection ONCE — Babylon's
  `bakeTransformIntoVertices` already flips faces on det<0; the old second
  `flipFaces` was the inside-out bug.
- Authority: PrusaSlicer 2.9.3 export of a known tetrahedron
  (`tests/fixtures/prusa-tetra.3mf`) + trimesh signed volumes; pinned in
  `tests/print-space.test.mjs`, `tests/threemf-components.test.mjs`,
  `tests/export.test.mjs`. Any change here re-runs those AND a real slicer.
- 3MF builds are centred in X/Y and rested on the bed (min z = 0).

### STL Export (Geometry-only fallback)
**Use `print/StlWriter.js`** (own binary writer). STL is geometry-only and
does not carry shader, texture, or per-part color metadata.

Current implementation:
1. `_runExport('stl', options)` clones logical print units and makes every
   clone geometry unique.
2. Format prep runs: `flattenWorld`, `weld`, `optimizeIndices`, `csg`,
   `createNormals`.
3. CSG2 is attempted only when available. Non-watertight parts skip CSG and
   report an informational toast; validation still gates hard errors.
4. `StlWriter.serializeSTL(ctx)` encodes prepared clones: 80-byte header,
   uint32 LITTLE-endian facet count, 50 bytes/facet (normal + 3 vertices as
   LE float32, attribute count 0), vertices through `PrintSpace`, facet
   normal from the emitted (outward) winding.
5. Combined mode emits one `.stl`; individual mode emits an outer `.zip` with
   one STL per logical object.
6. STL remains a fallback for non-color printer targets, not a Mimaki
   texture-preserving output.

### Export Gate
- Re-validate every object set to print via `MeshValidator.validateAllPrintParts()`.
- Errors → block, show the error-list modal (red — §9 *Pre-Export Gate*).
- Warnings only → the `exportGate` modal: **Fix & Export** (only when
  something is actually fixable — review I12) / **Export Anyway** /
  **Cancel** (amber — §9 *Pre-Export Gate* has the full state table and the
  `print.strictExport` contract).
- Bed-volume warning shown but does not block.

**Export Gate repairs clones (watertight-repair-and-cost task 4/5):** every
export clone is repaired on the fly during prep, REGARDLESS of the
three-way choice above or the `print.strictExport` setting — those only
decide whether a CONFIRMED-still-open clone blocks the export or just warns
after it succeeds. `ExportContext` carries two fields the pipeline mutates
as it goes: `repairReport: Array<{name, isWatertight: boolean|null, error?}>`
(one entry per clone the step touched; `isWatertight: null` means the attempt
threw mid-repair; `skipped: true` means the clone diagnosed CLOSED and was
deliberately left alone — review C1) and `repairSkipped: string[]` (names of
clones the repair attempted but could not confirm watertight — a subset
feeding the post-export `toast.exportedWithWarnings`, the SOLE owner of that
toast so the "Export Anyway" path never double-fires it). `strictExport:
true` throws BEFORE writing the file when any clone has `isWatertight ===
false` (confirmed open) — never on `null`/unknown, which is a repair-engine
problem (engine unavailable, or capped by `REPAIR_TRIANGLE_CAP`), not a
geometry one.

**The verdict describes the SHIPPED geometry (2026-09-18, review CIA F10).**
`csg` / `csgSolidOnly` run AFTER `repair` and replace the clone's geometry
wholesale with Manifold output, so the clone is RE-DIAGNOSED after a
successful re-bake and its `repairReport` entry (and its membership of
`repairSkipped`) updated. Otherwise the strict gate and the post-export toast
described pre-CSG geometry that is not what was written to the file. A
re-diagnose that itself fails leaves the verdict `null` — warned about, never
a strict-mode blocker, exactly like `_tryRepair`'s own error path.

---

### Print panel (overhaul 0.6 / 1.2 / 1.3 / 5.3)

Owner/integrator: merge into Blueprint.md at the anchors named below.

## §12 Printer Profiles — replace the parenthetical "(Apply/revert command + UI land in tasks 1.2/1.3; this section is the data contract.)"

**Profile defaults vs per-project settings (task 1.3, Decision 32).** The
profile-driven fields are ordinary per-project settings on `state.print`:
`exportFormat` (`'obj'|'3mf'|'stl'|'ply'|'wrl'`), `splitByMaterial`
(boolean), `objAxis` (`'y-up'|'z-up'`), `threeMFFlavour`
(`'core'|'bambu'|'prusa'`) and `bedDimensions`. Factory value of the first
four is `null` = "follow the selected printer profile" (also what every
project saved before 1.3 carries). There is no overrides map.
`src/core/print/PrintProfileSettings.js` (pure) is the single resolver:

- `formatKeyOf(printerFormat)` — printers.json format id → writer key
  (`obj-mtl`→`obj`, every `3mf-*`→`3mf`; the flavour is its own setting).
- `profileDefaults(profile)` — `{exportFormat: formatKeyOf(export.recommended),
  splitByMaterial: export.splitByMaterial || colour.mode ∈ {per-part, paint}
  (mirrors the 3MF writer fallback), objAxis: export.obj.axis, threeMFFlavour:
  export.threeMF.flavour, bedDimensions: bed when every axis is finite > 0,
  else null (Custom)}`.
- `effectivePrintSettings(print, profile)` — stored value when set and valid,
  else the profile default (an unknown stored value can never select a bogus
  writer).
- `modifiedFields(print, profile)` — `{field: profileDefault}` for every field
  whose effective value differs from the profile default, computed at read
  time (a later printers.json edit is reflected honestly). The bed counts
  only when the profile has a finite bed (a Custom bed is always the user's).

Commands (`src/core/commands/PrinterCommands.js`, re-exported by
HistoryManager):
- `ApplyPrinterProfileCommand(printerId)` — sets `targetPrinterId` and every
  profile-driven field to `profileDefaults` in ONE undo step (Custom keeps the
  current bed — no null axis is ever written, the floor/bed code needs finite
  dims). Selecting a printer runs it; **Printer default ↺** runs it with the
  current printer (the revert). Ctrl+Z after either restores the previous
  values, so Ctrl+Z after Printer default restores the user's overrides.
- `SetPrintSettingsCommand(patch, label)` — one undoable user edit of the
  per-project print settings (allow-list: `targetPrinterId, bedDimensions,
  exportFormat, splitByMaterial, objAxis, threeMFFlavour, objBakeSolidTextures,
  individually, referenceObjectId`; other keys are ignored). execute() marks
  dirty. A bed change rebuilds the floor, invalidates the bed-fit cache
  (`MeshValidator.invalidateAll`) and refreshes a visible bed preview, on
  execute AND undo.
- `SetReferenceObjectCommand(id|null)` — the explicit export reference
  (Decision 25); null = first printable object.

## §12 ExportContext — `ctx.prefs` (replace the `{objBakeSolidTextures}` typedef line)

`ctx.prefs` (frozen) = `{objBakeSolidTextures, exportFormat, splitByMaterial,
objAxis, threeMFFlavour, strictExport, individually}`; the four profile-driven
fields are EFFECTIVE values (`effectivePrintSettings`), so a user override
always wins over the profile and the writers' own profile fallbacks become
belt-and-braces. Pinned by `tests/export-context.test.mjs` ("ctx.prefs
reflects the OVERRIDDEN format, not the profile"). Follow-up for the
PrintPipeline owner: the strict gate still reads `state.print.strictExport`
(same snapshot) — switch it to `ctx.prefs.strictExport` so the pipeline reads
prefs in one place.

## Settings scope (Decision 15) — `## Per-user settings persistence` section

`SettingsStore` exports `PRINT_PROJECT_FIELDS = [targetPrinterId,
bedDimensions, exportFormat, objAxis, threeMFFlavour, exportTargets,
referenceObjectId, objBakeSolidTextures, splitByMaterial, individually]` and
`PRINT_USER_FIELDS = [strictExport, repairOnImport]` (+ the whole `cost`
slice). localStorage carries the per-user fields plus the last-used printer
setup (`targetPrinterId, bedDimensions, objBakeSolidTextures`) as a SEED for
a fresh boot / New project only (file wins on open); profile-driven
overrides, print sizes and the reference are never seeded, so a new project
starts on its printer's defaults. The Print ↺ reset restores the seed fields
AND returns the profile-driven fields + `individually` to factory (`null` /
false), leaving print sizes and the reference (project content) alone.
`default-settings.json` print gains `exportFormat/splitByMaterial/objAxis/
threeMFFlavour: null` and `individually: false`.
Open items for the persistence owner: (1) `strictExport` is per-user under
Decision 15 but `ProjectSerializer._serialisablePrint` still writes it into
the .mixo (only `repairOnImport` is stripped) — strip it on save and in
`_printWithoutLegacyScale` on load like `repairOnImport`; (2) the loader
merges the loaded print slice OVER the current one, so a document saved
before 1.3 (no `exportFormat`…) inherits the previous project's overrides —
default the missing profile-driven fields to `null` and `individually` to
false on load.

## §13 Print Panel (`src/ui/PrintPanel.js`) — replace the "Tabs: Scale / Validation / Bed / Export" line, the "The Scale tab shows…" paragraph and the "The Bed tab labels…" paragraph

Tabs: **Printer / Validation / Export** (segmented). The old Scale tab folded
into Export ("Print at"); the Bed tab became the Printer tab. Default tab:
Printer. Module split: `PrintPanel.js` = shell (tabs, strip, Validation tab,
export runner `_runExport`, gate + validation-error modals, `exportSelected`);
`ui/print/ReadinessStrip.js` (strip + shared issue list + issue labels),
`ui/print/PrinterTab.js`, `ui/print/ExportTab.js`, `ui/print/PrintSizes.js`
(Print at / Other sizes… / Reference), `ui/print/printLabels.js` (format
names/details, the "modified" marker), `ui/print/CostBlock.js`.

**Readiness strip (task 0.6).** One row at the top of EVERY tab, computed
from ONE `getPrintReadiness()` + ONE as-shown `previewExportContext({target:
null})` per render (shared with the tabs): status icon + word in its
functional colour (`print.readiness.<ready|warning|blocked>`), a monospace
readout "N to print · W × D × H mm" (first target's PrintSpace bounds), and a
sub-line = the most severe actionable issue (+ "+N more") or "Watertight and
inside the build volume". Info issues (mixed-scales) never colour the strip.
Clicking it routes to where the first issue is fixed; the all-clear strip
opens Validation. Routing (strip and issue rows): bed-overflow / below-bed →
Printer tab; no-print-parts / missing-source / missing-texture /
unit-unconfirmed → Layout workspace (File units live in Properties ▸ Object);
mixed-scales → Export; everything else → Validation; the first live related
object is selected. The full clickable issue list renders on the Validation
tab (under its status strip) and on the Export tab whenever there are issues.

**Printer tab (task 1.2).** Printer select grouped by vendor (`<optgroup>`
in printers.json order; vendor "—" shows as "Other"), the process name beside
the label; a spec list: Build volume (readout "X × Y × Z mm" for a named
printer, editable X/Y/Z inputs for a profile without a finite bed — Custom —
with placeholder "unlimited"; an empty/invalid entry restores the stored
value; edits are `SetPrintSettingsCommand`), Colour (sentence per
`colour.mode`), Recommended format (writer name + detail line). Then the
profile status line ("Profile defaults applied" / "N setting(s) changed from
the printer default" + **Printer default ↺** when any field is modified), the
Show-bed-volume toggle, and a quiet "Continue to Export". Selecting a printer
pushes `ApplyPrinterProfileCommand` — an apply-defaults action, undoable.

**Export tab (task 1.3, plan §4.3).** Top to bottom:
1. **Print at:** "the size shown (1:N)" where N = the reference's EFFECTIVE
   ratio (Decision 26), or the list of typed sizes ("1:144 · ×2 · 120 mm
   tall"), and **Other sizes…** which toggles the editor: one row per
   `exportTargets` entry (kind icon, label — monospace on the number only —
   whole-print W×D×H mm at that size, remove ×), an add form (segmented Scale
   1:X / Multiply ×N / Height mm, an affixed number field, Add; Enter adds,
   duplicates ignored) and "One file per size". Every edit is
   Add/RemoveExportTargetCommand (undoable). Editor/kind open state survives
   re-renders.
2. **Reference:** "<name> (1:N) [change]" — change opens a select of the
   printable objects plus "Automatic (first object)"; picking one pushes
   `SetReferenceObjectCommand`. When readiness carries `mixed-scales`, a note
   "Other objects keep their size relative to <name>." follows.
3. **Format** — segmented control with EVERY writer (OBJ · 3MF · STL · PLY ·
   WRL, `data-fmt`), never hidden or disabled by the printer or by readiness;
   a detail line (3MF detail follows the flavour); the contextual sub-row
   "OBJ up axis" (OBJ) or "3MF type" (3MF). Each profile-driven field shows a
   "modified" marker (`.pp-modified[data-field]`, tooltip names the profile
   value) when it differs from the profile; **Printer default ↺** sits on the
   Format header whenever anything is modified. Changes are
   `SetPrintSettingsCommand`.
4. Readiness issue list (when any).
5. **Cost** (5.3) — header "Cost · <material> ⚙"; the quote lines stay on the
   tab (one line per print size when there are several, 1.18); every cost
   input (material, prices, support %, setup fee, currency, volume basis,
   presets file line) lives in an anchored ⚙ popover (closes on Escape or an
   outside click; open state survives re-renders).
6. **▸ Advanced** disclosure ("N on"): Each individually (separate files),
   Split multi-material objects into parts (AMS / MMU) [+ modified marker],
   Bake solid colours to texture, Block export on non-watertight parts
   (strict), and — until 5.5 moves it to ? ▸ Preferences — Repair fixable
   issues automatically on import. Per-project ones are commands
   (persisted in the .mixo); strict + repair-on-import are per-user state +
   SettingsStore. Open state survives re-renders.
7. The ONE primary action, sticky at the panel bottom: **Export for
   <printer> (<FORMAT>)** (`data-act="export-primary"`), the effective
   `exportFormat`'s writer through the export gate (blocked → modal; warnings
   → three-way modal, default Repair & export), disabled with the recovery
   title when `canExport` is false. Options: `{ individually:
   print.individually }`. "Selected only" stays off this tab (2026-09-18
   decision) — the context menu's export-selected is the one-off path.

Design: monospace only for numbers (`.pp-num`); the stone-brown accent only
on the primary button; bengara only for the active segment cue and the
"modified" marker; hairlines and spacing instead of boxes; no fixed widths
beyond tokens.

## PART 13 — UI MODULES

### UI Rendering Safety Contract
String-template renderers are allowed for the no-build-step UI, but all
user-controlled or persisted values must be escaped before entering HTML.
This includes visible text and attribute values (`data-*`, `title`, `src`).
Badges and icons are rendered as trusted static markup beside escaped labels,
never by concatenating user text into an "HTML name" path. Thumbnail sources
from persisted project data are only rendered when they validate as
`data:image/png`, `data:image/jpeg`, or `data:image/webp` base64 URLs;
otherwise the panel falls back to its placeholder icon.

### Onboarding, ? sheet, Preferences (overhaul 5.5)

`src/ui/Onboarding.js` runs a 4-step coach (Import, select / enter groups, pick your printer, Export) as anchored bubbles with Next / Back / Skip tour. It auto-starts once per browser profile (`localStorage` `mx-onboard-v1`, storage access wrapped in try/catch) and replays from ? > Tour. The layer is click-through; only the bubble takes pointer events, and Esc or Skip dismisses it. ? > Keyboard shortcuts (the `mx:help-sheet` event, handled in `ProjectMenu.js`) opens a curated shortcut + mouse/touch sheet; ? > Preferences opens a per-user modal holding **Repair fixable issues automatically on import** (`print.repairOnImport`, SettingsStore per-user, never in the .mixo). That checkbox no longer appears on the Export tab. Styles: `src/styles/components/onboarding.css`.

### Import bake: shared vertex buffers (2026-09-18)
A glTF mesh whose primitives share a POSITION accessor (one vertex list,
several index lists — one per material) comes out of Babylon's loader as
separate Geometry objects on ONE shared VertexBuffer. `bakeImportTransform`
then baked that buffer once per primitive: unit scale applied twice (a
10 mm split cube imported at 0.01 mm) and the RH→LH reflection applied twice.
`_unshareVertexBuffers` copies every attribute of the second and later
sharers before the bake, so each bake touches its own data exactly once.

### Validation worker: exact weld keys (2026-09-18)
`MeshValidate.worker.js` packs the quantised position into one number. The
old packing used 3 × 21 bits = 63 bits — past JS's 53-bit exact integers —
so the low bits (the whole z component for anything under ~10 cm) were
rounded away and vertices differing only in z welded together: a closed cube
reported a non-manifold edge and every real model's `nonManifold` count was
garbage. Now 3 × 17 bits (±6.5 m at 0.1 mm) with a string-key fallback
outside that range. Pinned by `tests/validator.test.mjs`.

### Outliner (`src/ui/Outliner.js`)
- Renders unified tree from `state.scene.objects` + `state.scene.groups` + `state.scene.collections`.
- Row type is explicit: Collection/import provenance uses `Package`, a real
  TransformNode group uses `GitBranch`, and geometry uses `Box`. Picking in the
  viewport selects only the Object; it expands and reveals the object's
  Collection/Group ancestor path without selecting those ancestors. Clicking a
  Collection or Group row selects its live descendant Objects.
- Row icons use `Icons.icon(name, attrs)` — see Part 2. Validation status
  badges (warning/error, stale-dimmed) read the §9 A6 cache and render as
  trusted markup after the escaped name, INSIDE the `.ol-name-cell` wrapper:
  the row is a six-column grid (twirl · icon · name-cell · eye · lock ·
  print) and a badge rendered as a sibling of `.ol-name` used to take the
  lock/print column and push the print button onto a second grid row.
- **Parts vs objects; Separate by material / Merge (2026-09-18).** A multi-material
  import is ONE logical object made of several `SceneObject` parts (lead +
  `isInternalPart` siblings linked by `logicalObjectId`); the Outliner shows
  the lead only and its name drops the loader's `_primitive<N>` / `__part<N>`
  suffix. Separation is explicit and undoable, never automatic (Blender
  Separate/Join, PrusaSlicer Split to parts): context menu **Separate by material**
  (`SplitToPartsCommand`) makes every part an independent object under a new
  group named `<lead> parts` (unique among groups; nested under the lead's
  previous parent), the lead keeps its name and the other parts are named
  `<lead>.001`, `<lead>.002`… (unique among objects); **Merge into one object**
  (`JoinCommand`) makes the active object the lead and every other selected
  object — with its own parts — a material part, meshes and transforms
  untouched. Join keeps the hierarchy consistent: a `<lead> parts` group that
  holds only the joined members is dissolved (children rise to its parent) and
  any part sitting under a different parent moves next to the lead; undo
  restores both. Everything that iterates parts dedupes by `canonicalObjectId`
  (`collectPrintUnits` resolves selected parts to their lead — one unit per
  logical object; `validateAllPrintParts` is keyed by the lead), and
  `PrintPartCommand` on any part sets the flag on every part of the logical
  object as ONE undo step. Neither command touches
  geometry, shaders or `geometryFixes`; both only change the linkage flags
  (and, for Separate, the Outliner parent). The header toggle **Show material
  parts** (per-user, `localStorage` `mx-outliner-parts-v1`) lists a lead's
  parts as read-only rows (`data-kind="part"`): click selects the lead,
  right-click acts on the lead, no rename / drag / buttons.
- Lock / print toggles read at a glance when ON: a filled pill (warning
  colour for lock, accent for print) with the icon in the reversed colour.
  A colour-only change on a 13 px icon was invisible on the washi ground
  (owner feedback 2026-09-18). The Properties ▸ Print Export section carries
  the same flag ("Include in print export") plus a hint line saying what
  off means (stays in the scene, left out of export / validation / cost).
- Drag-to-reparent: Object and Group rows are draggable hierarchy sources.
  Dropping on a Group row pushes `ReparentCommand(sourceId, groupId)`;
  dropping on empty Outliner space pushes `UnparentCommand(sourceId)`.
  Collection rows are not parent targets. The UI calls
  `validateParentChange()` for drop affordances, so invalid self/cycle/missing
  parent targets do not highlight and no raw state mutation bypasses commands.
- Multi-select: `Shift+click` add, `Ctrl+click` toggle. Dispatch `SELECTION_CHANGED`.
- Double-click row name → inline rename (text input, blur/Enter commits via `RenameCommand`; collections via `RenameCollectionCommand`).
- The search bar filters by Object, Group, or Collection name. A matching
  Object keeps its complete ancestor path visible; clearing search restores the
  unfiltered tree without changing selection.
- Ghost rows: red `CircleAlert` icon. Relink runs from both the unmatched-assets
  modal and the object row/viewport context menu.
- **Row layout** uses a 6-column grid: `[indent] [type-icon] [name] [visibility] [lock] [print-part]`. The print-part column shows a `Printer` icon button on object rows (highlighted amber when `isPrintPart: true`); group rows get a blank placeholder span to keep alignment. Clicking the icon toggles `isPrintPart` via `PrintPartCommand`.

#### Collections (Blender-style import buckets)

A **collection** is a display-only outliner container per imported file. It carries no scene-graph weight — it's purely metadata used to route rendering. Each `AssetLoader.loadFromBlob` / `instantiateAsset` call mints one new collection named after the source filename (with `.NNN` suffix when the name is already taken). Members are tagged via `state.scene.objects[meshId].collectionId`.

`CollectionEntry` schema: `{ id, name, sourceFile, sourceAssetId, createdAt }` (state.scene.collections[id]).

**Render rules** — these resolve the group ↔ collection conflict cleanly:
1. Compute each group's "collection signature" by walking its leaf meshes' `collectionId` tags. Either `null` (no leaves tagged), a single collectionId (homogeneous), or `'mixed'` (multiple).
2. **Collection-homogeneous groups** nest inside the collection's expander.
3. **Mixed-collection groups** render at the outliner root (not inside any collection) with a `Mixed` badge next to the group name. Their members keep their original `collectionId` tags — the group is just routing display.
4. **Standalone (no group) objects** render inside their `collectionId` container, or at root if untagged.
5. Empty collections auto-hide (no row when 0 visible children).
6. Empty user-created groups remain visible with an `Empty` badge. Empty
   imported groups are removed by the lifecycle contract in §AssetLoader
   GroupNode / `DeleteCommand`, so rendering never needs to mask stale state.

The `Mixed` badge is static sibling markup after the escaped group-name span,
so inline rename reads only the actual group name and never treats the badge
as editable text.

Collection row interactions:
- Click name → select every mesh with that `collectionId` (descends across groups).
- Click chevron → toggle collapsed state in `ui.outlinerCollapsed[colId]`.
- Double-click name → inline rename through `RenameCollectionCommand`
  (dispatches `COLLECTION_RENAMED`; undoable).
- RMB → context menu: **Select Members**, **Rename Collection…**, **Delete Collection** (the last untags every member, leaving them visible as "uncollected" at outliner root; the collection entry is then removed from state).

Object/group context navigation adds **Select Parent Group**, **Unparent**,
**Select Siblings**, **Select Import Members**, and **Reveal in Outliner** where
the target supports them. Because selection stores geometry ids only, selecting
a parent group means selecting all of that group's live descendant Objects; it
does not make the meshless TransformNode an active geometry object.

Outliner row events are delegated from `#ol-list`; rows are not individually
re-wired on every render. Rows expose `role="treeitem"`, `tabindex="0"`, and
`aria-expanded` where applicable. Enter/Space activates the row like a click,
F2 begins inline rename, and ArrowLeft/ArrowRight collapse or expand collection
and group branches. Object rows still own shader drop targets, but the drop
handler is delegated and routes assignment through `ShaderAssignCommand`.
Hierarchy drops are a separate MIME payload from shader drops.

### Properties Panel (`src/ui/PropertiesPanel.js`)
Subscribes to `SELECTION_CHANGED`. Renders sections for Active Object:
1. **Object** — name, visible, locked
2. **Transform** — per-object **Ratio** dropdown (scale ratio, `RescaleObjectCommand`), Position XYZ (mm), Rotation XYZ (deg), Scale XYZ. Tab/Enter commits via `TransformCommand` (node transform — never baked, so it stays editable + persists). On multi-select, fields show `—` when values differ; editing applies delta. Editable **Size (mm)** row derived from world AABB (so a wrong-unit import is visible). (The old "Apply Rotation/Scale" bake-to-vertices buttons were removed 2026-06-16 — they destroyed the editable, persisted transform and were lost on reload.) **Scale lock** (default on, toggled via icon below the Scale row) makes per-axis edits mirror proportionally across XYZ; the viewport scale gizmo's per-axis arrows are hidden in this mode so only the central uniform handle remains (`SceneManager.setScaleLock`).
3. **File units** — dropdown + `AlertTriangle` if unconfirmed + "Looks right" button.
4. **Shader** (Phase 4, binding-only) — Lists distinct shaders bound to current selection as **slots**. Active mesh's shader appears first. Multi-selection across meshes with different shaders → one slot per shader. Per-slot UI: texture thumbnail chip or color preview, shader name, linked mesh-count badge, combined `<select>` with optgroup "Replace with → [list of all scene shaders]" + synthetic action "Duplicate in place". Click chip/name area → Library `focus(shaderId)`. **No color picker, sliders, or UV inputs here** — those live only in the Shader Library. Properties Shader is binding-only.
5. **UV Override** — offset/scale/rotation inputs per-mesh; "Reset to Default" button. Mesh-specific UI.
6. **Print** — export toggle.
   (Validation results are NOT a Properties section — they live in the
   Print ▸ Validation tab + Outliner row badges, both fed by the §9 cache.)

With no object active the panel shows only a "click a mesh" hint — Properties
is object-scoped. Scene-wide settings (grid styling, grid/axes visibility,
render look) live in the **Scene Panel** (`#rp-scene`, see below) so they stay
reachable while something is selected.

### Copy active-to-selected — ↧ buttons (shipped post-Phase-7, 2026-05-18)
Single header-level `↧` button on the **Transform**, **Shader**, and **UV
Override** sections. Visible only when `Selection.getSelectedIds().length > 1`
(and, for Shader, only when the active mesh has a binding to propagate).
Clicking the button copies the active mesh's value(s) to every OTHER selected
mesh in **one undo step**:

- **Transform** — single `TransformCommand(prev, next)` keyed by meshId; prev
  is each target's absolute pos/rot/scale before the copy, next is the active
  mesh's `_readTransform(...)` snapshot. Whole-section copy only — there is
  no per-axis variant (the original spec's per-axis flavour was dropped as
  premature for the actual use case, which is "make these match").
- **Shader** — `ShaderAssignCommand(targetIds, activeShaderId)`. The command
  is already multi-mesh-native; targets already bound to the same shader are
  filtered out so the diff is the change set, not the selection.
- **UV Override** — `UVOverrideCommand` is single-mesh, so N pushes are
  wrapped in `beginBatch('Copy UV Override') / endBatch()`. If the active
  mesh has no override, the copy *clears* each target's override (symmetric
  with "Reset to Default" applied across the selection). Equal-value
  targets are skipped.

The ↧ button lives inside `<header class="pp-section-header">`. The header
also owns the section collapse-toggle, so each copy click handler calls
`e.stopPropagation()` to keep the section open. CSS: `.pp-copy-btn` in
`src/styles/components.css` (transparent, border, accent on hover).

The earlier "File units" copy variant was dropped — File units edits
bake into vertex data per-asset, not per-mesh, so a copy-from-active makes
no sense at the Properties level.

### Shader Library (`src/ui/ShaderPanel.js`)
Renamed from "Shader Panel" in Phase 4. Right-panel lower section.

- **Scene Shaders list:** row per shader with texture thumbnail (if `diffuseTextureAssetId`) or color chip, name, linked mesh-count badge. Hover → small Duplicate button.
- Shader rows are draggable material assets (`application/x-mixomesh-shader`) and can be dropped onto Outliner object rows; assignment routes through `ShaderAssignCommand` so it is undoable and follows the same material-sharing rules as button/modal assignment.
- **Create new:** `+` button in header creates a Standard material shader.
- **Inline editor:** Click any row to open editor below the list. Fields: type toggle (`Standard` / `PBR` / `Unlit`), diffuse color picker + hex field, texture slot with drop-target + Pick… button (opens texture modal grid), opacity / roughness / metallic sliders, UV-base inputs (offsetX/Y, scaleX/Y, rotation), action row (Duplicate / Assign / Select Linked / Delete). All edits update viewport live and are undoable.
- **Texture pick modal:** Click Pick… → grid of every loaded texture (including imported glTF-embedded ones). Click texture → assigns, modal closes. Also shows "Swap…" and clear button on loaded state.
- **Swatch palette:** DEFAULT_SWATCHES from `src/config/swatches.json` (Primer / Military / Metals / Miniatures) + User section with `+` button to capture current editor's color. Click swatch → `ColorApplyCommand` pushed.
- **Merge modal:** When `registerFromContainer` encounters material-name collisions → modal with per-conflict radios (Use existing / Rename import / Replace scene shader) + "Apply to all" checkbox.
- **Auto-focus:** Subscribes to `ACTIVE_OBJECT_CHANGED`. When active object changes, `ShaderPanel.focus(shaderId)` is called UNLESS an `<input>` / `<select>` / `<textarea>` inside the Library has DOM focus (prevents focus theft mid-edit).
- **Sub-sections:** All collapsible via chevron headers (Scene Shaders, Editor, Swatches). Collapse state is session-only, lost on reload (`ui/lib/sections.js createCollapseController` without a storageKey — same controller as Properties/Scene).

### Asset Panel (`src/ui/AssetPanel.js`)
- Bottom-docked, resizable.
- Uses `src/core/assets/AssetTypes.js` for canonical supported mesh/texture
  extension lists and extension parsing; the panel must not carry divergent
  local extension tables.
- `AssetIndex.scanAssetMount(storage, mount)` recursively reads opaque adapter
  refs exactly once on mount/refresh and returns frozen `files` / `folders`
  projections. Each file row carries `mountKey`, display-relative `path`,
  mount-root-relative `sourcePath`, `assetKind`, and an opaque live `ref`.
  Rendering and searching use `queryAssets`; neither touches the filesystem.
  Rows deduplicate by `mountKey:path` and sort deterministically by name, path,
  then mount. `nearestFolderPath` preserves selection across refresh or walks to
  the nearest surviving ancestor.
- Left column: a two-tab switcher (built ONCE in `init` — `src/app/main.ts` appends the
  panel-collapse button into `.ap-tree-header`, so the header element must
  survive re-renders; only `#ap-tree-list`, `#ap-grid-summary`, and
  `#ap-grid-body` re-render).
  - **Session** tab — smart views `All`, `Used`, `Unused`, and `Issues` over all
    assets registered to *this project's* `assetLibrary`
    (loose drops + folder loads, regardless of source). Per-card **Linked /
    Snapshot** badge derived from `!!(asset.directoryHandleKey || asset.fileHandleKey)`.
    Mount button is also hidden on this tab — mounting belongs to Library.
    Drag from a Session card uses `mountKey: SESSION_KEY`; ViewportDrop
    re-instantiates the existing AssetContainer (no reload, identical to a
    "Duplicate" via drag).
  - **Asset Library** tab — the *mounted folder browser*. Same lifecycle as a
    cross-project folder (browser re-mounted via `last_mount_dir` on boot, see
    §11 Boot behaviour; desktop tokens are session-only). Tree of multiple mount
    roots + subdirectories. Mount, refresh-selected, and unmount-selected actions
    are visible.
    Drag from a Library card carries the directoryHandleKey + relPath; the drop
    handler loads through `AssetLoader.loadFromHandle` so it registers as a
    Linked asset in this project's Session.
- Right column: breadcrumb + thumbnail grid. Library cards show their relative
  provenance path so identically named files remain distinguishable.
- Right-column filter controls are built once and persist across grid renders:
  a search input filters by filename/path, a scope select chooses This folder /
  Folder + subfolders / All libraries, and an asset-kind select filters All /
  Meshes / Textures. Normal browsing shows direct children only. Starting a
  search defaults scope to descendants unless the user explicitly selected a
  scope. The grid summary reports shown vs total assets.
- Card: name, extension badge, source-unit badge (with warning icon if
  unconfirmed), and on Session — Linked/Snapshot link-status badge.
- Tree rows and cards escape all `data-*` attributes before writing HTML;
  drag payloads are reconstructed from `dataset` after the browser decodes
  those values.
- Double-click → Session: `instantiateAsset(assetId)` at origin; Library:
  `loadFromHandle(...)` at origin (or `loadTextureFromHandle` for textures).
- Mounting a folder auto-switches to the Library tab. Refresh rebuilds only that
  mount's index and keeps the selected folder or nearest existing ancestor;
  unmount discards only the in-session source, never project assets.
- Event handling is delegated from `#ap-tree-list` and `#ap-grid`; card and
  folder-row listeners are not re-created per render. Folder rows are
  `role="treeitem"` with `tabindex="0"` and support Enter/Space activation plus
  ArrowLeft/ArrowRight collapse. Asset cards are keyboard-focusable
  `role="button"` controls; Enter/Space performs the same origin load as
  double-click. This keeps large mounted folders responsive and preserves
  keyboard access.
- **Rationale for the split:** Session and Library answer different questions.
  Session = "what is this project made of?" — the working set, mixed
  provenance. Library = "what is in my reusable folder?" — content-addressable,
  cross-project, exists independently of whether this project uses any of it.
  Conflating them (the original single-tree design) made the empty state
  ("Session is empty / mount a folder") imply that mounting is required to
  drop files, which is false — loose drag-drop is fully supported.

### Viewport Drop (`src/ui/ViewportDrop.js`)

Attaches drag/drop listeners to `#viewport` after `SceneManager` is ready.
It owns the position handoff from browser drag events to asset loading.

Supported drop sources:
- Asset Panel session card: custom MIME `application/x-mixomesh-asset` with
  `mountKey: '__session__'` and `path = assetId`. Calls
  `AssetLoader.instantiateAsset(assetId, position)`.
- Asset Panel library card: custom MIME with `mountKey`, relative `path`, and
  mount-root-relative `sourcePath`. Retrieves a handle-shaped adapter wrapper via
  `AssetPanel.getFileHandle(mountKey, path)`, then calls
  `AssetLoader.loadFromHandle(handle, position, { directoryHandleKey:
  mountKey, originalPath: sourcePath })`.
- OS file explorer: reads `DataTransferItem.getAsFile()` and, while still
  inside the synchronous drop event, captures the Chrome-only
  `getAsFileSystemHandle()` promise. Mesh extensions are checked through
  `AssetLoader.isMeshExt(ext)`; unsupported files show a warning toast. Valid
  files call `AssetLoader.loadFromBlob(file, file.name, position, { fileHandle })`
  when a file handle exists, giving loose drops the tier-3 relink path in §11.

Drop position:
- Use `scene.createPickingRay()` at the drop coordinates.
- Prefer ray intersection with the `grid` mesh.
- Fallback to analytic intersection with the `y = 0` plane.
- If the ray is parallel or behind the camera, use `BABYLON.Vector3.Zero()`.
- Multi-file drops and multi-file Import picks are **staggered along +X**
  (overhaul 5.6): file N+1 lands at `placedMaxX + 10 mm + placedWidth/2`
  (`staggerNextX`) — exact for models centred on their origin, a heuristic
  otherwise. A cancelled/failed file does not advance the position.

All async **import** work runs through `safeImport` (`src/ui/ImportError.js`) —
a `safeAsync` variant that, on failure, opens the `importError` detail modal
(filename + plain-language hint + collapsible technical stack) instead of a
transient toast, so a failed model/texture import is actionable. Both import
entry points use it: `ViewportDrop` (OS drop + Session/folder drag) and
`AssetPanel._activateCard` (double-click). The module does not keep state and
does not maintain its own extension table.

### Context Menu (`src/ui/ContextMenu.js`)
Triggered by RMB. Items per Part 12 of v3.0 (Group/Ungroup/Duplicate/Replace with active/Copy placement from active/Set Shader/etc.). Cursor actions include selection-dependent `Selection → Cursor` and `Cursor → Selection`, plus always-enabled `Cursor → World Origin` for the global cursor reset. All visible menu labels use `context.*` i18n keys so the menu renders in the active locale each time it opens.

**Empty-space right-click (2026-09-19).** The canvas suppresses Chrome's own
menu (`InputManager` `contextmenu` preventDefault). When nothing is under the
cursor (`info.hit === false`, set by `InputManager._onContextMenuRMB` from the
mesh pick) the menu is the short SCENE menu — 匯入模型… (`ViewportDrop.
promptImport`), 開啟專案…, 聚焦全部, 游標→世界原點 — not thirty greyed-out
object actions; with a selection the object actions follow under a
separator. Pinned by `tests/browser-smoke.mjs`.

### Print Panel (`src/ui/PrintPanel.js`)
Tabs: Scale / Validation / Bed / Export (Thickness + Orientation future).
Validation reads the §9 A6 cache with an explicit "Validate All".

**Validation tab status strip (2026-09-18).** The tab reports on itself
rather than through toasts: a strip above the buttons shows (a) while a
Validate All / Repair all / per-result Repair runs — an inline progress
bar + "Repairing… — <name>" patched in place from the `onProgress`
callback (no full re-render mid-run, buttons disabled); (b) afterwards —
the outcome line ("Repaired N object(s): H hole(s) filled, M non-manifold
edge(s) fixed" / "Repair failed for: …" / "Validated N part(s): K with
issues") in success / warning / error tone; and (c) always — the live scene
summary from the cache ("All N print part(s) clean — watertight and ready
to export" / "N parts · K with issues · F auto-fixable" / "K not validated
yet"). The outcome line is dropped on the next import or object removal
(it described a scene that no longer exists); the summary stays live. Every
button routes through `RepairSession.repairObjects` (one shared path;
`geometryFixes` recording + `markDirty` live in `RepairSession`, not the
panel). "Repair all (N)" carries its fixable count and is hidden — really
hidden: `.pp-export-btn[hidden]{display:none}`, the class's `inline-flex`
used to beat the attribute — when nothing is fixable. Per-object
validation toasts carry `tag: validationTag(meshId)` and `Toast` dismisses
that tag on every `VALIDATION_COMPLETE` for the object, so a "click to
Repair" toast never outlives the repair it offered.

The Scale tab shows the export reference object's exported size in mm; the
internal BU→mm factor is not user-facing and is no longer printed.

Repair feedback (2026-09-18, owner ask): every repair — Validate All /
Repair all / per-result Repair in the tab, the Outliner badge, the context
menu and the status-bar Fix button — runs under the BLOCKING
`ProgressOverlay` with title, percentage and current object
(`RepairFeedback.repairWithOverlay` for the non-tab surfaces; the tab also
patches its inline strip), and reports the outcome afterwards (tab strip /
`reportBatchRepairResult`). The status-bar "not watertight" badge carries a
`Fix` action (`StatusBar.setCenter({ action })`) whenever a cached result is
auto-fixable; it repairs the selection's logical objects.

Sweep extras (2026-09-18): the status-bar HUD segment is localised
(`hud.tris` / `hud.sel` / `hud.watertight` / `hud.notWatertight`, re-rendered
on `LOCALE_CHANGED`; English values stay `tris` / `sel` so the smoke pins
hold); `.modal-content` carries its own padding (the shell has none — the
export-gate, validation-errors and import-error modals sat flush on the
edge); the context menu clamps to the window synchronously (a rAF clamp
never fires in a background tab) with a `max-height` + scroll fallback.
Display modes (print-preview matte, wireframe edges + colour) live in the
viewport toggles under the NavCube — see Viewport Toggles below — so they
work from every workspace; there is no Preview tab.

**What the Export tab writes is the 列印匯出 flag, and only that (owner
decision 2026-09-18).** The former "Selected only" checkbox is gone: it was
a second, transient answer to "what gets exported" that silently overrode
the flag while the readiness card and cost quote above it still described
the flagged set. A one-off export of the selection is the context menu's
**匯出所選物件…** (format chooser modal → `PrintPanel.exportSelected(format)`
→ the shared `_runExport` gate/overlay with `{ selectedOnly: true }`);
`collectPrintUnits(state, true)` then takes the selection AS the intent and
ignores the flag. Readiness and cost always match the file the tab produces.

The Bed tab labels printer choices **Printer**: choosing one only
seeds `print.bedDimensions` and the viewport volume. The Export tab always
keeps OBJ, 3MF, STL, PLY, and WRL actions visible; when `readiness.canExport === false`
all export buttons render disabled with the same recovery title rather than
failing late or hiding a format. Above them it renders one derived readiness
card with a summary per requested ratio, a blocking-state recovery hint, and
stable issue records:
`no-print-parts`, `missing-source`, `missing-texture`, `unit-unconfirmed`,
`geometry-error`, `geometry-warning`, `bed-overflow`, and `below-bed`.
Geometry/source/texture errors block export; bed overflow, below-bed geometry,
unconfirmed units, and geometry warnings require an explicit Export Anyway
acknowledgement. Clicking a fit issue opens Bed; clicking a geometry issue
opens Validation; clicking no-print-parts/source/texture issues switches to
Layout so the user can import, relink, or pick the affected asset. Issue rows
select their first live related object when one exists.

**Export gate (Decision 18, task 1.8).** Readiness `error` issues always
block. `warning` issues block unless the caller passes `acknowledgeWarnings:
true`; `_runExport` enforces this itself before any side effect and throws
`{needsAcknowledgement:true, code:'EXPORT_NEEDS_ACKNOWLEDGEMENT',
readinessIssues}`, which the panel turns into the three-way modal (Repair &
export [default] / Export anyway / Cancel) and re-calls with
`acknowledgeWarnings:true`. `info` issues never need acknowledgement. Under
`strictExport`, any clone whose post-repair watertight verdict is not
confirmed true (open, unknown, engine unavailable, `repair:false`) aborts with
`validationErrors` ("could not verify watertight" for unknown).

**Per-printer readiness hints (task 1.4).** `buildReadiness({parts, targets,
bedDimensions, reference, profile, strictExport})` adds four profile-driven
codes (limit 0/absent = no limit): `texture-too-large` (warning; a part's
diffuse texture longer side > `colour.maxTextureSize`, sizes from the frozen
source via `ExportTextures.getTextureDimensions`), `texture-count` (warning;
distinct diffuse textures per object > `colour.maxTexturesPerObject`),
`thin-feature` (warning; validator thickness proxy × `target.scaleToMM` <
`validation.minWallMM`, else `minFeatureMM`, per target ratio — an advisory
estimate per Decision 21), `watertight-required` (warning, ERROR under
`print.strictExport`; only when `validation.requireWatertight` and a FRESH
validation found holes/nonManifold — unknown never raises it). Parts carry
`textures[{assetId,width,height}]`, `thicknessBU`, `watertight`; targets carry
`scaleToMM = ratioFactor × unitFactor`. `MeshValidator.estimateThickness` =
`min(3|V|/A, min bbox extent) × worldScale` for closed meshes (one O(tris)
pass); cache entries gain `thicknessBU`; a `thinFeature` INFO result is added
only under 3 mm at the size shown. `info` issues (`mixed-scales`) show an Info
icon, never change status. Each code has `print.issue.*` + `print.issueAction.*`.

`BedFit.checkBedFit(bounds, bed)` compares millimetre print coordinates against
the positive slicer volume `0..X, 0..Y, 0..Z`. `PrintReadiness` converts the
centred Babylon bed (`X`, world `Z`, world-up `Y`) into that coordinate space,
applies the same pivot-anchored target-ratio scaling as `PrintPrep.flattenWorld`,
and returns `{ fits, overflowMM:{x,y,z}, belowBedMM }`. Readiness is a projection,
never persisted, and its `formats` includes all five writers `['obj','3mf','stl','ply','wrl']` regardless of
the selected printer (task 1.4/1.6).

### Viewport Toggles (`src/ui/ViewportToggles.js`)
Docked under the NavCube (`#viewport-toggles`). A mutually-exclusive **display-
mode** selector + independent **overlay** toggles — the MODE/OVERLAY split:
modes replace how the surface shades (only one at a time), overlays layer on top.
- **Display mode** `<select>` — **Shaded** · **Matte** (print preview, removes
  metallic → `setOverlay('printPreview', on)`) · **Base Color** (flat albedo,
  what Mimaki inks — PBR `unlit` / Standard `disableLighting`+emissive →
  `setOverlay('baseColorView', on)`) · **UV Checker** (swaps each CONTENT
  material's base texture for a shared checker — shows UV density/seams; flat =
  no UVs → `setOverlay('uvCheckerView', on)`). `_setMode` always drives ALL THREE
  mode overlays so picking one clears the others. All modes are VIEWPORT-ONLY +
  export-safe — they store/restore per material exactly like print-preview's
  metallic swap; export reads the frozen source textures/materials, never the
  checker/unlit override.
- **Wireframe edges** overlay (`MeshTriangle`) → `setOverlay('wireframeEdges', on)`,
  + an **edge-colour** swatch shown only while it's on.
- **Inverted / back-face check** overlay (`AlertTriangle`) → `setOverlay('invertedFaces', on)`
  → `scene/BackfaceCheck.js`: a shared-geometry red back-face clone per content
  solid (front culled via flipped `sideOrientation`, no `meshId`), so any RED
  visible from outside = a hole or inverted face. Viewport-only; re-applied on
  `ASSET_INSTANTIATED` / `PROJECT_LOADED` when on; disposed when off.
State lives in `state.scene.overlays` (silent writes). Re-renders on
`PROJECT_LOADED` / `PROJECT_NEW`. Mode overlays re-applied on `ASSET_INSTANTIATED`
so late imports pick up the active mode.

### Shared panel-wiring helpers (`src/ui/lib/`)
Two helper modules (2026-07-17 maintainability restructure) fold the wiring
boilerplate the right-side panels used to hand-roll. Deliberately minimal —
NO panel-init/locale framework (2-line boilerplate is cheaper than a
framework; locked in the restructure plan).

`fields.js`:
- `escEnter(input, onEscape?)` — Enter commits (preventDefault + blur →
  'change' fires), Escape runs the panel's revert (usually `_render`,
  sometimes a value restore). Omit `onEscape` for Enter-only (CursorPanel).
- `wireNumbers(root, selector, apply, { onInvalid?, onEscape?, parse? })` —
  'change' → parse (default `parseFloat`); non-finite → `onInvalid(input)`,
  else `apply(input, value)`. Keyboard handling is opt-in via `onEscape`
  (UV-override fields have none — matches pre-helper behavior).
- `wireSelects(root, selector, apply)` — 'change' → `apply(sel, sel.value)`.
- `wireToggles(root, selector, apply)` — aria-pressed BUTTON (click) or
  checkbox ('change'), per the checkbox→toggle audit; `apply(el, next)` gets
  the value to APPLY. Caller chooses `reflectToggle` in place vs a full
  re-render when the toggle gates dependent rows.
- `reflectToggle(el, on)` — repaint a toggle button (`pp-toggle-on` class +
  aria-pressed); no-op for checkboxes.

`sections.js`:
- `createCollapseController({ storageKey?, defaults? })` →
  `{ isCollapsed(key), toggle(key), wire(rootEl, { sectionSelector,
  collapsedClass, datasetKey? }) }`. `storageKey` null = session-only
  (Properties/Shader); string = per-user localStorage (ScenePanel — NEVER in
  .mixo). `wire` applies stored state to fresh markup and binds
  `:scope > header` clicks; clicks on header-internal buttons (↺ reset,
  + new, ↧ copy) never toggle.

Consumers: ScenePanel, PropertiesPanel, ShaderPanel, PrintPanel, CursorPanel.
Panels keep hand-rolled wiring for shapes the helpers don't cover
('input'-event sliders/pickers, drag-drop targets, command-dedup shader
fields).

### Scene Panel (`src/ui/ScenePanel.js`)
Right-panel section `#rp-scene` — the specialist section of the **Scene
workspace** (hidden in Layout / Shade / Print). Scene-wide settings, moved
out of the Properties panel so
they stay reachable while an object is selected (the old Scene section only
rendered with nothing active — Properties is object-scoped now).

Every section is **collapsible** (same `.pp-collapsed` pattern as the
Properties panel; both use `ui/lib/sections.js createCollapseController` —
this panel passes a `storageKey`) with the collapse state persisted per-user
in localStorage (`mixomesh.scenePanel.collapsed.v1` — NEVER in .mixo, same
per-user rule as workspaces). Field wiring (numbers/selects/toggles +
Enter-blur/Escape-revert) goes through `ui/lib/fields.js`; only
'input'-event controls (section-offset slider, colour pickers) and
clamp-only inputs (render W/H) stay hand-wired. Defaults: Environment + Camera + Section
collapsed so the Rendering section is reachable without scrolling. Long
sections carry muted uppercase `.pp-subhead` sub-group labels (blender.css
§8): Environment = HDRI lighting / Grade / Floor / Lights / Ambient
occlusion; Rendering = Still / Turntable. Dependent rows render only while
their toggle is ON (vignette amount, floor colour + height, shadow
darkness, AO strength, section axis/offset/flip) and the panel re-renders
on those toggles; floor-on + shadows-off shows a "floor won't catch any"
hint.

**Three-tier visual hierarchy (blender.css §8, 2026-06-13).** Tiers 2 and 3
read near-identically before. Now: tier 1 = top-level panel bar
(`.rp-section-header`, filled `--bg-1`); tier 2 = `.pp-section-header` —
brighter (`--text-1`, weight 600) with an **accent disclosure triangle**,
and its body is **indented under a vertical guide rail** (`border-left` on
each non-header child, `--bg-4`; spacing via padding not margin so the rail
stays continuous through sub-group dividers); tier 3 = `.pp-subhead` — dim
uppercase, hairline divider (`--bg-3`), nested inside the indented body.
Each header carries a leading `sectionIcon` glyph (see Part 2). Shared
`.pp-section` covers Properties + Scene.

⚠ **Attribute namespace:** the collapsible wrappers are
`<section data-sec="${key}">` and change events BUBBLE — wiring a
`[data-sec]`-prefixed selector for row inputs attaches the handler to every
section element and re-renders the panel on any child's change (detached-
node bug found by smoke 2026-06-13). The cross-section rows use `data-sect*`
for exactly this reason; never introduce another `data-sec…` row attribute.
Sections:
- **Grid** — grid cell (mm) + subdivisions (`SceneManager.setGrid`), grid +
  axes visibility checkboxes (overlay contract), bed-size hint.
- **Environment** (header renamed from "Render" 2026-06-13; state key stays
  `scene.render` — no save migration) — background Light/Dark (repaints the
  gradient backdrop + clearColor), **HDRI lighting** (default ON: toggle +
  preset Studio/Neutral/Outdoor + intensity — prefiltered `.env` cube
  textures bundled in `public/env/` (Babylon asset CDN copies), loaded via
  `CubeTexture.CreateFromPrefilteredData` into `scene.environmentTexture`;
  LIGHTING ONLY — no skybox, the gradient backdrop stays visible; drives
  IBL on PBR materials i.e. every imported model; texture cached across
  toggle off/on, disposed on preset change), exposure, contrast, **tone map** (ACES /
  Neutral-KHR / Standard / Off — `imageProcessing.toneMappingType`),
  **saturation** (`colorCurves.globalSaturation`, −100..100, curves enabled
  only when ≠ 0), **vignette** toggle + weight, **floor** (round shadow-catcher
  DISC: enable + colour picker + Z height in mm + diameter in mm —
  `floorEnabled`/`floorColor`/`floorZMM`/`floorDiameterMM`; a unit disc
  (`CreateDisc`, radius 0.5) SCALED to the diameter so resizing never rebuilds
  the mesh, diameter 0 = auto (4× largest bed dim), `receiveShadows`, matte
  Standard material, positioned 0.05 mm below the requested height so Z=0
  doesn't z-fight the bed grid; never registered / pickable / exported, stays
  VISIBLE in renders — it exists for them),
  shadows on/off, shadow darkness, key/fill/ambient light intensities,
  **Ambient occlusion** (SSAO toggle, default ON + strength 0..2 — viewport
  shading only, hint says so; see §7 SSAO) + a "Reset environment" button.
  User-initiated HDRI toggle/preset changes toast on `HDRI_STATUS`
  ('loaded' → "ready", 'error' → failure); boot/load stay silent.
- **Camera** — FOV (deg, clamped 5–140) and near clip (mm) →
  `CameraRig.applyCameraOptics` via the same settings object.
- **Section** — cross-section "Cut view" (state.scene.section, session-only):
  axis X/Y/Z (print-space, Z = height), offset via a **range SLIDER** whose
  min/max span the content extent along the axis (lowest..highest point + a 1 cm
  buffer each end so the plane can fully clear the model, from
  `SceneManager.getSectionExtentMM(axis)`), flip side → `SceneManager.setSectionPlane`.
  The slider drives the cut live on `input` (cheap — no extra geometry pass);
  the axis select re-renders so the range follows. Cuts content meshes only; an
  a back-face FILL clone renders the cut interior as a translucent amber
  (#f59e0b) hatched section — semi-transparent body + denser stripes, any GPU,
  no stencil — and an accent border outlines the plane (both viewport-only —
  inspection, not real geometry). Hint documents that grid/floor stay, the
  geometric cut shows in exports, shadows stay uncut.
All of it writes `state.scene.render` (silent) and applies via
`SceneManager.applyRenderSettings` (partial-safe); persisted in
`sceneSettings.render`, re-applied on boot / load / new. Defaults mirror
`scene/SceneConstants.js`.
- **Rendering** — output production (`state.scene.renderOut`, persisted in
  `sceneSettings.renderOut`; capture engine = `core/RenderOutput.js`, a
  façade over `core/render/{FrameCapture,SweepRig,TurntablePreview,VideoRecorder}.js`
  with frozen export names — the smokes dynamic-import the façade path):
  - **Resolution** preset (1080p / 4K / Square / Portrait) + custom W×H
    (clamped 16–8192) and a **Transparent background** toggle (PNG only).
  - **Render view** checkbox — compose mode: parks the free-nav camera pose,
    jumps to the stored `renderOut.pose` (first use seeds it from the current
    view), and shows the `ui/RenderFrame.js` overlay (aspect-fit rect for the
    output resolution; giant box-shadow darkens outside; centre crosshair as
    a composition aid; pointer-events pass
    through so nav still works). The render pose updates AUTOMATICALLY while
    the mode is on — every camera move is debounce-stored (250 ms) via the
    camera's `onViewMatrixChangedObservable`, plus a final snapshot on toggle
    off; there is no "Set view" button. Exits without touching the camera (or
    writing the stale pose) on `PROJECT_LOADED`/`PROJECT_NEW`.
  - **Export PNG** (button, or **Ctrl+Alt+E** globally — Blender's F12
    belongs to DevTools in a browser) — `render/FrameCapture.capturePng`: RTT
    screenshot (`CreateScreenshotUsingRenderTargetAsync`) at the exact
    output resolution. The RTT path skips the camera post chain — no
    selection silhouette and no SSAO in renders — while keeping tone
    mapping (material-level). Scene furniture (grid / axes / bed preview /
    3D cursor / cross-section indicator) is hidden for the capture and
    restored — `FrameCapture.hideFurniture` reads ACTUAL visibility, not proxy state: the
    cursor is hidden via `SceneManager.isCursorVisible()` (NOT
    `pivotMode==='cursor'`, since the N-panel Show toggle / open-panel can show
    it without cursor-pivot, and that must still stay out of exports); transparent mode
    disables the background Layer + sets `clearColor` alpha 0
    (`SceneManager.setBackgroundEnabled`), and an ENABLED floor is swapped
    to a `ShadowOnlyMaterial` for the capture
    (`SceneManager.setFloorShadowOnly`) — its caught shadow lands in the
    alpha channel, the plane itself does not, so the export composites as
    model + floating soft shadow. Both swaps restore after.
    **Pose rule (U1):** when `renderOut.pose` exists, Export PNG AND Export
    video shoot FROM IT (capture applies the pose, restores free nav after);
    no pose → current view. The render-view hint says so while a pose is
    stored. **Busy rule (U2):** Export PNG / Export video / Preview disable
    each other while any capture runs (Preview stays live during its own
    sweep — it doubles as Stop).
  - **Turntable video** — duration (s), FPS 30/60, direction Left/Right,
    ease in/out, plus a **Preview** button (plays the sweep live, no
    recording — button toggles to "Stop preview", Esc also stops).
    **Sweep semantics (`render/SweepRig.createSweepRig`, shared by preview +
    record): RIGID rotation of the camera rig about the WORLD vertical axis
    through the origin — the camera is never re-aimed and never pans.** The
    framing you start with is exactly what rotates: per-frame
    `camera.alpha = start + δ` AND `camera.target.copyFrom(RotY(−δ)·T₀)`
    together form a pure world rotation (target MUTATED, never assigned —
    the `camera.target =` setter calls setTarget() which re-aims and would
    silently overwrite the alpha write). The key/fill directional lights
    (direction + key position) and `scene.environmentTexture.rotationY`
    (when one exists) rotate by the same angle — lights moving with the
    camera is what makes it read as "model spinning on a turntable under
    fixed studio lighting". World matrix is `RotationY(−δ)` for alpha +δ
    (ArcRotate α moves the camera +X→+Z, Babylon RotationY(+θ) maps +X→−Z —
    sign flips; verified numerically). environmentTexture.rotationY uses
    **+δ** — verified EMPIRICALLY by the smoke's mirror-sphere probe (a
    mid-sweep capture must match the baseline while a camera-only rotation
    must not; −δ counter-rotated the env). Hemi points straight up, no-op.
    Sinusoidal ease via `render/RenderMath.turntableProgress`; full rig
    restored after done/cancel; Esc cancels; nav locked during. The smoke
    pins both invariants with a panned composition: |position| AND |target|
    each stay on their origin circles mid-sweep (catches the re-aim bug and
    the setter bug). Filenames share the §12
    export-stem contract: `<project>_render_<w>x<h>[_alpha].png`,
    `<project>_turntable_<s>s.<ext>` (`render/RenderMath.js`).
  - **Recording path 1 (primary): offline WebCodecs.** The sweep is stepped
    frame-by-frame (`i/frameCount` — the last frame sits just short of 360°
    so the video loops cleanly), each frame rendered at the EXACT output
    resolution (`renderOut.width × height`, screen size irrelevant;
    furniture hidden like PNG) and fed to a `VideoEncoder` (H.264 High —
    level by area: L4.0 ≤ 1080p, L5.1 ≤ 4K; ~0.12 bits/px/frame clamped
    4–40 Mbps; keyframe every 2 s; even dimensions forced), muxed by
    **mp4-muxer** (dependency, LAZY `import()` — its chunk stays out of
    boot) into an in-memory mp4. Deterministic — no dropped frames.
    **Frame source (perf audit 2026-06-13):** NOT the PNG screenshot helper
    per frame — `_renderSceneToTarget` replicates what
    `CreateScreenshotUsingRenderTarget` does internally
    (`camera.outputRenderTarget` + full `scene.render()` under
    `engine.skipFrameRender` + getRenderWidth/Height overrides) into ONE
    reused `RenderTargetTexture`, then `readPixels` → row-flip (WebGL is
    bottom-up) → `new VideoFrame(rgba, {format:'RGBA'})`. Kills the
    per-frame PNG encode→dataURL→fetch→decode→ImageBitmap round-trip that
    dominated export time. `captureFrameRGBA()` exposes one frame of this
    exact path as the smoke probe (asserts real pixel variance — an mp4 of
    black frames still has plausible bytes).
    **Project-switch guard (audit C2):** `PROJECT_NEW`/`PROJECT_LOADED`
    cancel an in-flight preview/recording immediately, and the cancellation
    skips the camera restore — the incoming project's camera wins, never a
    stale pose. Lights/env rotation still restore (app-fixed studio rig).
    Smoke pins the abort (recording resolves null, `isRecording()` clears).
  - **WebCodecs is the ONLY path** — the MediaRecorder fallback was REMOVED.
    ⚠ MediaRecorder hard-freezes/crashes the renderer in ALL headless Chromium
    and in Chrome 149 even headed/live (STATUS_BREAKPOINT — reproduced on a
    trivial 2D canvas; Chrome-build bug, Edge 149 fine), so it was never a safe
    fallback. No WebCodecs (`typeof VideoEncoder !== 'function'`) ⇒ a clear
    "needs Chrome/Edge" error, not a hung tab. WebCodecs is unaffected (verified
    by `tests/webcodecs-probe.mjs`). The browser smoke records a real 1 s mp4
    HEADLESS via this path; `npm run test:video` (headed; `VIDEO_CHECK_EDGE=1`
    forces Edge) covers a full-size sweep.

### Viewport Toolbar (`src/ui/ViewportToolbar.js`)

Fusion 360-style floating pill anchored bottom-centre of the `#viewport` element. Always visible, always above the canvas. Four groups, divider between each:

- **Group A — Gizmo mode.** Move / Rotate / Scale. Click → `SceneManager.setGizmoMode('translate'|'rotate'|'scale')`.
- **Group B — Pivot mode.** Dropdown (`<select class="pp-preset-select">`, overhaul 5.6 — functional swap, restyle is mockup-gated later): Active / Median / Cursor / World (in display order); `'individual'` (reachable via `.`) shows as an extra selected option. Default = `'active'` so transforms pivot around the selected object out of the box. Change → `Selection.setPivotMode(...)`. `'world'` pivots at `(0,0,0)`; `'cursor'` pivots at `state.scene.cursor3d`.
- **Group ~ — Orientation.** Single toggle button. Click flips `state.gizmo.space` between `'world'` and `'local'` via `SceneManager.setGizmoSpace`. Label reads the current state.
- **Group C — Camera mode.** Dropdown (same control): Free / Follow Active / World Origin. Change → `SceneManager.setFollowMode(...)`. See §7 *Camera Follow Modes*.

Active button highlighted with `--accent`. Subscribes to `SELECTION_CHANGED`, `ACTIVE_OBJECT_CHANGED`, `CAMERA_PRESET_CHANGED`, `PROJECT_LOADED` so the active highlight stays in sync.

### Nav Cube (`src/ui/NavCube.js`)

Fusion 360-style orientation widget anchored top-left of the viewport. Pure DOM/CSS 3D — no Babylon meshes. A `scene.onBeforeRenderObservable` writes the cube's CSS transform each frame straight from the `ArcRotateCamera` spherical angles:

```
transform: rotateX(β − π/2) rotateY(π/2 − α)
```

At the front preset (α = β = π/2) this is the identity → the bare `nc-front` face. Yaw is `π/2 − α`: viewed from FRONT in Babylon's left-handed space world +X is on the viewer's LEFT, so a camera on +X (α = 0) shows the LEFT face. Verified live (Chrome DevTools) against the scene: front = identity/FRONT; camera +X → LEFT; camera −X → RIGHT; above → TOP; below → BOTTOM; every face label stays upright and readable. Earlier view-matrix reconstructions kept introducing mirror / 180° flips (Babylon LH ↔ CSS handedness), so the camera's own angles are used directly. The six CSS faces are the **canonical static cube layout** (`nc-front` +Z, `nc-back` −Z, `nc-right` +X, `nc-left` −X, `nc-top` +Y, `nc-bottom` −Y); all orientation lives in the per-frame rotateX/rotateY.

Interactions:
- **Click face** (FRONT/BACK/LEFT/RIGHT/TOP/BOTTOM) → `SceneManager.setCameraPreset(name)`. That call: (a) computes the scene bbox over all registered meshes, (b) animates camera `alpha/beta/target/radius` toward the orthogonal view + bbox fit (320 ms ease-in-out), (c) switches to `ORTHOGRAPHIC_CAMERA` after the animation finishes. The ortho view persists until the user pans (RMB drag) — auto-revert in `_applyFollowTarget` flips the preset back to `'perspective'`.
- **Drag any part of the cube** → orbit main camera (`alpha -= dx*0.01`, `beta -= dy*0.01`, clamped to `[0.01, π−0.01]`). A 4-px movement threshold suppresses the face-click when the gesture is actually a drag.
- **Home button** (small circular `⌂` below the cube) → `SceneManager.setCameraPreset('perspective')` — same code path, animates back to a 3/4 perspective view fit to the full scene bbox.

### Status Bar (`src/ui/StatusBar.js`)
Single bar at bottom. Segments:
- **Left:** current op hint or default shortcuts.
- **Center:** `src/ui/MeshStats.js` → `StatusBar.setCenter` (2026-09-18 —
  watertight-repair-and-cost task 7 + fix round 1). Two independent halves:
  - **Triangle budget — scene-wide, ALWAYS ON**, even with nothing selected:
    `tris <scene> / <budget>` against `caps.triangleBudget` (web 1.5M /
    desktop 6M). Gains `hud-warn` (≥70% of budget) / `hud-danger` (≥90%)
    classes; tooltip `t('hud.triangleBudget')`. The scene-wide count is a full
    `scene.meshes` walk, so it is CACHED and only recomputed on events that
    change scene geometry (asset add/remove, undo/redo, repair-completion
    re-validate) — never on `SELECTION_CHANGED` — and a burst of geometry
    events (an N-part import) coalesces into one microtask-deferred walk.
    The walk counts a mesh only if it IS the currently-registered live mesh
    for its `metadata.meshId` (`AssetLoader.getBabylonMesh(meshId) === mesh`
    — the same guard `MeshValidator.js`'s cache-write path uses), not merely
    a mesh that carries that id — `Mesh.clone()` copies the metadata
    reference, so a transient export clone sharing the source `meshId` would
    otherwise be double-counted while briefly alive during its own
    export-time validation pass (task 8 fix round 1, 2026-09-18 — live-caught
    as a HUD reading `tris 8` for a 4-triangle solid).
  - **Selection stats — selection-driven, appended only when something is
    selected:** `· sel <selTris> · <W>×<D>×<H> mm · <watertight>` — the
    selection's own triangle count, print-space W×D×H in mm, and watertight
    state. With nothing selected the line is just the triangle-budget half.
    Overhaul 5.6: the selection half also re-renders on `TRANSFORM_COMMITTED`
    (dims follow moves/scales) and measures every logical part of a selected
    object and every object mesh under a selected group. The cached scene
    total also feeds `Hover.setBudgetExceeded` (hover off at ≥ 70 %).
    The watertight verdict keys on result TYPES — any `holes` /
    `nonManifold` / `invertedNormals` result on the ACTIVE mesh reads
    `⚠ not watertight` (2026-09-18, review CIA F1). It used to test
    `hasErrors(results)`, and the validator NEVER emits severity `error`
    (owner rule: non-manifold stays a warning), so the badge was
    structurally blind and could only ever read `✓ watertight`. The only
    hard geometry block in the app is `print.strictExport` (§9 *Pre-Export
    Gate*); the validator's own results never block anything.
    `mesh-stats.test.mjs` pins all three verdicts.
  - Full example: `tris 342k / 1.5M · sel 82k · 120×80×45 mm · ✓ watertight`.
  - `AssetImport.js` reuses the same scene/container triangle counters for a
    non-blocking `toast.triangleBudget` warning before both
    `container.addAllToScene()` call sites (`loadFromBlob`,
    `instantiateAsset`) — one traversal, two consumers. The counting itself
    lives in `src/core/scene/TriangleCount.js` (2026-09-18, review M5) so a
    core import path no longer depends on a UI module; `MeshStats` re-exports
    the three functions and keeps owning the cache, the HUD text, and the
    `MeshStats.countSceneTriangles` indirection the spy test relies on.
    Selection stats resolve their meshes through `AssetLoader.getBabylonMesh`
    rather than a `scene.meshes` scan, for the same reason the scene walk does
    (review M4).
- **Right:** undo/redo labels, polycount, save state (`Circle` for dirty, `Check` for saved). Status bar right side has Undo/Redo icon buttons (`#status-undo`/`#status-redo`, disabled when the stack is empty) beside the undo/redo labels; Project menu ▸ Reset settings asks for confirmation first.

Collapses non-essential segments below 1280px.

### Toast (`src/ui/Toast.js`)

**Feedback toasts (task 5.4).** Applying a colour swatch toasts "Color #HEX
applied" (success, 1.5 s); saving a user swatch toasts 'Saved swatch "name"'
and a duplicate hex is refused ("Swatch #HEX is already saved"); an automatic
workspace jump (`ShaderPanel.focus` → Shade, `PrintPanel._focusValidation` →
Print) toasts "Switched to X — click to go back to Y" (click restores);
"Export selected" with nothing selected toasts instead of running. Export
success is toasted only by `PrintPipeline` (`toast.exportedOk`).
- Max 4 stacked bottom-right.
- Types: info / success / warning / error / loading.
- `loading` shows spinning `Loader2` icon (CSS rotation), ignores duration.
- `show(message, type, duration, { onClick })` — an `onClick` makes the toast
  a button (`role="button"`, focusable, Enter/Space): activation dismisses the
  toast then runs the handler. Used by validation toasts (B5 click-through).

### Modal (`src/ui/Modal.js`)
Generic. Listens for `MODAL_OPEN`. Renders by id (`shaderMerge`, `dirtyConfirm`, `validationErrors`, `importError`, etc.).
Every opened modal gets `role="dialog"` + `aria-modal="true"` and an accessible
name: the shell uses the first `.modal-title` / `.pm-modal-title` / heading as
`aria-labelledby`, falling back to a payload/title/id label. Opening a modal
stores the previously focused element, moves focus to the first enabled visible
control (or the shell), traps Tab/Shift+Tab inside the dialog, closes on Escape
unless `blocking`, and restores focus to the opener after close.

### App Shell (`src/ui/AppShell.js`)
Owns behaviour for the static shell declared in `index.html`: right-panel
section collapse (`button.rp-section-header` with `aria-expanded`), right-panel
splitter drag + keyboard resize (`role="separator"`), outer panel
collapse/expand buttons, outer panel resize separators, the localized
`#viewport-size-guard`, and removal of `#boot-status` after successful
initialisation. Outer resize handles are focusable `role="separator"` controls
with `aria-orientation`, `aria-valuemin/max/now`, and arrow/Home/End keyboard
resizing that matches pointer resizing. `src/app/main.ts` calls
`AppShell.init()` after the panels have rendered their headers; `src/app/main.ts`
no longer owns resize/collapse helper code.

### Project Menu (`src/ui/ProjectMenu.js`)
Header toolbar: **New / Open / Save / Save As** buttons + Recent-projects flyout (thumbnails + timestamps; max 10 from `PersistenceManager.getRecentProjects`). The header also exposes the **`#project-name` inline editor** — clicking (or pressing Enter/Space while focused) swaps the label for a text input pre-selected to the current name; Enter or blur commits via `HistoryManager.push(new RenameProjectCommand(prev, next))` (so the rename is undoable and marks the project dirty), Escape cancels, empty / whitespace cancels. Subscribes to `PROJECT_LOADED / PROJECT_SAVED / PROJECT_NEW / PROJECT_RENAMED` to refresh the label — the refresh skips the element while `data-editing="1"` so it can't clobber an open editor. Why editable in-place: the project name is the prefix for every export filename (see §12 *Export filenames*), so changing it must be a one-second action — not a hidden side-effect of Save As. Owns four `Modal.register` IDs the persistence flow dispatches into:
- `dirtyConfirm` — "Unsaved changes" → returns `'save' | 'discard' | 'cancel'`.
- `recoverAutosave` — surface a found autosave → `'recover' | 'discard'`.
- `unmatchedAssets` — Linked assets that fell back to Snapshot (only those with a link expectation: `directoryHandleKey || fileHandleKey`). Per-item **Relink…** button calls `PersistenceManager.relinkAsset(id)` and drops the row when it resolves.
- `portableSaveBlocked` — manual save failed the portable `.mixo` gate
  (`err.portableIssues[]`). Lists missing required assets/usage and offers the
  same per-item **Relink…** recovery. Save/Save As surface this modal directly
  instead of a transient toast because a `.mixo` without required geometry or
  texture bytes would not reopen/export the same project.

`ProjectMenu.init()` is called from `src/app/main.ts` after `PersistenceManager.init()`; the persistence module dispatches `MODAL_OPEN` events but the renderers themselves live here so the UI layer owns markup.
Recent-project thumbnails are treated as persisted untrusted data and pass
through the UI rendering safety contract before becoming `<img src>`.

### Progress Overlay (`src/ui/ProgressOverlay.js`)
Full-screen blocking overlay shown during exports. Single instance, mounted into
the static `#progress-root` from `index.html` (or lazily created if an old shell
is loaded). Captures and swallows `pointerdown / pointerup / click / wheel /
contextmenu` on the overlay root, and installs a document-level capture guard
for `keydown / keyup / keypress`. Keyboard events target the focused element,
not the overlay sibling, so the document guard is what blocks viewport
shortcuts while export is running.

```js
ProgressOverlay.show(title = 'Working…')   → void
ProgressOverlay.update(frac, message?)      → void   // frac 0..1; clamps to 0..100%
ProgressOverlay.hide()                      → void
```

`PrintPipeline._runExport` reports `onProgress(frac, msg)` across collect / prep / validate / serialize / package / download; `PrintPanel.runExport` wraps the call in `show / hide` via `try…finally` so a thrown error still tears the overlay down.

---

### Properties panel (overhaul 1.13 / 1.16 / 3.6 / 4.6 / 5.2)

Owner/integrator: merge into Blueprint.md at the anchors named below.

## §SceneObject (`state.scene.objects[meshId]`) — add one field after `isInternalPart`

```js
  ratio,                       // declared scale (1:ratio); see §12 Scale
  ratioSource,                 // 'file' | 'user' | 'default' (task 1.13,
                               //   Decision 24). Seeded at import by
                               //   AssetRegistration: modelRatio ≠ 1 → 'file'
                               //   (glTF extras.ratio), else 'default'
                               //   (STL/OBJ never declare a scale). Any
                               //   explicit Set scale / Convert → 'user'.
                               //   Persisted per object in .mixo; objects
                               //   minted outside import (Boolean / Slice)
                               //   carry none and derive the seed from their
                               //   asset (ScaleCommands.ratioSourceOf).
```

## §11 Persistence — migrate ladder (3.3 → 3.4 step `_migrateTo34`)

Add to the per-field migrations list: **1.13** seeds every scene object's
`ratioSource` from its asset (`seedRatioSource(asset.modelRatio)`: `'file'`
when `modelRatio ≠ 1`, else `'default'`); an explicit valid value already on
the object is kept (idempotent). The loader applies the same derivation to
3.4 documents saved before the field existed (`ratioSourceOf(o, asset)`), and
the serializer always writes the resolved value.

## §12 Scale — declare vs convert (replace the Properties "Ratio" description)

- Properties ▸ Transform **Scale** row: `Scale [1:72 ▾] [1:72] Set scale |
  Convert…`. Picking a preset or typing a ratio only *stages* it; nothing is
  applied until a verb is clicked (or Enter applies the default verb).
- **Set scale** = `SetScaleLabelCommand(ids, ratio)`: relabels `ratio`, sets
  `ratioSource:'user'`, touches no geometry/transform. Undo restores each
  prior `ratio` + `ratioSource`. Emits no `OBJECT_UPDATED` (geometry is
  unchanged, so validation must not go stale); panels re-render on
  `HISTORY_PUSHED/UNDONE/REDONE`.
- **Convert…** = `RescaleObjectCommand(ids, ratio)` (math unchanged: bake
  `old/new` about the object's own origin, 1.14). It now also sets
  `ratioSource:'user'` and restores the prior source on undo.
- **Default verb** (primary button, Enter): relabel when EVERY target's
  `ratioSource` is `'default'` (never declared — the STL/OBJ case), convert
  otherwise. Both verbs are always available.
- **Consequence line** under the row, before applying:
  `Set scale: relabel only, size unchanged · Convert…: resize ×2.06`
  (default verb first; mixed-ratio selections say "resize each object to the
  new scale"). With nothing staged the line shows the **effective scale**
  (1.16, Decision 26) from `ScaleMath.effectiveRatioInfo(obj, leadMesh)`:
  `×2.0 → prints as 1:36` when the uniform node scale ≠ 1, `non-uniform
  scale…` when the node scale is non-uniform, or — for an undeclared
  (`'default'`) object at node scale 1 — a one-line hint that Set scale
  labels without resizing.
- Targets = selected objects expanded to every logical-object part; one undo
  step. Groups have no Scale row (scale is declared per object).
- The XYZ node-scale row is labelled **Scale XYZ** to keep the two nouns apart.
- Pure helpers exported for tests: `PropertiesPanel.__test.defaultScaleVerb`,
  `scaleConsequence`; `ScaleCommands.RATIO_SOURCE`, `seedRatioSource`,
  `ratioSourceOf`, `SetScaleLabelCommand` (re-exported by HistoryManager).

## Properties Panel (`src/ui/PropertiesPanel.js`) — replace the numbered section list

Renders for the active selection:

1. **Object** — name; **Source** row (single selection with an asset):
   status chip *Embedded copy / Linked / Changed on disk / Missing*
   (`sourceStatusFor`: ghost → missing; else `AssetResolver.getAssetStatus`
   from the last load; else `linked` when `sourcesOf(asset)` is non-empty,
   otherwise `embedded`), the qualified file name
   (`DisplayNames.qualifiedDisplayName`) in mono, and a ⋯ menu:
   **Refresh** (`ProjectLoader.refreshAsset` → `RelinkAssetCommand`; enabled
   when the asset has a link), **Find moved file…** (`FindMoved.runFindMoved`;
   enabled when `canFindMoved`), **Relink…** (`relinkAsset`). Esc / outside
   click closes the menu. Then **Print** (toggle "Include when printing" —
   formerly its own Print section), and the Visible / Locked toggles.
2. **Transform** — Scale row (§12 above), Size (mm), Pos (mm), Rot (deg),
   Scale XYZ (axis-coloured field edges), scale lock, **Drop to bed**
   (`BedPlacementCommand(selection, 'drop')`).
3. **File units** — unchanged.
4. **Material** slots, 5. **UV Override** — unchanged.

**Group active (task 3.6)** — when the active selection id is a user group:
header `Group · <name> (N objects)` (N = non-internal objects in the subtree)
with an **Ungroup** button (`UngroupCommand([groupId])`); **Object** = Name
(`RenameCommand` on the group id) + **Print** toggle for the whole subtree
(one batch of `PrintPartCommand`s for objects whose flag differs; shows
mixed when partial); **Transform** = Size (mm) of the group's hierarchy
bounds (edits scale the group node; scale lock applies), Pos (mm), Rot (deg)
— each edit is ONE `TransformCommand({[groupId]: prev}, {[groupId]: next})`
on the group TransformNode so children follow rigidly — and **Drop to bed**
(same command shape, label "Drop to bed"). No Scale row, no material slots:
a note reads "Material is set per object". Locked (or inside a locked
group) → fields read-only; multi-select → fields disabled.

**Workspaces (task 5.2, Decision 6)** — Properties ▸ Object is visible in all
four workspaces. Layout: Object + Transform + File units; Shade: Object +
Material + UV; Scene / Print: Properties shows ONLY its Object section as a
compact strip (`flex: 0 0 auto; max-height: 45%`) above the specialist panel,
and hides entirely when nothing is selected (`#rp-properties:has(.pp-empty)`).
Rules live in `src/styles/layout.css` (Workspaces block).

The staged ratio is module state reset whenever the selection (active id +
selected ids) changes.

### Outliner + context menu (overhaul 3.4 / 3.5)

## Outliner (replaces the collection-tree description)
- Tree = top-level groups, then top-level objects. **No collection rows or headers** (Decision 2); `scene.collections` stays in the schema for provenance only (object row tooltip "From file: ..." and the `file:name` search prefix). An import that yielded several objects is a Group named after the file stem.
- Group rows are selectable: a plain click selects the group itself (`Selection.set([groupId])`, `aria-selected="true"` on the row; scope = the row's parent, 3.2). Shift adds, Ctrl toggles. Chevron expands/collapses (`ui.outlinerCollapsed[id]`, true = collapsed). A count badge shows direct children (objects + sub-groups).
- Row = 24px, indent by `--ol-depth`. Selected = 2px bengara left edge (`--active`) + faint wash (`--active-bg`). Hover reveals eye / lock (/ print on objects); non-default states (hidden, locked, locked by an ancestor group, excluded from print) stay visible. Numbers (count, parts N) are monospace; nothing else.
- Cascade (`src/core/hierarchy/GroupCascade.js`, pure): groups have no visibility flag; the eye on a group hides every object beneath it (any visible descendant -> hide all, else show all) as one `VisibilityCommand` over `cascadeObjectIds`. Lock is the group's own `locked` flag (`LockCommand([groupId])`) and reaches descendants by ancestry via `Selection.isEffectivelyLocked`; descendants keep their own flag, and show a dimmed lock when locked by an ancestor.
- Objects with more than one material part show a "Parts N" pill and a chevron; the disclosure (session-only `_openParts`) reveals read-only part rows (click selects the lead). The old header "show internal parts" toggle is gone.
- Status pill at row end from the A6 validation cache: "Repair" (wrench, clickable `data-action="repair"`) when auto-fixable, otherwise "Check"; stale = dimmed.
- Footer: "N objects · N groups" + "N selected". Header title only. `Outliner.renameActive()` is exported on the `Outliner` object (F2 and the context-menu Rename share it; works for groups).

## Context menu (§4.6 tiering)
- One object selected: at most 12 primary items + four submenu headers (Arrange, Combine, Material, Export) = at most 16 top-level entries. Primary: Rename, Duplicate, Delete | Group, Ungroup, Enter group / Exit group | Hide/Show, Lock/Unlock, Focus, Select parent, Repair, and Relink (ghost) or Reveal in Outliner (viewport source).
- Submenus are hidden sibling panels (`.context-menu.cm-submenu[data-submenu-for]`) appended to `<body>` while the menu is open (a child of the root would be clipped by its overflow); opened by hover, click, Enter/Space/ArrowRight; ArrowLeft/Esc closes. Arrange = Snap to active, Copy placement from active, Replace with active, Align centre X/Y/Z, bed placement, Mirror, Array, 3D-cursor snaps, Unparent. Combine = Union / Subtract / Intersect / Slice & Connector. Material = Separate by material, Merge into one object, Edit material. Export = 3MF / OBJ / STL of the selection.
- Enter group = `Selection.enterScope(group, picked)` (target = the single selected group, or the parent of the single selected object); when already inside, the entry becomes Exit group = `Selection.exitScope()`.
- Group right-click selects the group and shows the same menu; hide/lock/frame/repair/unparent act on groups through the cascade helpers. Collection menu items removed.

### Asset panel, Sources modal, boot banner, duplicate dialog (overhaul 4.6 / 4.7 / 4.8)

Merge into `Blueprint.md`. Each block names the section it replaces/amends.

---

## §0.3 file layout — add

```
src/ui/BootBanner.js     ← one non-blocking boot banner: re-mount last folder + recover newest autosave (task 4.7)
src/ui/SourcesModal.js   ← the one Sources modal (status of every asset + Refresh / Find moved / Relink, bulk) + Source-status vocabulary (task 4.6)
```

---

## Boot sequence, step 6 (≈ line 592) — replace the last sentence

6. `main.ts` registers global project shortcuts (`Ctrl+S`, `Ctrl+Shift+S`,
   `Ctrl+O`, `Ctrl+N`), reapplies overlay defaults, starts autosave, focuses the
   canvas, then calls `BootBanner.runBootChecks()`: it looks up
   `AssetPanel.findRemountOffer()` (last-mounted folder whose ref is still
   stored) and `Autosave.findRecoverableAutosave()` (newest snapshot newer than
   its project's last save) in parallel and shows ONE slim banner above the
   header. No modal opens at boot (Decision 4).

---

## §11 Autosave — replace the "Boot:" bullet

- Boot (task 4.7, Decision 4): `findRecoverableAutosave()` returns the newest
  `autosave_<id>` snapshot only if its `savedAt` is newer than the snapshot
  doc's `project.lastSavedAt` (a stale one is deleted silently) as an offer
  `{key, projectId, savedAt, name}`; it never opens UI and never touches the
  world. The boot banner shows "Recover unsaved work from HH:MM" (date added
  when not today; time in monospace). **Recover** calls
  `recoverAutosave(offer)`: re-mounts the offered folder first in the same
  click (handle-backed assets resolve through it — autosave skips their bytes,
  A9), asks the usual save / discard / cancel question if the open project is
  dirty, then loads the snapshot. A recovered project re-attaches its stored
  images, stays DIRTY and is re-snapshotted at once. A poisoned snapshot is
  deleted and reported, never re-offered. **Dismiss (×)** only hides the banner;
  the snapshot is kept and offered again next launch (non-destructive).
  `discardAutosave(offer)` drops an offer explicitly. `recoverAutosave()` with
  no argument recovers the newest recoverable snapshot (headless/tests).

---

## §11 Asset resolution — replace the "Liveness rule" paragraph (≈ line 3248)

Source status (task 4.6; words from overhaul §7): every asset shows one of
**Embedded copy · Linked · Changed on disk · Missing** —
`SourcesModal.sourceStatus(asset)`:
- `isGhost` (no bytes anywhere) → `missing`;
- else the last load/relink resolution (`AssetResolver.getAssetStatus`,
  session-only, not persisted): `linked` (tier 1/3 bytes match), `changed`
  (linked file differs — embedded copy in use, Refresh offered), `missing`
  (link unreachable — embedded copy in use, Find moved file… / Relink offered),
  `embedded` (no link);
- never resolved this session (fresh import): `linked` when the entry has a
  source link (`sourcesOf(entry)`), else `embedded`.
The old Linked/Snapshot badge is retired. The post-load `unmatchedAssets` /
`ghostAssets` modals are superseded by the Sources modal as the place to fix
sources (ProjectLoader still dispatches them until they are removed).

---

## Asset Panel (`src/ui/AssetPanel.js`) — amendments

- Tabs are **Project · Folders** (i18n keys `panel.session.title` /
  `panel.library.title` unchanged; values renamed). Each tab carries a
  monospace count (project assets / mounted folders), hidden when zero.
- **Project** tab (was Session): smart views All / Used / Unused / Issues;
  Issues also includes `changed` / `missing` sources. Header shows a
  **Sources** button (hidden on Folders) that opens the Sources modal.
- Project card: thumbnail with the **Source chip** top-left (Embedded copy and
  Linked are quiet neutral chips; Changed on disk = warning amber tint;
  Missing = danger red tint; chip carries `data-source-status`), then the
  **qualified name** — `displayNameParts(asset, assetLibrary)` label plus the
  qualifier dimmed (`chair.glb · downloads` only while ambiguous; generic
  texture names `<model> · <slot>`), tooltip = original filename (+ path) —
  then a **⋯** button and the extension / imported-scale / unit badges.
- Card **⋯ menu** (popover on `<body>`, `role="menu"`, Arrow keys, Esc returns
  focus): Add to scene (meshes) · Refresh (enabled when `linked|changed`;
  `ProjectLoader.refreshAsset`, undoable `RelinkAssetCommand`) · Find moved
  file… (enabled when `canFindMoved`; `FindMoved.runFindMoved`) · Relink…
  (meshes; `relinkAsset`, undoable) · Show in Sources (opens the modal with the
  asset highlighted) · Remove. The hover × delete button is retired (Remove
  lives in the menu).
- Boot re-mount: `findRemountOffer()` (no UI, no permission prompt; null when
  `!caps.persistAssets`, no stored ref, or already mounted) +
  `remountLast(offer)` (must run in a user gesture — the banner button; toasts
  on permission denial). `promptRemount` remains as a legacy alias of
  `findRemountOffer`. The `remountFolder` modal is removed.
- Folders card: unchanged (name, relative path, badges; no chip, no menu).

---

## Sources modal (`src/ui/SourcesModal.js`) — new section

Modal id `assetSources`, registered by `AssetPanel.init()` via
`SourcesModal.init()`; opened by the Project-tab **Sources** button and card
menu **Show in Sources** (`SourcesModal.open({ focusAssetId })`).
- Lists every `assetLibrary` entry, sorted Missing → Changed on disk → Linked →
  Embedded copy, then by display name. Row: qualified name (dimmed qualifier,
  original in tooltip) · Source chip · where (source path, "Was at <path>" when
  missing, "Saved in the project" when embedded-only, "No file and no saved
  copy" for ghosts) · actions (Refresh when `linked|changed`, Find moved file…
  when `canFindMoved`, Relink… for meshes).
- Summary line with monospace counts per status; bulk actions **Find moved
  files (N)** (sequential `runFindMoved`) and **Relink missing (N)…**
  (sequential relink pickers; stops when a picker is cancelled).
- Re-renders on `ASSET_RELINKED / ASSET_REMOVED / ASSET_REGISTERED` while open.
- Exports the status vocabulary used by the cards: `SOURCE_STATUSES`,
  `sourceStatus(asset)`, `statusChipHtml(status, extraClass)`.

---

## Boot banner (`src/ui/BootBanner.js`) — new section

One slim (32px) strip inserted before `#app`; `body.has-boot-banner` shrinks
`#app` to `calc(100vh - 32px)`. Content: "Welcome back" · "Re-mount folder
**<name>**" and/or "Recover unsaved work from `HH:MM` (in <project>)" ·
[Re-mount] [Recover (primary)] [×]. Non-blocking; nothing happens until a
click (the click is the gesture a browser folder re-grant needs). Re-mount →
`AssetPanel.remountLast`; Recover → re-mount first if still offered, dirty
confirm, `recoverAutosave(offer)`; × hides (autosave kept). The banner
disappears once every offer is used. Re-renders on `LOCALE_CHANGED`. API:
`show({remount, recover})`, `hide()`, `runBootChecks()`, `formatSavedAt(iso)`.

---

## Project Menu (`src/ui/ProjectMenu.js`) — modal list

`recoverAutosave` is no longer dispatched (boot banner, task 4.7); drop it
from the registered list when ProjectMenu removes the renderer.
`unmatchedAssets` / `ghostAssets` are superseded by the Sources modal (task
4.6) — still dispatched by ProjectLoader until removed.

---

## Import — "already in this project" dialog (task 4.8 display, Decision 16)

`AssetImport.askDuplicateImport({filename, existingName})` dispatches modal id
`duplicateImport` (rendered by AssetPanel): icon + title "Already in this
project", "Source: **<filename>**", a body panel (same-content sentence + hint
"Add another copy reuses it. Import as separate asset keeps an independent
copy."), buttons [Import as separate asset] [Add another copy (primary,
focused default)], × top-right. Close results `'copy' | 'separate'`; ×/Esc/
backdrop → `null` (import cancelled). Contract `'copy'|'separate'|null`
unchanged; it no longer rides the generic `confirmAction` modal.

---

## Known risks table (≈ line 5454) — replace the row

| IndexedDB FS handle permission resets per session | Boot banner "Re-mount" button (AssetPanel.remountLast) re-grants via its click gesture; per-asset recovery in the Sources modal / card ⋯ menu (Refresh · Find moved file… · Relink…) |

### Shell chrome (overhaul 5.1 / 0.7 / 3.3 / 5.7 / 5.4)

**Header (§13/§13b).** Order: logo · project name · workspace segmented switcher (centred) · action cluster:
Import (`#btn-import`, primary, `ViewportDrop.promptImport`, Ctrl+I) · New/Open/Save/Save As/Recent · Undo/Redo
(`#btn-undo`/`#btn-redo`, enabled from `HistoryManager.getUndoLabel/getRedoLabel`, refreshed on HISTORY_*/PROJECT_*) ·
Export (`#btn-export` → Print workspace, Export tab, right column opened) · locale switcher · `?` menu (`#btn-help`):
Keyboard shortcuts (dispatches `document` CustomEvent `mx:help-sheet` for 5.5 to handle) and Reset all settings (opens the
existing `resetSettingsConfirm` modal). Reset-all no longer has its own header button. DOM order is pinned by CSS `order`.

**Arrange (0.7).** The 3D Cursor drawer is now "Arrange": root `#cursor-panel` (was `#n-panel`; class `.n-panel` unchanged),
sections Placement then a "3D cursor" sub-section. Shift+N and the viewport-toolbar Arrange button
(`[data-kind="arrange"]`, group `arrange`) both toggle it; `CursorPanel` exports `open/isOpen/toggle` and emits a document
CustomEvent `mx:arrange-toggled` so the toolbar button mirrors the drawer.

**Scope breadcrumb (3.3).** `src/ui/ScopeBreadcrumb.js` renders `#scope-breadcrumb` (viewport top-left, right of the NavCube):
"Scene › group › subgroup" + "Esc to exit group", hidden at root, rebuilt on SCOPE_CHANGED / history / project events. Each
ancestor crumb (incl. the "Scene" root crumb, `data-scope=""`) calls `Selection.setScope`; the last crumb is the current scope.
While scoped it sets the status-bar hint (`scope.statusHint`); at root it clears it so `status.defaultHint` (now ending
"Double-click a group to enter") shows. Initialised from `ViewportToggles.init()`.

**Viewport toggle strip (5.7).** `#viewport-toggles` is a top-right HUD strip: feature toggles Grid / Axes / Build volume
(`scene.overlays.grid|axes|bedPreview`) and Cross-section (`scene.section.enabled`, session-only, applied via
`SceneManager.setSectionPlane`), then the display-mode select and Wireframe / Inverted-faces buttons. Toggles are viewport
chrome only (never exported) and call `ScenePanel.refresh()` so the Scene panel mirrors them. Pivot stays in the bottom
toolbar (plan §4.7: toolbar dropdown).

**Scene Advanced (5.4).** Scene panel section key `advanced` ("Advanced"), after Environment: colour grade, lights, ambient
occlusion, performance. Collapsed by default; collapse state persists per user in `mixomesh.scenePanel.collapsed.v1`.
Background, HDRI and the floor stay in Environment. No new schema keys.

## PART 13b — WORKSPACES & PANEL HIERARCHY

**Status:** SHIPPED v1 (2026-06-12) — `src/ui/Workspace.js`, `ui.workspace` +
`ui.panelCollapsed` in state, `WORKSPACE_CHANGED` / `PANEL_COLLAPSED_CHANGED`
events, `body[data-workspace]` CSS in layout.css, SceneManager resize hooks,
localStorage persistence, `.mixo` ui-strip. Two deliberate v1 deviations:
- **Hotkeys are `Ctrl+Shift+1/2/3`**, not the spec'd `Ctrl+1/2/3` — Chrome
  reserves Ctrl+digit for tab switching and never delivers it to the page.
- **Section-visibility presets, not expand presets.** The per-SECTION
  expand/collapse defaults in the workspace table below (e.g. "Transform
  expanded, Shader header-collapsed") are NOT implemented. Instead (2026-06-12
  decision: no repeated sections across workspaces unless genuinely needed)
  each workspace shows Properties + at most ONE specialist section:
  Layout → none (arrange focus, asset panel visible), Shade → **Shader
  Library**, Scene → **Scene** panel, Print → **Print**. FOUR workspaces —
  Scene was promoted to its own workspace between Shade and Print
  (user decision 2026-06-12). `ShaderPanel.focus()` auto-switches to Shade
  when invoked from another workspace (Properties chip click / ContextMenu
  Set Shader). Expansion state within visible panels is left to the user.

**Design intent.** The user's workflow is linear — *Import → Arrange → Shade → Print* — not the swiss-army-knife DCC pattern. Tabbed panels with manual resize don't scale once the Print pipeline grows (Bed / Scale / Validation / Export, plus deferred Thickness / Orientation). Industry-standard fix is **workspace presets** (Blender top-bar pattern, also Substance Painter, Maya, Cinema 4D, Houdini): a tiny set of named panel layouts, one click to switch. The user stops resizing because the layout is *per task*, not freeform.

This is **not** a full dockable/floating-panel system (Blender's `Area`/`Region` model). Overkill for a focused tool. The contract here is:

1. Three fixed workspaces (`Layout` / `Shade` / `Print`).
2. A semantic elevation token assignment so parent-child panel hierarchy reads at a glance.
3. Three single-key panel-collapse hotkeys for the "give me the viewport now" panic case.

### The three workspaces

| Workspace | Outliner | Properties | Scene Panel | Shader Library | Asset Panel | Print Panel |
|---|---|---|---|---|---|---|
| **Layout** (default — import & arrange) | visible 260px | visible, task-filtered: Object / Transform / File units / Print (Shader + UV hidden) | hidden | hidden | visible at default 220px (drop target focus) | hidden |
| **Shading** (id `shade` — texture / shader / UV) | visible 220px (narrow) | visible, task-filtered: Object / Shader / UV Override (Transform + File units + Print hidden) | hidden | **visible, expanded — primary edit surface** | hidden | hidden |
| **Scene** (grid / environment / camera / Rendering output) | visible 220px (narrow) | **hidden** (scene-wide, not object work) | **visible** | hidden | hidden | hidden |
| **Print** (validate + export) | visible 220px (narrow) | **hidden** (per-object Print toggle lives in Layout; selective export via Print ▸ Export "selected only") | hidden | hidden | hidden | **visible at full height** (Scale / Validation / Bed / Export) |

Properties section filtering is pure CSS (`body[data-workspace]` +
`.pp-section[data-section]`, layout.css) — the panel renders everything,
the workspace decides what shows.

Outliner is **pinned** in every workspace — you always need the scene list to know what you're working on. The user can still hide it via `panelCollapsed.left` (manual override), but it isn't a workspace default.

**Top-bar UI.** Workspace switcher is a four-button pill in the header (icon + label per button: Layout=`Box` / Shading=`Palette` / Scene=`Boxes` / Print=`Printer` — Scene mirrors the Scene-panel top glyph; `Boxes` ≠ the Layout `Box` and avoids the old `SunDim` clash with the Environment `Sun`). Active button highlighted with `--accent`. Tooltip on each button shows the hotkey (`Ctrl+Shift+1..4`). Module: `src/ui/Workspace.js` (`_renderPill`).

**Switch ergonomics.** Right-panel scroll positions are remembered per
workspace (session-only `_scroll` map, captured on switch-away, restored on
switch-back). The Properties empty state is task-aware: empty scene → import
hint; Shading → "select an object to edit its shader"; else the generic mesh
hint (re-rendered on `WORKSPACE_CHANGED`).

### Elevation token assignment (the hierarchy contract)

The existing `--bg-0..--bg-4` ladder gets a **fixed-assignment rule** (PART 1 tokens table). Each rung has a documented role; don't reuse a rung at the wrong level. The rule:

| Token | Used for |
|---|---|
| `--bg-0` | viewport / app background |
| `--bg-1` | **top-level panel surface** — Outliner, Properties, Shader Library, Asset Panel, Print Panel |
| `--bg-2` | **section surface inside a panel** — `.pp-section`, `.sp-section`, `.ap-card` body |
| `--bg-3` | **control surface** — inputs, default buttons, selected rows |
| `--bg-4` | hover / pressed elevation on top of `--bg-3` |

Plus two **semantic border roles** (also in PART 1 tokens):

- `--border-panel` (= `--border-strong`) — 1px, between top-level panels.
- `--border-section` (= `--border`) — 1px, between sections inside a panel.

Each top-level panel gains a 1px **top stripe** in `--accent` when it owns keyboard focus, `--border-panel` otherwise. Reads as a parent-child tree without relying on whitespace alone (which was the audit issue — sections and panels visually blended).

**Implementation contract:** every CSS rule that sets `background-color` on a panel must use the right token. Audit checklist:
- `.pp-body`, `.sp-body`, `#asset-panel`, `#print-panel` root → `--bg-1`
- `.pp-section`, `.sp-section`, `.ap-card` → `--bg-2`
- `input`, `select`, `textarea`, `.pp-btn` (default) → `--bg-3`
- `:hover` on the above → `--bg-4`

### Panel-collapse hotkeys (the panic-button pattern)

Three single keys, gated by `InputManager` when an `<input> / <textarea> / <select>` has focus (same gate the `G/R/S` modal ops use):

```
N              → toggle right column (Properties + Shader + Print stack)
T              → toggle bottom region (Asset Panel)
\              → max viewport — collapse right + bottom together
Ctrl+1/2/3     → switch workspace
```

`N` and `T` are Blender-canonical (Properties / Toolbar). `\` is the "I need the viewport NOW" key — collapses everything except the pinned Outliner. The Outliner has no toggle hotkey because hiding the scene list mid-work is rarely what the user actually wants; they can still hide it via the splitter handle.

### State shape

```js
state.ui = {
  ...existing,
  workspace: 'layout',                                  // 'layout' | 'shade' | 'print'
  panelCollapsed: { right: false, bottom: false, left: false },  // manual overrides on top of workspace defaults
};
```

**Resolution rule** for "is panel P visible?":
1. If `state.ui.panelCollapsed[side]` is `true`, hide.
2. Otherwise, look up the workspace's default visibility for P.
3. Workspace-defaults that say "hidden" still respect `panelCollapsed[side] === false` (user can pop a panel back up explicitly).

Switching workspace **resets** `panelCollapsed` to all-`false` so the new workspace starts from its declared defaults. Mid-workspace `N/T/\` toggles only flip `panelCollapsed`, never `workspace`.

### Persistence (per-user, not per-project)

Workspace + `panelCollapsed` + per-workspace panel widths persist to `localStorage.mixomesh_ui_workspace` (JSON object). NOT stored in `.mixo` — workspace is a *user preference*, not a project artefact. A teammate opening the same `.mixo` on a different monitor shouldn't inherit the saver's layout.

Boot sequence: `PersistenceManager.init` (or a small `src/ui/Workspace.js` module) reads `localStorage` → seeds `state.ui.workspace + panelCollapsed` before the first render. Missing key → workspace defaults to `'layout'`. Schema version field in the localStorage blob so future shape changes can migrate.

## Per-user settings persistence (`core/SettingsStore.js`)

Separate from the workspace/layout persistence above: the browser remembers the
user's last-used **panel settings** so a fresh boot / New project starts with
them. **Content is never persisted here** — objects, shaders, UV, selection,
live camera pose, cross-section, cursor live in the `.mixo` file only.

**Factory defaults** live in **`src/config/default-settings.json`** — the single
source of truth, consumed by `StateManager.INITIAL_STATE` for those slices AND
by every reset. Edit the JSON to change the default setup everywhere (boot, New,
all reset buttons), no code change.

**Persisted slices** (`SettingsStore.SCHEMA`): `scene.render` (full look/grade/
env/HDRI/SSAO/textureCap), `scene.renderOut` (minus `pose` — a session/project
composition), `scene.grid`, `scene.overlays` (display prefs `grid`/`axes`/
`printPreview` ONLY — inspection modes like wireframe stay session-only),
`print` (all), `gizmo` (`space`+`snap`, not transient `mode`),
`selection.pivotMode`. A corrupt/old blob can only inject SCHEMA-known paths
(`mergeSettings` narrows to known keys).

**Precedence — FILE WINS:** `seedBootState()` merges persisted settings onto the
factory boot state at state init (before panels render); `applyToScene()` pushes
them to the engine (replaces the old inline boot block in `main.ts`). New
(`PersistenceManager.newProject`) re-seeds per-user defaults. Opening a `.mixo`
restores the file's slices directly and never re-seeds — so a loaded project's
look is authoritative.

**Save trigger:** debounced `scheduleSave()` on USER edits only — a capturing
`change`/`input` listener on `#rp-scene-body` + `#rp-print-body`, plus the
`GIZMO_CHANGED`/`PIVOT_MODE_CHANGED` events. Programmatic applies (boot/load)
bypass it, preserving File-wins.

**Reset:** per-section `↺` buttons (`SettingsStore.SECTION_KEYS`:
grid/environment/camera/rendering on the Scene panel, one `print` button on the
Print tab bar — Properties/object + session-only Cross-Section have none) call
`resetSection(key)`; the top-bar `↺` (ProjectMenu `.pm-bar`) calls `resetAll()`
(settings only — workspace/widths/section-collapse untouched). Both restore from
`default-settings.json`, re-apply to the scene, and dispatch `SETTINGS_RESET`
(Scene + Print panels re-render).

**Scene-protected fields:** when a scene is loaded (`state.scene.objects`
non-empty), a reset does NOT preserve per-object scale (deprecated 2026-06-16,
Per-Object Ratio Redesign task 2.2) — each object's `ratio` is content, not a setting,
and belongs in the `.mixo` document, never in user settings. All settings fields
(bed, wall, mode, render, grid…) always reset on both empty and loaded scenes.
`SettingsStore.SCENE_PROTECTED` is now empty `{}` (scale is content, not a setting).

**Header logo:** `#app-logo` is an **inline** SVG wordmark in `index.html`,
pinned far-left of `#header` before the editable `#project-name`. Inline (not
an `<img>`/`public/` asset) so it has no HTTP request and no base-path
dependency, and `fill: currentColor` themes it with the header text. Sized via
CSS (`#app-logo svg { height: 26px }`).

### Module sketch

`src/ui/Workspace.js` (~120 lines target):
- `init()` — subscribes to `EVENTS.WORKSPACE_CHANGED`; renders the header pill switcher; binds the four hotkeys via `InputManager`.
- `setWorkspace(name)` — dispatches state change + resets `panelCollapsed`.
- `togglePanel(side)` — flips `panelCollapsed[side]`.
- `maxViewport()` — sets `panelCollapsed = { right: true, bottom: true, left: false }`.
- Applies a `data-workspace="…"` attribute on `<body>` so CSS can hide/size panels per workspace without per-panel JS.

CSS hook points (one selector per panel, three workspaces × hidden|narrow|wide):
```css
body[data-workspace="layout"]   .panel-shader  { display: none; }
body[data-workspace="shade"]    .panel-print   { display: none; }
body[data-workspace="print"]    .panel-shader  { display: none; }
body[data-panel-collapsed-right="true"]  .panel-right-column { display: none; }
/* …etc */
```

This keeps the layout logic declarative — flip an attribute, the grid recomputes. No per-panel show/hide imperative code in twenty places.

### Events

```js
EVENTS.WORKSPACE_CHANGED       // payload: { from, to }
EVENTS.PANEL_COLLAPSED_CHANGED // payload: { side, collapsed }
```

Subscribers: `src/ui/Workspace.js` for re-render; `SceneManager` (engine.resize() on the next animation frame so the canvas fills the new viewport size).

### Why not full dockable panels

Considered. Rejected for v1.

Pros of full docking (Blender/Maya/Houdini): infinite flexibility, power users love it.

Cons: heavy implementation (drag-to-detach, drop-zone detection, floating windows with their own resize/close), serialisation of arbitrary trees, and a UX cost — users have to *learn* where they put things. The MIXOMESH workflow is linear and small. Three workspaces cover 95% of the value at ~5% of the implementation cost.

If a future user requests it, the layered design above supports it: workspace presets become *named saves* of an arbitrary layout tree. v1 ships fixed presets.

### Rollout plan

Order when it lands:

1. Update tokens.css (semantic borders + the elevation comment block).
2. Add `state.ui.workspace + panelCollapsed` + localStorage persistence.
3. Write `src/ui/Workspace.js` + header pill + hotkey bindings.
4. Add `data-workspace` driven CSS rules in `layout.css`.
5. Audit each panel root's CSS to confirm it sits on `--bg-1`, sections on `--bg-2`, controls on `--bg-3`.
6. Headless tests: state-shape test for the new `ui.workspace + panelCollapsed` defaults; one round-trip test for the localStorage seeding.
7. Live Chrome pass: workspace switch + hotkeys + visible hierarchy + maximised viewport on `\`.

---

## PART 14 — STABILITY PATTERNS

### 14.1 Status — centralized error + loading policy (`src/ui/Status.js`)
ONE module owns the two cross-cutting concerns; everything else delegates, so
changing how the app surfaces failures or shows progress is a single edit.
```js
reportError(err, { title, modal, filename })  // toast, or the detail modal (import/export)
guard(fn, { title, modal, filename, loadingToastId })  // run + route failure → reportError
runTask(label, fn, { overlay })               // ONE loading path (overlay | loading toast), always cleaned up
safeAsync(fn, loadingToastId)                 // toast-policy adapter = guard({title:'Error'})
```
Adapters delegate here: `safeAsync` (re-exported from `Toast.js` for compat) and
`ImportError.safeImport` (= `guard({ modal:true })`). Wrap every async UI entry
point in `safeAsync`/`safeImport`. DELIBERATELY out of scope: intentional silent
fallbacks (`catch { /* optional */ }`) and domain loaders with their own staged
/ nested progress (`AssetLoader` import overlay, `PrintManager` export) — those
aren't the shared concern and centralizing them would be false-DRY.

Adopted catch-site policy (2026-07-17 sweep — every raw `catch` either routes
through `reportError` or carries a one-line comment naming why it is silent):
- **`reportError`**: PNG/turntable export failure (ScenePanel), auto-fix +
  export failure (PrintPanel; export uses `modal:true`), asset-embed failure
  during save, autosave failure (warn-ONCE per session flag, resets on next
  success), user-requested validation failure (AssetLoader).
- **Console-only by design**: tiered asset resolve + container restore in
  PersistenceManager (the ghost mesh / unmatchedAssets modal already surface
  the miss), thumbnail generation (cosmetic).
- **Fully silent by design**: WorkerImport queue-chain detach (caller still
  gets the rejection), EnvironmentRig idle HDRI prewarm.

### 14.2 Disposal Discipline
**On delete mesh:**
1. Detach gizmo.
2. Remove from HighlightLayer.
3. Dispose UV override material clone if present.
4. Remove meshId from `shader.linkedMeshIds`.
5. `AssetLoader.releaseAsset(assetId)` (only disposes container if zero refs).
6. Remove from state.

**On new/load project:**
1. Revoke all blob URLs.
2. Dispose meshes, materials, containers.
3. Clear all module-local Maps.
4. `HistoryManager.clear()`.
5. Reset state to `initialState`.

### 14.3 Large Mesh Guard
- On import: if `vertexCount > 100_000`, skip auto-validation, show toast.
- On import: if `vertexCount > 500_000`, also skip auto-thumbnail (use generic icon).

### 14.4 Render Loop Hygiene
- Never call `StateManager.getState()` inside `scene.registerBeforeRender`. Cache via event subscription.
- Gizmo drag updates Babylon transforms directly; state is updated only on `onDragEndObservable`.

---

## PART 14b — HEADLESS TEST HARNESS

**Directory: `tests/`** — Node-native, no build, no framework. Drives the *real* `PrintManager / MeshValidator / PersistenceManager` modules with stubs for browser-only deps (Babylon shim, JSZip, IndexedDB, DOMParser).

### Run command (single)
```
node --import ./tests/register-hooks.mjs --test tests/*.test.mjs
```
**`--import` runs the register-shim, NOT the hooks file directly.** `tests/register-hooks.mjs` is a one-liner that calls `module.register('./hooks.mjs', import.meta.url)` — the Node module-customisation API. Pointing `--import` at `tests/hooks.mjs` is silently wrong: it'll run the file's top-level code (the `resolve` export), but Node won't register it as a loader, so resolutions fall through to the real `idb.js` / `jszip` and tests hang on `indexedDB is not defined`.

### Resolver hook (`tests/hooks.mjs`)
```js
export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'jszip')      → tests/jszip-stub.mjs    // app imports `await import('jszip')`
  if (specifier === './idb.js')   → tests/idb-stub.mjs      // path-suffix match
  return nextResolve(specifier, context);
}
```

### Stubs
- **`tests/idb-stub.mjs`** — Map-backed mirror of `src/core/idb.js`. Same export surface (`putHandle / getHandle / kvSet / kvGet / putFileHandle / getFileHandle / __reset`). `__reset()` wipes both Maps between tests.
- **`tests/jszip-stub.mjs`** — minimal JSZip for export tests.
- **`tests/env.mjs`** — `installEnv()`: shims `window.BABYLON` minimally, polyfills `atob / btoa`, registers `DOMParser`, etc. Every test file calls `installEnv()` before importing the modules under test.

### Test files
| File | Count | Covers |
|---|---:|---|
| `tests/export.test.mjs` | 52 | PrintManager: collection gating; per-format prep; non-destructive clone; post-fix validation; selectedOnly / individually (OBJ + STL + 3MF colorgroup + 3MF materials-ext); logical-object grouping for internal material splits; OBJ fallback material; generated MTL matching OBJ `usemtl` ids; PBR/albedo MTL support; STL CSG present/absent + non-watertight rejection; 3MF OPC structure + colorgroup + origin-centering + winding-flip + explicit-identity build item; per-object 3MF wraps each inner OPC zip in an outer `.zip`; filename pattern (`${project}${suffix}.${ext}` combined, `${project}_${mesh}${suffix}.${ext}` individually) covers OBJ + STL + 3MF colorgroup + 3MF materials-ext including OBJ `mtllib` reference; OBJ solid-colour PNG synthesis (default off, explicit on/off, dedup by RRGGBBAA, opacity-byte flow, textured-shader skip, individually-mode per-mesh map_Kd injection); progress monotonic |
| `tests/export-planner.test.mjs` | 4 | ExportPlanner: `_r{scene}to{print}` filename contract, safe filename stems |
| `tests/progress-overlay.test.mjs` | 2 | ProgressOverlay blocks document-level keyboard events while visible and releases them after hide |
| `tests/validator.test.mjs` | 4 | MeshValidator: position-welded manifold (no false positive on unwelded imports); non-manifold + inverted-normals = `warning` (not blocking) |
| `tests/persistence.test.mjs` | 18 | PersistenceManager `__test`: base64 byte fidelity (0x8000 boundary + full 0–255); sha256; `_resolveAssetBlob` 5-tier priority (incl. `fileHandleKey` granted/denied + dir-beats-handle); `_scanDirForHash` recursion + ext filter; `_fileHandleAtPath`; `_arrToMap`; `_migrate` passthrough |
| `tests/portable-project.test.mjs` | 4 | Portable `.mixo` integrity: manual saves reject required mesh assets without embedded bytes, mounted-library meshes embed for clean-profile reopen, content-addressed texture payloads satisfy used texture refs, autosave skips only handle-backed assets |
| `tests/printer-profile.test.mjs` | 3 | PrinterProfiles: Mimaki default profile, filament target selection, unknown-id Mimaki fallback |
| `tests/import-metadata.test.mjs` | 5 | ImportMetadata: Blender glTF `extras` ratio parsing, `library = 1` marker detection, library item root detection |
| `tests/library-import.test.mjs` | 3 | AssetLoader GLB library mode: marked pack registers one AssetEntry per top-level object without SceneObjects; child asset instantiates only its own object; normal GLB empty hierarchy imports as Outliner groups |
| `tests/hierarchy.test.mjs` | 4 | Hierarchy commands: reparent/unparent preserve world transforms, keep `collectionId` independent, reject invalid parent edges, and ungroup direct objects/subgroups with deterministic undo/redo |
| `tests/logical-objects.test.mjs` | 3 | Selection canonicalizes an internal split pick to the visible logical object while resolving all internal meshes for manipulation; delete removes every internal split part; duplicate creates an independent logical split object |
| `tests/scale.test.mjs` | 8 | ScaleMath: ratio parser/formatter, Authored→Scene normalization, Scene→Print export scale, scene-scale rebake factor, v3.1 field compatibility |
| `tests/split-on-import.test.mjs` | 5 | AssetLoader splits MultiMaterial meshes at import time; every sibling shares one `logicalObjectId` (split-time `sourceGroupId` stamp is the import key only) so the group can be re-unioned downstream |
| `tests/state-shape.test.mjs` | 11 | StateManager INITIAL_STATE invariants: required slots, defaults, `print.objBakeSolidTextures = false`, persistence migration shallow-merge handles missing keys |
| `tests/texture-source.test.mjs` | 6 | TextureSource + ExportTextures: first-writer-wins full-res capture, export-prefers-source, user-loaded texture asset-id lookup + real filename, GPU fallback |
| `tests/threemf-components.test.mjs` | 5 | 3MF components: solid/textured hierarchy export emits component objects, nested component resources are dependency-ordered, Materials Extension resources remain intact, component import creates transform groups with child meshes, and production-extension `p:path` component links load related model parts |
| `tests/threemf-materials-ext.test.mjs` | 6 | 3MF Materials Extension writer: content-driven textured vs solid-only flavor, texture dedup, UV round-trip via pseudo-loader regex, printer dropdown does not switch flavor |
| `tests/validator-group.test.mjs` | 6 | Group-aware MeshValidator: split siblings re-union as welded watertight body; broken group reports the real seam; validate-all dedupes split groups |
| `tests/render-output.test.mjs` | 6 | RenderMath: dimension clamp, turntable easing endpoints/symmetry, signed 360° alpha, video format pick (mp4 avc3 → WebM vp8 fallback, thrower-safe), frame aspect-fit/centre, render/turntable filenames share the export stem contract |

The table is NOT exhaustive — `npm test` runs every `tests/*.test.mjs`
(see the file tree; later additions cover workspaces, texture identity,
hybrid asset resolve, shader rebinds, validation cache, …). Drives the
*real* modules — passing tests guarantee the load-path math, byte
fidelity, and export pipeline. **Out of scope (headless):** live Babylon
scene round-trip, `showSaveFilePicker` save flow (the picker prompts the
user — verified live in Chrome; the test harness exercises the
anchor-fallback branch of `triggerDownload` only), autosave timer firing,
Outliner ghost row UI, 3MF rendered in a slicer.

### Browser Smoke Harness

Run separately from the Node test suite:

```bash
node tests/browser-smoke.mjs
```

The script uses only Node built-ins, the repo-local Vite executable, and a
locally installed Chrome or Edge. It starts a temporary Vite server, opens
`index.html`, verifies the local npm-built Babylon namespace, waits for
the boot overlay to clear, and asserts the main shell panels/render canvas
— plus the functional rendering-stack pins listed at the file-tree entry
(PNG alpha, floor shadow-only swap, offline mp4, turntable rigidity, HDRI
rotation probe) and the 2026-06-13 wave: offline frame-source pixel
variance (`captureFrameRGBA`), the section-plane cut sign convention
(no-cut/cut/flip alpha triple), bounce-in exact-scaling landing, soft
shadow pixels with a real caster (RENDERONCE tripwire), the SSAO
enable/disable toggle, and the project-switch recording abort.

Companions: `npm run test:export` (functional export round-trip incl. the
OBJ-worker path), `npm run test:video` (OPTIONAL headed full-size sweep;
`VIDEO_CHECK_EDGE=1` forces Edge — video is WebCodecs-only now, MediaRecorder
removed), `npm run test:webgpu` (WebGPU backend + WGSL + capture; headless SKIPs
without an adapter, `WEBGPU_HEADFUL=1` for a real GPU), and
`tests/webcodecs-probe.mjs` (diagnostic: VideoEncoder sanity in headless Chrome).
It launches the browser headless with a
remote-debugging port, drives Chrome DevTools Protocol directly, and fails on
page exceptions or console errors. Assertions cover app boot, canvas, project
toolbar, outliner, asset grid, right-panel `aria-expanded` toggles, splitter
keyboard resize, named/trapped modals with focus return, visible keyboard
focus on primary shell controls, keyboard outer-panel resizing, blocked export
button states, portable-save recovery modal, narrow-window guard, toast/modal/
progress roots, and removal of `#boot-status`.
If Chrome/Edge is missing, the script exits with a clear setup error. This is
not an external slicer acceptance check; it is a fast app-shell regression
guard for local UI changes.

### Adding a new test file
1. Create `tests/<name>.test.mjs`, start with `import { installEnv } from './env.mjs'; installEnv(); console.error = () => {};`.
2. Drive *real* modules via dynamic `await import('../src/core/Whatever.js')` so the resolver hook fires.
3. Tests should call `resetIdb()` between cases for isolation (see `persistence.test.mjs` pattern).
4. New browser-only deps need a stub + a `hooks.mjs` redirect line.

---

## PART 15 — BUILD HISTORY AND CURRENT VERIFICATION STATUS

This section records the current product baseline and points to the append-only
build history. Detailed behaviour contracts live in the module sections above.

### Current Product Baseline

- **Primary workflow:** import textured/full-colour models, assemble and transform parts, assign/override shaders and UVs, validate printability, then export via the explicit OBJ / 3MF / STL format buttons.
- **Primary target:** Mimaki 3DUJ-553 by default (`state.print.targetPrinterId = 'mimaki-3duj-553'`, bed `508 × 508 × 305` mm). Mimaki targets preserve continuous-tone textures through 3MF Materials Extension or OBJ+MTL+PNG.
- **Secondary workflows:** solid-only scenes export 3MF `<colorgroup>` for Bambu / Prusa / Orca-style slicing (task 1.11). Textured content always uses the 3MF Materials Extension and solid content `<colorgroup>` (content picks the colour REPRESENTATION, AGENTS rule 6); the package FLAVOUR (core / bambu / prusa) is a printer-profile default the user may override (task 1.11).
- **Verification baseline:** run `npm run lint`, `npm run typecheck`, `npm run i18n:check`, `npm run build`, and `npm run test:all` (= `test` → `test:browser` → `test:export` → `test:repair`). Lint is ESLint flat config (`eslint.config.js`): ~10 core rules (no-unused-vars w/ `^_` + rest-sibling exemptions, no-console except warn/error, prefer-const, no-duplicate-imports, no-undef w/ `BABYLON` global, …); `tests/` and `scripts/` are exempt from no-console (harnesses report via stdout); `.ts` files stay tsc-only. Do not hard-code total test counts in this spec; counts drift as coverage changes. Manual Chrome file-picker checks and external slicer acceptance checks remain useful when changing persistence/export behaviour, but they are not tracked as an active handoff.

### Build history

Moved to `BUILDLOG.md` (append-only; arch review A10). This part keeps only
the contracts below — baseline, locked decisions, and accepted scope cuts.

### Locked Design Decisions

- Printer presets are build-area data only (`displayName`, `vendor`, XYZ bed). Adding one never changes or selects an export writer.
- Mimaki targets must never collapse textures to solid colours. Filament targets intentionally collapse to solid per-part colours.
- One-mesh-one-shader remains an invariant. MultiMaterial imports split into single-material siblings sharing a `logicalObjectId`; validator/exporter re-union by it (`sourceGroupId` is migrate-only).
- Export prep is non-destructive: clones get unique geometry before any world flattening, welding, normal creation, CSG, or serialization.
- Group-aware topology checks weld split siblings in validator-local buffers only; no welded data is copied back into Babylon meshes.
- `AGENTS.md` is the active instruction authority; `CLAUDE.md` is legacy context only.

### Accepted Scope Cuts

- Persistence load restores glTF-embedded imported-texture shaders to persisted diffuse colour when the original embedded texture cannot be rebound; geometry, user-loaded textures, shader parameters, transforms, groups, collections, camera, and print state restore.
- Mimaki 3MF loader/writer is XML-contract complete; external slicer compatibility should be rechecked when export semantics change.
- 3MF `<m:texture2d>` optional defaults (`contentbox`, tiling, filter) are omitted unless a Mimaki slicer requires explicit values.

---
## PART 16 — ACCEPTED CONSTRAINTS

| Constraint | Mitigation |
|---|---|
| Chrome / Edge / Safari (WebKit) only | Single startup check (`engineGate`); blocking dialog otherwise |
| Source unit assumed mm (Blender default) | Per-asset override in Properties Panel; flips `unitConfirmed: false` until reviewed |
| Validation v1 = 3 checks only | Future Pro version adds thin-wall, self-intersect, overhang |
| Numpad shortcuts assume numpad | `Alt+1/3/7` registered as alternates |
| OBJ+MTL slicer support varies | Informational tooltip — not a blocking warning |
| IndexedDB FS handle permission resets per session | Boot remount-folder modal (AssetPanel.promptRemount) re-grants via its button gesture; per-asset relink via the unmatched-assets modal |

---

## §Boolean — interactive Boolean (kitbash combine)

*Full design + rationale: `docs/adr/0002-interactive-boolean.md`. This is the contract.*

**Purpose.** The defining pre-slice kitbash "combine" verb: union / subtract / intersect
on selected parts → one printable solid (or cut socket). Engine = Babylon CSG2 (Manifold),
the same one the export re-bake uses (`PrintPipeline`).

**Hard rule — SOLID-COLOUR ONLY.** CSG2/Manifold **drops UVs** (verified in
`@babylonjs/core/Meshes/csg2.d.ts`; the export path already skips CSG2 for textured meshes,
`PrintPrep.csgSolidOnly`). So a Boolean runs only on solid-colour operands. A textured operand
(any of: `diffuseTexture`, `albedoTexture`, `normalTexture`, `bumpTexture`, `emissiveTexture`,
`opacityTexture`, `specularTexture`, `lightmapTexture`, `ambientTexture`, `microSurfaceTexture`, `detailMap.texture`,
`occlusionTexture`, `metallicTexture`, `reflectanceTexture`, and the `.texture` of the `sheen` / `anisotropy` / `clearCoat` configs; NOT `reflectionTexture` — the PBR environment map)
triggers a **bake-to-solid-or-cancel modal** — NEVER a silent texture drop (the Mimaki colour moat).

**Gating (pure, pre-CSG2).** `BooleanService.evaluateBooleanEligibility(operands, {triangleCap})`
returns `{ok, reason}` — hard blocks first (`needs-two`, `multi-part` [same guard as SmartReplace],
`too-large`), then the soft `needs-texture-bake`. `DEFAULT_BOOLEAN_TRIANGLE_CAP = 50_000` (web;
a desktop build passes a larger cap — ADR 0001 capabilities). Operands are also manifold-validated
(existing MeshValidator) before CSG2; non-manifold → point to validation, no crash.

**Data model — DESTRUCTIVE bake to a synthetic embedded asset (`.mxvd`).** The result geometry is
serialised to bytes via `GeometryCodec` (positions/normals/indices; no UV) and registered as an
embedded asset (`extension:'.mxvd'`), so the result round-trips through the existing pipeline (no
reload recompute, never stale). Restore adds ONE branch: `.mxvd` → decode → build mesh, SKIP
`bakeImportTransform` (already world-space). **Field invariant for a neutral restore:**
`sourceUnit='meters'` (unit factor 1) AND `modelRatio == ratio` (delta = modelRatio/ratio = 1) —
use `modelRatio=1, ratio=1` (bytes ARE the displayed size; export "as shown"). Operands
soft-deleted (SmartReplace pattern); `BooleanCommand.undo` restores them + drops the result + its
synthetic asset. One-mesh-one-shader holds (solid result = one material).

**CSG2 API (verified `csg2.d.ts`):** `CSG2.FromMesh(m)` (world-space), union = `.add()`,
`.subtract()`, `.intersect()`, `.toMesh(name, scene)`, `.dispose()`. `BooleanService.computeBoolean`
wraps it (main-thread, init cached).

**Threading.** Main-thread CSG2 (init cached once, mirrors `PrintPipeline._ensureCSG2`); a worker is
a deferred perf knob (no proven Manifold-in-worker path). Invocation: ContextMenu Union/Subtract/
Intersect on a 2+ selection (Subtract base = active object).

**Status — COMPLETE (union/subtract/intersect).** `BooleanService` (gating + `computeBoolean` CSG2
wrapper) · `GeometryCodec` (`.mxvd`) · `commands/BooleanCommands.js` `performBoolean` (async: gate →
CSG2 → `registerBakedResult` synthetic `.mxvd` asset → soft-delete operands) + `BooleanCommand`
undo/redo · `AssetRestore` `registerBakedResult` + the `.mxvd` restore branch (skips import
normalization) · ContextMenu "Combine: Union/Subtract/Intersect" + i18n. **CSG2 + InitializeCSG2Async
now imported in `boot.ts`** (were absent → the export re-bake also silently skipped; now active).
Browser smoke: union two solid cubes → watertight result, operands consumed, undo restores, survives
`.mixo` reload. Remaining polish (textured bake-or-cancel modal; subtract/intersect UI smokes) in
`docs/handoff/boolean-ops.md`.

---

## §Slice Connector — viewport cut plane with printable connector

**Purpose.** Split one selected solid-colour object into two printable baked parts with a
slicer-style connector workflow: draw a straight cut line from the current camera view, create a
temporary two-part cut preview, choose connector side/shape/size/depth/clearance, then finish as
two baked objects. This follows the Creality/Prusa/Bambu mental model where the visible action is a
straight screen-space cut line, not numeric plane entry.

**Interaction contract.** ContextMenu exposes **Slice & Connector...** for a single selected object.
Starting it enters a temporary viewport session (`ui/SliceConnectorSession.js`) and installs an
`InputManager.setViewportToolHandler` callback so LMB/RMB events are owned by the tool instead of
selection/body-drag. The session is non-destructive until **Finish**:

1. **Draw line** — user LMB-drags a straight SVG overlay line across the object from the active
   camera view. The line endpoints are ray-cast to the view plane through the object's centre.
2. **Cut** — user confirms the line; the session computes the cut plane from `{line direction ×
   camera forward}` and creates temporary CSG preview halves only. The project state is not mutated.
3. **Choose male** — both temporary halves are visible; user chooses Part A or Part B as the male
   side. Later steps hide every preview half except the male side so placement is unambiguous.
4. **Place origin** — user clicks the cut plane/intersection area on the male preview to mark where
   the connector grows.
5. **Shape/size** — user chooses round cylinder or square/traditional peg and drags on the plane
   (or enters mm) to set diameter/width.
6. **Depth** — user drags to set connector depth; preview peg grows along the cut normal.
7. **Clearance** — user enters socket clearance in millimetres.
8. **Finish** — session disposes temporary preview meshes, then runs
   `HistoryManager.push(await performSliceConnector(...))` to create the persistent two-object
   result. Cancel/RMB at any step restores the original object and disposes all furniture.

**Geometry contract.** `SliceConnectorService.planSliceConnector(bounds, options)` is pure and
accepts `cameraNormal`, either `lineStart`/`lineEnd` or the legacy `planeOffsetMM` camera plane,
`connectorPoint`, `maleSide`, `connectorShape`, `diameterMM`, `depthMM`, and `clearanceMM`.
`planeFromCutLine({lineStart,lineEnd,cameraNormal})` computes the plane normal from
`normalize(cross(lineDirection, cameraNormal))`. The plan returns plane centre/normal, projected
connector point, connector centre, front/back half-space cutter boxes, peg direction, connector
shape, peg size, socket size (`diameter + 2*clearance`), and connector length (`depth + 1mm root
overlap`). `connectorPoint` is always projected onto the cut plane before CSG so an imprecise click
cannot create a floating peg.

**Bake contract.** `commands/SliceConnectorCommands.js` runs CSG2 in this order: intersect source
with front/back cutters, union the peg into the chosen male side, subtract the clearance-expanded
socket from the opposite side, register both results as embedded `.mxvd` assets, soft-delete the
source SceneObject, and select both baked halves. Undo restores the original mesh/object and hides
the baked halves; redo consumes the source and restores the baked halves. Like Boolean, CSG is
solid-colour only; textured objects and multi-part logical objects are blocked because UVs would be
lost and one-mesh-one-shader must hold.

**Naming + recipe metadata (Level 2).** Final visible names use stable family part numbers, not
nested cut labels: `{baseName} - Part 01`, `{baseName} - Part 02`, etc. Repeated cuts on any part
reuse `sliceRecipe.baseName` and allocate the next unused part numbers. Each result SceneObject
persists `sliceRecipe` with `recipeId`, `baseName`, `partIndex`, `role` (`male`/`female`),
`sourceObjectId`, `sourceAssetId`, cut line, camera normal, plane, connector point, shape, size,
depth, clearance, and parent recipe id. `findSliceRecipePair(objects, id)` locates the matching
male/female pair by recipe id. This is the rebuild/edit contract: a future "Edit Slice Connector"
command can validate that both matching parts exist, recover the source asset, and replace the pair
from the stored recipe rather than trying to edit baked peg/socket geometry directly.

**CSG robustness.** `BooleanService.computeBoolean` clones operands for CSG and strips optional
vertex streams (`uv`, `uv2`, colours, skinning matrices/weights) from the clones. This avoids
Babylon CSG2's "geometries having the same number of properties" failure without mutating live
content meshes.

**Accepted limits.** One cut + one connector pair per operation. Round and square plug/socket
connectors are supported. Dowel mode (holes in both halves plus a separate printed pin), dovetail,
snap, multi-connector arrays, and textured cut preservation are deferred.

---

## §Placement — precision assembly verbs (kitbash)

*Full design + rationale: `docs/adr/0003-placement-precision.md`. This is the contract.*

Accurate part placement for kitbashing: **align · mirror · mate (face-snap) · array**. All are
reversible ⇒ Commands on HistoryManager, expand multi-part logical objects via
`logicalObjectCommandIds`, and hold one-mesh-one-shader. Sequence (safest first): **align →
mirror → mate → array**.

- **Align (slice 1, shipped):** `placement/AlignMath.computeAlignDeltas(items, mode)` — pure axis
  deltas (min/center/max of the selection's world AABB). `AlignCommand` reads live AABBs + applies
  via a transform Command. Headless-tested.
- **Mirror:** vertex-bake reflection + `flipFaces` when `determinant < 0` (copy ImportNormalizer
  winding fix) + `makeGeometryUnique` first. NOT node negative-scale.
- **Mate:** pick two faces → `Quaternion.FromToRef(-nB, nA)` + coincident face centres; snap at
  pick-time (faceId unstable).
- **Array:** N linear/radial clones registered atomically in ONE `push` (pre-register before mutate).

**Status.** Align + Array + Mirror + Mate shipped (`commands/PlacementCommands.js`) with a
**Placement section in the N-panel** (`ui/CursorPanel.js`, Shift+N) holding the full matrix —
align min/center/max × X/Y/Z, mirror X/Y/Z, array X/Y/Z, mate; ContextMenu keeps the common
subset. `MateCommand` = snap-abut to the active object (auto axis/side). `AlignCommand`
(world-AABB → `applyTransforms`; ContextMenu center X/Y/Z) · `ArrayCommand` (linear repeat via
`cloneMeshAsNewObject`, soft-hide undo) · `MirrorCommand` (UV-preserving geometry reflection +
winding + recompute-normals, recorded as a `mirror-<axis>` geometryFix so it **persists** via the
M1 replay; self-inverse undo; ContextMenu Mirror X/Y/Z; single-part only). Browser-smoke verified.
**Array dialog (overhaul 5.6):** Array X/Y/Z opens a modal (`arrayDialog`, registered by
CursorPanel) with Count (integer 2–100, default 3) and Spacing in mm (centre-to-centre, non-zero,
default = the active object's extent on that axis so copies touch); `parseArrayInput` validates,
Enter applies, Apply is disabled while invalid → one `ArrayCommand`. Align min/max UI + face-mate
tracked in `docs/handoff/placement.md`.

**Bed placement (2026-08-03).** `BedPlacementCommand` expands logical objects,
skips locked objects, and records one absolute-transform snapshot for the whole
selection. **Drop to Bed** translates the union world AABB to world Y=0;
**Center on Bed** moves its X/Z centre to the centred bed origin; **Place Face
on Bed** is offered from a viewport face pick, rotates that world normal to up,
then recomputes the final AABB and drops it to Y=0. Undo restores every part's
exact world transform. N-panel buttons use visible translated words at every
width (no glyph-only placement controls); Drop/Center also appear there and in
the viewport context menu.

### Empty viewport and close flow

When `scene.objects` is empty, `ViewportEmptyState` overlays two primary entry
points: **Import Model** (the same multi-file model/MTL/texture import path as a
viewport drop) and **Open Project** (`PersistenceManager.open`). Any object,
including a recoverable ghost, hides the overlay; New/removal/load events keep
it synchronized.

Browser close uses the native `beforeunload` prompt only while dirty — on web AND
Electron (`core/UnloadGuard.shouldGuardUnload`). Electron answers
`will-prevent-unload` (Ctrl+R / navigation) with a native "Leave without saving?"
confirm (skipped for an already-approved close), handles `render-process-gone` with a
Reload / Close dialog, and `MIXO_SMOKE` bypasses these guards only when
`!app.isPackaged`. Electron also
intercepts `BrowserWindow.close`, asks the renderer over the allowlisted
`app:close-requested` channel, and closes only after `{action:'discard'}` or a
successful `{action:'save',saved:true}` response; cancel and failed/cancelled
save leave the window open. The renderer never exposes Node or an OS path.

---

*End of MIXOMESH Blueprint v4.0*
