# Per-Object Scale Ratio — Design Spec

**Date:** 2026-06-16
**Status:** IMPLEMENTED 2026-06-16. See BUILDLOG "Per-object scale ratio" entries
+ memory `per-object-ratio-redesign`. Notes below are the original design; the
AS-BUILT corrections (marked inline in §3.6 and §4) are:
- Export reference = the **active printable object's ratio**, falling back to
  the first printable unit when the active object is excluded; **default =
  "as shown"** (empty target list ⇒ print displayed size). The brief
  "scene-relative 1000/T" idea was reverted — it dropped the object ratio.
- **Batch export** done (one file per target in the list).
- **Legacy fully removed** (`workingRatio`/`targetRatio` only read in migration;
  `RescaleWorldCommand` deleted; `SCENE_PROTECTED` emptied).
- **Restore re-bakes** the import normalization (the original "no rebake" claim
  was a real bug, fixed + guarded).
**Supersedes:** the global `workingRatio` model in `Blueprint.md` §8 *Import Scale
Model* and §12 *Scale Math*, and memory `scale_ratio_model.md`.

---

## 1. Problem

Today the scene has **one global** `workingRatio` (`state.print.workingRatio`).
Every object is normalized to it; you cannot hold two objects at different
scales in one scene. Hobbyist kitbashing mixes source models authored at
different scales (a 1:1 prop next to a 1:72 vehicle) into one print. The global
ratio forces them all to the same scale and the "scene scale" knob is a poor fit
for that workflow.

## 2. Goal

Make scale **per-object**:

- Each object remembers its own ratio, persisted in `.mixo`, never lost.
- On import, the object adopts the ratio its file suggests (glTF `extras.ratio`).
- Changing an object's ratio **live-resizes it in the scene**.
- Export converts each object from its ratio to a chosen **target** ratio.
- Export targets are a **list** → batch, one output per target.
- Multi-object export stays visually consistent ("as is"), anchored on the
  active object.

## 3. The model (locked)

### 3.1 Two numbers per object

| Number | Scope | Role | Default / seed | Mutable? |
|---|---|---|---|---|
| `modelRatio` | per-asset (`AssetEntry`) | **authoring anchor** — what scale the file's geometry was authored at; normalizes file→real | glTF `extras.ratio`, else `1` | no (set at import) |
| `ratio` (objectRatio) | **per-object** (`state.scene.objects[id]`) | **display + print scale** — what scale the object currently *is* in the scene | seeded `= modelRatio` on import | yes (dropdown) |

This is the key reframe: the per-object `ratio` is the old global
`workingRatio`, promoted to object scope. `modelRatio` is unchanged.

### 3.2 Import (formula unchanged, R now per-object)

```
importFactor(obj) = SOURCE_UNIT_FACTORS[sourceUnit] × (modelRatio / ratio)
```

Seeded with `ratio = modelRatio`, the ratio term cancels → the object enters at
its authored size (a 1:72-authored file shows at its 1:72 size). Baked into
vertices exactly as today (`ImportNormalizer.bakeImportTransform`); every mesh
still ends `parent=null, rot=0, scale=1`.

"The file suggests the ratio" = `extras.ratio` seeds **both** `modelRatio` and
the initial `ratio`. STL/OBJ (no extras) → both `1`.

### 3.3 Scene display

Object shows at `real / ratio`, where `real = fileSize × modelRatio`. Bigger
denominator → smaller object. So a 1:1 object shows large, a 1:72 object small —
their on-screen size difference *is* their ratio difference. This is why mixed
ratios look correct in the viewport without extra work.

### 3.4 Changing an object's ratio (live resize)

Dropdown change `R_old → R_new` rescales the selected object(s) by
`R_old / R_new`, baked into vertices, and updates the stored `ratio`. This is
`RescaleWorldCommand`'s exact math **scoped to a selection** — new
`RescaleObjectCommand`, one undoable step.

The stored `ratio` number is the anchor that lets export read R even though R is
also baked into the displayed geometry. (Resolves the apparent "ratio is baked
in vs export reads ratio" conflict: it is *both* — baked into pixels, kept as a
number in state.)

### 3.5 Hand scale

Hand scaling bakes into geometry and rides along with every ratio rescale and
the export factor — it is preserved inside the object's ratio frame.

### 3.6 Export  *(AS-BUILT: reference = the active PRINT UNIT's ratio)*

```
exportFactor(T) = (referenceRatio / T) × 1000     // BU(m) → mm at target T
```

`referenceRatio = _exportReferenceRatio(printUnits, state)` — the **active
object's ratio if it's in the export set, else the first printable unit's
ratio**. It is threaded as `ctx.referenceRatio` through `exportFactorFor(ctx)`
and `exportBaseName(ctx)`/`perMeshBaseName(ctx)` so the factor AND the filename
use the same reference across the whole batch.

