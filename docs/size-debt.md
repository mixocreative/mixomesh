# Size debt — the register

The rule (the owner's code principle, rule 5): **size is debt with a date.** Over ~600 lines a
file is named here with its next cut written down; over ~1000 the cut is taken, not named.

**Status, honestly: eight files are over the cut limit and none of the cuts has been taken.** That
is a live violation of rule 5, recorded here under rule 8 — *debt not taken is written down with
the reason* — rather than left silent. The reason is the same for all eight and it is a judgement,
not an excuse: every one of them sits on a path the 187-check browser suite and the 250 vitest
checks currently cover green, and a six-file refactor landed without re-walking each surface is
how this project shipped a 92% support-loss regression under three green gates on 2026-11-13. The
cuts below are each a day's work *including* its walk. They are worth taking; they are not worth
taking unwalked.

**What this register is for:** so the next person adding to one of these files knows where the
seam is, and adds at the seam instead of at the end of the file.

Measured by `cia`'s `tools/maintainability.py` (rule M2). Re-measure with:

```bash
python ~/.claude/skills/cia/tools/maintainability.py S:/ai/mixomesh --rule=M2
```

## Over the cut limit (~1000) — the cut is owed

| File | Lines | The next cut, concretely |
|---|---|---|
| `src/ui/PropertiesPanel.js` | 1,482 | Two cuts, in this order. **(1)** The four already-exported pure decisions — `sourceStatusFor`, `isTransformReadOnly`, `defaultScaleVerb`, `scaleConsequence` — go to `ui/propertiesRules.ts` with tests. They are pure, they are the panel's actual rules, and nothing tests them today: output much narrower than input, so a job and not a hub. **(2)** Then each `// ── X section ──` block's render/wire pair (`object`, `source row`, `transform`, `scale row`) becomes `ui/properties/<section>.js`. The file's own section comments are already the cut lines |
| `tests/browser-smoke.mjs` | 2,839 | Split by subject into the folder's existing convention (`browser-<subject>-smoke.mjs`) and add each to `package.json`. **The risk to handle first:** a check that silently stops running is worse than a long file, so the split must assert the total check count before and after |
| `tests/export.test.mjs` | 1,982 | By format, matching `src/core/print/`'s own split: `export-stl`, `export-threemf`, `export-obj-ply-wrl`, plus `export-context`. Same count assertion as above |
| `src/core/InputManager.js` | 1,310 | **The keymap is the clean cut:** `_buildKey`, `_isTypingTarget`, `_isViewportKeyTarget`, `_handleKeyDown/Up` → `core/input/keymap.js`, pure and testable, which is what makes it worth doing. Second cut: the touch block (`_onTouchPointer`, `_onTouchGestures`, `_canvasLocal`, `_clearLongPress`) → `core/input/touch.js`, next to the existing `TouchGestures.js`. The pointer/selection core stays |
| `src/ui/print/PublishTab.js` | 1,046 | Two jobs in one file. **Transport** (`_api`, `_request`, `_remoteId`, `_publish`, `_retry`, `_cancel`, `_connect`, `_testSaved`, `_disconnect`, `_checkPending`, `_resolvePending`) → `ui/print/publishClient.js`; **capture** (`_captureShot`, `_captureHero`, `_addGalleryShot`) → `ui/print/publishCapture.js`. What is left is a view, which is what a tab should be. This one also buys the most: the transport talks to someone else's service and is the hardest thing here to test today |
| `src/core/commands/ParentCommands.js` | 1,052 | **The easiest cut of the eight, and the one to take first.** Line 511 already carries the comment `── Split to parts / Join ──`: two unrelated jobs, parenting/grouping above it and split/join below. Cut there into `ParentCommands.js` + `SplitJoinCommands.js`. No logic moves, no signature changes, and `tests/split-join.test.mjs` already exists to prove it |
| `src/core/ShaderLibrary.js` | 1,091 | Three cuts, its own comments marking each. **Most valuable first:** the duplicate/conflict detection (`_buildSignatureIndex`, `_shaderSignature`, `_findNameConflicts`, `_findContentDuplicate`) → `core/shaders/dedupe.js` — pure, and the behaviour a user notices when it is wrong. Then colour helpers (`_color3ToHex`, `_hexToColor3`) → `core/shaders/color.js`, pure, trivially tested. Then material construction (`_detectType`, `_createBabylonMaterial`, `_buildEntryFromMaterial`) → `core/shaders/materialBuild.js` |
| `src/core/print/PrintPipeline.js` | 1,031 | The repair/CSG block (`_ensureCSG2`, `_csgRebake`, `_tryCsg`, `_ensureRepairRuntime`, `_tryRepair`, `_tryRepairGroup`, `_recordRepairVerdict`, `_refreshRepairVerdict`) → `core/print/ExportRepair.js`. Then `getPrintReadiness` and `supportReadiness` move into the `PrintReadiness.js` that already exists — that cut **removes** a concept rather than adding a file, which is the best kind |

## Over the debt limit (~600), named, no cut owed yet

Listed so they are known, per rule 8. None needs action; each is here so a reader can see it was
counted and not missed.

`src/ui/AssetPanel.js` (881) · `src/ui/ScenePanel.js` (861) · `src/ui/ShaderPanel.js` (814) ·
`src/core/persist/ProjectLoader.js` (796) · `src/core/scene/PivotSession.js` (760) ·
`src/core/SceneManager.js` (727) · `src/core/print/ThreeMFWriter.js` (711) ·
`src/ui/Outliner.js` (712) · `src/ui/ContextMenu.js` (706) · `src/core/repair/MeshRepair.js` (686) ·
`src/ui/PrintPanel.js` (678) · `src/core/commands/HierarchyCommands.js` (637) ·
`src/core/scene/CameraRig.js` (630) · `src/core/MeshValidator.js` (629) ·
`src/supports/live/liveGeneration.ts` (621), and the test files
`tests/listbridge-runner.test.mjs` (864) · `tests/split-join.test.mjs` (722) ·
`tests/persistence-load-guards.test.mjs` (717) · `tests/storage-adapter.test.mjs` (675) ·
`tests/scan-probe.mjs` (655) · `tests/listbridge-tunnel.test.mjs` (642) ·
`tests/export-context.test.mjs` (626) · `tests/hierarchy.test.mjs` (621).

## Not counted, and why

`public/vendor/**` (the vendored engine, manifold, meshfix) is consumed as built and never edited
here — a line count on generated wasm glue is not debt anybody can pay. `src/i18n/locales/*` are
string tables: length is content, not complexity.
