# PHASE HANDOFF

> ╔══════════════════════════════════════════════════════════════════╗
> ║  📋 COPY THE FENCED BLOCK BELOW INTO A NEW CLEAR CLAUDE SESSION.  ║
> ║  Everything UNDER the "── reference ──" line is detail Claude     ║
> ║  reads itself — you do NOT need to copy it.                       ║
> ╚══════════════════════════════════════════════════════════════════╝

```text
MIXOMESH Phases 6 AND 7 are both CLOSED on the checkbox but neither live
milestone has been demonstrated in a browser — that verification is THIS
session's job and must happen before any new feature/polish work.

Read PHASE_HANDOFF.md in full, then:
  STEP 0 — verify Phase 5 still runs in Chrome.
  STEP 1 — run the deferred Phase 6 milestone verification in Chrome
           (save→reopen, ghost→relink, hybrid match, boot, autosave).
  STEP 2 — run the deferred Phase 7 milestone verification:
           import a textured GLB → set printer = Mimaki 3DUJ-553 →
           Export 3MF → reopen the exported 3MF in MIXOMESH AND in a
           Mimaki slicer (or any 3MF viewer that supports the Materials
           Extension). Textures must round-trip intact, not collapse to
           solid colours. Then set printer = Bambu X1C → Export 3MF →
           open in Bambu Studio: parts colored by `<m:colorgroup>`.
  STEP 3 — fix anything that fails; when it passes, update the
           "LIVE-CHROME-UNVERIFIED" markers (CLAUDE.md, BLUEPRINT §15,
           memory phase6_close + phase7_close) to "verified <date>".
Re-read BLUEPRINT §11 (Persistence), §12 (Export), §15 (Phase 7) before
touching anything. Code + 95/95 headless tests pass; the browser/slicer
runs are the only thing missing. Do NOT assume it works — verify and
debug. I will run Chrome and the slicer and report what I see.
```

────────────────────────────── reference ──────────────────────────────
*(below is for Claude to read — not part of the copy-paste prompt)*

## Status: Phases 6 + 7 — CLOSED on checkbox, ⚠ LIVE-CHROME-UNVERIFIED

Phase 6 (Persistence & Polish) closed 2026-05-17. Phase 7 (Mimaki textured
3MF Materials Extension writer + matching loader) closed 2026-05-18. Both
were marked closed on the user's explicit "no human tester available, move
on" instruction. **Code is complete and 95/95 headless tests pass, but
neither §15 milestone was ever demonstrated in a browser, and the Phase 7
output has never been opened in a real Mimaki slicer.** Last phase actually
verified live in Chrome is still Phase 5. This is a known, recorded
deferral — see memory `[[phase6_close]]` + `[[phase7_close]]`.

There is no Phase 8 planned. The remaining work is: (1) the two live
verification passes below, (2) fixing whatever they surface, (3) any polish
the user then requests.

Milestones to prove (BLUEPRINT §15, verbatim):

**Phase 6:**
> Save → close → reopen identically. Move asset file → reopen → ghost →
> relink → resolved.

**Phase 7:**
> A textured asset round-trips: Mimaki target → Export 3MF → reopen in
> MIXOMESH (textures intact, UVs intact, transforms intact) AND open in a
> Mimaki-aware viewer/slicer with continuous-tone colour preserved.
> Filament target (Bambu X1C) → Export 3MF → open in Bambu Studio with
> parts coloured per `<m:colorgroup>` pindex.

## What exists (code complete, headless-tested only)

### Phase 6
- **`core/PersistenceManager.js`** — v3.1 `.mixo` JSON, embeds every asset's
  bytes + sha256 + originalPath + directoryHandleKey. Public API: `save /
  saveAs / open / newProject / getRecentProjects / openRecent / relinkAsset /
  startAutosave / stopAutosave / recoverAutosave / init`. Asset-resolution
  priority and boot behaviour locked — memory `[[hybrid_asset_persistence]]`.
- **Import/export seams** — `core/ImportNormalizer.js` (import) +
  `PrintManager.flattenWorld` (export). Locked — `[[import_export_seam_split]]`.
- **UI** — `ui/ProjectMenu.js` (header New/Open/Save/SaveAs + Recent +
  dirtyConfirm/recoverAutosave/unmatchedAssets modals), `ui/ProgressOverlay.js`,
  Outliner ghost/unlinked rows + Relink/SmartReplace/TransformSwab context
  items, `main.js` Ctrl+S/Shift+S/O/N, `AssetPanel.promptRemount`.