- **"As shown" (DEFAULT):** when `print.exportRatios` is empty, the target =
  `_exportReferenceRatio(printUnits, state)` ⇒ factor `1000` ⇒ prints **exactly
  the size on screen** (each object at its own displayed scale). No footgun where
  a 1:72 object prints at real size.
- **A target `T`** rescales relative to the reference: 1:144 on a 1:72 reference
  ⇒ `72/144` = 0.5×.
- Targets are a **list** of absolute ratios (`print.exportRatios`); each produces
  one output file. Filename suffix `_r{referenceRatio}to{T}`.
- The as-shown target, factor reference, filename suffix, Print panel preview,
  and dimension helper all use `_exportReferenceRatio`; excluded helpers cannot
  skew the exported scale.
- **Single object** → `(referenceRatio / T) × 1000`.
- **Same-ratio selection** → all share `ratio`; uniform `(ratio / T)` about the
  **active printable object's origin**, then `×1000` BU→mm.
- **Mixed-ratio selection, exported as one** → **uniform** scale by the
  **active printable object's** `(R_active / T)`, about that origin, then
  `×1000` BU→mm.
  Because the factor is uniform, on-screen relative sizes and positions are
  preserved exactly ("as is"). Non-active objects' own `ratio` is **not** used
  for this combined factor — they were already displayed at their own size in
  the scene, and the uniform factor keeps that relationship. (User-confirmed.)

The bake still happens only at the `PrintManager.flattenWorld` PREP seam; only
the **source of the factor** changes (per-object `ratio` + target list instead
of global working/target).

### 3.7 Worked example

Car authored+set 1:1, tank set 1:72. Scene shows car large, tank small (their
ratio difference). Export both *as one* at target 1:144, active = tank:
uniform factor `(72 / 144) × 1000 = 500`. Whole group ×0.5 about tank origin.
Looks identical to the scene, half size. Car stays proportionally larger because
it already was on screen.

Tank alone at target 1:35: `(72 / 35) × 1000 ≈ 2057` → ~2.06× its scene size.

## 4. Migration + restore (`.mixo`)  *(AS-BUILT — corrected)*

