# UX / Asset / Grouping Overhaul — implementation plan

**Date:** 2026-10-14 · **Status:** proposal for owner review · **Branch:** master (solo, no feature branches)
**Supersedes in part:** `docs/superpowers/specs/2026-08-03-editor-asset-hierarchy-ux-design.md` §"Scene hierarchy" (its "viewport picking selects an Object only, never a Group" rule is the behaviour the owner now wants changed — see Decision 1). Everything else in that spec (asset index, shader identity, readiness) stands.
**Authority:** `AGENTS.md` rules 1–8 apply to every task below. Every task that changes a contract updates `Blueprint.md` in the same commit.

> **For agentic workers:** execute task-by-task with `superpowers:subagent-driven-development` or `superpowers:executing-plans`. Each task names its files, exact behaviour, acceptance checks and a worker tier (**haiku** = mechanical / 1 file, **sonnet** = bounded 1–3 file feature, **opus/main** = cross-cutting or judgement). Verify gate for every task: `npm run lint && npm run typecheck && npm run i18n:check && npm test`; browser smokes where the task says so. Commit per task on master.

---

## 0. Executive summary

Three owner complaints, one root cause each:

| Complaint | Root cause in code | Fix in one line |
|---|---|---|
| Asset handling is not elegant across web + Electron | Provenance lives in **four** fields (`directoryHandleKey`, `fileHandleKey`, `originalPath`, `contentHash`) across **three** unsynchronised registries (panel `_mounts`, `DirMounts._dirRefs`, IndexedDB), the "Linked/Snapshot" badge is derived from key *presence* not from what actually loaded, and the desktop build persists no asset path at all so it is *less* live than the web build | One `source` descriptor per asset, resolved by **one** adapter method, with a status the user can read in plain words (*Embedded copy / Linked / Changed on disk / Missing*), and a desktop ref registry that survives restart |
| Grouping / ungrouping / multi-part imports are messy | Four overlapping notions of "group" (Collection, GroupNode, logical object, legacy `sourceGroupId`); groups are **never selectable** and the gizmo **never moves a group node**; a viewport click inside a multi-object import grabs one piece | Two user concepts only — **Object** (one printable solid, may have hidden material parts) and **Group** (a rigid container you can enter) — with Figma/Keynote click-depth and a real group transform |
| Viewport panel and overall UI structure confuse beginners | 41-item context menu, 8 repair entry points, print-critical verbs hidden in a drawer called "3D Cursor", jargon ("Snapshot", "Source Unit", "logical object", "Transform Swab"), shortcuts dead unless the canvas has focus, no onboarding, no header Import/Export/Undo | Keep the four workspaces; tier the context menu; rename the drawer to **Arrange**; one terminology table; header Import/Export/Undo; readiness strip on every Print tab; a 4-step first-run coach |

Phases 0–5 below are each independently shippable and keep the web build green at every step; `.mixo` migration is a single additive schema bump (3.3 → 3.4) with a no-regret fallback (embedded bytes always load).

---

## 1. Current-state diagnosis

All citations are against master at 4da6236. Line numbers were verified by reading the files (three parallel code audits + direct reads); the owner memory notes were treated as *claims* and checked, and several were found stale (noted inline).

### 1.1 Asset storage, provenance and resolution

**What exists.**

- `AssetEntry` carries provenance in four fields written at import: `directoryHandleKey` + `originalPath` for folder loads (`src/core/assets/AssetImport.js:259-267`, `:394-402`), `fileHandleKey` for loose OS drops when `opts.fileHandle && !opts.directoryHandleKey` (`AssetImport.js:349-357`, idb key `fh_<assetId>`), `contentHash` (sha256, duplicated as `sourceFileHash`, `AssetImport.js:187,267`). `directoryHandleKey` values are minted as `dir_<name>_<Date.now()>` (`src/core/assets/DirMounts.js:18`) — a fresh key per mount, so re-mounting the same folder never matches older assets (`src/ui/AssetPanel.js:664-671`).
- Resolution on load is `resolveAssetBlob` (`src/core/persist/AssetResolver.js:45-97`): dir-handle path hit → dir hash scan (cap 4000 files, each candidate fully read and hashed, `:18-35`) → single file handle → embedded `fileData` (hash-checked, `:86-92`) → null/ghost. The path hit is **not** hash-verified (`:51-52`), so an edited file on disk silently replaces what the user saved.
- Status (`live`/`static`/`ghost`/`imported`) lives only in a local map in `ProjectLoader.js:236-312` and is never persisted; `isUnlinked` on the object is set for *any* static result (`ProjectLoader.js:330,388`), including baked `.mxvd` results and legacy docs that never had a link.
- The "Linked / Snapshot" badge is `!!(directoryHandleKey || fileHandleKey)` (`AssetPanel.js:490-495`) — it reflects key presence, not what loaded. An asset that fell back to its embedded copy still says "Linked".
- Relink (`ProjectLoader.js:491-532`) clears `isGhost` only: it does not write a new handle key, `originalPath` or `contentHash`, passes no `libraryItem`/OBJ siblings (`:501`), and does not dispose the old container. The next save embeds the new bytes under the **old** hash (`ProjectSerializer.js:146`), so the M5 hash check (`AssetResolver.js:86-92`) can later reject correct bytes and ghost the asset.
- `migrate()` is a no-op `return doc` (`ProjectLoader.js:121-126`); legacy handling is inline (`:189-196`, `:225`, `:261-264`). The memory note "migrates old saves" refers to those inline branches.
- Autosave writes `buildDocument({skipEmbed:true})` every 60 s (`src/core/persist/Autosave.js:18-43`) but `textureImages` is still base64-encoded every tick (`ProjectSerializer.js:167-179,269`); `recoverAutosave` has **no UI caller** (`main.ts:118-120` only starts the timer and calls `promptRemount`; the `recoverAutosave` modal is registered at `ProjectMenu.js:201` and never opened). Autosaves accumulate under `autosave_<projectName>` and are never offered back.
- `StorageAdapter` (`src/core/storage/StorageAdapter.js:45-75`) implements only KV + `mountDirectory`/`listDirectory`/`readFile`; the typedef declares ~12 more methods (`:33-36`) that neither adapter has. Direct File System Access calls remain at `PersistenceManager.js:88,124`, `ProjectLoader.js:494`, `ViewportDrop.js:62,129-130`, `print/Download.js:9,14`; direct idb use at `AssetPanel.js:5`, `AssetImport.js:10`, `DirMounts.js:5`, `PersistenceManager.js:17`, `AssetResolver.js:4`, `RecentProjects.js:4`, `ProjectLoader.js:16`.
- Of the five capability flags, only `mountDirectory` (`AssetPanel.js:117`) and `triangleBudget` are read anywhere; `persistAssets`, `relinkByPath`, `writeFiles`, `watchFiles` are never consulted. The one real gate is shadowed by the hard boot block at `src/app/main.ts:41` (`showDirectoryPicker` required even under Electron).

**Desktop (Electron) specifically.**

- Mounted-asset refs are random **in-memory** tokens (`electron/OpaqueFileRegistry.cjs:15-19`); `DirMounts.js:20,30` skip idb persistence for non-browser; `promptRemount` returns early on desktop (`AssetPanel.js:208`). After a restart every folder-sourced asset falls to the embedded copy and the "unmatched" modal fires on every reopen. `preload.cjs:12-18` nevertheless declares `watchFiles`/`relinkByPath`/`persistAssets: true`; there is no watcher in `main.cjs`.
- `pickOpen`/`pickSave` IPC exist (`electron/preload.cjs:32-33`, `main.cjs:104-105`) but nothing in `src/` calls them; project open/save and relink go through `window.showOpenFilePicker`/`showSaveFilePicker` even on desktop.
- `listDirectory` registers a fresh token per entry on every call (`OpaqueFileRegistry.cjs:43`) and `DirMounts` calls it on every handle lookup (`DirMounts.js:50-67`): the registry grows without bound.
- Recents live in the desktop KV file but their file handles go to IndexedDB (`RecentProjects.js:24,30`): split brain.

