# MIXOMESH — Phase 3 → Phase 4 handoff

Paste this into a fresh Claude Code session at `S:\ai\mixomesh` to continue.

---

## Where we are

**Phase 3 (Selection & Interaction) closed 2026-05-13.** What works in Chrome at `http://localhost:5500`:

- Click-pick + Shift-click multi-select; `A` toggle select-all; `Alt+A` deselect; right-click on viewport or Outliner row opens the context menu.
- Active mesh has a full-intensity cyan ring; other selected meshes have a dim ring (screen-pixel constant, no face bleed, no `HighlightLayer` — see "Design decisions" below).
- Gizmo (translate/rotate/scale) with a pivot-parented `TransformNode` that respects `pivotMode = 'median' | 'active'`. Drag-end commits a `TransformCommand`.
- Modal `G` / `R` / `S` with `X`/`Y`/`Z` axis constraint, `Shift+X/Y/Z` planar, typed values (mm / deg / multiplier), `Ctrl` to snap, `Enter`/LMB to commit, `Esc`/RMB to cancel.
- `F` frame · `Ctrl+G` group / `Ctrl+Shift+G` ungroup · `H` hide / `Alt+H` unhide · `Delete` / `X` delete (soft-delete + undo restores) · `Shift+D` duplicate (also in context menu) · `~`/`backtick` toggle gizmo space · `.` cycles `pivotMode`.
- Outliner with hierarchy tree, visibility/lock toggles, inline rename (double-click), right-click context menu, ghost/locked/hidden row states.
- Properties panel: Object / Transform (with derived **Size (mm)** read-only row) / Source Unit (re-bakes vertices on change). When nothing is selected the panel shows a **Scene** section with a Grid Size (mm) input.
- Scene defaults: 300 mm grid extent, 50 mm axes (1-pixel red/green/blue lines, no arrowheads), camera radius 400 mm, zoom 20 mm…5 m, panning/wheel sensitivity tuned for small parts. 3D cursor is hidden unless `pivotMode='cursor'`.
- Import scale is BAKED into vertex data — every mesh reads `scaling = (1,1,1)` after drop. See **Design decisions** for why this matters.
- Full undo/redo across every command above. `Ctrl+Z` / `Ctrl+Y`.

## Deferred from Phase 3 (user accepted)

1. **Locked-mesh enforcement** — `locked` flag is plumbed through state + UI but doesn't currently block transforms. Future work.
2. **`B` box-select** — not wired (drag-marquee). Skipped for milestone.
3. **`pivotMode = 'individual'` / `'cursor'`** — currently fall through to `'median'`. Cycle key `.` rotates through all four labels visually.
4. **Drop dedup** — dropping the same file twice currently creates two `AssetEntry` rows + duplicate `AssetContainer`s in memory. Functionally fine (you get N independent meshes); Phase 6's Smart Replace work is the natural place to add a "this file is already loaded → instantiate from existing container" fast path.
5. **Copy active-to-selected** — Blender-style "↧ to all" affordance on Properties sections. Documented in BLUEPRINT §13 "Future: Copy active-to-selected" and in memory note `backlog-copy-from-active`. Defer to Phase 4 because the same pattern wants to apply to Shader/UV sections that don't exist yet.

## Design decisions locked in Phase 3

Read these before changing related code:

- `memory/phase3_design_decisions.md` — gizmo pivot, modal typed units, snap on Ctrl.
- `memory/scene_default_scale.md` — 300 mm working area + camera/axes/cursor defaults + the custom selection outline (mask RTT + dilation shader, NOT `HighlightLayer`).
- `memory/scale_ratio_model.md` — workingRatio / targetRatio / per-asset modelRatio math AND the vertex-bake decision. **The bake is a Babylon software-compatibility concern (HL stencil + gizmo precision at sub-mm scale), not part of the ratio math.** BLUEPRINT §8 has a callout explaining this.
- `memory/backlog_copy_from_active.md` — the deferred copy-from-active feature.

Critical rules that must not be violated (also in `CLAUDE.md`):
1. All state mutations go through `StateManager.dispatch()` / `setState()`.
2. All reversible actions push a Command to `HistoryManager`.
3. All inter-module communication uses typed events from `core/events.js` — no raw strings.
4. Babylon-first per BLUEPRINT §0.4 before writing custom geometry/scene/IO.
5. Chrome/Edge only. Single startup check.
6. OBJ + MTL primary export.
7. Module size soft targets per BLUEPRINT §0.5 — split if exceeded by 1.5×.

## Where to find things

- **Spec:** `BLUEPRINT.md` — re-read the relevant Part before writing or modifying a module. Phase 3 changes are baked into Parts 4, 5, 7, 8, 13, 15.
- **Project context:** `CLAUDE.md` — coding conventions, build phases, phase handoff rule.
- **Auto-memory:** `C:\Users\DCT\.claude\projects\S--ai-mixomesh\memory\MEMORY.md` is the index; read the linked notes when their topic comes up.

---

# Next: Phase 4 — Shader System

## BLUEPRINT §15 deliverables

