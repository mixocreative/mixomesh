# PHASE HANDOFF — pickup prompt for the next clear session

## What just closed: Phase 4 + cross-phase UX/polish batch

Phase 4 (Shader System) is done and was previously verified. On top of it
this batch closed and is **demonstrably working in Chrome** (verified live
via DevTools against the running app):

- **Import dedupe** — identical shader/texture (content + settings + size)
  is silently shared on import, no merge prompt. `ShaderLibrary._findContentDuplicate`,
  `AssetLoader._findImportedTextureBySignature`.
- **Working-ratio rescale** — changing working ratio rescales every scene
  object about the origin and re-normalizes scale to 1 (`RescaleWorldCommand`,
  undoable). Working/Target ratio accept M:N (larger *or* smaller), not just 1:N.
- **Apply Rotation / Apply Scale** in Properties — bakes into vertices and
  normalizes transform to 0,0,0 / 1,1,1 (`BakeTransformCommand`, vertex
  snapshot undo). Scale-lock toggle (default ON) = proportional XYZ;
  viewport scale gizmo is uniform by default.
- **Collections** — every imported file mints one display-only outliner
  bucket (`state.scene.collections`, `SceneObject.collectionId`). Real
  groups are unaffected; a group mixing collections renders at the outliner
  root with a `[Mixed]` badge. RMB → Select Members / Rename / Delete.
- **Floating viewport toolbar** (Fusion-360 style) — Group A move/rotate/scale,
  Group B pivot (active/median/cursor/world), orientation local/world,
  Group C camera free/follow-active/world-origin. `ui/ViewportToolbar.js`.
- **Nav Cube** (`ui/NavCube.js`) — top-left orientation widget. Click face →
  ortho preset (fit to scene bbox); drag → orbit; Home → perspective.
  Camera sync (locked, see memory note): `rotateX(β − π/2) rotateY(π/2 − α)`.
  Face→preset map in `SceneManager.setCameraPreset` uses the same
  front-relative convention (LEFT = camera +X / α=0, RIGHT = camera −X / α=π).
- **Bed FRONT tag** — single flat tag hugging the +Z bed edge, grid-line
  colour, readable from the default camera (`rotation = (π/2, π, 0)`).
  Replaces the old four billboarded amber tags.
- Camera defaults: front-3/4 elevated (α=π/3, β=π/4, r≈0.4243 ≈ 30 cm high);
  first dropped asset auto-frames the scene.

All of the above is reflected in `BLUEPRINT.md` (§0.3/0.5, Part 4 state,
Part 5 commands, Part 7 SceneManager + camera convention, Part 8 SceneObject/
Collection schema, Part 10 dedupe, Part 12 PrintManager, Part 13 Outliner /
Properties / ViewportToolbar / NavCube, Part 15 adjustments batch).

## Deferred / accepted scope cuts

- Full **Phase 5** milestone (export → Bambu Studio) is **not** verified yet —
  `core/PrintManager.js` + `ui/PrintPanel.js` exist as scaffolding only.
- Nav cube does **not** snap to corner/edge isometric views — face clicks only.
- Camera follow-active / world-origin modes wired but lightly tested.

## Locked design decisions (memory notes)

- `[[navcube_camera_convention]]` — NavCube CSS sync formula + front-relative
  LEFT/RIGHT convention, derived empirically via Chrome DevTools.
- `[[phase4_design_decisions]]`, `[[phase3_design_decisions]]`,
  `[[scale_ratio_model]]`, `[[ui_accent_palette]]`, `[[scene_default_scale]]`,
  `[[backlog_copy_from_active]]`.

---

## NEXT: Phase 5 — Print Pipeline

**BLUEPRINT §15 deliverables:**
`PrintManager` · `PrintPanel` · pre-export validation gate · bed preview
overlay · OBJ+MTL via `BABYLON.OBJExport`.

**Milestone (verbatim):**
> Set 1:35, see live dimensions, export ZIP, open in Bambu Studio with
> colors intact.

Key API surface (BLUEPRINT §12):
```
PrintManager.setWorkingRatio(num) / setTargetRatio(num)
PrintManager.getExportedDimensions(meshId) → {x,y,z} mm at targetRatio
PrintManager.exportOBJ(options) → Promise<void>   // triggers ZIP download
PrintManager.exportSTL(options) → Promise<void>
```
`PrintPartCommand` (Part 5) toggles `isPrintPart`/`partLabel`/`partTolerance`.
OBJ+MTL is the primary colored-print format (CLAUDE.md rule 6). Add the
Babylon loaders/serializers `<script defer>` only when this phase needs it
(BLUEPRINT line 34).

---

### STEP 0 — verify the previous work still runs (do this first)

1. `npx http-server -p 5500 -c-1`, open Chrome at http://localhost:5500.
2. DevTools console must be clean (no errors — CLAUDE.md dev rule).
3. Drop a multi-mesh GLB: outliner shows a collection bucket; scene
   auto-frames; nav cube tracks orbit and every face label is upright;
   click each nav-cube face → camera snaps to the matching side
   (LEFT click → you view from +X). Bed shows a flat readable `FRONT`
   tag at the front edge.
4. Change Working Ratio → all objects rescale in place, scale stays 1.
   Properties → Apply Rotation/Scale bakes and zeroes the transform.
   Undo (`Ctrl+Z`) reverses each.
5. If anything above fails, fix it before starting Phase 5.

### STEP 1 — build Phase 5

Re-read **BLUEPRINT §12 (PrintManager)** and **§13 (PrintPanel)** before
writing code. Then implement, in order:
1. `core/PrintManager.js` — ratio math, `getExportedDimensions`,
   `exportOBJ` (OBJ+MTL in a JSZip), `exportSTL`. Babylon-first:
   use `BABYLON.OBJExport` / serializers, not hand-rolled writers.
2. Pre-export validation gate (reuse `MeshValidator`; block on hard errors,
   warn on soft).
3. `ui/PrintPanel.js` — wire Scale/Validation/Preview/Export tabs to
   PrintManager; live exported-dimension readout at `targetRatio`.
4. Bed preview overlay (bed volume box at `state.print.bedDimensions`,
   toggled by `overlays.printPreview`).
5. `PrintPartCommand` + Properties "print part" section.

Demonstrate the milestone in Chrome, then run the CLAUDE.md
"Phase handoff" procedure (flip Phase 5 → `[x]`, rewrite this file).
