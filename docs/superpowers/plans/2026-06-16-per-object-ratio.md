# Per-Object Scale Ratio — Implementation Plan

**Spec:** `docs/superpowers/specs/2026-06-16-per-object-ratio-design.md`
**Date:** 2026-06-16
**Status:** DONE (2026-06-16). All stages landed + two corrections beyond the
plan: export default is **"as shown"** (active object's ratio), and **restore
re-bakes** the import normalization (the planned "no rebake" migration was a bug
— see spec §4 AS-BUILT). Verified: 72 headless + i18n + typecheck + build +
browser smoke (incl. ratio round-trip) + export smoke. See BUILDLOG.

Ordered by dependency. Each step is independently testable; do not start a step
until the prior one's tests are green. TDD: write the failing test first where a
test column is given.

---

## Stage 0 — Safety net (finding C, do first)

The current code shares Babylon geometry across duplicated instances; per-object
baking is unsafe until that is fixed.

- **0.1** Add a headless test proving `AssetLoader` dup produces **independent
  geometry**: import an asset, duplicate it, bake a scale into the dup, assert
  the source's vertex bounds are unchanged.
- **0.2** Make it pass: call `makeGeometryUnique` (or equivalent) on each
  instance at `AssetLoader.js:490`. Verify the existing `RescaleWorldCommand`
  path still works (it bakes all meshes; uniqueness must not double-apply).

> If 0.1 already passes, document why (clone path already unique) and skip 0.2.

## Stage 1 — State shape + scale math

- **1.1** `StateManager.js`: add `ratio` to the object record default; add
  `print.exportRatios: [1]`. Keep reading old `print.workingRatio` /
  `print.targetRatio` only inside the migration shim (Stage 6).
- **1.2** `ScaleMath.js`: 
  - `objectScaleFromObject(obj)` → `{ ratio }` (per-object), replacing
    `sceneScaleFromState`'s global read.
  - `computeSceneNormalizationScale` unchanged signature, fed per-object ratio.
  - `computePrintExportScale(objectScale, printScale)` → `(ratio / T) × 1000`.
  - keep `computeSceneScaleRebakeFactor(prev, next)`.
  - Tests: factor table from spec §3.7 (1:72→1:144 = 500, 1:72→1:35 ≈ 2057).

## Stage 2 — Import seeds per-object ratio

- **2.1** `ImportNormalizer.importScaleFactor(sourceUnit, modelRatio, ratio)`
  reads the object's ratio; at fresh import `ratio = modelRatio` ⇒ unit-only
  factor (regression-test: a 1:72 file imports at its authored size).
- **2.2** `AssetLoader.js`: when registering an object, set object `ratio =
  modelRatio` (`:304/:340/:421` paths and the library-import path `:660`).
- **Test:** import glb with `extras.ratio="1/72"` → object.ratio === 72,
  asset.modelRatio === 72, in-scene bounds == authored.

## Stage 3 — RescaleObjectCommand (live resize, findings D/E)

- **3.1** New `RescaleObjectCommand(objectIds, prevRatioById, nextRatio)` in
  `ScaleCommands.js`. For each object: bake `Matrix.Scaling(prev/next)` into its
  **own** geometry, scale its **own** local position; never touch shared
  ancestors; operate at logical-object granularity. Update stored `ratio`. Undo
  = inverse per object.
- **Tests:** 
  - single object 1:72→1:144 halves its bounds, ratio stored 144.
  - two objects sharing a group: rescaling one leaves the other's bounds +
    position unchanged (finding D).
  - a multi-mesh logical object scales as one unit, no tearing (finding E).
  - undo restores bounds + ratio.

## Stage 4 — Export: per-object factor + target list + uniform-active group

- **4.1** `PrintScale.exportFactor` / `ExportPlanner`: factor per object from its
  `ratio`; iterate `exportRatios` as a batch (one plan per target T).
- **4.2** `PrintManager.flattenWorld`: mixed-ratio "export as one" uses uniform
  `(R_active / T) × 1000` about the active object's origin; fallback pivot =
  selection bbox center, fallback ratio = first selected (finding I).
- **4.3** `scaleFilenameSuffix` uses the active object's target T (one file per
  T). Update the locked filename contract note.
- **Tests:** 
  - mixed car(1:1)+tank(1:72) export-as-one @1:144 active=tank → uniform 0.5,
    relative sizes preserved.
  - target list `[72,144]` → two output files, suffixes reflect each T.

## Stage 5 — Remove bed validation (finding G)

- **5.1** Delete `_checkExceedsBed`, the `exceedsBed` result branch, and the
  `targetRatio`/`bedDimensions` `invalidateAll` triggers in `MeshValidator.js`.
  Leave bed/grid/camera visuals untouched.
- **Test:** validator returns no `exceedsBed`; topology checks still run.

## Stage 6 — Persistence + migration (finding B)

- **6.1** `PersistenceManager.js`: persist object `ratio` + `print.exportRatios`.
- **6.2** Migration shim: on load of a pre-redesign `.mixo`, set every object
  `ratio = workingRatio`, `exportRatios = [targetRatio]`, drop the globals. No
  rebake.
- **Test:** load a fixture old `.mixo` → object bounds byte-identical, ratios
  populated, globals absent.

## Stage 7 — UI

- **7.1** `PropertiesPanel.js`: ratio dropdown in the transform section (presets
  + custom), multi-select `—`, one undo step. Drives `RescaleObjectCommand`.
- **7.2** `PrintPanel.js`: remove Scene Scale field; Print Scale → editable
  target **list** with add/remove from preset dropdown.
- **7.3** i18n keys; `SettingsStore` + `default-settings.json` drop
  `workingRatio`; review `SCENE_PROTECTED`.
- **Verify live** (PROBE=1 + ui-screenshot.mjs per project rule): dropdown
  resizes object; print list batch-exports.

## Stage 8 — Wide audit (finding F) + docs

- **8.1** Grep all `workingRatio`/`targetRatio` reads; ensure none survive
  outside migration. NaN guards via `_positiveOrOne`.
- **8.2** Update `Blueprint.md` §8/§12 from "planned" to "shipped" once green;
  update memory `scale_ratio_model.md` + `import_export_seam_split.md`; add a
  BUILDLOG entry.

## Done criteria

- Headless suite green (existing + new tests above).
- `npm run test:export` smoke green.
- Live Chrome: import two different-ratio objects, resize via dropdown,
  batch-export to two targets, confirm sizes match the spec math.
- No `state.print.workingRatio` read anywhere but the migration shim.
