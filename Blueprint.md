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
main.js                    ← bootstrap, dependency wiring, panel collapse/resize
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
  ViewportDrop.js          ← drag-and-drop onto viewport (asset panel + OS files)
  ViewportToolbar.js       ← floating bottom toolbar (Fusion 360-style)
  NavCube.js               ← top-left orientation widget
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
| `main.js` | < 300 (bootstrap + panel collapse/resize wiring) |

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
  AUTOSAVE_WRITTEN:        'project:autosaved',

  // Camera
  CAMERA_PRESET_CHANGED:   'camera:presetChanged',

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
    overlays: { grid: true, axes: true, wireframe: false, bedPreview: false, wireframeEdges: false, wireframeEdgeColor: '#f59e0b' },
    grid: { cellMM: 10, subdivisions: 10 },  // line styling only; floor footprint = print.bedDimensions XY
    cursor3d: { x: 0, y: 0, z: 0 },
  },
  selection: { selectedIds: [], activeId: null, pivotMode: 'median' /* world|median|active|individual|cursor */ },
  print: {
    workingRatio: 1,            // denominator of the scene display ratio (1 = 1:1)
    targetRatio:  1,            // denominator of the final print export ratio
    bedPreset: 'Elegoo Saturn 4 Ultra', bedDimensions: { x: 218.88, y: 122.88, z: 220 },
    minWallThickness: 1.2, printMode: 'fdm', chordTolerance: 0.05,
  },
  ui: { activePanel: 'properties', outlinerCollapsed: {}, assetPanelHeight: 220, scaleLocked: true },
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
Implemented in Phase 3:
- `TransformCommand` — `{ prev, next, alreadyApplied? }` keyed by meshId. Sets absolute transforms via `setParent(null)` cycle so the world position survives the change. Used by both gizmo drag-end and Properties Panel input commits.
- `VisibilityCommand`, `LockCommand`, `RenameCommand`
- `DeleteCommand` — soft-deletes (`setEnabled(false)` + remove from state) so undo restores instantly without re-instantiating from the asset container.
- `DuplicateCommand` — clones via `AssetLoader.cloneMeshAsNewObject`, offsets +10 mm in X so the clone is visible, auto-selects new meshes. Sharing geometry on redo: clones are kept disabled in memory and re-enabled on redo (same pattern as DeleteCommand).
- `GroupCommand` / `UngroupCommand` — creates/disposes a `TransformNode` pivot; reparents members preserving world transform. All three commands wrap their parent-touching work in a `_withDetachedPivot` helper that temporarily detaches the selection-visual pivot so meshes are in their canonical parents during the mutation.

Phase 4 implementations (Shader System):
- `ShaderCreateCommand` — `{ shaderId }` — creates new Babylon material, entry in state, pushes with `getNewId()`.
- `ShaderAssignCommand` — `{ shaderId, meshIds[] }` — reassigns material to multiple meshes, dispatches `SHADER_ASSIGNED` per mesh.
- `ShaderUpdateCommand` — `{ shaderId, field, prevValue, newValue }` — mutates Babylon material + state entry (color, opacity, UV base, etc.). Texture swaps go through `diffuseTextureAssetId`.
- `ShaderDuplicateCommand` — `{ shaderId, newShaderId }` — clones entry + Babylon material, linked meshes remain with original, pushes with `getNewId()`.
- `ShaderDeleteCommand` — `{ shaderId }` — checks `linkedMeshIds === []` before delete, disposes Babylon material.
- `UVOverrideCommand` — `{ meshId, isClearing, ...uvFields }` — applies or clears per-mesh UV offset/scale/rotation, clones material + texture on apply.
- `ColorApplyCommand` — `{ shaderId, hex }` — applies swatch color to a shader's diffuse, dispatches `COLOR_APPLIED`.

Phase 5 implementations:
- `PrintPartCommand` — `{ meshId, prevPrintPart, nextPrintPart }` — toggles `isPrintPart` / `partLabel` / `partTolerance` on a scene object, dispatches `OBJECT_UPDATED`.
- `RescaleWorldCommand` — `{ prevRatio, nextRatio }` — re-bakes every registered mesh's vertex data by `prev/next`, scales every ancestor `TransformNode.position` (via WeakSet dedup), scales `state.scene.cursor3d`, updates `state.print.workingRatio`. Undo runs the inverse factor.
- `BakeTransformCommand` — `{ meshId, kind: 'rotation' | 'scale' }` — bakes either the current rotation OR scaling into vertices and resets that component to identity. Position is left untouched. Snapshots pre-bake position + normal vertex buffers so undo restores exact bytes (no FP drift on repeated cycles).

