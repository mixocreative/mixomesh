# MIXOMESH Deep Code Review — 2026-06-11

Scope: all `src/core/**` (full read), `src/app/main.ts`, UI: PropertiesPanel,
Outliner, PrintPanel, ShaderPanel (full read), AssetPanel (partial).
Not reviewed line-by-line: ContextMenu, ViewportToolbar, NavCube, ViewportDrop,
AppShell, ProjectMenu, Modal, Toast, StatusBar, idb, Icons, boot.ts,
PrintFormats/PrintPackaging/Download/PrinterProfiles, config JSON.
Baseline: 10/10 headless test files green.

Severity: C = critical (correctness / product goal), H = high, M = medium, L = low.

## C — Critical

### C1. Mimaki texture export likely produces blank PNGs in a real browser
`src/core/PrintManager.js` `_textureToBlob()` calls `texture.readPixels()`
synchronously. Modern Babylon returns a **Promise**; `imageData.data.set(promise)`
silently writes nothing → exported `3D/Textures/*.png` are transparent. The
headless Babylon shim returns sync arrays, so tests pass. Also missing: Y-flip
(GL bottom-up rows), Float32 → Uint8 conversion, RGB stride handling — all of
which `AssetLoader._readTextureToDataUrl()` already implements correctly.
**Fix:** extract one shared texture-readback utility (await readPixels, flip,
normalize) and use it in both places. Verify with a live-Chrome export opened
in a slicer — this is exactly the deferred Phase 7 live milestone.

### C2. Textured projects lose all textures after save → reload
`PersistenceManager._loadProject()`: imported (glTF-embedded) texture assets are
registered entry-only; `ShaderLibrary.restoreShader()` nulls
`diffuseTextureAssetId`; `assignToMesh()` then replaces the container's textured
PBR materials with recreated flat-color materials. Viewport AND export lose
textures. Directly contradicts the locked project goal (Mimaki texture
preservation). **Fix (design needed):** on restore, re-register container
textures (`registerImportedTexture`) and rebind shaders — requires persisting a
stable texture identity (e.g. material-name ↔ texture map per asset, or texture
content hash) in the `.mixo` shader entries.

### C3. Delete → Undo re-parents meshes to a disposed pivot node
`HistoryManager.DeleteCommand` constructor snapshots `prevParent: mesh.parent`
at construction time. With any active selection, meshes are parented to the
temporary `selectionPivot` TransformNode (`SceneManager.attachToSelection`),
which `_withDetachedPivot()` disposes during execute. Undo then calls
`setParent(<disposed node>)`. Delete is only reachable with a selection, so the
undo path is always wrong. **Fix:** snapshot parents inside `execute()` after
`_withDetachedPivot` restores canonical parents (mirror `GroupCommand`'s
state-side approach), or capture the canonical parent from SceneManager's
`_parentingSnapshots`.

### C4. Group-aware validation never runs in the live app
`MeshValidator.validateMesh()` line ~243:
`getState().scene.objects?.[mesh.name]` — objects are keyed by **meshId**, not
Babylon mesh name. `sourceGroupId` never resolves → split multi-material meshes
are validated as individual shells → false "non-manifold" warnings, the exact
problem §0.1's group-aware rule exists to prevent. Tests pass because they key
state by name. **Fix:** `getState().scene.objects?.[mesh.metadata?.meshId]`,
plus a regression test that registers via the real import path.

## H — High

### H5. SmartReplace undo loses parenting
`SmartReplaceCommand.execute()` captures `const oldParent = oldMesh.parent`
**after** `oldMesh.setParent(null)` → always null; undo drops group membership.
Move capture above the `setParent(null)` call.

### H6. Cross-file texture aliasing → wrong texture in UI/persistence/export
`AssetLoader._findImportedTextureBySignature()` dedupes by
`name|width|height|class`. Two different textures with generic glTF names
("Image_0", 1024²) collide → second file's shader points at first file's
texture. `ShaderLibrary._shaderSignature()` keys on that assetId, so the
shaders auto-merge silently too. Also `PrintManager._getAssetIdForTexture()`
checks `asset.textures?.[name]` which no assetLibrary entry has (dead path →
name fallback). **Fix:** dedupe by content hash of readback bytes (or skip
dedupe and accept duplicates); delete the dead `.textures` lookup.

