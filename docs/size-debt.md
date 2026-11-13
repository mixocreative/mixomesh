# Size debt — the register

The rule (the owner's code principle, rule 5): **size is debt with a date.** Over ~600 lines a
file is named here with its next cut written down; over ~1000 the cut is taken, not named.

**Status: four of eight cuts taken on 2026-11-14. Two of the remaining four are measured as NOT
takeable** — the extraction would make a hub, and rule 1 comes before rule 5. The other two are
test harnesses whose **vacuous-pass guard has landed**; the splits are owed and now safe to make.

Measured by `cia`'s `tools/maintainability.py` (rule M2). Re-measure with:

```bash
python ~/.claude/skills/cia/tools/maintainability.py S:/ai/mixomesh --rule=M2
```

## Cuts taken, 2026-11-14

| Was | Now | How |
|---|---|---|
| `core/commands/ParentCommands.js` 1,052 | **513** | `core/commands/SplitJoinCommands.js` (554), cut at the file's own line-511 section comment |
| `ui/PropertiesPanel.js` 1,482 | **949** | `ui/properties/`: `ShaderSection.js` (279), `SourceRow.js`, `SourceUnitSection.js`, `UVOverrideSection.js`, `targets.js`, `format.js` |
| `core/ShaderLibrary.js` 1,091 | **977** | `core/shaders/materials.js` (141): the colour conversions and material construction |
| `core/print/PrintPipeline.js` 1,031 | **839** | `core/print/ExportRepair.js` (222): the CSG re-bake and watertight repair |

**What made these four safe, and it was not the line count.** Each boundary was measured before it
was cut: what the block needs from outside, and what outside needs from the block. `ParentCommands`
was one-way (three names out, nothing in). `PrintPipeline`'s repair block needed nothing but
`window.BABYLON`. Then `eslint` named **17 now-unused imports** across the cuts — whole dependency
sets leaving with their sections, which is the evidence that the seams were real and not chosen to
hit a number. `test:all` (187 checks) and 250 vitest green after each.

**Two corrections made mid-cut, worth knowing:**
- `PropertiesPanel`'s pure rules (`scaleConsequence`, `defaultScaleVerb`, …) are only ~20 lines.
  Extracting them buys a test but is not a cut; the size came from four whole sections.
- `PrintPipeline` exposes `repairVerdictOf(mesh)` rather than its `WeakMap`. The measurement said
  the map crossed the boundary and the first attempt dismissed that; the accessor is the narrow
  form. **The tool was right and the hunch was wrong.**

## NOT takeable — measured, and the measurement is the reason

Rule 1 of the principle: *a module is clean when its output is narrower than its input; a module
that needs nearly as much handed in as it hands back is a hub, not a job, and moving code into it
makes the codebase worse while looking like progress.* Rule 1 comes before rule 5. These two files
are over the cut limit and stay that way until someone changes their shape, not their line count.

### `core/InputManager.js` — 1,310 lines

One state machine over pointer, key and touch input, sharing one set of mutable module variables.

| Candidate block | What it needs from module state |
|---|---|
| keymap + dispatcher (`_buildKey`, `_isTypingTarget`, `_isViewportKeyTarget`, `_handleKeyDown/Up`) | **11 names**, including `_handlers`, `_modal`, `_mode`, `_readOnly`, `_currentContext`, `_canvas`, `_bodyDrag` |
| touch (`_onTouchPointer`, `_onTouchGestures`, `_canvasLocal`, `_clearLongPress`) | **16 names**, including 13 references to `_touchBody` alone, plus `_gest`, `_longPressTimer`, `_lastTouchTap`, `_modal` |

Either extraction is a module handed most of the file's state. **What IS worth taking, and is not
a cut:** the pure predicates — `_isDoubleClick`, `_buildKey`, `_isTypingTarget`,
`_isViewportKeyTarget`, `_canvasLocal` — about 60 lines, which would buy tests for rules nothing
tests today. Do that for the tests, not for the number.

### `ui/print/PublishTab.js` — 1,046 lines

Its one separable block is the HTML builders (`_fieldLabel` … `_blocker`, ~310 lines), and they
make **58 references to `S`**, the tab's own view state, plus eight helpers. Passing a nine-field
context bag in to get six builders out is the hub pattern wearing a disguise.

**The shape change that would make a cut possible** (a different, larger piece of work): give the
tab an explicit view-model — one function from `S` to a plain object — and let the builders take
that. Then they are pure, testable, and the boundary is one value wide. Until someone does that,
this file is honestly 1,046 lines.

## Guards landed; splits owed

Both are harnesses with their **own** runners, which means the suite's totals say nothing about
whether they still run everything. That hole is now closed, and closing it was the precondition
for ever splitting them — a move that drops a check would otherwise still exit 0.

### `tests/browser-smoke.mjs` — 2,845 lines

`cdp-harness.mjs` now counts assertions (`assertionsRun()`, `expectAssertions()` — available to
**all 34 browser walks**, not just this one), and this walk asserts `expectAssertions(321)`.
Measured, not grepped: the source contains 310 `assert(` calls and runs 321, because of loops and
conditional branches. Proven to bite — claiming 322 fails the walk with exit 1.

**The next cut:** by subject into the folder's existing `browser-<subject>-smoke.mjs` convention,
each added to `package.json`, with the total assertion count preserved across the split.

### `tests/export.test.mjs` — 2,003 lines

This file has its own tiny runner, so `node --test` counts the whole file as **one** test: its 113
cases were invisible to the suite's `ℹ tests 1136` line, and a dropped case changed nothing it
reported. It now asserts `EXPECTED_CASES = 113`. Proven to bite.

**The next cut:** the 146-line preamble (env install, stubs, `mesh`/`setScene`/`obj` builders,
validator fakes) becomes `tests/export-kit.mjs` — the same pattern as the existing
`support-browser-kit.mjs` — and the 113 cases split by subject (`export-obj`, `export-stl`,
`export-threemf`, `export-gate`, `export-preview`). The case count is what proves none was lost.

## In the debt band (~600–1000), named, no cut owed

`core/ShaderLibrary.js` (977) · `ui/PropertiesPanel.js` (949) · `ui/AssetPanel.js` (881) ·
`ui/ScenePanel.js` (861) · `core/print/PrintPipeline.js` (839) · `ui/ShaderPanel.js` (814) ·
`core/persist/ProjectLoader.js` (796) · `core/scene/PivotSession.js` (760) ·
`core/SceneManager.js` (727) · `ui/Outliner.js` (712) · `core/print/ThreeMFWriter.js` (711) ·
`ui/ContextMenu.js` (706) · `core/repair/MeshRepair.js` (686) · `ui/PrintPanel.js` (678) ·
`core/commands/HierarchyCommands.js` (637) · `core/scene/CameraRig.js` (630) ·
`core/MeshValidator.js` (629) · `supports/live/liveGeneration.ts` (621), plus the test files
`tests/listbridge-runner.test.mjs` (864) · `tests/split-join.test.mjs` (722) ·
`tests/persistence-load-guards.test.mjs` (717) · `tests/storage-adapter.test.mjs` (675) ·
`tests/scan-probe.mjs` (655) · `tests/listbridge-tunnel.test.mjs` (642) ·
`tests/export-context.test.mjs` (626) · `tests/hierarchy.test.mjs` (621).

## Not counted, and why

`public/vendor/**` (the vendored engine, manifold, meshfix) is consumed as built and never edited
here — a line count on generated wasm glue is not debt anybody can pay. `src/i18n/locales/*` are
string tables: length is content, not complexity.