Stubs (real bodies in later phases):
`SmartReplaceCommand`, `TransformSwabCommand`.

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
LMB drag empty      → box select
RMB during body drag → cancel (pivot snaps back, no history push)
RMB click            → context menu (deferred to UP; suppressed if drag > 4 px)
RMB drag             → pan camera target
MMB drag             → orbit
Wheel                → dolly zoom
Shift+RMB            → place 3D cursor at hit point
```

---

## PART 7 — SCENE MANAGER

**File: `core/SceneManager.js`**

### Public API
```js
SceneManager.init(canvas)
SceneManager.setTransformCommitHandler(fn)    // injected by main.js to push TransformCommand on gizmo drag-end
SceneManager.getScene()                       → BABYLON.Scene
SceneManager.getEngine()                      → BABYLON.Engine

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
SceneManager.setOverlay(name, on)             // 'grid'|'axes'|'wireframe'|'bedPreview'|'wireframeEdges'
SceneManager.setWireframeEdgeColor(hexColor)  // live-update edge color while wireframeEdges is on
SceneManager.setGrid({cellMM,subdivisions})   // re-skins grid lines (footprint unchanged)
SceneManager.rebuildBed()                     // rebuilds ground to current print.bedDimensions XY
SceneManager.updateBedPreview(dims)

// 3D Cursor
SceneManager.getCursor()                      → Vector3
SceneManager.setCursor(v3)
SceneManager.setCursorVisible(on)             // hidden by default; shown only for pivotMode='cursor'

