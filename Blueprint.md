# MIXOMESH — Implementation Blueprint v3.1
### Babylon.js · Vanilla JS · No Build Step · Chrome/Edge Only

> **For Claude Code:** Sections are in build order. Each module section is a contract:
> *Purpose · Data Structure · Public API · Implementation Rules · Pitfalls.*
> Use Babylon.js APIs whenever available — see §0.4 "Babylon-First Rule."
> Module size targets in §0.5 are enforced to keep files reviewable.

---

## PART 0 — GROUND RULES

### 0.1 Absolute Rules
- **Target browser:** Chrome / Edge only. App halts on startup if `'showDirectoryPicker' in window === false`.
- **1 Babylon Unit = 1 Meter.** UI shows mm: `mm = BU * 1000`.
- **All state mutations go through `StateManager.dispatch()`.**
- **All reversible actions push a Command to `HistoryManager`.**
- **All inter-module communication uses typed events from `events.js`.**
- **OBJ + MTL is the primary export format** (colored 3D printing).
- **Validation runs at import time, non-blocking.** Re-runs blocking before export.

### 0.2 CDN Imports (`index.html`)

Babylon ships UMD globals from `cdn.babylonjs.com`. The `babylon.module.js`
ESM file the older v3.0 of this blueprint specified does **not** exist on
the CDN, and the npm `babylonjs` package only ships UMD too. Use script
tags; defer scripts execute in document order before module scripts, so
`window.BABYLON` is populated before any of our ES modules run.

```html
<!-- UMD: populates window.BABYLON, then extends it -->
<script defer src="https://cdn.babylonjs.com/babylon.js"></script>
<script defer src="https://cdn.babylonjs.com/materialsLibrary/babylonjs.materials.js"></script>
<!-- Add these when Phase 2 / Phase 5 needs them -->
<!-- <script defer src="https://cdn.babylonjs.com/loaders/babylonjs.loaders.js"></script> -->
<!-- <script defer src="https://cdn.babylonjs.com/serializers/babylonjs.serializers.js"></script> -->

<script type="importmap">
{
  "imports": {
    "jszip": "https://cdn.jsdelivr.net/npm/jszip@3.10.1/+esm"
  }
}
</script>
```

In any module that needs Babylon, read it from the global:
```js
const BABYLON = window.BABYLON;
if (!BABYLON) throw new Error('Babylon.js failed to load');
```
Pin a version (`https://cdn.babylonjs.com/v9.6.2/babylon.js`) before shipping
if you need reproducible builds. Un-versioned URL is fine for development.

No other CDN libs. Everything else is vanilla JS.

### 0.3 File Layout
```
index.html
main.js                    ← bootstrap, dependency wiring only
styles/
  tokens.css               ← CSS variables (colors, spacing, type)
  layout.css               ← panel grid, splitters
  components.css           ← buttons, inputs, list rows, modals
core/
  events.js                ← imported by everything
  StateManager.js
  HistoryManager.js
  InputManager.js
  SceneManager.js
  AssetLoader.js
  ShaderLibrary.js
  MeshValidator.js
  PersistenceManager.js
  PrintManager.js
  Icons.js                 ← Lucide wrapper: returns SVG strings by name
ui/
  Outliner.js
  PropertiesPanel.js
  ShaderPanel.js
  AssetPanel.js
  ContextMenu.js
  PrintPanel.js
  StatusBar.js
  Toast.js
  Modal.js                 ← generic modal helper
```

### 0.4 Babylon-First Rule
Before writing custom logic, check if Babylon provides it. **Required uses:**

| Need | Use this |
|---|---|
| OBJ + MTL export | `BABYLON.OBJExport.OBJ(meshes, materials, matlibname)` |
| STL export | `BABYLON.STLExport.CreateSTL(meshes, ...)` |
| Selection outline | `BABYLON.HighlightLayer` (1 layer, 2 intensities) |
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
| Module | Target LOC |
|---|---|
| `events.js` | < 80 |
| `StateManager.js` | < 200 |
| `HistoryManager.js` | < 250 (all command classes in one file is OK) |
| `InputManager.js` | < 300 |
| `SceneManager.js` | < 400 |
| `AssetLoader.js` | < 350 |
| `ShaderLibrary.js` | < 400 |
| `MeshValidator.js` | < 300 |
| `PersistenceManager.js` | < 400 |
| `PrintManager.js` | < 350 |
| Each `ui/*.js` | < 400 |
| `main.js` | < 150 |

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

**File: `styles/tokens.css`**

Single dark theme. Pro-tool aesthetic. No theme switcher in v1.

