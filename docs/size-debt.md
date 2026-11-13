# Size debt — the register

The rule (the owner's code principle, rule 5): **size is debt with a date.** Over ~600 lines a
file is named here with its next cut written down; over ~1000 the cut is taken, not named.

**Status: five of eight cuts taken on 2026-11-14. The remaining three are measured as NOT
takeable** — each extraction would make a hub, and rule 1 of the principle comes before rule 5.
Every one of the three carries its measurement below, and the shape change that would make a cut
possible. They are not "left for later": they are decided, with evidence.

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
| `tests/export.test.mjs` 2,003 | **gone** | `tests/export-kit.mjs` (the harness) + five `export-pipe-*.test.mjs` of 208–509 lines |

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

### `tests/browser-smoke.mjs` — 2,845 → 2,649. One block taken; the rest NOT takeable.

**The guard, which landed first and stands on its own merit.** `cdp-harness.mjs` now counts
assertions (`assertionsRun()`, `expectAssertions()` — available to **all 34 browser walks**, not
just this one), and this walk asserts `expectAssertions(321)`. Measured, not grepped: the source
contains 310 `assert(` calls and runs 321, because of loops and conditional branches. Proven to
bite — claiming 322 fails with exit 1.

**Why the split was then refused.** `main()` is one 2,778-line sequential walk: it boots once and
each area builds on the scene the previous areas left. Measured, block by block, against the
bindings declared earlier in the same function:

| Block | Earlier bindings it references |
|---|---|
| Scene ▸ Rendering (676–841) | **9** of 82 |
| shadows / SSAO (876–1154) | **25** of 134 |
| import + errors (1155–1335) | **24** of 201 |
| scale round-trips (1336–1595) | **31** of 234 |
| live checks (1596–2000) | **42** of 295 |
| the rest (2001–2835) | **76** of 372 |

The dependency grows with the walk, because that is what a walk is. Handing a later block a
context of seventy-six things is the hub rule 1 forbids.

**The one block that passed rule 1 was taken** (`tests/smoke/rendering.mjs`, 198 lines). Measured
again at the moment of cutting, its real Node-scope dependency turned out to be **two** things, not
nine: most of the nine were identifiers inside the evaluated JS string, which runs in the browser,
not in Node. It takes `(cdp, failures)` — `failures` rather than a fresh list, because surfacing
page exceptions BEFORE the pixel asserts is the point of that check. **321 assertions before the
cut, 321 after**, which is what the guard is for. The file is still over the limit and the entry
stays.

**This is a different answer from `export.test.mjs` on purpose**, and the difference is the shape,
not the size: that file held 113 *independent* cases and split cleanly; this one is a single
ordered session.

**The shape change that would make a cut possible** (a rewrite of the walk, not a move): make each
area self-sufficient — import its own fixture, build its own scene, assert, tear down — so the
areas can run in any order. That costs one browser boot per file and is a different review.

### `tests/export.test.mjs` — split, 2026-11-14

It had its own tiny runner, so `node --test` counted the whole file as **one** test: its 113 cases
were invisible to the suite's `ℹ tests 1136` line, and a dropped case changed nothing it reported.
The guard went in first (`EXPECTED_CASES`), and only then the split.

The 146-line preamble became `tests/export-kit.mjs` — stubs, the `mesh`/`setScene`/`obj` builders,
the validator fakes, the runner and a `report(n, label)` that asserts each caller's count. The 113
cases went into five contiguous files, in order, unaltered:

| File | Cases |
|---|---|
| `export-pipe-gating` | 29 — collection gating, auto-fix, the warning gate |
| `export-pipe-repair` | 9 — watertight repair of the export clones |
| `export-pipe-formats` | 27 — STL and 3MF |
| `export-pipe-naming` | 26 — filenames, typed print sizes, texture synthesis |
| `export-pipe-misc` | 22 — progress, dimensions, download, PLY/WRL, OBJ axis |

**29 + 9 + 27 + 26 + 22 = 113**, and the node suite went 1,136 → 1,140 (one file became five).
That arithmetic is the whole proof that no case was lost, and it is why the guard had to come
first.

**Counts are measured, never grepped.** The static count said 111: two cases live inside a `for`
loop, so one source line produces several. The files were generated with a sentinel, run, and the
real numbers patched in.

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