// Picking
SceneManager.pickMeshIdAt(x, y)               → meshId | null  (filters out gizmo arrows / overlays)
```

### Implementation Notes
- Camera: `BABYLON.ArcRotateCamera` with `mode` switched between `PERSPECTIVE_CAMERA` and `ORTHOGRAPHIC_CAMERA`. Defaults tuned for a 300 mm working area: `radius=0.4`, `lowerRadiusLimit=0.02`, `upperRadiusLimit=5`, `wheelPrecision=500`, `panningSensibility=5000`. Compute ortho bounds from `camera.radius` and aspect on every preset change.
- Numpad presets set `alpha` and `beta` then call `camera.rebuildAnglesAndRadius()`.
- **Selection silhouette:** custom mask render-target + post-process — NOT `HighlightLayer`. HL's stencil mask leaks onto PBR mesh faces on any material reporting an alpha mode. The replacement renders selected meshes into a half-res RTT with an emissive-white override material (full brightness for `active`, ~0.5 for `selected`), then a fullscreen shader dilates the mask, subtracts the silhouette, and adds `outlineColor × ring` to the scene. By construction the ring exists only outside the mesh. Dials at top of SceneManager: `OUTLINE_RADIUS_PX = 4.5`, `OUTLINE_INTENSITY = 2.0`, `ACCENT_COLOR = '#f59e0b'` (amber — matches `--accent`).
- **Wireframe edges:** `SceneManager.setOverlay('wireframeEdges', on)` calls `mesh.enableEdgesRendering(0.9, true)` / `mesh.disableEdgesRendering()` on every mesh with `.geometry`. Edge color and width stored in module-local `_wireframeEdgeState`. `setWireframeEdgeColor(hex)` parses hex to `BABYLON.Color4` and updates all live edge renderers.
- **Gizmo:** `BABYLON.GizmoManager(scene)` with a temporary `TransformNode` pivot that parents the selected meshes at `pivotMode` (`median` or `active`; `individual` and `cursor` currently fall through to `median`). Drag-start snapshots absolute transforms; drag-end snapshots again and the bridge in `main.js` pushes one `TransformCommand` with `{ alreadyApplied: true }`.
- **Axes overlay:** three `MeshBuilder.CreateLines` meshes (red X, green Y, blue Z) at length `0.05` BU. 1-pixel GL line stroke, no arrowheads. Toggled via `mesh.isVisible`.
- **Bed (grid):** ground plane footprint = the printer bed XY (`state.print.bedDimensions.x` × `.y`, mm → BU; default Elegoo Saturn 4 Ultra 218.88 × 122.88 mm), rectangular. Lines drawn with `BABYLON.GridMaterial`, styled from `state.scene.grid` (`cellMM` minor cell size, `subdivisions` minor cells per major line; default 10 mm / 10). `SceneManager.rebuildBed()` resizes the floor when bed dimensions change (called from Print ▸ Bed); `SceneManager.setGrid({cellMM,subdivisions})` re-skins the lines (called from Properties ▸ Scene). The single flat `FRONT` tag sits at the `+Z` bed edge and scales with `min(width,depth)`. Old v3.1 saves with a scalar `scene.gridSize` are ignored; `scene.grid` falls back to the 10/10 default.
- **Bed FRONT tag:** a single `MeshBuilder.CreatePlane` mesh with `DynamicTexture` text `FRONT`, laid **flat on the bed** (`rotation = (π/2, π, 0)`, no billboard) hugging the +Z edge, 4 mm above the bed, textured face up with glyphs readable from the front-elevated camera (verified live; `rotation.x = -π/2` mirrors the text, `+π/2` alone is upside-down). Drawn in the muted grid-line colour (`rgba(97,97,117,0.55)` ≈ grid `Color3 0.38,0.38,0.46`) so it reads as part of the bed, not a UI accent. Only FRONT is shown — once the front edge is known the rest is implied; the old four upright billboarded tags (FRONT/BACK/LEFT/RIGHT) were dropped as visual noise. Size scales with bed extent (`max(0.03, extent * 0.10)` × 0.32 ratio). Rebuilt by `_rebuildGroundMesh` whenever bed extent changes. Visibility tracks `state.scene.overlays.grid` (toggled together with ground plane).
- **Bed preview:** `MeshBuilder.CreateBox` sized to bed dims, semi-transparent material, wireframe outline overlay.
- **3D cursor:** 3 mm sphere, hidden by default. Made visible only when `state.selection.pivotMode === 'cursor'` via `setCursorVisible`.
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
AssetLoader.loadTextureFromHandle(fileHandle)         → Promise<void>  // async thumbnail gen
AssetLoader.loadTextureFromBlob(blob, filename)       → Promise<void>
AssetLoader.registerImportedTexture(babylonTexture)   → Promise<assetId>  // glTF-embedded texture → asset entry + data URL thumbnail
AssetLoader.loadAssetsForProject(assetEntries)        → Promise<void>  // uses AssetsManager
AssetLoader.releaseAsset(assetId)                     → void
AssetLoader.removeAsset(assetId)                      → void  // removes from state + dispatches ASSET_REGISTERED{type:'removed'}
AssetLoader.instantiateAsset(assetId, position)       → Promise<MeshId[]>  // re-loads from cached blob URL; each call = independent scene objects
AssetLoader.getContainer(assetId)                     → BABYLON.AssetContainer | null
AssetLoader.getBabylonTexture(assetId)                → BABYLON.Texture | null
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
  directoryHandleKey,          // IndexedDB key for FileSystemDirectoryHandle
  blobUrl,                     // module-local Map, not in state
  thumbnailDataUrl,
}
```

### SceneObject (per visible mesh, in `state.scene.objects[meshId]`)
```js
{
  id,                          // meshId
  name,                        // mesh name from import or rename
  assetId,                     // back-reference to AssetEntry
  collectionId,                // outliner display bucket (null = uncollected)
  parentId,                    // groupId if this mesh is inside a group, else null
  shaderId,                    // shader currently assigned (null = scene default)
  visible, locked, isGhost,    // booleans
  isPrintPart,                 // include in OBJ/STL export
  partLabel, partTolerance,    // print-time annotations (Phase 5)
}
```

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

**On import**, the loader scales every parent-less node (and its position) by:

```js
importFactor = SOURCE_UNIT_FACTORS[sourceUnit] * (modelRatio / workingRatio);
// SOURCE_UNIT_FACTORS: meters=1, centimeters=0.01, millimeters=0.001, inches=0.0254, feet=0.3048
```

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