The original spec assumed restore reused the live baked geometry ("no rebake
needed"). **That was wrong:** `restoreContainer` reloads the RAW source bytes
and the import/ratio bake lives in vertices (`scaling=1`), so the saved node
transform never carried it — a verified round-trip showed restored meshes at raw
file size (import scale AND ratio both lost). As-built:

1. For each object: `ratio = o.ratio` (new saves) or `state.print.workingRatio`
   (migrated pre-redesign saves).
2. **`restoreContainer` re-runs the SAME `bakeImportTransform` as a fresh import**
   (unit + glTF RH→LH flip + winding, baked into vertices) at the modelRatio
   seed, and **`_loadProject` bakes the per-object ratio DELTA** (`modelRatio /
   ratio`). Restore is byte-identical to a fresh import + the saved placement.
   Guarded by two browser-smoke round-trips: STL (ratio size survives) + a
   minimal asymmetric glTF (restored AABB == fresh import AABB ⇒ the flip
   survives).
3. `exportRatios = [state.print.targetRatio]` for migrated saves; new default is
   empty (= "as shown").
4. Drop `state.print.workingRatio` / `targetRatio` (only read here, in migration).

## 5. UI

- **Properties ▸ Layout/Transform:** per-object **ratio dropdown** (presets from
  `SCALE_PRESETS` + free-form input), drives `RescaleObjectCommand`. Multi-select
  same ratio shows the shared value; mixed shows `—`; picking a value applies to
  all (each rescaled by its own `old/new`) as one undo step.
- **Print panel ▸ Scale tab:** the global **Scene Scale** field is **removed**.
  The single **Print Scale** field becomes an editable **list** ("add ratio"
  from the preset dropdown); each entry is one export target.

## 6. Removals

- Delete `MeshValidator._checkExceedsBed` (`MeshValidator.js:119`), the
  `exceedsBed` result type, and its `invalidateAll` trigger. Bed/grid/camera
  **visuals** stay (cosmetic); only the fit-check dies. (User: remove bed
  validation.)
- Remove `state.print.workingRatio` everywhere (see §7 audit F).

## 7. Audit findings — must be honored

| # | Finding | Severity | Required fix |
|---|---|---|---|
| A | Per-object `ratio` = `workingRatio` promoted to object scope; `modelRatio` unchanged. Import formula identical. | (reframed, not a rewrite) | Move `ratio` onto `state.scene.objects[id]`; seed `= modelRatio` at import. |
| B | Old geometry baked at `modelRatio/workingRatio`. | trivial | Migration copies global `workingRatio` → each object `ratio`; no rebake. |
| C | `AssetLoader.js:490` dup uses `Mesh.clone`, which **shares the Babylon `Geometry`**. Per-object `bakeTransformIntoVertices` would corrupt every instance sharing the buffer. (Hidden today because `RescaleWorldCommand` bakes all meshes uniformly.) | data-corruption | Call `makeGeometryUnique` on each instance before any scoped bake. Verify dup path. |
| D | Scoped rescale must not scale **shared-ancestor** positions (would move siblings through a shared group/collection parent). | real | `RescaleObjectCommand` touches only the object's own geometry + own local position; never walks into shared ancestors. |
| E | **Logical objects / collections** (recent "preserve logical blender objects"): ratio must apply at the **selectable-object** granularity, pivot at its origin — not per-mesh, or a multi-mesh logical object tears apart. | real | Ratio + rescale operate on the logical object as one unit. |
| F | `workingRatio` removal is wide: ~12 source files + `config/default-settings.json` + `SettingsStore`. Stale read → `undefined` → NaN factor → zero-size meshes. | thoroughness | Audit all; `_positiveOrOne` guards; old settings/saves ignore dead field. |
| G | Only `_checkExceedsBed` + `exceedsBed` + its invalidate die; bed visual/grid/camera stay. | scoping | Surgical delete. |
| H | Incremental `R_old/R_new` bakes accumulate float epsilon over many edits. | minor | Acceptable (matches existing `RescaleWorld` reasoning); no baseline-store (YAGNI). |
| I | Export pivot when no active / active not printable. | minor | Fallback: selection bbox center + first-selected object's `ratio`. |

## 8. File touch-list (for the implementation plan)

- `src/core/scale/ScaleMath.js` — `sceneScaleFromState` → per-object source;
  `computePrintExportScale` reads object `ratio`; `computeSceneScaleRebakeFactor`
  reused for per-object change.
- `src/core/ImportNormalizer.js` — `importScaleFactor` reads per-object `ratio`
  (seeded `= modelRatio`); `computeImportSceneNormalizationScale` accordingly.
- `src/core/commands/ScaleCommands.js` — add `RescaleObjectCommand` (scoped
  rescale, findings C/D/E); keep `SourceUnitCommand`.
- `src/core/AssetLoader.js` — seed per-object `ratio` at import (`:304`, `:340`,
  `:421`); `makeGeometryUnique` on dup (`:490`, finding C).
- `src/core/print/PrintScale.js` / `ExportPlanner.js` — `exportFactor` per object
  + target **list**; `scaleFilenameSuffix` uses active object's target T.
- `src/core/PrintManager.js` — `flattenWorld` factor source = per-object `ratio`
  (uniform active factor for mixed groups, §3.6).
- `src/core/MeshValidator.js` — delete `_checkExceedsBed` + `exceedsBed` (`:119`,
  `:335`) + bed invalidate (`:204`, `:266`).
- `src/ui/PropertiesPanel.js` — ratio dropdown in transform section.
- `src/ui/PrintPanel.js` — remove Scene Scale field; Print Scale → target list.
- `src/core/PersistenceManager.js` — `.mixo` migration (§4); persist object
  `ratio` + `exportRatios`.
- `src/core/StateManager.js` — state shape: object `ratio`, `print.exportRatios`;
  drop `print.workingRatio` / `print.targetRatio`.
- `src/core/SettingsStore.js` + `config/default-settings.json` — drop
  `workingRatio` defaults; `SCENE_PROTECTED` review.
- `src/core/ThreeMFLoader.js` — keep axis/unit mirror; no ratio recovery
  (export-only ratio, user-confirmed).
- i18n keys for the new dropdown/list labels.

## 9. Flow summary (for future refinement)

```
glTF extras.ratio ─┬─► modelRatio (asset, fixed authoring anchor)
                   └─► ratio      (object, seeded = modelRatio, mutable)

IMPORT   : bake  unit × modelRatio / ratio   into vertices   (ratio==modelRatio ⇒ file as authored)
DISPLAY  : object shown at  real / ratio      (real = file × modelRatio)
EDIT     : ratio R_old→R_new ⇒ rescale ×(R_old/R_new), bake, store ratio   [RescaleObjectCommand]
EXPORT   : per object  ×(ratio / T) × 1000
           mixed group ⇒ uniform ×(R_active / T) × 1000 about active origin  (WYSIWYG)
           targets = list ⇒ one output file per T;  filename suffix = active's T
PERSIST  : object.ratio + print.exportRatios in .mixo;  migrate old global workingRatio→per-object
```

Invariants to preserve when refining:
- Scale math lives only in the two seams (import = `ImportNormalizer`, export =
  `PrintManager.flattenWorld`). Do not scatter unit/ratio math elsewhere.
- A scoped rescale must never mutate geometry shared with another instance
  (finding C) nor positions of ancestors shared with siblings (finding D).
- Ratio operates at selectable-object granularity (finding E).
