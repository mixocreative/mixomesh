# Print / Export Subsystem — Structural Restructure

**Date:** 2026-06-18 (post-landing hardening 2026-06-19, two rounds).
**Status:** SHIPPED 2026-06-18; hardened by max-effort code review 2026-06-19
(round 1 closed 13 of 15 review findings; round 2 closed the 3 outlying
"PLAUSIBLE" items; round 3 extracted shared `capturePrintPrefs` helper).
**Supersedes parts of:** `2026-06-16-per-object-ratio-design.md` (AS-BUILT corrections to
`PrintManager.js` / `PrintScale.js` / `PrintPrep.js` / `PrintPanel.js`).

### Post-landing changes (read before treating snippets below as canonical)

The §3 snippets describe the AS-DESIGNED shape. AS-BUILT additions from the
2026-06-19 hardening rounds (4 rounds, ending when review returned clean):

**Contract changes (consumer-visible):**
- `buildExportContext({state, units, target?, options?, csgReady?})` —
  `csgReady` is a build-time PARAMETER (default false). PrintPipeline awaits
  `_ensureCSG2()` ONCE per batch, before the target loop, then threads the
  boolean down. The frozen ctx never flips csgReady post-build.
- `ExportContext` adds `ctx.prefs` — a frozen snapshot of `state.print.*`
  preferences captured inside `buildExportContext` via private `_capturePrefs`.
  `ObjWriter` reads `ctx.prefs.objBakeSolidTextures` (not `ctx.options.*`).
  `ctx.options` stays purely the caller's per-call request bag, so a caller
  can't accidentally shadow a persisted pref by spreading their own options.
- `previewExportContext(options)` accepts `options.target` (explicit ratio
  override, `null` = "as shown") or `options.targetIndex` (Nth entry of the
  export-ratios list) for multi-target preview support. Default unchanged
  (first entry / as-shown).
- `previewExportContext` wraps its WHOLE body (collectPrintUnits +
  exportRatiosFromState + buildExportContext) in try/catch and returns `null`
  on throw — the Scale tab degrades to an empty-state placeholder rather
  than crashing on a malformed object.
- `getExportedDimensions(meshId, ctx?)` requires `ctx.state.scene` AND
  `ctx.factor` when ctx is supplied (TypeError otherwise). Without ctx,
  builds a preview ctx internally.
- `PrintPipeline._runExportForTarget` re-throws any `Error` whose message
  starts with `PrintPrep.` so the per-step try/catch around prep does NOT
  swallow PrintPrep's contract violations. Export clones are pushed to
  `clones[]` IMMEDIATELY after `makeGeometryUnique` (BEFORE the prep loop)
  so the finally{} dispose catches any clone whose prep threw — no leaks.

**Defensive throws (no silent fallback):**
- `_csgInitPromise` clears on rejection so a transient WASM-fetch failure no
  longer permanently disables CSG2 for the page lifetime.
- `_validateExportMeshes` records validator throws as hard errors so broken
  validation blocks export instead of passing it.
- `_referencePivot` throws on missing world translation (no silent
  Vector3.Zero() fallback).
- `_safeAlpha01(null)` returns 1 (opaque), not 0 (transparent — Number(null)
  is finite, so the original isFinite guard let null through to 0).
- `PrintNaming.exportBaseName/perMeshBaseName` `_requireCtx` — symmetric
  strict-field contract with `PrintPrep.flattenWorld`.
- `PrintPrep.flattenWorld` throws on null world matrix (no silent return).

