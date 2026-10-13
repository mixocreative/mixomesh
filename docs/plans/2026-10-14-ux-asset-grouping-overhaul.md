# MIXOMESH whole-software overhaul — implementation plan

**Date:** 2026-10-14 (rev 2, whole-software scope) · **Status:** proposal for owner review · **Branch:** master (solo, no feature branches)
**Appendix:** `docs/plans/2026-10-14-overhaul-appendix-inventory.md` — full function inventory (every user-reachable function with placement verdict) and the risk register with `path:line` evidence.
**Supersedes in part:** `docs/superpowers/specs/2026-08-03-editor-asset-hierarchy-ux-design.md` §"Scene hierarchy" (Decision 1). Its asset-index, shader-identity and readiness decisions stand.
**Authority:** `AGENTS.md` rules 1–8 apply to every task; rule 6 (export is button-driven, the printer never hides/switches/blocks a format) is honoured throughout — printer presets set *defaults and hints*, never gates. Every contract change updates `Blueprint.md` in the same commit.

> **For agentic workers:** execute task-by-task with `superpowers:subagent-driven-development` or `superpowers:executing-plans`. Each task lists **Files · Behaviour · Accept · Deps · Tier** (**haiku** = mechanical / 1 file, **sonnet** = bounded 1–3 file feature, **opus** = cross-cutting or judgement). Gate for every task: `npm run lint && npm run typecheck && npm run i18n:check && npm test`; browser smokes (`npm run test:browser`, `test:export`, `test:repair`, `test:group`) where the task says. Orientation/axis claims are verified only empirically (`tests/scan-probe.mjs`, trimesh, PrusaSlicer CLI). Commit per task on master. The web build stays green after every task; Electron work is additive and never enters the Vite graph.

---

## 0. Executive summary

| Area | Root cause in code (verified) | Fix in one line |
|---|---|---|
| **Data safety** | Autosave is written every 60 s but **never offered back** (`src/core/persist/Autosave.js:53-88` has no caller; `src/app/main.ts:118-120`); autosave keyed by project *name*; no write abort on failure; no `navigator.storage.persist()`; Electron reload unguarded | Phase 0: recovery reachable, keyed by project id, atomic-write hygiene, persistent-storage request, reload guard |
| **Printer strategy** | `src/config/printers.json` rows carry only `displayName/vendor/bed/defaultMaterialId` (`:2-91`); `minWallThickness`/`printMode`/`chordTolerance` are dead settings (`src/config/default-settings.json:39-49`); no vertex-colour writer, no Bambu/Prusa paint metadata, multi-material objects collapse to one 3MF mesh (`src/core/print/ThreeMFWriter.js:272`), OBJ bypasses `PrintSpace` (`src/core/print/ObjWriter.js:235,241`) | printers.json v2 = capability data (process, colour mode, texture limits, format defaults, validation hints) driving defaults, readiness, bed and cost; PLY/WRL writers; split-by-material 3MF; Bambu-flavoured 3MF; Mimaki stays default and best-tested |
| **Export settings** | 4 tabs, options scattered (`individually` resets every render, `src/ui/PrintPanel.js:591`), `strictExport` persisted both per-user and in `.mixo`, readiness only on Export tab | Printer → sensible defaults → one primary "Export for <printer>" → Advanced disclosure; readiness strip on every tab; clean per-project vs per-user split |
| **Assets** | provenance in four fields over three unsynchronised registries; "Linked/Snapshot" badge reflects key *presence* not what loaded (`src/ui/AssetPanel.js:490-495`); relink never refreshes hash/provenance (`src/core/persist/ProjectLoader.js:491-532`); desktop persists no asset path (`electron/OpaqueFileRegistry.cjs:15-24`); no import dedupe (`src/core/assets/AssetImport.js:180` always mints) | one `source` descriptor + `contentHash`, one `resolveAsset()`, plain-word status, desktop refs that survive restart, hash-dedupe prompt, VS-Code-style qualified names |
| **Grouping** | four overlapping "group" concepts; groups never selectable (`src/core/Selection.js:58-81`), gizmo never moves a group node (`src/core/scene/PivotSession.js:175-204`); click inside a multi-object import grabs one piece | **Object** (print unit) + **Group** (rigid, enterable) only; Figma/Keynote click-depth; real group transform |
| **UI shell / viewport** | 41-item context menu, 8 repair entry points with 5 labels, print verbs under "3D Cursor", shortcuts dead outside the canvas, no hover feedback, no onboarding, no header Import/Export/Undo | tiered menu, **Arrange** panel, one terminology table, header verbs, hover + breadcrumb, 4-step coach, readiness strip |

Eight phases, ordered **risk-first**: 0 safety net → 1 printers/export → 2–3 hierarchy → 4 assets → 5 shell/viewport → 6 hardening → 7 deferred. 65 scheduled tasks (15 haiku · 35 sonnet · 15 opus) plus 7 deferred items.

---

## 1. Current-state diagnosis

Citations against master 4da6236 (plan committed at 2a4c2a2). Three parallel code audits plus direct reads; owner memory notes were treated as claims and several were stale (noted inline).

### 1.1 Assets, provenance, resolution

- Provenance = `directoryHandleKey`+`originalPath` (`src/core/assets/AssetImport.js:259-267,394-402`), `fileHandleKey` only when `opts.fileHandle && !opts.directoryHandleKey` (`:349-357`), `contentHash` duplicated as `sourceFileHash` (`:187,267`). Mount keys are `dir_<name>_<Date.now()>` (`src/core/assets/DirMounts.js:18`) → re-mounting the same folder never matches older assets (`src/ui/AssetPanel.js:664-671`).
- `resolveAssetBlob` (`src/core/persist/AssetResolver.js:45-97`): dir path hit (not hash-verified, `:51-52`) → dir hash scan (4000 files, each fully read, `:18-35`) → file handle → embedded (hash-checked `:86-92`) → ghost. Status lives only in a local map (`src/core/persist/ProjectLoader.js:236-312`); `isUnlinked` is set for *any* static result (`:330,388`).
- Badge "Linked/Snapshot" = `!!(directoryHandleKey || fileHandleKey)` (`AssetPanel.js:490-495`). Relink (`ProjectLoader.js:491-532`) clears `isGhost` only — no new key/path/hash, no `libraryItem`/OBJ siblings (`:501`), old container not disposed; next save embeds new bytes under the **old** hash (`src/core/persist/ProjectSerializer.js:146`) which the hash check can later reject.
- `migrate()` is identity (`ProjectLoader.js:121-126`); legacy handling inline (`:189-196,225,261-264`). Autosave `skipEmbed` still base64-encodes every texture each tick (`ProjectSerializer.js:166-178,269`); `recoverAutosave` has no UI caller (`main.ts:118-120`; modal registered `src/ui/ProjectMenu.js:201`, never opened).
- Adapter (`src/core/storage/StorageAdapter.js:45-75`) implements KV + mount/list/read only; declared methods `:33-36` absent in both impls. Direct FSA at `src/core/PersistenceManager.js:57,88,124,177`, `ProjectLoader.js:494`, `src/ui/ViewportDrop.js:62,129-130`, `src/core/print/Download.js:9,14,18`, `AssetPanel.js:225`; direct idb imports in `AssetImport.js:10`, `DirMounts.js:5`, `AssetResolver.js:4`, `ProjectLoader.js:16`, `PersistenceManager.js:17`, `src/core/persist/RecentProjects.js:4`. Caps `persistAssets/relinkByPath/writeFiles/watchFiles` never read; the one gate (`AssetPanel.js:117`) is shadowed by the boot block `src/app/main.ts:41`.
- **Desktop:** mount refs are in-memory tokens (`electron/OpaqueFileRegistry.cjs:15-24`); `DirMounts.js:20,30` skip persistence off-browser; `promptRemount` exits on desktop (`AssetPanel.js:208`); `preload.cjs:12-18` declares `watchFiles/relinkByPath/persistAssets: true` with no watcher; `pickOpen/pickSave` IPC (`electron/preload.cjs:32-33`, `electron/main.cjs:104-105`) have no callers; registry grows per `listDirectory` (`OpaqueFileRegistry.cjs:43`); recents split between desktop KV and IDB handles (`RecentProjects.js:24,30`). Net: **desktop is less live than web today.**
- **Name clashes (new scope):** no content-hash lookup on import (`AssetImport.js:172-180` mints a fresh id every time); glTF textures are named from `texture.name`/URL (`src/core/assets/TextureAssets.js:156-159`) so `baseColor`/`Image_0` repeat across models; export texture names collide case-sensitively (`src/core/print/ExportTextures.js:72-84`, suffix `_1`), while zip-entry dedupe is case-insensitive (`src/core/print/PrintPackaging.js:72-89`) → a renamed entry can leave the XML/MTL pointing at the wrong image; OS save dialog is the only overwrite guard (`Download.js:14-20`).

### 1.2 Hierarchy, selection, gizmo

Four overlapping concepts — Collection (`src/core/assets/AssetRegistration.js:201-226`, rendered `src/ui/Outliner.js:241-268`), GroupNode (`src/core/import/ImportHierarchy.js:85-141`, `src/core/commands/ParentCommands.js:168-271`), logical object lead+parts (`AssetRegistration.js:124-146`, `src/core/LogicalObjects.js`), legacy `sourceGroupId` (`src/core/assets/MeshSplit.js:66,121-126`; still read alone at `LogicalObjects.js:29,47`, `src/core/MeshValidator.js:140-151,513-518`).

