# Settings Persistence + Reset + Header Logo — Design

Date: 2026-06-14
Status: approved (brainstorming)

## Goal

The browser should remember the user's last-used **panel settings** across
sessions (a fresh boot / New project starts with them), **excluding object
properties** (a new session has no objects loaded). Add a **per-section reset
button** that restores that section to factory defaults, a **top-bar "reset all
settings"** button, and the **mixomesh logo** at the header's left edge.

The factory defaults live in an **editable config file** so the default setup
can be changed later without touching code.

## Decisions (locked with user)

- **Precedence: File wins.** Per-user persisted settings seed a New/empty boot
  only. Opening a saved `.mixo` restores exactly what the file holds — per-user
  defaults never override a loaded project.
- **Reset-all scope: settings only.** Does NOT touch workspace / panel widths /
  section-collapse (those keep their existing separate persistence).
- **Logo: left of the project name**, both visible.
- **Overlays:** persist display prefs only (`grid`, `axes`, `printPreview`).
  Inspection modes (`wireframe`, `baseColorView`, `uvCheckerView`,
  `invertedFaces`, `bedPreview`) stay session-only — don't boot into wireframe.

## Architecture

### `src/config/default-settings.json` (NEW)

Single source of truth for the **factory** values of every persisted settings
slice. Imported via `import … with { type: 'json' }` (same pattern as
`printers.json`). Edited later to change defaults everywhere: boot, New, and all
reset buttons.

Contains: `render` (full look/grade/env/HDRI/SSAO/textureCap), `renderOut`
(width/height/transparent/turntable — NO `pose`), `grid`, `overlays`
(grid/axes/printPreview only), `print` (workingRatio/targetRatio/
targetPrinterId/bedDimensions/minWallThickness/printMode/chordTolerance/
objBakeSolidTextures), `gizmo` (space + snap), `pivotMode`.

`StateManager.INITIAL_STATE` consumes this file for those slices so the defaults
are defined in exactly one place.

### `src/core/SettingsStore.js` (NEW)

Curated per-user settings persistence. `localStorage['mx-settings-v1']`,
versioned + migrate-tolerant.

Pure / testable core:
- `SCHEMA` — declarative list mapping each persisted slice to its dotted state
  path + the field allow-list (so `overlays` only persists 3 keys, `renderOut`
  drops `pose`).
- `pickSettings(state)` → the persisted subset of a state object.
- `mergeSettings(base, persisted)` → deep-merge persisted over a base, accepting
  only SCHEMA-known paths (a corrupt/old blob can never inject unknown keys).
- `parseStored(raw)` → `{v, settings}` or null.

Glue:
- `load()` → persisted partial (or `{}`).
- `seedBootState(initial)` → `mergeSettings(initial, load())`. Called once at
  state init for the empty boot scene.
- `scheduleSave()` → debounced (~300 ms) `pickSettings(getState())` → localStorage.
- `applyToScene()` → push the live settings slices to the engine
  (`SceneManager.applyRenderSettings` + `setGrid` + display overlays +
  `rebuildBed` + `setGizmoSpace`, `Selection.setPivotMode`). Extracted from the
  inline boot block in `main.ts` and reused after every reset.
- `resetSection(key)` → write that section's factory fields (from the config
  file) into state, `applyToScene()`, `scheduleSave()`, dispatch
  `SETTINGS_RESET`.
- `resetAll()` → all settings slices to factory, clear `mx-settings-v1`,
  `applyToScene()`, dispatch `SETTINGS_RESET`. Leaves workspace/widths/
  section-collapse localStorage keys untouched.

`SECTIONS` map (sectionKey → factory field group):
`grid`, `render.look`, `render.env`, `render.camera`, `renderOut`, `print`.

### Persistence trigger (user edits only)

Settings writes go through many handlers and through `SceneManager` methods that
ALSO run on boot/load — so we trigger `scheduleSave()` on **user interaction**,
not programmatic applies:

- One capturing `change`/`input` listener on the stable `#rp-scene-body` and
  `#rp-print-body` containers → `SettingsStore.scheduleSave()`. (Over-firing on
  a non-settings click is harmless — the save is debounced + idempotent.)
- `SettingsStore.scheduleSave` also subscribes to `GIZMO_CHANGED` and
  `PIVOT_MODE_CHANGED` (existing events).

Loading a `.mixo` calls `SceneManager.applyRenderSettings` etc. directly (not
through these listeners), so File-wins holds: a load never rewrites the
per-user defaults.

### New events (`events.js`)

- `SETTINGS_RESET: 'settings:reset'` — panels (`ScenePanel`, `PrintPanel`)
  subscribe → `_render()` to reflect restored values.

### UI

- **Per-section reset:** small `↺` button in each settings section header.
  - `ScenePanel._section(key,…)` header gains `data-reset-sec="${key}"` for
    grid / environment / camera / rendering. Cross-Section is session-only → no
    button. Click handler calls `SettingsStore.resetSection`; **must
    `stopPropagation`** (header also toggles collapse).
  - `PrintPanel` Scale / Bed / Export tab bodies gain a `↺ Reset` button →
    `resetSection('print')` (one print slice).
- **Top-bar reset-all:** `ProjectMenu` `.pm-bar` gains
  `data-act="reset-settings"` (`↺` icon, tooltip "Reset all settings to
  defaults") → `SettingsStore.resetAll()` + success toast. No confirm modal
  (cheap, re-editable).
- **Logo:** inline the SVG into `#header` (index.html) before `#project-name`,
  `id="app-logo"`. Replace hardcoded `fill:#fff` with `currentColor` so it
  themes; CSS `#app-logo svg { height: 26px; width: auto; }`, pinned far-left.

### Boot order (`main.ts`)

`SettingsStore.seedBootState` must run before panels render and before the
existing `applyRenderSettings`/overlay block. The block at the end of
`bootstrap()` is replaced by `SettingsStore.applyToScene()`. `SettingsStore`
listeners attach after the panels init.

`PersistenceManager.newProject()` re-seeds from per-user defaults (New uses your
preferred setup, not factory); `open()`/`load()` do NOT seed (File wins).

## Testing

- **Unit (`tests/settings-store.test.mjs`):** `pickSettings` drops content
  slices (objects/shaders/etc.) + `renderOut.pose`; `mergeSettings` overlays
  persisted onto factory and rejects unknown paths; `parseStored` round-trip +
  bad-blob tolerance; `resetSection` restores one slice from the config file and
  leaves others; schema defaults equal `default-settings.json`.
- **Browser smoke:** edit a setting (e.g. exposure) → `scheduleSave` writes
  localStorage; a section `↺` restores factory; reset-all clears the key +
  restores; `#app-logo svg` present in the header.

## Out of scope

Slicing/print-prep (printer's job). Persisting inspection modes, live camera
pose, section plane, cursor. Workspace/layout reset (handled separately).