### Phase 7
- **`config/printers.json`** — single source of truth for printer profile
  (format / colorMode / textureLimits / bedDimensions / axis / winding /
  unit / PREP pipeline). Mimaki 3DUJ-553 default; Bambu X1C, Prusa XL,
  generic-filament entries also defined.
- **`core/PrintManager.js`** — single `FORMATS['3mf']` entry; `_serialize3MF`
  is async and dispatches on `printerProfile.format`:
  - `3mf-materials-ext` → `_build3MFModelMaterialsExt` (Mimaki). Emits
    `<m:texture2d>` (one per source asset, deduped via `_getAssetIdForTexture`),
    `<m:texture2dgroup>` (one per textured mesh, `texid` → texture2d),
    one `<m:tex2coord>` per vertex in vertex order, triangles carry
    `p1/p2/p3` mirroring `v1/v2/v3` (after the winding-flip switch).
    PNG bytes land in `/3D/Textures/`, referenced via per-part rels
    file `3D/_rels/3dmodel.model.rels`, Content_Types gains
    `<Default Extension="png" .../>`.
  - `3mf-colorgroup` → existing `_build3MFModelColorGroup` (Bambu/Prusa).
- **`weldSolidOnly` PREP step** — skips welding for textured meshes so
  per-vertex UVs survive. Solid-colour meshes still get welded for clean
  topology.
- **`core/ThreeMFLoader.js`** — async `_buildContainer(scene, zip, modelXml)`.
  Parses `texture2d` (reads PNG bytes from zip → blob URL → diffuseTexture),
  parses `texture2dgroup` into `{texId, coords[]}`, and on per-object
  build: if `pid` resolves to a texGroup, walks triangles writing
  `coords[p_i]` to `uvs[v_i*2]` (the trivial inverse of the writer). Solid
  objects keep the `<m:colorgroup>` `pid+pindex` path.

### Post-Phase-7 polish wave (2026-05-18, LIVE-CHROME-UNVERIFIED)
On top of Phase 7's textured-3MF work, three polish features landed in the
same handoff window. They share the live-Chrome verification gap with
Phases 6 + 7 — all three need a browser pass before the markers can flip.

- **Filename system.** Unique export names + `_1to35` ratio suffix +
  `showSaveFilePicker` save flow + inline project rename. Four sites move
  as one contract — touch one, audit all. BLUEPRINT §12 + memory
  `[[export_filename_system]]`.
- **OBJ solid-colour PNG synthesis.** OBJ-only Mimaki fallback: every
  solid-colour shader bakes to a 4×4 RGBA PNG at
  `textures/solid_<HEX_RRGGBBAA>.png`, the MTL gets `map_Kd` injected,
  α is dual-written (PNG channel + MTL `d`). Toggle persisted in
  `state.print.objBakeSolidTextures` (default `true`). Checkbox in
  Print ▸ Export. BLUEPRINT §12 *OBJ solid-colour PNG synthesis*;
  memory `[[obj_solid_png_synthesis]]`.
- **Copy-from-active ↧ buttons.** Single header-level button on
  Properties ▸ Transform / Shader / UV Override sections. Visible only
  when `selectedIds.length > 1` (Shader additionally needs an active
  binding). One-undo-step semantics via `TransformCommand(prev, next)` /
  `ShaderAssignCommand(targets, shaderId)` / `beginBatch` around N
  `UVOverrideCommand`s respectively. Each handler calls
  `e.stopPropagation()` so the section collapse-toggle (also on the
  header) doesn't fire. CSS `.pp-copy-btn` in `styles/components.css`.
  BLUEPRINT §"Copy active-to-selected — ↧ buttons (shipped
  post-Phase-7)"; memory `[[copy_from_active_shipped]]`.

### Headless tests — 95/95 green
`node --import ./tests/register-hooks.mjs --test tests/*.test.mjs`

Breakdown: export 47 + validator 4 + persistence 18 + split-on-import 5 +
state-shape 10 + threemf-materials-ext 6 + validator-group 5 = 95.

**Phase 7 round-trip tests cover** (`tests/threemf-materials-ext.test.mjs`):
1. Mimaki + textured mesh → Content_Types has png, `/3D/Textures/paint.png`
   present, per-part rels with texture relationship, texture2d +
   texture2dgroup XML, object pid → texGroup, triangle `p_i == v_i`.
2. Bambu target → colorgroup layout, no png, no per-part rels.
3. Mimaki + solid mesh → degrades to colorgroup (no textures land).
4. Mimaki + mixed → both resource types coexist with distinct pids.
5. Round-trip integrity: regex-recover tex2coord ordering, pseudo-loader
   rebuilds identical UVs.