- Groups never in `selectedIds` (`src/core/Selection.js:58-81`; `src/core/InputManager.js:762`); Outliner group click expands to leaves (`Outliner.js:717-732`); gizmo re-parents leaves under a temp pivot and the group node never moves (`PivotSession.js:175-204,230-238`). A glTF with body+head under one node → 1 import group + 2 objects; viewport click selects only the clicked mesh (`InputManager.js:190-220`). No double-click handler in the viewport.
- `CreateGroupCommand` lands at root and names `'Group'` un-uniquified (`ParentCommands.js:169,172,241`); `SplitToPartsCommand` names the group like its lead and parts `.2/.3` (`:439,454`); Ungroup dissolves the whole parent of anything selected (`InputManager.js:766-777`, `src/ui/ContextMenu.js:550-560`); `JoinCommand` leaves parts under old parents (`ParentCommands.js:499-512`); `DuplicateCommand.undo` leaves clone ids in `childIds` (`src/core/commands/HierarchyCommands.js:294-302`); lock is cosmetic (only `src/core/commands/PlacementCommands.js:47-49` honours it); viewport Shift=toggle vs Outliner Shift=add (`InputManager.js:201`, `Outliner.js:707-709`); `validateAllPrintParts` dedupes by `sourceGroupId` (`MeshValidator.js:515-518`); `collectPrintUnits` lead-flag/part-flag mismatch (`src/core/print/ExportContext.js:177,181`); collection rename/delete bypass commands (`ContextMenu.js:587-619`).

### 1.3 UI shell (beginner lens)

41-item object menu with 14 separators, "Unparent" twice (`ContextMenu.js:162,227`); print verbs in the "3D Cursor" drawer (`src/ui/CursorPanel.js:96-98`, Shift+N); eight repair entry points, five labels; silent workspace jumps (`src/ui/ShaderPanel.js:788-796`, `src/ui/PrintPanel.js:90-99,787`); shortcuts need canvas focus (`InputManager.js:95`), `Tab` dead (`:797-800`), status hint contradicts code (`en.json status.defaultHint` vs `InputManager.js:673-675`); no header Import/Export/Undo; reset-all without confirm (`src/ui/ProjectMenu.js:33,48-51`); readiness only on Export tab (`PrintPanel.js:547,585`); Properties hidden in Scene/Print (`src/styles/layout.css:384-391`); no onboarding; blocking overlay swallows Esc (`src/ui/ProgressOverlay.js:244-251`); modal replaces modal (`src/ui/Modal.js:86`). Full inventory: appendix §A.

### 1.4 Printers and export (new scope)

- `printers.json` row = `displayName, vendor, bed{x,y,z}, defaultMaterialId` (`src/config/printers.json:2-91`); consumers `src/ui/PrintPanel.js:798,813,820,861-869`, `src/core/print/PrinterProfiles.js:16-23`, `src/ui/print/CostBlock.js:50`. The pipeline reads `state.print.bedDimensions` (`src/core/print/PrintPipeline.js:409`), never the profile. No format/colour/texture-limit/wall/prep data. `PrinterProfiles.*` helpers, `ExportPlanner.buildExportPlan`, `src/core/printers/PrinterProfile.ts`, `src/export/ExportPipeline.ts` are dead/type-only.
- Options: `ctx.options = {individually, selectedOnly, repair, onProgress}` (`src/core/print/ExportContext.js:131-144`), `ctx.prefs = {objBakeSolidTextures}` only (`:47-51`); `strictExport` read directly (`PrintPipeline.js:525`); `individually` rebuilt unchecked on each render (`PrintPanel.js:591`); `targetPrinterId/bedDimensions/objBakeSolidTextures/strictExport` live in **both** SettingsStore and `.mixo` (`src/core/SettingsStore.js:41`), `repairOnImport` per-user only (`ProjectSerializer.js:187`, `ProjectLoader.js:146`); `minWallThickness/printMode/chordTolerance` dead (`default-settings.json:39-49`).
- 3MF (`ThreeMFWriter.js`): core + Materials 2015/02 `m:` (`:244,401`); no metadata/thumbnail/`requiredextensions`/`p:`; `unit="millimeter"`; reflection `(-x,-z,y)` via PrintSpace (`:289`), seated on bed (`:298-305`); colorgroup alpha always `FF` (`:242-245`); multi-part unit → **one** `<object>` with per-triangle `pid/p1-3` (`:272`); textured path `m:texture2d`+`m:texture2dgroup` (`:331-405`); groups → `<components>` (`:170-211`); whole-file textured-vs-colorgroup decision (`PrintPipeline.js:591-594`); no vertex colours, no paint/MMU attributes.
- OBJ (`ObjWriter.js`): Babylon `OBJExport` (`:235,241`) **not** through PrintSpace (Y-up, x negated — unverified in Mimaki tool); MTL `Kd/Ka/Ks/Ke/d/map_Kd` (`:366-381`); solid bake `solid_RRGGBBAA.png` (`:261-284`); never CSG (`src/core/print/PrintFormats.js:5-6`). STL (`src/core/print/StlWriter.js:134-160`): binary LE, mm, Z-up, no colour, not seated. **No glTF/PLY/VRML writer** (`src/core/print/PrintReadiness.js:4` formats = obj/3mf/stl).
- Textures: frozen full-res source preferred (`ExportTextures.js:25-29`), GPU readback fallback, PNG only, no size cap, diffuse slot only (`:99-101,162`), no sRGB flag check.
- Gate: issue codes `src/core/print/PrintReadiness.js:39-84`; validator emits warnings only (`MeshValidator.js:220-267`) so `geometry-error` is reachable only via validator crash (`PrintPipeline.js:262-283`); strict blocks only confirmed-open (`:525-533`); nothing checks wall thickness, texture dimensions, colour count, floating shells.

### 1.5 Viewport interaction (new scope)

No hover highlight (`InputManager.js:148-159`; `HighlightLayer` only in a comment `src/core/scene/SelectionOutline.js:3`); Ctrl-click unhandled; marquee tests bbox *centres* incl. parts (`src/core/BoxSelect.js:54-66`); snapping only in G/R/S with Ctrl (`InputManager.js:405-408,594-601`) and the translate step is in BU not mm (`default-settings.json:50` → 1.0 = 1 m); gizmo drags unsnapped; no grid/surface/vertex snap; body drag XZ-only (`InputManager.js:224,253`); no nudge keys; no measure tool; HUD not refreshed on `TRANSFORM_COMMITTED` (`src/ui/MeshStats.js:44-58`); undo labels hard-coded English (`src/core/commands/TransformCommands.js:18`, `ParentCommands.js:178`); cursor ops and collection edits not undoable (`src/core/CursorTools.js:4-6`, `ContextMenu.js:594-619`); multi-file drops stack at one point (`ViewportDrop.js:167`); camera: RMB orbit / MMB pan / wheel 8 % about target, no zoom-to-cursor (`src/core/scene/CameraRig.js:151-154,195-253`); display modes exclusive, matte default (`src/ui/ViewportToggles.js:34-76`); cross-section session-only (`src/ui/ScenePanel.js:209-211`); floor-disc setting exists in state but no implementation found.

### 1.6 Risk headline

Appendix §B holds the full register (29 risks). The ones that drive Phase 0: **R2** autosave unreachable (H/H), **R6** Electron reload unguarded, **R1/R8** no write abort, **R4** no persistent storage, **W6** case-sensitive texture names, **F6** replay failure silent, **F1** capture failure silent, **R7** import/load window.

---

## 2. Target design

### 2.1 The user's mental model (plain words)

> **A project is a self-contained file.** Everything you import is copied into it, so it always opens — anywhere. If a model came from a file on your computer, MIXOMESH remembers **where** (its *Source*) so you can **Refresh** it or **Find** it if it moved.
> **Objects** are the things you print; an object is one solid, and its materials are parts that stay together. **Groups** hold objects so they move as one — click a group to grab everything, **double-click to go inside**, **Esc** to step out. A file with several objects arrives as a group named after the file.
> **Pick your printer** first. MIXOMESH then knows the build volume, which file format it wants, how colour reaches it, and what to check before you export. You can still export any format.

### 2.2 Printer strategy and `printers.json` v2

**Principle (AGENTS rule 6 kept):** the printer row is the single source of truth for *defaults, hints, limits, bed and cost*; export format remains the user's explicit button click. Mimaki 3DUJ-553 stays the default and the reference target (Decision 8 resolved).

```jsonc
// src/config/printers.json v2 — one row
"mimaki-3duj-553": {
  "displayName": "Mimaki 3DUJ-553", "vendor": "Mimaki", "process": "uv-inkjet",
  "bed": { "x": 508, "y": 508, "z": 305 },
  "colour": { "mode": "texture", "maxTextureSize": 4096, "maxTexturesPerObject": 1, "alpha": true, "vertexColour": true },
  "export": { "recommended": "obj-mtl", "formats": ["obj-mtl", "3mf-textured", "wrl", "stl"],
              "obj": { "axis": "y-up" }, "threeMF": { "flavour": "core", "seatOnBed": true, "metadata": true } },
  "validation": { "requireWatertight": true, "minWallMM": 1.0, "minFeatureMM": 0.5, "maxTrianglesHint": 2000000 },
  "defaultMaterialId": "mimaki-model",
  "verified": "unverified"   // 'verified' only after a real-slicer round-trip is recorded in docs/reviews
}
```

