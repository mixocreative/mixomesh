# src/core/print/ — the map

25 files: everything that turns the scene into bytes someone sends to a printer. **This is the
app's primary path.** A regression here is unrecoverable in a way a UI bug is not — the operator
already handed the file to a machine, and nothing in the app can take it back. Treat every change
here as needing a test before it needs a review.

`../PrintManager.js` is the façade the UI calls; the work is here.

## The pipeline, in order

| File | Step |
|---|---|
| `PrintPrep.js` | what must happen to the scene before anything is written |
| `PrintReadiness.js` | can this be printed at all, and what is still missing. The readiness strip in `../../ui/PrintPanel.js` renders this answer |
| `BedFit.js` | does it fit the bed. **An axis that is unset, null or non-positive (the "custom" printer) is unlimited** — not zero |
| `PrintSpace.js` · `BedPlacement` (in `../placement/`) | where on the bed it goes |
| `ExportPlanner.js` | the plan: which objects, which format, which filename. Owns the **filename scale token** |
| `ExportContext.js` | the resolved context a writer is handed, so a writer never reaches back into app state |
| `PrintPipeline.js` | runs the plan. 1,031 lines, over the cut limit, named as debt in `../../../docs/size-debt.md` |
| `PrintPackaging.js` | one file or a package, and what goes beside the mesh |
| `Download.js` | handing the bytes to the user |

## The writers — one per format

| File | Format | Note |
|---|---|---|
| `StlWriter.js` + `stlEncode.js` | STL | `stlEncode.js` is **pure and import-free on purpose**, so the main thread and a worker share one encoder |
| `ThreeMFWriter.js` | 3MF | split out of PrintManager (review L29) |
| `ThreeMFBambu.js` | 3MF, Bambu/Orca flavour | builds on ThreeMFWriter rather than forking it |
| `ObjWriter.js` | OBJ | |
| `PlyWriter.js` | PLY | carries colour/UVs |
| `WrlWriter.js` | WRL | carries colour/UVs |

`PrintFormats.js` is the table that says which writer does what: **PLY and WRL carry colour/UVs, so
like OBJ they never CSG re-bake.** That sentence is the rule; the table is where it is enforced.

## Texture and geometry support

| File | Job |
|---|---|
| `ExportTextures.js` | collecting the textures an export needs (split from PrintManager, review L29) |
| `UvTransform.js` | the UVs a writer emits: the mesh's own, composed with its base-colour transform |
| `VertexWeld.js` | welding before write, where the format needs it |
| `MaterialPresets.js` | the material presets offered |

## Printer and cost

| File | Job |
|---|---|
| `PrinterProfiles.js` | the printer list and each one's bed and limits |
| `PrintProfileSettings.js` | the settings a profile carries |
| `PrintNaming.js` | the filename rules, including the scale token |
| `PrintCost.js` | the estimate shown before committing |

## The rule that holds this folder together

**A writer takes an `ExportContext` and returns bytes. It reads no app state and shows no UI.**
That is why the formats can be tested without a browser, and why `tests/export*.test.mjs` is the
largest test cluster in the repo. A writer that subscribes to state, or toasts its own error, has
broken the only property that makes this folder testable.
