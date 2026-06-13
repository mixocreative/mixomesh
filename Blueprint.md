# MIXOMESH — Implementation Blueprint v4.0
### Babylon.js · Vite/TypeScript Runtime · Chrome/Edge Only

> **For Codex / Claude Code:** Sections are in build order. Each module section is a contract:
> *Purpose · Data Structure · Public API · Implementation Rules · Pitfalls.*
> Use Babylon.js APIs whenever available — see §0.4 "Babylon-First Rule."
> Module size targets in §0.5 are enforced to keep files reviewable.

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

Per-printer behavior is **data-driven** via `src/config/printers.json` (single
source of truth: format, color mode, texture limits, bed dimensions,
axis/winding/unit, prep pipeline). Adding a printer = adding a JSON row,
not editing code.

---

## PART 0 — GROUND RULES

### 0.1 Absolute Rules
- **Target browser:** Chrome / Edge only. App halts on startup if `'showDirectoryPicker' in window === false`.
- **1 Babylon Unit = 1 Meter.** UI shows mm: `mm = BU * 1000`.
- **All state mutations go through `StateManager.dispatch()`.**
- **All reversible actions push a Command to `HistoryManager`.**
- **All inter-module communication uses typed events from `events.js`.**
- **Export is printer-driven, not format-driven.** Target printer (from
  `src/config/printers.json`) declares format + color mode + prep steps.
  Mimaki target preserves textures; filament target collapses to solid
  per-part color. Never collapse textures for a Mimaki target.
- **One-mesh-one-shader is an enforced invariant.** AssetLoader splits any
  `BABYLON.MultiMaterial` mesh into N single-material siblings at import,
  stamping `sourceGroupId` on each SceneObject so validator + exporter can
  re-union the part.
- **Validation runs at import time, non-blocking.** Re-runs blocking before
  export. Topology checks are **group-aware**: meshes with a `sourceGroupId`
  are validated as the welded union of all siblings (positions only, no
  data copy), not as individual shells. Integrity checks (zero verts,
  missing registry) stay per-mesh.

### 0.2 Runtime

`index.html` is the single supported app shell. It is served by Vite and loads
`/src/app/boot.ts` through an inline dynamic `import()` wrapper. `vite.config.ts`
sets `root` to the config file's directory and uses an absolute Rollup
`index.html` input, so Vite serves the repo root even if a tool launches it
from the wrong working directory. The wrapper does not make static file servers
supported; it exists so VS Code/Live Server style hosts that serve `.ts` as
`video/mp2t` fail visibly in `#boot-status` with the Vite command instead of
hanging forever on "Loading MIXOMESH...".

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
  dynamic `import()` in RenderOutput.js so it builds as its own lazy
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

### 0.3 File Layout
```
index.html                 ← Vite app shell
package.json               ← npm scripts, runtime deps, Vite deps
.npmrc                     ← local npm cache and install policy
vite.config.ts             ← Vite dev/build config
tsconfig.json              ← TypeScript migration config
scripts/
  install-deps.mjs         ← dependency bootstrap with local cache/temp paths
  ui-screenshot.mjs        ← headless 4-workspace capture harness (PROBE=1 dumps geometry)
public/
  env/                     ← HDRI presets: studio/neutral/outdoor .env (prefiltered cube textures)
src/
  app/boot.ts              ← Babylon npm namespace bridge
  app/main.ts              ← app bootstrap + dependency wiring
  import/                  ← typed import pipeline contracts
  export/                  ← typed export pipeline contracts + export planner
  config/                  ← editable data, no code change (JSON import attrs)
    printers.json          ← printer profiles (single source of truth)
    scale-presets.json     ← SCALE_PRESETS (PrintManager)
    swatches.json          ← DEFAULT_SWATCHES (ShaderLibrary)
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
      TransformCommands.js ← Transform / BakeTransform / TransformSwab
      HierarchyCommands.js ← Visibility/Lock/Rename*/Delete/Group/Ungroup/Duplicate/SmartReplace/PrintPart
      ShaderCommands.js    ← ShaderCreate/Assign/Update/Duplicate/Delete, UVOverride, ColorApply
      ScaleCommands.js     ← RescaleWorld + SourceUnit
    InputManager.js
    SceneManager.js        ← engine/lighting/overlays orchestrator (camera/pivot split into scene/)
    WorkerImport.js        ← main side of worker OBJ parse: rebuild meshes from transferables
    ValidateWorker.js      ← main side of worker topology validation (transfer pos/idx, get counts)
    workers/
      ObjParse.worker.js   ← Babylon OBJ/MTL loader in a NullEngine worker (no UI freeze)
      MeshValidate.worker.js ← pure-math topology check (weld + non-manifold + signed-volume), off-thread
    Selection.js           ← selection set + active id + pivot mode (§4b)
    AssetLoader.js         ← mesh-asset loading/instancing/restore + façade
    ImportNormalizer.js    ← import-normalization seam (units/ratio/RH→LH bake)
    ShaderLibrary.js
    MeshValidator.js       ← topology via worker (inline fallback) + bed-bounds + cache
    PersistenceManager.js
    PrintManager.js        ← export orchestrator + OBJ/STL serializers, non-destructive
    print/
      PrintScale.js        ← scale presets, export factor, ratio filenames, dimensions
      PrinterProfiles.js   ← current/explicit printer profile resolution + bed helpers
      ExportPlanner.js     ← export request/profile/scale planning + filename stems
      Download.js          ← save picker + anchor fallback
      PrintPrep.js         ← reusable clone prep steps (flatten/weld/CSG/normals)
      PrintFormats.js      ← format registry: labels, prep order, serializers
      PrintPackaging.js    ← zip/blob packaging + download dispatch
      ExportTextures.js    ← export-side texture collection (OBJ + Mimaki shared)
      ThreeMFWriter.js     ← 3MF colorgroup + Materials Extension package writers
    printers/              ← PrinterProfile.ts (type-only printer JSON schema)
    scale/                 ← ScaleMath.js runtime + ScaleTypes.ts (type-only)
    assets/
      AssetTypes.js        ← supported extensions + extension parser
      TextureReadback.js   ← shared GPU readback: Promise readPixels, float/RGB, Y-flip
      TextureAssets.js     ← texture-asset registry: user/imported, §10b dedupe + rebind, recap-all
      TextureSource.js     ← full-res export-PNG per assetId, frozen pre-cap (export fidelity)
      TextureCap.js        ← viewport texture cap: capture-then-downscale GPU, export reads source
      MeshSplit.js         ← split-on-import invariant (pure planner + Babylon factory)
      BlobUrls.js          ← shared assetId → object-URL registry
    scene/
      SceneConstants.js    ← viewport/grid/camera/outline constants (+ dark bg pair)
      SelectionOutline.js  ← custom mask-RTT selection silhouette + post-process (GLSL + WGSL twin, picked by engine)
      BedGrid.js           ← printer-bed floor, grid styling, FRONT tag, bed preview
      CameraRig.js         ← camera creation, CAD pointer nav, presets, framing, follow, optics
      PivotSession.js      ← GizmoManager + selectionPivot parenting + drag→TransformCommand
      EnvironmentRig.js    ← 3-light studio + RENDERONCE shadows, shadow-catcher floor, HDRI IBL
      ViewEffects.js       ← SSAO + cross-section: clip plane + back-face fill (solid interior) + cut-plane border
      BackfaceCheck.js     ← inverted/back-face highlight (red back-face clones, viewport overlay)
      ImportBounce.js      ← scale-pop on ASSET_INSTANTIATED (exact-restore, reduced-motion aware)
      EdgeOverlay.js       ← wireframe-edges overlay clones + emissive wire material
      AdaptiveResolution.js ← capped DPR + safety-valve dynamic downscale for heavy scenes
    RenderOutput.js        ← Scene ▸ Rendering capture engine: PNG stills + turntable video
    render/
      RenderMath.js        ← pure: turntable easing, video format pick, frame fit, filenames
    ThreeMFLoader.js       ← `.3mf` SceneLoader plugin = inverse of 3MF export
    idb.js                 ← IndexedDB layer for FileSystemHandles + kv store (§11b)
    Icons.js               ← Lucide wrapper: returns SVG strings by name
  ui/
    Outliner.js
    PropertiesPanel.js
    ShaderPanel.js
    AssetPanel.js
    ContextMenu.js
    PrintPanel.js
    StatusBar.js
    MeshStats.js           ← live tris / mm dims / watertight in the status-bar centre (selection-driven)
    Toast.js
    Status.js              ← centralized error + loading policy (reportError / guard / runTask / safeAsync)
    Modal.js               ← generic modal helper
    AppShell.js            ← shell controls: panel collapse/resize + boot status
    renderSafe.js          ← escaping helpers + validated image data URLs
    ProjectMenu.js         ← header toolbar (new/open/save/recent) + persistence modals (§13b)
    ProgressOverlay.js     ← full-screen blocking overlay during exports (§13b)
    ViewportDrop.js        ← drag-and-drop onto viewport (asset panel + OS files)
    ImportError.js         ← safeImport wrapper + importError detail modal (import failures)
    ViewportToolbar.js     ← floating bottom toolbar (Fusion 360-style)
    ViewportToggles.js     ← display-mode selector (Shaded/Matte/Base Color) + wireframe-edges overlay, under the NavCube
    ScenePanel.js          ← Scene workspace panel: grid / environment (incl. floor) / camera / Rendering output
    RenderFrame.js         ← Render-view compose overlay (aspect frame + darkening)
    Workspace.js           ← workspace presets (PART 13b): pill, hotkeys, scroll memory
    NumberScrub.js         ← wheel-scrub on number inputs (delegated, panel never scrolls)
    NavCube.js             ← top-left orientation widget
tests/                     ← headless harness — Node-native, no build (§14b)
  register-hooks.mjs       ← `node:module.register` entry; runner uses --import
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
  webcodecs-probe.mjs      ← headless VideoEncoder sanity probe (diagnostic, not in npm scripts)
  render-output.test.mjs   ← RenderMath: easing/format/frame-fit/filename contracts
  hooks.mjs                ← resolver hook: 'jszip' → stub, './idb.js' → stub
  jszip-stub.mjs           ← minimal JSZip for export tests
  idb-stub.mjs             ← in-memory mirror of src/core/idb.js
  env.mjs                  ← installEnv(): Babylon shim, atob/btoa, DOMParser
  export.test.mjs          ← PrintManager export pipeline
  export-planner.test.mjs  ← filename/profile/scale planner
  validator.test.mjs       ← MeshValidator severity + position-welded manifold
  validator-group.test.mjs ← sourceGroupId union topology checks
  persistence.test.mjs     ← PersistenceManager `__test` helpers + 5-tier resolve
  printer-profile.test.mjs ← default/fallback printer profile behavior
  scale.test.mjs           ← ScaleMath contracts + compatibility helpers
  split-on-import.test.mjs ← MultiMaterial split invariant
  state-shape.test.mjs     ← default state and migration invariants
  threemf-materials-ext.test.mjs ← textured 3MF Materials Extension writer/loader contracts
```

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
4. `main.ts` blocks non-Chrome/Edge by requiring
   `'showDirectoryPicker' in window`.
