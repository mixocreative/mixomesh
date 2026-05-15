# PHASE HANDOFF — pickup prompt for the next clear session

## What just closed: Phase 5 — Print Pipeline ✓ (2026-05-15)

Milestone **verified live in Chrome**: set Target Ratio 1:35, live exported
dimensions update, Export OBJ+MTL → ZIP downloads, opens in Bambu Studio with
colors intact.

Phase 5 surface (all working):
- **PrintManager** (`core/PrintManager.js`) — `SCALE_PRESETS`, `getExportedDimensions`,
  `exportOBJ` (OBJ+MTL+textures in a JSZip via `BABYLON.OBJExport`), `exportSTL`
  (`BABYLON.STLExport`). Export factor = `(workingRatio/targetRatio)*1000`.
- **PrintPanel** (`ui/PrintPanel.js`) — tabs Scale / Validation / **Bed** / Preview /
  Export. Ratio inputs accept any positive `M:N` (stored `N/M`). Pre-export
  validation gate: errors block (modal), warnings confirm.
- **Bed tab + presets** — default **Elegoo Saturn 4 Ultra** (218.88×122.88×220 mm);
  Bambu P1S/X1C/A1/mini, Prusa, Ender, Generic, Custom. X/Y/Z inputs +
  "Show bed volume" overlay (`overlays.bedPreview`, `SceneManager.setOverlay`).
- **Scene floor = printer bed XY** — `state.scene.gridSize` REMOVED. Floor
  footprint tracks `state.print.bedDimensions` (rectangular). New
  `state.scene.grid {cellMM,subdivisions}` = grid-line styling only.
  `SceneManager.rebuildBed()` (Print▸Bed) / `setGrid()` (Properties▸Scene)
  replace `setGridSize()`.
- **Camera mouse remap (CAD, all modes)** — Babylon pointer orbit/pan
  disabled (`buttons:[]`); custom `_onCameraPointer`: **RMB=orbit, MMB=pan,
  Shift+MMB=orbit, wheel=zoom, LMB=select/gizmo**. (Babylon hard-forces RMB
  as its pan button, so RMB-orbit had to be hand-rolled.)
- `PrintPartCommand`, `BakeTransformCommand`, `RescaleWorldCommand` in
  `core/HistoryManager.js`. Properties Print-Part section + Outliner printer
  toggle column.

## Deferred / accepted scope cuts

- Nav cube: face clicks only, no corner/edge isometric snaps.
- Camera follow modes (followActive/worldOrigin) lightly tested.
- **Old v3.1 saves**: scalar `scene.gridSize` is ignored on load — footprint
  still correct (from bed), grid styling falls back to 10 mm / 10 subdiv.
  **Phase 6 PersistenceManager must not re-emit `gridSize`; persist
  `scene.grid` + `print.bedDimensions/bedPreset` instead, and migrate old files.**

## Locked design decisions (memory notes)

- `[[scene-grid-bed-camera]]` — floor = printer bed XY; `scene.grid` is
  styling only; Saturn 4 Ultra default; RMB/MMB/Shift+MMB camera map.
- `[[scale_ratio_model]]`, `[[navcube_camera_convention]]`,
  `[[phase4_design_decisions]]`, `[[phase3_design_decisions]]`,
  `[[ui_accent_palette]]`, `[[scene_default_scale]]`,
  `[[backlog_copy_from_active]]`.

All reflected in `BLUEPRINT.md` (§4 state, §7 SceneManager grid/camera,
§12 PrintManager, §13 PrintPanel/Properties, §15 Phase 5 close-out).

---

## NEXT: Phase 6 — Persistence & Polish

**BLUEPRINT §15 deliverables:**
Full `PersistenceManager` with autosave + recent projects · ghost/relink in
Outliner · Smart Replace · Transform Swab · camera state save/restore.

**Milestone (verbatim):**
> Save → close → reopen identically. Move asset file → reopen → ghost →
> relink → resolved.

Key spec: BLUEPRINT **§10 (PersistenceManager — full project schema v3.1,
load sequence, autosave, recent projects)** and §11 (asset relink / ghost).
`SmartReplaceCommand` / `TransformSwabCommand` are stubs in
`core/HistoryManager.js` — real bodies land this phase. Camera
save/restore: `SceneManager.saveCameraState`/`restoreCameraState` exist.

---

### STEP 0 — verify previous work still runs (do this first)

1. `npx http-server -p 5500 -c-1`, open Chrome at http://localhost:5500.
2. DevTools console clean (no errors — CLAUDE.md dev rule).
3. Drop a multi-mesh GLB: collection bucket in outliner; scene auto-frames;
   nav-cube tracks orbit, faces upright, face click snaps camera; floor is
   the rectangular Saturn bed with a flat readable `FRONT` tag.
4. Camera: **RMB drag = orbit, MMB drag = pan, Shift+MMB = orbit, wheel =
   zoom, LMB = select/gizmo**. No middle-click autoscroll.
5. Properties ▸ Scene: Grid cell + Subdivisions re-skin grid (footprint
   fixed). Print ▸ Bed: switch preset → floor resizes; Show bed volume box
   matches footprint. Export tab: 1:35 → ZIP exports.
6. Working Ratio change rescales in place (scale stays 1); Apply
   Rotation/Scale bakes & zeroes; `Ctrl+Z` reverses each.
7. If anything fails, fix before starting Phase 6.

### STEP 1 — build Phase 6

Re-read **BLUEPRINT §10 + §11** before writing code. Implement in order:
1. `core/PersistenceManager.js` — full v3.1 save/load (whole project state,
   shaders, UV overrides, collections, print, **scene.grid +
   print.bedDimensions**; do NOT emit `scene.gridSize`; migrate old files).
   Load sequence order per §10.
2. Autosave + recent-projects list.
3. Outliner ghost rows + Relink (file picker) — §11 / §13.
4. `SmartReplaceCommand` + `TransformSwabCommand` real bodies.
5. Camera state save/restore wired into project save/load.

Demonstrate the milestone in Chrome, then run the CLAUDE.md
"Phase handoff" procedure (flip Phase 6 → `[x]`, rewrite this file).