### H7. UV-override clones never receive shader updates
`ShaderLibrary.updateShader()` mutates only the base material. Meshes holding a
per-mesh UV-override clone (`_uvClones`) keep stale color/texture/opacity until
override cleared. **Fix:** after `_setMaterialField(mat, …)`, iterate
`_uvClones` entries with matching `shaderId` and apply the same field (preserve
the clone's own UV transform).

### H8. Shader type switch does nothing
ShaderPanel binds `type` → `ShaderUpdateCommand` → `_setMaterialField` case
'type' is a no-op ("recreated elsewhere" — nowhere does). State flips to 'pbr',
PBR sliders appear, but the Babylon material stays Standard and roughness/
metallic writes silently fail the `'roughness' in mat` guard. **Fix:** on type
change, rebuild the material via `_createBabylonMaterial` + `_applyEntryToMaterial`,
reassign to linked meshes + rebuild UV clones.

### H9. "Save & New / Save & Open" data loss on cancelled picker
`PersistenceManager.newProject()/open()`: dirty modal → 'save' → `save()` →
`saveAs()` → user cancels picker → `saveAs` returns silently → flow continues
and **resets the world unsaved**. **Fix:** `save()/saveAs()` must return
success/abort; abort cancels the enclosing flow.

## M — Medium

### M10. Export clone fallback can mutate + dispose the live mesh
`PrintManager._runExport`: `(mesh.clone(...)) || mesh` — if clone returns null,
prep steps bake mm-scale into the LIVE mesh and the `finally` disposes it.
Fail the export instead of falling back.

### M11. PrintPanel event wiring broken
Subscribes to `EVENTS.OBJECT_ADDED` (doesn't exist → undefined key; violates
the typed-events rule). Panel misses `ASSET_INSTANTIATED`, so the Validation
tab is stale after imports. Validation tab also re-runs full topology checks
on every render (every selection change while open) — cache results or run on
explicit "Validate" action.

### M12. Source-unit change is destructive but not undoable
`PropertiesPanel._changeSourceUnit()` rebakes vertices directly — violates
§0.1 "all reversible actions push a Command". Wrap in a command (mirror
`BakeTransformCommand` snapshot strategy).

### M13. World rescale leaves 3D cursor visual behind
`RescaleWorldCommand` scales `state.scene.cursor3d` but never calls
`SceneManager.setCursor()` — sphere stays at the old position.

### M14. Shader delete/duplicate redo mints new ids
`ShaderDeleteCommand.undo()` / `ShaderDuplicateCommand` redo recreate with new
ids; older stack entries (e.g. `ShaderAssignCommand`) still reference the dead
id → broken redo chains. Fix: `createShader` should accept a forced id on
recreate (entry already carries it — reuse `restoreShader`-style id keep).

### M15. Print-preview matte mode drifts
`SceneManager._setPrintPreviewMode`: assets imported while preview is ON keep
their metallic (no re-apply on `ASSET_INSTANTIATED`); `_printPreviewMaterialMap`
never pruned; user metallic edits made while ON are clobbered by stale restore
values.

### M16. Autosave cost
Every 60 s while dirty: re-fetch every asset blob, SHA-256, base64, JSON.stringify
on the main thread. Cache content hashes (bytes are immutable per assetId), or
skip embedding in autosave docs (recovery already has live/idb tiers).

### M17. Nested-group undo divergence
`GroupCommand.undo()` re-parents meshes to scene root (`setParent(null)`) while
state restores `parentId` to the previous group → Babylon graph and state
disagree for nested groups.

### M18. Split-on-import memory blow-up
`_makeBabylonChildMesh` does `Array.from(positions)` (Float32Array → plain JS
number array) and copies the FULL vertex buffer per child. N-material mesh ⇒
N× full-buffer plain-array copies. Keep typed arrays (VertexData accepts them)
and consider slicing per-subMesh vertex windows.

### M19. wireframeEdges overlay half-wired
Missing from `INITIAL_STATE.scene.overlays` and from `setOverlay()` JSDoc;
`wireframeEdgeColor` is persisted but never reapplied to SceneManager on
project load (meshes come back with default yellow edges).

## L — Low / polish

- L20. Status hint says "MMB: Orbit" — actual scheme is RMB orbit / MMB pan
  (`InputManager._defaultHint`).
- L21. `AssetLoader.removeAsset` dispatches `ASSET_REGISTERED {type:'removed'}`
  — add a real `ASSET_REMOVED` event.
- L22. Dev-mode `getState()` deep-clones+freezes per call; `Selection.selectAll`
  calls it inside a filter loop (N clones per keypress in dev).
- L23. `cyclePivotMode` JSDoc omits 'world' though the cycle includes it;
  `setPivotMode` JSDoc type omits 'world'.
- L24. `endBatch()` pushes empty batches — guard `_batchCmds.length`.
- L25. InputManager: dead `groups` var in `_groupSelected`; grouping a single
  object allowed; Numpad5 ortho-toggle jumps to 'front' instead of preserving
  the current view axis.
- L26. PropertiesPanel shader section lacks `data-section` → only
  non-collapsible section.
- L27. `ShaderLibrary._findContentDuplicate` has side effects (registers
  imported textures + schedules thumbnails during a probe; runs twice per material).
- L28. PrintPanel re-implements export-factor math inline — use
  `PrintScale.exportFactor()`.
- L29. Module sizes: 9 modules exceed 1.5× Blueprint §0.5 targets
  (SceneManager 1216/<400, HistoryManager 993/<250, AssetLoader 1023/<350,
  PrintManager 843/<350, InputManager 725/<300, PropertiesPanel 855/<400,
  ShaderLibrary 814/<400, ShaderPanel 677/<400, PersistenceManager 665/<400).
  Blueprint mandates splitting.
- L30. Outliner collection rename bypasses HistoryManager (not undoable).
- L31. Design question: undo/redo deliberately don't mark dirty (§ contract),
  so saved-file divergence after undo never prompts on close — re-confirm this
  is intended.

## Suggested remediation order

1. **Verify-and-fix bundle (C1, C4, H5, C3)** — small, surgical fixes + live
   Chrome verification of texture export (covers the deferred Phase 6/7 live
   milestone at the same time).
2. **Texture integrity bundle (C2, H6, H7, H8)** — needs a short design pass
   on texture identity persistence; touches AssetLoader/ShaderLibrary/
   PersistenceManager + `.mixo` schema (bump to 3.2 + migration).
3. **Safety bundle (H9, M10, M12, M14)** — undo/data-loss correctness.
4. **Hygiene pass (M11, M13, M15–M19, L-items)** — mechanical.
5. **Module splits (L29)** — after the above so splits don't churn open fixes.
