# MIXOMESH overhaul — the authoritative plan

**Date:** 2026-10-14 (merged edition) · **Status:** APPROVED — owner accepted ALL decisions 1–33 on 2026-10-14; execution tracked in `docs/handoff/overhaul-execution.md` · **Branch:** master (solo, no feature branches)
**This file is authoritative.** It merges the UX/asset/grouping overhaul, the whole-software expansion (printers, export settings, risk register, function inventory), and the scale/ratio deep-dive into one reconciled plan. Appendices A (function inventory) and B (risk register) are part of this file.
**Scope of change:** `docs/superpowers/specs/2026-08-03-editor-asset-hierarchy-ux-design.md` §"Scene hierarchy" is overturned by Decision 1; its asset-index, shader-identity and readiness decisions stand. `docs/superpowers/specs/2026-06-16-per-object-ratio-design.md` is refined, not replaced (§3).
**Authority:** `AGENTS.md` rules 1–8 apply to every task; rule 6 and the printer paragraph are amended per **Decision 32 (RESOLVED by the owner)** in the same commit as task 1.1; rule 7 is amended per **Decision 33 (accepted 2026-10-14)** in the same commit as 2.7. The plan does not claim compliance with the current text of either rule. Every contract change updates `Blueprint.md` in the same commit.

> **Blueprint rule (AGENTS):** every task below that changes a contract updates the relevant `Blueprint.md` section **in its own commit**; tasks 1.12, 3.7, 4.10, 5.10 and 6.7 are review-only consistency passes and never carry new contract text.

> **For agentic workers:** execute task-by-task with `superpowers:subagent-driven-development` or `superpowers:executing-plans`. Each task lists **Files · Behaviour · Accept · Deps · Tier** (**haiku** = mechanical, ≤ 2 files, no judgement; **sonnet** = bounded 1–3 file feature; **opus** = cross-cutting or judgement). Gate for every task: `npm run lint && npm run typecheck && npm run i18n:check && npm test`; browser smokes (`npm run test:browser`, `test:export`, `test:repair`, `test:group`) where the task says. Orientation/axis claims are verified only empirically (`tests/scan-probe.mjs`, trimesh, PrusaSlicer CLI). Commit per task on master. The web build stays green after every task; Electron work is additive and never enters the Vite graph. All citations are `path:line` on master 4da6236.

---

## 1. Executive summary

| Area | Root cause in code (verified) | Fix in one line |
|---|---|---|
| **Data safety** | Autosave written every 60 s but **never offered back** (`src/core/persist/Autosave.js:53-88` has no caller; `src/app/main.ts:118-120`); keyed by project *name*; no write abort; no `navigator.storage.persist()`; Electron reload unguarded | Phase 0: recovery reachable, keyed by project id, write hygiene, persistent storage, reload guard |
| **Printer strategy** | `src/config/printers.json` rows carry only `displayName/vendor/bed/defaultMaterialId` (`src/config/printers.json:2-91`); `minWallThickness/printMode/chordTolerance` dead (`src/config/default-settings.json:39-49`); no vertex-colour writer; no Bambu/Prusa metadata; multi-material objects collapse to one 3MF mesh (`src/core/print/ThreeMFWriter.js:272`); OBJ bypasses `PrintSpace` (`src/core/print/ObjWriter.js:52`) | printers.json v2 capability data drives defaults, readiness hints, bed and cost; PLY/WRL writers; split-by-material 3MF; Bambu flavour; Mimaki stays default |
| **Scale / print size** | Per-object `ratio` is a *label* that silently **resizes** when first set on an STL/OBJ (`src/core/commands/ScaleCommands.js:138-142`), moves the object about the world origin (`src/core/commands/ScaleCommands.js:144-146`), goes stale after any Size/Scale edit, and the export reference is the *transient active selection* (`src/core/print/ExportContext.js:297-301`) so the same button yields different files | **Refine, not replace** (§3): declare-vs-convert, explicit reference, effective scale, scale about own origin, typed "Print at" targets (ratio / × / height mm) |
| **Export settings** | options scattered (`individually` resets each render, `src/ui/PrintPanel.js:591`), `strictExport` in both per-user and `.mixo`, readiness only on the Export tab | Printer → defaults → one primary "Export for <printer>" → Advanced; readiness strip on every tab; clean scope split |
| **Assets** | provenance in four fields over three registries; "Linked/Snapshot" badge reflects key *presence* (`src/ui/AssetPanel.js:490-495`); relink never refreshes hash (`src/core/persist/ProjectLoader.js:491-532`); desktop persists no path (`electron/OpaqueFileRegistry.cjs:15-24`); no import dedupe (`src/core/assets/AssetImport.js:180`) | one `source` descriptor + `contentHash`, one `resolveAsset()`, plain-word status, persistent desktop refs, hash-dedupe prompt, VS-Code-style names |
| **Grouping** | four "group" concepts; groups never selectable (`src/core/Selection.js:58-81`); gizmo never moves a group node (`src/core/scene/PivotSession.js:175-204`) | **Object** + **Group** only; Figma/Keynote click-depth; rigid group transform |
| **UI shell / viewport** | 41-item context menu, 8 repair entry points, print verbs under "3D Cursor", shortcuts dead outside the canvas, no hover, no onboarding | tiered menu, **Arrange** panel, one terminology table, header verbs, hover + breadcrumb, 4-step coach |

Eight phases, risk-first: 0 safety net → 1 printers/export/scale → 2–3 hierarchy → 4 assets → 5 shell/viewport → 6 hardening → 7 deferred. **79 scheduled tasks (12 haiku · 48 sonnet · 19 opus)** + 8 deferred. UI tasks that change layout carry a **mockup gate** (Stitch, §4.9): an owner-approved mockup before implementation and a local no-network review after.

---

## 2. Current-state diagnosis

### 2.1 Assets, provenance, resolution

- Provenance = `directoryHandleKey`+`originalPath` (`src/core/assets/AssetImport.js:259-267`, `src/core/assets/AssetImport.js:394-402`), `fileHandleKey` only when `opts.fileHandle && !opts.directoryHandleKey` (`src/core/assets/AssetImport.js:349-357`), `contentHash` duplicated as `sourceFileHash` (`src/core/assets/AssetImport.js:187`, `src/core/assets/AssetImport.js:267`). Mount keys are `dir_<name>_<Date.now()>` (`src/core/assets/DirMounts.js:18`) so re-mounting never matches older assets (`src/ui/AssetPanel.js:664-671`).
- `resolveAssetBlob` (`src/core/persist/AssetResolver.js:45-97`): dir path hit not hash-verified (`src/core/persist/AssetResolver.js:51-52`) → dir hash scan of up to 4000 fully-read files (`src/core/persist/AssetResolver.js:18-35`) → file handle → embedded (hash-checked `src/core/persist/AssetResolver.js:86-92`) → ghost. Status lives in a local map (`src/core/persist/ProjectLoader.js:236-312`); `isUnlinked` set for *any* static result (`src/core/persist/ProjectLoader.js:330`, `src/core/persist/ProjectLoader.js:388`).
- Badge = `!!(directoryHandleKey || fileHandleKey)` (`src/ui/AssetPanel.js:490-495`). Relink clears `isGhost` only (`src/core/persist/ProjectLoader.js:491-532`): no new key/path/hash, no `libraryItem`/OBJ siblings (`src/core/persist/ProjectLoader.js:501`), old container kept; next save embeds new bytes under the old hash (`src/core/persist/ProjectSerializer.js:146`).
- `migrate()` is identity (`src/core/persist/ProjectLoader.js:121-126`). Autosave `skipEmbed` still encodes every texture (`src/core/persist/ProjectSerializer.js:167-178`); `recoverAutosave` has no caller (`src/app/main.ts:118-120`; modal registered `src/ui/ProjectMenu.js:201`).
- Adapter implements KV + mount/list/read only (`src/core/storage/StorageAdapter.js:45-75`); declared methods absent (`src/core/storage/StorageAdapter.js:33-36`). Direct FSA: `src/core/PersistenceManager.js:57`, `src/core/PersistenceManager.js:88`, `src/core/PersistenceManager.js:124`, `src/core/PersistenceManager.js:177`; `src/core/persist/ProjectLoader.js:494`; `src/ui/ViewportDrop.js:62`, `src/ui/ViewportDrop.js:129-130`; `src/core/print/Download.js:9`, `src/core/print/Download.js:14`, `src/core/print/Download.js:18`; `src/ui/AssetPanel.js:225`. Direct idb imports: `src/core/assets/AssetImport.js:10`, `src/core/assets/DirMounts.js:5`, `src/core/persist/AssetResolver.js:4`, `src/core/persist/ProjectLoader.js:16`, `src/core/PersistenceManager.js:17`, `src/core/persist/RecentProjects.js:4`. Caps `persistAssets/relinkByPath/writeFiles/watchFiles` never read; the one gate (`src/ui/AssetPanel.js:117`) is shadowed by `src/app/main.ts:41`.
- **Desktop:** refs are in-memory tokens (`electron/OpaqueFileRegistry.cjs:15-24`); `src/core/assets/DirMounts.js:20`, `src/core/assets/DirMounts.js:30` skip persistence; `promptRemount` exits on desktop (`src/ui/AssetPanel.js:208`); `electron/preload.cjs:12-18` claims `watchFiles/relinkByPath/persistAssets: true` with no watcher; `pickOpen/pickSave` (`electron/preload.cjs:32-33`, `electron/main.cjs:104-105`) have no callers; registry grows per listing (`electron/OpaqueFileRegistry.cjs:43`); recents split between KV and IDB (`src/core/persist/RecentProjects.js:24`, `src/core/persist/RecentProjects.js:30`). **Desktop is less live than web today.**
- **Name clashes:** no hash lookup on import (`src/core/assets/AssetImport.js:172-180`); glTF textures named from `texture.name`/URL (`src/core/assets/TextureAssets.js:156-159`); export texture names collide case-sensitively (`src/core/print/ExportTextures.js:72-84`, suffix `_1`) while zip dedupe is case-insensitive (`src/core/print/PrintPackaging.js:33-38`) → a renamed entry can leave MTL/XML pointing at the wrong image; the OS save dialog is the only overwrite guard (`src/core/print/Download.js:14-20`).

### 2.2 Hierarchy, selection, gizmo

Four overlapping concepts: Collection (`src/core/assets/AssetRegistration.js:201-226`; rendered `src/ui/Outliner.js:241-268`), GroupNode (`src/core/import/ImportHierarchy.js:85-141`; `src/core/commands/ParentCommands.js:168-271`), logical object (`src/core/assets/AssetRegistration.js:124-146`; `src/core/LogicalObjects.js`), legacy `sourceGroupId` (`src/core/assets/MeshSplit.js:66`; read alone at `src/core/LogicalObjects.js:29`, `src/core/LogicalObjects.js:47` and `src/core/MeshValidator.js:140-151`, `src/core/MeshValidator.js:513-518`).

- Groups never in `selectedIds` (`src/core/Selection.js:58-81`; `src/core/InputManager.js:762`); Outliner group click expands to leaves (`src/ui/Outliner.js:717-732`); gizmo re-parents leaves under a temp pivot, group node never moves (`src/core/scene/PivotSession.js:175-204`, `src/core/scene/PivotSession.js:230-238`). A glTF with body+head under one node → 1 import group + 2 objects; a viewport click selects only the clicked mesh (`src/core/InputManager.js:190-220`); no viewport double-click exists.
- `CreateGroupCommand` lands at root with an un-uniquified `'Group'` name (`src/core/commands/ParentCommands.js:169`, `src/core/commands/ParentCommands.js:172`, `src/core/commands/ParentCommands.js:241`); Split names the group like its lead and parts `.2/.3` (`src/core/commands/ParentCommands.js:439`, `src/core/commands/ParentCommands.js:454`); Ungroup dissolves the whole parent (`src/core/InputManager.js:766-777`; `src/ui/ContextMenu.js:550-560`); Join leaves parts under old parents (`src/core/commands/ParentCommands.js:499-512`); Duplicate undo leaves clone ids in `childIds` (`src/core/commands/HierarchyCommands.js:294-302`); lock is cosmetic (only `src/core/commands/PlacementCommands.js:47-49`); viewport Shift=toggle vs Outliner Shift=add (`src/core/InputManager.js:201`; `src/ui/Outliner.js:707-709`); `validateAllPrintParts` dedupes by `sourceGroupId` (`src/core/MeshValidator.js:515-518`); `collectPrintUnits` lead/part flag mismatch (`src/core/print/ExportContext.js:177`, `src/core/print/ExportContext.js:181`); collection rename/delete bypass commands (`src/ui/ContextMenu.js:587-619`).

### 2.3 UI shell (beginner lens)

41-item object menu with "Unparent" twice (`src/ui/ContextMenu.js:203`, `src/ui/ContextMenu.js:230`); print verbs in the "3D Cursor" drawer (`src/ui/CursorPanel.js:96-98`); eight repair entry points with five labels; silent workspace jumps (`src/ui/ShaderPanel.js:788-796`; `src/ui/PrintPanel.js:90-99`, `src/ui/PrintPanel.js:787`); shortcuts need canvas focus (`src/core/InputManager.js:95`), `Tab` dead (`src/core/InputManager.js:797-800`), status hint contradicts code (`en.json status.defaultHint` vs `src/core/InputManager.js:673-675`); no header Import/Export/Undo; reset-all without confirm (`src/ui/ProjectMenu.js:33`, `src/ui/ProjectMenu.js:48-51`); readiness only on Export tab (`src/ui/PrintPanel.js:547`, `src/ui/PrintPanel.js:585`); Properties hidden in Scene/Print (`src/styles/layout.css:384-391`); no onboarding; blocking overlay swallows Esc (`src/ui/ProgressOverlay.js:31-38`); modal replaces modal (`src/ui/Modal.js:85`). Full inventory: Appendix A.

### 2.4 Printers and export

- printers.json row = `displayName, vendor, bed{x,y,z}, defaultMaterialId` (`src/config/printers.json:2-91`); consumers `src/ui/PrintPanel.js:815`, `src/ui/PrintPanel.js:813`, `src/ui/PrintPanel.js:820`, `src/ui/PrintPanel.js:861-869`; `src/core/print/PrinterProfiles.js:16-23`; `src/ui/print/CostBlock.js:50`. Pipeline reads `state.print.bedDimensions` (`src/core/print/PrintPipeline.js:409`), never the profile. Dead: `PrinterProfiles.*` helpers (`src/core/print/PrinterProfiles.js:12-35`), `ExportPlanner.buildExportPlan`, `src/core/printers/PrinterProfile.ts`, `src/export/ExportPipeline.ts`.
- `ctx.options = {individually, selectedOnly, repair, onProgress}` (`src/core/print/ExportContext.js:131-144`); `ctx.prefs = {objBakeSolidTextures}` only (`src/core/print/ExportContext.js:47-51`); `strictExport` read directly (`src/core/print/PrintPipeline.js:525`); `individually` rebuilt unchecked (`src/ui/PrintPanel.js:591`); `targetPrinterId/bedDimensions/objBakeSolidTextures/strictExport` in **both** SettingsStore (`src/core/SettingsStore.js:41`) and `.mixo`; `repairOnImport` per-user only (`src/core/persist/ProjectSerializer.js:187`; `src/core/persist/ProjectLoader.js:146`); dead keys `minWallThickness/printMode/chordTolerance` (`src/config/default-settings.json:39-49`).
- 3MF (`src/core/print/ThreeMFWriter.js`): core + Materials 2015/02 (`src/core/print/ThreeMFWriter.js:244`, `src/core/print/ThreeMFWriter.js:401`); no metadata/thumbnail/`requiredextensions`; seated on bed (`src/core/print/ThreeMFWriter.js:298-305`); colorgroup alpha always `FF` (`src/core/print/ThreeMFWriter.js:242-245`); multi-part unit → one `<object>` (`src/core/print/ThreeMFWriter.js:272`); textured path (`src/core/print/ThreeMFWriter.js:331-405`); groups → `<components>` (`src/core/print/ThreeMFWriter.js:170-211`); whole-file textured-vs-colorgroup decision (`src/core/print/PrintPipeline.js:591-594`); no vertex colours, no paint/MMU attributes.
- OBJ: Babylon `OBJExport` (`src/core/print/ObjWriter.js:52`, `src/core/print/ObjWriter.js:58`) not through PrintSpace (Y-up, x negated — unverified in the Mimaki tool); MTL (`src/core/print/ObjWriter.js:184-198`); solid bake (`src/core/print/ObjWriter.js:85-100`); never CSG (`src/core/print/PrintFormats.js:5-6`). STL (`src/core/print/StlWriter.js:45-53`): binary LE, mm, Z-up, no colour, not seated. **No glTF/PLY/VRML writer** (`src/core/print/PrintReadiness.js:4`).
- Textures: frozen full-res source preferred (`src/core/print/ExportTextures.js:25-29`), PNG only, diffuse slot only (`src/core/print/ExportTextures.js:99-101`), no sRGB flag check. Gate: codes at `src/core/print/PrintReadiness.js:39-84`; validator emits warnings only (`src/core/MeshValidator.js:220-267`); strict blocks only confirmed-open (`src/core/print/PrintPipeline.js:525-533`); nothing checks wall thickness, texture dimensions, colour count.

### 2.5 Viewport interaction

No hover highlight (`src/core/InputManager.js:148-159`; `HighlightLayer` only in a comment `src/core/scene/SelectionOutline.js:3`); Ctrl-click unhandled; marquee tests bbox centres incl. parts (`src/core/BoxSelect.js:54-66`); snapping only in G/R/S with Ctrl (`src/core/InputManager.js:405-408`, `src/core/InputManager.js:594-601`) and the translate step is in BU (`src/config/default-settings.json:50` → 1.0 = 1 m); gizmo drags unsnapped; no nudge keys; no measure tool; HUD not refreshed on `TRANSFORM_COMMITTED` (`src/ui/MeshStats.js:44-58`); undo labels hard-coded English (`src/core/commands/TransformCommands.js:18`); cursor ops and collection edits not undoable (`src/core/CursorTools.js:4-6`); multi-file drops stack at one point (`src/ui/ViewportDrop.js:167`); camera has no zoom-to-cursor (`src/core/scene/CameraRig.js:151-154`).

### 2.6 Risk headline

Appendix B holds the full register. Phase 0 is driven by: **R2** autosave unreachable, **R6** Electron reload unguarded, **R1/R8** no write abort, **R4** no persistent storage, **W6** case-sensitive texture names, **F6** replay failure silent, **F1** capture failure silent, **R7** import/load window, **W1** scale footguns (§3).

---

## 3. Scale and print size — deep-dive and verdict

### 3.1 Intent, reconstructed from history