**Pain points, in user terms.**

1. "Linked" can be false; "Snapshot" is a storage word the user cannot act on; there is no card-level Relink (relink only exists in load modals and on ghost/unlinked rows, `ContextMenu.js:195,208`).
2. Loose drop vs folder drop behave differently (hash rescan only for folders; OBJ `.mtl`/texture siblings never embedded and only recoverable with a `directoryHandleKey`, `ProjectLoader.js:281`) and the user is never told which one they did.
3. Four names for one idea in code: `mountKey` / `directoryHandleKey` / `key` / `handleKey` / `ref` / `handle`; `getFileHandle` means three different things; the resolver fetches a *directory* via `getFileHandle` (`AssetResolver.js:48`).
4. Desktop promise ("real fs, live relink") is not delivered — today desktop is strictly worse than web for liveness.
5. Boot prompts: the only startup dialog is "Re-mount folder?" (single `last_mount_dir`, multi-mount sessions lose all but the last, `AssetPanel.js:157,198`); crash recovery is silent and unreachable.

### 1.2 Hierarchy, grouping, selection, gizmo

**What exists — four overlapping "group" concepts.**

| Concept | Minted | User sees | Movable as a unit? |
|---|---|---|---|
| **Collection** (import bucket) | every import/instantiate: `createCollectionFromFilename` (`AssetRegistration.js:201-226`, called `AssetImport.js:272,337`) | Package-icon row with count (`Outliner.js:241-268`), hidden when the file yielded one object (`:147-154`) | Only indirectly: clicking the row multi-selects members (`Outliner.js:734-739`) |
| **GroupNode** (`scene.groups` + Babylon `TransformNode`) | import wrappers with ≥2 structural children (`src/core/import/ImportHierarchy.js:85-116,124-141`), `CreateGroupCommand` (`ParentCommands.js:168-271`), `SplitToPartsCommand` (`:454`) | GitBranch row with `Mixed`/`Empty` badges (`Outliner.js:270-298`); eye/lock buttons render but are dead (`:285-286`) | **No.** Groups are never in `selectedIds` (`Selection.js:58-81`; `InputManager.js:762` "groups aren't currently selectable"). Clicking the row expands to leaf meshes (`Outliner.js:717-732`); the gizmo re-parents leaves to a temp pivot and the group's own node is never moved (`PivotSession.js:175-204,230-238`) |
| **Logical object** (lead + `isInternalPart` parts) | `registerInstantiatedMeshes` keys `sg:<sourceGroupId>` or `pp:<originNode>:<stem>` (`AssetRegistration.js:124-146`); `JoinCommand` (`ParentCommands.js:479-530`) | One row named after the lead (`_logicalDisplayName`, `:53-62`); parts only behind the "Show internal parts" toggle as read-only rows (`Outliner.js:306-325`) | **Yes** — `Selection._resolve` expands to parts (`Selection.js:19-35`) |
| **`sourceGroupId`** (legacy twin of the above) | MultiMaterial split only (`MeshSplit.js:66,121-126`) | nothing | — ; still consumed alone by `canonicalObjectId` fallback (`LogicalObjects.js:29,47`), `MeshValidator._collectGroupSiblings` (`:140-151`) and `validateAllPrintParts` dedupe (`:513-518`) |

**What a multi-object import produces today** (verified by reading `ImportHierarchy.js` + `AssetRegistration.js`):

- glTF multi-primitive mesh → 1 object with N hidden parts; click any part → whole object moves. Good.
- MultiMaterial OBJ/3MF → same via `__partN` split. Good.
- glTF with body + head as **two meshes under one node** (the common character/kitbash case) → 1 import Group + 2 Objects. Viewport click on the head selects **only the head** (`InputManager.js:190-220` → `pickMeshIdAt` → `Selection.set([id])`); nothing in the viewport can select the group; the user must find the group row in the Outliner or box-select. **This is complaint #2.**

**Other verified defects.**

- `CreateGroupCommand` always lands the new group at root (`ParentCommands.js:241`), flattening existing nesting, and names it `'Group'` without uniquifying (`:169,172`); `SplitToPartsCommand` names the new group exactly like the lead (`:454`) and numbers parts `.2/.3` (`:439`) against the codebase's `.NNN` convention — both violate the "name maps to at most one node" invariant (`AssetRegistration.js:19-23`, `HierarchyCommands.js:107-123`).
- Ungroup dissolves the *whole parent* of whatever is selected (`InputManager.js:766-777`, `ContextMenu.js:550-560`), including import groups, with no confirmation.
- `JoinCommand` leaves absorbed parts under their old `parentId` (`ParentCommands.js:499-512`), so a hidden part can live in a different group from its lead.
- `DuplicateCommand.undo` does not remove clone ids from `groups[].childIds` (`HierarchyCommands.js:294-302`); stale ids persist to disk (`ProjectLoader.js:111-114` skips them on load).
- Lock is cosmetic for transforms: no check in `Selection`, `PivotSession` or `InputManager`; only `PlacementCommands.js:47-48` honours it.
- Viewport Shift = toggle (`InputManager.js:201`) but Outliner Shift = add, Ctrl = toggle (`Outliner.js:707-709`).
- Pivot position uses node `getAbsolutePosition()` (`PivotSession.js:142,149`); after `bakeImportTransform` an imported node with zero translation puts the gizmo at the node origin, not the geometry centre (inferred from `ImportNormalizer.js:200-207`; verify live).
- `validateAllPrintParts` dedupes by `sourceGroupId` (`MeshValidator.js:515-518`) so glTF multi-primitive, joined and split objects are validated N× against the same union; readiness concatenates cached results across parts (`PrintPipeline.js:368-387`).
- `collectPrintUnits` decides inclusion by the **lead's** `isPrintPart` but filters parts by their own flag (`ExportContext.js:177,181`): lead-off/part-on silently drops the object.
- Delete-collection and context-menu rename-collection write state directly (`ContextMenu.js:587-619`), not through commands.
- No double-click handler exists in the viewport (only Outliner/AssetPanel register `dblclick`).

### 1.3 UI shell / UX structure (beginner lens)

**What exists** (`index.html:39-118`; `Workspace.js:34-39`; `layout.css:378-409`): header (logo, project name, dirty dot, locale, 4-workspace pill, icon-only New/Open/Save/SaveAs/Recent/Reset-all), pinned Outliner, viewport (NavCube, display toggles, bottom transform toolbar, empty-state card, Shift+N "3D Cursor" drawer, slice tool), right column with Properties/Shader Library/Scene/Print sections, bottom Asset panel (Layout only), 3-segment status bar, 14 modal ids, a ~41-item object context menu (`ContextMenu.js:156-253`), ~45 shortcuts.

**Pain points (verified).**