5. `main.ts` initialises modules in this order: `Toast`, `StatusBar`,
   `SceneManager`, `InputManager`, transform-commit history hook, `Modal`,
   `Outliner`, `PropertiesPanel`, `ShaderPanel`, `PrintPanel`, `ContextMenu`,
   `AssetPanel`, `ViewportToolbar`, `NavCube`, `PersistenceManager`,
   `ProjectMenu`, `AppShell`, `ViewportDrop`.
6. `main.ts` registers global project shortcuts (`Ctrl+S`,
   `Ctrl+Shift+S`, `Ctrl+O`, `Ctrl+N`), reapplies overlay defaults, starts
   autosave, focuses the canvas, then asks the Asset Panel to remount the last
   folder.

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
| Persistence | `.mixo` v3.1 JSON plus IndexedDB handles/kv | `PersistenceManager`, `idb.js` |
| Export packaging | `PrintManager` orchestrator plus `src/core/print/*` seams | `PrintPanel` invokes public export entry points |
| UI markup safety | `src/ui/renderSafe.js` | every string-template UI renderer |

#### Runtime Dataflow

Import path:
1. `AssetPanel` or `ViewportDrop` obtains a `File`, `Blob`, or
   File System Access handle.
2. `AssetLoader.loadFromBlob/loadFromHandle` validates the extension via
   `src/core/assets/AssetTypes.js`, loads an `AssetContainer`, and calls
   `splitMultiMaterialMeshesInContainer()` before shader registration.
3. `ShaderLibrary.registerFromContainer()` creates or merges shader entries.
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
4. `AssetLoader` adds the container to the scene, bakes source unit and
   authored ratio into scene scale, persists an `AssetEntry`, creates a
   display-only `CollectionEntry`, and registers each geometry mesh as a
   `SceneObject`.
5. `AssetLoader` generates an idle thumbnail and queues non-blocking
   validation.

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
1. `PrintPanel` reads the selected printer profile and invokes one of
   `PrintManager.exportOBJ/exportSTL/exportThreeMF`.
2. `PrintManager._runExport` collects printable meshes, validates the source
   scene, clones meshes with unique geometry, builds a plan from printer +
   scene/print scale, runs ordered prep steps on clones, validates the prepared
   clones, serializes, packages, and downloads.
3. Export never mutates live scene meshes. Mimaki texture profiles keep UVs and
   textures; filament profiles collapse to solid per-part color.

#### Typed Contract Modules (type-only — NO runtime twins)

The runtime is JavaScript; a small set of TYPE-ONLY TypeScript files lock
schemas at compile time. The earlier runtime-mirror files (`ScaleMath.ts`,
`printers/PrinterProfiles.ts`, `export/ExportPlanner.ts`) were deleted
2026-06-11 (arch review A7) — a manual "keep the twin in sync" rule is a
drift liability, and the headless tests already pin the runtime behaviour.

- `src/core/scale/ScaleTypes.ts` — SourceUnit / AuthoredScale / SceneScale /
  PrintScale shapes. Runtime math lives in `ScaleMath.js`.
- `src/core/printers/PrinterProfile.ts` — printer JSON schema types.
  Runtime resolver is `src/core/print/PrinterProfiles.js`.
- `src/import/ImportPipeline.ts` — source-file, raw import, normalized
  import, asset, collection, and scene-part shapes.
- `src/export/ExportPipeline.ts` — export request, mesh, package, and plan
  shapes.

These files contain types and `import type` only — never executable mirrors
of runtime functions.

### 0.4 Babylon-First Rule
Before writing custom logic, check if Babylon provides it. **Required uses:**

| Need | Use this |
|---|---|
| OBJ + MTL export | `BABYLON.OBJExport.OBJ(meshes, materials, matlibname)` |
| STL export | `BABYLON.STLExport.CreateSTL(meshes, ...)` |
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
| each `core/commands/*.js` | < 500 (HierarchyCommands is the big one by design) |
| `InputManager.js` | < 750 (incl. modal G/R/S; extract `input/ModalTransform.js` if it grows) |
| `SceneManager.js` | < 450 (engine/lighting/overlays orchestrator; camera, pivot, outline, bed/grid all split into `core/scene/`) |
| each `core/scene/*.js` | < 250 (`CameraRig.js` < 550 — creation + custom nav + presets + framing + follow + optics + pose save/restore are one cohesive rig) |
| `AssetLoader.js` | < 700 (mesh-side only; textures/split/blob-urls live in `core/assets/`) |
| each `core/assets/*.js` | < 350 |
| `ImportNormalizer.js` | < 150 |
| `ShaderLibrary.js` | < 1100 (registry + merge + UV clones + type rebuild; split candidate if it grows) |
| `MeshValidator.js` | < 460 (topology worker plumbing + group-union; pure topology lives in `workers/MeshValidate.worker.js`) |
| `PersistenceManager.js` | < 800 |
| `PrintManager.js` | < 500 (orchestrator + OBJ/STL; 3MF writers + texture collection split out) |
| each `core/print/*.js` | < 350 |
| `ThreeMFLoader.js` | < 300 (3MF import = inverse of 3MF export) |
| Each `src/ui/*.js` | < 900 (PropertiesPanel/ShaderPanel are section stacks; split per-section when a panel exceeds this) |
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

Single dark theme. Pro-tool aesthetic. No theme switcher in v1.

**Blender-inspired pass (2026-06-12):** surfaces went neutral gray (blue cast
removed), controls became light-gray inset pills (lighter than the panel,
dark seam border, hover lighten / press darken), property labels right-align,
section headers are sentence case, tab strips are segmented controls. The
component-level overrides live in `src/styles/blender.css`, loaded LAST in
index.html; the tokens below are the current values.

```css
:root {
  /* Surfaces — FIXED-ASSIGNMENT elevation ladder. The ladder isn't a free
     palette; each rung has a documented role so the parent-child panel
     hierarchy reads at a glance (PART 13b). Don't reuse a rung at the
     wrong level — that's what blends the hierarchy. */
  --bg-0: #111111;          /* viewport / app background */
  --bg-1: #1d1d1d;          /* top-level panel surface (Outliner, Properties, Shader, Asset, Print) */
  --bg-2: #252525;          /* section surface inside a panel (.pp-section, .sp-section, .ap-card) */
  --bg-3: #2f2f2f;          /* control surface — inputs, default buttons, selected rows */
  --bg-4: #3b3b3b;          /* hover / pressed elevation on top of --bg-3 */

  /* Blender separates surfaces with darker SEAMS (inset look), not lighter
     outlines; -strong stays lighter for chips/handles needing an outline. */
  --border:         #161616;
  --border-strong:  #404040;
  --border-section: #181818;
  --border-focus:  #f59e0b;
  --ring-focus:    rgba(245, 158, 11, 0.35);  /* 2px box-shadow ring on input :focus — keyboard a11y */

  /* Controls — Blender fields sit LIGHTER than their panel (inset pill). */
  --ctl-bg:        #383838;
  --ctl-bg-hover:  #434343;
  --ctl-bg-active: #2c2c2c;
  --ctl-border:    #202020;
  --ctl-h: 22px;

  /* Text */
  --text-0: #e8e8e8;        /* primary */
  --text-1: #a8a8a8;        /* secondary */
  --text-2: #8c8c8c;        /* tertiary, hints */
  --text-disabled: #5e5e5e;

  /* Accent — yellow-orange (amber); locked Phase 3, user confirmed */
  --accent:    #f59e0b;
  --accent-hi: #fbbf24;
  --accent-fg: #1a1108;

  --border-focus: #f59e0b;

  /* Status — warning uses yellow-400 to stay distinct from amber accent */
  --danger:  #ef4444;
  --warning: #facc15;
  --success: #22c55e;
  --info:    #3b82f6;

  /* Typography */
  --font-sans: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --font-mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  --fs-xs: 11px;
  --fs-sm: 12px;
  --fs-md: 13px;            /* default UI size */
  --fs-lg: 15px;
  --fs-xl: 18px;

  /* Spacing — compact pro-tool scale */
  --sp-1: 2px;
  --sp-2: 4px;
  --sp-3: 6px;
  --sp-4: 8px;
  --sp-5: 12px;
  --sp-6: 16px;
  --sp-7: 24px;

  /* Radii */
  --r-sm: 3px;
  --r-md: 5px;
  --r-lg: 8px;

  /* Motion */
  --ease: cubic-bezier(0.4, 0, 0.2, 1);
  --dur-fast: 120ms;
  --dur-med:  200ms;

  /* Shadows */
  --shadow-md: 0 4px 12px rgba(0,0,0,0.35);
  --shadow-lg: 0 12px 32px rgba(0,0,0,0.45);
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
- **Properties sections**: Object=`Shapes`, Transform=`Move`, Authored Scale=`Ruler`, Shader=`Brush`, UV Override=`Map`, Print Part=`Tag`
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
    // viewport furniture — RenderOutput._hideFurniture hides them during capture.
    // The shadow-map pass renders depth directly, so shadows stay uncut (limit).
    // NOTE for a color-print tool: a REAL cut face for export/print is geometry,
    // not visual — that is the CSG2 path (PrintManager._csgRebake already uses
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
    minWallThickness: 1.2, printMode: 'fdm', chordTolerance: 0.05,
    objBakeSolidTextures: true,
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
  gizmo: { mode: 'translate', space: 'world', snap: { translate: 1.0, rotate: 15, scale: 0.1 } },
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
Selection.getSelectedResolved()      → { id, mesh }[]   // ghost/missing dropped
```