`process` ∈ `uv-inkjet | polyjet | mjf | fdm | fdm-multi | resin | sls`; `colour.mode` ∈ `texture | vertex | per-part | paint | none`; `export.formats` ⊂ `obj-mtl | 3mf-textured | 3mf-colorgroup | 3mf-bambu | 3mf-prusa | stl | ply | wrl`. `tests/hygiene.test.mjs` validates every row against this schema. Bed/material keys are unchanged, so v1 rows load with defaults.

**What each printer family needs — and today's gap** (slicer behaviour marked *unverified* until a round-trip is recorded):

| Family (examples) | Format(s) | Units / axis | Colour encoding | Limits that matter | Today | Gap → task |
|---|---|---|---|---|---|---|
| **UV-inkjet full colour** — Mimaki 3DUJ-553/2207 (primary) | OBJ+MTL+PNG (primary), textured 3MF, WRL, PLY | mm; prep tool accepts Y-up OBJ *(unverified)* | texture (one per material), vertex colour also accepted | texture ≤ 4096² *(unverified)*, UV 0–1, watertight, min wall ~1 mm | OBJ+3MF textured OK (`ThreeMFWriter.js:331-405`, `ObjWriter.js:366-381`) | texture-size readiness (1.4), WRL/PLY (1.6), OBJ axis per printer (1.7) |
| **PolyJet** — Stratasys J-series via GrabCAD Print | WRL (texture or vertex colour), OBJ+MTL, 3MF | mm | texture or vertex colour | watertight; min wall 0.5–1 mm | OBJ/3MF only | WRL+PLY writers (1.6) |
| **MJF colour** — HP 580 via SmartStream | 3MF (texture/vertex), OBJ, WRL | mm, Z-up 3MF | texture or vertex | watertight; min wall 0.5 mm | 3MF textured | vertex-colour 3MF + WRL (1.6) |
| **FDM multi-material** — Bambu X1C/H2D/A1 AMS, Anycubic Kobra ACE, Elegoo Centauri (Orca forks) | 3MF Bambu/Orca flavour (Production ext, `Metadata/model_settings.config`, per-object extruder, per-triangle `paint_color`), else STL/OBJ per part | mm, Z-up | per-part colour (object = filament) and/or paint | watertight per part; parts must be separate objects | single merged `<object>` per logical object (`ThreeMFWriter.js:272`) | split-by-material parts (1.5), Bambu flavour (1.11) |
| **FDM MMU** — Prusa XL / MMU3 | 3MF with `slic3rpe:mmu_segmentation`, or STL per part | mm | per-part + paint | same | colorgroup only | 1.5 now; Prusa paint deferred (7.1) |
| **Single-material FDM** — Bambu/Prusa/Creality/Elegoo | STL / 3MF / OBJ | mm, Z-up | none | watertight, bed fit, min wall ~0.8 mm | OK (STL LE, 3MF core) | wall/feature hints (1.4) |
| **Resin** — Elegoo Saturn, Anycubic Photon, Formlabs | STL / 3MF / OBJ | mm | none | watertight (hollowing is the slicer's job), min feature 0.3–0.5 mm | OK | hints (1.4) |

**Never a slicer:** no toolpaths, supports, hollowing or profile files; the 3MF flavours carry only what the slicer needs to *identify* parts/colours.

### 2.3 Export flow (beginner-first)

```
Print ▸ [Printer] [Validation] [Export]        ← Scale tab folds into Export ▸ Advanced
▲ Review before export — 1 object not watertight · texture 8192² > 4096² for Mimaki   [Go to Export →]
──────────────────────────────────────────────────────────────────────────────────────
Printer: [Mimaki 3DUJ-553 ▾]   Build volume 508 × 508 × 305 mm   Colour: full-colour textures
──────────────────────────────────────────────────────────────────────────────────────
[  Export for Mimaki 3DUJ-553  (OBJ + MTL + PNG)  ]       ← primary = printer's recommended format
Other formats: 3MF (textured) · WRL · STL · PLY           ← every writer, always clickable
Print at: the size shown (1:1)            [Other sizes…]
▸ Advanced
   ☐ Each object as its own file     ☐ Split multi-material objects into parts (for AMS/MMU)
   ☐ Bake solid colours to texture (OBJ)   ☐ Block export when not watertight (strict)
Cost: PLA · 42 g · $9.40  ⚙
```

Rules: readiness strip on every tab (0.6); clicking "Export for …" runs the gate: errors block, warnings open the three-way modal whose **default button is "Repair & export"** (1.8); formats never hidden or disabled by the printer, only by readiness errors (as today). Every disk write of a new file goes through the OS/Electron dialog; a future "Export again" **re-prompts** (R9).

**Settings scope (Decision 15):** per-project, file-wins — `targetPrinterId, bedDimensions, exportRatios, objBakeSolidTextures, splitByMaterial, individually`; per-user only — `strictExport, repairOnImport, cost.*, volumeMode`, viewport/scene look. `ExportContext.prefs` becomes the one place the pipeline reads print preferences (today `strictExport` bypasses it, `PrintPipeline.js:525`).

### 2.4 Asset model

```js
// AssetEntry (schema 3.4) — replaces directoryHandleKey + fileHandleKey + originalPath
source: null | { kind:'folder'|'file', refKey:string, path:string, label:string }
contentHash: string            // bytes the project currently uses; updated on Refresh/Relink
displayName: string            // ours; never renames the user's file
// fileData embedded on every manual save (unchanged)

// StorageAdapter (both impls)
resolveAsset({source, contentHash, fileData}) → { bytes, origin:'live'|'embedded', drift:boolean, reason? }
persistRef(key, nativeRef) / restoreRef(key) / deleteRef(key)       // browser: idb; desktop: main-process {token→absPath} in mixo-kv.json 'refs'
findMoved(source, contentHash, {limit, onProgress}) → source|null   // today's hash scan, EXPLICIT only
pickOpenProject / pickSaveProject / pickImportAssets / saveExport({suggestedName, bytes}) // desktop via dialog IPC
findByHash(contentHash) → assetId|null                               // in-project dedupe (state lookup, not storage)
```

Resolution: `source` → bytes → hash equal ⇒ `live`; different ⇒ `embedded` + `drift` ("Changed on disk — Refresh?"); unreachable ⇒ `embedded` ("Missing source — Find…"); no bytes ⇒ ghost. Automatic directory scan removed from load (Decision 3). Status (`embedded | live | drift | missing | ghost`) is session state shown in **Properties ▸ Object ▸ Source** and as a card chip only when ≠ `embedded|live`. Linked/Snapshot badges go. Relink/Refresh/Find = one undoable `RelinkAssetCommand`. Desktop refs persist and the same absolute path yields the same token; browser folder keys become stable `dir_<sha256(name+firstEntry)>` (Decision 10). Boot = one non-blocking banner (re-mount all remembered folders · recover newer autosave) (Decision 4). Autosave keyed by `project.id`, never re-encodes already-stored texture images.

**Name-clash rules (adopting the main session's rules, refined):**

1. **Never rename the user's files.** Display names are ours (`displayName`); `filename` stays the original.
2. **Identity = `contentHash`.** Re-importing identical bytes prompts *"chair.glb is already in this project — [Add another copy to the scene] [Import as a separate asset]"*; default = add a copy (instantiate). Drops from the Project tab never prompt. Project load never prompts. (Decision 16)
3. **Same name, different content** → both kept; display names qualified **only while ambiguous within the project**, VS Code style: `chair.glb · downloads` / `chair.glb · models/old` (folder label from `source.label`, or `copy 2` for sourceless). Qualification is recomputed on add/remove.
4. **Generic texture names** (`baseColor|basecolor|albedo|diffuse|Image_\d+|texture\d*|tex_\d+|material_\d+`, case-insensitive, extension stripped) display as `<model> · <slot>` ("chair.glb · Base colour"); original name in tooltip and search. Non-generic names stay, qualified by rule 3 when ambiguous.
5. **Export package names are deterministic, not source-derived:** textures = `<objectName>_<slot>.png` (object names are already unique, `AssetRegistration.js:19-23`), shared textures = `<materialName>.png`; uniqueness is **case-insensitive** and the MTL/3MF references are rewritten in the same pass (closes W6). Per-object files keep `${project}_${object}_r…` (unchanged). (Decision 17)
6. **Overwrite** only through a dialog or an explicit "Replace" confirm; never via a remembered ref.
7. **Material-name clashes on import** keep the existing merge modal (`src/ui/ShaderPanel.js:182-257`).

### 2.5 Hierarchy / grouping

| Concept | Selectable | Gizmo | Validation / export / cost unit |
|---|---|---|---|
| **Object** (lead + hidden material parts) | yes | all parts under the temp pivot (unchanged) | **the unit** (unchanged) |
| **Group** (`scene.groups` + `TransformNode`) | **yes (new)** | the group node itself goes under the pivot → rigid | transparent; 3MF keeps `<components>` |
| ~~Collection~~ | — | — | schema kept for provenance; no Outliner level (Decision 2) |
| ~~`sourceGroupId`~~ | — | — | migrate-only |

Import: a file yielding ≥2 objects arrives as one **Group named after the file stem** (authored sub-hierarchy kept; single-child wrappers collapse); a single-object file arrives bare. Group origin = bottom-centre of the combined AABB. **Click-depth (Figma/Keynote):** click = topmost ancestor below the current scope; double-click = enter and select the child; Esc = step out; click empty = clear; Outliner click selects exactly that row and sets scope to its parent; breadcrumb under the NavCube; box-select picks topmost-below-scope by combined AABB centre; Shift = add, Ctrl = toggle on both surfaces (Decision 5). Commands: Group nests under the common ancestor and uniquifies `Group.001`; Ungroup acts on the *selected group(s)*; Delete/Duplicate accept groups; Lock = transform-lock, cascades (Decision 9); "Separate by material" / "Merge into one object" fix naming and parents.

### 2.6 UI shell and where functions live

Keep: four workspaces (no repeated specialist sections), Blender control language, washi palette, Materials panel as the single edit surface, per-object ratio. Changes (full per-function table in appendix §A):

- **Header:** logo · project name · **Import** (Ctrl+I) · New/Open/Save/Save As/Recent · **Undo/Redo** · workspace pill · **Export** · locale · **?** (shortcuts, tour, preferences incl. *Auto-repair on import*, reset-all with confirm).
- **Properties ▸ Object** (name, visible, lock, print, Source, file units) visible in all four workspaces (Decision 6).
- **Context menu:** primary tier ≤ 12 (Focus · Hide · Lock · Rename · Duplicate · Group · Ungroup · Enter/Exit group · Separate/Merge · Repair · Export selected · Delete) + **Arrange ▸ / Combine ▸ / Select ▸ / Cursor ▸** submenus; impossible items hidden in submenus, greyed in the primary tier (Decision 11).
- **Arrange** panel (was 3D Cursor) with a toolbar button; Array gets a count/spacing dialog.
- **Print panel:** Printer / Validation / Export tabs + readiness strip (§2.3).
- **Terminology** (strings only; keys unchanged): Session/Library → **Project/Folders**; Linked/Snapshot → Source status words; Print Part/Print Export → **Print**; Repair/Auto-Fix/Fix → **Repair**; Source Unit/Authored Scale/Confirm → **File units / Imported as 1:72 / Looks right**; Ratio → **Scale ratio**; Shader → **Material** (Decision 7); Split to parts / Join → **Separate by material / Merge into one object**; Internal part → **Material part**; 3D Cursor → **Arrange**; Mate/Transform Swab/Smart Replace → **Snap to active / Copy placement from active / Replace with active**; Build Volume Preset/Bed → **Printer / Build volume**; Rot (rad) → Rot (deg).
- **Onboarding:** first-run 4-step coach (Import → Arrange → Colour → Print), replayable from **?**; one unified empty-state sentence.

### 2.7 Viewport interaction model (full)

| Area | Target behaviour | Borrowed from |
|---|---|---|
| Selection | click/double-click/Esc scope rule (§2.5); Shift add, Ctrl toggle; marquee by combined AABB centre of topmost-below-scope nodes; `A` select-all at scope; locked nodes selectable but not transformable; hidden never pickable | Figma, Keynote, Tinkercad |
| Hover | subtle outline on hover (reuse `SelectionOutline` mask, third channel), ≤1 pick per frame, disabled above 70 % triangle budget; cursor changes over draggable body | Tinkercad, Spline, Shapr3D |
| Transform | gizmo Move/Rotate/Scale (toolbar); G/R/S modal with axis/plane locks, typed mm/deg/×, Ctrl-snap; **gizmo drags also Ctrl-snap**; snap steps shown in mm (translate 1 mm default; fix BU→mm, `default-settings.json:50`); body drag on ground plane; arrow keys nudge 1 mm (Shift 10, Alt 0.1) | Blender, Tinkercad, Fusion |
| Snapping | Ctrl-snap only (no always-on grid snap); Arrange verbs for exact placement (Drop/Center/Align/Mirror/Array/Snap-to-active); *surface/vertex snap deferred* | Blender, Tinkercad |
| Pivot / orientation | toolbar dropdown (Active / Median / Cursor / World), `.` cycles; Local/World toggle | Blender |
| Camera | RMB orbit, MMB pan, wheel zoom **to cursor** (new option, default on), NavCube, numpad/Alt presets, F frame selection, **Home frame all**, ortho toggle; follow modes kept | Fusion, Shapr3D, Bambu |
| Display modes | Shaded / Matte (default) / Base colour / UV checker exclusive; overlays: wireframe edges, inverted faces, **grid, axes, bed volume, cross-section** as viewport toggles (not only in panels) | Blender, Bambu |
| Cross-section | toggle in viewport + Scene panel; axis/offset/flip; fill + border furniture hidden in exports (unchanged) | Bambu, PrusaSlicer |
| Cursor | Shift+RMB places; cursor ops undoable; cursor sub-section inside Arrange | Blender |
| Measurement | HUD W×D×H + tris refreshed on `TRANSFORM_COMMITTED`; Properties Size (mm); *two-point measure tool optional* (Decision 23) | Bambu |
| Drops | ground-pick position; multi-file drops staggered along X by each bbox width; dedupe prompt (§2.4) | Tinkercad |
| Undo | every command label localised and shown as header tooltip + status; cursor ops and collection edits removed/undoable; undo/redo buttons | Figma |
| Feedback | 2 s toast for silent actions that change many things (swatch recolour "Applied to N objects", workspace jump with "back"); progress overlay gets Cancel where abortable | Spline |

### 2.8 Mockups

Outliner after importing `tank.glb` (hull + turret + 2 wheels) and `base.stl`:

```
Scene objects                        [⌕ filter… file:] [≡ parts]
 ▾ ⧉ tank.glb               👁 🔒 🖨    ← Group (from file), first click selects it
    ▸ ▣ hull    (2 mats)    👁 🔒 🖨    ← Object with hidden material parts
      ▣ turret              👁 🔒 🖨
    ▾ ⧉ wheels              👁 🔒 🖨    ← sub-group (authored node with 2 children)
         ▣ wheel.L          👁 🔒 🖨
         ▣ wheel.R          👁 🔒 🖨
   ▣ base                   👁 🔒 🖨    ← single-object file: no wrapper
```

```
┌───────────────────────────────────────────────┐   Properties ▸ Object (all workspaces)
│ [NavCube]  Scene › tank.glb › wheels [Esc]    │    Name     [ hull                 ]
│            (wheel.L hover-outlined)           │    Visible (●)  Print (●)  Locked ( )
│                                               │    Source   Linked · tanks/tank.glb  [Refresh][Find…]
│   [Move][Rot][Scale] | Pivot ▾ | [Arrange ▾]  │    File units [Millimetres ▾] Imported as 1:1 [Looks right]
└───────────────────────────────────────────────┘
```

---

## 3. Borrowed patterns

| Pattern | Source | Applied as | Why it fits hobbyist printers |
|---|---|---|---|
| Click whole group, double-click enters, Esc exits, breadcrumb | Figma frames; Keynote/PowerPoint groups | §2.5 scope rule, breadcrumb | zero vocabulary to learn |
| Multi-part file arrives as one movable thing | Tinkercad imports; Bambu object list | import group named after file | "I downloaded a tank, I move the tank" |
| Object = print unit with hidden parts; explicit Separate/Merge | PrusaSlicer / Bambu "Split to parts" | logical object kept, verbs renamed | slicer users already know it |
| Rigid group node | SketchUp components, Blender empties | group `TransformNode` under pivot | kitbash rotation must not shear |
| Shift add / Ctrl toggle everywhere | Figma, SketchUp, Shapr3D, Tinkercad | unified modifiers | Blender's Shift-toggle is the outlier |
| Transform-lock keeps selection | Figma, Keynote | lock enforcement | what "lock" means to non-CG users |
| Self-contained file + explicit Find/Relink | Figma, Keynote, Fusion insert-vs-link | embed-always + Source status | "copy vs link" in plain words |
| Printer-first export with recommended format, nothing hidden | Bambu Studio printer preset; Fusion manufacture setup | §2.3 flow | the user's question is "what does *my* printer want?" |
| Readiness strip always visible | Bambu slice status, Fusion warnings | Print header | "can I print this yet?" |
| Hover outline + cursor change | Tinkercad, Spline, Shapr3D | §2.7 | tells beginners what is clickable |
| Zoom to cursor | Fusion, Shapr3D, Bambu | CameraRig option | expected by anyone who used a slicer |
| Tiered context menu with submenus | Spline, Womp, Shapr3D | §2.6 | beginners stop reading after ~10 |
| Arrange panel with named verbs | Tinkercad Align/Mirror; Bambu Arrange / Lay on face | Arrange panel + toolbar | print prep is mostly placement |
| "Already in project" dedupe prompt | Figma components, Blender Asset Browser | §2.4 rule 2 | avoids 5 copies of the same 200 MB scan |
| Qualified names only when ambiguous | VS Code tab titles | §2.4 rule 3 | names stay short until they must not |
| First-run coach marks | Spline, Womp, Nomad Sculpt | 4-step tour | one-time, skippable |
| Workspaces = fixed task layouts | Blender 2.8+ (kept) | unchanged | already locked, works |

---

## 4. Decisions for owner

1. **Groups become first-class selectable nodes with Figma/Keynote click-depth** (overturns the 2026-08-03 rule). *Recommend accept.*
2. **Collections leave the Outliner tree** (become "From file" tooltip + `file:` filter; schema field stays). *Recommend accept.*
3. **Automatic directory hash-scan on load removed**; "Find moved file…" explicit. *Recommend accept.*
4. **Boot prompts become one non-blocking banner** (re-mount all + recover newer autosave). *Recommend accept.*
5. **Viewport Shift = add, Ctrl = toggle** (matches Outliner; departs from Blender). *Recommend accept.*
6. **Properties ▸ Object visible in all four workspaces.** *Recommend accept.*
7. **"Shader" → "Material"** app-wide (strings only). *Recommend accept.*
8. **RESOLVED — Mimaki 3DUJ-553 stays the default printer**; other families supported via printers.json v2 presets.
9. **Lock = transform-lock** (selectable, Delete asks). *Recommend transform-lock.*
10. **Stable per-folder browser keys + persisted desktop tokens.** *Recommend accept.*
11. **Context-menu impossible items**: hidden in submenus, greyed in primary tier. *Recommend accept.*
12. **`scopeId` session-only**, not persisted. *Recommend session-only.*
13. **printers.json v2 schema with capability data** (process, colour mode, texture limits, export defaults, validation hints, `verified` flag); presets set defaults/hints only — formats are never hidden/blocked by the printer. *Recommend accept.*
14. **New writers: PLY (vertex colour) and VRML 2.0 (WRL, texture + vertex colour)** for PolyJet/MJF/Mimaki; **Bambu/Orca-flavoured 3MF** next; Prusa `mmu_segmentation` deferred; **no glTF/GLB export** (not a print hand-off format). *Recommend accept.*
15. **Settings scope**: per-project file-wins = printer, bed, export ratios, bake-solids, split-by-material, individually; per-user = strict, repair-on-import, cost, look. *Recommend accept.*
16. **Re-import dedupe prompt** default = "Add another copy to the scene" (same asset). *Recommend accept.*
17. **Export texture names deterministic** (`<object>_<slot>.png`, case-insensitive unique) instead of source filenames. *Recommend accept.*
18. **Gate defaults**: warnings modal default button = **Repair & export**; strict mode blocks on *unknown* verdict too (engine missing / over cap); `invertedNormals` + confirmed non-watertight become "review" warnings (unchanged severity) with Repair first. *Recommend accept.*
19. **Security budget**: CSP + `sandbox:true` + `will-navigate` guard; import caps file 1 GB, zip entries ≤ 256, uncompressed ≤ 2 GB, triangles hard cap = 4× budget. *Recommend accept with these numbers.*
20. **`navigator.storage.persist()`** requested on first save (web). *Recommend accept.*
21. **Thin-wall check**: advisory proxy now (smallest AABB extent and per-shell thickness estimate vs `minWallMM`); true thin-wall analysis deferred. *Recommend proxy now.*
22. **Hover highlight** in the viewport (perf-gated). *Recommend accept.*
23. **Two-point measure tool**: optional Phase 7. *Recommend defer.*

---

## 5. Implementation plan (risk-first)

### Phase 0 — Safety net and quick wins (data-loss, wrong-print, hygiene) · 12 tasks

**0.1 Terminology pass (strings only).** Files: `src/i18n/locales/{en,ja,zh-Hant}.json`; hard-coded strings in `src/ui/AppShell.js:146-193`, `src/core/InputManager.js:673-695`, `src/ui/CopyPaste.js` ASPECTS. Behaviour: §2.6 table minus Shader→Material; `status.defaultHint` matches `_defaultHint`. Accept: `npm run i18n:check` 0 gaps; `tests/i18n.test.mjs`; smoke pins updated in the same commit. Tier: haiku.

**0.2 Write hardening + persistent storage.** Files: `src/core/PersistenceManager.js:50-74`, `src/core/print/Download.js:8-36`. Behaviour: `w.abort()` on any write failure; `pushRecent` failure after a successful write is reported but never rejects `save()` nor leaves dirty wrong; non-Abort FSA errors surface a toast before the anchor fallback; on first successful save call `navigator.storage.persist()` once (web). Accept: `tests/persistence-saveas.test.mjs` + `tests/export.test.mjs` extended (abort called, toast on fallback); headless stub for `navigator.storage`. Tier: sonnet.

**0.3 Input hygiene.** Files: `src/core/InputManager.js:95,201-205,797-800,811-814`, `src/ui/ContextMenu.js:162,227,216`, `src/ui/Outliner.js` (focus). Behaviour: viewport context active when focus is on `body`, canvas or Outliner (not inputs); Shift = add, Ctrl = toggle; remove `Tab`; delete the Ctrl+S/N/O no-op stubs; register F2 (rename) and Ctrl+I (import) globally, Home = frame all, L = lock toggle; one Unparent item. Accept: `tests/box-select.test.mjs` unchanged; new asserts in `tests/safety-commands.test.mjs` via an exported `InputManager.__test` seam; smoke: click Outliner row, send `Delete`. Tier: sonnet.

**0.4 Electron reload / crash guard.** Files: `src/app/main.ts:130-139`, `electron/main.cjs:34-38`. Behaviour: `beforeunload` also under Electron; `render-process-gone` → main shows a dialog offering to reopen; `MIXO_SMOKE` bypass only when `NODE_ENV!=='production'`. Accept: `tests/electron-smoke.mjs` greps the new handler; headless test for the `beforeunload` predicate. Tier: sonnet.

**0.5 Load-path integrity.** Files: `src/core/assets/AssetImport.js:172-187`, `src/core/PersistenceManager.js:118-146`, `src/core/persist/ProjectLoader.js:359-368`. Behaviour: `_importBegin` before any `await`; `open/openRecent` call `assertNoImportInFlight` before the dirty confirm; a failed `geometryFixes` replay removes the fix from state and toasts "Repair could not be replayed for X — run Repair". Accept: `tests/persistence-load-guards.test.mjs` F20 window case + replay-failure case. Tier: sonnet.

**0.6 Readiness strip on every Print tab.** Files: `src/ui/PrintPanel.js:107-130`, `src/styles/components/print.css`. Accept: smoke asserts strip text "Ready" after the closed fixture import. Tier: sonnet.

**0.7 Arrange rename + toolbar button.** Files: `src/ui/CursorPanel.js`, `src/ui/ViewportToolbar.js`, locales. Accept: smoke: toolbar button opens `#cursor-panel`. Tier: haiku.

**0.8 Texture capture failure surfaced.** Files: `src/core/assets/TextureCap.js:76-78`, `src/core/assets/TextureAssets.js:117`. Behaviour: capture failure sets `asset.captureFailed=true` and the export path refuses to downscale (uses GPU readback only when cap is Off, else aborts with the texture named). Accept: `tests/texture-source.test.mjs` new case. Tier: sonnet.

**0.9 Undo/Redo buttons + reset-all confirm.** Files: `src/ui/StatusBar.js:274-291`, `src/ui/ProjectMenu.js:24-51`. Accept: smoke clicks Undo after Duplicate. Tier: haiku.

**0.10 Case-insensitive texture export names.** Files: `src/core/print/ExportTextures.js:72-84`, `src/core/print/PrintPackaging.js:72-89`. Behaviour: `usedNames` compares lower-case; writers receive the final name map so MTL/3MF references always match. Accept: `tests/export.test.mjs`: `A.png`/`a.png` → distinct names and matching references in MTL and `3dmodel.model`. Tier: sonnet.

**0.11 Autosave: reachable, keyed by id, cheap.** Files: `src/core/persist/Autosave.js:15-88`, `src/core/persist/ProjectSerializer.js:166-178`, `src/core/StateManager.js:7`, `src/app/main.ts:118-120`, `src/ui/ProjectMenu.js:201`. Behaviour: `project.id` (uuid) added to state/document; keys `autosave_<id>`; a newer-than-`savedAt` autosave is offered at boot (modal now; banner in 4.7); `textureImages` entries already present by hash are not re-encoded; the dirty/loading check wraps the whole build. Accept: `tests/persistence-load-guards.test.mjs` (offer only when newer; same-name projects don't clobber); `tests/persistence-abort.test.mjs` (no re-encode). Tier: opus.

**0.12 Shader → Material strings.** Files: three locale JSONs. Accept: i18n check; smoke pins. Deps: Decision 7. Tier: haiku.

### Phase 1 — Printer strategy and export flow · 12 tasks

**1.1 printers.json v2 + loader.** Files: `src/config/printers.json`, `src/core/print/PrinterProfiles.js`, `src/core/printers/PrinterProfile.ts`, `tests/hygiene.test.mjs`, `tests/printer-profile.test.mjs`, `Blueprint.md` §12 Printer Profiles. Behaviour: §2.2 schema; `getPrinterProfile(id)` returns a normalised row with defaults for v1 rows; rows for Mimaki ×2, Stratasys J55/J850, HP MJF 580, Bambu X1C/H2D/A1/A1 mini, Prusa MK4/XL, Creality K1/Ender-3, Elegoo Centauri/Saturn 4 Ultra, Anycubic Kobra 3/Photon Mono, Formlabs Form 4, Generic OBJ, Custom; every row `verified:'unverified'` except Mimaki (owner records verification). Accept: hygiene test validates every row; profile test covers v1-row defaulting. Tier: sonnet.

**1.2 Printer tab.** Files: `src/ui/PrintPanel.js:798-889`, locales. Behaviour: tab renamed Printer; select grouped by vendor; shows build volume, colour capability sentence, recommended format; editing bed sets `custom` (as today); custom with null axis shows "unlimited" explicitly and readiness says so (W4). Accept: smoke: selecting Bambu X1C sets bed 256³ and the Export primary label reads "Export for Bambu Lab X1 Carbon (3MF)". Tier: sonnet.

**1.3 Export flow + settings scope.** Files: `src/ui/PrintPanel.js` (Scale tab folds into Export ▸ Advanced; options persisted), `src/core/print/ExportContext.js:47-51,131-144` (`prefs` carries `strictExport, splitByMaterial, individually, objBakeSolidTextures`), `src/core/print/PrintPipeline.js:525`, `src/core/SettingsStore.js:35-47`, `src/core/persist/ProjectSerializer.js:187`, `src/core/persist/ProjectLoader.js:146`, `src/config/default-settings.json`, `Blueprint.md` §12/§11. Behaviour: §2.3 layout; primary button = `export.recommended`; all formats listed; per-project vs per-user per Decision 15; "Auto-repair on import" moves to ? ▸ Preferences; every disk write through a dialog. Accept: `tests/export-context.test.mjs` (prefs threaded, pipeline reads `ctx.prefs.strictExport`); `tests/settings-store.test.mjs` (scope split); smoke: Advanced disclosure toggles persist across re-render. Tier: opus.

**1.4 Per-printer readiness hints.** Files: `src/core/print/PrintReadiness.js`, `src/core/MeshValidator.js` (new `thinFeature` advisory), `src/core/print/ExportTextures.js`, locales. Behaviour: new codes `texture-too-large` (warning: any exported texture > `colour.maxTextureSize`), `texture-count` (warning), `thin-feature` (advisory, Decision 21), `watertight-required` (warning when `validation.requireWatertight` and a unit is confirmed open; strict makes it an error); `below-bed` applies to formats not seated. Accept: `tests/print-readiness.test.mjs` per code. Tier: sonnet.

**1.5 3MF: split-by-material parts, metadata, thumbnail, alpha.** Files: `src/core/print/ThreeMFWriter.js:170-211,242-272,331-405`, `src/core/print/PrintPipeline.js:591-611`, `src/core/print/PrintPackaging.js`. Behaviour: `prefs.splitByMaterial` writes one `<object>` per material part grouped by a `<components>` parent (per-part colour printers), default on when `colour.mode ∈ {per-part, paint}`; `<metadata name="Title|Application|CreationDate">`; `Metadata/thumbnail.png` (reuse `capturePng`); colorgroup alpha from material alpha when `colour.alpha`. Accept: `tests/threemf-materials-ext.test.mjs` + `tests/threemf-components.test.mjs`: split cube → 2 objects + 1 component; thumbnail present; round-trip loads as one logical object (loader already groups by `sourceGroupId`). Owner eyeball: Bambu Studio / PrusaSlicer open the file (record in `docs/reviews/`). Tier: opus.

**1.6 PLY + WRL writers (vertex colour / texture).** Files: new `src/core/print/PlyWriter.js`, `src/core/print/WrlWriter.js`, `src/core/print/PrintFormats.js`, `src/core/print/PrintReadiness.js:4`, `src/ui/PrintPanel.js` buttons, `src/core/PrintManager.js`. Behaviour: PLY binary LE with `x y z nx ny nz red green blue alpha` (+ `s t` when textured) through PrintSpace Z-up; vertex colour = sampled from the diffuse texture at UV (bilinear) or material colour; WRL (VRML 2.0) `Shape/IndexedFaceSet` with `ImageTexture` + `texCoord` (textured) or `Color` per vertex; mm. Accept: `tests/export.test.mjs` byte-level checks; trimesh reads PLY/WRL with volume +1000 on the tetra fixture (`tests/scan-probe.mjs` extension). Tier: opus.

**1.7 OBJ through PrintSpace with per-printer axis.** Files: `src/core/print/ObjWriter.js:231-246`, `src/core/print/PrintSpace.js`, `tests/print-space.test.mjs`. Behaviour: OBJ vertices go through `toPrintSpace` then an optional `yUp` remap per `export.obj.axis`; winding per mesh via `printIndices`; verified empirically (trimesh +1000 both axes). Accept: print-space test; owner eyeball in Mimaki prep tool for Y-up. Tier: opus.

**1.8 Gate tightening.** Files: `src/core/print/PrintPipeline.js:316-323,525-533,560-566`, `src/ui/PrintPanel.js:672-730,968`. Behaviour: Decision 18 (default button "Repair & export"; strict blocks on unknown verdict; acknowledgement enforced inside `_runExport`, not only in the panel). Accept: `tests/export-gate.test.mjs`, `tests/export.test.mjs` strict/unknown case. Tier: sonnet.

**1.9 Texture colour-space check + all-formats parity.** Files: `src/core/print/ExportTextures.js:25-50`, `src/core/assets/TextureReadback.js:84`, `src/core/shaders/ColorSpace.js`. Behaviour: PNG written from the frozen source bytes verbatim; GPU-readback path converts linear→sRGB when the Babylon texture is flagged non-sRGB; a dedicated `tests/color-space.test.mjs`. Accept: that test + `tests/texture-readback.test.mjs` case. Tier: sonnet.

**1.10 Dead export code/settings removal.** Files: `src/core/print/ExportPlanner.js` (`buildExportPlan`), `src/core/print/PrinterProfiles.js:12-35` unused helpers, `src/export/ExportPipeline.ts`, `src/import/ImportPipeline.ts`, `default-settings.json` keys `printMode/chordTolerance/minWallThickness` (replaced by printer `validation.*`), `src/core/SettingsStore.js`. Accept: lint; `tests/settings-store.test.mjs` updated; `tests/state-shape.test.mjs`. Tier: haiku.

**1.11 Bambu/Orca-flavoured 3MF.** Files: `src/core/print/ThreeMFWriter.js` (flavour switch), new `src/core/print/ThreeMFBambu.js`. Behaviour: when `export.threeMF.flavour==='bambu'`: Production extension (`p:UUID` on objects/items, `requiredextensions`), `Metadata/model_settings.config` with one `<object>` per part and `<part>`/`extruder` from a material→slot map (first 4 distinct colours → slots 1–4, rest warn), `Metadata/project_settings.config` minimal, thumbnail; **no** per-triangle paint in this task. Accept: `tests/threemf-bambu.test.mjs` (XML shape); owner eyeball in Bambu Studio → record `verified`. Tier: opus.

**1.12 Blueprint §12 rewrite (printer profiles, export flow, writers).** Tier: haiku (after 1.1–1.11).

### Phase 2 — Hierarchy core · 7 tasks

**2.1 Selection accepts group ids.** Files: `src/core/Selection.js`, `src/core/LogicalObjects.js`, `Blueprint.md` §4b. Behaviour: `set/add/toggle` accept group ids; `_resolve` returns `{id,node,kind}`; `getSelectedResolved()` unchanged contract; new `getSelectedNodes()`. Accept: new `tests/selection-groups.test.mjs`. Tier: opus.

**2.2 Pivot attaches group nodes rigidly.** Files: `src/core/scene/PivotSession.js:175-238`, `src/core/commands/TransformCommands.js`, `src/core/commands/support.js`, `src/core/InputManager.js:319-399`. Behaviour: selected nodes (mesh or group) go under the pivot; snapshots keyed by node id; pivot = AABB centre of selected geometry. Accept: `tests/history-pivot.test.mjs` extended (group move/rotate/undo). Tier: opus.

**2.3 Group creation semantics + persistence.** Files: `src/core/commands/ParentCommands.js:168-271`, `src/core/persist/ProjectSerializer.js:225-233`, `ProjectLoader.js:76-117`. Behaviour: parent = common ancestor; name uniquified; origin = bottom-centre AABB; transform round-trips. Accept: `tests/hierarchy.test.mjs`. Tier: sonnet.

**2.4 Ungroup on selected groups; Delete/Duplicate accept groups.** Files: `ParentCommands.js:277-368`, `src/core/commands/HierarchyCommands.js:171-303`, `src/core/InputManager.js:760-777`, `src/ui/ContextMenu.js:544-560`. Accept: `tests/hierarchy.test.mjs` (subtree delete, deep duplicate, clean `childIds` after undo). Tier: sonnet.

**2.5 Lock enforcement (transform-lock, cascades).** Files: `Selection.js`, `PivotSession.js`, `InputManager.js`, `src/ui/PropertiesPanel.js`, `HierarchyCommands.js:52-72`. Accept: `tests/safety-commands.test.mjs`. Tier: sonnet.

**2.6 Logical-object edge cases.** Files: `ParentCommands.js:416-530`, `src/core/MeshValidator.js:513-518`, `src/core/print/ExportContext.js:167-190`, `HierarchyCommands.js:363-382`. Behaviour: Split names `.001` + group `<lead> parts`; Join reparents parts; dedupe by `canonicalObjectId`; `PrintPartCommand` expands to parts so lead/part flags never diverge. Accept: `tests/split-join.test.mjs`, `tests/validator-group.test.mjs`, `tests/export-context.test.mjs`. Tier: sonnet.

**2.7 Retire runtime reads of `sourceGroupId`.** Files: `LogicalObjects.js:29,47`, `MeshValidator.js:140-151,332-335`, `HierarchyCommands.js:330-345`, `AssetRegistration.js:111,162`, loader seed. Accept: `tests/logical-objects.test.mjs`. Tier: sonnet.

### Phase 3 — Hierarchy UI · 7 tasks

**3.1 Import rule: multi-object file → group named after the file.** Files: `src/core/import/ImportHierarchy.js:68-160`, `src/core/assets/AssetImport.js:235,330`, `AssetRegistration.js:93-189`, `Blueprint.md` §8. Accept: `tests/split-on-import.test.mjs`, `tests/library-import.test.mjs`; smoke group count. Tier: sonnet.

**3.2 Scope + click-depth.** Files: `Selection.js` (`scopeId`, `enterScope/exitScope`), `InputManager.js:190-237`, `src/core/SceneManager.js:647-669` (`pickSelectionTargetAt`), `src/core/BoxSelect.js:54-67`, `src/core/events.js` (`SCOPE_CHANGED`), `Blueprint.md` §4b/§6. Behaviour: §2.5; double-click = two POINTERDOWNs < 350 ms / < 4 px; Esc priority modal > marquee > scope. Accept: `tests/selection-groups.test.mjs`; smoke double-click selects child. Tier: opus.

**3.3 Breadcrumb + status hint.** Files: new `src/ui/ScopeBreadcrumb.js`, `index.html`, `src/styles/components/viewport.css`. Accept: smoke breadcrumb text. Tier: sonnet.

**3.4 Outliner: group rows selectable, collections demoted.** Files: `src/ui/Outliner.js:110-171,241-268,703-739,781-788`, locales. Behaviour: no collection rows; "From file" tooltip + `file:` chip; group rows highlight; eye/lock cascade. Accept: smoke `aria-selected` on group row; `tests/hierarchy.test.mjs` cascade. Deps: Decision 2. Tier: sonnet.

**3.5 Context menu tiering + Enter/Exit group + collection items removed.** Files: `src/ui/ContextMenu.js:114-262,587-619`, `src/styles/components/context-modal.css`, locales. Behaviour: §2.6; Rename triggers Outliner inline rename (no `window.prompt`); impossible items per Decision 11. Accept: smoke pins ≤ 14 top-level items with one object selected; submenu opens. Tier: sonnet.

**3.6 Properties with a group active.** Files: `src/ui/PropertiesPanel.js:112-148,211-242`. Accept: smoke group name + Pos X edit moves the node. Tier: sonnet.

**3.7 Blueprint §5/§13 sync + command labels via `t()`.** Files: `src/core/commands/*.js` labels, `Blueprint.md`. Tier: haiku.

### Phase 4 — Asset model and name clashes · 10 tasks

**4.1 Schema 3.4 + real `migrate()`.** Files: `src/core/persist/constants.js`, `ProjectLoader.js:121-126`, `ProjectSerializer.js:76-163`, `src/core/persist/ProjectValidator.js`, `src/core/StateManager.js:7`, `Blueprint.md` §11. Behaviour: `source`, `project.id`, `displayName`; map legacy keys; keep legacy keys on write for one minor; newer-minor docs log a notice and preserve unknown top-level keys on re-save. Accept: `tests/persistence.test.mjs` (3.3→3.4 migrate; 3.4 round-trip; legacy resolve). Tier: opus.

**4.2 Adapter `resolveAsset / persistRef / restoreRef / findMoved`, desktop persistence.** Files: `src/core/storage/StorageAdapter.js`, `src/core/storage/DesktopStorageAdapter.js`, `src/core/persist/AssetResolver.js`, `src/core/assets/DirMounts.js`, `electron/OpaqueFileRegistry.cjs`, `electron/main.cjs`, `electron/preload.cjs`, `electron/KvStore.cjs` (`refs` namespace). Behaviour: §2.4; stable keys (Decision 10); desktop tokens re-validated on restore; `watchFiles` declared false until implemented. Accept: `tests/storage-adapter.test.mjs` conformance against both impls; `tests/opaque-file-registry.test.mjs` persistence + no-growth; `tests/persistence.test.mjs` tiers (live / drift / embedded / ghost). Tier: opus.

**4.3 Explicit "Find moved file…".** Files: `AssetResolver.js:18-35` → adapter `findMoved`, `src/ui/AssetPanel.js` card menu, `src/ui/PropertiesPanel.js` Source row. Accept: headless: load never scans; `findMoved` with progress callback test. Deps: Decision 3. Tier: sonnet.

**4.4 Route remaining FSA/idb calls + boot gate.** Files: `src/core/PersistenceManager.js:57,88,124,177`, `ProjectLoader.js:494`, `src/ui/ViewportDrop.js:62,129-130`, `src/core/print/Download.js`, `src/ui/AssetPanel.js:225`, `src/app/main.ts:41`, `DesktopStorageAdapter.js` (dialog IPC + token-only `fs:writeRef`). Accept: spies prove adapter use; `npm run test:electron` (headful, `MIXO_SMOKE=save`) opens + saves via IPC. Tier: opus.

**4.5 `RelinkAssetCommand`.** Files: new `src/core/commands/AssetCommands.js`, `ProjectLoader.js:491-532` (delete `relinkAsset`), `src/core/assets/AssetRestore.js`, `src/core/assets/ObjSiblings.js`. Behaviour: updates `source` + `contentHash`, restores with `libraryItem` + siblings, disposes old container, undoable. Accept: `tests/persistence.test.mjs` relink → new hash embedded; undo restores. Tier: sonnet.

**4.6 Source status, Properties row, Project/Folders tabs, card menu, one Sources modal.** Files: `ProjectLoader.js:236-312,330,388`, `src/ui/PropertiesPanel.js`, `src/ui/AssetPanel.js:444-495,636-670`, `src/ui/ProjectMenu.js:217-296` (merge `unmatchedAssets`/`ghostAssets`/`portableSaveBlocked` renderers), `src/ui/ContextMenu.js:207-209`, locales. Accept: smoke Source reads "Embedded copy"; `tests/persistence.test.mjs` status values. Tier: sonnet.

**4.7 Boot banner (re-mount all + recover).** Files: new `src/ui/BootBanner.js`, `src/ui/AssetPanel.js:136-231`, `src/core/persist/Autosave.js`, `src/ui/ProjectMenu.js:201`, `src/app/main.ts:118-120`, `src/core/persist/RecentProjects.js:23-24` (prune stale handles). Accept: `tests/persistence-load-guards.test.mjs`; smoke banner renders with a stored autosave. Deps: Decision 4. Tier: sonnet.

**4.8 Name-clash rules.** Files: `src/core/assets/AssetImport.js:172-187` (`findByHash` + prompt), new `src/core/assets/DisplayNames.js` (rules 3–4, pure), `src/core/assets/TextureAssets.js:156-159`, `src/ui/AssetPanel.js` cards, `src/ui/Outliner.js` tooltips, `src/core/print/ExportTextures.js:72-84` + `ObjWriter.js:381` + `ThreeMFWriter.js:355-357` (rule 5), `src/ui/ViewportDrop.js:141-171` (dedupe prompt only for OS drops/picker), locales. Accept: new `tests/display-names.test.mjs` (qualification only when ambiguous; generic-name list; recompute on removal); `tests/library-import.test.mjs` (identical bytes → prompt stub → "copy" instantiates the existing asset); `tests/export.test.mjs` (`<object>_<slot>.png`, case-insensitive, references match). Deps: Decisions 16–17. Tier: opus.

**4.9 Dead code + registry growth.** Files: `src/core/assets/DirMounts.js:50-67`, `electron/OpaqueFileRegistry.cjs:43`, `restoreDirectory`, `pickOpen/pickSave` (now used or removed), duplicate `SESSION_KEY` constants, `ProjectValidator` `OBJECT_FIELDS 'scene'`. Accept: lint; registry listing twice yields same tokens. Tier: haiku.

**4.10 Blueprint §11 rewrite + ADR 0001 addendum + HANDOFF resume pointer.** Tier: haiku.

### Phase 5 — Shell, viewport, onboarding · 10 tasks

**5.1 Header: Import / Export / Undo / Redo / ?; reset-all under ? with confirm.** Files: `src/ui/ProjectMenu.js:24-51`, `index.html:40-57`, `src/styles/components/project.css`, `src/core/InputManager.js` (Ctrl+I). Accept: smoke `#btn-import` triggers `ViewportDrop.promptImport` spy. Tier: sonnet.

**5.2 Properties ▸ Object in all workspaces.** Files: `src/styles/layout.css:378-409`, `src/ui/PropertiesPanel.js`. Accept: `scripts/ui-screenshot.mjs` four captures; `PROBE=1`. Deps: Decision 6. Tier: haiku.

**5.3 Print panel re-layout polish + Cost ⚙ popover.** Files: `src/ui/PrintPanel.js`, `src/ui/print/CostBlock.js:63,199-203`. Accept: smoke pins "Print at: the size shown". Tier: sonnet.

**5.4 Feedback toasts + Scene Advanced disclosure.** Files: `src/ui/ShaderPanel.js:727-737,788-796`, `src/ui/PrintPanel.js:90-99,787`, `src/ui/ScenePanel.js:317-390`, locales. Behaviour: swatch toast "Applied to N objects sharing this material"; workspace-jump toast with "back"; Grade/Lights/SSAO inside an Advanced disclosure. Accept: smoke toast text. Tier: sonnet.

**5.5 Onboarding coach + ? sheet + Preferences.** Files: new `src/ui/Onboarding.js`, new `src/styles/components/onboarding.css` (imported from `src/styles/components.css`), `index.html`, locales; `localStorage mx-onboard-v1`. Accept: smoke overlay present with cleared storage; Skip hides; ? reopens. Tier: sonnet.

**5.6 Viewport interaction upgrades.** Files: `src/core/scene/SelectionOutline.js` (hover channel), `src/core/InputManager.js:148-159` (hover pick throttle, arrow nudge), `src/core/scene/PivotSession.js` (gizmo Ctrl-snap via Babylon `snapDistance`), `src/config/default-settings.json:50` + `src/core/InputManager.js:594-601` (snap in mm), `src/core/scene/CameraRig.js:151-154` (zoom-to-cursor option), `src/ui/ViewportToolbar.js:27-38` (pivot/follow dropdowns), `src/ui/ViewportDrop.js:167` (stagger), `src/ui/MeshStats.js:44-58` (`TRANSFORM_COMMITTED`), `src/ui/CursorPanel.js:97` (Array dialog). Accept: `tests/box-select.test.mjs`; new `tests/snap-units.test.mjs` (1 mm = 0.001 BU); smoke hover outline flag after synthetic pointermove; eyeball. Deps: Decision 22. Tier: opus.

**5.7 Viewport toggles for grid/axes/bed/cross-section.** Files: `src/ui/ViewportToggles.js:34-99`, `src/ui/ScenePanel.js:430-449`. Accept: smoke toggle flips `state.scene.section.enabled`. Tier: sonnet.

**5.8 Progress Cancel + modal queue.** Files: `src/ui/ProgressOverlay.js:244-251`, `src/ui/Modal.js:86`. Accept: `tests/progress-overlay.test.mjs`; new modal-queue test. Tier: sonnet.

**5.9 Undoable cursor ops; remove collection edits.** Files: `src/core/CursorTools.js:33-66`, `src/ui/ContextMenu.js:587-619`. Accept: `tests/safety-commands.test.mjs`. Tier: haiku.

**5.10 Blueprint §13/§13b/§6 sync.** Tier: haiku.

### Phase 6 — Hardening and maintenance · 7 tasks

**6.1 Electron security: CSP, sandbox, navigation guards.** Files: `electron/main.cjs:25-29`, `index.html:22,123` (move inline scripts to modules), `vite.config.ts` (CSP meta), `electron/preload.cjs`. Behaviour: `sandbox:true`, `will-navigate` + `setWindowOpenHandler` deny, `session.setPermissionRequestHandler` deny-all, CSP `default-src 'self'; img-src 'self' data: blob:; worker-src 'self' blob:`. Accept: `npm run test:electron` boots; `npm run build` + browser smoke green under the CSP. Deps: Decision 19. Tier: opus.

**6.2 Dialog IPC via descriptors.** Files: `electron/main.cjs:104-105`, `electron/preload.cjs:32-33`, `DesktopStorageAdapter.js`. Behaviour: renderer passes only `{suggestedName, filters}`; main returns a token + display name; `fs:writeRef` accepts tokens minted by `dialog:save` only, with a size cap. Accept: `tests/opaque-file-registry.test.mjs`. Tier: sonnet.

**6.3 Boolean gate covers every texture slot.** Files: `src/core/commands/BooleanCommands.js:23`, `src/core/BooleanService.js:97-113`. Accept: `tests/boolean-service.test.mjs`. Tier: haiku.

**6.4 Import limits + validation-worker timeout.** Files: `src/core/assets/AssetImport.js:172-180`, `src/core/ThreeMFLoader.js:534`, `src/core/ValidateWorker.js:14-20`, `src/core/MeshValidator.js:115-122`. Behaviour: Decision 19 caps; zip entry/uncompressed limits before `loadAsync` consumption; worker timeout 120 s with inline fallback. Accept: `tests/threemf-components.test.mjs` (limit throws), `tests/validation-cache.test.mjs` (timeout path). Tier: sonnet.

**6.5 Escaping test.** Files: new `tests/render-safe.test.mjs` driving `src/ui/renderSafe.js` + a DOM-stub render of Outliner/AssetPanel rows with hostile names. Tier: haiku.

**6.6 Headless coverage for untested core modules.** Files: new tests for `src/core/scene/PivotSession.js`, `src/core/commands/ParentCommands.js`, `TransformCommands.js`, `src/core/persist/AssetResolver.js`, `ProjectValidator.js`, `src/core/print/PrintPackaging.js`, `src/core/assets/TextureCap.js` (each with the existing `tests/env.mjs` shims). Accept: each file ≥ 5 asserts; `npm test` green. Tier: sonnet (one task per module, parallelisable).

**6.7 Blueprint §0.3 file-layout sync + BUILDLOG entry.** Tier: haiku.

### Phase 7 — Deferred (not scheduled)

7.1 Prusa `slic3rpe:mmu_segmentation` + Bambu per-triangle `paint_color` (needs a face-paint tool first) · 7.2 HP MJF / PolyJet real-slicer verification pass (owner, records `verified`) · 7.3 two-point measure tool (Decision 23) · 7.4 `watchFiles` desktop watcher → auto "Changed on disk" · 7.5 `caps.externalTools` + `src/core/tools/ToolAdapter.js` typedef (Blender sidecar seam, one file, no callers) · 7.6 surface/vertex snapping · 7.7 per-section workspace expand presets.

### Dependency graph and order

```
0.1–0.12 (independent; 0.11 before 4.7) ──────────────────────────────┐
1.1 → 1.2 → 1.3 → 1.4 → 1.8        1.5 → 1.11      1.6, 1.7, 1.9, 1.10 → 1.12
2.1 → 2.2 → 2.3 → 3.1 → 3.2 → 3.3 ; 2.1 → 2.4, 2.5 ; 2.6 → 2.7 ; 3.2 → 3.4 → 3.5 → 3.6 → 3.7
4.1 → 4.2 → 4.3, 4.4, 4.5 → 4.6 → 4.7 ; 4.1 → 4.8 ; 4.2 → 4.9 → 4.10
5.1–5.10 after Phase 3 (5.6 after 3.2) ; 6.1–6.7 any time after Phase 0 (6.2 after 4.4)
```

Recommended order: 0 → 1 → 2 → 3 → 4 → 5 → 6. Phases 1 and 2–3 are independent and may interleave; Phase 4's schema bump (4.1) should land after 2.7 so `logicalObjectId` seeding is final.

---

## 6. Risks and what not to do

Full register with likelihood/impact/mitigation/gap/closing task: appendix §B. Execution risks of this plan itself:

- **Selection invariant change (2.1)** touches every `logicalObjectCommandIds` caller — `getSelectedResolved()` keeps its mesh-only contract; run `npm run test:all` after 2.1 and 2.2.
- **Group transforms × export seam**: `PrintPrep.flattenWorld` bakes ancestor matrices, so rigid groups export correctly — verify empirically (tetra inside a rotated group → trimesh +1000, PrusaSlicer manifold).
- **New writers (1.6, 1.11) and the OBJ axis change (1.7)** are *unverified in real slicers* until the owner records a round-trip in `docs/reviews/`; rows stay `verified:'unverified'` and the UI shows "(untested preset)" until then.
- **Schema 3.4**: legacy keys kept on write for one minor; test both directions (4.1). Old browser mount keys keep resolving via `restoreRef`.
- **Terminology renames** collide with smoke pins — update pins in the same commit (0.1, 0.12).
- **CSP (6.1)** can break Babylon workers/blob URLs — ship behind a build flag first, smoke under it before making it default.
- **Electron tasks** are headless-unverifiable; each ends with `npm run test:electron` headful on the owner's machine.

**Do NOT:** build a slicer (no toolpaths/supports/hollowing/profiles); let the printer preset hide, switch or block a format (AGENTS rule 6); reintroduce a global scale; downscale textures or freeze meshes; let OS paths into renderer state or `.mixo`; make the hash scan automatic again; replace bytes whose hash differs without a click; silently overwrite files; add a fifth workspace or repeat a specialist section; build dockable panels, a DAM, or cloud sync; plan the Blender sidecar beyond the `ToolAdapter` typedef; reason about axes/winding on paper; auto-merge "Separate by material" parts on import; rename the user's files on disk.