1. **Context menu** of up to 41 items / 14 separators, beginner verbs mixed with Boolean/Array/Mate/Transform Swab; "Unparent" appears twice (`ContextMenu.js:162,227`); greyed not hidden.
2. **Print-critical placement verbs** (Drop to Bed, Center on Bed, Align, Mirror, Array, Mate) live in a drawer named "3D Cursor" (`CursorPanel.js:96-98`), closed by default, opened by `Shift+N`.
3. **Eight repair entry points** with five labels: "Repair geometry", "Repair all", "Auto-Fix", "Fix", "Auto-fix and export" (`ContextMenu`, `Outliner.js:555`, `MeshStats.js:140`, `PrintPanel.js:416-448,968`, toasts, `repairOnImport`, export prep).
4. **Jargon** shown to the user with no explanation: Snapshot/Linked, Source Unit / Authored Scale / Confirm, Ratio (two meanings), UV Override / Rot (rad), Shader / PBR / Unlit, Make Unique, Median/Active pivot, Transform Swab, Smart Replace, Mate to Active, logical object / internal part, watertight / non-manifold, Mimaki, HDRI / ACES / SSAO, "CSG2 unavailable".
5. **Terminology drift**: Print Part / Print Export / Include in print export; Repair / Auto-Fix / Fix; Library (assets) vs Shader Library; Scene (workspace) vs Scene Shaders; Bed / Build Volume / Build Volume Preset; Object / Mesh / Part / Collection / Group / Import collection.
6. **Silent workspace jumps**: `ShaderPanel.focus()` forces Shade (`ShaderPanel.js:788-796`), readiness issues force Layout/Print (`PrintPanel.js:90-99,787`).
7. **Shortcuts dead outside the canvas**: viewport context only on canvas focus (`InputManager.js:95`); after an Outliner click G/R/S/F/H/Delete do nothing while the status bar still advertises them; `Tab` dispatches `UI_PANEL_CHANGED` with no listener (`InputManager.js:797-800`); the status hint string contradicts the code (`en.json status.defaultHint` vs `InputManager.js:673-675`).
8. **No header Import / Export / Undo / Redo**; Undo/Redo appear only as status-bar text (`StatusBar.js:274-291`); the header **Reset-all** icon wipes render/grid/print/cost settings with no confirm (`ProjectMenu.js:33,48-51`).
9. **Readiness only on the Export tab** (`PrintPanel.js:547,585`); Scale/Validation/Bed never show it.
10. **Properties hidden entirely** in Scene and Print workspaces (`layout.css:384-391`) — you cannot rename, hide or flag an object while printing.
11. **Default printer is Mimaki 3DUJ-553** 508×508×305 (`default-settings.json:30-32`); a hobbyist FDM/resin user starts with a bed that never overflows and a cost card priced for a service bureau.
12. **No onboarding** of any kind (no help button, tour, first-run flag; grep found none). Empty states are four different sentences in four panels.
13. **Blocking progress overlay** swallows Esc and has no cancel (`ProgressOverlay.js:244-251`).
14. Modal replaces modal silently (`Modal.js:86`); concurrent import failures overwrite each other (CIA review MEDIUM, still open).
15. Icon-only header/outliner/toolbar buttons; some hard-coded English (`AppShell.js:146-193`, `InputManager.js:673-695`).

---

## 2. Target design

### 2.1 The user's mental model (plain words)

> **A project is a self-contained file.** Everything you import is copied into it, so it always opens — anywhere.
> If a model came from a file on your computer, MIXOMESH also remembers **where** (its *Source*), so you can **Refresh** it when the original changes, or **Find** it if it moved. Nothing depends on the original staying put.
>
> **Objects** are the things you print. An object is one solid; if it came with several materials, those are *parts of the object* and stay together.
> **Groups** hold objects (and other groups) so they move, rotate and scale as one. Click a group to grab the whole thing; **double-click to go inside** and pick a single object; press **Esc** to step back out.
> A file that contains several objects arrives as a group named after the file.

Two nouns for hierarchy (Object, Group), one noun for provenance (Source). "Collection", "logical object", "internal part", "Linked", "Snapshot" disappear from the UI.

### 2.2 Asset model

**One descriptor, one resolver, one status.**

```js
// AssetEntry (schema 3.4) — replaces directoryHandleKey + fileHandleKey + originalPath
source: null | {
  kind: 'folder' | 'file',   // folder = mounted directory (path is relative to it); file = single picked/dropped file
  refKey: string,            // opaque: browser = idb handle key; desktop = main-process registry token
  path: string,              // folder-relative path, or '' for kind:'file'
  label: string,             // display only, e.g. "tanks/hull.glb" or "hull.glb (Downloads)"
}
contentHash: string          // sha256 of the bytes the project currently uses (updated on Refresh/Relink)
// fileData: embedded base64 — ALWAYS written on manual save (unchanged rule)
```

```js
// StorageAdapter additions (both impls)
resolveAsset({ source, contentHash, fileData }) → { bytes, origin: 'live'|'embedded', drift: boolean, reason?: string }
//   live tier only if source resolves AND (hash matches OR caller opts in to drift) — never silently swaps bytes
persistRef(key, nativeRef) / restoreRef(key) / deleteRef(key)   // browser: idb handle store; desktop: main-process {token → absPath} in mixo-kv.json ('refs' namespace)
findMoved(source, contentHash, { limit }) → source|null       // the hash scan, now EXPLICIT (button), not automatic
pickOpenProject / pickSaveProject / pickImportAssets / saveExport  // route the 6 remaining direct FSA calls; desktop uses dialog:open/save IPC
```

**Resolution on load** (replaces the 5-tier ladder): `source` → bytes; compare hash → if equal `origin:'live'`; if different `origin:'embedded', drift:true` (use the saved copy, show *Changed on disk — Refresh?*); if source unreachable → `origin:'embedded'` (show *Missing source — Find…*); if no `fileData` either → ghost (*Missing*). The automatic directory hash scan is gone from load (it reads and hashes up to 4000 files on every open); it becomes **Find moved file…** on demand. **(Decision 3)**

**Per-object status**, derived at load and stored in `state.scene.assetLibrary[id].status` (session, not persisted): `embedded` (no source — the default for web drops; shown as *Embedded copy*), `live`, `drift`, `missing`, `ghost`. Shown in **Properties ▸ Object ▸ Source** and as a small chip on the asset card **only when not `embedded`/`live`**. "Linked/Snapshot" badges are removed.

**Relink / Refresh / Find** become one command `RelinkAssetCommand(assetId, {source?, bytes})` that updates `source`, `contentHash`, re-restores the container (with `libraryItem` + OBJ siblings), disposes the old one, and is undoable.

**Desktop parity.** `DesktopStorageAdapter.persistRef` stores `{token → absolutePath}` in the main-process KV (never in the renderer); tokens survive restart; `mountDirectory` returns the same token for the same absolute path (stable `refKey`, fixing the fresh-key-per-mount defect for desktop; browser keys become `dir_<sha256(name+firstEntry)>` — still opaque, stable across re-mounts of the same folder). `watchFiles` stays declared-false until a watcher exists (**no lying caps**). `main.ts:41` boot gate becomes `caps.mountDirectory || isDesktop()`.

**Asset panel** tabs rename: *Session* → **Project** ("Models in this project"), *Library* → **Folders** ("Folders on this computer"). Cards get a context menu: *Add to scene*, *Reveal source*, *Refresh from source*, *Find moved file…*, *Remove*. Boot: one non-blocking banner (not a modal) — "Re-mount *Folder X*?" and, when an autosave is newer than the last save, "Recover unsaved changes from 12:04?" **(Decision 4)**.

**Autosave**: keep 60 s, embed nothing that has a resolvable `source` *or* `textureImages` hash already present (stop re-encoding textures), key by project **id** (new `project.id` uuid in 3.4) not name.

**Blender sidecar seam (not planned in depth):** add `caps.externalTools: string[]` (empty on web) and a `src/core/tools/ToolAdapter.js` typedef `{ run(toolId, { inputBytes, args }) → { outputBytes, log } }`. Desktop implements it later via IPC; nothing else references it now.

### 2.3 Hierarchy / grouping model

| Concept | State | Babylon | Selectable | Gizmo | Validation / export / cost unit |
|---|---|---|---|---|---|
| **Object** | `scene.objects[id]` lead (+ hidden parts via `logicalObjectId`) | N meshes | yes (lead id) | all parts under the temp pivot (unchanged) | **yes — the unit** (unchanged: `collectPrintUnits`, `GroupRepair`, `PrintCost`) |
| **Group** | `scene.groups[id]` (+ `transform` already serialised) | `TransformNode` | **yes (new)** — group id may appear in `selection.selectedIds` | the **group node itself** is parented to the temp pivot → rigid move/rotate/scale, one undo entry per node | no — transparent; export/validation/cost iterate objects, 3MF keeps `<components>` as today |
| ~~Collection~~ | `scene.collections` kept in schema for provenance (`sourceFile`) | — | — | — | — ; **no longer an Outliner tree level** (Decision 2) |
| ~~`sourceGroupId`~~ | kept in schema, read only by `_migrate` to seed `logicalObjectId` | — | — | — | removed from all runtime reads |