### Behaviour rules
- Resolution drops `obj.isGhost === true` and meshes `AssetLoader.getBabylonMesh` cannot find. Ghosts are *selectable in the outliner* but never receive gizmo / silhouette attention.
- Every selection-write call emits `EVENTS.SELECTION_CHANGED` (with `{selectedIds, activeId}`); an active-id change additionally emits `EVENTS.ACTIVE_OBJECT_CHANGED`.
- `_applyVisuals` (private) calls `SceneManager.setActive(activeMesh)`, `SceneManager.setSelected(others)`, `SceneManager.attachToSelection(allMeshes, pivotMode, activeMesh)`. The gizmo's pivot follows `state.selection.pivotMode`.
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
### Shader / Scale modules + shared `support.js`; HistoryManager re-exports all)
Implemented in Phase 3:
- `TransformCommand` — `{ prev, next, alreadyApplied? }` keyed by meshId. Sets absolute transforms via `setParent(null)` cycle so the world position survives the change. Used by both gizmo drag-end and Properties Panel input commits.
- `VisibilityCommand`, `LockCommand`, `RenameCommand`
- `DeleteCommand` — soft-deletes (`setEnabled(false)` + remove from state) so undo restores instantly without re-instantiating from the asset container.
- `DuplicateCommand` — clones via `AssetLoader.cloneMeshAsNewObject`, offsets +10 mm in X so the clone is visible, auto-selects new meshes. Sharing geometry on redo: clones are kept disabled in memory and re-enabled on redo (same pattern as DeleteCommand).
- `GroupCommand` / `UngroupCommand` — creates/disposes a `TransformNode` pivot; reparents members preserving world transform. All three commands wrap their parent-touching work in a `_withDetachedPivot` helper that temporarily detaches the selection-visual pivot so meshes are in their canonical parents during the mutation.

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
- `RescaleWorldCommand` — `{ prevRatio, nextRatio }` — re-bakes every registered mesh's vertex data by `prev/next`, scales every ancestor `TransformNode.position` (via WeakSet dedup), scales `state.scene.cursor3d`, updates `state.print.workingRatio`. Undo runs the inverse factor.
- `BakeTransformCommand` — `{ meshId, kind: 'rotation' | 'scale' }` — bakes either the current rotation OR scaling into vertices and resets that component to identity. Position is left untouched. Snapshots pre-bake position + normal vertex buffers so undo restores exact bytes (no FP drift on repeated cycles).

Phase 6+ implementations:
- `SmartReplaceCommand`, `TransformSwabCommand` — fully implemented (context
  menu "Smart Replace" / "Transform Swab").
- `SourceUnitCommand` — per-asset unit re-bake (inverse-factor undo), pushed
  by Properties ▸ Source Unit (review M12).
- `RenameCollectionCommand` — undoable outliner collection rename (L30).

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

**Viewport:**
```
G              → grab (translate); axis with X/Y/Z; plane with Shift+X/Y/Z
R              → rotate; axis with X/Y/Z
S              → scale; axis with X/Y/Z
Escape / RMB   → cancel current op (restore pre-op transform)
Enter / LMB    → confirm op

A              → select all (toggle: all → none if all already selected)
Alt+A          → deselect all
B              → box select (drag marquee) — PLANNED, not implemented
Shift+LMB      → add/remove from selection

F              → frame selected
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
Tab            → cycle active panel
~              → toggle gizmo space (world/local)
. (period)     → cycle pivot mode (world → median → active → individual → cursor)
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

### Mouse
```
LMB click           → pick + select
LMB drag on mesh    → translate selection on the horizontal plane
                      (locked to the active mesh's current Y; Bambu-Studio /
                      Tinkercad style). A drag has to clear ~4 px to engage —
                      shorter LMB presses are still a plain click.
Shift+LMB           → add / remove from selection (no drag)
LMB drag empty      → box select — PLANNED, not implemented
RMB during body drag → cancel (pivot snaps back, no history push)
RMB click            → context menu (deferred to UP; suppressed if drag > 4 px)
RMB drag             → pan camera target
MMB drag             → orbit
Wheel                → dolly zoom
Shift+RMB            → place 3D cursor at hit point
Shift+N              → toggle the 3D-cursor N-panel (plain N = right-panel toggle, taken)
Ctrl+C / Ctrl+V      → copy / paste with an aspect chooser (Object/Location/Rotation/Scale/Loc+Rot/All)
```

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
`RenderOutput` now calls `engine.flushFramebuffer()` after the manual render, and
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

// Gizmos
SceneManager.setGizmoMode(mode)               // 'translate'|'rotate'|'scale'|'none'
SceneManager.setGizmoSpace(space)             // 'world'|'local'
SceneManager.setScaleLock(locked)             // hide per-axis scale arrows when true; only uniform handle remains
SceneManager.setFollowMode(mode)              // 'free'|'followActive'|'worldOrigin' — camera target tracking
SceneManager.attachToSelection(meshes, pivotMode, activeMesh)

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
- **Viewport texture cap + export-from-source (`assets/TextureSource.js` + `assets/TextureCap.js`, perf 2026-06-13):** the one lever left for genuinely large texture counts. THE LOCK it works around: Mimaki export reads pixels off the LIVE GPU texture (`print/ExportTextures.js` → `TextureReadback.readTextureRGBA`), so any viewport-side texture downscale would silently degrade the export. The fix decouples the two. **Capture:** at the texture-asset registration seam (`TextureAssets.js` — user-loaded, imported, and restored paths all schedule it at idle) `captureAndCap(assetId, texture)` freezes the full-res, export-ready PNG into `TextureSource` via the SAME `textureToPngBlob()` the export uses — so it is orientation/encoding identical by construction (the glTF↔3MF Y-flip lives only in `TextureReadback.EXPORT_FLIP_Y`). Capture happens BEFORE any downscale. **Cap:** `applyCapToTexture` re-decodes the stored source to a canvas at `min(capPx, srcMax)` and `Texture.updateURL`s the GPU copy (same instance, so material bindings + the export assetId→texture map stay valid; raising the cap restores detail from source — a downscale is never permanent). **Export:** `ExportTextures.textureToBlob(tex, assetId)` returns the captured source blob verbatim when present (full-res, regardless of the viewport cap), falling back to a live GPU readback only when no source was captured. State: `scene.render.textureCapPx` (0 = off/full, default; 4096/2048/1024), persisted with the render look; the Scene ▸ Environment ▸ Performance select writes it and calls `AssetLoader.recapAllTextures(px)`. Default OFF — opt-in VRAM relief. Pinned by `tests/texture-source.test.mjs` (first-writer-wins capture, export-prefers-source, GPU fallback) and the export Y-flip smoke (source path is byte-correct).
- Camera: `BABYLON.ArcRotateCamera` with `mode` switched between `PERSPECTIVE_CAMERA` and `ORTHOGRAPHIC_CAMERA`. Babylon's pointer orbit/pan is fully DISABLED (`buttons=[]`, `panningSensibility=0`); custom orbit/pan lives in `_onCameraPointer`, wheel zoom is percentage-based (`wheelDeltaPercentage=0.08`). Ortho bounds recompute from `camera.radius` + aspect every frame the camera is orthographic.
- Numpad face presets route through `setCameraPreset` (animated, bbox-fit — see *Camera Presets* below). Numpad5 toggles projection IN PLACE via `toggleOrthographic()`, preserving the current view direction.
- **Selection silhouette (`scene/SelectionOutline.js`):** custom mask render-target + post-process — NOT `HighlightLayer`. HL's stencil mask leaks onto PBR mesh faces on any material reporting an alpha mode. The replacement renders selected meshes into a half-res RTT with an emissive override material, then a fullscreen shader dilates the mask, subtracts the silhouette, and adds `colour × ring` to the scene. By construction the ring exists only outside the mesh. **Two-tone (2026-06-14):** the mask is TWO-CHANNEL — the ACTIVE object writes emissive `(1,0,0)` (carries in R), the other SELECTED objects write `(0,1,0)` (carries in G). The shader dilates both channels and tints R→`OUTLINE_ACTIVE_HEX` (`#c2410c`, darker orange), G→`OUTLINE_SELECTED_HEX` (`#f59e0b`, amber), active drawn over selected where rings overlap — so the active object reads apart from the rest of the selection. A single intensity channel couldn't carry which-is-which without a threshold that misfires on the dilation fringe; the GLSL **and** WGSL twins both consume `activeColor`/`selectedColor`. Dials in `scene/SceneConstants.js`: `OUTLINE_RADIUS_PX = 4.5`, `OUTLINE_INTENSITY = 2.0`, `OUTLINE_ACTIVE_HEX`, `OUTLINE_SELECTED_HEX`. **Gated (perf 2026-06-13):** the mask RTT and the 64-tap fullscreen pass are DETACHED whenever the selection is empty (`_setOutlineEnabled`) — they were running every frame for zero benefit, a real cost at 4K over heavy scenes; re-attached on the first selection. Browser smoke pins detach-when-empty / attach-when-selected.
- **Wireframe edges (`scene/EdgeOverlay.js`):** `SceneManager.setOverlay('wireframeEdges', on)` builds a per-mesh CLONE sharing the source geometry, drawn with a wireframe emissive `StandardMaterial` (`zOffset −1`) over the textured base — `enableEdgesRendering` at any epsilon only showed sharp creases (field report). Clones carry `metadata.edgeOverlay` so they never pick, cast, or register. `setWireframeEdgeColor(hex)` live-updates the shared material.
- **Gizmo:** `BABYLON.GizmoManager(scene)` with a temporary `TransformNode` pivot that parents the selected meshes at `pivotMode` (`median`, `active`, or `cursor` — the pivot session reads the cursor via `getCursorPosition`; `individual` still falls through to `median`). Drag-start snapshots absolute transforms; drag-end snapshots again and the bridge in `src/app/main.ts` pushes one `TransformCommand` with `{ alreadyApplied: true }`.
- **Axes overlay:** three `MeshBuilder.CreateLines` meshes (red X, green Y, blue Z) at length `0.05` BU. 1-pixel GL line stroke, no arrowheads. Toggled via `mesh.isVisible`.
- **Bed (grid):** ground plane footprint = the printer bed XY (`state.print.bedDimensions.x` × `.y`, mm → BU; default Mimaki 3DUJ-553 508 × 508 mm), rectangular. Lines drawn with `BABYLON.GridMaterial`, styled from `state.scene.grid` (`cellMM` minor cell size, `subdivisions` minor cells per major line; default 10 mm / 10). `SceneManager.rebuildBed()` resizes the floor when bed dimensions change (called from Print ▸ Bed); `SceneManager.setGrid({cellMM,subdivisions})` re-skins the lines (called from Properties ▸ Scene). The single flat `FRONT` tag sits at the `+Z` bed edge and scales with `min(width,depth)`. Old v3.1 saves with a scalar `scene.gridSize` are ignored; `scene.grid` falls back to the 10/10 default.
- **Bed FRONT tag:** a single `MeshBuilder.CreatePlane` mesh with `DynamicTexture` text `FRONT`, laid **flat on the bed** (`rotation = (π/2, π, 0)`, no billboard) hugging the +Z edge, 4 mm above the bed, textured face up with glyphs readable from the front-elevated camera (verified live; `rotation.x = -π/2` mirrors the text, `+π/2` alone is upside-down). Drawn in the muted grid-line colour (`rgba(97,97,117,0.55)` ≈ grid `Color3 0.38,0.38,0.46`) so it reads as part of the bed, not a UI accent. Only FRONT is shown — once the front edge is known the rest is implied; the old four upright billboarded tags (FRONT/BACK/LEFT/RIGHT) were dropped as visual noise. Size scales with bed extent (`max(0.03, extent * 0.10)` × 0.32 ratio). Rebuilt by `_rebuildGroundMesh` whenever bed extent changes. Visibility tracks `state.scene.overlays.grid` (toggled together with ground plane).
- **Bed preview:** `MeshBuilder.CreateBox` sized to bed dims, semi-transparent material, wireframe outline overlay.
- **3D cursor (`scene/Cursor3D.js`, 2026-06-14):** the original yellow translucent ball (a fixed world anchor) PLUS a Blender-style crosshair + dashed ring that billboard to the camera and hold a roughly constant on-screen size (scaled per-frame by `camera.radius × SCREEN_K`, ring/crosshair drawn in `renderingGroupId 1` so they're never occluded). Shown for `pivotMode === 'cursor'` or while the N-panel is open. `setCursor` writes `state.scene.cursor3d` (silent — placing the cursor doesn't dirty the project, same rule as selection) and fires `CURSOR_CHANGED`; `PersistenceManager` restores it on load via `setCursorFromState`.
  - **N-panel (`ui/CursorPanel.js`):** a slide-out sidebar docked to the viewport's right edge (clipped by `#viewport { overflow:hidden }`, so the closed body hides and only a 26 px tab peeks), toggled by **Shift+N** (plain N is the docked right-panel toggle). Holds a 3D-Cursor tab: live two-way XYZ inputs in mm (`× MM_PER_BU`), the snap buttons, and a "Use Cursor as Pivot" toggle.
  - **Snap ops (`core/CursorTools.js`):** `selectionToCursor()` rigid-translates the whole selection so its median lands on the cursor (one undoable `TransformCommand`); `cursorToSelection()` moves the cursor to the selection median; `cursorToWorldOrigin()` resets it to (0,0,0). Cursor moves are NOT in the undo stack (Blender-parity — the cursor is a tool, not scene content).
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
  (`RenderOutput._sweepRig.applyDelta`). Browser smoke pins soft (0<α<255)
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

