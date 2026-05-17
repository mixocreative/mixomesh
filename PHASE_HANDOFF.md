# PHASE HANDOFF

> ╔══════════════════════════════════════════════════════════════════╗
> ║  📋 COPY THE FENCED BLOCK BELOW INTO A NEW CLEAR CLAUDE SESSION.  ║
> ║  Everything UNDER the "── reference ──" line is detail Claude     ║
> ║  reads itself — you do NOT need to copy it.                       ║
> ╚══════════════════════════════════════════════════════════════════╝

```text
Pick up MIXOMESH Phase 6 from PHASE_HANDOFF.md.

Phase 6 (Persistence & Polish) is CODE COMPLETE but NOT verified in Chrome.
Read PHASE_HANDOFF.md in full, then:
  STEP 0 — verify Phase 5 still runs.
  STEP 1 — verify the Phase 6 milestone in Chrome (the actual goal).
  STEP 2 — only after STEP 1 passes, run the CLAUDE.md phase-handoff close-out.
Re-read BLUEPRINT §10 + §11 before touching persistence code.
Do NOT assume the code works — verify, and fix anything that fails.
I will run Chrome and report what I see; you debug from there.
```

────────────────────────────── reference ──────────────────────────────
*(below is for Claude to read — not part of the copy-paste prompt)*

## Status: Phase 6 — Persistence & Polish — CODE COMPLETE, NOT YET VERIFIED

Phase 6 is fully implemented + a refactor pass landed, but the **milestone has
not been demonstrated in Chrome yet**. This session's job is to VERIFY (and
fix anything that fails), THEN run the CLAUDE.md phase-handoff close-out.
Do **not** assume it works — the author could not run Chrome. Last phase
*verified* live is still Phase 5.

Milestone to prove (BLUEPRINT §15, verbatim):
> Save → close → reopen identically. Move asset file → reopen → ghost →
> relink → resolved.

## What was built this session

**Persistence (`core/PersistenceManager.js`, NEW ~600 lines)**
- v3.1 `.mixo` JSON. Embeds **every object mesh's bytes** (base64) + sha256 +
  originalPath + directoryHandleKey, so a project always reopens even with no
  database mounted. Per-object world transform `{p,q,s}` + containerMeshIndex,
  group transforms, camera + followMode, print/ui/gizmo/selection/shaders/
  uvOverrides/collections/swatches.
- **Hybrid open model** (`_resolveAssetBlob`, locked decision): live mounted
  path → content-hash scan of the mounted dir → embedded static copy → ghost.
  Matched-by-hash assets relink to the live file and keep project settings
  (shader/scale/transform/UV); unmatched ones load from the embedded copy and
  stay static/unlinked; the user is shown the unmatched list.
- `save/saveAs/open/newProject/getRecentProjects/openRecent/relinkAsset/
  startAutosave/recoverAutosave/init`. Autosave runs; `recoverAutosave` exists
  but is **deliberately NOT called on boot**.
- **Boot behavior (locked):** does NOT recover the last discarded session.
  Instead remembers the last mounted database folder (`last_mount_dir` kv) and
  prompts to auto-mount it (`AssetPanel.promptRemount` → `remountFolder` modal).

**UI:** `ui/ProjectMenu.js` (header New/Open/Save/SaveAs + Recent, modals
`dirtyConfirm`/`recoverAutosave`/`unmatchedAssets`), `ui/ProgressOverlay.js`
(full-screen darkened pointer-locked % overlay), Outliner ghost/unlinked rows
+ Relink/SmartReplace/TransformSwab context items. `main.js` Ctrl+S / Shift+S
/ O / N. Real `TransformSwabCommand` + `SmartReplaceCommand` in
`core/HistoryManager.js`.

**Export pipeline rebuilt + made non-destructive (`core/PrintManager.js`)**
- One orchestrator `_runExport(formatKey, options)`; `FORMATS` registry
  (per-type ordered `prep[]` + serializer); reusable named `PREP_STEPS`.
- **Scene never mutated:** clone → `clone.makeGeometryUnique()` *before any
  prep* (Babylon clones share geometry by ref), prep/weld/CSG hit the throwaway
  copy, disposed in `finally`. Re-export idempotent.
- `flattenWorld` bakes the full world matrix (groups/ancestors) + mm scale →
  fixes grouped parts exporting at group-local transform.
- **3MF export added** (`exportThreeMF`): hand-written OPC zip, one `<object>`
  per mesh, Materials-extension colour. Y-up→Z-up + winding flip; placement
  fully baked, every `<build><item>` carries an explicit identity transform so
  every slicer/viewer shows identical placement.
- Validation runs on the *fixed* clones — only errors that survive auto-fix
  block; CSG2 needs watertight input, non-watertight parts are skipped
  silently with one summarized info toast (slicer auto-repairs).