```css
:root {
  /* Surfaces */
  --bg-0: #0a0a0b;          /* deepest — viewport background */
  --bg-1: #131316;          /* panel background */
  --bg-2: #1a1a1f;          /* elevated rows, hover */
  --bg-3: #232329;          /* selected rows, inputs */
  --bg-4: #2d2d35;          /* borders subtle */

  --border:        #2a2a30;
  --border-strong: #3a3a44;
  --border-focus:  #06b6d4;

  /* Text */
  --text-0: #ededf0;        /* primary */
  --text-1: #a1a1ab;        /* secondary */
  --text-2: #6b6b75;        /* tertiary, hints */
  --text-disabled: #4a4a52;

  /* Accent */
  --accent:     #06b6d4;    /* cyan — interactive, active */
  --accent-hi:  #22d3ee;
  --accent-fg:  #ecfeff;

  /* Status */
  --danger:  #ef4444;
  --warning: #f59e0b;
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

**Layout (`styles/layout.css`):**
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

**File: `core/Icons.js`**

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
SVG) and add an entry to `ICON_PATHS`. Names below are the ones the rest
of this blueprint references — add them in the phase that first uses
each one:
- Outliner: `Eye` / `EyeOff` (visibility), `Lock` / `Unlock`, `AlertTriangle`, `CircleAlert`, `Printer`, `CheckCircle2`, `XCircle`, `Folder`, `FolderOpen`, `Box`
- Header: `Save`, `FolderOpen`, `FilePlus`, `Undo2`, `Redo2`
- Status bar: `Move3D`, `RotateCcw`, `Maximize`, `Circle` (dirty), `Check` (saved)
- Asset panel: `Upload`, `Image`, `RefreshCw`
- Print panel: `Printer`, `Ruler`, `Layers`, `RotateCw`, `Download`, `AlertOctagon`
- Toast: `Info`, `CheckCircle`, `AlertTriangle`, `XCircle`, `Loader2` (spinner — animate via CSS)
- Shader panel: `Palette`, `Copy`, `Trash2`, `Plus`, `Edit3`

Render in DOM:
```js
element.innerHTML = icon('Eye', { class: 'icon-sm' });
```

---

## PART 3 — EVENTS

**File: `core/events.js`** (write first)

```js
export const EVENTS = {
  // Asset lifecycle
  ASSET_REGISTERED:        'asset:registered',
  ASSET_INSTANTIATED:      'asset:instantiated',
  ASSET_MISSING:           'asset:missing',
  ASSET_RELINKED:          'asset:relinked',

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
  AUTOSAVE_WRITTEN:        'project:autosaved',

  // Camera
  CAMERA_PRESET_CHANGED:   'camera:presetChanged',

  // UI
  TOAST:                   'ui:toast',
  MODAL_OPEN:              'ui:modalOpen',
  MODAL_CLOSE:             'ui:modalClose',
};
```

---

## PART 4 — STATE MANAGER

**File: `core/StateManager.js`**

### Public API
```js
StateManager.subscribe(eventName, fn)    → unsubscribeFn
StateManager.dispatch(eventName, payload) → void
StateManager.getState()                  → ReadonlyState
StateManager.setState(updaterFn)         → void
```

### State Shape (full schema — see Part 10 for persisted form)
```js
const initialState = {
  project: { name: 'Untitled', isDirty: false, lastSavedAt: null, version: '3.1' },
  scene: {
    objects: {},        // Record<meshId, SceneObject>
    groups: {},         // Record<groupId, GroupNode>
    assetLibrary: {},   // Record<assetId, AssetEntry>
    shaders: {},        // Record<shaderId, ShaderEntry>
    uvOverrides: {},    // Record<meshId, UVOverride>
    userSwatches: [],
    camera: { preset: 'perspective', alpha: 1.57, beta: 1.1, radius: 10, target: {x:0,y:0,z:0}, isOrthographic: false },
    overlays: { grid: true, axes: true, wireframe: false, bedPreview: false },
    cursor3d: { x: 0, y: 0, z: 0 },
  },
  selection: { selectedIds: [], activeId: null, pivotMode: 'median' /* median|active|individual|cursor */ },
  print: {
    workingScale: '1:1', targetRatio: null,
    bedPreset: 'Bambu P1S', bedDimensions: { x: 256, y: 256, z: 256 },
    minWallThickness: 1.2, printMode: 'fdm', chordTolerance: 0.05,
  },
  ui: { activePanel: 'properties', outlinerCollapsed: {}, assetPanelHeight: 220 },
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

## PART 5 — HISTORY MANAGER

**File: `core/HistoryManager.js`**

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

### Standard Commands (one file, all classes)
```
TransformCommand
ShaderAssignCommand
ShaderUpdateCommand
ShaderDuplicateCommand
ShaderDeleteCommand
UVOverrideCommand
ColorApplyCommand
GroupCommand / UngroupCommand
VisibilityCommand / LockCommand / RenameCommand
DeleteCommand
DuplicateCommand
SmartReplaceCommand
TransformSwabCommand
```

### Rules
- Stack limit 200. Drop oldest when exceeded.
- Undo/redo do **not** mark project dirty.
- New push clears redo stack.
- Commands capture `prev` state **before** `execute()`, never inside.
- `undo()` must perfectly reverse `execute()`.

---

## PART 6 — INPUT MANAGER

**File: `core/InputManager.js`**

Uses `scene.onKeyboardObservable` and `scene.onPointerObservable` — no `addEventListener` calls outside this module.

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
```

**Viewport:**
```
G              → grab (translate); axis with X/Y/Z; plane with Shift+X/Y/Z
R              → rotate; axis with X/Y/Z
S              → scale; axis with X/Y/Z
Escape / RMB   → cancel current op (restore pre-op transform)
Enter / LMB    → confirm op

A              → select all (toggle: all → none if all already selected)
Alt+A          → deselect all
B              → box select (drag marquee)
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
. (period)     → cycle pivot mode (median → active → individual → cursor)
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
LMB click      → pick + select
Shift+LMB      → add to selection
LMB drag empty → box select
RMB            → context menu
MMB drag       → orbit
Shift+MMB drag → pan
Wheel          → dolly zoom
Shift+RMB      → place 3D cursor at hit point
```

---

## PART 7 — SCENE MANAGER

**File: `core/SceneManager.js`**

### Public API
```js
SceneManager.init(canvas)
SceneManager.getScene()                       → BABYLON.Scene
SceneManager.getEngine()                      → BABYLON.Engine

// Camera
SceneManager.setCameraPreset(preset)          // 'perspective'|'top'|'bottom'|'front'|'back'|'left'|'right'
SceneManager.frameSelected(meshes)            // animate to fit bounding box of meshes
SceneManager.saveCameraState()                → CameraState
SceneManager.restoreCameraState(state)

// Gizmos
SceneManager.setGizmoMode(mode)               // 'translate'|'rotate'|'scale'|'none'
SceneManager.setGizmoSpace(space)             // 'world'|'local'
SceneManager.attachToSelection(meshes, pivot)

// Selection visuals
SceneManager.setActive(mesh)                  // strong HighlightLayer outline
SceneManager.setSelected(meshes)              // subtle HighlightLayer outline

// Overlays
SceneManager.setOverlay(name, on)             // 'grid'|'axes'|'wireframe'|'bedPreview'
SceneManager.updateBedPreview(dims)

// 3D Cursor
SceneManager.getCursor()                      → Vector3
SceneManager.setCursor(v3)
```

### Implementation Notes
- Camera: `BABYLON.ArcRotateCamera` with `mode` switched between `PERSPECTIVE_CAMERA` and `ORTHOGRAPHIC_CAMERA`. Compute ortho bounds from `camera.radius` and aspect on every preset change.
- Numpad presets set `alpha` and `beta` then call `camera.rebuildAnglesAndRadius()`.
- **Selection highlight:** one `BABYLON.HighlightLayer('hl', scene)`. Add active mesh with full-intensity color `var(--accent)`. Add selected (non-active) with reduced intensity (alpha 0.4). Remove all on selection change.
- **Gizmo:** `BABYLON.GizmoManager(scene)`. Subscribe to `gizmo.{position|rotation|scale}Gizmo.onDragStartObservable` → snapshot transforms. `onDragEndObservable` → push `BatchCommand`.
- **Axes overlay:** `new BABYLON.AxesViewer(scene, 0.5)`. Toggle visibility via dispose/recreate or by setting `viewer.scaleLines = 0`.
- **Grid:** ground plane (`MeshBuilder.CreateGround` 20×20m) with `BABYLON.GridMaterial` from `babylonjs-materials`. Minor lines 10mm, major lines 100mm.
- **Bed preview:** `MeshBuilder.CreateBox` sized to bed dims, semi-transparent material, wireframe outline overlay.
- **3D cursor:** custom small mesh (cross + sphere) created once, repositioned on demand.

### Lighting
1 × `HemisphericLight` (top-down, intensity 0.4)
1 × `DirectionalLight` (intensity 0.8, casts shadows on a `ShadowGenerator` 1024×1024)

---

## PART 8 — ASSET LOADER

**File: `core/AssetLoader.js`**

### Public API
```js
AssetLoader.mountDirectory()                          → Promise<DirectoryEntry>
AssetLoader.loadFromHandle(fileHandle, position)      → Promise<MeshId[]>
AssetLoader.loadFromBlob(blob, filename, position)    → Promise<MeshId[]>
AssetLoader.loadAssetsForProject(assetEntries)        → Promise<void>  // uses AssetsManager
AssetLoader.releaseAsset(assetId)                     → void
AssetLoader.getContainer(assetId)                     → BABYLON.AssetContainer | null
```

### AssetEntry
```js
{
  id, name, filename, originalPath, extension,
  sourceUnit,                  // 'meters'|'centimeters'|'millimeters'|'inches'|'feet'
  unitConfirmed,               // boolean
  directoryHandleKey,          // IndexedDB key for FileSystemDirectoryHandle
  blobUrl,                     // module-local Map, not in state
  thumbnailDataUrl,
}
```

### Load Flow
```
1. Receive FileHandle or Blob.
2. Create Blob URL via URL.createObjectURL.
3. BABYLON.SceneLoader.LoadAssetContainerAsync(blobUrl, '', scene, null, extension).
4. Register all materials → ShaderLibrary.registerFromContainer (merge strategy).
5. Store AssetContainer in module-local Map<assetId, container>.
6. Register AssetEntry in state.
7. addAllToScene() for the container.
8. Create SceneObject entries for each visible mesh.
9. Detect source unit (heuristic — see below). Set unitConfirmed=false if guessed.
10. Generate thumbnail via Tools.CreateScreenshotUsingRenderTarget (async).
11. If vertexCount <= 100_000 → queue MeshValidator.validateMesh; else skip auto-validate with toast.
12. Dispatch EVENTS.ASSET_INSTANTIATED for each mesh.
```

### Source Unit Heuristic
```js
function detectSourceUnit(container) {
  const bbox = computeContainerBoundingBox(container);
  const maxDim = Math.max(bbox.sizeX, bbox.sizeY, bbox.sizeZ);
  // HEURISTIC — flag unitConfirmed=false; user confirms in Properties Panel
  if (maxDim > 100)  return { unit: 'millimeters', confirmed: false };
  if (maxDim > 10)   return { unit: 'centimeters', confirmed: false };
  return { unit: 'meters', confirmed: false };
}
```

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

### Memory Rules
- `releaseAsset(assetId)`: only dispose container if `linkedMeshIds.length === 0`.
- Track blob URLs in `Map<assetId, blobUrl>` for explicit revocation.
- On `PROJECT_NEW` / `PROJECT_LOADED`: revoke all blob URLs, dispose all containers, clear map.

---

## PART 9 — MESH VALIDATOR

**File: `core/MeshValidator.js`**

### Scope (v1)
Three critical checks only. Pure JS — no WASM. Each handles 50k+ triangle meshes in under 200ms.

| Check | Severity | Method | Auto-Fix |
|---|---|---|---|
| Non-manifold edges | error | Edge-face count map; flag edges with count ≠ 2 | Merge by distance |
| Inverted normals | error | Cast ray from face centroid along normal; if it exits the mesh it's correct, else inverted (majority vote) | Flip winding |
| Exceeds bed volume | warning | Compare mesh world AABB to bed dims | None |

Deferred to future versions: thin-wall heatmap, self-intersection, overhang analysis.

### Public API
```js
MeshValidator.validateMesh(babylonMesh)            → Promise<ValidationResult[]>
MeshValidator.autoFix(babylonMesh, results)        → Promise<ValidationResult[]>
MeshValidator.hasErrors(results)                   → boolean
MeshValidator.hasWarnings(results)                 → boolean
MeshValidator.validateAllPrintParts()              → Promise<Map<meshId, ValidationResult[]>>
```

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
  - `warning` "⚠ [name]: 2 warnings" (persistent, clickable → Print Panel)
  - `error` "✗ [name]: 3 errors" (persistent, clickable)
- Outliner row icon updates correspondingly.
- **DO NOT** open a modal on import.

### Pre-Export Gate
- Re-runs validation on all Print Parts.
- Errors → block export, show modal listing issues with per-mesh links.
- Warnings only → confirmation "Export anyway?" (default yes).

---

## PART 10 — SHADER LIBRARY

**File: `core/ShaderLibrary.js`**

### Public API
```js
ShaderLibrary.createShader(partial)                    → shaderId
ShaderLibrary.updateShader(shaderId, field, value)
ShaderLibrary.duplicateShader(shaderId)                → newShaderId
ShaderLibrary.deleteShader(shaderId)                   // only if linkedMeshIds is empty
ShaderLibrary.assignToMesh(shaderId, meshId)
ShaderLibrary.setUVOverride(meshId, uv)
ShaderLibrary.clearUVOverride(meshId)
ShaderLibrary.applySwatchColor(shaderId, hex)
ShaderLibrary.getBabylonMaterial(meshId)               → BABYLON.Material
ShaderLibrary.registerFromContainer(container)         → shaderId[]
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
- On `setUVOverride`, clone the shared material once, apply UV offset, store in `Map<meshId, BABYLON.Material>`. Assign clone to that mesh only.
- On `clearUVOverride`, dispose clone, re-assign shared material.
- Do **not** clone-per-frame. Clone once on override creation.

### Shader Duplication
- New ShaderEntry with copied fields, `linkedMeshIds: []`, new id and auto-incremented name (e.g. `Hull_Metal` → `Hull_Metal.001`).
- Babylon material cloned via `mat.clone(newId)`. Same texture **reference** (not a copy).

### Import Merge Strategy
On material-name collision during `registerFromContainer`:
1. Dispatch `EVENTS.MODAL_OPEN` with id `shaderMerge`, payload `{ conflicts }`.
2. Modal options per conflict: **Use existing** / **Rename import** / **Replace scene shader**.
3. Default: Rename. Checkbox "Apply to all conflicts in this import."
4. On confirm: apply choices, continue load.

### Hardcoded Swatches
```js
export const DEFAULT_SWATCHES = [
  { id:'sw_primer_grey',   name:'Primer Grey',     hex:'#808080', category:'Primer' },
  { id:'sw_black_primer',  name:'Black Primer',    hex:'#1C1C1C', category:'Primer' },
  { id:'sw_white_primer',  name:'White Primer',    hex:'#F0F0F0', category:'Primer' },
  { id:'sw_olive_drab',    name:'Olive Drab',      hex:'#6B6B2B', category:'Military' },
  { id:'sw_nato_black',    name:'NATO Black',      hex:'#1A1A1A', category:'Military' },
  { id:'sw_desert_sand',   name:'Desert Sand',     hex:'#C2B280', category:'Military' },
  { id:'sw_panzer_grey',   name:'Panzer Grey',     hex:'#4A4A4A', category:'Military' },
  { id:'sw_russian_green', name:'Russian Green',   hex:'#4A5E3A', category:'Military' },
  { id:'sw_us_dark_green', name:'US Dark Green',   hex:'#354535', category:'Military' },
  { id:'sw_interior_buff', name:'Interior Buff',   hex:'#C8A87A', category:'Military' },
  { id:'sw_silver',        name:'Metallic Silver', hex:'#C0C0C0', category:'Metals' },
  { id:'sw_gunmetal',      name:'Gunmetal',        hex:'#2C3539', category:'Metals' },
  { id:'sw_brass',         name:'Brass',           hex:'#B5A642', category:'Metals' },
  { id:'sw_copper',        name:'Copper',          hex:'#B87333', category:'Metals' },
  { id:'sw_rust',          name:'Rust',            hex:'#8B4513', category:'Metals' },
  { id:'sw_bone_white',    name:'Bone White',      hex:'#E8E4C9', category:'Miniatures' },
  { id:'sw_flesh',         name:'Flesh',           hex:'#FFCBA4', category:'Miniatures' },
  { id:'sw_blood_red',     name:'Blood Red',       hex:'#8B0000', category:'Miniatures' },
  { id:'sw_royal_blue',    name:'Royal Blue',      hex:'#2B4590', category:'Miniatures' },
  { id:'sw_leather',       name:'Leather Brown',   hex:'#8B5E3C', category:'Miniatures' },
];
```

---

## PART 11 — PERSISTENCE MANAGER

**File: `core/PersistenceManager.js`**

### Public API
```js
PersistenceManager.save()                  → Promise<void>
PersistenceManager.saveAs()                → Promise<void>
PersistenceManager.open()                  → Promise<void>
PersistenceManager.newProject()            → Promise<void>
PersistenceManager.getRecentProjects()     → RecentProject[]
PersistenceManager.startAutosave(ms=60000) → void
PersistenceManager.stopAutosave()          → void
PersistenceManager.recoverAutosave()       → Promise<boolean>
```

### Full Project Schema (v3.1)
Every field persisted. Restored exactly.

```jsonc
{
  "version": "3.1",
  "savedAt": "ISO8601",
  "project": { "name": "..." },
  "sceneSettings": {
    "camera": { "preset": "perspective", "alpha": 1.57, "beta": 1.1, "radius": 10,
                "target": {"x":0,"y":0,"z":0}, "isOrthographic": false },
    "overlays": { "grid": true, "axes": true, "wireframe": false, "bedPreview": false },
    "cursor3d": { "x":0, "y":0, "z":0 }
  },
  "print": {
    "workingScale": "1:1", "targetRatio": 35,
    "bedPreset": "Bambu P1S", "bedDimensions": {"x":256,"y":256,"z":256},
    "minWallThickness": 1.2, "printMode": "fdm", "chordTolerance": 0.05
  },
  "assetLibrary": [ /* AssetEntry without container or blobUrl */ ],
  "shaders": [ /* ShaderEntry without linkedMeshIds */ ],
  "uvOverrides": { /* Record<meshId, UVOverride> */ },
  "userSwatches": [ /* SwatchEntry[] */ ],
  "sceneObjects": [ /* SceneObject[] */ ],
  "groups": [ /* GroupNode[] */ ],
  "selection": { "selectedIds": [], "activeId": null, "pivotMode": "median" },
  "gizmo": { "mode": "translate", "space": "world", "snap": {...} },
  "ui": { "activePanel": "properties", "outlinerCollapsed": {}, "assetPanelHeight": 220 }
}
```

### Load Sequence (order critical)
```
1. Parse JSON, check version compatibility.
2. HistoryManager.clear()
3. Dispose all current Babylon meshes/materials/containers, revoke blob URLs.
4. Restore print, sceneSettings, ui, gizmo into state.
5. Restore shaders into state + create Babylon materials in ShaderLibrary.
6. Restore uvOverrides into state.
7. Restore userSwatches.
8. Use BABYLON.AssetsManager to batch-load all assetLibrary entries:
   - For each: attempt to resolve via directoryHandleKey from IndexedDB.
   - Unresolved → create ghost (state.scene.objects entry with isGhost: true).
9. For each sceneObject:
   - If asset loaded → instantiate at transform, assign shader, apply UV override if exists.
   - If ghost → create wireframe bounding box at transform.
10. Restore groups (TransformNodes), re-parent children in order.
11. SceneManager.restoreCameraState() from saved camera.
12. Apply overlay states.
13. ShaderLibrary.rebuildLinkedIndex().
14. Queue validation for all non-ghost meshes (async, non-blocking).
15. Dispatch PROJECT_LOADED. Set isDirty=false.
```

### Autosave
- Interval 60s when `isDirty === true`.
- Writes full JSON to IndexedDB key `autosave_${projectName}`.
- On startup, if autosave entry exists AND is newer than last explicit save → recovery banner: "Autosave from [time]. Recover?" [Recover][Discard].
- Cleared after successful explicit save.

### Recent Projects
- Max 10. Stored under IndexedDB key `recent_projects`.
- Entry: `{ name, path, savedAt, thumbnailDataUrl }`. Thumbnail = viewport screenshot at save time (use `BABYLON.Tools.CreateScreenshot`).

---

## PART 12 — PRINT MANAGER

**File: `core/PrintManager.js`**

### Public API
```js
PrintManager.setWorkingScale(str)             // '1:1', etc.
PrintManager.setTargetRatio(num)              // 35, 48, ...
PrintManager.getExportedDimensions(meshId)    → {x,y,z} in mm
PrintManager.exportOBJ(options)               → Promise<void>  // triggers download
PrintManager.exportSTL(options)               → Promise<void>
```

### Scale Math
```js
function exportedPositionMM(v3, sourceUnit, targetRatio) {
  const unitFactor = SOURCE_UNIT_FACTORS[sourceUnit]; // m=1, cm=0.01, mm=0.001, in=0.0254, ft=0.3048
  const exportScale = 1 / targetRatio;
  // result in millimeters
  return {
    x: v3.x * unitFactor * exportScale * 1000,
    y: v3.y * unitFactor * exportScale * 1000,
    z: v3.z * unitFactor * exportScale * 1000,
  };
}
```

### Presets
```js
export const SCALE_PRESETS = [
  { category:'Military',   label:'1:35 Armor',      ratio:35  },
  { category:'Military',   label:'1:48 Aircraft',   ratio:48  },
  { category:'Military',   label:'1:72 Small',      ratio:72  },
  { category:'Military',   label:'1:100 Micro',     ratio:100 },
  { category:'Miniatures', label:'28mm Heroic',     ratio:56  },
  { category:'Miniatures', label:'32mm Standard',   ratio:48  },
  { category:'Miniatures', label:'54mm Large',      ratio:32  },
  { category:'Tabletop',   label:'6mm Epic',        ratio:300 },
  { category:'Custom',     label:'Custom',          ratio:null},
];
```

### OBJ + MTL Export (Primary)

**Use `BABYLON.OBJExport.OBJ()`.** Do not write a custom OBJ serializer.

```js
import * as BABYLON from 'babylonjs';
import 'babylonjs-serializers';
import JSZip from 'jszip';

async function exportOBJ({ partsOnly = true }) {
  // 1. Collect meshes
  const meshes = collectExportMeshes(partsOnly);

  // 2. Apply export scale: scale by source unit × (1/targetRatio) × 1000 (to mm)
  // OBJExport bakes mesh.scaling into output, so set scaling per mesh temporarily.
  const prevScales = meshes.map(m => m.scaling.clone());
  meshes.forEach(m => {
    const f = SOURCE_UNIT_FACTORS[m.metadata.sourceUnit] * (1/state.print.targetRatio) * 1000;
    m.scaling.scaleInPlace(f);
  });

  // 3. Generate OBJ + MTL via Babylon
  const matlibName = `${state.project.name}.mtl`;
  const objString = BABYLON.OBJExport.OBJ(meshes, /*materials=*/ true, matlibName, /*globalposition=*/ true);
  const mtlString = BABYLON.OBJExport.MTL(meshes);

  // 4. Restore scales
  meshes.forEach((m, i) => m.scaling = prevScales[i]);

  // 5. Collect texture blobs from materials with diffuse textures
  const textureBlobs = await collectTextureBlobs(meshes);

  // 6. Bundle in zip
  const zip = new JSZip();
  zip.file(`${state.project.name}.obj`, objString);
  zip.file(`${state.project.name}.mtl`, mtlString);
  const texFolder = zip.folder('textures');
  for (const [name, blob] of textureBlobs) texFolder.file(name, blob);

  const archive = await zip.generateAsync({ type: 'blob' });
  triggerDownload(archive, `${state.project.name}.zip`);
}
```

### STL Export (Geometry-only fallback)
```js
function exportSTL() {
  const meshes = collectExportMeshes(true);
  // Apply scale baking same as OBJ flow
  BABYLON.STLExport.CreateSTL(meshes, /*download=*/ true, state.project.name,
    /*binary=*/ true, /*doNotBakeTransform=*/ false, /*supportInstanced=*/ false,
    /*exportIndividualMeshes=*/ false);
}
```

### Export Gate
- Re-validate all Print Parts via `MeshValidator.validateAllPrintParts()`.
- If errors → block, show modal listing them.
- If warnings only → confirm "Export anyway?"
- Bed-volume warning shown but does not block.

---

## PART 13 — UI MODULES

### Outliner (`ui/Outliner.js`)
- Renders unified tree from `state.scene.objects` + `state.scene.groups`.
- Row icons via `Icons.icon(name, attrs)` — see Part 2.
- Drag-to-reparent: `dragstart` on row, `dragover` on group, `drop` → `PARENT_CHANGED`.
- Multi-select: `Shift+click` range, `Ctrl+click` toggle. Dispatch `SELECTION_CHANGED`.
- Double-click row name → inline rename (text input, blur/Enter commits via `RenameCommand`).
- Search bar: filters by name / shader / part-label / validation status.
- Ghost rows: red `CircleAlert` icon, right-click → Relink (file picker).

### Properties Panel (`ui/PropertiesPanel.js`)
Subscribes to `SELECTION_CHANGED`. Renders sections for Active Object:
1. **Object** — name, visible, locked
2. **Transform** — Position XYZ (mm), Rotation XYZ (deg), Scale XYZ. Tab/Enter commits via `TransformCommand`. On multi-select, fields show `—` when values differ; editing applies delta.
3. **Source Unit** — dropdown + `AlertTriangle` if unconfirmed + "Confirm" button.
4. **Shader** — dropdown of scene shaders, Duplicate / Edit buttons.
5. **UV Override** — offset/scale/rotation inputs; "Reset to Default" button.
6. **Print Part** — toggle + label + tolerance.
7. **Validation** — collapsed list of issues with per-issue Auto-Fix button.

### Shader Panel (`ui/ShaderPanel.js`)
- Scene Shaders list: row per shader with color/texture preview, name, mesh count badge, action menu.
- Per-shader actions: Edit / Duplicate / Assign to Selection / Select Linked / Rename / Delete.
- Inline editor: type toggle, diffuse color picker, texture drop-target, UV base, opacity, PBR sliders.
- Swatch palette: hardcoded library grouped by category + user swatches with `Plus` button.
- Click swatch → applies `diffuseColor` to currently edited shader. Drag swatch → mesh: see Part 10.

### Asset Panel (`ui/AssetPanel.js`)
- Bottom-docked, resizable.
- Left: folder tree from mounted directory.
- Right: thumbnail grid. Hover preview tooltip.
- Card: name, extension badge, source-unit badge (with warning icon if unconfirmed).
- Double-click → add at origin. Drag → add at cursor ray-pick.

### Context Menu (`ui/ContextMenu.js`)
Triggered by RMB. Items per Part 12 of v3.0 (Group/Ungroup/Duplicate/Smart Replace/Transform Swab/Set Shader/etc.).

### Print Panel (`ui/PrintPanel.js`)
Tabs: Scale / Validation / Bed / Thickness (future) / Orientation (future) / Export.

### Status Bar (`ui/StatusBar.js`)
Single bar at bottom. Segments:
- **Left:** current op hint or default shortcuts.
- **Center:** active object summary `[name] X:0.0 Y:0.0 Z:0.0 mm`.
- **Right:** undo/redo labels, polycount, save state (`Circle` for dirty, `Check` for saved).

Collapses non-essential segments below 1280px.

### Toast (`ui/Toast.js`)
- Max 4 stacked bottom-right.
- Types: info / success / warning / error / loading.
- `loading` shows spinning `Loader2` icon (CSS rotation), ignores duration.

### Modal (`ui/Modal.js`)
Generic. Listens for `MODAL_OPEN`. Renders by id (`shaderMerge`, `dirtyConfirm`, `validationErrors`, etc.).

---

## PART 14 — STABILITY PATTERNS

### 14.1 safeAsync
```js
export async function safeAsync(fn, loadingToastId) {
  try { await fn(); }
  catch (err) {
    console.error(err);
    if (loadingToastId) Toast.dismiss(loadingToastId);
    Toast.show(`Error: ${err.message}`, 'error', 0);
  }
}
```
Wrap every async UI entry point.

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

## PART 15 — BUILD PHASES

### Phase 1 — Foundation
`tokens.css` · `layout.css` · `events.js` · `StateManager` · `HistoryManager` · `InputManager` · `SceneManager` · `Icons.js` · `Toast.js` · `StatusBar.js` · `main.js`
**Milestone:** Empty viewport, MMB orbit, axes + grid, status bar live, `Ctrl+Z` registered.

### Phase 2 — Asset Pipeline
`AssetLoader` · `ShaderLibrary` (registration stub) · `MeshValidator` · `AssetPanel`
**Milestone:** Mount directory, drop GLB onto viewport, see thumbnail, get validation toast.

### Phase 3 — Selection & Interaction
Selection model in StateManager · gizmo wiring in SceneManager · `Outliner` · `ContextMenu` · `PropertiesPanel` (transform + source unit) · remaining viewport shortcuts
**Milestone:** Click-select, G+X move with snap, Ctrl+G group, F frame, undo all.

### Phase 4 — Shader System
Full `ShaderLibrary` · `ShaderPanel` · Properties Panel shader + UV override sections · merge-strategy modal
**Milestone:** Create / duplicate / assign shaders, edit UV per mesh, apply swatches, all undoable.

### Phase 5 — Print Pipeline
`PrintManager` · `PrintPanel` · pre-export validation gate · bed preview overlay · OBJ+MTL via `BABYLON.OBJExport`
**Milestone:** Set 1:35, see live dimensions, export ZIP, open in Bambu Studio with colors intact.

### Phase 6 — Persistence & Polish
Full `PersistenceManager` with autosave + recent projects · ghost/relink in Outliner · Smart Replace · Transform Swab · camera state save/restore
**Milestone:** Save → close → reopen identically. Move asset file → reopen → ghost → relink → resolved.

---

## PART 16 — ACCEPTED CONSTRAINTS

| Constraint | Mitigation |
|---|---|
| Chrome / Edge only | Single startup check; blocking dialog otherwise |
| Source unit detection is heuristic | `unitConfirmed: false` → warning icon → user confirms |
| Validation v1 = 3 checks only | Future Pro version adds thin-wall, self-intersect, overhang |
| Numpad shortcuts assume numpad | `Alt+1/3/7` registered as alternates |
| OBJ+MTL slicer support varies | Informational tooltip — not a blocking warning |
| IndexedDB FS handle permission resets per session | Non-blocking re-grant banner |

---

*End of MIXOMESH Blueprint v3.1*