**File: `src/core/AssetLoader.js`**

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
  id, name, filename, originalPath, extension,
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
  sourceFileHash,              // texture identity scope — §10b (texture entries)
  sourceAssetId,               // owning mesh asset for imported textures — §10b
  babylonTextureName,          // loader-minted texture.name for reload rebind — §10b
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
  collectionId,                // outliner display bucket (null = uncollected)
  parentId,                    // groupId if this mesh is inside a group, else null
  shaderId,                    // shader currently assigned (null = scene default)
  visible, locked, isGhost,    // booleans
  isPrintPart,                 // include in OBJ/STL export
  sourceGroupId,               // uuid shared by siblings split
                               //   from one MultiMaterial source mesh.
                               //   Null if the mesh came in single-material.
                               //   Group-aware validator + exporter use this
                               //   to re-union part topology. See §0.1 +
                               //   §9 group-aware validation.
}
```

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

Why: per-mesh export filenames are `${projectName}_${name}${ratioSuffix}.${ext}`
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
   ships none). 3MF import is the exact INVERSE of `PrintManager.exportThreeMF`:
   unzip OPC → `3D/3dmodel.model` → per `<object>`/`<mesh>` build a Babylon
   mesh, rotate `RotationX(+90°)` (3MF Z-up → Babylon Y-up, undoing the export
   `Y_UP_TO_Z_UP`), restore winding (export wrote `v1,v3,v2`), map
   `m:colorgroup`+`pid/pindex` → `StandardMaterial.diffuseColor`, apply any
   `<build><item>` transform. Returns an AssetContainer so every downstream
   path (shaders, re-instantiate, project restore) is identical to other
   formats. Vertices are raw mm → handled by the normal import-scale model
   exactly like STL (so scale is NOT bit-identical across a working≠target
   ratio — same inherent behaviour as re-importing an exported OBJ/STL).
   Component-only assemblies (no `<mesh>`) are unsupported — we never export
   those (one `<object>`+`<mesh>` per part).
4. Register all materials → ShaderLibrary.registerFromContainer (merge strategy).
5. Store AssetContainer in module-local Map<assetId, container>.
6. addAllToScene() for the container.
7. Resolve modelRatio: read glTF "ratio" extra (Blender custom property);
   parse '1/N', '1:N', or bare 'N' as denominator N. Default 1 when absent.
8. Apply import scaling — see "Import Scale Model" below. Drop offset on top.
9. Register AssetEntry (sourceUnit='millimeters', unitConfirmed=true, modelRatio).
10. Create SceneObject entries for each visible mesh.
11. Generate thumbnail via Tools.CreateScreenshotUsingRenderTargetAsync (async).
12. If vertexCount <= 100_000 → queue MeshValidator.validateMesh; else skip
    auto-validate with toast.
13. Dispatch EVENTS.ASSET_INSTANTIATED for each mesh.
```

### Import Scale Model
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
**Authored Scale**, `workingRatio` is **Scene Scale**, and `targetRatio` is
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

```js
function applyImportScaling(container, factor, dropPos) {
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

**External (non-Blender) glTF files** that follow the spec's meters convention will import 1000× too small at the mm default. The user can then override `sourceUnit` to `'meters'` in the Properties Panel (Phase 3), and the loader re-applies the scaling.

Export-time rescaling from `workingRatio` to `targetRatio` happens in `PrintManager` — see §12.

### Thumbnail Generation
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

### Chrome Directory Mount
```js
async function mountDirectory() {
  const handle = await window.showDirectoryPicker();
  const key = `dir_${handle.name}_${Date.now()}`;
  await idbSet(key, handle);              // store for session restoration
  return { handle, key };
}
```
On project load, retrieve handle via `idbGet(key)`, call `handle.requestPermission({ mode: 'read' })`. If denied, show non-blocking banner with re-grant button. Ghost objects render until resolved.

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
`instantiateAsset(assetId, position)` re-loads the asset from the cached blob URL (stored in a module-local `Map<assetId, objectURL>` set on first load). Each call goes through the full load path — fresh `AssetContainer`, new mesh registration, independent SceneObject entries — so re-dragged copies appear as separate items in the Outliner and are independently selectable.

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

### Scope (v1)
Three critical checks only. Pure JS — no WASM.

| Check | Severity | Method | Auto-Fix |
|---|---|---|---|
| Non-manifold edges | **warning** (Phase 6) | Edge-face count map over **position-welded** indices (Phase 6 — raw indices false-flag unwelded imports); flag edges with count ≠ 2 | Merge by distance |
| Inverted normals | **warning** (Phase 6) | **Signed mesh volume** (one O(tris) pass; V<0 ⇒ inward winding) — replaced the old 64-ray heuristic (O(tris) PER ray) 2026-06-13 | Flip winding |
| Exceeds bed volume | warning | Compare mesh world AABB to bed dims | None |

> **Topology runs in a Web Worker (perf goal 2026-06-13).** The non-manifold
> + inverted-winding pass is the heavy part on dense print meshes (80k+ tris
> ≈ 450 ms of weld + edge-map on the main thread — a felt freeze when several
> heavy models import). `MeshValidator._topology` posts a COPY of
> positions/indices to `workers/MeshValidate.worker.js` (via `ValidateWorker.js`,
> transferables) and awaits the counts; the UI thread never blocks (measured
> ~12 ms wall, warm worker). The worker uses NUMERIC packed keys for the weld
> + edge maps (no per-vertex/edge string allocation) and signed-volume
> inverted-normals (no rays/octree). Inline pure-JS fallback runs when Worker
> is unavailable (Node tests). The bed-bounds check stays on the main thread
> (needs the world matrix; trivial). Group-union topology (split shells) is
> built on the main thread then posted the same way.

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
MeshValidator.autoFix(babylonMesh, results)        → Promise<ValidationResult[]>
MeshValidator.hasErrors(results)                   → boolean
MeshValidator.hasWarnings(results)                 → boolean
MeshValidator.validateAllPrintParts()              → Promise<Map<meshId, ValidationResult[]>>
MeshValidator.validateGroup(sourceGroupId)         → Promise<ValidationResult[]>  // welded-union path
```

### Group-aware topology checks

Split-on-import (§8 *Load Flow*) makes individual shells non-watertight by
construction — a 6-face cube with 3 shaders becomes 3 meshes of 2 faces
each, each with 6 boundary edges by definition. Per-shell topology checks
lose all signal in this case.

**Rule:** when validating a mesh whose `SceneObject.sourceGroupId` is set,
topology checks (`nonManifold`, `invertedNormals`) run on the **welded
union of all siblings**, not on the individual mesh:

1. Collect every SceneObject sharing this `sourceGroupId`.
2. Concatenate their position arrays. Index buffers shift by the running
   vertex offset so concatenated indices remain valid.
3. Weld concatenated positions by distance (existing weld used by §9
   non-manifold check) — siblings share coplanar seams, so welding
   stitches them back into one logical part. **No data copied back into
   Babylon meshes**; the welded buffers exist only inside the validator.
4. Run topology checks on the welded union. Result is attached to **every**
   sibling's `ValidationResult[]` so the Outliner shows the warning on any
   row of the group.

**Integrity checks** (zero-vertex mesh, missing registry entry, exceeds bed
volume) stay per-mesh — they answer about the individual shell, not the
part topology.

**Pre-export gate** (§9 *Pre-Export Gate*) iterates print parts, but
deduplicates by `sourceGroupId` so each part runs once even if it has 12
siblings. Block / confirm-anyway semantics unchanged.

