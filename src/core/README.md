# src/core/ — the map

39 files at this level plus seven subfolders: the application's state, its commands, and the
services the UI calls. **Nothing here renders.** If a module reaches for the DOM it belongs in
`../ui/`, and if it only computes it probably belongs in a plain module with a test and no engine.

## The load-bearing four — read these before changing anything else

| File | Job | The trap |
|---|---|---|
| `StateManager.js` | the single store: subscribe / getState / setState, and the project id minted on new/load/autosave | **dirty is not state.** It is derived, and treating it as stored was how a clean project once asked to be saved |
| `Selection.js` | what is selected, and the active object | **writes are canonicalising.** `set()` reduces a part id to its lead, so downstream code may assume `selectedIds` holds *displayable* ids. Anything that writes selection without going through `set` breaks that, which is why `reconcile()` exists and why `HistoryManager` calls it on all four of its paths |
| `HistoryManager.js` | the undo/redo stack. Command classes are in `commands/` | a command that mutates the scene without a stack entry is a change the user cannot undo, and there is no test that can notice it after the fact |
| `SceneManager.js` | the Babylon scene: silhouette, bed, grid, camera rig, pivot session, environment | 727 lines and opens with imports; named as debt in `../../docs/size-debt.md` |

## Logical objects — the concept that surprises everyone

`LogicalObjects.js` holds it: **one object can be several meshes.** One mesh is the lead; the
others carry `isInternalPart: true` and a `logicalObjectId`. They are **not parented in Babylon** —
each part carries its own absolute transform. So any operation on "an object" must expand through
`logicalObjectPartIds()` / `getTransformTargets()` or it silently moves one mesh out of four. Only
the lead gets an outliner row.

## Input, selection and tools

| File | Job |
|---|---|
| `InputManager.js` | mouse → world, the tool rails, and the keyboard commands. 1,310 lines, named as debt. It also holds the refusals that keep inside-object scope honest (delete / duplicate / hide) |
| `BoxSelect.js` | marquee selection |
| `Hover.js` | viewport hover highlight |
| `CursorTools.js` | 3D-cursor snap operations |
| `SnapUnits.js` | snap and nudge units — every step the operator can take |
| `TouchGestures.js` | the touch recogniser |

## Services the UI calls

| File | Job |
|---|---|
| `AssetLoader.js` | façade over `assets/*`. A façade on purpose: the UI should not know the split |
| `PersistenceManager.js` | façade over `persist/*` |
| `PrintManager.js` · `print/` | export and print; the real work is in `print/` |
| `RenderOutput.js` | façade over `render/*` |
| `BooleanService.js` · `BooleanWorker.js` | interactive boolean for pre-slice kitbashing (ADR 0002) |
| `SliceConnectorService.js` | slice connectors: mm↔BU conversion, option normalisation, the triangle cap |
| `MeshRepair` (in `repair/`) · `MeshValidator.js` | what is wrong with a mesh, and fixing it |
| `ShaderLibrary.js` | materials and swatches, including names recovered from an imported container. 1,091 lines, named as debt |
| `ImportNormalizer.js` | **the import side of the transform pipeline** — the one place unit and orientation decisions are made. `SOURCE_UNIT_FACTORS` lives here and is imported elsewhere, never redefined |
| `ThreeMFLoader.js` | registers `.3mf` with Babylon's SceneLoader, so every path gets it |
| `GeometryCodec.js` | the compact binary codec for baked geometry (ADR 0002) |
| `LaunchRequests.js` | the renderer side of "call MIXOMESH from another app" |
| `SettingsStore.js` | per-user panel settings in localStorage — not project state |
| `BusyRegistry.js` | the user's own work in flight (save, export, repair, boolean). What blocks a quit |
| `UnloadGuard.js` | the pure decision behind the dirty-project `beforeunload`. Pure so it has a test |
| `ViewerModel.js` | the pure logic behind the responsive layout and phone viewer |
| `CursorTools.js` · `Icons.js` | cursor snaps; icon paths (Lucide, ISC — the notice is generated, not hand-kept) |

## Workers — main-thread clients

Each of these is the **main thread's half** of a worker in `workers/`. The pattern is one
persistent worker per concern, not one per call.

`Base64Worker.js` · `BooleanWorker.js` · `MeshImportWorker.js` · `MixoRefinementWorker.js` ·
`ValidateWorker.js` · `WorkerImport.js`, with `hash.js` / `hashHex.js` shared with
`workers/Hash.worker.js`.

**Reject malformed worker geometry before any Babylon mesh is constructed** —
`MixoRefinementWorker.js` says so in its first line, and it is the rule for all of them.

## Subfolders

| Folder | What is in it |
|---|---|
| `assets/` | the asset lifecycle: import, dedupe, registry, textures, thumbnails, mounts (has its own map) |
| `print/` | every export format and the pipeline that feeds them (has its own map) |
| `commands/` | one class per undoable command. `ParentCommands.js` is the largest, named as debt |
| `persist/` | save, load, project id, integrity, asset resolution |
| `scene/` | camera rig, pivot session |
| `render/` | the Render-view output path |
| `repair/` · `refinement/` · `placement/` · `shaders/` · `import/` | the narrower services the façades above cover |

## Small modules worth knowing

`events.js` (the event names — a string literal elsewhere is a bug), `idb.js` (directory-handle
storage), `vendorUrl.js` (where the vendored wasm and manifold live; `initCsg2`).

**The vendored engine under `../../vendor/mixo-geocore/` is consumed as built and never edited
here.** A change to it is a change in geocore, vendored in with `scripts/vendor-geometry.mjs`.