**Import rule (replaces `ImportHierarchy` "≥2 structural children" collapse):** a file that yields **one** object arrives as that object (no wrapper, as today). A file that yields **two or more** objects (after multi-primitive/multi-material folding) arrives as **one Group named after the file stem** containing the authored hierarchy (nested wrapper nodes with ≥2 children survive as sub-groups, single-child wrappers still collapse). Group transform origin = bottom-centre of the combined AABB (so rotate/scale make sense on a kitbash; fixes pain point "pivot at node origin").

**Selection and click-depth (Figma / Keynote rule).** `state.selection` gains `scopeId: string|null` (session-only, never persisted): the group the user has *entered*.

- **Click** on geometry → select the **topmost ancestor below the scope** (at root scope: the whole import group). If the hit is already inside the current selection, promote it to active (unchanged).
- **Double-click** on geometry → enter the clicked thing's parent group (scope = that group) and select the clicked child. Repeat to go deeper.
- **Esc** (no modal, no box select) → step scope out one level, selection becomes the group just left. Click empty space → clear selection; scope stays (second click on empty → scope root).
- **Outliner click** selects exactly the row clicked (object *or* group) and sets scope to that row's parent, so subsequent viewport clicks stay at that depth. Shift = add, Ctrl = toggle in **both** surfaces (viewport changes to match Outliner; Blender uses Shift-toggle but Figma/Tinkercad/SketchUp/Shapr3D all use Shift-add — beginner-friendlier).
- **Breadcrumb** in the viewport's top-left under the NavCube: `Scene › tank.glb › turret` while scope ≠ root; clicking a crumb sets scope and selects it. Outliner highlights group rows when a group is selected (today it never does, `Outliner.js:781-788`).
- **Box select** at scope: selects topmost-below-scope nodes whose combined AABB centre is in the marquee (today it tests each *part's* centre, `BoxSelect.js:54-67`).

**Commands (semantics locked).**

| Verb (UI label) | Command | Behaviour |
|---|---|---|
| **Group** (Ctrl+G) | `GroupCommand` | new group's `parentId` = common ancestor of the selection (not root); name uniquified `Group.001`; origin = bottom-centre AABB; members keep world transforms |
| **Ungroup** (Ctrl+Shift+G) | `UngroupCommand` | acts on the **selected group(s)** only (requires group selection; with objects selected it is disabled and the hint says "select a group") |
| **Separate by material** (was "Split to parts") | `SplitToPartsCommand` | unchanged logic; new group name uniquified; parts named `<lead>.001…`; result stays in the lead's parent |
| **Merge into one object** (was "Join into one object") | `JoinCommand` | also reparents absorbed parts to the lead's `parentId` |
| **Delete** | `DeleteCommand` | accepts group ids: deletes the subtree, prunes membership (existing `planHierarchyRemoval`) |
| **Duplicate** | `DuplicateCommand` | accepts group ids: deep copy of subtree; undo removes clone ids from `childIds` (fix) |
| **Lock** | — | enforced: locked nodes are selectable but excluded from pivot attach, G/R/S, body-drag, Delete; Properties transform fields disabled; lock on a group locks the subtree |
| Reparent (drag in Outliner) | `ReparentCommand` | unchanged; group-onto-group allowed via `validateParentChange` |

Collections: rows removed from the tree; `sourceFile` becomes a hover tooltip on import groups/objects ("From tank.glb") and a **filter chip** in the Outliner search ("file: tank.glb"). `RenameCollectionCommand` / delete-collection menu items removed (nothing to rename).

### 2.4 UI shell / UX structure

Keep: four workspaces, no repeated specialist sections, Blender control language, washi palette, Library = single shader edit surface, per-object ratio, printer-agnostic export.

**Header (left→right):** logo · project name · dirty dot · **Import** (primary button, Ctrl+I) · New/Open/Save/Save As/Recent (icon group) · **Undo / Redo** (icon pair, labels on hover from HistoryManager) · workspace pill · **Export** (jumps to Print ▸ Export, or opens the format chooser if already there) · locale · **?** (shortcut sheet + "Show tour again") · Reset-all moves under **?** with a confirm.

**Workspaces (unchanged set):** Layout / Shade / Scene / Print. One change: the **Properties ▸ Object** section (name, visible, lock, print toggle, Source) is visible in **all four** workspaces (the same section, not a repeat — the rule bans repeated *specialist* sections) **(Decision 6)**. Silent workspace jumps get a 2 s toast: "Switched to Shade — Ctrl+Shift+1 to go back".

**Viewport:** NavCube; display toggles; bottom toolbar unchanged; **breadcrumb** (new, §2.3); the Shift+N drawer renamed **Arrange** (Drop to bed · Center on bed · Place face on bed · Align · Mirror · Array · Mate) and given a toolbar button; "3D Cursor" becomes a sub-section inside Arrange.

**Context menu — tiered.** Primary (always visible, ≤12): Focus · Hide · Lock · Rename · Duplicate · Group · Ungroup · Enter group / Exit group · Separate by material / Merge into one object · Repair · Export selected… · Delete. Submenus: **Arrange ▸** (Drop to bed, Center on bed, Place face on bed, Align ▸, Mirror ▸, Array ▸, Mate) · **Combine ▸** (Union, Subtract, Intersect, Slice & Connector…) · **Select ▸** (Parent group, Siblings, Same file, Reveal in Outliner) · **Cursor ▸** (three cursor items). Items impossible for the selection are **hidden** inside submenus and **greyed** in the primary tier (so the primary tier keeps a stable shape). Transform Swab and Smart Replace move to **Combine ▸** with tooltips ("Give the selected objects the active object's position/rotation/scale" / "Replace the selected objects' geometry with the active object's").

**Print panel:** a one-line **readiness strip** above the tabs on every tab (✓ Ready / ▲ Review / ✖ Fix — click → Export tab). The Scale tab's default state collapses to "Print at the size shown" with an *Advanced: other sizes* disclosure. Cost card hides file-path plumbing behind a ⚙ popover.

**Terminology table (single source of truth, applied via `en.json`; ja/zh-Hant follow):**

| Today | Target | Where |
|---|---|---|
| Session / Library (assets) | **Project / Folders** | AssetPanel tabs |
| Linked / Snapshot | *(removed)*; **Source: Embedded copy · Linked · Changed on disk · Missing** | Properties ▸ Object, asset card chip |
| Print Part / Print Export / Include in print export / 列印匯出 | **Print** toggle; "Include when printing" | Properties, Outliner tooltip, Validation summary ("N objects to print") |
| Repair geometry / Repair all / Auto-Fix / Fix / Auto-fix and export | **Repair** everywhere; "Repair all (N)"; "Repair & export" | all 8 sites |
| Source Unit / Authored Scale / Confirm | **File units** (dropdown) · "Imported as 1:72" · **Looks right** | Properties |
| Ratio (object) / Print Scale / target ratio | **Scale ratio** (object) · **Print at** (Print ▸ Scale) | Properties, Print |
| Shader / Shader Library | **Material / Materials** | everywhere (Decision 7) |
| Split to parts / Join into one object | **Separate by material / Merge into one object** | context menu |
| Internal part / Show internal parts | **Material parts / Show material parts** | Outliner |
| 3D Cursor (drawer) | **Arrange** | drawer, toolbar |
| Mate to Active / Transform Swab / Smart Replace | **Snap to active · Copy placement from active · Replace with active** | Combine ▸ |
| Build Volume Preset / Bed | **Printer** (select) · **Build volume** | Print ▸ Bed (tab renamed **Printer**) |
| Transform group / Import collection (display only) / Mesh object | **Group / Object** | Outliner tooltips |

**Onboarding:** first run (no `mx-onboard-v1`) shows a 4-step coach overlay anchored to real controls — *1 Import a model → 2 Arrange (click / double-click / Esc) → 3 Colour (Shade) → 4 Print (readiness → Export)* — skippable, replayable from **?**. Empty states unify to one sentence + the Import button.

**Status bar:** left hint corrected and context-aware ("Double-click to enter *tank.glb* · Esc to exit"); centre unchanged; right: Undo/Redo become **buttons** (they already have labels).

**Shortcuts:** viewport context is active whenever focus is on `body`, the canvas, or the Outliner (not inside inputs); `Tab` unbound; `Ctrl+I` import; `Esc` scope-out.

### 2.5 ASCII mockups

Outliner after importing `tank.glb` (hull + turret + 2 wheels) and a single `base.stl`:

```
Scene objects                               [⌕ filter…] [≡parts]
 ▾ ⧉ tank.glb                 👁 🔒 🖨        ← Group (from file), selected on first click
    ▸ ▣ hull        (2 mats)  👁 🔒 🖨        ← Object with 2 material parts (hidden)
      ▣ turret                👁 🔒 🖨
    ▾ ⧉ wheels                👁 🔒 🖨        ← sub-group (authored node with 2 children)
         ▣ wheel.L            👁 🔒 🖨
         ▣ wheel.R            👁 🔒 🖨
   ▣ base                     👁 🔒 🖨        ← single-object file: no wrapper
```

Viewport breadcrumb while inside the group:

```
┌─────────────────────────────────────────────┐
│ [NavCube]                                   │
│ Scene › tank.glb › wheels        [Esc exits]│
│                                             │
│            (wheel.L highlighted)            │
│                                             │
│        [Move][Rot][Scale] | [Arrange ▾]     │
└─────────────────────────────────────────────┘
```

Properties ▸ Object (all workspaces):

```
Object                                   ↧
 Name      [ hull                     ]
 Visible   (●) Print (●) Locked ( )
 Source    Linked · tanks/tank.glb        [Refresh] [Find…]
 File units [Millimetres ▾]  Imported as 1:1   [Looks right]
```

Print panel header strip (every tab):

```
▲ Review before export — 1 object not watertight · 1 outside build volume   [Go to Export →]
[ Scale | Validation | Printer | Export ]
```

---

## 3. Borrowed patterns

| Pattern | Source app | How applied here | Why it fits hobbyist printers |
|---|---|---|---|
| Click selects the whole group; double-click enters; Esc exits; breadcrumb shows depth | **Figma** (frames/groups), **Keynote/PowerPoint** (grouped shapes) | §2.3 scope rule, viewport breadcrumb, Outliner sets scope | Zero-vocabulary: everyone has clicked into a grouped slide shape |
| A file with several parts arrives as one movable thing | **Tinkercad** (imports arrive as one shape), **Bambu Studio** (multi-part object = one row with parts) | import wrapper → Group named after file | Matches "I downloaded a tank, I want to move the tank" |
| Object = print unit with hidden sub-parts; "Split to parts / Merge" explicit | **PrusaSlicer / Bambu Studio** object list | keep logical object, rename verbs | Slicer users already know "object → parts" |
| Group transform is a real node (rigid rotate/scale) | **SketchUp** components, **Blender** empties | group `TransformNode` goes under the pivot | Kitbash rotation must not shear child placement |
| Outliner Shift=range/add, Ctrl=toggle, same in canvas | **Figma, SketchUp, Shapr3D, Tinkercad** | unify viewport with Outliner | Blender's Shift-toggle is the odd one out |
| Lock prevents transform but not selection | **Figma, Keynote** | lock enforcement §2.3 | What "lock" means to non-CG users |
| Self-contained file + "Relink / Find moved" on demand | **Figma** (embedded images), **Keynote**, **Fusion 360** (insert vs link) | embed-always stays; explicit Find; Source status in words | Users understand "copy" vs "link" when told in those words |
| Tiered context menu with "More ▸" submenus | **Spline, Womp, Shapr3D** | §2.4 | Beginners stop reading after ~10 items |
| Persistent readiness strip | **Bambu Studio** (slice status bar), **Fusion 360** (manufacture setup warnings) | Print panel strip on every tab | The user's question is always "can I print this yet?" |
| Arrange panel with named verbs (Drop, Center, Align, Mirror, Array) | **Tinkercad** (Align/Mirror/Duplicate), **Bambu** (Arrange/Lay on face) | rename drawer; expose on toolbar | Print prep is mostly placement |
| First-run coach marks anchored to real controls | **Spline, Womp, Nomad Sculpt** | 4-step tour | One-time, skippable, replayable |
| Header Import / Export / Undo / Redo | **Tinkercad, Bambu, Fusion** | header redesign | The three verbs every session uses |
| Workspaces = fixed task layouts, not docking | **Blender 2.8+** (kept) | unchanged | Already locked, works |

---

## 4. Decisions for owner

1. **Groups become first-class selectable nodes with Figma/Keynote click-depth** (overturns the 2026-08-03 spec rule "viewport picking selects an Object only"). *Recommend: accept — it is the direct answer to complaint #2.*
2. **Collections leave the Outliner tree** (become a "From file" tooltip + filter chip; schema field stays). *Recommend: accept — with import groups named after the file, the collection row is a duplicate level.*
3. **Automatic directory hash-scan on load is removed**; "Find moved file…" is an explicit button. (Memory note `hybrid_asset_persistence` says "do not reorder" the tiers; this is a replacement, not a reorder.) *Recommend: accept — the scan reads up to 4000 files on every open and hides drift.*
4. **Boot prompts become one non-blocking banner** (re-mount + optional autosave recovery), replacing the `remountFolder` modal and making recovery reachable. Overturns the Phase-6 "never recover session" rule only to the extent of *offering* it. *Recommend: accept.*
5. **Viewport Shift-click becomes "add" and Ctrl-click "toggle"** (matches Outliner; departs from Blender). *Recommend: accept.*
6. **Properties ▸ Object visible in all four workspaces** (same section; specialist sections still never repeat). *Recommend: accept.*
7. **Rename "Shader" → "Material"** app-wide (i18n keys unchanged, strings only). *Recommend: accept; it is a string-only change but touches ~60 strings × 3 locales.*
8. **Default printer** stays Mimaki 3DUJ-553 or becomes a generic "Hobby FDM 220×220×250" with the Mimaki preset one click away. *Recommend: generic hobby default; Mimaki remains the stand-in example in docs.*
9. **Lock semantics**: transform-lock only (still selectable/deletable with a confirm) vs full freeze. *Recommend: transform-lock, Figma style.*
10. **Browser mount keys become stable per folder** (`dir_<hash(name+firstEntry)>`) so re-mounting matches older assets; desktop tokens persist in the main-process KV. *Recommend: accept.*
11. **Context-menu impossible items**: hidden inside submenus, greyed in the primary tier. *Recommend: accept.*
12. **Scope depth memory across sessions**: `scopeId` session-only (recommended) vs persisted in `.mixo`. *Recommend: session-only.*

---

## 5. Implementation plan

Conventions: every task lists **Files · Behaviour · Accept · Deps · Tier**. "Smoke" = add an assert to `tests/browser-smoke.mjs` (CDP). "Eyeball" = a live Chrome check the owner does once. Keep the web build green after every task; Electron tasks are additive and must not enter the Vite graph.

### Phase 0 — Quick wins and terminology (1–2 days, all haiku/sonnet, no architecture)

**0.1 Terminology pass (strings only).** Files: `src/i18n/locales/{en,ja,zh-Hant}.json`, `src/ui/*.js` only where a string is hard-coded (`AppShell.js:146-193`, `InputManager.js:673-695`, `CopyPaste.js` ASPECTS). Behaviour: apply the §2.4 table except "Shader→Material" (Decision 7, own task 0.2). Fix `status.defaultHint` to match `InputManager._defaultHint`. Accept: `npm run i18n:check` 0 gaps; `tests/i18n.test.mjs` green; grep finds no "Snapshot", "Print Part", "Auto-Fix", "Transform Swab" in `en.json`. Deps: none. Tier: haiku.

**0.2 Shader → Material strings.** Files: three locale JSONs. Behaviour: string values only; keys untouched. Accept: i18n check; smoke pins that look for "Shader Library" text updated. Deps: Decision 7. Tier: haiku.

**0.3 Dedupe context-menu "Unparent"; hide Tab binding; fix Shift/Ctrl in viewport.** Files: `src/ui/ContextMenu.js:162,227`, `src/core/InputManager.js:201-205,797-800`. Behaviour: one Unparent; remove `Tab`; viewport Shift = add (`Selection.add`), Ctrl = toggle. Accept: `tests/box-select.test.mjs` unchanged; new headless test in `tests/safety-commands.test.mjs` that `InputManager.__test.onSelectionPointerDown({shiftKey})` adds rather than toggles (export a test seam if missing). Deps: Decision 5. Tier: sonnet.

**0.4 Viewport shortcut context follows Outliner/body focus.** Files: `src/core/InputManager.js:95`, `src/ui/Outliner.js` (focus handler). Behaviour: `_context='viewport'` when `document.activeElement` is `body`, the canvas, or inside `#outliner` and not an input/textarea/select. Accept: smoke: click an outliner row, send `Delete` via CDP, object removed. Deps: none. Tier: sonnet.

**0.5 Reset-all confirm + Undo/Redo buttons.** Files: `src/ui/ProjectMenu.js:33,48-51`, `src/ui/StatusBar.js:274-291`. Behaviour: reset-all opens `Modal` confirm; status-bar Undo/Redo become buttons calling `HistoryManager.undo/redo`. Accept: smoke: click Undo button after a duplicate → object count back. Tier: haiku.

**0.6 Readiness strip on every Print tab.** Files: `src/ui/PrintPanel.js` (render header above tabs at `:107-130`, reuse `PrintReadiness` projection), `src/styles/components/print.css`. Behaviour: one line, three states, click → Export tab. Accept: smoke asserts strip text contains "Ready" after importing the closed fixture. Tier: sonnet.

**0.7 Arrange rename + toolbar button.** Files: `src/ui/CursorPanel.js`, `src/ui/ViewportToolbar.js`, locales. Behaviour: drawer title "Arrange"; cursor controls in a sub-section; toolbar button toggles it (same as Shift+N). Accept: smoke: toolbar button opens drawer (`#cursor-panel` visible). Tier: haiku.

### Phase 1 — Hierarchy core: selectable groups, rigid group transform, lock (core only, no UI polish yet)

**1.1 Selection accepts group ids.** Files: `src/core/Selection.js`, `src/core/LogicalObjects.js` (add `isGroupId(id, state)`), `Blueprint.md` §4b. Behaviour: `set/add/toggle` accept `scene.groups` ids; `_resolve` returns `{id, node, kind:'group'|'object'}`; for groups, highlight = all descendant meshes; `getSelectedResolved()` keeps returning meshes (+ new `getSelectedNodes()`); ghosts/parts canonicalise as today. Accept: new `tests/selection-groups.test.mjs`: group id round-trips; selecting a group highlights 3 descendant meshes; `selectAll` returns top-level nodes only. Deps: none. Tier: opus (touches the selection invariant).

**1.2 Pivot attaches group nodes rigidly.** Files: `src/core/scene/PivotSession.js:175-238`, `src/core/commands/TransformCommands.js`, `src/core/commands/support.js` (`findNodeForId` already exists). Behaviour: `attachToSelection(nodes, …)` parents each selected **node** (mesh or group TransformNode) under the pivot; `_snapshotAbsolute` keys by node id (`metadata.meshId` or `metadata.groupId`); `TransformCommand` applies to either; pivot position = AABB centre of the selected nodes' geometry (not node origins). G/R/S modal path (`InputManager.js:319-399`) uses the same node list. Accept: `tests/history-pivot.test.mjs` extended: moving a selected group moves its TransformNode and children keep local transforms; undo restores; rotate a group → child world positions rotate about the group pivot. Deps: 1.1. Tier: opus.

**1.3 Group transform persistence + origin.** Files: `src/core/commands/ParentCommands.js:168-271`, `src/core/persist/ProjectSerializer.js:225-233`, `ProjectLoader.js:76-117`. Behaviour: `CreateGroupCommand` sets `parentId` = common ancestor of members; origin = bottom-centre of combined AABB; name via `uniqueHierarchyName('Group')`; group transform is restored on load (already serialised; add a round-trip test). Accept: `tests/hierarchy.test.mjs`: grouping two objects already inside group A creates the new group under A; name is `Group.001` on collision; persistence round-trip keeps the group node transform. Deps: 1.2. Tier: sonnet.

**1.4 Ungroup acts on selected groups; Delete/Duplicate accept groups.** Files: `ParentCommands.js:277-368`, `HierarchyCommands.js:171-303`, `InputManager.js:760-777`, `ContextMenu.js:544-560`. Behaviour: `UngroupCommand(groupIds)`; disabled when no group selected; `DeleteCommand` deletes a group subtree (reuse `planHierarchyRemoval`); `DuplicateCommand` deep-copies a subtree and its undo prunes `childIds`. Accept: `tests/hierarchy.test.mjs`: ungroup only the selected nested group; delete group removes subtree + records; duplicate group → new group + N clones; undo leaves `childIds` clean (assert no dangling ids). Deps: 1.1. Tier: sonnet.

**1.5 Lock enforcement.** Files: `Selection.js` (`_resolve` tags locked), `PivotSession.js` (skip locked nodes), `InputManager.js` (G/R/S, body drag, Delete → toast "N locked objects skipped"), `PropertiesPanel.js` (disable transform fields when active is locked), `HierarchyCommands.js` (`LockCommand` on a group applies to subtree). Accept: `tests/safety-commands.test.mjs`: locked mesh not in pivot set; Delete on locked selection pushes nothing and reports; group lock cascades. Deps: 1.1. Tier: sonnet.

**1.6 Fix logical-object edge cases found in audit.** Files: `ParentCommands.js:416-530`, `MeshValidator.js:513-518`, `ExportContext.js:167-190`. Behaviour: Split names `.001` via `uniqueHierarchyName`, new group named `<lead> parts`; Join reparents absorbed parts to the lead's parent; `validateAllPrintParts` dedupes by `canonicalObjectId`; `collectPrintUnits` includes a unit if **any** part has `isPrintPart` and the lead flag is authoritative (set parts = lead on toggle via `PrintPartCommand` expansion). Accept: `tests/split-join.test.mjs`, `tests/validator-group.test.mjs`, `tests/export-context.test.mjs` extended for each bullet. Deps: none. Tier: sonnet.

**1.7 Remove runtime reads of `sourceGroupId`.** Files: `LogicalObjects.js:29,47`, `MeshValidator.js:140-151,332-335`, `HierarchyCommands.js:330-345`, `AssetRegistration.js:111,162`. Behaviour: `logicalObjectId` is the only linkage; `sourceGroupId` written for back-compat only; loader seeds `logicalObjectId` from `sourceGroupId` when absent (`ProjectLoader` migrate hook, see 3.4). Accept: `tests/logical-objects.test.mjs`: doc with only `sourceGroupId` loads as one logical object; grep shows no runtime consumer. Deps: 1.6. Tier: sonnet.

### Phase 2 — Import groups, click-depth, Outliner and menu (user-visible hierarchy)

**2.1 Import rule: multi-object file → group named after the file.** Files: `src/core/import/ImportHierarchy.js:68-160`, `AssetImport.js:235,330`, `AssetRegistration.js:93-189`, `Blueprint.md` §8 GroupNode. Behaviour: after folding multi-primitive/multi-material parts, if ≥2 leads → root import group `{name: fileStem, origin:'import'}` containing the authored sub-hierarchy (single-child wrappers still collapse); 1 lead → no wrapper. `instantiateAsset` follows the same rule. Accept: `tests/library-import.test.mjs`/`tests/split-on-import.test.mjs`: 2-mesh glTF → 1 group + 2 objects; 1-mesh glTF → 0 groups; multi-primitive single mesh → 0 groups. Smoke: import the two fixtures, assert group count. Deps: 1.3. Tier: sonnet.

**2.2 Scope + click-depth in the viewport.** Files: `Selection.js` (`scopeId`, `enterScope/exitScope`), `InputManager.js:190-237` (click/double-click), `SceneManager.js:647-669` (`pickSelectionTargetAt` returns topmost-below-scope), `BoxSelect.js:54-67` (AABB of topmost-below-scope nodes), `events.js` (`SCOPE_CHANGED`), `Blueprint.md` §4b/§6. Behaviour: exactly §2.3. Double-click detection: two POINTERDOWNs < 350 ms, < 4 px apart. Esc priority: modal op > box select > scope out. Accept: `tests/selection-groups.test.mjs`: pick on child inside group at root scope → group selected; after `enterScope(group)` → child; `exitScope` → group; box-select at root returns group not children. Smoke: CDP double-click on fixture inside group selects child (assert `selection.activeId` is a mesh id). Deps: 1.1, 2.1. Tier: opus.

**2.3 Breadcrumb + status hint.** Files: new `src/ui/ScopeBreadcrumb.js` (under `#nav-cube`), `index.html`, `StatusBar`/`InputManager` hint, `src/styles/components/viewport.css`. Behaviour: `Scene › group › subgroup`; crumb click sets scope; hidden at root; hint "Double-click to enter · Esc to exit" when the active selection is a group. Accept: smoke: after entering a group `#scope-breadcrumb` text contains the group name. Eyeball. Deps: 2.2. Tier: sonnet.

**2.4 Outliner: groups selectable rows, collections demoted.** Files: `src/ui/Outliner.js` (tree build `:110-171,241-268`, `_activateRow :703-739`, highlight `:781-788`), `ContextMenu.js:114-127,587-619`. Behaviour: no collection rows; import groups/objects show a "From file" tooltip and a `file:` filter chip; clicking a group row selects the group (and sets scope to its parent); group rows highlight when selected; group eye/lock buttons work (cascade commands); part rows labelled "material parts"; remove collection rename/delete menu items. Accept: smoke: import 2-object fixture → outliner has a group row with `aria-selected=true` after click; `tests/hierarchy.test.mjs` for cascade visibility. Deps: 1.1, 1.5, 2.1; Decision 2. Tier: sonnet.

**2.5 Properties with a group active.** Files: `src/ui/PropertiesPanel.js:112-148,211-242`. Behaviour: header "Group · N objects"; Transform edits the group node; Object section shows name/visible/lock/print (print toggle cascades); Material/UV/Source hidden for groups. Accept: smoke: select group → Properties shows group name; edit Pos X → group node moved (read via `window.__mixo` test hook already used by smokes). Deps: 1.2, 2.4. Tier: sonnet.

**2.6 Context menu tiering + Enter/Exit group items.** Files: `ContextMenu.js:156-253`, `src/styles/components/context-modal.css`, locales. Behaviour: §2.4 primary tier + four submenus; `Enter group` when active is a group, `Exit group` when scope ≠ root; impossible items hidden in submenus, greyed in primary. Accept: smoke pins count of top-level `.cm-item` ≤ 14 with one object selected; submenu opens on hover/click. Deps: 2.2. Tier: sonnet.

**2.7 Undo/redo labels for new commands + Blueprint sync.** Files: commands' `label`, `Blueprint.md` §5 standard commands, §13 Outliner/Context Menu. Tier: haiku.

### Phase 3 — Asset model: one descriptor, one resolver, desktop parity, migration

**3.1 Schema 3.4 + `migrate()`.** Files: `src/core/persist/constants.js`, `ProjectLoader.js:121-126` (real migrate), `ProjectSerializer.js:76-163`, `ProjectValidator.js`, `Blueprint.md` §11 schema. Behaviour: write `source` + `project.id`; `migrate(3.3→3.4)`: `directoryHandleKey+originalPath → source{kind:'folder', refKey, path, label}`, `fileHandleKey → source{kind:'file', refKey, path:'', label:filename}`, `sourceGroupId`-only linkage → `logicalObjectId`; keep legacy keys on write for one minor version (3.4 docs still carry them, 3.5 drops). Readers of 3.4 that are older (3.3 app) still load via `fileData`. Accept: `tests/persistence.test.mjs`: 3.3 fixture doc migrates to `source` shape; 3.4 doc round-trips; a 3.4 doc loaded by `_resolveAssetBlob` legacy path still resolves bytes. Deps: none. Tier: opus.

**3.2 `StorageAdapter.resolveAsset / persistRef / restoreRef / findMoved`.** Files: `StorageAdapter.js`, `DesktopStorageAdapter.js`, `AssetResolver.js` (becomes a thin caller), `DirMounts.js`, `electron/OpaqueFileRegistry.cjs` + `main.cjs` (+ `refs:persist/restore` IPC backed by `KvStore` namespace `refs`), `electron/preload.cjs`. Behaviour: §2.2; browser `refKey` stable per folder (`dir_<sha256(name+firstEntryName)>`), file keys `fh_<sha256(name+size+lastModified)>`; desktop tokens persisted `{token→absPath}` and re-validated on restore (path exists); `findMoved` = today's `scanDirForHash` behind an explicit call with a progress callback. Accept: `tests/storage-adapter.test.mjs` conformance suite run against BrowserStorageAdapter (idb stub) **and** DesktopStorageAdapter (fake `window.electronAPI`); `tests/opaque-file-registry.test.mjs`: tokens survive a registry reload from KV; `tests/persistence.test.mjs` tiers: live hash-match → live; hash-mismatch → embedded+drift; unreachable → embedded; nothing → ghost. Deps: 3.1; Decisions 3, 10. Tier: opus.

**3.3 Route the six direct FSA calls + boot gate.** Files: `PersistenceManager.js:88,124`, `ProjectLoader.js:494`, `ViewportDrop.js:62,129-130`, `print/Download.js:9,14`, `main.ts:41`, `DesktopStorageAdapter.js` (use `dialog:open/save` IPC with `fs:readFileRef`/write via a new allowlisted `fs:writeRef` that only accepts tokens minted by `dialog:save`). Behaviour: all pickers via `storage.*`; desktop never calls `window.show*Picker`; boot gate `caps.mountDirectory || storage.kind==='desktop'`. Accept: headless: `PersistenceManager.__test` paths call the adapter (spy); Electron smoke (`npm run test:electron`, headful) opens + saves a `.mixo` via IPC (extend `tests/electron-smoke.mjs` with `MIXO_SMOKE=save`). Deps: 3.2. Tier: opus.

**3.4 `RelinkAssetCommand` (Refresh / Find / Relink unified).** Files: new `src/core/commands/AssetCommands.js`, `ProjectLoader.js:491-532` (delete `relinkAsset`), `AssetRestore.js`, `ObjSiblings.js`. Behaviour: given `{assetId, source?, bytes}` → update `source`, `contentHash`, re-restore container with `libraryItem` + OBJ siblings, rebind textures, dispose old container, clear ghost; undoable (keeps old container disabled, like Delete). Accept: `tests/persistence.test.mjs`: relink updates hash and the next `buildDocument` embeds the new bytes under the new hash; undo restores old bytes. Deps: 3.2. Tier: sonnet.

**3.5 Asset status in state + Properties ▸ Source + card chips; remove Linked/Snapshot.** Files: `ProjectLoader.js:236-312,330,388` (write `assetLibrary[id].status`), `PropertiesPanel.js` (Object section), `AssetPanel.js:444-495` (tabs renamed Project/Folders, chips only for drift/missing/ghost, card context menu with Refresh/Find/Remove), locales. Behaviour: §2.2. Accept: smoke: drop fixture → Properties Source reads "Embedded copy"; `tests/persistence.test.mjs` asserts `status` values per tier. Deps: 3.2, 3.4. Tier: sonnet.

**3.6 Boot banner (re-mount + autosave) and autosave hygiene.** Files: new `src/ui/BootBanner.js`, `AssetPanel.js:202-231` (delete `promptRemount` modal path), `Autosave.js`, `ProjectSerializer.js:167-179` (skip re-encoding images that already have a stored hash), `ProjectMenu.js:201`, `main.ts:118-120`. Behaviour: non-blocking banner under the header with "Re-mount *X*" (all remembered mounts, not just last) and "Recover unsaved changes (hh:mm)" when an autosave for the last `project.id` is newer than its `savedAt`; autosave keyed by `project.id`; desktop re-mounts silently (tokens persist) and only shows the recovery line. Accept: `tests/persistence-load-guards.test.mjs`: recovery offered only when newer; `tests/dirty-tracking.test.mjs` unchanged. Smoke: with a stored autosave the banner renders. Deps: 3.2; Decision 4. Tier: sonnet.

**3.7 Dead code + registry growth.** Files: `DirMounts.js:50-67`, `OpaqueFileRegistry.cjs:43` (cache child tokens per directory token, invalidate on refresh), remove `restoreDirectory`, `recoverAutosave` modal, unused caps, `ProjectValidator` `OBJECT_FIELDS` `'scene'`, duplicate `SESSION_KEY` constants. Accept: lint clean; `tests/opaque-file-registry.test.mjs` asserts listing twice yields the same tokens. Tier: haiku.

**3.8 Blueprint §11 rewrite + ADR 0001 addendum + HANDOFF resume pointer.** Tier: haiku (after 3.1–3.7 land).

### Phase 4 — Shell polish and onboarding

**4.1 Header: Import / Export / Undo / Redo / ?.** Files: `ProjectMenu.js:24-35`, `index.html:40-57`, `src/styles/components/project.css`, `InputManager` (Ctrl+I). Behaviour: §2.4; Export switches to Print workspace + Export tab (toast on switch). Accept: smoke: `#btn-import` exists and opens the multi-file picker path (`ViewportDrop.promptImport` spy). Tier: sonnet.

**4.2 Properties ▸ Object in all workspaces.** Files: `layout.css:378-409`, `PropertiesPanel.js`. Behaviour: Scene/Print keep Properties mounted with only the Object section; existing `data-section` CSS filter. Accept: `scripts/ui-screenshot.mjs` four-workspace capture shows the Object section in all; `PROBE=1` geometry sane. Deps: Decision 6. Tier: haiku.

**4.3 Workspace-switch toast; Repair naming; Print ▸ Scale simplification; Cost plumbing popover.** Files: `ShaderPanel.js:788-796`, `PrintPanel.js:90-99,787`, `PrintPanel.js` Scale tab, `src/ui/print/CostBlock.js`, locales. Accept: smoke pins Scale tab default text "Print at the size shown". Tier: sonnet.

**4.4 First-run coach + ? sheet.** Files: new `src/ui/Onboarding.js`, `index.html`, new `src/styles/components/onboarding.css` (import it from `src/styles/components.css` like the other component sheets), locales; `localStorage mx-onboard-v1`. Behaviour: 4 anchored steps, skippable, replay from ?; shortcut sheet lists `InputManager` registrations grouped by context. Accept: smoke with cleared localStorage: overlay present; after Skip, absent; `?` reopens. Eyeball. Tier: sonnet.

**4.5 Progress overlay Cancel; modal stacking.** Files: `ProgressOverlay.js:244-251`, `Modal.js:86`. Behaviour: overlays that support abort show Cancel (export, video already have abort paths); `Modal.open` queues when one is open instead of replacing (closes CIA MEDIUM "concurrent import failures overwrite"). Accept: `tests/progress-overlay.test.mjs` extended; new modal queue test. Tier: sonnet.

**4.6 Default printer (Decision 8) + `printers.json` row.** Tier: haiku.

### Phase 5 — Deferred / seams (not scheduled)

- `watchFiles` desktop watcher → auto "Changed on disk" chip (needs 3.2).
- `caps.externalTools` + `ToolAdapter` stub for the Blender sidecar (one typedef file, no callers).
- Per-section workspace expand presets (Blueprint 13b deviation 2).
- Outliner multi-row drag of groups; keyboard arrow navigation into groups.

### Dependency graph

```
0.* ──────────────────────────────┐
1.1 → 1.2 → 1.3 → 2.1 → 2.2 → 2.3 │
 │     │            └──→ 2.4 → 2.5 → 2.6 → 2.7
 ├──→ 1.4, 1.5                    │
1.6 → 1.7                          │
3.1 → 3.2 → 3.3                    │
       ├──→ 3.4 → 3.5              │
       └──→ 3.6 → 3.7 → 3.8        │
4.1, 4.2, 4.3, 4.4, 4.5, 4.6 ←─────┘ (after Phase 2 for 4.1/4.2; others any time)
```

Phases 1–2 and Phase 3 are independent and can interleave; recommended order is 0 → 1 → 2 → 3 → 4 because the grouping change is the most visible win and the asset change carries a schema bump best shipped once the hierarchy fields (`logicalObjectId` seeding) are final.

---

## 6. Risks and what NOT to do

**Risks**

- **Selection invariant change (1.1)** touches every command that expands ids (`logicalObjectCommandIds` callers). Mitigation: `getSelectedResolved()` keeps its mesh-only contract; new `getSelectedNodes()` is additive; run `npm run test:all` after 1.1 and 1.2 before continuing.
- **Rigid group transform + export seam**: `PrintPrep.flattenWorld` already bakes the full ancestor matrix (`import_export_seam_split`), so group transforms export correctly — but verify with the empirical loop (export tetra inside a rotated group → trimesh signed volume +1000, PrusaSlicer manifold) **never by LH/RH reasoning** (memory `print_space_axis_seam_2026-09-17`).
- **Import grouping changes Outliner shape for existing projects**: 3.3 docs restore their saved groups as-is (no re-import), so nothing moves; only *new* imports get the file group.
- **Schema 3.4**: keep legacy keys on write for one version; a 3.3 build reading a 3.4 file still finds `fileData`. Test both directions (3.1).
- **Browser mount-key change (Decision 10)**: old `dir_<name>_<ts>` keys still resolve through `restoreRef` (keep the idb records); new keys only for new mounts.
- **Electron work is headless-unverifiable**: every 3.x desktop step ends with `npm run test:electron` headful on the owner's machine before the next step.
- **Terminology rename collides with smoke pins** (`tests/browser-smoke.mjs` greps English text): update pins in the same commit (0.1, 0.2).
- **Context-menu tiering** hides power verbs one level deeper; mitigated by the Arrange toolbar button and the ? sheet.

**Do NOT**

- Do not reintroduce a global scale/`workingRatio`; per-object ratio is locked.
- Do not downscale textures or freeze meshes to "simplify" assets (export reads frozen full-res source bytes — Mimaki fidelity lock).
- Do not let OS paths into renderer state or `.mixo` (ADR 0001); `source.label` is display-only.
- Do not make the hash scan automatic again, and do not let a live tier replace bytes whose hash differs without the user's click.
- Do not put a `.mixo`-wide "collection" rename back as a feature — provenance is read-only.
- Do not add a fifth workspace or repeat a specialist section; the Object section exception (Decision 6) is the only one.
- Do not build dockable panels, a DAM (tags/ratings/cloud), or a slicer.
- Do not plan the Blender sidecar beyond the `ToolAdapter` typedef.
- Do not reason about winding/axes on paper; use `tests/scan-probe.mjs`, trimesh and PrusaSlicer CLI.
- Do not merge "Separate by material" parts back automatically on import; separation stays explicit (owner decision 2026-09-18).