### ValidationResult
```js
{
  type: 'nonManifold'|'invertedNormals'|'exceedsBed',
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

### Pre-Export Gate
- Hard errors are caught INSIDE `_runExport` (post auto-fix) → block with
  the error-list modal.
- Cached non-stale warnings on print parts → PrintPanel confirms
  "Export anyway?" before invoking the export (default yes — display
  models are routinely non-watertight and slicers auto-repair).

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

### Import Merge Strategy
On material-name collision during `registerFromContainer`:
1. **Auto-dedupe first.** `_findContentDuplicate(mat)` builds a signature from the imported material — `type | diffuseColor | opacity | roughness | metallic | uvBase | diffuseTextureAssetId` — and compares to every existing scene shader's signature. An exact match silently reuses the existing shaderId, redirects the imported mesh's `material` pointer, disposes the duplicate material, and skips the merge modal entirely. This catches the most common case (the user dropped the same file twice).
2. **Texture dedupe** runs as part of step 1's signature. Imported (glTF-embedded) textures are deduped by `${name}|${width}|${height}|${className}` in `AssetLoader.registerImportedTexture` so two imports of the same file end up sharing one `diffuseTextureAssetId` — without this, shader content-dedupe would fail because the texture ids would differ.
3. **Only remaining conflicts hit the modal.** If a name still collides AND content differs, dispatch `EVENTS.MODAL_OPEN` with id `shaderMerge`, payload `{ conflicts }`.
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

**Dedupe rule** (`AssetLoader.registerImportedTexture`): signature is
`sourceFileHash | babylonTextureName | width | height | class`. Same file
re-imported → dedupes to one assetId. Different files NEVER silently merge,
even when loaders mint generic names like `Image_0` at equal dimensions.
Cross-file pixel-level dedupe is intentionally out of scope — correctness
over compactness.

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

**File: `src/core/PersistenceManager.js`**

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
// Test surface — pure helpers exported for headless tests; do NOT import from app code.
PersistenceManager.__test = {
  _b64FromBuf, _bufFromB64, _sha256Hex, _extOf,
  _resolveAssetBlob, _scanDirForHash, _fileHandleAtPath,
  _arrToMap, _migrate,
}
```
Constants: `SCHEMA_VERSION = '3.2'` (3.2 adds the §10b texture-identity
fields `sourceFileHash` / `sourceAssetId` / `babylonTextureName` on texture
AssetEntries — 3.1 docs load unchanged, missing fields just skip the rebind
and fall back to colour), `FILE_EXT = '.mixo'`, `RECENT_KEY = 'recent_projects'`, `RECENT_MAX = 10`, `AUTOSAVE_PREFIX = 'autosave_'` (autosave keys are literally `AUTOSAVE_PREFIX + projectName`), `SCAN_FILE_LIMIT = 4000` (hash-relink safety cap — see §11 Asset Resolution Priority).

### Full Project Schema (v3.1)
Every field persisted. Restored exactly.

```jsonc
{
  "version": "3.1",
  "savedAt": "ISO8601",
  "project": { "name": "..." },
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
    "minWallThickness": 1.2, "printMode": "fdm", "chordTolerance": 0.05,
    "objBakeSolidTextures": true
  },
  "assetLibrary":  [ /* AssetEntry without container or blobUrl */ ],
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

### Asset Resolution Priority (locked — `_resolveAssetBlob`)
Every asset has one resolution attempt on load. Walk top-down; first hit wins.

| # | Tier | Condition | Live? | Source |
|---|---|---|---|---|
| 1 | Live exact path | `directoryHandleKey` granted **and** file exists at `originalPath` | yes | file on disk |
| 2 | Hash relink | `directoryHandleKey` granted **and** no exact path, but a sibling/descendant file with matching `sha256` (+ ext filter) is found within `SCAN_FILE_LIMIT` (4000) | yes | file on disk |
| 3 | Single-file handle | `fileHandleKey` resolves and permission is granted (loose drag-drop relink — Chrome only, only set when caller passed `fileHandle:` without a `directoryHandleKey`) | yes | file on disk |
| 4 | Embedded snapshot | `fileData` (base64) present | no (Snapshot) | embedded in `.mixo` |
| 5 | None | nothing left | — | → ghost wireframe |

Liveness rule: tier 1–3 ⇒ live (badge: **Linked**); tier 4 ⇒ frozen (badge: **Snapshot**); tier 5 ⇒ ghost. Tier 3 sits below the directory because a dir also gives the hash-relink rescue (tier 2) — folder-mounted assets have a richer recovery path than loose drops. **Unmatched modal** (post-load) lists only assets where a live source was *expected but failed*: `status==='static' && (directoryHandleKey || fileHandleKey)`. Assets that were always frozen (no link at all) never surface — they're not lost, they're snapshots by design.

### Load Sequence (order critical)
```
1. Parse JSON, check version compatibility.
2. HistoryManager.clear()
3. Dispose all current Babylon meshes/materials/containers, revoke blob URLs.
4. Restore print, sceneSettings, ui, gizmo, uvOverrides, userSwatches,
   collections into state (no Babylon work).
8. Resolve + restore every assetLibrary entry sequentially:
   - For each: run `_resolveAssetBlob` (see priority table above).
   - Mesh assets: restoreContainer, then REBIND imported textures owned by
     this container (§10b reload rebind rule: match persisted
     babylonTextureName, register under the persisted texture assetId).
   - User-loaded texture assets: restoreTexture under the persisted id.
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
- Writes full JSON to IndexedDB key `autosave_${projectName}`.
- Startup does NOT auto-offer recovery: the boot flow re-mounts the last
  asset folder instead (AssetPanel.promptRemount — deliberate Phase 6
  decision: folder relink beats session recovery for this workflow).
  `recoverAutosave()` exists for an explicit recovery entry point.
- Cleared after successful explicit save.
- Known cost (arch A9, accepted for now): each autosave re-embeds all asset
  bytes as base64 on the main thread. Planned relief: autosave docs without
  `fileData` (recovery resolves via live tiers + last explicit save).

### Recent Projects
- Max 10. Stored under IndexedDB key `recent_projects`.
- Entry: `{ name, path, savedAt, thumbnailDataUrl }`. Thumbnail = viewport screenshot at save time (use `BABYLON.Tools.CreateScreenshot`).

---

## PART 11b — IDB (IndexedDB Layer)

**File: `src/core/idb.js`**

Thin wrapper over IndexedDB. Single DB `'mixomesh'` v1 with two object stores:
- `handles` — structured-clonable `FileSystemDirectoryHandle` / `FileSystemFileHandle`. Survives reloads (Chrome only). Keys: `last_mount_dir` (rec `{key, name}`), `fh_<assetId>` (loose-drop file handles, see §11 tier 3), `<mountKey>` (per-mount dir handles minted by `AssetLoader.mountDirectory`).
- `kv` — generic JSON-serialisable values. Keys: `recent_projects` (max 10, see above), `autosave_<projectName>` (full project JSON, 60 s while dirty).

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

**File: `src/core/PrintManager.js`**

### Public API
```js
PrintManager.exportOBJ(options)               → Promise<void>  // triggers download
PrintManager.exportSTL(options)               → Promise<void>
PrintManager.exportThreeMF(options)           → Promise<void>  // printer-selected 3MF mode
PrintManager.getExportedDimensions(meshId)    → {x,y,z} in mm at targetRatio
PrintManager.SCALE_PRESETS                    → scale-presets.json passthrough

// options = { selectedOnly?:bool, individually?:bool, onProgress?:fn }
//   selectedOnly  — restrict to current selection (default: all isPrintPart meshes)
//   individually  — one file per mesh on disk (see "Export filenames" below)
//                   (default: one combined file per format)
```

`PrintManager` does not expose ratio setter functions in the Vite baseline.
`PrintPanel` updates `state.print.targetRatio` directly for export-only scale
changes and uses `HistoryManager.RescaleWorldCommand` for working-ratio rebake
changes.

### Export filenames

Every export filename follows one recipe so two exports at different scales
never collide on disk and the user can read the scale from the filename
without opening the file. **The ratio suffix is always present, even at
1:1** — consistency beats brevity here:

```
suffix         = `_r${workingRatio}to${targetRatio}`     // e.g. `_r1to144`, `_r1to1`
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
colour and no map gets ignored or interpreted as plain white. To keep
OBJ+MTL exports usable on the primary printer target, **OBJ export
synthesises a 4×4 RGBA PNG per unique solid-colour material** and injects a
`map_Kd` line into the MTL pointing at it. Tiled sampling makes 4×4
sufficient — every texel is the same colour, so any UV (or none) resolves
to the same pixel. Concept-only fallback: this is OBJ-specific; 3MF
Materials Extension already preserves real textures and falls back to
`<m:colorgroup>` for solid materials.

Filenames + dedup:
- Per-material hex key `RRGGBBAA` where `A = round(material.alpha × 255)`.
- File path inside the export zip: `textures/solid_${HEX_RRGGBBAA}.png`.
- One PNG per unique key — N materials of the same (rgb, α) → one PNG.
- MTL line appended per matching `newmtl` block: `map_Kd textures/solid_${HEX_RRGGBBAA}.png`.

Transparency:
- The α byte lives **in the PNG** (modern slicers, Mimaki especially, read
  this).
- MTL `d` (dissolve) is left at whatever Babylon's `OBJExport.MTL` emits
  — i.e. it carries `material.alpha` already — so legacy slicers that
  only read MTL opacity still get the right value. The two channels match
  by construction; multiplying both is a slicer edge case rare enough to
  accept.

Toggle:
- `state.print.objBakeSolidTextures` (default **true**). Persisted in
  `state.print` like every other print option; survives save/load via
  `PersistenceManager`'s shallow-merge — old saves without the key auto-
  default to `true` on load.
- Surfaced as the **"Bake solid colors to texture (OBJ, Mimaki-friendly)"**
  checkbox on the Export tab. Toggling dispatches a silent `setState` (no
  history entry — it's an export option, not a scene mutation).
- Disabling skips synthesis entirely: no PNG entries, no `map_Kd`
  injection. OBJ ships as classic vertex-coloured material — chosen
  explicitly when an FDM workflow or a downstream tool prefers it.

Code seams:
- `PrintManager._synthesizeSolidShaderTextures(meshList)` — returns
  `{ blobByName, filenameByMaterialName }`. Skips materials with a real
  diffuse/albedo/base texture (the existing `_collectTextureBlobs` path
  owns those).
- `PrintManager._solidColorBlob(r,g,b,a)` — 4×4 RGBA PNG via canvas.
- `PrintManager._injectMapKd(mtlString, filenameByMaterialName)` —
  post-processes the MTL string emitted by `BABYLON.OBJExport.MTL`,
  splitting on `^newmtl\s+` to locate each block and appending the
  `map_Kd` line. No-op when the map is empty.
- All three are called from `_serializeOBJ` only; STL and 3MF are
  unaffected.
> **Phase 6 — structured export pipeline.** All three entry points are thin
> wrappers over one orchestrator `_runExport(format, options)` driven by a
> declarative `FORMATS` / `PREP_STEPS` registry: collect → clone (+
> `makeGeometryUnique` so the shared-geometry clone can't corrupt the scene)
> → ordered prep (`fallbackMaterial` / `flattenWorld` (world-matrix + mm scale
> bake) / weld / optimizeIndices / createNormals / CSG2) → re-validate the
> fixed clones → serialize → package. The live scene is never mutated.
> Validation runs *after* prep; export only blocks on errors that survive the
> auto-fix (`err.validationErrors`). `options.onProgress(frac,msg)` feeds the
> blocking `src/ui/ProgressOverlay`. See §15 *Phase 6* for the full surface
> (CSG2-needs-watertight, 3MF Z-up + baked viewer-invariant placement, etc.).

### Split Print Modules

`PrintManager.js` stays the orchestrator and serializer owner. Helper modules
under `src/core/print/` keep reusable policy out of the large file:

- `PrintScale.js`
  - imports `scale-presets.json` and exports `SCALE_PRESETS`.
  - `exportFactor()` returns `(state.print.workingRatio / state.print.targetRatio) * 1000`.
  - `ratioSuffix()` returns `_r{workingRatio}to{targetRatio}` using current state.
  - `exportBaseName(ctx)` returns safe `${project}${suffix}`.
  - `perMeshBaseName(ctx, meshName)` returns safe `${project}_${mesh}${suffix}`.
  - `getExportedDimensions(meshId)` returns world AABB size in target mm.
  - `scaleSummary()` returns display strings for UI.
- `PrinterProfiles.js`
  - imports `printers.json`.
  - exports `DEFAULT_PRINTER_ID = 'mimaki-3duj-553'`,
    `DEFAULT_MIMAKI_3DUJ_553_BED`, `getPrinterProfile(id?)`,
    `getDefaultPrinterProfile()`, `bedDimensionsForPrinter(id?)`,
    `listPrinterProfiles()`, `getPrinterProfileMap()`, and
    `printerProfileExists(id)`.
  - Unknown ids fall back to the Mimaki default.
- `ExportPlanner.js`
  - `buildExportPlan(input)` resolves profile, normalizes
    `selectedOnly/individually`, computes `printExportScale`, and carries the
    mesh list through unchanged.
  - `scaleFilenameSuffix(sceneScale, printScale)` returns `_r{scene}to{print}`;
    non-integer tokens replace `.` with `p`.
  - `exportBaseName(projectName, sceneScale, printScale)`,
    `perMeshBaseName(projectName, meshName, sceneScale, printScale)`, and
    `safeFilenameStem(value)` implement the filename contract.
  - `profilePreservesTextures(profile)` is true only when color mode is
    `texture-uv` and `prep` includes both `preserveUVs` and
    `preserveTextures`.
  - `profileUsesSolidPartColors(profile)` is true for `solid-per-part` or
    `collapseToSolidColor`.
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
  - `createFormats({ serializeOBJ, serializeSTL, serialize3MF })` returns
    `{ obj, stl, '3mf' }`.
  - OBJ prep: `fallbackMaterial`, `flattenWorld`, `weld`,
    `optimizeIndices`, `createNormals`; CSG not required.
  - STL prep: `flattenWorld`, `weld`, `optimizeIndices`, `csg`,
    `createNormals`; CSG required.
  - 3MF prep: `fallbackMaterial`, `flattenWorld`, `weldSolidOnly`,
    `optimizeIndices`, `csgSolidOnly`, `createNormals`; CSG required, but
    textured meshes keep UV seams.
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
add a serializer in `PrintManager`, add planner/type coverage, and add only
generic reusable prep/packaging logic to the helper modules.

### Scale Math

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

### Presets
Maintained in **`src/config/scale-presets.json`** (edit the JSON, no code change).
`PrintManager.js` re-exports it unchanged:
```js
import scalePresetData from '../../config/scale-presets.json' with { type: 'json' };
export const SCALE_PRESETS = scalePresetData;
```
Each entry: `{ category, label, ratio }`. `ratio: null` marks the free-form
**Custom** row (user types any `M:N`).

### Printer Profiles (`src/config/printers.json`) — single source of truth

Per-printer behavior (format, color mode, texture limits, bed dimensions,
axis/winding, prep pipeline) is data-driven. `src/config/printers.json` is the
**only** place to add/edit a printer. Replaces the earlier
`src/config/bed-presets.json` (deleted) — bed dims live inline per row.

Schema (one entry per printer, keyed by id):
```js
{
  "<id>": {
    displayName: string,                          // shown in UI dropdowns
    vendor: string,
    format: '3mf-materials-ext' | '3mf-colorgroup' | 'obj+mtl' | 'stl',
    color: {
      mode: 'texture-uv' | 'solid-per-part' | 'none',
      colorSpace?: 'sRGB'
    },
    texture: null | { maxSize: number, encoding: 'png' },
    bed: { x: number|null, y: number|null, z: number|null },  // mm; null falls back to Mimaki default helper
    axis: { up: 'Y' | 'Z', winding: 'cw' | 'ccw' },
    unit: 'millimeter',
    prep: ExportPrepStep[]
  }
}
```

`ExportPrepStep` is locked by `src/core/printers/PrinterProfile.ts`:
`fallbackMaterial`, `flattenWorld`, `preserveUVs`, `preserveTextures`,
`collapseToSolidColor`, `synthesizeSolidColorPNG`, `weld`, `repairWinding`.
Runtime format prep in `src/core/print/PrintFormats.js` also uses internal
steps that do not appear in `printers.json`: `optimizeIndices`,
`createNormals`, `csg`, `weldSolidOnly`, and `csgSolidOnly`.

Current profile ids:
- `mimaki-3duj-553`: default, `3mf-materials-ext`, `texture-uv`, 4096 PNG,
  `508 × 508 × 305` mm, Z-up, CCW.
- `mimaki-3duj-2207`: `3mf-materials-ext`, `texture-uv`, 2048 PNG,
  `203 × 203 × 76` mm.
- `bambu-x1c`, `bambu-a1`, `bambu-a1-mini`, `prusa-mk4`: `3mf-colorgroup`,
  `solid-per-part`, no texture.
- `elegoo-saturn-4-ultra`: `stl`, `none`, no texture.
- `generic-obj-mtl-png`: `obj+mtl`, `texture-uv`, Y-up, solid-color PNG
  synthesis allowed.
- `custom`: `obj+mtl`, `solid-per-part`, null bed dimensions.

Consumers:
- `PrintPanel.js` reads `state.print.targetPrinterId` → looks up row → drives
  format/color UX, bed-size readout, and the export call.
- `SceneManager.js` reads the same row's `bed` for the floor/bed preview
  geometry (replaces the old `bedPresets` lookup).
- `PrintManager._serialize3MF` resolves the current printer row and chooses
  Materials Extension for `format: '3mf-materials-ext'`; all other 3MF rows
  use colorgroup. OBJ/STL calls use their explicit public entry points.
- `src/core/print/ExportPlanner.js` reads printer id + scene/print scale to
  produce filename suffixes, export scale, profile texture helpers, and the
  request shape tested by `tests/export-planner.test.mjs`.

Default seeded entry: `mimaki-3duj-553`. State default
`state.print.targetPrinterId === 'mimaki-3duj-553'`. Each printer's `bed`
also seeds `state.print.bedDimensions` at project create / printer-switch
time (still a state field; printers.json is the *source*, state is the
*current value*, mirrors how `scale-presets.json` seeds `workingRatio`).

Ratio inputs in PrintPanel accept any positive `M:N` (or `M/N`) — both numerator and denominator parsed as floats. A bare `N` is shorthand for `1:N`. The stored value is `N / M`, so `1:72 → 72`, `2:1 → 0.5`, `3:5 → 5/3 ≈ 1.667`. Display:
- value `> 1` → `1:N` (N rounded, decimal if non-integer)
- value `< 1` → `M:1` (M = 1/value, decimal if non-integer)
- value `≈ 1` → `1:1`

This lets the user scale **up** (e.g. 2:1 for an oversized fit-test print) as well as **down** (1:72 model). Both `RescaleWorldCommand` and `exportFactor()` already operate on plain positive numbers, so no math changes are needed downstream.

### OBJ + MTL Export (Primary)

**Use `BABYLON.OBJExport.OBJ()`.** Do not write a custom OBJ serializer.

Current implementation:
1. `_runExport('obj', options)` collects print parts and clones each mesh.
2. Each clone gets `makeGeometryUnique()` before prep.
3. Format prep runs: `fallbackMaterial`, `flattenWorld`, `weld`,
   `optimizeIndices`, `createNormals`.
4. `_serializeOBJ(ctx)` calls `BABYLON.OBJExport.OBJ(meshes, true,
   mtlName, true)` and `BABYLON.OBJExport.MTL(meshes)`.
5. Real diffuse/albedo/base textures are encoded as PNG blobs under
   `textures/`.
6. If `state.print.objBakeSolidTextures` is true, solid-color materials also
   get synthetic 4×4 PNGs and matching `map_Kd` MTL lines.
7. Output is always an outer `.zip`. Combined mode contains one OBJ, one MTL,
   and texture entries. Individual mode contains per-mesh OBJ/MTL entries plus
   shared texture entries.
8. Live scene meshes are never scaled or rewritten.

### STL Export (Geometry-only fallback)
**Use `BABYLON.STLExport.CreateSTL()`.** STL is geometry-only and does not
carry shader, texture, or per-part color metadata.

Current implementation:
1. `_runExport('stl', options)` clones print parts and makes geometry unique.
2. Format prep runs: `flattenWorld`, `weld`, `optimizeIndices`, `csg`,
   `createNormals`.
3. CSG2 is attempted only when available. Non-watertight parts skip CSG and
   report an informational toast; validation still gates hard errors.
4. `_serializeSTL(ctx)` calls Babylon STL serialization on prepared clones.
5. Combined mode emits one `.stl`; individual mode emits an outer `.zip` with
   one STL per mesh.
6. STL remains a fallback for non-color printer targets, not a Mimaki
   texture-preserving output.

### Export Gate
- Re-validate all Print Parts via `MeshValidator.validateAllPrintParts()`.
- If errors → block, show modal listing them.
- If warnings only → confirm "Export anyway?"
- Bed-volume warning shown but does not block.

---

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

### Outliner (`src/ui/Outliner.js`)
- Renders unified tree from `state.scene.objects` + `state.scene.groups` + `state.scene.collections`.
- Row icons via `Icons.icon(name, attrs)` — see Part 2. Validation status
  badges (warning/error, stale-dimmed) read the §9 A6 cache and render as
  trusted markup after the escaped name.
- Drag-to-reparent (`PARENT_CHANGED`) — PLANNED, not implemented.
- Multi-select: `Shift+click` add, `Ctrl+click` toggle. Dispatch `SELECTION_CHANGED`.
- Double-click row name → inline rename (text input, blur/Enter commits via `RenameCommand`; collections via `RenameCollectionCommand`).
- Search bar (name / shader / validation filters) — PLANNED, not implemented.
- Ghost rows: red `CircleAlert` icon. Relink runs from the unmatched-assets
  modal (ProjectMenu) — per-row right-click relink is PLANNED.
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

The `Mixed` badge is static sibling markup after the escaped group-name span,
so inline rename reads only the actual group name and never treats the badge
as editable text.

Collection row interactions:
- Click name → select every mesh with that `collectionId` (descends across groups).
- Click chevron → toggle collapsed state in `ui.outlinerCollapsed[colId]`.
- Double-click name → inline rename (dispatches `COLLECTION_RENAMED`, not undoable for now).
- RMB → context menu: **Select Members**, **Rename Collection…**, **Delete Collection** (the last untags every member, leaving them visible as "uncollected" at outliner root; the collection entry is then removed from state).

Outliner row events are delegated from `#ol-list`; rows are not individually
re-wired on every render. Rows expose `role="treeitem"`, `tabindex="0"`, and
`aria-expanded` where applicable. Enter/Space activates the row like a click,
F2 begins inline rename, and ArrowLeft/ArrowRight collapse or expand collection
and group branches. Object rows still own shader drop targets, but the drop
handler is delegated and routes assignment through `ShaderAssignCommand`.