Full `ShaderLibrary` · `ShaderPanel` · Properties Panel shader + UV override sections · merge-strategy modal.

The Phase 2 stub of `ShaderLibrary` (in `core/ShaderLibrary.js`) already does **registerFromContainer / linkMesh / unlinkMesh / getBabylonMaterial / getMaterialById**. Phase 4 fills in the rest of the public API from BLUEPRINT §10:

```
ShaderLibrary.createShader(partial)         → shaderId
ShaderLibrary.updateShader(shaderId, field, value)
ShaderLibrary.duplicateShader(shaderId)     → newShaderId
ShaderLibrary.deleteShader(shaderId)        // only when linkedMeshIds.length === 0
ShaderLibrary.assignToMesh(shaderId, meshId)
ShaderLibrary.setUVOverride(meshId, uv)
ShaderLibrary.clearUVOverride(meshId)
ShaderLibrary.applySwatchColor(shaderId, hex)
ShaderLibrary.rebuildLinkedIndex()
```

Plus the standard commands whose stubs already exist in `HistoryManager.js`:
- `ShaderAssignCommand`, `ShaderUpdateCommand`, `ShaderDuplicateCommand`, `ShaderDeleteCommand`
- `UVOverrideCommand`, `ColorApplyCommand`

UI new in Phase 4:
- `ui/ShaderPanel.js` per BLUEPRINT §13 — scene shader list with mesh-count badge, inline editor (type / diffuse color / texture drop / UV base / opacity / PBR sliders), swatch palette using the hardcoded library from §10 (`DEFAULT_SWATCHES`), user swatches with `Plus` button.
- Properties Panel new sections — **Shader** (dropdown of scene shaders, Duplicate / Edit) and **UV Override** (offset/scale/rotation inputs, "Reset to Default").
- Merge-strategy modal — surfaced on `EVENTS.MODAL_OPEN` payload `{ id: 'shaderMerge', conflicts }`. Generic `ui/Modal.js` lives in BLUEPRINT §13 "Modal" — create it now.

## Phase 4 milestone (BLUEPRINT §15)

> Create / duplicate / assign shaders, edit UV per mesh, apply swatches, all undoable.

## Process

### STEP 0 — verify Phase 3 in Chrome
Before writing Phase 4 code, confirm in `http://localhost:5500`:
- Drop two GLBs → click each → cyan ring follows; active has stronger ring than other selected. Console clean.
- `G+X+50+Enter` moves 50 mm; Ctrl-hold snaps. `Esc` reverts. Undo unwinds.
- `Ctrl+G` groups them; Outliner shows a Group; `Ctrl+Shift+G` ungroups.
- `F` frames selection. `H` toggles hidden. Right-click → Duplicate creates an offset clone.
- Properties → Source Unit dropdown change → mesh rescales correctly, AlertTriangle appears, `Confirm` clears it.
- Click empty space → Properties shows Scene → change Grid size (mm) → ground rebuilds at new extent.

If anything regresses, fix before proceeding.

### STEP 1 — build Phase 4 per BLUEPRINT §10 + §13

Recommended order:
1. `ui/Modal.js` — generic id-routed modal (used by shader merge + later validation-errors + dirty-confirm).
2. Flesh out `core/ShaderLibrary.js` — create / update / duplicate / delete / assign / UV override / swatch apply / linked-index rebuild. Live-mutates the Babylon material so all linked meshes update without per-mesh clones; UV overrides clone the material once per override per BLUEPRINT §10 "Material Management".
3. Implement command bodies in `HistoryManager.js` for the Shader/UV/Color stubs. Each must work through `setState` and `markDirty` per Phase 3 patterns; reuse `_withDetachedPivot` if a command moves meshes.
4. `ui/ShaderPanel.js` — scene shader list, inline editor, swatch palette. Mount it in `main.js`. Add a panel container to `index.html` (right column shares with Properties — switch via `state.ui.activePanel`).
5. Properties Panel → new **Shader** and **UV Override** sections rendered for the active object.
6. Merge-strategy modal — wire `EVENTS.MODAL_OPEN` `'shaderMerge'` in `AssetLoader` when `registerFromContainer` detects a name collision, default to "Rename" per §10.

Stop at the Phase 4 milestone and hand the user a verification checklist. Then follow the "Phase handoff" rule in `CLAUDE.md` to update this file for Phase 4 → 5.

## Ask before guessing

- New icons needed: `Palette`, `Copy`, `Trash2`, `Plus`, `Edit3` — already in `core/Icons.js` from Phase 3. Add `Pipette` (color picker) if you build one.
- Texture asset model: BLUEPRINT §10 talks about `diffuseTextureAssetId` on `ShaderEntry`. We haven't decided how textures show up in the Asset Panel — assume "they're listed alongside .glb/.stl/.obj in the mounted directory and drag-drop onto a shader's texture slot." Ask the user if a different flow is wanted.
- If a UI/UX detail isn't covered by BLUEPRINT, ASK before guessing — same instruction the user gave when Phase 3 started.