**Architectural rules tightened:**
- `ctx.options`, `ctx.pivot`, and `ctx.prefs` are deep-frozen (pivot is a
  plain `{x,y,z}` to avoid freezing Babylon's Vector3 internals).
- `BU_TO_MM` is re-exported through the `PrintManager` façade so tests do
  not reach across into `ExportContext.js`.
- Parity test walks BOTH directions — adding a method to the API without
  the destructured re-export now fails the test.
- `_objMaterialName` uses `??` not `||` — a falsy mat.id (0, '') no longer
  cascades to mesh.name and misaligns OBJ `usemtl`.

**UX:**
- `PrintPanel` Scale tab shows an em-dash + `print.noPrintParts` placeholder
  when no printable parts exist (no more `0.00 mm/BU` + fake "as shown · 1:1"
  pill).

The §3 design snippets below remain canonical for INTENT; check the source
files for the AS-BUILT details listed above.

## 1. Why this exists

A code review of the per-object-ratio WIP turned up **7 bugs** in the print/export
chain:

| # | Severity | Symptom |
|---|---|---|
| 1 | 🔴 crash | `PrintManager.getExportReference()` returns `undefined` → TypeError on every Scale-tab render. The named export is not in the `PrintManager` namespace object. |
| 2 | 🟡 silent-wrong | `getExportedDimensions` preview picks `exportRatios[0]` only; second target reads wrong size with no indication. |
| 3 | 🟡 drift | `ctx.ratioFactor = ctx.factor / BU_TO_MM` assumes `PrintScale`'s `BU→mm` constant is 1000. The constant is duplicated in three files. |
| 4 | 🟡 drift | `PrintScale.exportFactor` / `getExportedDimensions` / `scaleSummary` are now dead — `PrintManager` defines rivals. Two source-of-truth candidates coexist. |
| 5 | 🟡 silent-wrong | `PrintPrep.flattenWorld` falls back to **world-origin scaling** when `ctx.pivot` is missing; baked geometry ends up in a wrong world position with no error. |
| 6 | 🟡 drift | `PrintPanel.js` imports `computePrintExportScale` directly from `ScaleMath` AND `getExportReference`/`getExportedDimensions` from `PrintManager` — reaches across three layers. |
| 7 | 🟡 silent-drop | `getExportedDimensions(meshId, options)` accepts an untyped `options` bag and silently ignores every field except `selectedOnly`. |

Fixing each one in isolation is one-line work. **That misses the point** — the
class of bug recurs because the *shape* of the subsystem invites it. This spec
restructures the subsystem so the bugs cannot exist by construction.

## 2. Root cause: 5 structural problems

### 2.1 Three competing "export factor" sources of truth

- `ScaleMath.computePrintExportScale(sceneScale, printScale)` — pure math (the
  actual primitive).
- `PrintScale.exportFactor()` / `exportFactorFor(ctx)` — adapter that reads
  `getState()` and a mutable module-level `_targetOverride`.
- `PrintManager._exportFactorForReference(state, refRatio)` — re-reads
  `getState()` + `exportRatiosFromState` independently.

Same math, three call paths, no shared contract. New consumers (PrintPanel)
picked whichever was closest and bypassed the adapter layer.

### 2.2 Mutable module state (`_targetOverride`) couples the target loop to filename helpers via a side channel

```js
let _targetOverride = null;
export function setExportTargetOverride(ratio) { _targetOverride = ratio; }
function currentPrintScale(state) {
  return { printRatio: _targetOverride ?? resolveExportTargets(state)[0] };
}
```

`_runExport` sets/clears the global between targets. Every filename helper
reads it indirectly. A preview render that happens to fire mid-export reads a
stale value. Concurrent export passes would race. The global exists because
filename helpers were retrofitted with target-awareness late and there were
many call sites — the global was the path of least resistance, not the right
shape.

### 2.3 `ctx` is a typeless grab-bag

```js
const ctx = {
  state, referenceUnit, referenceRatio, options,
  projectName, individually, pivot,
  meshes: [], units: [], csgReady: false, csgSkipped: [],
};
ctx.factor = _exportFactorFor(ctx);
ctx.ratioFactor = ctx.factor / BU_TO_MM;
ctx.unitFactor = BU_TO_MM;
```

Fields appended over time, no typedef, no `Object.freeze`. Consumers write
defensive code:

```js
const ratioFactor = _positive(ctx.ratioFactor, _positive(ctx.factor, BU_TO_MM) / BU_TO_MM);
const pivot = _validPivot(ctx.pivot);
const M = pivot ? newMath : oldMath;
```

Silent fallback chains — the consumer doesn't trust the producer. PrintPrep's
silent world-origin fallback (bug #5) is the same disease.

### 2.4 `PrintManager.js` is 682 lines doing five jobs

1. Mesh collection (logical units / printable filtering / parts ungrouping).
2. Reference unit + pivot computation.
3. **OBJ-specific MTL writer + solid-color PNG synthesis (~200 lines).**
4. Pre-export prep wiring (CSG, weld, normals).
5. Format orchestration (`_runExport`, `_runExportForTarget`).

The OBJ-shaped lump in §3 has nothing to do with the format-agnostic
orchestrator that hosts it. STL and 3MF have their writers split
(`ThreeMFWriter.js`); OBJ's was never moved.

### 2.5 `PrintPanel.js` reaches across three layers

```js
import { PrintManager } from '../core/PrintManager.js';                  // orchestrator
import { computePrintExportScale, /*...*/ } from '../core/scale/ScaleMath.js'; // pure math
```

When `PrintScale`'s adapter was insufficient, the panel skipped it and reached
the math primitive directly. Every math-semantics change → three update sites.

## 3. Proposed structure

```
src/core/print/
  ExportContext.js   ⟵ NEW. Defines the ExportContext typedef and ONE
                        builder. Owns the BU_TO_MM constant. Returns a
                        frozen object. No mutable globals anywhere.
  PrintNaming.js     ⟵ RENAMED from PrintScale.js. Filename helpers ONLY
                        (exportBaseName + perMeshBaseName; suffix appended
                        internally via ExportPlanner.scaleFilenameSuffix —
                        a standalone ratioSuffix accessor was carried over
                        from PrintScale but had no callers, dropped 2026-06-19).
                        Every helper takes a ctx argument — no getState()
                        reads, no module state.
  PrintPipeline.js   ⟵ NEW. _runExport, _runExportForTarget, mesh
                        collection, reference/pivot, CSG init, weld,
                        validation gate. Builds one ctx per target.
  ObjWriter.js       ⟵ NEW. _serializeOBJ + MTL writer + solid-PNG
                        synthesis. Format-specific code moves out of the
                        orchestrator.
  PrintPrep.js       ⟵ unchanged shape; ctx fields become REQUIRED.
                        flattenWorld throws on missing pivot/ratioFactor/
                        unitFactor. No silent fallback.
  PrintFormats.js    ⟵ unchanged.
  PrintPackaging.js  ⟵ unchanged.
  ExportPlanner.js   ⟵ unchanged. Pure filename math, consumed by
                        PrintNaming.
  ExportTextures.js  ⟵ unchanged.
  ThreeMFWriter.js   ⟵ unchanged.
  Download.js        ⟵ unchanged.
  PrinterProfiles.js ⟵ unchanged.

src/core/PrintManager.js  ⟵ shrinks to a FAÇADE. Re-exports the public
                             API. Single source array drives both named
                             exports and the `PrintManager` namespace
                             object — they cannot drift.

src/core/scale/
  ScaleMath.js       ⟵ unchanged. The ONE math primitive.

src/ui/PrintPanel.js ⟵ imports ONLY from PrintManager (+ ScaleMath for
                        UI-pure helpers: formatScaleRatio,
                        parseScaleRatioText, exportRatiosFromState). No
                        more cross-layer reach. Calls
                        PrintManager.previewExportContext() to get
                        factor/referenceRatio/targetRatio/referenceUnit.
```

### 3.1 The `ExportContext` type

```js
// ExportContext.js
import { objectRatio, exportRatiosFromState } from '../scale/ScaleMath.js';

export const BU_TO_MM = 1000;

/**
 * @typedef {Object} ExportContext
 * @property {Object} state              - StateManager snapshot at build time.
 * @property {Object} options            - { selectedOnly, individually, ... }
 * @property {Array}  units              - Logical print units (one per object).
 * @property {Object} referenceUnit      - Unit that anchors ratio + pivot
 *                                          (active printable, else first).
 * @property {number} referenceRatio     - Ratio of referenceUnit (positive).
 * @property {number} targetRatio        - Output ratio (positive). Defaults to
 *                                          referenceRatio when no explicit
 *                                          target → factor 1000 "as shown".
 * @property {{x:number,y:number,z:number}} pivot
 *                                       - World-space anchor for scaling.
 * @property {number} ratioFactor        - referenceRatio / targetRatio.
 * @property {number} unitFactor         - BU→mm (always BU_TO_MM).
 * @property {number} factor             - ratioFactor * unitFactor.
 * @property {string} projectName        - From state.project.name.
 * @property {boolean} individually      - Per-part output if true.
 * @property {boolean} csgReady          - Mutated by pipeline once set.
 * @property {string[]} csgSkipped       - Mutated by pipeline.
 * @property {Array} meshes              - Mutated by pipeline (clones).
 * @property {Array} cloneGroups         - Mutated by pipeline.
 */

export function buildExportContext({ state, units, target = null, options = {} }) {
  if (!units.length) throw new Error('buildExportContext: units required');
  const referenceUnit = _selectReference(units, state);
  const referenceRatio = objectRatio(referenceUnit.obj);
  const targetRatio = target ?? referenceRatio;
  const ratioFactor = referenceRatio / targetRatio;
  return Object.freeze({
    state, options, units,
    referenceUnit, referenceRatio, targetRatio,
    pivot: _pivot(referenceUnit),
    ratioFactor, unitFactor: BU_TO_MM,
    factor: ratioFactor * BU_TO_MM,
    projectName: state.project.name || 'Untitled',
    individually: !!options.individually,
    csgReady: false, csgSkipped: [],
    meshes: [], cloneGroups: [],
  });
}
```

**Mutability note:** the pipeline needs to fill `csgReady`, `csgSkipped`,
`meshes`, `cloneGroups` *after* the ctx is built but *before* the prep
steps run. Two options:

- **A** — Keep them as fields, freeze with `Object.freeze` shallow (arrays
  inside stay mutable; the field references can't be swapped). Simple.
- **B** — Split into `ImmutableExportContext` + `MutableExportRun` that
  references it. Cleaner separation but doubles the type surface.

**Decision: A.** Shallow freeze is enough discipline; consumers can read
fields safely, and array `.push` for clone collection is idiomatic.

### 3.2 Preview entry point

`PrintPanel` needs the same context shape but without running an export:

```js
// In PrintManager façade
export function previewExportContext(options = {}) {
  const state = getState();
  const units = collectPrintUnits(state, !!options.selectedOnly);
  if (!units.length) return null;
  const explicit = exportRatiosFromState(state);
  const target = explicit.length ? explicit[0] : null;
  return buildExportContext({ state, units, target, options });
}
```

`PrintPanel`:

```js
const preview = PrintManager.previewExportContext();
const factor = preview?.factor ?? 0;
const refRatio = preview?.referenceRatio ?? 1;
const targetRatio = preview?.targetRatio ?? refRatio;
const refId = preview?.referenceUnit.logicalId ?? null;
const dims = refId ? PrintManager.getExportedDimensions(refId, preview) : null;
```

`getExportedDimensions(meshId, ctx)` takes an optional `ctx`; if absent it
builds a fresh one. The signature documents the dependency.

### 3.3 PrintPrep gets strict

```js
flattenWorld(mesh, ctx) {
  if (!ctx?.pivot) throw new Error('PrintPrep.flattenWorld: ctx.pivot required');
  if (!(ctx.ratioFactor > 0)) throw new Error('PrintPrep.flattenWorld: ctx.ratioFactor required');
  if (!(ctx.unitFactor > 0))  throw new Error('PrintPrep.flattenWorld: ctx.unitFactor required');
  const W = mesh.getWorldMatrix?.();
  if (!W) return;
  const { pivot: p, ratioFactor: r, unitFactor: u } = ctx;
  const M = W
    .multiply(BABYLON.Matrix.Translation(-p.x, -p.y, -p.z))
    .multiply(BABYLON.Matrix.Scaling(r, r, r))
    .multiply(BABYLON.Matrix.Translation(p.x, p.y, p.z))
    .multiply(BABYLON.Matrix.Scaling(u, u, u));
  mesh.bakeTransformIntoVertices?.(M);
  // ... unchanged tail
}
```

`_positive`/`_validPivot` helpers gone. No fallback branch. Missing field =
loud error in dev, never silent wrong geometry in prod.

### 3.4 Façade with parity guarantee

```js
// PrintManager.js (the façade)
import * as Pipeline from './print/PrintPipeline.js';
import * as Naming from './print/PrintNaming.js';
import { previewExportContext, getExportedDimensions, getExportReference } from './print/ExportContext.js';
import scalePresets from '../config/scale-presets.json' with { type: 'json' };

const API = {
  exportOBJ:       Pipeline.exportOBJ,
  exportSTL:       Pipeline.exportSTL,
  exportThreeMF:   Pipeline.exportThreeMF,
  getExportedDimensions,
  getExportReference,
  previewExportContext,
  SCALE_PRESETS:   scalePresets,
};

export const {
  exportOBJ, exportSTL, exportThreeMF,
  getExportedDimensions, getExportReference, previewExportContext,
  SCALE_PRESETS,
} = API;

export const PrintManager = API;
```

Named exports and the namespace object are derived from one `API` object →
they cannot drift. **This is the structural answer to bug #1.**

## 4. How each bug closes

| Bug | Structural fix |
|---|---|
| 🔴 1 | Single `API` object drives both named exports and namespace. Adding/removing a method touches one place. |
| 🟡 2 | `getExportedDimensions(meshId, ctx?)` takes the ctx that drives the dimension preview; doc says "first target by default, pass ctx to override". UI can render per-target dims if needed without code changes. |
| 🟡 3 | `BU_TO_MM` defined once (`ExportContext.js`). `factor = ratioFactor * unitFactor`. No division anywhere. |
| 🟡 4 | `PrintScale.js` renamed to `PrintNaming.js`; dead helpers deleted at the rename. Two-rival situation can't recur because there's only one home for each concern. |
| 🟡 5 | `PrintPrep.flattenWorld` throws on missing field. Tests pin the throw. |
| 🟡 6 | `PrintPanel` imports only `PrintManager` for export concerns. Cross-layer reach is dead. |
| 🟡 7 | `previewExportContext` and `getExportedDimensions` destructure their arguments. No `options = {}` bags. |

## 5. Cost / blast radius

- **Files added:** `ExportContext.js`, `PrintPipeline.js`, `ObjWriter.js`, `PrintNaming.js` (rename from `PrintScale.js`).
- **Files removed:** `PrintScale.js` (renamed).
- **`PrintManager.js`:** 682 → ~50 lines.
- **Test additions:** `tests/print/exportContext.test.mjs` (build, freeze, factor math, pivot), namespace-export-parity assertion in `tests/export.test.mjs`, PrintPrep throws-on-missing assertion. Existing `tests/export.test.mjs` runs green with import paths updated.
- **Migration:** one PR. Mostly moves with rename. No state-schema change; no `.mixo` migration.

## 6. What's intentionally NOT in scope

- **Per-format serializer split** (STL, 3MF). Already short, no benefit yet.
- **TypeScript or runtime schema validation.** JSDoc typedef + `Object.freeze` is enough for this team size.
- **Reworking `ExportPlanner.js`.** Pure already; becomes the implementation behind `PrintNaming`.
- **`state.print.exportRatios` shape changes.** The redesign already landed; this restructure is consumer-side only.

## 7. Delivery order

1. **P0 hotfix commit (~1 minute, ~1 line):** add `getExportReference,` to the `PrintManager` object literal in the current `PrintManager.js`. Ship the crash fix immediately, on top of the current WIP. Conventional commit:
   `fix(print): expose getExportReference on PrintManager namespace`
2. **Refactor commit (single):** all of §3 in one cohesive change. Conventional commit:
   `refactor(print): unify export factor + collapse PrintManager into façade`
3. **Doc commit:** Blueprint.md + BUILDLOG.md + memory file.

## 8. Self-review pass

- **Placeholders:** none.
- **Internal consistency:** §3 file layout matches §4 bug-fix mapping. §3.1 typedef matches §3.3 PrintPrep field usage. §3.4 façade matches §4 bug #1 closure.
- **Scope check:** one cohesive concern (export factor + ownership). Fits one implementation pass.
- **Ambiguity check:**
  - "Frozen ctx" §3.1 — clarified as **shallow** freeze (mutable arrays inside).
  - "Preview" §3.2 — clarified: `previewExportContext` returns null when no printable units (avoids throw at UI render time).
  - "Throws on missing" §3.3 — clarified each field individually.