### Properties Panel (`src/ui/PropertiesPanel.js`)
Subscribes to `SELECTION_CHANGED`. Renders sections for Active Object:
1. **Object** — name, visible, locked
2. **Transform** — Position XYZ (mm), Rotation XYZ (deg), Scale XYZ. Tab/Enter commits via `TransformCommand`. On multi-select, fields show `—` when values differ; editing applies delta. Read-only **Size (mm)** row at top derived from world AABB (so a wrong-unit import is visible). **Apply Rotation** and **Apply Scale** buttons next to their section labels bake the current rotation/scale into vertex data and reset that component to identity (`BakeTransformCommand`, undoable via vertex snapshot). **Scale lock** (default on, toggled via icon below the Scale row) makes per-axis edits mirror proportionally across XYZ; the viewport scale gizmo's per-axis arrows are hidden in this mode so only the central uniform handle remains (`SceneManager.setScaleLock`).
3. **Source Unit** — dropdown + `AlertTriangle` if unconfirmed + "Confirm" button.
4. **Shader** (Phase 4, binding-only) — Lists distinct shaders bound to current selection as **slots**. Active mesh's shader appears first. Multi-selection across meshes with different shaders → one slot per shader. Per-slot UI: texture thumbnail chip or color preview, shader name, linked mesh-count badge, combined `<select>` with optgroup "Replace with → [list of all scene shaders]" + synthetic action "Duplicate in place". Click chip/name area → Library `focus(shaderId)`. **No color picker, sliders, or UV inputs here** — those live only in the Shader Library. Properties Shader is binding-only.
5. **UV Override** — offset/scale/rotation inputs per-mesh; "Reset to Default" button. Mesh-specific UI.
6. **Print Part** — export toggle.
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

The earlier "Source Unit" copy variant was dropped — Source Unit edits
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
- **Sub-sections:** All collapsible via chevron headers (Scene Shaders, Editor, Swatches). Collapse state is module-local, lost on reload.

### Asset Panel (`src/ui/AssetPanel.js`)
- Bottom-docked, resizable.
- Uses `src/core/assets/AssetTypes.js` for canonical supported mesh/texture
  extension lists and extension parsing; the panel must not carry divergent
  local extension tables.
- Left column: a two-tab switcher (built ONCE in `init` — `src/app/main.ts` appends the
  panel-collapse button into `.ap-tree-header`, so the header element must
  survive re-renders; only `#ap-tree-list`, `#ap-grid-summary`, and
  `#ap-grid-body` re-render).
  - **Session** tab — all assets registered to *this project's* `assetLibrary`
    (loose drops + folder loads, regardless of source). Per-card **Linked /
    Snapshot** badge derived from `!!(asset.directoryHandleKey || asset.fileHandleKey)`.
    No tree (CSS: `#ap-tree[data-tab="session"] .ap-tree-list { display: none }`).
    Mount button is also hidden on this tab — mounting belongs to Library.
    Drag from a Session card uses `mountKey: SESSION_KEY`; ViewportDrop
    re-instantiates the existing AssetContainer (no reload, identical to a
    "Duplicate" via drag).
  - **Asset Library** tab — the *mounted folder browser*. Same lifecycle as a
    cross-project folder (re-mounted via `last_mount_dir` on boot, see §11
    Boot behaviour). Tree of mount roots + subdirectories. Mount button visible.
    Drag from a Library card carries the directoryHandleKey + relPath; the drop
    handler loads through `AssetLoader.loadFromHandle` so it registers as a
    Linked asset in this project's Session.
- Right column: thumbnail grid. Hover preview tooltip.
- Right-column filter controls are built once and persist across grid renders:
  a search input filters by filename/path and an asset-kind select filters
  All / Meshes / Textures. The grid summary reports shown vs total assets.
- Card: name, extension badge, source-unit badge (with warning icon if
  unconfirmed), and on Session — Linked/Snapshot link-status badge.
- Tree rows and cards escape all `data-*` attributes before writing HTML;
  drag payloads are reconstructed from `dataset` after the browser decodes
  those values.
- Double-click → Session: `instantiateAsset(assetId)` at origin; Library:
  `loadFromHandle(...)` at origin (or `loadTextureFromHandle` for textures).
- Mounting a folder auto-switches to the Library tab.
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
  filename. Retrieves a `FileSystemFileHandle` via
  `AssetPanel.getFileHandle(mountKey, path)`, then calls
  `AssetLoader.loadFromHandle(handle, position, { directoryHandleKey:
  mountKey, originalPath: path })`.
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

All async **import** work runs through `safeImport` (`src/ui/ImportError.js`) —
a `safeAsync` variant that, on failure, opens the `importError` detail modal
(filename + plain-language hint + collapsible technical stack) instead of a
transient toast, so a failed model/texture import is actionable. Both import
entry points use it: `ViewportDrop` (OS drop + Session/folder drag) and
`AssetPanel._activateCard` (double-click). The module does not keep state and
does not maintain its own extension table.

### Context Menu (`src/ui/ContextMenu.js`)
Triggered by RMB. Items per Part 12 of v3.0 (Group/Ungroup/Duplicate/Smart Replace/Transform Swab/Set Shader/etc.).

### Print Panel (`src/ui/PrintPanel.js`)
Tabs: Scale / Validation / Bed / Export (Thickness + Orientation future).
Validation reads the §9 A6 cache with an explicit "Validate All".
Display modes (print-preview matte, wireframe edges + colour) live in the
viewport toggles under the NavCube — see Viewport Toggles below — so they
work from every workspace; there is no Preview tab.

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

### Scene Panel (`src/ui/ScenePanel.js`)
Right-panel section `#rp-scene` — the specialist section of the **Scene
workspace** (hidden in Layout / Shade / Print). Scene-wide settings, moved
out of the Properties panel so
they stay reachable while an object is selected (the old Scene section only
rendered with nothing active — Properties is object-scoped now).