- **2026-05-13 (global model).** Four numbers: `sourceUnit`, `modelRatio` (glTF `extras.ratio`), `workingRatio`, `targetRatio`; "1 BU = 1 m at the working ratio's print size"; export factor `(working/target)×1000`; owner's worked example "working 12, target 2 → a 0.1 BU mesh exports as 600 mm at 1:2" (`Blueprint.md:3171-3180`). Motivation: Blender mm authoring convention, hobbyist nominal scales, a 300 mm working area (`Blueprint.md:1864`; memory `scene_default_scale`). Filename suffix `_r{working}to{target}` so "two exports at different scales never collide on disk and the user can read the scale from the filename" (`Blueprint.md:2954-2957`).
- **2026-06-16 (per-object).** Commit `c70defc`: "Replace the single global workingRatio with a per-object `ratio` … Export reference = the active print unit's ratio (else first unit) … Default 'as shown' (empty exportRatios → prints displayed size); add absolute target ratios as an editable list, one output file per target." Spec §1: "Hobbyist kitbashing mixes source models authored at different scales (a 1:1 prop next to a 1:72 vehicle) into one print." Spec §3.6: mixed-ratio export scales **uniformly by the active object's ratio** "(User-confirmed.)"; §6 "(User: remove bed validation.)". Blueprint "Why": kitbashing mixes authored scales; each object "imports at the ratio its file suggests, resizes live, and exports at the size shown (or a chosen target)" (`Blueprint.md:3191-3195`).
- **Owner's words in the UI.** "Default prints each object at the size shown (its own Ratio). Add a target ratio to also export rescaled copies — e.g. 1:144 on a 1:72 object is half size. One file per entry." (`src/i18n/locales/en.json:135`). 2026-09-18: the printed BU→mm factor "meant nothing to the user … What they need is the size the reference object will actually come out at" (`src/ui/PrintPanel.js:204-207`).

**User problems the design serves:** (1) scale-model hobbyists think in nominal scales (1:72 / 1:35 / 28 mm) and convert between them; (2) kitbashing sources authored at different scales/units into one print; (3) printing one project at several sizes in one go; (4) never printing a 1:72 object at real size by accident ("as shown" default); (5) unambiguous files on disk; (6) Mimaki fidelity and a 300 mm bed. These are the right problems and per-object authority is the right answer to (2).

### 3.2 Mechanics end to end (verified)

| Stage | Code | What happens |
|---|---|---|
| Import unit + authored scale | `src/core/assets/AssetImport.js:207` (`extractModelRatio`), `src/core/assets/AssetImport.js:245` (`bakeImportTransform(container, importScaleFactor(sourceUnit, modelRatio), position)`), `src/core/assets/AssetImport.js:264` (asset `modelRatio`) | `importScaleFactor(sourceUnit, modelRatio, ratio = modelRatio)` (`src/core/ImportNormalizer.js:111-120`) → `computeSceneNormalizationScale` (`src/core/scale/ScaleMath.js:87-93`) = `unitFactor × modelRatio/ratio`; with the seed the ratio cancels, so **the object lands at its authored size in BU (1 BU = 1 m)**. `ratio` is baked into nothing at import. |
| Per-object state | `src/core/assets/AssetRegistration.js:168` seeds `ratio = modelRatio`; `objectRatio(obj)` (`src/core/scale/ScaleMath.js:54-56`) | STL/OBJ carry no extras ⇒ `modelRatio = 1` ⇒ `ratio = 1` ⇒ label "1:1" regardless of truth. |
| Viewport / Properties | Size (mm) = world AABB × 1000 (`src/ui/PropertiesPanel.js:198`); Pos (mm) `src/ui/PropertiesPanel.js:189`; Size edit → node scaling via `TransformCommand` (`src/ui/PropertiesPanel.js:411-444`); Ratio row `src/ui/PropertiesPanel.js:250-272`, apply `src/ui/PropertiesPanel.js:276-292`, wire `src/ui/PropertiesPanel.js:333-344` | Three ways to resize: Size (node scale), Scale XYZ (node scale), Ratio (vertex bake). |
| Ratio change | `RescaleObjectCommand` (`src/core/commands/ScaleCommands.js:111-127`): factor `from/to`, `bakeTransformIntoVertices` (`src/core/commands/ScaleCommands.js:138-142`), **`mesh.position.scaleInPlace(factor)`** (`src/core/commands/ScaleCommands.js:144-146`), state `ratio` (`src/core/commands/ScaleCommands.js:151-162`) | Geometry rescaled about the mesh origin, and the **position is scaled about the world origin** for top-level objects too — an object at x = 100 mm set from 1:1 to 1:72 jumps to x ≈ 1.4 mm. |
| Readiness / bed / cost | `boundsForExportContext(ctx)` (`src/core/print/PrintReadiness.js:114-119`); per-target readiness (`src/core/print/PrintPipeline.js:398-409`); cost from `previewExportContext()` (`src/ui/print/CostBlock.js:285`, `src/ui/print/CostBlock.js:296`) = **first target only** | Bed fit per target; cost for one target even in a batch. |
| ExportContext | `buildExportContext` (`src/core/print/ExportContext.js:115-154`): reference = active printable unit else first (`src/core/print/ExportContext.js:297-301`); `referenceRatio = objectRatio(reference)` (`src/core/print/ExportContext.js:119`); `targetRatio = target ?? referenceRatio` (`src/core/print/ExportContext.js:120`); `ratioFactor = ref/target` (`src/core/print/ExportContext.js:123`); `factor = ratioFactor × BU_TO_MM` (`src/core/print/ExportContext.js:142`); pivot = reference lead's world translation (`src/core/print/ExportContext.js:303-316`) | **Every** object in the batch is scaled by the reference's ratio/target about the reference pivot (`src/core/print/PrintPrep.js:24-33`). |
| Target list | `exportRatiosFromState` (`src/core/scale/ScaleMath.js:66-71`); `targets = explicit.length ? explicit : [null]` (`src/core/print/PrintPipeline.js:344-345`); loop `src/core/print/PrintPipeline.js:346-353` | Empty = as shown ⇒ factor 1000 (displayed size). |
| Filename | `_r{ref}to{T}` (`src/core/print/ExportPlanner.js:22-24`, token `src/core/print/ExportPlanner.js:39-42`; `src/core/print/PrintNaming.js:28-33`, `src/core/print/PrintNaming.js:39-54`) | Suffix uses the reference ratio — i.e. **whatever was active when Export was clicked**. |
| Persistence / migration | object `ratio` + `print.exportRatios` (`src/config/default-settings.json:40`); `exportRatios` excluded from per-user settings (`src/core/SettingsStore.js:36-41`); migration `src/core/persist/ProjectLoader.js:189-196`, `src/core/persist/ProjectLoader.js:332-336`; restore delta bake `src/core/persist/ProjectLoader.js:31-36`, `src/core/persist/ProjectLoader.js:346-352` | Round-trip is correct (pinned by smokes). |
| Leaks outside the seams | `× 1000` literals at `src/ui/PropertiesPanel.js:189`, `src/ui/PropertiesPanel.js:198`, `src/ui/PropertiesPanel.js:420`, `src/ui/PropertiesPanel.js:464` and `src/core/InputManager.js:686`; dead legacy readers `sceneScaleFromState` / `printScaleFromState` / `computePrintExportScale` (`src/core/scale/ScaleMath.js:45-48`, `src/core/scale/ScaleMath.js:73-76`, `src/core/scale/ScaleMath.js:95-99`, used only by the dead `ExportPlanner.buildExportPlan`, `src/core/print/ExportPlanner.js:16`); dead keys `print.sceneScale` + `print.sceneScaleHelp` (`src/i18n/locales/en.json:131`, `src/i18n/locales/en.json:133`; `print.custom` at `:132` stays — live at `src/ui/PrintPanel.js:192`) | Minor; cleaned in task 1.10. |

### 3.3 Evaluation

**Where it is clean.** One import seam, one export seam, one frozen context; "as shown" default is the correct safety net; batch-by-target list is exactly the Figma @1x/@2x idea; the filename contract is good; restore replays correctly; per-object authority is right for kitbashing.

**Where users get hurt (all verified in code):**

1. **Declare ≠ convert.** The Properties "Ratio" control always *resizes* by `old/new` (`src/core/commands/ScaleCommands.js:138`). For an STL/OBJ (seeded 1:1) the user who merely wants to *declare* "this kit is 1:72" **shrinks it 72×**. Only files authored through the owner's own Blender `extras.ratio` pipeline avoid this; downloaded models never carry it.
2. **Position jump** on every ratio change for objects not at the origin (`src/core/commands/ScaleCommands.js:144-146`).
3. **The label goes stale.** Size (mm) / Scale XYZ edits change the node scale but not `ratio`; a 1:72 object doubled by Size still says 1:72 and exports "at 1:72" at twice the true 1:72 size (`src/core/print/ExportContext.js:119` ignores node scale).
4. **Hidden, volatile reference.** `_selectReferenceUnit` is the active selection (`src/core/print/ExportContext.js:297-301`). In a 1:35 + 1:72 scene, "export at 1:144" yields factor 35/144 or 72/144 depending on what was last clicked; the filename suffix changes with it; no warning. Same button, two different files.
5. **Two meanings of one word.** Properties "Ratio" (what the object *is*) and Print "Print Scale / Add ratio…" (what to *print at*) share one preset list (`src/config/scale-presets.json:2-11`) and one noun.
6. **Mixed scenes and a named target.** The uniform rule keeps the assembly intact (right for a kitbash) but then "1:144" is only true for the reference object; the UI never says so.
7. **Cost at the first target only** in a batch (`src/ui/print/CostBlock.js:285`); readiness is per target.
8. **Target edits are not undoable** (`src/ui/PrintPanel.js:226-234`, `src/ui/PrintPanel.js:258-268` write `setState` directly); ratio edits are.
9. **Float drift** across repeated vertex bakes (spec finding H, accepted).

**Four user stories through today's UI.**

| Story | What the user sees and clicks | Outcome |
|---|---|---|
| A. Single 1:72 kit from STL | Import → Properties shows **Ratio "1:1 Full Scale"**, Size 150 mm → Print ▸ Scale shows "As shown · 1:1" → Export → `Kit_r1to1.3mf` | Prints right *only if the user never touches Ratio*. Choosing "1:72 Small" to label it shrinks the kit to 2 mm. To get a 1:144 copy they must first shrink, then add 144 — impossible without the footgun; the workaround is Size (mm). |
| B. Kitbash 1:35 tank (glTF `extras.ratio=35`) + 1:72 figure (`=72`) | Both import at authored size; select figure → Ratio "1:35" → ×2.06 → correct size (but it jumps if off-origin) → Export as shown → `Diorama_r35to35` (if the tank was active) or `_r72to72` (if the figure was) | Works — this is the designed case — but only because the files carried the property; the filename depends on the last click. Without extras both read 1:1 and story A's footgun returns. |
| C. One model at 1:12, 1:6, 1:4 | Object ratio 12 (from extras) → add targets 12, 6, 4 → three files `_r12to12/_r12to6/_r12to4`, factors 1/2/3 → cost shown for 1:12 only | Works. For an STL (ratio 1) the same targets give 1/12, 1/6, 1/4 of the displayed size — correct **iff** the display is real size, which the user cannot tell from the label. |
| D. Real-size functional part (STL, mm) | Ratio 1:1, as shown, `Bracket_r1to1.stl`, bed fit and cost correct | Correct; the model is right for this story. |

### 3.4 How praised tools express scale intent

| Tool | Model | Lesson |
|---|---|---|
| Bambu Studio / PrusaSlicer / OrcaSlicer / Lychee / Chitubox | **Scale %** + **size in mm** (locked aspect), 100 % = file units as mm; no nominal-scale concept | mm and % are universal; every print user already knows them |
| Tinkercad / Shapr3D / Fusion / SketchUp | type a dimension in mm; "Scale" by factor | dimension entry is the beginner path |
| Blender | scene unit scale + object scale; scale modelling relies on unit scale | the "declare the scale" idea exists but is global — the June design was right to make it per-object |
| Scale-model community (1:35 ↔ 1:48 calculators, 28 mm "heroic") | ratio-to-ratio conversion `old/new`; minis by eye-height | ratio **is** the native noun for this audience — keep it, but conversion must be an explicit verb |
| Figma export @1x/@2x/@3x | multiple sizes from one design, suffix in the filename | the `exportRatios` list is exactly this; multipliers read better than "1:144 on a 1:72 reference" |

### 3.5 Verdict — **refine** (keep the model, fix four semantics, add two beginner forms)

The owner's design is right in substance: per-object scale declaration, "as shown" default, a list of print sizes, uniform WYSIWYG export of a mixed kitbash, and the filename contract all stay. What changes is *meaning*, not structure:

1. **Declare vs convert.** `objects[id].ratioSource: 'file' | 'user' | 'default'`. The Properties control becomes **Scale** with two verbs: *Set scale* (relabel, no geometry — the default action when `ratioSource === 'default'`, i.e. the STL/OBJ case, and always available) and *Convert to scale* (today's `RescaleObjectCommand`, the default once a scale is trusted). The picker shows the consequence before applying ("Resize ×2.06" / "Relabel only").
2. **Scale about the object's own origin.** `RescaleObjectCommand` keeps a top-level object's position; a child's local position scales relative to its parent (intra-asset spacing) — the spec's finding D intent, without the world-origin jump.
3. **Effective scale.** `effectiveRatio(obj, mesh) = ratio / uniformNodeScale` (uniform within 1e-6; otherwise `ratio` and the UI says "non-uniform"). Properties shows "Scale 1:72 · ×2.0 → prints as 1:36"; the export factor uses the reference's *effective* ratio, so "print at 1:72" is true after hand scaling.
4. **Explicit, stable reference.** `print.referenceObjectId` (per-project; default = first printable unit; shown in Print ▸ Export as "Reference: tank (1:35) [change]"), never the transient active selection. Mixed-scale scenes show one sentence: "Other objects keep their size relative to tank (as shown)". Uniform WYSIWYG scaling is **reaffirmed** — a kitbash is one assembly.
5. **Typed print sizes.** `print.exportTargets: [] | [{kind:'ratio', value} | {kind:'factor', value} | {kind:'height', mm}]`. Empty = as shown. `factor` = ×N (Figma @2x); `height` = make the reference object N mm tall, where "tall" = its print-space Z extent (bed-up axis), the usual meaning for printers. Filename tokens: ratio `_r{ref}to{T}`, factor `_x{N}`, height `_h{N}mm`, as shown `_r{ref}to{ref}`; `ref` is the reference's **effective** ratio (Decision 26), so the token format is unchanged but a hand-scaled object now reports its true scale (a 1:72 object at node scale 2 writes `_r36to36`, not `_r72to72`).
6. **Per-target cost and readiness lines; undoable target edits.**

User-facing nouns: **Scale** (what an object *is*: "1:72") and **Print at** (what you get: "the size shown · 1:144 · ×2 · 120 mm tall"). Size (mm) stays the beginner's resize path.

```
Properties ▸ Transform
 Scale   [1:72 ▾]  Set scale | Convert…      ×2.0 → prints as 1:36
 Size (mm)  [300.0] [120.5] [ 88.2]  🔒

Print ▸ Export
 Print at:  the size shown (1:36, reference: Spitfire)   [Other sizes…]
   ▸ 1:144   ·  ×0.5   ·  120 mm tall        [+ add]   one file each
 Reference: Spitfire (1:36) [change]   ⓘ other objects keep their relative size
```

Migration (owned by the Phase-1 tasks, not 4.1): 1.17 migrates `exportRatios: number[]` → `exportTargets: [{kind:'ratio', value}]` (mirroring `exportRatios` for one minor so 3.3 readers still work); 1.13 seeds `ratioSource = asset.modelRatio !== 1 ? 'file' : 'default'`; 1.15 adds `referenceObjectId = null`. 4.1 only bumps the schema version and adds `source`, `displayName` and formalises the `project.id` that 0.11 already mints. No geometry changes; filenames change only for objects whose node scale ≠ 1 (Decision 26).

Locks kept: no global world rescale; per-object authority; printer-agnostic export; the `_r{ref}to{T}` suffix format for ratio targets (its `ref` value becomes the effective ratio — Decision 26).

---

## 4. Target design

### 4.1 The user's mental model (plain words)

> **A project is a self-contained file.** Everything you import is copied into it, so it always opens — anywhere. If a model came from a file on your computer, MIXOMESH remembers **where** (its *Source*) so you can **Refresh** it or **Find** it if it moved.
> **Objects** are the things you print; an object is one solid, and its materials are parts that stay together. **Groups** hold objects so they move as one — click a group to grab everything, **double-click to go inside**, **Esc** to step out. A file with several objects arrives as a group named after the file.
> Every object has a **Scale** ("this kit is 1:72") and a **Size** in mm. **Print at** says what comes out: the size shown, another scale, a multiplier, or a height in mm — one file each.
> **Pick your printer** first. MIXOMESH then knows the build volume, the file format it wants, how colour reaches it, and what to check. You can still export any format.

### 4.2 Printer strategy and `src/config/printers.json` v2

**Principle (Decision 32, resolved):** the printer row is the single source of truth for *profile defaults, hints, limits, bed and cost*. Selecting a printer **applies** its profile defaults; every one of them is then an ordinary per-project user setting the user may change; **Printer default** reverts them; no format is ever hidden or blocked. The `AGENTS.md` amendment ships with task 1.1. Mimaki 3DUJ-553 stays the default and reference target (Decision 8).

```jsonc
"mimaki-3duj-553": {
  "displayName": "Mimaki 3DUJ-553", "vendor": "Mimaki", "process": "uv-inkjet",
  "bed": { "x": 508, "y": 508, "z": 305 },
  "colour": { "mode": "texture", "maxTextureSize": 4096, "maxTexturesPerObject": 1, "alpha": true, "vertexColour": true },
  "export": { "recommended": "obj-mtl", "formats": ["obj-mtl", "3mf-textured", "wrl", "ply", "stl"],
              "obj": { "axis": "y-up" }, "threeMF": { "flavour": "core", "seatOnBed": true, "metadata": true } },
  "validation": { "requireWatertight": true, "minWallMM": 1.0, "minFeatureMM": 0.5, "maxTrianglesHint": 2000000 },
  "defaultMaterialId": "mimaki-model",
  "verified": "unverified"
}
```

`process` ∈ `uv-inkjet | polyjet | mjf | fdm | fdm-multi | resin | sls`; `colour.mode` ∈ `texture | vertex | per-part | paint | none`; `export.formats` ⊂ `obj-mtl | 3mf-textured | 3mf-colorgroup | 3mf-bambu | 3mf-prusa | stl | ply | wrl`. `tests/hygiene.test.mjs` validates every row; v1 rows load with defaults.

| Family (examples) | Format(s) | Units / axis | Colour encoding | Limits | Today | Gap → task |
|---|---|---|---|---|---|---|
| **UV-inkjet** — Mimaki 3DUJ-553/2207 (primary) | OBJ+MTL+PNG (primary), textured 3MF, WRL, PLY | mm; Y-up OBJ *(unverified)* | texture (one per material) or vertex colour | texture ≤ 4096² *(unverified)*, UV 0–1, watertight, wall ~1 mm | OBJ/3MF textured (`src/core/print/ThreeMFWriter.js:331-405`; `src/core/print/ObjWriter.js:184-198`) | 1.4, 1.6, 1.7 |
| **PolyJet** — Stratasys J-series (GrabCAD Print) | WRL, OBJ+MTL, 3MF | mm | texture or vertex | watertight; wall 0.5–1 mm | OBJ/3MF | 1.6 |
| **MJF colour** — HP 580 | 3MF (texture/vertex), OBJ, WRL | mm, Z-up | texture or vertex | wall 0.5 mm | 3MF textured | 1.6 |
| **FDM multi-material** — Bambu X1C/H2D/A1 AMS, Kobra ACE, Centauri (Orca forks) | Bambu/Orca 3MF (Production ext, `Metadata/model_settings.config`, per-object extruder, `paint_color`), else STL/OBJ per part | mm, Z-up | per-part colour (+ paint) | parts must be separate objects | merged `<object>` (`src/core/print/ThreeMFWriter.js:272`) | 1.5, 1.11 |
| **FDM MMU** — Prusa XL / MMU3 | 3MF `slic3rpe:mmu_segmentation`, or STL per part | mm | per-part + paint | same | colorgroup only | 1.5; paint 7.1 |
| **Single FDM** — Bambu/Prusa/Creality/Elegoo | STL / 3MF / OBJ | mm, Z-up | none | watertight, bed fit, wall ~0.8 mm | OK | 1.4 |
| **Resin** — Elegoo Saturn, Anycubic Photon, Formlabs | STL / 3MF / OBJ | mm | none | watertight (hollowing is the slicer's job), feature 0.3–0.5 mm | OK | 1.4 |

**Never a slicer:** no toolpaths, supports, hollowing or profile files; 3MF flavours carry only what identifies parts/colours.

### 4.3 Export flow and settings scope

```
Print ▸ [Printer] [Validation] [Export]        ← the Scale tab folds into Export
▲ Review — 1 object not watertight · texture 8192² > 4096² for Mimaki          [Go to Export →]
────────────────────────────────────────────────────────────────────────────────
Printer: [Mimaki 3DUJ-553 ▾]   Build volume 508 × 508 × 305 mm   Colour: full-colour textures
────────────────────────────────────────────────────────────────────────────────
[  Export for Mimaki 3DUJ-553  (OBJ + MTL + PNG)  ]       ← primary = printer's recommended format
Other formats: 3MF (textured) · WRL · STL · PLY           ← every writer, always clickable
Print at: the size shown (1:36 · reference: Spitfire)     [Other sizes…]  → 1:144 · ×0.5 · 120 mm tall (+)
▸ Advanced
   ☐ Each object as its own file     ☐ Split multi-material objects into parts (AMS/MMU)
   ☐ Bake solid colours to texture (OBJ)   ☐ Block export when not watertight (strict)
Cost: PLA · 42 g · $9.40  (per size when several)  ⚙
```

Rules: readiness strip on every tab; "Export for …" runs the gate (errors block; warnings open the three-way modal whose default is **Repair & export**); formats never hidden by the printer; every disk write through the OS/Electron dialog and "Export again" re-prompts. The reference object is explicit state (§3.5 #4).

**Printer profile defaults vs user overrides (Decision 32).** The profile-driven fields are ordinary per-project settings: `print.exportFormat`, `print.splitByMaterial`, `print.objAxis`, `print.threeMFFlavour`, `print.bedDimensions`. There is no separate overrides map — a field is "modified from printer default" when its value differs from `getPrinterProfile(print.targetPrinterId)`'s default for that field (computed at render time, so a later printers.json change is reflected honestly). `ApplyPrinterProfileCommand(printerId)` sets `targetPrinterId` and every profile-driven field to the profile's defaults in **one undo step**; **selecting a printer runs it** (so the select is an apply-defaults action, undoable with Ctrl+Z) and so does **Printer default ↺** (the revert) (shown beside the printer select whenever any field is modified; modified fields also carry a small "modified" dot with the profile value in the tooltip). User edits of a field go through the existing settings commands and mark it modified. Persistence: the fields themselves persist per-project, file-wins (Decision 15); nothing extra is stored. Undo: apply/revert and each override are separate history entries, so Ctrl+Z after **Printer default** restores the overrides.

```
Printer: [Bambu Lab X1 Carbon ▾] · modified   [Printer default ↺]
[  Export for Bambu Lab X1 Carbon  (STL ●)  ]     ← user changed format from 3MF to STL; ● = modified
```

**Settings scope (Decision 15).** Per-project, file-wins: `targetPrinterId, bedDimensions, exportFormat, objAxis, threeMFFlavour, exportTargets, referenceObjectId, objBakeSolidTextures, splitByMaterial, individually`. Per-user only: `strictExport, repairOnImport, cost.*, volumeMode`, viewport/scene look. `ExportContext.prefs` is the one place the pipeline reads print preferences.

### 4.4 Asset model

```js
// AssetEntry (schema 3.4)
source: null | { kind:'folder'|'file', refKey:string, path:string, label:string }
contentHash: string
displayName: string          // ours; never renames the user's file
// fileData embedded on every manual save (unchanged)

// StorageAdapter (both impls)
resolveAsset({source, contentHash, fileData}) → { bytes, origin:'live'|'embedded', drift:boolean, reason? }
persistRef(key, nativeRef) / restoreRef(key) / deleteRef(key)       // browser: idb; desktop: {token→absPath} in mixo-kv.json 'refs'
findMoved(source, contentHash, {limit, onProgress}) → source|null   // explicit only
pickOpenProject / pickSaveProject / pickImportAssets / saveExport    // desktop via dialog IPC
findByHash(contentHash) → assetId|null                               // in-project dedupe
```

Resolution: `source` → bytes → hash equal ⇒ `live`; different ⇒ `embedded` + `drift` ("Changed on disk — Refresh?"); unreachable ⇒ `embedded` ("Missing source — Find…"); no bytes ⇒ ghost. No automatic directory scan on load (Decision 3). Status (`embedded | live | drift | missing | ghost`) shown in **Properties ▸ Object ▸ Source** and as a card chip only when ≠ `embedded|live`. Relink/Refresh/Find = one undoable `RelinkAssetCommand`. Desktop refs persist; browser folder keys stable `dir_<sha256(name+firstEntry)>` (Decision 10). Boot = one non-blocking banner (Decision 4). Autosave keyed by `project.id`, never re-encodes stored texture images.

**Name-clash rules.** (1) Never rename the user's files. (2) Identity = `contentHash`: re-importing identical bytes prompts "already in this project — [Add another copy] [Import as separate asset]", default = add a copy; Project-tab drops and project load never prompt (Decision 16). (3) Same name, different content → both kept; display qualified only while ambiguous, VS Code style (`chair.glb · downloads`). (4) Generic texture names (`baseColor|albedo|diffuse|Image_\d+|texture\d*|tex_\d+|material_\d+`) display as `<model> · <slot>`, original in tooltip. (5) Export package names are deterministic: textures `<objectName>_<slot>.png`, shared `<materialName>.png`, **case-insensitive** uniqueness with MTL/3MF references rewritten in the same pass (Decision 17). (6) Overwrite only via a dialog or explicit "Replace". (7) Material-name clashes keep the merge modal (`src/ui/ShaderPanel.js:182-257`).

### 4.5 Hierarchy / grouping

| Concept | Selectable | Gizmo | Validation / export / cost unit |
|---|---|---|---|
| **Object** (lead + hidden material parts) | yes | parts under the temp pivot (unchanged) | **the unit** |
| **Group** (`scene.groups` + `TransformNode`) | **yes (new)** | the group node itself under the pivot → rigid | transparent; 3MF `<components>` |
| ~~Collection~~ | — | — | schema kept for provenance; no Outliner level (Decision 2) |
| ~~`sourceGroupId`~~ | — | — | migrate-only |

Import: a file yielding ≥2 objects arrives as one **Group named after the file stem**; single-object files arrive bare. Group origin = bottom-centre of the combined AABB. **Click-depth (Figma/Keynote):** click = topmost ancestor below the scope; double-click = enter + select child; Esc = step out; click empty = clear; Outliner click selects exactly that row and sets scope to its parent; breadcrumb under the NavCube; marquee by combined AABB centre; Shift = add, Ctrl = toggle (Decision 5). Group nests under the common ancestor with `Group.001` naming; Ungroup acts on selected groups; Delete/Duplicate accept groups; Lock = transform-lock, cascades (Decision 9); Separate/Merge fix naming and parents.

### 4.6 UI shell

Keep: four workspaces (no repeated specialist sections), Blender control language, washi palette, Materials panel as the single edit surface, per-object scale authority. Changes (full per-function table: Appendix A):

- **Header:** logo · project name · **Import** (Ctrl+I) · New/Open/Save/Save As/Recent · **Undo/Redo** · workspace pill · **Export** · locale · **?** (shortcuts, tour, preferences incl. *Auto-repair on import*, reset-all with confirm).
- **Properties ▸ Object** (name, visible, lock, print, Source, file units) visible in all four workspaces (Decision 6); **Properties ▸ Transform** carries Scale (§3.5), Size (mm), Pos, Rot, Scale XYZ.
- **Context menu:** primary tier ≤ 12 (Focus · Hide · Lock · Rename · Duplicate · Group · Ungroup · Enter/Exit group · Separate/Merge · Repair · Export selected · Delete) + **Arrange ▸ / Combine ▸ / Select ▸ / Cursor ▸** (Decision 11).
- **Arrange** panel (was 3D Cursor) with a toolbar button; Array gets a count/spacing dialog.
- **Print panel:** Printer / Validation / Export tabs + readiness strip (§4.3).
- **Onboarding:** first-run 4-step coach (Import → Arrange → Colour → Print), replayable from **?**; one unified empty-state sentence.

### 4.7 Viewport interaction model

| Area | Target behaviour | Borrowed from |
|---|---|---|
| Selection | click/double-click/Esc scope rule; Shift add, Ctrl toggle; marquee by combined AABB centre of topmost-below-scope nodes; `A` at scope; locked nodes selectable but not transformable; hidden never pickable | Figma, Keynote, Tinkercad |
| Hover | subtle outline on hover (third channel of `SelectionOutline` mask), ≤1 pick/frame, off above 70 % triangle budget; cursor changes over draggable body | Tinkercad, Spline, Shapr3D |
| Transform | gizmo Move/Rotate/Scale; G/R/S modal with axis/plane locks, typed mm/deg/×, Ctrl-snap; gizmo drags Ctrl-snap; snap steps in **mm** (translate 1 mm default); body drag on ground plane; arrow keys nudge 1 mm (Shift 10, Alt 0.1); Size (mm) and Scale XYZ on the node; Scale (nominal) per §3.5 | Blender, Tinkercad, Fusion |
| Snapping | Ctrl-snap only; Arrange verbs for exact placement; surface/vertex snap deferred | Blender, Tinkercad |
| Pivot / orientation | toolbar dropdown (Active / Median / Cursor / World), `.` cycles; Local/World | Blender |
| Camera | RMB orbit, MMB pan, wheel zoom **to cursor** (default on), NavCube, numpad/Alt presets, F frame, **Home frame all**, ortho; follow modes kept | Fusion, Shapr3D, Bambu |
| Display modes | Shaded / Matte (default) / Base colour / UV checker (all four exist today in `src/ui/ViewportToggles.js:40-45`; unchanged, no task); overlays wireframe, inverted faces, **grid, axes, bed volume, cross-section** as viewport toggles | Blender, Bambu |
| Cross-section | viewport toggle + Scene panel; furniture hidden in exports (unchanged) | Bambu, PrusaSlicer |
| Cursor | Shift+RMB places; cursor ops undoable; cursor sub-section inside Arrange | Blender |
| Measurement | HUD W×D×H + tris refreshed on `TRANSFORM_COMMITTED`; Properties Size (mm); two-point measure optional (Decision 23) | Bambu |
| Drops | ground-pick position; multi-file drops staggered along X; dedupe prompt | Tinkercad |
| Undo | every command label localised; cursor ops and collection edits removed/undoable; Undo/Redo buttons; target-list edits undoable | Figma |
| Feedback | 2 s toast for silent multi-object changes (swatch "Applied to N objects", workspace jump with "back"); progress overlay Cancel where abortable | Spline |

### 4.8 Mockups

```
Scene objects                        [⌕ filter… file:] [≡ parts]
 ▾ ⧉ tank.glb               👁 🔒 🖨    ← Group (from file), first click selects it
    ▸ ▣ hull    (2 mats)    👁 🔒 🖨    ← Object with hidden material parts
      ▣ turret              👁 🔒 🖨
    ▾ ⧉ wheels              👁 🔒 🖨    ← sub-group
         ▣ wheel.L          👁 🔒 🖨
         ▣ wheel.R          👁 🔒 🖨
   ▣ base                   👁 🔒 🖨    ← single-object file: no wrapper

┌───────────────────────────────────────────────┐   Properties ▸ Object (all workspaces)
│ [NavCube]  Scene › tank.glb › wheels [Esc]    │    Name     [ hull                 ]
│            (wheel.L hover-outlined)           │    Visible (●)  Print (●)  Locked ( )
│                                               │    Source   Linked · tanks/tank.glb  [Refresh][Find…]
│   [Move][Rot][Scale] | Pivot ▾ | [Arrange ▾]  │    File units [Millimetres ▾] Imported as 1:35 [Looks right]
└───────────────────────────────────────────────┘   Properties ▸ Transform: Scale [1:35 ▾] Set | Convert…
```

### 4.9 Design workflow (Stitch)

Google Stitch (CLI `stitch` 0.11.1, signed in; skill at `C:\Users\DCT\.claude\skills\stitch\`) is used as a **mockup and variant-exploration tool**, never as a code generator. Verified on this machine 2026-10-14:

- Capturing the Vite **dev** server is broken (Stitch inlines Vite's HMR wrappers instead of CSS → unstyled). Capturing the **production** build is faithful: `npm run build` → `npx vite preview --host 127.0.0.1 --port 5180 --strictPort` → `stitch capture browser --url http://127.0.0.1:5180/ -o <scratch>/x.html --json`. Port 4173 (the `package.json` preview default) is EACCES-reserved by Windows here, so the recipe passes `--port 5180` and never edits `package.json`.
- The Babylon WebGL viewport is **not** captured (blank washi background); CSS chrome (NavCube, toolbars, panels, empty state) is captured well.
- Workspaces and tabs switch via in-memory state, not routes: each non-default view is driven with `chrome-devtools` (`take_snapshot`, `click`) and captured with `stitch capture browser --page 1 -o … --json` (or a `--prepare` script kept **outside** the repo, e.g. in the scratchpad).
- Stitch's default output dir `.stitch/` and `.stitch.json` land in the repo root → gitignored before any real use (task 0.13b).
- Uploads go to Google: capture **empty or fixture scenes only** (`tests/fixtures/open-tetra.glb`, `tests/fixtures/textured-quad.glb`), never owner models, thumbnails or `.mixo` data (Decision 30).

**Where Stitch helps (mockup + 1–5 variants under the bound design system; `--creativeRange REFINE|EXPLORE|REIMAGINE`, `--aspects LAYOUT,COLOR_SCHEME,TEXT_CONTENT,…`):** header with Import/Export/Undo/? (5.1); tiered context menu and its submenus (3.5); Outliner with group rows, breadcrumb, Enter/Exit group (3.3, 3.4, 3.6); Print panel Printer tab, "Export for <printer>" / "Print at" / Advanced, readiness strip, per-size cost lines (0.6, 1.2, 1.3); the Scale control with *Set scale* / *Convert…* and the effective-scale line (1.13); first-run coach and empty states (5.5); asset Source words, Project/Folders tabs, card menu, Sources modal, boot banner, name-clash display (4.6, 4.7, 4.8); Properties ▸ Object in every workspace and the Scene Advanced disclosure (5.2, 5.4); viewport **chrome** toggles and the Arrange panel (0.7, 5.7); Print polish (5.3).

**Where it does not help (spec stays textual, verified by smoke + eyeball):** anything drawn by Babylon — the viewport, gizmo, selection/hover outline, 3D cursor, cross-section fill, bed grid (Phase 2, 3.1, 3.2, 5.6, 5.8–5.10) — plus every pure-logic task.

**Rules.** (1) Generated HTML/Tailwind is a **reference picture only**: every screen is re-implemented with the existing tokens (`src/styles/tokens.css`, `src/styles/blender.css` `--ctl-*`) and the locked washi/sumi/stone-brown/bengara palette; nothing is pasted (Decision 31). (2) With the design system bound, generation prompts omit hex codes, fonts and radii so `DESIGN.md` governs (Decision 29). (3) Binding a Stitch project (`stitch config set project <id>`) and any batch upload need explicit owner approval per batch; `stitch generate screen` is never used to *import* existing views — real views are captured and uploaded. (4) **Mockup gate** (marked **· Mockup gate** on tasks in §8): before implementation, the owner approves a Stitch screen id (recorded in the task's commit message, "Mockup: <project-id>/<screen-id>"); after implementation, a local `stitch` review per `flows/review.md` (capture the production build, compare against `DESIGN.md`, no network, no upload) with no finding above *minor* is part of the acceptance. Mockup generation and prompting are main/opus judgement; captures are haiku mechanical.

---

## 5. Borrowed patterns

| Pattern | Source | Applied as | Why it fits hobbyist printers |
|---|---|---|---|
| Click whole group, double-click enters, Esc exits, breadcrumb | Figma frames; Keynote/PowerPoint groups | §4.5 | zero vocabulary |
| Multi-part file arrives as one movable thing | Tinkercad imports; Bambu object list | import group named after file | "I move the tank" |
| Object = print unit with hidden parts; explicit Separate/Merge | PrusaSlicer / Bambu | logical object kept, verbs renamed | slicer users know it |
| Rigid group node | SketchUp components, Blender empties | group `TransformNode` under pivot | kitbash rotation must not shear |
| Shift add / Ctrl toggle everywhere | Figma, SketchUp, Shapr3D, Tinkercad | unified modifiers | Blender is the outlier |
| Transform-lock keeps selection | Figma, Keynote | lock enforcement | plain meaning of "lock" |
| Self-contained file + explicit Find/Relink | Figma, Keynote, Fusion | embed-always + Source status | "copy vs link" in plain words |
| Printer-first export, recommended format, nothing hidden | Bambu printer preset; Fusion manufacture setup | §4.3 | "what does *my* printer want?" |
| Readiness strip always visible | Bambu slice status; Fusion warnings | Print header | "can I print this yet?" |
| Scale % + size in mm | Bambu, Prusa, Lychee, Tinkercad | Size (mm) stays; `×N` and `height mm` print sizes | universal units |
| Nominal scale ratio with explicit conversion | scale-model calculators (1:35↔1:48) | Scale = declaration; Convert = verb | the native noun of the audience |
| Multi-size export presets with suffix | Figma @1x/@2x | typed `exportTargets`, suffix tokens | one design, several outputs |
| Hover outline + cursor change | Tinkercad, Spline, Shapr3D | §4.7 | shows what is clickable |
| Zoom to cursor | Fusion, Shapr3D, Bambu | CameraRig option | expected from any slicer |
| Tiered context menu | Spline, Womp, Shapr3D | §4.6 | beginners stop after ~10 items |
| Arrange panel with named verbs | Tinkercad; Bambu Arrange / Lay on face | Arrange panel | print prep is placement |
| "Already in project" prompt | Figma components; Blender Asset Browser | §4.4 rule 2 | no five copies of a 200 MB scan |
| Qualified names only when ambiguous | VS Code tab titles | §4.4 rule 3 | names stay short |
| First-run coach marks | Spline, Womp, Nomad | 4-step tour | one-time, skippable |
| Workspaces = fixed task layouts | Blender 2.8+ (kept) | unchanged | already locked |

---

## 6. Decisions for owner

1. Groups become first-class selectable nodes with Figma/Keynote click-depth (overturns the 2026-08-03 rule). *Recommend accept.*
2. Collections leave the Outliner tree (tooltip + `file:` filter; schema kept). *Accept.*
3. Automatic directory hash-scan on load removed; "Find moved file…" explicit. *Accept.*
4. Boot prompts become one non-blocking banner (re-mount all + recover newer autosave). *Accept.*
5. Viewport Shift = add, Ctrl = toggle. *Accept.*
6. Properties ▸ Object visible in all four workspaces. *Accept.*
7. "Shader" → "Material" app-wide (strings only). *Accept.*
8. **RESOLVED — Mimaki 3DUJ-553 stays the default printer**; other families via printers.json v2 presets.
9. Lock = transform-lock (selectable; Delete asks). *Transform-lock.*
10. Stable per-folder browser keys + persisted desktop tokens. *Accept.*
11. Context-menu impossible items hidden in submenus, greyed in the primary tier. *Accept.*
12. `scopeId` session-only. *Session-only.*
13. printers.json v2 capability schema; presets set defaults/hints only. *Accept.*
14. New writers PLY + WRL; Bambu/Orca-flavoured 3MF next; Prusa `mmu_segmentation` deferred; no glTF export. *Accept.*
15. Settings scope: per-project = printer, bed, export format, OBJ axis, 3MF flavour, print sizes, reference object, bake-solids, split-by-material, individually; per-user = strict, repair-on-import, cost, look. *Accept.*
16. Re-import dedupe prompt, default "Add another copy". *Accept.*
17. Deterministic export texture names `<object>_<slot>.png`, case-insensitive. *Accept.*
18. Gate defaults: "Repair & export" default button; strict blocks unknown verdicts. *Accept.*
19. Security budget: CSP + `sandbox:true` + navigation guards; import caps 1 GB file / 256 zip entries / 2 GB uncompressed / 4× triangle budget. *Accept.*
20. `navigator.storage.persist()` on first save (web). *Accept.*
21. Thin-wall: advisory proxy now; real analysis deferred. *Proxy now.*
22. Hover highlight (perf-gated). *Accept.*
23. Two-point measure tool: Phase 7. *Defer.*
24. **Scale control splits "Set scale" (relabel) from "Convert to scale" (resize)** with `ratioSource`; relabel is the default when the scale was never declared (STL/OBJ). *Accept.*
25. **Export reference becomes explicit per-project state** (`print.referenceObjectId`, default first printable), never the active selection; mixed-scale scenes show a one-line note; uniform WYSIWYG scaling of a mixed kitbash is reaffirmed. *Accept.*
26. **Effective scale** = declared ratio ÷ uniform node scale drives the export factor, the "the size shown (1:36)" label **and the filename `ref` token** — filenames of hand-scaled objects change (truthfully); untouched objects keep their names. *Accept.*
27. **Typed print sizes** `asShown | ratio | factor | height-mm`; filename tokens `_r{ref}to{T}` (unchanged), `_x{N}`, `_h{N}mm`. *Accept.*
28. **Scale changes keep the object in place** (scale about its own origin; children keep intra-asset spacing); target-list edits become undoable commands. *Accept.*
29. **`DESIGN.md` lives at the repo root** (the only location the Stitch CLI finds without a gitignored `.stitch/` copy; listed in `Blueprint.md` §0.3), authored from `src/styles/tokens.css`/`src/styles/blender.css` and the locked palette; the capture recipe lives at `docs/design/stitch-capture.md`. *Recommend accept.*
30. **Uploads to Stitch are allowed only for empty or fixture scenes** (`tests/fixtures/*.glb`), never owner models, thumbnails or `.mixo` data; binding a project and every batch upload need explicit owner approval. *Recommend accept.*
31. **Stitch output is a reference picture, never code**: every mockup is re-implemented with the existing tokens and Blender control language; generated HTML/Tailwind is not pasted into `src/`. *Recommend accept.*
32. **RESOLVED (owner, 2026-10-14) — selecting a printer applies its profile; the user then changes freely; choosing the printer default again reverts.** Picking a printer in the select is an **apply-defaults action**: it sets export format, split-by-material, OBJ axis, 3MF flavour and bed to that profile's suggested defaults in one undo step (Ctrl+Z restores the previous values). The user may then change any of them. Choosing the same printer's default profile again — the explicit **Printer default ↺** action — reverts every override to the profile's defaults (also one undo step). The user's explicit choice stands until they revert; no format is ever hidden or blocked. `AGENTS.md:20-24` and rule 6 (`AGENTS.md:59-64`) are amended with the text in task 1.1, same commit.
33. **Amend `AGENTS.md` rule 7 (`AGENTS.md:65-67`)**: `logicalObjectId` (not `sourceGroupId`) is the linkage the validator and exporter re-union by; `sourceGroupId` is still stamped at split time but is migrate-only at runtime. Edited in the same commit as 2.7. *Recommend accept.*

---

## 7. Terminology (single source of truth; strings only, i18n keys unchanged)

| Today | Target | Where |
|---|---|---|
| Session / Library (assets) | **Project / Folders** | AssetPanel tabs |
| Linked / Snapshot | *(removed)* → Source: **Embedded copy · Linked · Changed on disk · Missing** | Properties ▸ Object, card chip |
| Print Part / Print Export / Include in print export | **Print** toggle, "Include when printing" | Properties, Outliner, Validation summary |
| Repair geometry / Repair all / Auto-Fix / Fix / Auto-fix and export | **Repair** · "Repair all (N)" · "Repair & export" | all sites |
| Source Unit / Authored Scale / Confirm | **File units** · "Imported as 1:72" · **Looks right** | Properties ▸ Object |
| Ratio (object) | **Scale** (value "1:72"; verbs *Set scale* / *Convert to scale*) | Properties ▸ Transform |
| Print Scale / As shown / Add ratio… / target ratio | **Print at** · "the size shown" · "Other sizes…" (1:X · ×N · N mm tall) | Print ▸ Export |
| Scene Scale (dead keys `print.sceneScale` `src/i18n/locales/en.json:131` and `print.sceneScaleHelp` `src/i18n/locales/en.json:133`; `print.custom` at `:132` is LIVE — `src/ui/PrintPanel.js:192`, `src/ui/PropertiesPanel.js:265`) | *(removed: those two keys only)* | — |
| Shader / Shader Library | **Material / Materials** | everywhere |
| Split to parts / Join into one object | **Separate by material / Merge into one object** | context menu |
| Internal part / Show internal parts | **Material part / Show material parts** | Outliner |
| 3D Cursor (drawer) | **Arrange** | drawer, toolbar |
| Mate to Active / Transform Swab / Smart Replace | **Snap to active / Copy placement from active / Replace with active** | Combine ▸ |
| Build Volume Preset / Bed (tab) | **Printer** (select) · **Build volume** · Printer tab | Print ▸ Printer |
| Transform group / Import collection / Mesh object | **Group / Object** | Outliner tooltips |
| Rot (rad) (material UV) | Rot (deg) | Materials editor |

---

## 8. Implementation plan (risk-first)

### Phase 0 — Safety net and quick wins · 14 tasks

**0.1 Terminology pass.** Files: `src/i18n/locales/{en,ja,zh-Hant}.json`; hard-coded strings `src/ui/AppShell.js:146-193`, `src/core/InputManager.js:673-695`, `src/ui/CopyPaste.js` ASPECTS. Behaviour: 0.1 owns exactly these §7 rows — Print Part/Print Export → Print; Repair/Auto-Fix/Fix → Repair; Source Unit/Authored Scale/Confirm → File units/Imported as/Looks right; Split to parts/Join → Separate by material/Merge into one object; Internal part → Material part; Mate/Transform Swab/Smart Replace → Snap to active/Copy placement from active/Replace with active; Transform group/Import collection/Mesh object → Group/Object; Rot (rad) → Rot (deg). NOT 0.1: Shader→Material (0.12), Scale/Print at (1.13/1.17), Scene Scale keys (1.10), 3D Cursor→Arrange (0.7), Build Volume Preset/Bed→Printer (1.2), Session/Library→Project/Folders + Source words (4.6); `status.defaultHint` matches `_defaultHint`. Accept: `npm run i18n:check` 0 gaps; smoke pins updated in the same commit. Tier: sonnet (≈6 files).

**0.2 Write hardening + persistent storage.** Files: `src/core/PersistenceManager.js:50-74`, `src/core/print/Download.js:8-36`. Behaviour: `w.abort()` on write failure; `pushRecent` failure after a successful write is reported but never rejects `save()`; non-Abort FSA errors toast before the anchor fallback; first successful save calls `navigator.storage.persist()` (web). Accept: `tests/persistence-saveas.test.mjs`, `tests/export.test.mjs` extended; `navigator.storage` stub. Tier: sonnet.

**0.3 Input hygiene.** Files: `src/core/InputManager.js:95`, `src/core/InputManager.js:201-205`, `src/core/InputManager.js:797-800`, `src/core/InputManager.js:811-814`; `src/ui/ContextMenu.js:203`, `src/ui/ContextMenu.js:216`, `src/ui/ContextMenu.js:230`; `src/ui/Outliner.js` (focus). Behaviour: viewport context when focus is on `body`, canvas or Outliner; Shift add / Ctrl toggle; remove `Tab`; delete Ctrl+S/N/O stubs; register F2, Ctrl+I, Home (frame all), L (lock); one Unparent. Accept: `tests/safety-commands.test.mjs` via `InputManager.__test`; smoke: Outliner row + `Delete`. Tier: sonnet.

**0.4 Electron reload / crash guard.** Files: `src/app/main.ts:130-139`, `electron/main.cjs:34-38`. Behaviour: `beforeunload` under Electron; `render-process-gone` → reopen dialog; `MIXO_SMOKE` bypass only outside production. Accept: `tests/electron-smoke.mjs` grep; headless predicate test. Tier: sonnet.

**0.5 Load-path integrity.** Files: `src/core/assets/AssetImport.js:172-187`, `src/core/PersistenceManager.js:118-146`, `src/core/persist/ProjectLoader.js:359-368`. Behaviour: `_importBegin` before any `await`; `open/openRecent` assert no import before the dirty confirm; failed `geometryFixes` replay removes the fix and toasts. Accept: `tests/persistence-load-guards.test.mjs` F20 window + replay-failure. Tier: sonnet.

**0.6 Readiness strip on every Print tab.** Files: `src/ui/PrintPanel.js:107-130`, `src/styles/components/print.css`. Accept: smoke strip "Ready" after the closed fixture. Deps: 0.13a + 0.13b. Tier: sonnet · **Mockup gate**.

**0.7 Arrange rename + toolbar button.** Files: `src/ui/CursorPanel.js`, `src/ui/ViewportToolbar.js`, locales. Accept: smoke: toolbar button opens `#cursor-panel`. Deps: 0.13a + 0.13b. Tier: sonnet (3 files) · **Mockup gate** (panel chrome only; the cursor itself is not captured).

**0.8 Texture capture failure surfaced.** Files: `src/core/assets/TextureCap.js:76-78`, `src/core/assets/TextureAssets.js:117`. Behaviour: `captureFailed` flag; export refuses to downscale (readback only when cap is Off, else abort naming the texture). Accept: `tests/texture-source.test.mjs`. Tier: sonnet.

**0.9 Undo/Redo buttons + reset-all confirm.** Files: `src/ui/StatusBar.js:15-30`, `src/ui/ProjectMenu.js:24-51`. Accept: smoke Undo after Duplicate. Tier: haiku.

**0.10 Case-insensitive texture export names.** Files: `src/core/print/ExportTextures.js:72-84`, `src/core/print/PrintPackaging.js:33-38`. Behaviour: lower-case uniqueness; writers receive the final name map. Accept: `tests/export.test.mjs`: `A.png`/`a.png` distinct with matching MTL/3MF references. Tier: sonnet.

**0.11 Autosave: reachable, keyed by id, cheap.** Files: `src/core/persist/Autosave.js:15-88`, `src/core/persist/ProjectSerializer.js:167-178`, `src/core/StateManager.js:7`, `src/app/main.ts:118-120`, `src/ui/ProjectMenu.js:201`. Behaviour: mints `project.id` (uuid) on new/open/migrate and persists it in state and the document (4.1 only formalises it in the schema); keys `autosave_<id>`; newer-than-`savedAt` autosave offered at boot (modal now, banner in 4.7); stored texture images not re-encoded; dirty/loading check wraps the whole build. Accept: `tests/persistence-load-guards.test.mjs`; `tests/persistence-abort.test.mjs`. Tier: opus.

**0.12 Shader → Material strings.** Files: three locale JSONs. Accept: i18n check; smoke pins. Deps: Decision 7. Tier: haiku.

**0.13a / 0.13b Stitch design-workflow setup (two tasks).** 0.13a (opus) authors `DESIGN.md`; 0.13b (haiku) does the gitignore, capture recipe, hygiene test and trial capture. Files: `.gitignore` (add `.stitch/` and `.stitch.json`); new `DESIGN.md` at the repo root (Decision 29) authored per the skill's six sections from `src/styles/tokens.css`, `src/styles/blender.css` (`--ctl-*` tokens, Blender control language) and the locked palette decisions (washi cream ground, sumi text, stone-brown accent, bengara active cue; silhouette `--accent-vibrant`), validated with `stitch status --flow=design --json` (`data.designMd.valid === true`); new `docs/design/stitch-capture.md` documenting the capture recipe (production build → `npx vite preview --host 127.0.0.1 --port 5180 --strictPort` → `stitch capture browser --url http://127.0.0.1:5180/ -o <scratch>/<view>.html --json`; workspace/tab switches via `chrome-devtools` + `--page 1`; fixture-only scenes; `--prepare` scripts live in the scratchpad, never in the repo); `Blueprint.md` §0.3 lists both files. Behaviour: no Stitch project is bound and nothing is uploaded in this task — binding and the first batch upload wait for the owner's go (Decision 30). Accept: `git status` clean after a trial capture into the scratchpad; `stitch status --flow=design --json` reports a valid `DESIGN.md`; `tests/hygiene.test.mjs` asserts `.stitch/` is gitignored. Deps: none; both must land before any task marked **Mockup gate** (the gate needs 0.13a's `DESIGN.md` for the review and 0.13b's gitignore/recipe for the capture). Tier: 0.13a opus · 0.13b haiku.

### Phase 1 — Printer strategy, export flow, scale model · 18 tasks

**1.1 printers.json v2 + loader.** Files: `src/config/printers.json`, `src/core/print/PrinterProfiles.js`, `src/core/printers/PrinterProfile.ts`, `src/export/ExportPipeline.ts` (imports it at `src/export/ExportPipeline.ts:2`) and `src/import/ImportPipeline.ts` (all three DELETED in this task so `npm run typecheck` stays green — the profile typedef moves into a JSDoc `@typedef` in `PrinterProfiles.js`), `AGENTS.md:20-24` + `AGENTS.md:59-64` (same commit — replace the printer paragraph with: "Printer profiles are data-driven via `src/config/printers.json` (display name, vendor, bed, colour capabilities, suggested export defaults, validation hints). Adding a printer = adding a JSON row. Selecting a printer APPLIES its suggested defaults (export format, split-by-material, OBJ axis, 3MF flavour, bed); the user may change any of them; **Printer default** reverts to the profile. Export remains an explicit OBJ / 3MF / STL / PLY / WRL choice that is always available." — and replace rule 6 with: "6. Export format is an explicit user choice. Selecting a printer APPLIES that printer's suggested profile defaults (export format, split-by-material, OBJ axis, 3MF flavour, bed) as one undoable step; the user may then change any of them, and choosing the printer's default profile again (**Printer default ↺**) reverts to those defaults. A profile may raise readiness hints but must never hide or disable a format. Export content still selects the representation: textured 3MF uses the Materials Extension; solid 3MF uses `<colorgroup>`; OBJ uses MTL + PNG when textures exist. Never collapse texture data merely because of a printer preset."), `tests/hygiene.test.mjs`, `tests/printer-profile.test.mjs`, `Blueprint.md` §12. Behaviour: §4.2 schema; `getPrinterProfile(id)` normalises v1 rows; rows for Mimaki ×2, Stratasys J55/J850, HP MJF 580, Bambu X1C/H2D/A1/A1 mini, Prusa MK4/XL, Creality K1/Ender-3, Elegoo Centauri/Saturn 4 Ultra, Anycubic Kobra 3/Photon Mono, Formlabs Form 4, Generic OBJ, Custom; all `verified:'unverified'` except Mimaki when the owner records it. Accept: hygiene validates every row; profile test covers v1 defaulting; `tests/hygiene.test.mjs` asserts `AGENTS.md` contains "Printer default" in rule 6 (so the amendment and the schema cannot drift apart). Deps: Decision 32 (resolved). Tier: sonnet.

**1.2 Printer tab.** Files: `src/ui/PrintPanel.js:812-889`, locales. Behaviour: tab renamed Printer; grouped select; build volume, colour sentence, recommended format; custom null axis shown as "unlimited" and reported by readiness. Accept: smoke: Bambu X1C → bed 256³ and the primary label "Export for Bambu Lab X1 Carbon (3MF)". Deps: 0.13a + 0.13b, 1.1. Tier: sonnet · **Mockup gate**.

**1.3 Export flow + settings scope.** Files: `src/ui/PrintPanel.js` (Scale tab folds into Export; the "Print at" row, the "Other sizes…" editor and the "Reference: … [change]" row + mixed-scale note, and the "the size shown (1:36)" effective-scale label — ALL PrintPanel UI for 1.15/1.16/1.17 lands here, after the approved mockup; options persisted), `src/core/print/ExportContext.js:47-51`, `src/core/print/ExportContext.js:131-144` (`prefs` carries `strictExport, splitByMaterial, individually, objBakeSolidTextures`), `src/core/print/PrintPipeline.js:525`, `src/core/SettingsStore.js:35-47`, `src/core/persist/ProjectSerializer.js:187`, `src/core/persist/ProjectLoader.js:146`, `src/config/default-settings.json`, `Blueprint.md` §11/§12. Behaviour: §4.3 layout; new `ApplyPrinterProfileCommand` (one undo step) runs on printer select and on **Printer default ↺**; profile-driven fields `exportFormat / splitByMaterial / objAxis / threeMFFlavour / bedDimensions` are per-project settings with a "modified" dot when they differ from the profile; primary button = `print.exportFormat` (seeded from `export.recommended`); all formats listed; scope per Decision 15; the "Auto-repair on import" checkbox STAYS on the Export tab until 5.5 delivers ? ▸ Preferences; every disk write through a dialog. Accept: `tests/export-context.test.mjs` (pipeline reads `ctx.prefs.strictExport`); `tests/settings-store.test.mjs` (scope split); smoke: Advanced toggles persist across re-render; smoke: select Bambu X1C → format 3MF; pick STL → "modified" dot + **Printer default ↺** visible; click it → format back to 3MF, dot gone; Ctrl+Z → STL again; `tests/export-context.test.mjs`: `ctx.prefs` reflects the overridden format, not the profile. Deps: 0.13a + 0.13b, 1.1, 1.15, 1.16, 1.17. Tier: opus · **Mockup gate** (one approved Export-tab screen covers 1.3, 1.15's reference row, 1.17's "Other sizes…" and 1.18's cost lines).

**1.4 Per-printer readiness hints.** Files: `src/core/print/PrintReadiness.js`, `src/core/MeshValidator.js` (new `thinFeature` advisory), `src/core/print/ExportTextures.js`, locales. Behaviour: codes `texture-too-large`, `texture-count`, `thin-feature` (Decision 21), `watertight-required` (error under strict). Accept: `tests/print-readiness.test.mjs`. Tier: sonnet.

**1.5 3MF: split-by-material parts, metadata, thumbnail, alpha.** Files: `src/core/print/ThreeMFWriter.js:170-211`, `src/core/print/ThreeMFWriter.js:242-272`, `src/core/print/ThreeMFWriter.js:331-405`; `src/core/print/PrintPipeline.js:591-611`; `src/core/print/PrintPackaging.js`. Behaviour: `prefs.splitByMaterial` → one `<object>` per material part under a `<components>` parent (default on for `per-part|paint`); `<metadata>` Title/Application/CreationDate; `Metadata/thumbnail.png`; colorgroup alpha from material alpha when `colour.alpha`. Deps: 1.1. Accept: `tests/threemf-materials-ext.test.mjs`, `tests/threemf-components.test.mjs`; owner eyeball in Bambu Studio / PrusaSlicer. Tier: opus.

**1.6 PLY + WRL writers.** Files: new `src/core/print/PlyWriter.js`, `src/core/print/WrlWriter.js`; `src/core/print/PrintFormats.js`; `src/core/print/PrintReadiness.js:4`; `src/ui/PrintPanel.js` buttons; `src/core/PrintManager.js`. Behaviour: PLY binary LE (`x y z nx ny nz r g b a` + `s t` when textured) through PrintSpace Z-up; vertex colour sampled bilinearly from the diffuse texture or material colour; WRL (VRML 2.0) `IndexedFaceSet` + `ImageTexture`/`Color`; mm. Accept: `tests/export.test.mjs` byte checks; trimesh reads both with volume +1000 (extend `tests/scan-probe.mjs`). Tier: opus.

**1.7 OBJ through PrintSpace with per-printer axis.** Files: `src/core/print/ObjWriter.js:48-60`, `src/core/print/PrintSpace.js`, `tests/print-space.test.mjs`. Behaviour: `toPrintSpace` then optional `yUp` remap per `export.obj.axis`; `printIndices` winding; verified empirically. Accept: print-space test; owner eyeball in the Mimaki tool. Deps: 1.1. Tier: opus.

**1.8 Gate tightening.** Files: `src/core/print/PrintPipeline.js:316-323`, `src/core/print/PrintPipeline.js:525-533`, `src/core/print/PrintPipeline.js:560-566`; `src/ui/PrintPanel.js:672-730`, `src/ui/PrintPanel.js:968`. Behaviour: Decision 18; acknowledgement enforced inside `_runExport`. Accept: `tests/export-gate.test.mjs`, `tests/export.test.mjs`. Tier: sonnet.

**1.9 Texture colour-space check.** Files: `src/core/print/ExportTextures.js:25-50`, `src/core/assets/TextureReadback.js:84`, `src/core/shaders/ColorSpace.js`. Behaviour: frozen source bytes verbatim; readback path converts linear→sRGB when the texture is flagged non-sRGB; new `tests/color-space.test.mjs`. Accept: that test + `tests/texture-readback.test.mjs`. Tier: sonnet.

**1.10 Dead export/scale code and settings removal.** Files: `src/core/print/ExportPlanner.js:1-20` (`buildExportPlan`), `src/core/print/PrinterProfiles.js` (whatever helpers 1.1's rewrite leaves without callers — no line range, the file is rewritten by 1.1), `src/core/scale/ScaleMath.js:45-48`, `src/core/scale/ScaleMath.js:73-76`, `src/core/scale/ScaleMath.js:95-99` (legacy readers), `× 1000` literals at `src/ui/PropertiesPanel.js:189`, `src/ui/PropertiesPanel.js:198`, `src/ui/PropertiesPanel.js:420`, `src/ui/PropertiesPanel.js:464` and `src/core/InputManager.js:686` (→ `BU_TO_MM` via `PrintManager`), the two dead keys `print.sceneScale` / `print.sceneScaleHelp` (`src/i18n/locales/en.json:131`, `src/i18n/locales/en.json:133` — NOT `print.custom` at `:132`, which is live), `src/config/default-settings.json` keys `printMode/chordTolerance/minWallThickness`, `src/core/SettingsStore.js:41`. Accept: lint; `tests/settings-store.test.mjs`, `tests/state-shape.test.mjs`, `tests/per-object-ratio.test.mjs` updated. Deps: 1.1. Tier: sonnet (≈10 files).

**1.11 Bambu/Orca-flavoured 3MF.** Files: `src/core/print/ThreeMFWriter.js` (flavour switch), new `src/core/print/ThreeMFBambu.js`. Behaviour: `p:UUID` + `requiredextensions`; `Metadata/model_settings.config` with parts and `extruder` from a material→slot map (first 4 colours → slots, rest warn); minimal `project_settings.config`; thumbnail; no per-triangle paint. Accept: `tests/threemf-bambu.test.mjs`; owner eyeball in Bambu Studio → record `verified`. Tier: opus.

**1.12 Blueprint §12 review-only consistency pass** (profiles, export flow, writers, scale model — each owning task already wrote its own §12 text; this pass only reconciles). Deps: every other Phase-1 task. Tier: haiku.

**1.13 Scale control: declare vs convert.** Files: `src/core/assets/AssetRegistration.js:168` (`ratioSource`), `src/core/commands/ScaleCommands.js:111-163` (new `SetScaleLabelCommand`; `RescaleObjectCommand` unchanged math), `src/ui/PropertiesPanel.js:250-292`, `src/ui/PropertiesPanel.js:333-344` (Scale row with *Set scale* / *Convert…* and a consequence line), `src/core/persist/ProjectSerializer.js`, `src/core/persist/ProjectLoader.js:332-336` (`ratioSource` default), locales, `Blueprint.md` §12. Behaviour: §3.5 #1; `ratioSource` = `'file'` when `modelRatio ≠ 1`, `'user'` after any explicit action, else `'default'`; default verb = relabel when `'default'`, convert otherwise; both undoable. Accept: `tests/properties-ratio.test.mjs` + `tests/per-object-ratio.test.mjs`: STL at 1:1 → "Set 1:72" leaves geometry untouched and sets `ratio=72, ratioSource='user'`; glTF at 1:72 → "Convert 1:35" rescales ×72/35. Deps: 0.13a + 0.13b, Decision 24. Tier: opus · **Mockup gate** (the approved Properties ▸ Transform screen also covers 1.16's effective-scale line).

**1.14 Rescale about the object's own origin.** Files: `src/core/commands/ScaleCommands.js:134-150`. Behaviour: top-level mesh position untouched; child local position scaled relative to its parent; logical parts handled as one unit (existing expansion). Accept: `tests/per-object-ratio.test.mjs`: object at x=0.1 BU converted 1:1→1:72 keeps x=0.1; child spacing scales. Deps: Decision 28. Tier: sonnet.

**1.15 Explicit export reference + mixed-scale note.** Files: `src/core/print/ExportContext.js:297-301` (read `state.print.referenceObjectId`, fallback first printable), `src/core/StateManager.js` + `src/config/default-settings.json` (`referenceObjectId: null`, per-project), `src/core/persist/ProjectSerializer.js` / `src/core/persist/ProjectLoader.js` (persist; drop when the object disappears), `src/core/print/PrintReadiness.js` (info code `mixed-scales`), locales. No PrintPanel edits here — the "Reference: … [change]" row and the note are built in 1.3 under its approved mockup. Behaviour: §3.5 #4; selection never changes the reference; `getExportReference` reflects state. Accept: `tests/export-context.test.mjs`: reference stable across selection changes; filename suffix stable; `tests/print-readiness.test.mjs` `mixed-scales`. Deps: Decision 25. Tier: opus.

**1.16 Effective scale.** Files: `src/core/scale/ScaleMath.js` (new `effectiveRatio(obj, mesh)`), `src/core/print/ExportContext.js:119` (use effective ratio of the reference), `src/ui/PropertiesPanel.js` (Scale row "×2.0 → prints as 1:36"). No PrintPanel edits here — the "the size shown (1:36)" label is built in 1.3 under its approved mockup; 1.16 exposes `effectiveRatio` for it. Accept: `tests/per-object-ratio.test.mjs`: node scale 2 on a 1:72 object → effective 36; export factor at target 72 = 36/72 × 1000. Deps: 1.13, Decision 26. Tier: sonnet.

**1.17 Typed print sizes + filename tokens + undoable edits.** Files: `src/core/scale/ScaleMath.js:66-71` (`exportTargetsFromState`), `src/core/print/PrintPipeline.js:344-353`, `src/core/print/PrintPipeline.js:398-400`; `src/core/print/ExportContext.js:120-123` (`target` object → `ratioFactor`: ratio = ref/T, factor = N, height = N / referenceHeightMM, where `referenceHeightMM` = the reference unit's print-space Z extent (bed-up axis, `PrintSpace`) at as-shown — "N mm tall" everywhere means print-space Z); `src/core/print/ExportPlanner.js:22-42` (`_r{ref}to{T}` unchanged; `_x{N}`; `_h{N}mm`); `src/core/print/PrintNaming.js:28-33`; new `ExportTargetCommands` in `src/core/commands/ScaleCommands.js` (the "Other sizes…" editor in `src/ui/PrintPanel.js:226-268` is rebuilt by 1.3 under its approved mockup; 1.17 keeps the existing pills working against the new state); `src/core/persist/ProjectLoader.js:189-196` (migration `exportRatios` → `exportTargets`, mirror for one minor); `src/core/SettingsStore.js:36-41` (comment), `tests/export.test.mjs` filename block. Accept: `tests/export.test.mjs`: targets `[ratio 144, factor 2, height 120]` on a 60 mm-tall 1:72 reference → three files `_r72to144`, `_x2`, `_h120mm` with factors 0.5, 2, 2; legacy doc with `exportRatios:[144]` loads as `[{kind:'ratio',value:144}]`; add/remove targets undo. Deps: Decision 27. Tier: opus.

**1.18 Per-target cost lines.** Files: `src/ui/print/CostBlock.js:285-310`. Behaviour: one cost line per print size when several (each via `previewExportContext({targetIndex})`). Accept: smoke: two targets → two cost rows. Tier: sonnet.

### Phase 2 — Hierarchy core · 7 tasks

**2.1 Selection accepts group ids.** Files: `src/core/Selection.js`, `src/core/LogicalObjects.js`, `Blueprint.md` §4b. Behaviour: `set/add/toggle` accept group ids; `_resolve` returns `{id,node,kind}`; `getSelectedResolved()` unchanged; new `getSelectedNodes()`. Accept: new `tests/selection-groups.test.mjs`. Tier: opus.

**2.2 Pivot attaches group nodes rigidly.** Files: `src/core/scene/PivotSession.js:175-238`, `src/core/commands/TransformCommands.js`, `src/core/commands/support.js`, `src/core/InputManager.js:319-399`. Behaviour: nodes (mesh or group) under the pivot; snapshots keyed by node id; pivot = AABB centre of selected geometry. Accept: `tests/history-pivot.test.mjs` extended. Tier: opus.

**2.3 Group creation semantics + persistence.** Files: `src/core/commands/ParentCommands.js:168-271`, `src/core/persist/ProjectSerializer.js:225-233`, `src/core/persist/ProjectLoader.js:76-117`. Behaviour: parent = common ancestor; name uniquified; origin = bottom-centre AABB; transform round-trips. Accept: `tests/hierarchy.test.mjs`. Tier: sonnet.

**2.4 Ungroup on selected groups; Delete/Duplicate accept groups.** Files: `src/core/commands/ParentCommands.js:277-368`, `src/core/commands/HierarchyCommands.js:171-303`, `src/core/InputManager.js:760-777`, `src/ui/ContextMenu.js:544-560`. Accept: `tests/hierarchy.test.mjs`. Tier: sonnet.

**2.5 Lock enforcement.** Files: `src/core/Selection.js`, `src/core/scene/PivotSession.js`, `src/core/InputManager.js`, `src/ui/PropertiesPanel.js`, `src/core/commands/HierarchyCommands.js:52-72`. Accept: `tests/safety-commands.test.mjs`. Tier: sonnet.

**2.6 Logical-object edge cases.** Files: `src/core/commands/ParentCommands.js:416-530`, `src/core/MeshValidator.js:513-518`, `src/core/print/ExportContext.js:167-190`, `src/core/commands/HierarchyCommands.js:363-382`. Behaviour: Split names `.001` + group `<lead> parts`; Join reparents parts; dedupe by `canonicalObjectId`; `PrintPartCommand` expands to parts. Accept: `tests/split-join.test.mjs`, `tests/validator-group.test.mjs`, `tests/export-context.test.mjs`. Tier: sonnet.

**2.7 Retire runtime reads of `sourceGroupId`.** Files: `src/core/LogicalObjects.js:29`, `src/core/LogicalObjects.js:47`; `src/core/MeshValidator.js:140-151`, `src/core/MeshValidator.js:332-335`; `src/core/commands/HierarchyCommands.js:330-345`; `src/core/assets/AssetRegistration.js:111`, `src/core/assets/AssetRegistration.js:162`; loader seed. `AGENTS.md:65-67` (rule 7 amended per Decision 33, same commit). Accept: `tests/logical-objects.test.mjs`. Deps: Decision 33. Tier: sonnet.

### Phase 3 — Hierarchy UI · 7 tasks

**3.1 Import rule: multi-object file → group named after the file.** Files: `src/core/import/ImportHierarchy.js:68-160`, `src/core/assets/AssetImport.js:235`, `src/core/assets/AssetImport.js:330`, `src/core/assets/AssetRegistration.js:93-189`, `Blueprint.md` §8. Accept: `tests/split-on-import.test.mjs`, `tests/library-import.test.mjs`; smoke group count. Tier: sonnet.

**3.2 Scope + click-depth.** Files: `src/core/Selection.js` (`scopeId`), `src/core/InputManager.js:190-237`, `src/core/SceneManager.js:647-669` (`pickSelectionTargetAt`), `src/core/BoxSelect.js:54-67`, `src/core/events.js` (`SCOPE_CHANGED`), `Blueprint.md` §4b/§6. Behaviour: §4.5; double-click = two POINTERDOWNs < 350 ms / < 4 px; Esc priority modal > marquee > scope. Accept: `tests/selection-groups.test.mjs`; smoke double-click. Tier: opus.

**3.3 Breadcrumb + status hint.** Files: new `src/ui/ScopeBreadcrumb.js`, `index.html`, `src/styles/components/viewport.css`. Accept: smoke breadcrumb text. Deps: 0.13a + 0.13b. Tier: sonnet · **Mockup gate** (breadcrumb chrome; the highlighted mesh is not captured).

**3.4 Outliner: group rows selectable, collections demoted.** Files: `src/ui/Outliner.js:110-171`, `src/ui/Outliner.js:241-268`, `src/ui/Outliner.js:703-739`, `src/ui/Outliner.js:781-788`; locales. Accept: smoke `aria-selected` on group row; `tests/hierarchy.test.mjs` cascade. Deps: 0.13a + 0.13b, Decision 2. Tier: sonnet · **Mockup gate**.

**3.5 Context menu tiering + Enter/Exit group + collection items removed.** Files: `src/ui/ContextMenu.js:114-262`, `src/ui/ContextMenu.js:587-619`; `src/styles/components/context-modal.css`; locales. Behaviour: §4.6; Rename triggers Outliner inline rename. Accept: smoke pins ≤ 16 top-level entries with one object selected (≤ 12 primary items + the 4 submenu headers); submenu opens. Deps: 0.13a + 0.13b. Tier: sonnet · **Mockup gate** (open the menu via `chrome-devtools` before `--page 1` capture).

**3.6 Properties with a group active.** Files: `src/ui/PropertiesPanel.js:112-148`, `src/ui/PropertiesPanel.js:211-242`. Accept: smoke group name + Pos X edit moves the node. Deps: 0.13a + 0.13b. Tier: sonnet · **Mockup gate**.

**3.7 Blueprint §5/§13 review-only consistency pass + command labels via `t()`.** Files: `src/core/commands/*.js` labels, `Blueprint.md` (reconcile only). Tier: haiku.

### Phase 4 — Asset model and name clashes · 10 tasks

**4.1 Schema 3.4 + real `migrate()`.** Files: `src/core/persist/constants.js`, `src/core/persist/ProjectLoader.js:121-126`, `src/core/persist/ProjectSerializer.js:76-163`, `src/core/persist/ProjectValidator.js`, `src/core/StateManager.js:7`, `Blueprint.md` §11. Behaviour: bumps `SCHEMA_VERSION` to 3.4; adds `source` + `displayName` (asset) and formalises `project.id` (minted by 0.11); turns `migrate()` into a real ladder that CALLS the per-field migrations owned by 1.13 (`ratioSource`), 1.15 (`referenceObjectId`), 1.17 (`exportTargets`) and 2.7 (`logicalObjectId` seed) — 4.1 owns no field beyond `source`/`displayName`; keeps legacy keys on write for one minor; newer-minor docs preserve unknown top-level keys. Accept: `tests/persistence.test.mjs` (3.3→3.4; 3.4 round-trip; legacy resolve). Deps: 1.13, 1.15, 1.17, 2.7. Tier: opus.

**4.2 Adapter `resolveAsset / persistRef / restoreRef / findMoved`, desktop persistence.** Files: `src/core/storage/StorageAdapter.js`, `src/core/storage/DesktopStorageAdapter.js`, `src/core/persist/AssetResolver.js`, `src/core/assets/DirMounts.js`, `electron/OpaqueFileRegistry.cjs`, `electron/main.cjs`, `electron/preload.cjs`, `electron/KvStore.cjs`. Behaviour: §4.4; stable keys; desktop tokens re-validated; `watchFiles` declared false until implemented. Accept: `tests/storage-adapter.test.mjs` conformance against both impls; `tests/opaque-file-registry.test.mjs`; `tests/persistence.test.mjs` tiers. Tier: opus.

**4.3 Explicit "Find moved file…".** Files: `src/core/persist/AssetResolver.js:18-35` → adapter `findMoved`; `src/ui/AssetPanel.js` card menu; `src/ui/PropertiesPanel.js` Source row. Accept: load never scans; `findMoved` progress test. Deps: 4.2, Decision 3. Tier: sonnet.

**4.4 Route remaining FSA/idb calls + boot gate.** Files: `src/core/PersistenceManager.js:57`, `src/core/PersistenceManager.js:88`, `src/core/PersistenceManager.js:124`, `src/core/PersistenceManager.js:177`; `src/core/persist/ProjectLoader.js:494`; `src/ui/ViewportDrop.js:62`, `src/ui/ViewportDrop.js:129-130`; `src/core/print/Download.js`; `src/ui/AssetPanel.js:225`; `src/app/main.ts:41`; `src/core/storage/DesktopStorageAdapter.js`. Accept: spies prove adapter use; `npm run test:electron` (headful, `MIXO_SMOKE=save`). Deps: 4.2. Tier: opus.

**4.5 `RelinkAssetCommand`.** Files: new `src/core/commands/AssetCommands.js`, `src/core/persist/ProjectLoader.js:491-532`, `src/core/assets/AssetRestore.js`, `src/core/assets/ObjSiblings.js`. Accept: `tests/persistence.test.mjs` relink → new hash embedded; undo restores. Deps: 4.2. Tier: sonnet.

**4.6 Source status, Properties row, Project/Folders tabs, card menu, one Sources modal.** Files: `src/core/persist/ProjectLoader.js:236-312`, `src/core/persist/ProjectLoader.js:330`, `src/core/persist/ProjectLoader.js:388`; `src/ui/PropertiesPanel.js`; `src/ui/AssetPanel.js:444-495`, `src/ui/AssetPanel.js:636-670`; `src/ui/ProjectMenu.js:217-296`; `src/ui/ContextMenu.js:207-209`; locales. Accept: smoke Source "Embedded copy"; `tests/persistence.test.mjs` status values. Deps: 0.13a + 0.13b. Tier: sonnet · **Mockup gate** (Properties ▸ Source row, Project/Folders tabs, card menu, Sources modal — one approved screen set).

**4.7 Boot banner (re-mount all + recover).** Files: new `src/ui/BootBanner.js`, `src/ui/AssetPanel.js:136-231`, `src/core/persist/Autosave.js`, `src/ui/ProjectMenu.js:201`, `src/app/main.ts:118-120`, `src/core/persist/RecentProjects.js:23-24`. Accept: `tests/persistence-load-guards.test.mjs`; smoke banner. Deps: 0.13a + 0.13b, Decision 4. Tier: sonnet · **Mockup gate**.

**4.8 Name-clash rules.** Files: `src/core/assets/AssetImport.js:172-187` (`findByHash` + prompt), new `src/core/assets/DisplayNames.js`, `src/core/assets/TextureAssets.js:156-159`, `src/ui/AssetPanel.js`, `src/ui/Outliner.js`, `src/core/print/ExportTextures.js:72-84`, `src/core/print/ObjWriter.js:198`, `src/core/print/ThreeMFWriter.js:355-357`, `src/ui/ViewportDrop.js:141-171`, locales. Accept: new `tests/display-names.test.mjs`; `tests/library-import.test.mjs`; `tests/export.test.mjs` (`<object>_<slot>.png`, references match). Deps: 0.13a + 0.13b, 4.1, Decisions 16–17. Tier: opus · **Mockup gate** for the display parts only (qualified names on cards/rows, the "already in project" prompt); the hashing/export-naming logic is ungated.

**4.9 Dead code + registry growth.** Files: `src/core/assets/DirMounts.js:50-67`, `electron/OpaqueFileRegistry.cjs:43`, `restoreDirectory`, `pickOpen/pickSave`, duplicate `SESSION_KEY` constants, `ProjectValidator` `OBJECT_FIELDS 'scene'`. Accept: lint; listing twice yields same tokens. Tier: sonnet (≈6 files).

**4.10 Blueprint §11 review-only consistency pass + ADR 0001 addendum + HANDOFF pointer.** Tier: haiku.

### Phase 5 — Shell, viewport, onboarding · 10 tasks

**5.1 Header: Import / Export / Undo / Redo / ?; reset-all under ? with confirm.** Files: `src/ui/ProjectMenu.js:24-51`, `index.html:40-57`, `src/styles/components/project.css`, `src/core/InputManager.js`. Accept: smoke `#btn-import` triggers `ViewportDrop.promptImport`. Deps: 0.13a + 0.13b. Tier: sonnet · **Mockup gate**.

**5.2 Properties ▸ Object in all workspaces.** Files: `src/styles/layout.css:378-409`, `src/ui/PropertiesPanel.js`. Accept: `scripts/ui-screenshot.mjs` four captures; `PROBE=1`. Deps: 0.13a + 0.13b, Decision 6. Tier: haiku · **Mockup gate** (four workspace captures via `chrome-devtools` + `--page 1`).

**5.3 Print panel polish + Cost ⚙ popover.** Files: `src/ui/PrintPanel.js`, `src/ui/print/CostBlock.js:63`, `src/ui/print/CostBlock.js:199-203`. Accept: smoke pins "Print at: the size shown". Deps: 0.13a + 0.13b. Tier: sonnet · **Mockup gate**.

**5.4 Feedback toasts + Scene Advanced disclosure.** Files: `src/ui/ShaderPanel.js:727-737`, `src/ui/ShaderPanel.js:788-796`; `src/ui/PrintPanel.js:90-99`, `src/ui/PrintPanel.js:787`; `src/ui/ScenePanel.js:317-390`; locales. Accept: smoke toast text. Deps: 0.13a + 0.13b. Tier: sonnet · **Mockup gate** for the Scene Advanced disclosure only; toasts are ungated.

**5.5 Onboarding coach + ? sheet + Preferences.** Behaviour: also moves the "Auto-repair on import" checkbox from the Export tab into ? ▸ Preferences (`src/ui/PrintPanel.js:606`). Files: new `src/ui/Onboarding.js`, `src/ui/PrintPanel.js:606`, new `src/styles/components/onboarding.css` (imported from `src/styles/components.css`), `index.html`, locales; `localStorage mx-onboard-v1`. Accept: smoke overlay/skip/reopen. Deps: 0.13a + 0.13b. Tier: sonnet · **Mockup gate** (all four coach steps + the ? sheet; `REIMAGINE` variants welcome here).

**5.6 Viewport interaction upgrades.** Files: `src/core/scene/SelectionOutline.js` (hover channel), `src/core/InputManager.js:148-159` (hover throttle, arrow nudge), `src/core/scene/PivotSession.js` (gizmo Ctrl-snap), `src/config/default-settings.json:50` + `src/core/InputManager.js:594-601` (snap in mm), `src/core/scene/CameraRig.js:151-154` (zoom-to-cursor), `src/ui/ViewportToolbar.js:27-38` (dropdowns), `src/ui/ViewportDrop.js:167` (stagger), `src/ui/MeshStats.js:44-58`, `src/ui/CursorPanel.js:97` (Array dialog). Accept: `tests/box-select.test.mjs`; new `tests/snap-units.test.mjs`; smoke hover flag; eyeball. Deps: Decision 22. Tier: opus.

**5.7 Viewport toggles for grid/axes/bed/cross-section.** Files: `src/ui/ViewportToggles.js:34-99`, `src/ui/ScenePanel.js:430-449`. Accept: smoke toggle flips `state.scene.section.enabled`. Deps: 0.13a + 0.13b. Tier: sonnet · **Mockup gate** (toggle strip only; the overlays themselves are not captured).

**5.8 Progress Cancel + modal queue.** Files: `src/ui/ProgressOverlay.js:31-38`, `src/ui/Modal.js:85`. Accept: `tests/progress-overlay.test.mjs`; modal-queue test. Tier: sonnet.

**5.9 Undoable cursor ops; remove collection edits.** Files: `src/core/CursorTools.js:33-66`, `src/ui/ContextMenu.js:587-619`. Accept: `tests/safety-commands.test.mjs`. Tier: haiku.

**5.10 Blueprint §13/§13b/§6 review-only consistency pass.** Tier: haiku.

### Phase 6 — Hardening and maintenance · 13 tasks

**6.1 Electron security: CSP, sandbox, navigation guards.** Files: `electron/main.cjs:25-29`, `index.html:22`, `index.html:123` (inline scripts → modules), `vite.config.ts`, `electron/preload.cjs`. Behaviour: `sandbox:true`; `will-navigate` + `setWindowOpenHandler` deny; permission handler deny-all; CSP `default-src 'self'; img-src 'self' data: blob:; worker-src 'self' blob:`. Accept: `npm run test:electron`; build + browser smoke green under the CSP. Deps: Decision 19. Tier: opus.

**6.2 Dialog IPC via descriptors.** Files: `electron/main.cjs:104-105`, `electron/preload.cjs:32-33`, `src/core/storage/DesktopStorageAdapter.js`. Behaviour: renderer passes `{suggestedName, filters}`; main returns a token; `fs:writeRef` accepts tokens from `dialog:save` only, size-capped. Accept: `tests/opaque-file-registry.test.mjs`. Tier: sonnet.

**6.3 Boolean gate covers every texture slot.** Files: `src/core/commands/BooleanCommands.js:23`, `src/core/BooleanService.js:97-113`. Accept: `tests/boolean-service.test.mjs`. Tier: haiku.

**6.4 Import limits + validation-worker timeout.** Files: `src/core/assets/AssetImport.js:172-180`, `src/core/ThreeMFLoader.js:534`, `src/core/ValidateWorker.js:14-20`, `src/core/MeshValidator.js:115-122`. Behaviour: Decision 19 caps; zip entry/uncompressed limits; worker timeout 120 s with inline fallback. Accept: `tests/threemf-components.test.mjs`, `tests/validation-cache.test.mjs`. Tier: sonnet.

**6.5 Escaping test.** Files: new `tests/render-safe.test.mjs`. Tier: haiku.

**6.6a–6.6g Headless coverage, one task per module** — 6.6a `src/core/scene/PivotSession.js`, 6.6b `src/core/commands/ParentCommands.js`, 6.6c `src/core/commands/TransformCommands.js`, 6.6d `src/core/persist/AssetResolver.js`, 6.6e `src/core/persist/ProjectValidator.js`, 6.6f `src/core/print/PrintPackaging.js`, 6.6g `src/core/assets/TextureCap.js` (each with the `tests/env.mjs` shims; parallelisable). Accept: ≥ 5 asserts each; `npm test` green. Tier: sonnet ×7.

**6.7 Blueprint §0.3 file-layout review-only pass + BUILDLOG entry.** Tier: haiku.

### Phase 8 — Responsive + touch (owner-approved 2026-10-14) · 8 tasks

Goal: phone = simple read-only viewer; iPad = full app. All iOS/iPadOS browsers are WebKit, so AGENTS rule 5 gains a Safari (WebKit) exception and the browser gets a storage tier without File System Access (OPFS project store + file-input import + download export).

**8.1 AGENTS rule 5 + capability gate.** Files: `AGENTS.md` rule 5 (same commit), `src/core/storage/capabilities.js`, `src/app/main.ts` boot gate. Behaviour: Chrome/Edge = full desktop; Safari/WebKit (iPad, iPhone) allowed with the touch/OPFS tier; other browsers still blocked. Accept: capabilities test per UA. Tier: sonnet.
**8.2 OPFS storage adapter tier.** Files: new `src/core/storage/OpfsStorageAdapter.js`, `StorageAdapter.js` selection. Behaviour: projects + autosave in OPFS; import via `<input type=file multiple>`; export via download/share sheet; refs are embedded-only (no live links, status 'embedded'). Accept: storage-adapter conformance suite runs against the OPFS impl (stubbed). Tier: opus.
**8.3 Layout breakpoints.** Files: `src/styles/layout.css`, shell/panel CSS. Behaviour: ≥ 1024 px tablet landscape = full layout with panels as slide-over sheets when narrow; < 768 px = viewer layout (viewport full-screen, bottom sheet for object info). Accept: `scripts/ui-screenshot.mjs` captures at 1366×1024, 1024×768, 390×844. Tier: sonnet · Mockup gate (tablet + phone frames).
**8.4 Touch camera + selection.** Files: `src/core/scene/CameraRig.js`, `src/core/InputManager.js`. Behaviour: one-finger orbit, two-finger pan/pinch zoom, tap select, double-tap enter group, long-press = context menu. Accept: pointer-event unit tests. Tier: opus.
**8.5 Touch gizmo + transforms (iPad).** Files: `src/core/scene/PivotSession.js`, gizmo sizing. Behaviour: larger handles on coarse pointers, numeric entry sheet for precise moves. Tier: sonnet.
**8.6 Phone viewer mode.** Files: new `src/ui/ViewerMode.js`. Behaviour: open .mixo / GLB / 3MF read-only, object list + info sheet (name, size mm, scale), no editing/export. Tier: sonnet · Mockup gate.
**8.7 PWA install + offline.** Files: manifest, service worker (vendored assets cached). Tier: sonnet.
**8.8 Blueprint + ADR 0001 addendum (WebKit/OPFS tier).** Tier: haiku.

### Phase 7 — Deferred (unscheduled)

7.1 Prusa `slic3rpe:mmu_segmentation` + Bambu per-triangle `paint_color` (needs a face-paint tool) · 7.2 HP MJF / PolyJet real-slicer verification (owner records `verified`) · 7.3 two-point measure tool · 7.4 `watchFiles` desktop watcher → auto "Changed on disk" · 7.5 `caps.externalTools` + `src/core/tools/ToolAdapter.js` typedef (Blender sidecar seam, no callers) · 7.6 surface/vertex snapping · 7.7 per-section workspace expand presets · 7.8 multi-slot texture export (normal / roughness maps — no listed printer consumes them for colour; diffuse-only stays by design).

### Dependency graph and order

```
0.1–0.13b independent (0.11 before 4.7; 0.13a + 0.13b before every task marked Mockup gate: 0.6, 0.7, 1.2, 1.3, 1.13, 3.3–3.6, 4.6–4.8, 5.1–5.5, 5.7)
1.1 → 1.2, 1.3, 1.5, 1.7 ; 1.2 → 1.4 → 1.8 ; 1.13 → 1.14, 1.16 ; 1.15, 1.16, 1.17 → 1.3 → 1.18 ; 1.5 → 1.11 ; every other Phase-1 task → 1.12
2.1 → 2.2 → 2.3 → 3.1 → 3.2 → 3.3 ; 2.1 → 2.4, 2.5 ; 2.6 → 2.7 ; 3.2 → 3.4 → 3.5 → 3.6 → 3.7
1.13, 1.15, 1.17, 2.7 → 4.1 → 4.2 → 4.3, 4.4, 4.5 → 4.6 → 4.7 ; 4.1 → 4.8 ; 4.2 → 4.9 → 4.10
5.1–5.10 after Phase 3 (5.6 after 3.2) ; 6.1–6.7 any time after Phase 0 (6.2 after 4.4)
```

Recommended order: 0 → 1 → 2 → 3 → 4 → 5 → 6. Phase 4's schema bump (4.1) lands after 1.13/1.15/1.17/2.7 so every new persisted field is final.

---

## 9. Risks and what not to do

Full register: Appendix B. Execution risks of this plan:

- **Selection invariant change (2.1)** — `getSelectedResolved()` keeps its mesh-only contract; run `npm run test:all` after 2.1 and 2.2.
- **Group transforms × export seam** — `PrintPrep.flattenWorld` bakes ancestor matrices; verify empirically (tetra inside a rotated group → trimesh +1000, PrusaSlicer manifold).
- **Scale semantics (1.13–1.17)** — as-shown output is byte-identical before/after (factor 1000 either way); only explicit ratio targets on hand-scaled objects change (effective scale) — pinned by `tests/export.test.mjs` before/after cases; filename tokens keep their format, and only hand-scaled objects get a different `ref` value (Decision 26).
- **New writers (1.6, 1.11) and OBJ axis (1.7)** are unverified in real slicers until the owner records a round-trip; rows stay `verified:'unverified'` and the UI says "(untested preset)".
- **Schema 3.4** — legacy keys kept on write for one minor; both directions tested (4.1).
- **Terminology renames** collide with smoke pins — update pins in the same commit.
- **CSP (6.1)** can break Babylon workers/blob URLs — ship behind a build flag first.
- **Electron tasks** are headless-unverifiable; each ends with `npm run test:electron` headful on the owner's machine.

**Do NOT:** build a slicer; let the printer preset hide, switch or block a format; reintroduce a global world rescale; downscale textures or freeze meshes; let OS paths into renderer state or `.mixo`; make the hash scan automatic again; replace bytes whose hash differs without a click; silently overwrite files; add a fifth workspace or repeat a specialist section; build dockable panels, a DAM, or cloud sync; plan the Blender sidecar beyond the `ToolAdapter` typedef; reason about axes/winding on paper; auto-merge material parts on import; rename the user's files on disk; scale objects of a mixed kitbash by different factors in one export (the assembly is the unit).

---

## 10. Contradiction check (tensions found while merging, and how they were resolved)

- **"Ratio → Scale ratio" (first plan) vs "Scale / Print at" (review).** Resolved: Properties field is **Scale**; Print tab row is **Print at**; §7 is the only terminology table; 0.1 excludes these strings, which land with 1.13/1.17.
- **Task 1.3 originally folded the Scale tab into "Print at: the size shown + Advanced: other sizes" with numeric ratios only.** Rewritten to depend on 1.15/1.17 (typed targets, explicit reference) — no layering.
- **Settings scope (Decision 15) listed `exportRatios`.** Now `exportTargets` + `referenceObjectId`; `src/core/SettingsStore.js:36-41` keeps both out of per-user settings.
- **Filename contract.** Token format `_r{ref}to{T}` kept for ratio targets and as-shown; new tokens only for the two new kinds (Decision 27). One deliberate value change: `ref` is the effective ratio (Decision 26), so a hand-scaled object's filename changes to its true scale; §3.5, 1.16, 1.17 and §9 all say so — the `export_filename_system` contract is extended, not broken.
- **Spec 2026-06-16 §3.6 "reference = active printable object (user-confirmed)".** The *uniform WYSIWYG* half is reaffirmed; the *active-selection* half is replaced by explicit state (Decision 25) because the audit showed the same button producing different files — flagged as a decision, not silently changed.
- **Spec §3.4 "dropdown change rescales".** Kept as *Convert*; *Set scale* added for the STL/OBJ case (Decision 24). The spec's "ratio is baked into pixels and kept as a number" invariant holds for Convert; Set changes only the number.
- **Decision 21 (thin-wall proxy) vs printers.json `validation.minWallMM`.** The field exists in v2 rows; only the check is a proxy until 7.x.
- **First plan's 1.10 removed `minWallThickness/printMode/chordTolerance`; review added dead ScaleMath readers and `×1000` literals.** Merged into one 1.10.
- **Appendix A rows 69 and 107** now say "Scale · Set/Convert (1.13)" and "Print at (1.17)"; Appendix B W1 closes via 1.3, 1.8, 1.13, 1.15, 1.16.
- **"Export for <printer>" primary button vs AGENTS rule 6.** Not compliant with the current rule text; Decision 32 (resolved) amends the rule in 1.1's commit — the primary shows the applied profile format, every other writer stays one click away.
- **Decision 8.** Mimaki default stands everywhere (printers.json v2 default row, default-settings, onboarding copy).
- **Stitch vs "keep the repository clean".** Stitch writes `.stitch/` and `.stitch.json` into the repo root by default; 0.13b gitignores both before any use, captures go to the scratchpad, and `--prepare` scripts never enter the repo (the skill's own rule). `DESIGN.md` at the root is the one tracked file (Decision 29) and is added to `Blueprint.md` §0.3 so M3 (Blueprint drift) is not re-opened.
- **Stitch vs the README preview recipe.** `npm run preview` defaults to port 4173, which is EACCES-reserved on this machine; the recipe passes `--port 5180` explicitly instead of editing `package.json` (no source change, README untouched).
- **Mockup gate vs "web build green at every task".** The gate adds a pre-implementation approval and a post-implementation no-network review; it never touches code, so the green-build rule is unaffected. Tasks that only change Babylon-drawn pixels (Phase 2, 3.1, 3.2, 5.6) stay textual because Stitch cannot capture the viewport.
- **Decision 31 vs AGENTS "Babylon-first / existing tokens".** Generated Tailwind is reference-only; implementation uses `src/styles/tokens.css` / `src/styles/blender.css` — compliant.
- **Task counts (final).** Independent audit 2026-10-14 (28 items) applied: 0.13 split into 0.13a/b, 6.6 split into 6.6a–g, 0.1 and 1.10 re-tiered to sonnet → totals in §1.
- **AGENTS conflicts surfaced, not papered over.** The plan previously claimed rule 6 "honoured"; `AGENTS.md:20-21` and `:59-64` say printers are bed-only and format is independent of the printer, and rule 7 (`:65-67`) requires `sourceGroupId` for re-union. Decision 32 is RESOLVED by the owner (apply-defaults / override / Printer-default-reverts; AGENTS text shipped in 1.1); Decision 33 stays open with its AGENTS edit in 2.7.
- **Field ownership.** `ratioSource` (1.13), `referenceObjectId` (1.15), `exportTargets` + migration (1.17), `logicalObjectId` seed (2.7), `project.id` (0.11) each have one owner; 4.1 bumps the version, adds `source`/`displayName` and wires `migrate()` to call them.
- **PrintPanel edits before the 1.3 mockup.** 1.15 and 1.17 no longer touch `PrintPanel.js`; all Export-tab UI lands in 1.3 under its approved mockup.
- **Auto-repair on import** stays on the Export tab until 5.5 ships ? ▸ Preferences (was wrongly moved in 1.3).
- **`print.custom` is live** (`src/ui/PrintPanel.js:192`, `src/ui/PropertiesPanel.js:265`); only `print.sceneScale` and `print.sceneScaleHelp` are dead and removed by 1.10.
- **Context-menu pin** is ≤ 16 top-level entries (12 primary + 4 submenu headers), matching §4.6.
- **Mimaki format list** now includes `ply` in printers.json v2, matching the §4.2 family table.
- **"N mm tall"** is defined once as print-space Z extent (§3.5, 1.17).
- **Filename `ref` token** = effective ratio (Decision 26): format unchanged, value changes only for hand-scaled objects; §3.5, 1.16, 1.17, §9 agree.
- **W5 diffuse-only** is an accepted limit (7.8 deferred), not closed by 1.9.
- **UV checker** already exists (`src/ui/ViewportToggles.js:40-45`); no task.
- **`PrinterProfile.ts`** is deleted in 1.1 (typedef moves to JSDoc), not kept by 1.1 and removed by 1.10.
- **Blueprint same-commit rule** restated at the top of §8; the five sync tasks are review-only passes.
- **Tier rule** (haiku = mechanical, ≤ 2 files, no judgement) now holds: 0.1, 0.7, 1.10 and 4.9 are sonnet; 0.9, 5.2, 6.3 stay haiku (2 files each, mechanical).

---

## Appendix A — Function inventory (every user-reachable function)

"Verdict": **keep** · **merge** · **rename** · **move** · **remove** · **add**. "Should live" names the target surface (§4.6–4.7). Task ids refer to §8.

### A1. Header / project / shell

| # | Function | Reachable now | Should live | Verdict |
|---|---|---|---|---|
| 1 | New project | `src/ui/ProjectMenu.js:25` · Ctrl+N `src/app/main.ts:111` | header | keep |
| 2 | Open project | `src/ui/ProjectMenu.js:26` · Ctrl+O · `src/ui/ViewportEmptyState.js:27` · `src/ui/ContextMenu.js:176` | header + empty state | keep |
| 3 | Save / Save As | `src/ui/ProjectMenu.js:27-28` | header | keep |
| 4 | Recent projects | `src/ui/ProjectMenu.js:30`, `src/ui/ProjectMenu.js:149` | header | keep |
| 5 | Reset all settings | `src/ui/ProjectMenu.js:33`, `src/ui/ProjectMenu.js:48-51` (no confirm) | ? menu with confirm | move (5.1) |
| 6 | Rename project (inline) | `src/ui/ProjectMenu.js:130-133` | header | keep |
| 7 | Language select | `src/ui/LocaleSwitcher.js:12` | header | keep |
| 8 | Workspaces | `src/ui/Workspace.js:261-279` · Ctrl+Shift+1-4 `src/ui/Workspace.js:106-115` | header pill | keep |
| 9 | Collapse right-panel sections | `src/ui/AppShell.js:31-41` | right panel | keep |
| 10 | Splitters / collapse strips | `src/ui/AppShell.js:72-202` | panel edges | keep; i18n (0.1) |
| 11 | **Import model** (header) | none | header + Ctrl+I | add (5.1) |
| 12 | **Export** (header) | none | header → Print ▸ Export | add (5.1) |
| 13 | **Undo / Redo buttons** | status text only `src/ui/StatusBar.js:14-31` | header + status bar | add (0.9) |
| 14 | **? help** | none | header | add (5.5) |

### A2. Outliner

| # | Function | Reachable now | Should live | Verdict |
|---|---|---|---|---|
| 15 | Show internal parts | `src/ui/Outliner.js:63`, `src/ui/Outliner.js:73` | "Show material parts" | rename (0.1) |
| 16 | Filter scene… | `src/ui/Outliner.js:67`, `src/ui/Outliner.js:80` | + `file:` chip | keep (3.4) |
| 17 | Select object row | `src/ui/Outliner.js:703-709` | same | keep |
| 18 | Group row click → members | `src/ui/Outliner.js:710`, `src/ui/Outliner.js:717-732` | selects the **group** | change (2.1, 3.4) |
| 19 | Collection row click | `src/ui/Outliner.js:712`, `src/ui/Outliner.js:734-739` | removed | remove (3.4) |
| 20 | Part row → lead | `src/ui/Outliner.js:313`, `src/ui/Outliner.js:541-545` | same | keep |
| 21 | Twirl / arrows | `src/ui/Outliner.js:244`, `src/ui/Outliner.js:366`, `src/ui/Outliner.js:558-562`, `src/ui/Outliner.js:697-699` | same | keep |
| 22 | Hide / Show | `src/ui/Outliner.js:389`, `src/ui/Outliner.js:552` | cascades on groups | keep (2.5) |
| 23 | Lock / Unlock | `src/ui/Outliner.js:390`, `src/ui/Outliner.js:553` | enforced | keep (2.5) |
| 24 | Print toggle | `src/ui/Outliner.js:373`, `src/ui/Outliner.js:554` | "Print" | rename (0.1) |
| 25 | Repair via badge | `src/ui/Outliner.js:351-361`, `src/ui/Outliner.js:555` | "Repair" | keep |
| 26 | Rename (dblclick / F2) | `src/ui/Outliner.js:567-573`, `src/ui/Outliner.js:694` | same | keep |
| 27 | Drag reparent / unparent | `src/ui/Outliner.js:589`, `src/ui/Outliner.js:653-684` | group-onto-group | keep |
| 28 | Drop shader onto row | `src/ui/Outliner.js:619-626`, `src/ui/Outliner.js:658-668` | same | keep |
| 29 | Row context menus | `src/ui/Outliner.js:575-587` | object/group only | keep (3.5) |

### A3. Context menu (`src/ui/ContextMenu.js`)

| # | Function | Now | Should live | Verdict |
|---|---|---|---|---|
| 30 | Select Members (collection) | `:151` | removed | remove (3.5) |
| 31 | Rename Collection… | `:152`, `:587-601` | removed | remove (3.5) |
| 32 | Delete Collection | `:154`, `:604-619` | removed | remove (3.5) |
| 33 | Select Members (group) | `:161`, `:345` | Select ▸ | move |
| 34 | Select Parent Group | `:162`, `:200`, `:350` | Select ▸ | move |
| 35 | Unparent (×2) | `:163`, `:203`, `:230`, `:562` | primary, once | merge (0.3) |
| 36 | Reveal in Outliner | `:164`, `:204` | Select ▸ | move |
| 37 | Import model… (empty) | `:175` | keep + header | keep |
| 38 | Open project… (empty) | `:176` | keep | keep |
| 39 | Frame all | `:178` | keep + Home | keep |
| 40 | Cursor → World Origin | `:179`, `:234` | Cursor ▸ | move |
| 41 | Select Siblings | `:201`, `:358` | Select ▸ | move |
| 42 | Select Import Members | `:202`, `:367` | Select ▸ "Same file" | rename+move |
| 43 | Relink | `:207-209`, `:495` | Properties ▸ Source + primary when missing | keep (4.6) |
| 44 | Focus | `:212`, `:501` | primary | keep |
| 45 | Toggle Hidden | `:214`, `:506` | primary | keep |
| 46 | Toggle Lock | `:215`, `:516` | primary | keep |
| 47 | Rename… (prompt) | `:216`, `:526` | inline Outliner rename | merge (3.5) |
| 48 | Duplicate | `:217` | primary | keep |
| 49 | Repair geometry | `:219`, `:488` | "Repair" | rename |
| 50 | Export selected… | `:220` | primary | keep |
| 51 | Split to parts | `:223-224`, `:466` | "Separate by material" | rename |
| 52 | Join into one object | `:225-226`, `:478` | "Merge into one object" | rename |
| 53 | Group / Ungroup | `:228-229` | primary | keep (2.4) |
| 54 | **Enter / Exit group** | none | primary | add (3.5) |
| 55 | Selection ↔ Cursor | `:232-233` | Cursor ▸ | move |
| 56 | Drop/Center/Place Face on Bed | `:236-238`, `:305-317` | Arrange ▸ + panel | move |
| 57 | Smart Replace | `:240`, `:372` | Combine ▸ "Replace with active" | rename+move |
| 58 | Transform Swab | `:241`, `:389` | Combine ▸ "Copy placement from active" | rename+move |
| 59 | Align Center X/Y/Z | `:243-245`, `:397` | Arrange ▸ Align ▸ | move |
| 60 | Combine Union/Subtract/Intersect | `:247-249`, `:434` | Combine ▸ | move |
| 61 | Slice & Connector… | `:250` | Combine ▸ | move |
| 62 | Mirror X/Y/Z | `:252-254`, `:405` | Arrange ▸ Mirror ▸ | move |
| 63 | Array X/Y/Z | `:256-258`, `:413` | Arrange ▸ Array ▸ (dialog) | move |
| 64 | Mate to Active | `:259`, `:424` | Arrange ▸ "Snap to active" | rename+move |
| 65 | Delete | `:261`, `:574` | primary | keep |

### A4. Properties (`src/ui/PropertiesPanel.js`)

| # | Function | Now | Should live | Verdict |
|---|---|---|---|---|
| 66 | Name | `:151`, `:164-170` | Object (all workspaces) | keep |
| 67 | Visible / Locked | `:154-155`, `:175-178` | Object | keep |
| 68 | ↧ Copy transform | `:207`, `:367`, `:380` | Transform header | keep |
| 69 | Ratio preset + text | `:264-268`, `:276`, `:335-344` | **Scale** with *Set scale* / *Convert…* + effective line | rename+change (1.13, 1.16) |
| 70 | Size (mm) X/Y/Z | `:216-218`, `:352-356`, `:411` | Transform | keep |
| 71 | Pos / Rot / Scale XYZ | `:222-236`, `:346-350`, `:445` | Transform | keep |
| 72 | Proportional scale lock | `:239`, `:359-365` | Transform | keep |
| 73 | Source Unit + Confirm | `:515-541` | Object ▸ "File units" + "Looks right" | rename (0.1) |
| 74 | Shader slot click | `:657`, `:671-676` | Material (Shade) | keep |
| 75 | Duplicate in place / Replace… / Assign… | `:645-664`, `:679-727` | Material | keep |
| 76 | ↧ Copy shader | `:604`, `:730`, `:741` | Material header | keep |
| 77 | UV Override | `:822-848`, `:856-892` | Material ▸ UV (Shade) | keep |
| 78 | Include in print export | `:930`, `:940` | Object "Print" | rename |
| 79 | **Source status + Refresh / Find** | none | Object | add (4.6) |
| 80 | Shader-picker modal | `:83`, `:759-809` | same | keep |

### A5. Materials (`src/ui/ShaderPanel.js`)

| # | Function | Now | Verdict |
|---|---|---|---|
| 81 | New shader (+) | `:302`, `:362` | keep |
| 82 | Select row / duplicate / drag | `:324-328`, `:369-397` | keep |
| 83 | Consolidate Duplicates | `:314`, `:352-361` | keep |
| 84 | Editor name/type/colour/hex | `:424-440`, `:518-530` | keep |
| 85 | Texture drop / Pick / Swap / × | `:446-509`, `:554-578`, `:673` | keep |
| 86 | Opacity / Roughness / Metallic | `:453-465`, `:532-534` | keep |
| 87 | UV base incl. Rot (rad) | `:472-476`, `:544-551` | rename Rot (deg) (0.1) |
| 88 | Make Unique / Assign / Select linked / Delete | `:480-483`, `:583-610` | keep (tooltip) |
| 89 | Swatches + save | `:696-718`, `:727-751` | keep + toast (5.4) |
| 90 | Merge / texture pick modals | `:75-76`, `:136-257` | keep |
| 91 | Auto-focus (passive) | `:73`, `:81-93` | keep |

### A6. Scene panel (`src/ui/ScenePanel.js`)

| # | Function | Now | Verdict |
|---|---|---|---|
| 92 | ↺ per section | `:217`, `:565-570` | keep |
| 93 | Grid cell / subdivisions / Grid / Axes | `:264-272`, `:574`, `:587` | keep |
| 94 | Background + levels | `:283-296`, `:598`, `:615` | keep |
| 95 | HDRI toggle / preset / intensity | `:300-312`, `:606` | keep |
| 96 | Grade controls | `:317-342` | inside Advanced (5.4) |
| 97 | Floor | `:346-356`, `:650-654` | keep |
| 98 | Shadows / lights / SSAO | `:364-390` | inside Advanced (5.4) |
| 99 | Texture cap | `:398`, `:659-663` | keep |
| 100 | Reset environment | `:407`, `:665-669` | keep |
| 101 | FOV / Near clip | `:413-417` | keep |
| 102 | Cut view + axis/offset/flip | `:430-449`, `:629-647` | keep + viewport toggle (5.7) |
| 103 | Still / Render view / Export PNG | `:459-483`, `:677-724`, `:803` · Ctrl+Alt+E `:155` | keep |
| 104 | Turntable | `:488-509`, `:726-786` | keep |

### A7. Print panel (`src/ui/PrintPanel.js`, `src/ui/print/CostBlock.js`)

| # | Function | Now | Should live | Verdict |
|---|---|---|---|---|
| 105 | Tabs Scale / Validation / Bed / Export | `src/ui/PrintPanel.js:126`, `src/ui/PrintPanel.js:135-139` | **Printer / Validation / Export** | merge (1.3) |
| 106 | ↺ print settings | `:130`, `:141` | header | keep |
| 107 | Target ratio pills / Add ratio… / custom | `:179-194`, `:238-268` | **Print at** · Other sizes… (1:X · ×N · N mm) | change (1.17) |
| 108 | Validate All / Repair all / Auto-Fix | `:416-417`, `:448`, `:464-506` | "Repair" | rename |
| 109 | Readiness card + routing | `:563`, `:640-648`, `:781` | strip on every tab | keep + (0.6) |
| 110 | Cost controls | `src/ui/print/CostBlock.js:116-162`, `src/ui/print/CostBlock.js:180-210` | Export ▸ Cost; per-size lines; ⚙ popover | keep (1.18, 5.3) |
| 111 | Each individually | `src/ui/PrintPanel.js:591`, `src/ui/PrintPanel.js:656` | Advanced | move (1.3) |
| 112 | Bake solid colours | `:596`, `:742` | Advanced | move |
| 113 | Strict export | `:601`, `:747` | Advanced (per-user) | move |
| 114 | Auto-repair on import | `:606`, `:752` | ? ▸ Preferences | move (5.5) |
| 115 | Export OBJ / 3MF / STL | `:618-626`, `:757-763` | "Export for <printer>" + all formats | keep, re-layout |
| 116 | **Export PLY / WRL** | none | formats | add (1.6) |
| 117 | Build Volume Preset | `:812`, `:860` | Printer tab | rename |
| 118 | Build Volume XYZ | `:829`, `:877` | Printer tab | keep |
| 119 | Show bed volume | `:836`, `:884` | Printer tab + viewport toggle | keep |
| 120 | **Split multi-material into parts** | none | Advanced | add (1.5) |
| 121 | **Reference object [change]** | none | Export | add (1.15) |

### A8. Asset panel (`src/ui/AssetPanel.js`)

| # | Function | Now | Should live | Verdict |
|---|---|---|---|---|
| 122 | Session / Library tabs | `:67-68`, `:118-119` | **Project / Folders** | rename (4.6) |
| 123 | Mount / Refresh / Unmount | `:70-77`, `:111-113`, `:193`, `:255`, `:271` | Folders | keep |
| 124 | Smart views | `:290-296`, `:551-572` | Project | keep |
| 125 | Folder tree | `:319-346`, `:529-553` | Folders | keep |
| 126 | Search / scope / type | `:87-93`, `:574-591` | same | keep |
| 127 | Remove asset × | `:498`, `:594-599` | card menu | keep |
| 128 | Double-click → add | `:601`, `:634` | same | keep |
| 129 | Drag card | `:508`, `:616-622` | same | keep |
| 130 | Re-mount modal | `:136-150`, `:207` | boot banner | move (4.7) |
| 131 | **Card menu (Add / Reveal / Refresh / Find / Remove)** | none | Project | add (4.6) |
| 132 | **"Already in project" prompt** | none | import | add (4.8) |

### A9. Viewport chrome

| # | Function | Now | Should live | Verdict |
|---|---|---|---|---|
| 133 | Gizmo Move/Rotate/Scale | `src/ui/ViewportToolbar.js:22-24`, `src/ui/ViewportToolbar.js:99` | toolbar | keep |
| 134 | Pivot buttons | `:28-31`, `:100` · `.` | dropdown | keep (5.6) |
| 135 | Local/World | `:73`, `:102-105` | toolbar | keep |
| 136 | Camera follow | `:35-37`, `:101` | dropdown | keep |
| 137 | Display mode select | `src/ui/ViewportToggles.js:40-45`, `src/ui/ViewportToggles.js:79` | toggles | keep |
| 138 | Wireframe + colour | `:46-51`, `:80-99` | toggles | keep |
| 139 | Inverted faces | `:53`, `:80-91` | toggles | keep |
| 140 | **Cross-section / bed toggles** | panels only | toggles | add (5.7) |
| 141 | NavCube | `src/ui/NavCube.js:28-35`, `src/ui/NavCube.js:47-67`, `src/ui/NavCube.js:100-119` | same | keep |
| 142 | Empty-state Import / Open | `src/ui/ViewportEmptyState.js:26-27` | same | keep |
| 143 | Status-bar Fix | `src/ui/MeshStats.js:138-141` | "Repair" | rename |
| 144 | Cursor panel tab | `src/ui/CursorPanel.js:41`, `src/ui/CursorPanel.js:56`, `src/ui/CursorPanel.js:68` | **Arrange** + toolbar | rename (0.7) |
| 145 | **Scope breadcrumb** | none | under NavCube | add (3.3) |
| 146 | **Hover highlight** | none | viewport | add (5.6) |
| 147 | **Measure** | none | toolbar | add, deferred (7.3) |

### A10. Arrange panel (`src/ui/CursorPanel.js`)

| # | Function | Now | Verdict |
|---|---|---|---|
| 148 | Cursor XYZ / show / pivot | `:73-81`, `:44-49`, `:150-176` | keep (cursor sub-section; pivot checkbox removed in favour of toolbar) |
| 149 | Drop / Center on Bed | `:86-87`, `:51-54`, `:107` | keep |
| 150 | Align Min/Center/Max | `:91-93` | keep |
| 151 | Mirror / Array / Mate | `:96-98` | keep; Array dialog (5.6) |

### A11. Slice & Connector (`src/ui/SliceConnectorSession.js`)

| # | Function | Now | Verdict |
|---|---|---|---|
| 152 | Cut line / Cut / sides / place / size / depth / clearance / Finish / Back / Cancel | `:299-338`, `:358-372`, `:390-473`, `:476` | keep unchanged (Combine ▸ entry) |

### A12. Copy/paste, modals, toasts

| # | Function | Now | Verdict |
|---|---|---|---|
| 153 | Ctrl+C / Ctrl+V aspect chooser | `src/ui/CopyPaste.js:40-84`, `src/ui/CopyPaste.js:120-165` | keep |
| 154 | Modal ids: exportSelected, booleanTextureBake, shader-picker, shaderMerge, texturePick, remountFolder, importError, validationErrors, exportGate, dirtyConfirm, recoverAutosave, unmatchedAssets, ghostAssets, portableSaveBlocked | `src/ui/ContextMenu.js:55`, `src/ui/ContextMenu.js:73` · `src/ui/PropertiesPanel.js:83` · `src/ui/ShaderPanel.js:75-76` · `src/ui/AssetPanel.js:136` · `src/ui/ImportError.js:16` · `src/ui/PrintPanel.js:79-80` · `src/ui/ProjectMenu.js:185`, `src/ui/ProjectMenu.js:201`, `src/ui/ProjectMenu.js:250-253` | remountFolder + recoverAutosave → banner (4.7); unmatched/ghost/portable → one Sources modal (4.6); rest keep |
| 155 | Validation toasts | `src/core/assets/AssetRegistration.js:282-300` | keep ("Repair") |
| 156 | Blocking progress overlay | `src/ui/ProgressOverlay.js:31-38` | Cancel where abortable (5.8) |
| 157 | Close guard | `src/app/main.ts:130-139` · `electron/main.cjs:34-38`, `electron/main.cjs:106-114` | keep; Electron reload guard (0.4) |

### A13. Keyboard shortcuts

| Keys | Context | Registered at | Verdict |
|---|---|---|---|
| Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y | global | `src/core/InputManager.js:807-809` | keep |
| Ctrl+S / Ctrl+Shift+S / Ctrl+N / Ctrl+O | global | `src/app/main.ts:109-112` (stubs `src/core/InputManager.js:811-814`) | keep; delete stubs (0.3) |
| G / R / S + modal keys | viewport | `src/core/InputManager.js:817-819`, `src/core/InputManager.js:401-442` | keep |
| A / Alt+A | viewport | `:822-823` | keep |
| F | viewport | `:826` | keep; Home = frame all (add) |
| Numpad / Alt presets | viewport | `:829-847` | keep |
| H / Alt+H | viewport | `:850-851` | keep |
| Ctrl+G / Ctrl+Shift+G | viewport | `:852-853` | keep |
| Shift+D | viewport | `:854` | keep |
| Delete / X | viewport | `:855-856` | keep |
| Tab | viewport | `:859` | remove (0.3) |
| ` / ~ | viewport | `:860-861` | keep |
| . | viewport | `:862` | keep |
| Ctrl+C / Ctrl+V | viewport | `src/ui/CopyPaste.js:40-41` | keep |
| Shift+N | global | `src/ui/CursorPanel.js:56` | keep (Arrange) |
| Ctrl+Alt+E | global | `src/ui/ScenePanel.js:155` | keep |
| Ctrl+Shift+1-4 | global | `src/ui/Workspace.js:106-115` | keep |
| N / T / \ | global | `src/ui/Workspace.js:117-119` | keep |
| **Ctrl+I · Esc scope-out · Home · L** | none | add (0.3, 3.2) | add |
| F2 shown but unregistered | — | `src/ui/ContextMenu.js:216` vs `src/ui/Outliner.js:694` | register globally (0.3) |

### A14. Mouse gestures

| Gesture | Code | Verdict |
|---|---|---|
| LMB click / Shift+LMB / body drag / marquee | `src/core/InputManager.js:190-261` · `src/core/BoxSelect.js:89-123` | Shift→add, Ctrl→toggle (0.3); double-click enter (3.2) |
| RMB click → menu; RMB drag orbit | `src/core/InputManager.js:176`, `src/core/InputManager.js:183-186`, `src/core/InputManager.js:282-297` · `src/core/scene/CameraRig.js:178-190` | keep |
| Shift+RMB → cursor | `src/core/InputManager.js:172`, `src/core/InputManager.js:299-315` | keep |
| MMB / Shift+MMB / wheel | `src/core/scene/CameraRig.js:151-154`, `src/core/scene/CameraRig.js:210-212` | keep; zoom-to-cursor (5.6) |
| Gizmo drag / modal mouse | `src/core/scene/PivotSession.js:66-67` · `src/core/InputManager.js:156`, `src/core/InputManager.js:444` | keep; gizmo Ctrl-snap (5.6) |
| Drops / Import picker | `src/ui/ViewportDrop.js:42-49`, `src/ui/ViewportDrop.js:98-199`, `src/ui/ViewportDrop.js:59-84` | keep; stagger (5.6); dedupe prompt (4.8) |

### A15. Duplicates (3+ surfaces) and resolution

| Function | Surfaces | Resolution |
|---|---|---|
| Visibility | Outliner · Properties · menu · H / Alt+H | keep all |
| Lock | Outliner · Properties · menu | keep; add L |
| Rename | Outliner · Properties · menu prompt | menu → Outliner inline rename |
| Import | empty state · empty-space menu · OS drop · asset card · header (new) | keep all |
| Repair | menu · badge · status · Validation ×2 · toast · gate · on-import | one label "Repair", one `RepairSession` path |
| Pivot mode | toolbar ×4 · `.` · Cursor panel checkbox | dropdown + `.` |
| Camera presets | NavCube · numpad · Alt | keep |
| Placement verbs | menu · Cursor panel | Arrange ▸ + Arrange panel |
| Shader assignment | Outliner drop · Properties ×3 · editor ×2 | keep |
| Workspace switch | pill · keys · 3 programmatic jumps | toast with "back" (5.4) |
| Reset settings | header · Scene ↺ ×4 · Print ↺ · Reset environment | header under ? with confirm |
| Relink | menu · 3 modals | one command, one Sources modal, Properties ▸ Source |
| Export | Print ×3 · menu Export selected · header (new) | keep |
| Resize an object | Size (mm) · Scale XYZ · Ratio (bake) | Size/Scale XYZ = node; Scale (nominal) = declaration + explicit Convert (1.13) |

---

## Appendix B — Risk register

Likelihood/impact L/M/H. "Closes" = §8 task id.

### B1. Data loss

| ID | Risk | L | I | Existing mitigation | Gap | Closes |
|---|---|---|---|---|---|---|
| R1 | Torn/partial `.mixo` on save | L | H | FSA `createWritable→write→close` (`src/core/PersistenceManager.js:56-60`); saveAs writes before binding (`src/core/PersistenceManager.js:94-98`); open binds after load (`src/core/PersistenceManager.js:138-142`) | no `w.abort()` (`src/core/PersistenceManager.js:56-60`; `src/core/print/Download.js:18-20`); no read-back; `pushRecent` throw after bytes written rejects `save()` with dirty cleared (`src/core/PersistenceManager.js:65-72`) | 0.2 |
| R2 | Autosave never offered back | **H** | **H** | written every 60 s (`src/core/persist/Autosave.js:15-43`); recovery + modal exist (`src/core/persist/Autosave.js:53-88`; `src/ui/ProjectMenu.js:201`) | **no caller** (`src/app/main.ts:118-120`); keyed by name (`src/core/persist/Autosave.js:29`; `src/core/persist/ProjectLoader.js:465-468`); single check before an async build (`src/core/persist/Autosave.js:26-28`) | 0.11, 4.7 |
| R3 | Schema drift | M | M | newer major refused (`src/core/persist/ProjectValidator.js:39-48`) before `resetWorld` (`src/core/persist/ProjectLoader.js:172-174`) | `migrate()` identity (`src/core/persist/ProjectLoader.js:121-126`); newer-minor drops unknown fields; `src/core/StateManager.js:7` defaults `'3.1'` | 4.1 |
| R4 | Browser storage eviction | M | H | tiered fallback (`src/core/persist/AssetResolver.js:45-96`); ghosts relinkable (`src/core/persist/ProjectSerializer.js:110-115`) | no `navigator.storage.persist()`; autosave omits bytes for handle-backed assets (`src/core/persist/ProjectSerializer.js:130-133`); stale recents never pruned (`src/core/persist/RecentProjects.js:23-24`) | 0.2, 4.7 |
| R5 | Electron refs lost / KV | H | M | KV temp+rename, quarantine (`electron/KvStore.cjs:32-83`) | session tokens (`electron/OpaqueFileRegistry.cjs:15-24`; `src/core/assets/DirMounts.js:20`, `src/core/assets/DirMounts.js:30`); unbounded registry (`electron/OpaqueFileRegistry.cjs:43`); no fsync | 4.2, 4.9 |
| R6 | Close/reload without save | M | H | web `beforeunload` (`src/app/main.ts:130-134`); Electron close intercept (`electron/main.cjs:34-38`, `electron/main.cjs:106-114`; `src/core/PersistenceManager.js:189-196`) | skipped under Electron (`src/app/main.ts:131`); no `render-process-gone`; `MIXO_SMOKE` bypass (`electron/main.cjs:35`) | 0.4 |
| R7 | Load/import interleave | L | M | `LoadGate` (`src/core/persist/LoadGate.js:5-15`; `src/core/persist/ProjectLoader.js:162-180`; `src/core/assets/AssetImport.js:89-90`, `src/core/assets/AssetImport.js:173`, `src/core/assets/AssetImport.js:308`) | `loadFromBlob` awaits before `_importBegin` (`src/core/assets/AssetImport.js:173-187`); `open/openRecent` skip the assert before the dirty confirm | 0.5 |
| R8 | Crash mid-export | L | M | zip in memory (`src/core/print/PrintPackaging.js:12-15`); FSA commit on close; clones disposed (`src/core/print/PrintPipeline.js:571-572`); cancel never toasts success (`src/core/print/Download.js:22-24`) | non-Abort error silently falls to anchor (`src/core/print/Download.js:22-25`); no `abort()`; no size guard | 0.2 |
| R9 | Overwrite without consent | L | M | OS dialog confirms (`src/core/print/Download.js:14-20`) | a future "export again" via remembered ref — rule in 1.3 | 1.3 |

### B2. Fidelity

| ID | Risk | L | I | Existing mitigation | Gap | Closes |
|---|---|---|---|---|---|---|
| F1 | Texture downscaled into export | L | H | full-res capture (`src/core/assets/TextureCap.js:44-79`); export prefers source (`src/core/print/ExportTextures.js:25-29`); cap default 0 (`src/config/default-settings.json:29`) | capture failure swallowed (`src/core/assets/TextureCap.js:76-78`); no dedicated test | 0.8 |
| F2 | Colour space | L | M | one seam `src/core/shaders/ColorSpace.js:14-42` used by `src/core/print/ObjWriter.js:165`, `src/core/print/ThreeMFWriter.js:46`, `src/core/BooleanService.js:166`, `src/core/ShaderLibrary.js:54`, `src/core/ShaderLibrary.js:68` | texture bytes exported without sRGB flag check; no direct test | 1.9 |
| F3 | UV loss in Boolean | L | H | gate (`src/core/commands/BooleanCommands.js:23`, `src/core/commands/BooleanCommands.js:50-52`; ADR 0002) | diffuse/albedo/emissive only; `computeBoolean` unguarded | 6.3 |
| F4 | Unit/axis errors | M | H | import seam (`src/core/ImportNormalizer.js`), axis seam (`src/core/print/PrintSpace.js:25-31`), 3MF unit (`src/core/ThreeMFLoader.js:201-204`), `unit-unconfirmed` (`src/core/print/PrintReadiness.js:46`) | **OBJ bypasses PrintSpace** (`src/core/print/ObjWriter.js:52`, `src/core/print/ObjWriter.js:58`); no micron in `SOURCE_UNIT_FACTORS` (`src/core/scale/ScaleMath.js:6-12`) | 1.7 |
| F5 | Shared vertex buffer double-bake | L | H | `_unshareVertexBuffers` (`src/core/ImportNormalizer.js:90-103`, `src/core/ImportNormalizer.js:173`) | within one container only | — |
| F6 | Repair replay failure silent | M | M | per-object isolation (`src/core/persist/ProjectLoader.js:362-368`); export re-repairs | fix stays listed, console-only (`src/core/persist/ProjectLoader.js:359-361`) | 0.5 |
| F7 | Multi-material object merged in 3MF | H | M | — | `src/core/print/ThreeMFWriter.js:272`; per-part printers need separate parts | 1.5 |
| F8 | Scale footguns (declare resizes, stale label, volatile reference, position jump) | **H** | **H** | as-shown default (`src/core/print/ExportContext.js:120`); restore replay (`src/core/persist/ProjectLoader.js:31-36`, `src/core/persist/ProjectLoader.js:346-352`) | `src/core/commands/ScaleCommands.js:138-146`; `src/core/print/ExportContext.js:119`, `src/core/print/ExportContext.js:297-301`; §3.3 | 1.13–1.17 |

### B3. Performance

| ID | Risk | L | I | Existing mitigation | Gap | Closes |
|---|---|---|---|---|---|---|
| P1 | Heavy textures + high-poly | M | H | triangle budget (`src/core/storage/capabilities.js:33-34`; `src/core/assets/AssetImport.js:149-157`); validation worker (`src/core/MeshValidator.js:115-122`); adaptive DPR (`src/core/scene/AdaptiveResolution.js:20-25`); outline gating (`src/core/scene/SelectionOutline.js:212-226`, `src/core/scene/SelectionOutline.js:309`); OBJ worker timeout (`src/core/WorkerImport.js:17`); auto-validate skip (`src/core/MeshValidator.js:17`, `src/core/MeshValidator.js:527-529`); texture cap | validation worker has no timeout; budget advisory; no import size cap | 6.4 |
| P2 | Hash scan on load | H | M | cap 4000 per scan (`src/core/persist/constants.js:15`; `src/core/persist/AssetResolver.js:18-35`) | per-asset budget → N×4000 serial reads | 4.3 |
| P3 | Autosave cost | H | M | `skipEmbed` (`src/core/persist/ProjectSerializer.js:132`); base64 worker | `textureImages` always re-encoded (`src/core/persist/ProjectSerializer.js:167-178`) | 0.11 |

### B4. Wrong print

| ID | Risk | L | I | Existing mitigation | Gap | Closes |
|---|---|---|---|---|---|---|
| W1 | Wrong scale | M | H | per-object ratio + factor (`src/core/print/ExportContext.js:123`, `src/core/print/ExportContext.js:140-142`); `unit="millimeter"` (`src/core/print/ThreeMFWriter.js:244`, `src/core/print/ThreeMFWriter.js:401`); readiness size (`src/core/print/PrintReadiness.js:70-76`); filename suffix | acknowledge-only warnings enforced in UI (`src/ui/PrintPanel.js:684`) not pipeline (`src/core/print/PrintPipeline.js:317`); §3.3 footguns | 1.3, 1.8, 1.13, 1.15, 1.16 |
| W2 | Inside-out faces | L | H | flag-aware validator (`src/core/MeshValidator.js:92-106`, `src/core/MeshValidator.js:445`); `printIndices` (`src/core/print/PrintSpace.js:63-74`); repair conforms winding (`src/core/repair/MeshRepair.js:388-401`) | warning-only (`src/core/MeshValidator.js:221`) | 1.8 |
| W3 | Non-watertight export | M | H | repair on clones (`src/core/print/PrintPipeline.js:466-476`, `src/core/print/PrintPipeline.js:486`); strict (`src/core/print/PrintPipeline.js:525-533`) | strict off by default; unknown verdict never blocks; multi-part skips CSG (`src/core/print/PrintPipeline.js:500-514`) | 1.8 |
| W4 | Bed overflow / below bed | M | M | `BedFit` (`src/core/print/BedFit.js:22-39`); readiness (`src/core/print/PrintReadiness.js:70-84`) | warnings only; null bed → no check | 1.2 |
| W5 | Missing texture | L | H | fails closed (`src/core/print/ExportTextures.js:35-43`, `src/core/print/ExportTextures.js:110`, `src/core/print/ExportTextures.js:176`); readiness error (`src/core/print/PrintReadiness.js:45`) | diffuse only (`src/core/print/ExportTextures.js:99-101`) — accepted: no listed printer consumes other slots for colour | — (7.8 deferred) |
| W6 | Package name collisions | M | H | `uniqueEntryPaths` (`src/core/print/PrintPackaging.js:33-38`); `_1` suffix (`src/core/print/ExportTextures.js:72-84`) | case-sensitive `usedNames` (`src/core/print/ExportTextures.js:78`) → reference mismatch | 0.10, 4.8 |
| W7 | Printer limits unchecked | H | H | — | bed-only rows (`src/config/printers.json:2-91`); dead keys (`src/config/default-settings.json:39-49`) | 1.1–1.6 |

### B5. Security

| ID | Risk | L | I | Existing mitigation | Gap | Closes |
|---|---|---|---|---|---|---|
| S1 | Malicious / huge files | M | M | 3MF checks (`src/core/ThreeMFLoader.js:85-88`, `src/core/ThreeMFLoader.js:201-204`, `src/core/ThreeMFLoader.js:325-327`, `src/core/ThreeMFLoader.js:352`, `src/core/ThreeMFLoader.js:459`, `src/core/ThreeMFLoader.js:482`); worker timeout + payload (`src/core/WorkerImport.js:17`, `src/core/WorkerImport.js:203-223`); extension allowlist (`src/core/assets/AssetTypes.js:1`; `src/core/assets/AssetImport.js:174-176`) | no size cap; `JSZip.loadAsync` unlimited (`src/core/ThreeMFLoader.js:534`); Babylon parsers unaudited | 6.4 |
| S2 | Electron hardening | M | H | `contextIsolation`, no `nodeIntegration` (`electron/main.cjs:25-29`); narrow preload (`electron/preload.cjs:10-40`); opaque refs (`electron/OpaqueFileRegistry.cjs:44-45`); path IPC removed (`electron/main.cjs:103`) | `sandbox:false` (`electron/main.cjs:28`); no CSP (`index.html:22`, `index.html:123` inline); no navigation guards; `dialog:open/save` return OS paths (`electron/main.cjs:104-105`) | 6.1, 6.2 |
| S3 | HTML injection | L | M | `src/ui/renderSafe.js` used at every found site (`src/ui/Outliner.js:257`, `src/ui/Outliner.js:319`, `src/ui/Outliner.js:388`; `src/ui/AssetPanel.js:364`; `src/ui/ShaderPanel.js:175`, `src/ui/ShaderPanel.js:249`, `src/ui/ShaderPanel.js:326`; `src/ui/PropertiesPanel.js:151`, `src/ui/PropertiesPanel.js:655`, `src/ui/PropertiesPanel.js:783`; `src/ui/ProjectMenu.js:152`, `src/ui/ProjectMenu.js:231`, `src/ui/ProjectMenu.js:290`; `src/ui/ImportError.js:62-68`; `src/ui/PrintPanel.js:446`, `src/ui/PrintPanel.js:1010`) | heuristic review; `src/ui/ShaderPanel.js:224`, `src/ui/ShaderPanel.js:246` CSS selectors; no test | 6.5 |

### B6. Maintenance

| ID | Risk | L | I | Existing mitigation | Gap | Closes |
|---|---|---|---|---|---|---|
| M1 | Web/desktop divergence | H | M | adapter + caps | direct FSA/idb sites (§2.1); 4 caps unread; `src/app/main.ts:41` gate | 4.2, 4.4 |
| M2 | Test coverage gaps | M | M | 80 headless files + 5 smokes | no dedicated test for `PivotSession`, `ParentCommands`, `TransformCommands`, `CameraRig`, `TextureCap`, `AssetResolver`, `ProjectValidator`, `PrintPackaging`, `ColorSpace`, `ViewportDrop`, `ProjectMenu`; smoke-only: workers, CSG, WASM repair, Electron close | 6.6 |
| M3 | Blueprint drift | M | M | AGENTS rule | ~35 files absent from §0.3 (`src/core/LogicalObjects.js`, `src/core/persist/LoadGate.js`, `storage/*`, `src/core/shaders/ColorSpace.js`, `src/ui/CopyPaste.js`, `electron/*`) | 6.7 |
| M4 | Dead code / settings | M | L | — | `restoreDirectory`, `recoverAutosave` (unreachable), `pickOpen/pickSave`, `ExportPlanner.buildExportPlan`, `PrinterProfiles.*`, `src/export/ExportPipeline.ts`, `src/import/ImportPipeline.ts`, `src/core/printers/PrinterProfile.ts` (all three deleted in 1.1), legacy ScaleMath readers, dead print keys | 1.1, 1.10, 4.9 |