### Memory Rules
- `releaseAsset(assetId)`: only dispose container if `linkedMeshIds.length === 0`. Skip disposal if `isImported: true`.
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
ShaderLibrary.duplicateShader(shaderId)                → newShaderId  (returns id via getNewId())
ShaderLibrary.deleteShader(shaderId)                   // only if linkedMeshIds is empty
ShaderLibrary.assignToMesh(shaderId, meshId)
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
                "target": {"x":0,"y":0,"z":0}, "isOrthographic": false,
                "followMode": "free" /* 'free' | 'followActive' | 'worldOrigin' */ },
    "overlays": { "grid": true, "axes": true, "wireframe": false, "bedPreview": false,
                  "wireframeEdges": false, "wireframeEdgeColor": "#f59e0b" },
    "cursor3d": { "x":0, "y":0, "z":0 }
  },
  "print": {
    "workingRatio": 12, "targetRatio": 35,         // any positive float (e.g. 0.5 for 2:1 upscale)
    "bedPreset": "Bambu P1S", "bedDimensions": {"x":256,"y":256,"z":256},
    "minWallThickness": 1.2, "printMode": "fdm", "chordTolerance": 0.05
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

### Load Sequence (order critical)
```
1. Parse JSON, check version compatibility.
2. HistoryManager.clear()
3. Dispose all current Babylon meshes/materials/containers, revoke blob URLs.
4. Restore print, sceneSettings, ui, gizmo into state.
5. Restore shaders into state + create Babylon materials in ShaderLibrary.
6. Restore uvOverrides into state.
7. Restore userSwatches.
7b. Restore collections into state.scene.collections (outliner display only — no Babylon work).
8. Use BABYLON.AssetsManager to batch-load all assetLibrary entries:
   - For each: attempt to resolve via directoryHandleKey from IndexedDB.
   - Unresolved → create ghost (state.scene.objects entry with isGhost: true).
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
PrintManager.setWorkingRatio(num)             // 1, 12, 72 — denominator
PrintManager.setTargetRatio(num)              // 1, 35, 48, 72 — denominator
PrintManager.getExportedDimensions(meshId)    → {x,y,z} in mm at targetRatio
PrintManager.exportOBJ(options)               → Promise<void>  // triggers download
PrintManager.exportSTL(options)               → Promise<void>
```

### Scale Math

The asset loader has already baked unit conversion and the working ratio into the mesh's in-scene transform (see §8 *Import Scale Model*). The Print Manager only has to rescale from the **working ratio** to the **target ratio** and convert metres → millimetres:

#### Working-ratio re-bake (live)

Changing `state.print.workingRatio` after objects are already in the scene re-bakes **every** registered mesh so the scene's BU ↔ metres mapping stays consistent. PrintPanel routes the workingRatio input through `push(new RescaleWorldCommand(prev, next))` (defined in `core/HistoryManager.js`). The command:

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
```js
export const SCALE_PRESETS = [
  { category:'Default',    label:'1:1 Full Scale',  ratio:1   },
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

Ratio inputs in PrintPanel accept any positive `M:N` (or `M/N`) — both numerator and denominator parsed as floats. A bare `N` is shorthand for `1:N`. The stored value is `N / M`, so `1:72 → 72`, `2:1 → 0.5`, `3:5 → 5/3 ≈ 1.667`. Display:
- value `> 1` → `1:N` (N rounded, decimal if non-integer)
- value `< 1` → `M:1` (M = 1/value, decimal if non-integer)
- value `≈ 1` → `1:1`

This lets the user scale **up** (e.g. 2:1 for an oversized fit-test print) as well as **down** (1:72 model). Both `RescaleWorldCommand` and `exportFactor()` already operate on plain positive numbers, so no math changes are needed downstream.

### OBJ + MTL Export (Primary)

**Use `BABYLON.OBJExport.OBJ()`.** Do not write a custom OBJ serializer.

```js
import * as BABYLON from 'babylonjs';
import 'babylonjs-serializers';
import JSZip from 'jszip';

async function exportOBJ({ partsOnly = true }) {
  // 1. Collect meshes
  const meshes = collectExportMeshes(partsOnly);

  // 2. Apply export scale: (workingRatio / targetRatio) × 1000 (m at working → mm at target).
  // OBJExport bakes mesh.scaling into output, so set scaling per mesh temporarily.
  const prevScales = meshes.map(m => m.scaling.clone());
  const f = (state.print.workingRatio / state.print.targetRatio) * 1000;
  meshes.forEach(m => m.scaling.scaleInPlace(f));

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
- Renders unified tree from `state.scene.objects` + `state.scene.groups` + `state.scene.collections`.
- Row icons via `Icons.icon(name, attrs)` — see Part 2.
- Drag-to-reparent: `dragstart` on row, `dragover` on group, `drop` → `PARENT_CHANGED`.
- Multi-select: `Shift+click` range, `Ctrl+click` toggle. Dispatch `SELECTION_CHANGED`.
- Double-click row name → inline rename (text input, blur/Enter commits via `RenameCommand`).
- Search bar: filters by name / shader / part-label / validation status.
- Ghost rows: red `CircleAlert` icon, right-click → Relink (file picker).
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

Collection row interactions:
- Click name → select every mesh with that `collectionId` (descends across groups).
- Click chevron → toggle collapsed state in `ui.outlinerCollapsed[colId]`.
- Double-click name → inline rename (dispatches `COLLECTION_RENAMED`, not undoable for now).
- RMB → context menu: **Select Members**, **Rename Collection…**, **Delete Collection** (the last untags every member, leaving them visible as "uncollected" at outliner root; the collection entry is then removed from state).

### Properties Panel (`ui/PropertiesPanel.js`)
Subscribes to `SELECTION_CHANGED`. Renders sections for Active Object:
1. **Object** — name, visible, locked
2. **Transform** — Position XYZ (mm), Rotation XYZ (deg), Scale XYZ. Tab/Enter commits via `TransformCommand`. On multi-select, fields show `—` when values differ; editing applies delta. Read-only **Size (mm)** row at top derived from world AABB (so a wrong-unit import is visible). **Apply Rotation** and **Apply Scale** buttons next to their section labels bake the current rotation/scale into vertex data and reset that component to identity (`BakeTransformCommand`, undoable via vertex snapshot). **Scale lock** (default on, toggled via icon below the Scale row) makes per-axis edits mirror proportionally across XYZ; the viewport scale gizmo's per-axis arrows are hidden in this mode so only the central uniform handle remains (`SceneManager.setScaleLock`).
3. **Source Unit** — dropdown + `AlertTriangle` if unconfirmed + "Confirm" button.
4. **Shader** (Phase 4, binding-only) — Lists distinct shaders bound to current selection as **slots**. Active mesh's shader appears first. Multi-selection across meshes with different shaders → one slot per shader. Per-slot UI: texture thumbnail chip or color preview, shader name, linked mesh-count badge, combined `<select>` with optgroup "Replace with → [list of all scene shaders]" + synthetic action "Duplicate in place". Click chip/name area → Library `focus(shaderId)`. **No color picker, sliders, or UV inputs here** — those live only in the Shader Library. Properties Shader is binding-only.
5. **UV Override** — offset/scale/rotation inputs per-mesh; "Reset to Default" button. Mesh-specific UI.
6. **Print Part** — toggle + label + tolerance.
7. **Validation** — collapsed list of issues with per-issue Auto-Fix button.

**Scene** section (only when no object is active):
- **Grid cell (mm)** + **Subdivisions** inputs → `SceneManager.setGrid({cellMM,subdivisions})` (state `scene.grid`). Read-only hint shows the current bed size; bed size itself is set in Print ▸ Bed.

### Future: Copy active-to-selected (Phase 4 / 5 nice-to-have)
A "Copy from active" affordance on each Transform sub-section (Position, Rotation, Scale, Source Unit, Shader, UV Override) that applies the active object's value to all other selected objects in one batched `TransformCommand` / `ShaderAssignCommand` / etc. UI: small "↧ to all" button beside each section header, enabled only when `selectedIds.length > 1`. Three flavours per section:
- **Each axis** — per-component button (e.g. only copy Position.X).
- **Whole section** — copy all three components of Position.
- **All transforms** — single button at the Transform header that snaps Position+Rotation+Scale of every selected to match the active.

Not part of Phase 3's milestone. Defer until Phase 4 because the same pattern needs to apply to Shader/UV sections which don't exist yet.

### Shader Library (`ui/ShaderPanel.js`)
Renamed from "Shader Panel" in Phase 4. Right-panel lower section.

- **Scene Shaders list:** row per shader with texture thumbnail (if `diffuseTextureAssetId`) or color chip, name, linked mesh-count badge. Hover → small Duplicate button.
- **Create new:** `+` button in header creates a Standard material shader.
- **Inline editor:** Click any row to open editor below the list. Fields: type toggle (`Standard` / `PBR` / `Unlit`), diffuse color picker + hex field, texture slot with drop-target + Pick… button (opens texture modal grid), opacity / roughness / metallic sliders, UV-base inputs (offsetX/Y, scaleX/Y, rotation), action row (Duplicate / Assign / Select Linked / Delete). All edits update viewport live and are undoable.
- **Texture pick modal:** Click Pick… → grid of every loaded texture (including imported glTF-embedded ones). Click texture → assigns, modal closes. Also shows "Swap…" and clear button on loaded state.
- **Swatch palette:** Hardcoded DEFAULT_SWATCHES (Primer / Military / Metals / Miniatures, 20 entries) + User section with `+` button to capture current editor's color. Click swatch → `ColorApplyCommand` pushed.
- **Merge modal:** When `registerFromContainer` encounters material-name collisions → modal with per-conflict radios (Use existing / Rename import / Replace scene shader) + "Apply to all" checkbox.
- **Auto-focus:** Subscribes to `ACTIVE_OBJECT_CHANGED`. When active object changes, `ShaderPanel.focus(shaderId)` is called UNLESS an `<input>` / `<select>` / `<textarea>` inside the Library has DOM focus (prevents focus theft mid-edit).
- **Sub-sections:** All collapsible via chevron headers (Scene Shaders, Editor, Swatches). Collapse state is module-local, lost on reload.

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

### Viewport Toolbar (`ui/ViewportToolbar.js`)

Fusion 360-style floating pill anchored bottom-centre of the `#viewport` element. Always visible, always above the canvas. Four groups, divider between each:

- **Group A — Gizmo mode.** Move / Rotate / Scale. Click → `SceneManager.setGizmoMode('translate'|'rotate'|'scale')`.
- **Group B — Pivot mode.** Active / Median / Cursor / World (in display order). Default = `'active'` so transforms pivot around the selected object out of the box. Click → `Selection.setPivotMode(...)`. `'world'` pivots at `(0,0,0)`; `'cursor'` pivots at `state.scene.cursor3d`.
- **Group ~ — Orientation.** Single toggle button. Click flips `state.gizmo.space` between `'world'` and `'local'` via `SceneManager.setGizmoSpace`. Label reads the current state.
- **Group C — Camera mode.** Free / Follow Active / World Origin. Click → `SceneManager.setFollowMode(...)`. See §7 *Camera Follow Modes*.

Active button highlighted with `--accent`. Subscribes to `SELECTION_CHANGED`, `ACTIVE_OBJECT_CHANGED`, `CAMERA_PRESET_CHANGED`, `PROJECT_LOADED` so the active highlight stays in sync.

### Nav Cube (`ui/NavCube.js`)

Fusion 360-style orientation widget anchored top-left of the viewport. Pure DOM/CSS 3D — no Babylon meshes. A `scene.onBeforeRenderObservable` writes the cube's CSS transform each frame straight from the `ArcRotateCamera` spherical angles:

```
transform: rotateX(β − π/2) rotateY(π/2 − α)
```

At the front preset (α = β = π/2) this is the identity → the bare `nc-front` face. Yaw is `π/2 − α`: viewed from FRONT in Babylon's left-handed space world +X is on the viewer's LEFT, so a camera on +X (α = 0) shows the LEFT face. Verified live (Chrome DevTools) against the scene: front = identity/FRONT; camera +X → LEFT; camera −X → RIGHT; above → TOP; below → BOTTOM; every face label stays upright and readable. Earlier view-matrix reconstructions kept introducing mirror / 180° flips (Babylon LH ↔ CSS handedness), so the camera's own angles are used directly. The six CSS faces are the **canonical static cube layout** (`nc-front` +Z, `nc-back` −Z, `nc-right` +X, `nc-left` −X, `nc-top` +Y, `nc-bottom` −Y); all orientation lives in the per-frame rotateX/rotateY.

Interactions:
- **Click face** (FRONT/BACK/LEFT/RIGHT/TOP/BOTTOM) → `SceneManager.setCameraPreset(name)`. That call: (a) computes the scene bbox over all registered meshes, (b) animates camera `alpha/beta/target/radius` toward the orthogonal view + bbox fit (320 ms ease-in-out), (c) switches to `ORTHOGRAPHIC_CAMERA` after the animation finishes. The ortho view persists until the user pans (RMB drag) — auto-revert in `_applyFollowTarget` flips the preset back to `'perspective'`.
- **Drag any part of the cube** → orbit main camera (`alpha -= dx*0.01`, `beta -= dy*0.01`, clamped to `[0.01, π−0.01]`). A 4-px movement threshold suppresses the face-click when the gesture is actually a drag.
- **Home button** (small circular `⌂` below the cube) → `SceneManager.setCameraPreset('perspective')` — same code path, animates back to a 3/4 perspective view fit to the full scene bbox.

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

### Phase 4 — Shader System ✓ CLOSED 2026-05-14
Full `ShaderLibrary` · `ShaderPanel` (Shader Library) · Properties Panel shader + UV override sections · merge-strategy modal · imported texture readback · right-panel layout (splitter + sub-collapse) · body-drag translate on LMB
**Milestone:** Create / duplicate / assign shaders, edit UV per mesh, apply swatches, all undoable.
**What shipped:** Shader Library displays scene shaders with texture thumbnails. Inline editor for type / color / texture / UV base. Per-row Duplicate, per-mesh UV overrides clone texture to prevent leaks. Properties Shader section binding-only (slots with combined dropdown + auto-focus). Shader merge modal on import collisions. Right panel splitter + individually collapsible sub-sections. LMB drag on mesh translates on horizontal plane (Bambu Studio style). All undoable. Import readback pattern for glTF-embedded textures.
**Deferred (user accepted):** Copy-from-active, user-swatch persistence, multi-material-per-mesh, sub-section collapse persistence.

### Phase 5 — Print Pipeline ✓ CLOSED 2026-05-15
`PrintManager` · `PrintPanel` · pre-export validation gate · bed preview overlay · OBJ+MTL via `BABYLON.OBJExport`
**Milestone:** Set 1:35, see live dimensions, export ZIP, open in Bambu Studio with colors intact. — **verified in Chrome 2026-05-15.**
**What shipped:** PrintManager with SCALE_PRESETS (Default 1:1 added), exportOBJ/exportSTL with JSZip bundling, pre-export validation gate (errors block, warnings confirm). PrintPanel with Scale / Validation / Bed / Export tabs; ratio inputs accept any positive `M:N` format (parser stores `N/M`, so values < 1 = upscaled prints, > 1 = downscaled models). Bed preview overlay toggle. Print Part toggle in Outliner (6th column, Printer icon, `PrintPartCommand`). Wireframe edges overlay with color picker (`setOverlay('wireframeEdges')` + `setWireframeEdgeColor()`). Panel collapse/resize system in `main.js` (all three panels — Outliner, right panel, Asset Panel — collapsible + drag-resizable). Remove asset button in Asset Panel (session assets only). Session asset re-drag fixed via `instantiateAsset()` + blob URL cache.

**Adjustments batch (closed alongside Phase 5):**
- **Collections** — every import mints one display-only outliner bucket (`state.scene.collections`). Mixed-collection groups render at outliner root with a `Mixed` badge. RMB → Select Members / Rename / Delete. See §13 Outliner.
- **Working-ratio re-bake** — `RescaleWorldCommand` (Part 5) re-bakes every registered mesh's vertices and scales every ancestor `TransformNode.position` exactly once when `state.print.workingRatio` changes. Mesh.scaling stays `(1,1,1)`. Undo restores by running the inverse factor. PrintPanel's workingRatio input routes through this command; targetRatio remains plain `setState`.
- **Auto-dedupe on import** — `ShaderLibrary._findContentDuplicate` compares numeric fields + textureAssetId; exact match silently reuses the existing shader instead of opening the merge modal. `AssetLoader.registerImportedTexture` dedupes glTF-embedded textures by `${name}|${width}|${height}|${className}` so re-imports share textureAssetIds, which lets shader-content dedupe collapse the materials.
- **Apply Rotation / Apply Scale** — `BakeTransformCommand` (Part 5) bakes the current rotation OR scale into vertices and resets that component to identity. Position untouched. Undo uses a vertex-buffer snapshot so float error doesn't drift on repeated cycles.
- **Scale lock** — `state.ui.scaleLocked: true` (default). Properties Panel mirrors per-axis scale edits proportionally when locked. `SceneManager.setScaleLock(locked)` hides the scale gizmo's per-axis arrows so only the central uniform handle remains; re-applied each time `setGizmoMode('scale')` materialises the gizmo.
- **Viewport Toolbar (Fusion 360-style)** — floating bottom-centre pill with 4 groups: gizmo mode (Move/Rotate/Scale), pivot mode (World/Median/Active/Cursor), orientation toggle (World ↔ Local), camera mode (Free/Follow/World-Origin). Active button highlighted amber. See §13 *ViewportToolbar*.
- **Nav Cube** — DOM/CSS 3D widget anchored top-left of the viewport. Click face → orthogonal preset; drag → orbit; Home button → perspective reset. Sync via `scene.onBeforeRenderObservable`. See §13 *Nav Cube*.
- **Camera Follow Modes** — `state.scene.camera.followMode` (`free|followActive|worldOrigin`) drives a per-frame override of `_camera.target`. `followActive` tracks the active object's hierarchy bbox centre; `worldOrigin` pins to `(0,0,0)`. See §7 *Camera Follow Modes*.
- **Focus action** — RMB Outliner object → "Focus" (was "Frame Selection"). `frameSelected()` now uses hierarchy bounds + animated camera transition (280 ms ease-in-out on `target` and `radius`).

**Close-out batch (2026-05-15, verified live):**
- **Bed tab + presets** — `PrintPanel` Bed tab: printer presets (default **Elegoo Saturn 4 Ultra** 218.88×122.88×220 mm; Bambu P1S/X1C/A1/mini, Prusa, Ender, Generic, Custom), X/Y/Z mm inputs, "Show bed volume" overlay. `state.scene.overlays.bedPreview` + `SceneManager.setOverlay('bedPreview')` (the `updateBedPreview` box was previously dead code).
- **Scene floor = printer bed XY** — `state.scene.gridSize` removed; floor footprint now tracks `print.bedDimensions` (rectangular). New `state.scene.grid {cellMM,subdivisions}` is line-styling only. `SceneManager.setGrid()` (Properties ▸ Scene: Grid cell + Subdivisions) / `rebuildBed()` (Print ▸ Bed) replace `setGridSize()`. Old saves' scalar `gridSize` ignored (10/10 fallback).
- **Camera mouse remap (CAD)** — Babylon pointer orbit/pan disabled (`buttons:[]`); custom `_onCameraPointer`: RMB = orbit, MMB = pan, Shift+MMB = orbit, wheel = zoom, LMB = select/gizmo. Babylon hard-forces RMB as its pan button so RMB-orbit had to be custom. See §7.

**Deferred (user accepted):** Nav cube does not snap-to-corner / -edge isometric views (only face clicks). Camera follow modes lightly tested. Old v3.1 saves with scalar `scene.gridSize` lose grid styling (footprint still correct from bed).

### Phase 6 — Persistence & Polish
Full `PersistenceManager` with autosave + recent projects · ghost/relink in Outliner · Smart Replace · Transform Swab · camera state save/restore
**Milestone:** Save → close → reopen identically. Move asset file → reopen → ghost → relink → resolved.

### Phase handoff (every time a phase closes)
1. Flip the phase's checkbox in `CLAUDE.md` to `[x]`.
2. Rewrite `PHASE_HANDOFF.md` at the repo root as a self-contained pickup prompt for the next clear session (1-paragraph summary of what just landed, deferred items, design decisions locked, the next phase's BLUEPRINT §15 deliverables + milestone, and a STEP 0 / STEP 1 instruction block).
3. Add or update memory notes for anything durable (design decisions, deferred features, technical gotchas).
4. Commit only when the user asks.

`PHASE_HANDOFF.md` is rolling — overwrite each phase. Old phase history lives in this file (above) and in memory notes.

---

## PART 16 — ACCEPTED CONSTRAINTS

| Constraint | Mitigation |
|---|---|
| Chrome / Edge only | Single startup check; blocking dialog otherwise |
| Source unit assumed mm (Blender default) | Per-asset override in Properties Panel; flips `unitConfirmed: false` until reviewed |
| Validation v1 = 3 checks only | Future Pro version adds thin-wall, self-intersect, overhang |
| Numpad shortcuts assume numpad | `Alt+1/3/7` registered as alternates |
| OBJ+MTL slicer support varies | Informational tooltip — not a blocking warning |
| IndexedDB FS handle permission resets per session | Non-blocking re-grant banner |

---

*End of MIXOMESH Blueprint v3.1*