Every section is **collapsible** (same `.pp-collapsed` pattern as the
Properties panel) with the collapse state persisted per-user in
localStorage (`mixomesh.scenePanel.collapsed.v1` — NEVER in .mixo, same
per-user rule as workspaces). Defaults: Environment + Camera + Section
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
  `sceneSettings.renderOut`; capture engine = `core/RenderOutput.js`):
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
    belongs to DevTools in a browser) — `RenderOutput.capturePng`: RTT
    screenshot (`CreateScreenshotUsingRenderTargetAsync`) at the exact
    output resolution. The RTT path skips the camera post chain — no
    selection silhouette and no SSAO in renders — while keeping tone
    mapping (material-level). Scene furniture (grid / axes / bed preview /
    3D cursor) is hidden for the capture and restored; transparent mode
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
    **Sweep semantics (`RenderOutput._sweepRig`, shared by preview +
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
- **Group B — Pivot mode.** Active / Median / Cursor / World (in display order). Default = `'active'` so transforms pivot around the selected object out of the box. Click → `Selection.setPivotMode(...)`. `'world'` pivots at `(0,0,0)`; `'cursor'` pivots at `state.scene.cursor3d`.
- **Group ~ — Orientation.** Single toggle button. Click flips `state.gizmo.space` between `'world'` and `'local'` via `SceneManager.setGizmoSpace`. Label reads the current state.
- **Group C — Camera mode.** Free / Follow Active / World Origin. Click → `SceneManager.setFollowMode(...)`. See §7 *Camera Follow Modes*.

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
- **Center:** live mesh stats for the selection (`src/ui/MeshStats.js` →
  `StatusBar.setCenter`): `△ 82k · 120×80×45 mm · ✓ watertight` — triangle
  count, print-space W×D×H in mm, and watertight state (no error-severity
  validation results). Selection-driven; empties when nothing is selected.
- **Right:** undo/redo labels, polycount, save state (`Circle` for dirty, `Check` for saved).

Collapses non-essential segments below 1280px.

### Toast (`src/ui/Toast.js`)
- Max 4 stacked bottom-right.
- Types: info / success / warning / error / loading.
- `loading` shows spinning `Loader2` icon (CSS rotation), ignores duration.
- `show(message, type, duration, { onClick })` — an `onClick` makes the toast
  a button (`role="button"`, focusable, Enter/Space): activation dismisses the
  toast then runs the handler. Used by validation toasts (B5 click-through).

### Modal (`src/ui/Modal.js`)
Generic. Listens for `MODAL_OPEN`. Renders by id (`shaderMerge`, `dirtyConfirm`, `validationErrors`, `importError`, etc.).

### App Shell (`src/ui/AppShell.js`)
Owns behaviour for the static shell declared in `index.html`: right-panel
section collapse (`button.rp-section-header` with `aria-expanded`), right-panel
splitter drag + keyboard resize (`role="separator"`), outer panel
collapse/expand buttons, and removal of `#boot-status` after successful
initialisation. `src/app/main.ts` calls `AppShell.init()` after the panels have rendered
their headers; `src/app/main.ts` no longer owns resize/collapse helper code.

### Project Menu (`src/ui/ProjectMenu.js`)
Header toolbar: **New / Open / Save / Save As** buttons + Recent-projects flyout (thumbnails + timestamps; max 10 from `PersistenceManager.getRecentProjects`). The header also exposes the **`#project-name` inline editor** — clicking (or pressing Enter/Space while focused) swaps the label for a text input pre-selected to the current name; Enter or blur commits via `HistoryManager.push(new RenameProjectCommand(prev, next))` (so the rename is undoable and marks the project dirty), Escape cancels, empty / whitespace cancels. Subscribes to `PROJECT_LOADED / PROJECT_SAVED / PROJECT_NEW / PROJECT_RENAMED` to refresh the label — the refresh skips the element while `data-editing="1"` so it can't clobber an open editor. Why editable in-place: the project name is the prefix for every export filename (see §12 *Export filenames*), so changing it must be a one-second action — not a hidden side-effect of Save As. Owns four `Modal.register` IDs the persistence flow dispatches into:
- `dirtyConfirm` — "Unsaved changes" → returns `'save' | 'discard' | 'cancel'`.
- `recoverAutosave` — surface a found autosave → `'recover' | 'discard'`.
- `unmatchedAssets` — Linked assets that fell back to Snapshot (only those with a link expectation: `directoryHandleKey || fileHandleKey`). Per-item **Relink…** button calls `PersistenceManager.relinkAsset(id)` and drops the row when it resolves.

`ProjectMenu.init()` is called from `src/app/main.ts` after `PersistenceManager.init()`; the persistence module dispatches `MODAL_OPEN` events but the renderers themselves live here so the UI layer owns markup.
Recent-project thumbnails are treated as persisted untrusted data and pass
through the UI rendering safety contract before becoming `<img src>`.

### Progress Overlay (`src/ui/ProgressOverlay.js`)
Full-screen blocking overlay shown during exports. Single instance, mounted into
the static `#progress-root` from `index.html` (or lazily created if an old shell
is loaded). Captures and swallows `pointerdown / pointerup / click / wheel /
keydown / contextmenu` so the user can't mutate the scene mid-pipeline.

```js
ProgressOverlay.show(title = 'Working…')   → void
ProgressOverlay.update(frac, message?)      → void   // frac 0..1; clamps to 0..100%
ProgressOverlay.hide()                      → void
```

`PrintManager._runExport` reports `onProgress(frac, msg)` across collect / prep / validate / serialize / package / download; `PrintPanel.runExport` wraps the call in `show / hide` via `try…finally` so a thrown error still tears the overlay down.

---

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
| **Layout** (default — import & arrange) | visible 260px | visible, task-filtered: Object / Transform / Source Unit / Print Part (Shader + UV hidden) | hidden | hidden | visible at default 220px (drop target focus) | hidden |
| **Shading** (id `shade` — texture / shader / UV) | visible 220px (narrow) | visible, task-filtered: Object / Shader / UV Override (Transform + Source Unit + Print Part hidden) | hidden | **visible, expanded — primary edit surface** | hidden | hidden |
| **Scene** (grid / environment / camera / Rendering output) | visible 220px (narrow) | **hidden** (scene-wide, not object work) | **visible** | hidden | hidden | hidden |
| **Print** (validate + export) | visible 220px (narrow) | **hidden** (per-object Print Part toggle lives in Layout; selective export via Print ▸ Export "selected only") | hidden | hidden | hidden | **visible at full height** (Scale / Validation / Bed / Export) |

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
| `tests/export.test.mjs` | 47 | PrintManager: collection gating; per-format prep; non-destructive clone; post-fix validation; selectedOnly / individually (OBJ + STL + 3MF colorgroup + 3MF materials-ext); OBJ fallback material; STL CSG present/absent + non-watertight rejection; 3MF OPC structure + colorgroup + origin-centering + winding-flip + explicit-identity build item; per-mesh 3MF wraps each inner OPC zip in an outer `.zip`; filename pattern (`${project}${suffix}.${ext}` combined, `${project}_${mesh}${suffix}.${ext}` individually) covers OBJ + STL + 3MF colorgroup + 3MF materials-ext including OBJ `mtllib` reference; OBJ solid-colour PNG synthesis (on/off, dedup by RRGGBBAA, opacity-byte flow, textured-shader skip, individually-mode per-mesh map_Kd injection); progress monotonic |
| `tests/export-planner.test.mjs` | 6 | ExportPlanner: `_r{scene}to{print}` filename contract, safe filename stems, explicit printer profile resolution, export scale, texture-preserving vs solid-colour profile helpers |
| `tests/validator.test.mjs` | 4 | MeshValidator: position-welded manifold (no false positive on unwelded imports); non-manifold + inverted-normals = `warning` (not blocking) |
| `tests/persistence.test.mjs` | 18 | PersistenceManager `__test`: base64 byte fidelity (0x8000 boundary + full 0–255); sha256; `_resolveAssetBlob` 5-tier priority (incl. `fileHandleKey` granted/denied + dir-beats-handle); `_scanDirForHash` recursion + ext filter; `_fileHandleAtPath`; `_arrToMap`; `_migrate` passthrough |
| `tests/printer-profile.test.mjs` | 3 | PrinterProfiles: Mimaki default profile, filament target selection, unknown-id Mimaki fallback |
| `tests/scale.test.mjs` | 8 | ScaleMath: ratio parser/formatter, Authored→Scene normalization, Scene→Print export scale, scene-scale rebake factor, v3.1 field compatibility |
| `tests/split-on-import.test.mjs` | 5 | AssetLoader splits MultiMaterial meshes at import time; `sourceGroupId` stamped on every sibling so the group can be re-unioned downstream |
| `tests/state-shape.test.mjs` | 10 | StateManager INITIAL_STATE invariants: required slots, defaults, `print.objBakeSolidTextures = true`, persistence migration shallow-merge handles missing keys |
| `tests/threemf-materials-ext.test.mjs` | 6 | 3MF Materials Extension writer: layout per printer profile, texture dedup, UV round-trip via pseudo-loader regex, Bambu fallback to colorgroup |
| `tests/validator-group.test.mjs` | 5 | Group-aware MeshValidator: split siblings re-union as welded watertight body; broken group reports the real seam |
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
keyboard resize, toast/modal/progress roots, and removal of `#boot-status`.
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

This section is the compressed build history for the canonical v4.0 blueprint.
Detailed behaviour contracts live in the module sections above; this section
records what landed and the current verification baseline.

### Current Product Baseline

- **Primary workflow:** import textured/full-colour models, assemble and transform parts, assign/override shaders and UVs, validate printability, then export printer-driven packages.
- **Primary target:** Mimaki 3DUJ-553 by default (`state.print.targetPrinterId = 'mimaki-3duj-553'`, bed `508 × 508 × 305` mm). Mimaki targets preserve continuous-tone textures through 3MF Materials Extension or OBJ+MTL+PNG.
- **Secondary targets:** Bambu / Prusa / Orca-style filament printers use 3MF `<colorgroup>` with one solid colour per part.
- **Verification baseline:** 112/112 headless tests, Vite production build, and Vite browser smoke are green after the 2026-06-08 Vite-only cleanup. Manual Chrome file-picker checks and external slicer acceptance checks remain useful when changing persistence/export behaviour, but they are not tracked as an active handoff.

### Build history

Moved to `BUILDLOG.md` (append-only; arch review A10). This part keeps only
the contracts below — baseline, locked decisions, and accepted scope cuts.

### Locked Design Decisions

- Per-printer behaviour is data-driven by `src/config/printers.json`; adding printers should not require export-code edits unless a genuinely new writer mode is introduced.
- Mimaki targets must never collapse textures to solid colours. Filament targets intentionally collapse to solid per-part colours.
- One-mesh-one-shader remains an invariant. MultiMaterial imports split into single-material siblings stamped with `sourceGroupId`; validator/exporter re-union by group.
- Export prep is non-destructive: clones get unique geometry before any world flattening, welding, normal creation, CSG, or serialization.
- Group-aware topology checks weld split siblings in validator-local buffers only; no welded data is copied back into Babylon meshes.
- `AGENTS.md` is the active instruction authority; `CLAUDE.md` is legacy context only.

### Accepted Scope Cuts

- Persistence load restores glTF-embedded imported-texture shaders to persisted diffuse colour when the original embedded texture cannot be rebound; geometry, user-loaded textures, shader parameters, transforms, groups, collections, camera, and print state restore.
- Mimaki 3MF loader/writer is XML-contract complete; external slicer compatibility should be rechecked when export semantics change.
- 3MF `<m:texture2d>` optional defaults (`contentbox`, tiling, filter) are omitted unless a Mimaki slicer requires explicit values.
- Vertex-colour printer mode is scaffolded in `printers.json` but has no writer pipeline because no current Mimaki target needs it.

---
## PART 16 — ACCEPTED CONSTRAINTS

| Constraint | Mitigation |
|---|---|
| Chrome / Edge only | Single startup check; blocking dialog otherwise |
| Source unit assumed mm (Blender default) | Per-asset override in Properties Panel; flips `unitConfirmed: false` until reviewed |
| Validation v1 = 3 checks only | Future Pro version adds thin-wall, self-intersect, overhang |
| Numpad shortcuts assume numpad | `Alt+1/3/7` registered as alternates |
| OBJ+MTL slicer support varies | Informational tooltip — not a blocking warning |
| IndexedDB FS handle permission resets per session | Boot remount-folder modal (AssetPanel.promptRemount) re-grants via its button gesture; per-asset relink via the unmatched-assets modal |

---

*End of MIXOMESH Blueprint v4.0*