**Architecture refactor (locked decision — two clean seams)**
- `core/ImportNormalizer.js` (NEW) — THE import-normalization seam:
  `importScaleFactor` + `bakeImportTransform` + `SOURCE_UNIT_FACTORS`/
  `DEFAULT_SOURCE_UNIT`. One **unified** path, NOT branched by file extension
  (glTF RH→LH auto-detected via negative determinant; no-op for STL/OBJ; unit
  is per-asset not per-format). All future import settings go here.
- `core/PrintManager.js` — THE export seam, per-file-type prep, non-destructive.
- Killed the duplicated `SOURCE_UNIT_FACTORS` in `PropertiesPanel.js` (now
  imports it) and the dead `bakeTransform` PREP step.

**Headless test harness (`tests/`)** — Node `--test`, jszip stub via module
hooks, Babylon env stub. 34/34 green (30 export + 4 validator). Run:
`node --import ./tests/register-hooks.mjs --test tests/export.test.mjs tests/validator.test.mjs`

## Accepted scope cuts / known provisional items

- **3MF axis orientation + winding are single switches** (`Y_UP_TO_Z_UP`,
  `THREEMF_REVERSE_WINDING` at top of PrintManager export section). LH↔RH
  reasoning on paper is unreliable (same lesson as nav-cube) — **verify in a
  real slicer**; if the model lies down / is mirrored, flip the one switch.
- glTF-embedded textures are NOT restored on project load (solid-colour
  fallback). Texture2D / true textured-3MF deferred — use OBJ for image-
  textured parts.
- Old v3.1 saves: scalar `scene.gridSize` ignored on load (footprint from bed,
  grid styling falls back 10mm/10) — PersistenceManager does not re-emit it.

## Locked design decisions

- **Import/export seam split** (this session) — see Architecture refactor
  above; reflected in BLUEPRINT §0.3 file list, §0.5 size table, §15.
- **Hybrid asset persistence** (this session) — embed-all-bytes + mounted-dir
  content-hash match priority; boot re-mount prompt, no session recovery.
- `[[scene-grid-bed-camera]]`, `[[scale_ratio_model]]`,
  `[[navcube_camera_convention]]`, `[[phase4_design_decisions]]`,
  `[[phase3_design_decisions]]`, `[[ui_accent_palette]]`,
  `[[scene_default_scale]]`, `[[backlog_copy_from_active]]`,
  `[[phase5_close]]`.

All reflected in `BLUEPRINT.md` (§0.3/§0.5 layout, §10 Persistence, §11
relink, §12 PrintManager pipeline, §15 Phase 6 detail bullets).

---

### STEP 0 — verify Phase 5 still runs (do first)

1. `npx http-server -p 5500 -c-1`, open Chrome at http://localhost:5500.
2. DevTools console clean (CLAUDE.md rule — no errors, no "ignore warnings").
3. Drop a multi-mesh GLB: collection in outliner, scene auto-frames, nav-cube
   tracks orbit + face-click snaps, floor = rectangular Saturn bed.
4. Camera: RMB=orbit, MMB=pan, Shift+MMB=orbit, wheel=zoom, LMB=select/gizmo.
5. Properties▸Scene grid re-skin; Print▸Bed preset resize; Export 1:35 → ZIP.
6. Import a GLB → Properties shows **rotation 0 / scale 1,1,1** (import bake).

### STEP 1 — verify Phase 6 milestone (the actual goal)

Re-read BLUEPRINT **§10 + §11** first. Then prove, in Chrome:

1. **Save→reopen identical:** build a scene (multi-mesh, a group, a shader, a
   moved/scaled part, camera angle) → Save `.mixo` → New → Open → everything
   (transforms, group, shader, UV, camera, print/bed, selection) identical.
2. **Ghost→relink:** move/rename the source asset file → reopen → asset shows
   **ghost** in Outliner → Relink (file picker) → **resolved**, settings kept.
3. **Hybrid match:** with the database folder mounted, reopen → assets match
   by content hash to the live files (not the embedded copy); unmatched ones
   listed and load static/unlinked.
4. **Boot:** restart → it does NOT restore last session; it prompts to
   re-mount the last database folder.
5. **Export non-destructive:** export OBJ/STL/3MF → scene objects unchanged
   (positions/geometry intact, re-export gives same result). Open the **3MF**
   in a slicer (Bambu/Lychee) → parts in-place, upright, correct scale,
   colours per part. If lying down/mirrored → flip the one 3MF switch.
6. **Autosave/Smart Replace/Transform Swab** spot-check.

If anything fails, fix it before closing the phase.

### STEP 2 — close Phase 6 (only after STEP 1 passes in Chrome)

Run the CLAUDE.md "Phase handoff" procedure:
1. Flip Phase 6 → `[x]` in `CLAUDE.md`.
2. Add memory notes for the two locked decisions (import/export seam split;
   hybrid asset persistence) if not already noted; confirm the 3MF
   axis-switch outcome.
3. Rewrite this file for Phase 7 / project polish.
4. Commit only when the user asks.