6. Texture dedup: shared texture → one `<m:texture2d>` + two
   `<m:texture2dgroup>` both with `texid="1"`.

**Headless tests do NOT cover** (this is exactly what the live STEPs must
prove): the live Babylon scene round-trip, File System Access pickers,
autosave timer, Outliner ghost UI, **the actual Mimaki slicer accepting
the textured 3MF**, and the 3MF axis/winding switches against a real
consumer (paper LH↔RH reasoning is unreliable).

---

### STEP 0 — verify Phase 5 still runs (do first)

1. `npx http-server -p 5500 -c-1`, open Chrome at http://localhost:5500.
2. DevTools console clean (CLAUDE.md rule — no errors, no "ignore warnings").
3. Drop a multi-mesh GLB: collection in outliner, scene auto-frames, nav-cube
   tracks orbit + face-click snaps, floor = rectangular Saturn bed.
4. Camera: RMB=orbit, MMB=pan, Shift+MMB=orbit, wheel=zoom, LMB=select/gizmo.
5. Properties▸Scene grid re-skin; Print▸Bed preset resize; Export 1:35 → ZIP.
6. Import a GLB → Properties shows **rotation 0 / scale 1,1,1** (import bake).

### STEP 1 — verify Phase 6 milestone

Re-read BLUEPRINT **§11** first. Then prove, in Chrome:

1. **Save→reopen identical:** build a scene (multi-mesh, a group, a shader, a
   moved/scaled part, camera angle) → Save `.mixo` → New → Open → everything
   (transforms, group, shader, UV, camera, print/bed, selection) identical.
2. **Ghost→relink:** move/rename the source asset file → reopen → asset shows
   **ghost** in Outliner → Relink (file picker) → **resolved**, settings kept.
3. **Hybrid match:** with the asset folder mounted, reopen → assets match by
   content hash to the live files (not the embedded copy); unmatched ones
   listed and load static/unlinked.
4. **Boot:** restart → it does NOT restore last session; it prompts to
   re-mount the last asset folder.
5. **Autosave / Smart Replace / Transform Swab** spot-check.

### STEP 2 — verify Phase 7 milestone (Mimaki round-trip)

Re-read BLUEPRINT **§12** + **§15 Phase 7** first. Then prove:

1. **Mimaki textured round-trip (MIXOMESH↔MIXOMESH):**
   Import a textured GLB (e.g. a painted figurine). Verify Print panel
   shows printer = **Mimaki 3DUJ-553** by default. Export 3MF.
   File → Open the exported `.3mf` directly in MIXOMESH → textures must
   reappear (not blank, not solid colour), UVs intact, transforms intact.
2. **Mimaki textured round-trip (MIXOMESH→external):**
   Open the exported `.3mf` in a viewer that understands the Materials
   Extension (Mimaki's own slicer if available; failing that, Microsoft
   3D Viewer or Lychee Slicer's 3MF preview). Confirm the texture is
   visible — continuous-tone, not collapsed to a single colour.
3. **Filament colorgroup round-trip:** switch Print panel to **Bambu X1C**
   on a multi-shader scene (no textures, distinct solid colours). Export
   3MF. Open in Bambu Studio → each part assigned to its colour slot via
   `<m:colorgroup>` pindex. Same scene reopened in MIXOMESH should still
   show the solid colours correctly.
4. **Mixed scene:** one textured part + one solid-shader part under Mimaki
   target → Export 3MF → reopen → both resource paths coexist (textured
   part keeps its texture, solid part keeps its colour).
5. **Axis/winding sanity:** in every external open above — parts upright
   (Z-up), correct scale, no mirroring. If lying down / mirrored, flip the
   one PrintManager paper switch (`Y_UP_TO_Z_UP` or `THREEMF_REVERSE_WINDING`)
   and re-test. Record the outcome in memory `phase7_close.md`.

### STEP 3 — finalise (only after STEPs 1+2 pass live)

1. Fix anything STEP 0/1/2 surfaced; re-run the 95/95 headless suite.
2. Replace the **LIVE-CHROME-UNVERIFIED** markers with "verified <date>" in:
   `CLAUDE.md` Phase 6 + Phase 7 lines, `BLUEPRINT.md` §15 Phase 6 + Phase 7
   headers, memory `phase6_close.md` + `phase7_close.md`. Record both the
   3MF axis-switch outcome and which Mimaki viewer/slicer was used.
3. Rewrite this file: either next polish backlog, or "project verified —
   no open build phases".
4. Commit only when the user asks.

If STEP 1 or STEP 2 cannot be run (no Chrome / no slicer access again), do
NOT silently re-close — report that it is still unverified and stop.
