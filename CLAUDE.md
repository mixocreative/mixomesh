# MIXOMESH — Project Context

## What this is
Browser-based 3D model assembly tool for **full-color 3D printing**.

- **Primary target: Mimaki UV-inkjet color printers** (3DUJ-553 default,
  3DUJ-2207 + variants). These consume textured 3MF via the Materials
  Extension OR OBJ+MTL+PNG. Continuous-tone textures preserved end-to-end
  — Mimaki paints ~10M colors per surface, *not* one solid color per part.
- **Secondary target: filament multi-color printers** (Bambu X1C, Prusa XL,
  OrcaSlicer/PrusaSlicer pipeline). 3MF with `<colorgroup>` + per-object
  `pindex` for filament zone assignment. One solid color per part.

Per-printer behavior is data-driven via `config/printers.json` (single
source of truth for printer profile: format, color mode, texture limits,
bed dimensions, axis/winding/unit, export prep pipeline). Adding a printer
= adding a JSON row, not editing code.

Babylon.js, vanilla JS, no build step, Chrome/Edge only.

## Authoritative spec — fail-safe rebuild contract
`BLUEPRINT.md` is the **canonical rebuild spec**. If the entire `core/` and
`ui/` folders were deleted tomorrow, the project must be reconstructible from
BLUEPRINT alone — same logic, same config, same data schemas, same UX
behaviours. Treat it that way:

- Re-read the relevant section before writing or modifying any module.
- Do not deviate from the contracts there.
- **Every non-trivial code change includes a BLUEPRINT update in the same
  turn.** New seam, new schema field, new tier in a priority, new module,
  new event, new persisted key, new UX pattern → it lands in BLUEPRINT with
  its rationale before the task is "done". Bug fixes inside an existing
  contract don't need an edit; anything that *changes the contract* does.
- If a change has no obvious place in BLUEPRINT, that's a signal the spec
  is missing a section — add the section, then the change.
- Memory notes are *pointers* to BLUEPRINT sections + their "why", not
  replacements. BLUEPRINT survives a wiped memory store; memory does not
  survive a wiped BLUEPRINT.

## Critical rules (do not violate)
1. All state mutations go through StateManager.dispatch(). Never mutate
   scene objects directly from UI code.
2. All reversible actions push a Command to HistoryManager.
3. All inter-module communication uses typed events from `core/events.js`.
   No raw event-name strings in calling code.
4. Use Babylon.js built-ins per BLUEPRINT §0.4 "Babylon-First Rule" before
   writing custom geometry/scene/IO code.
5. Chrome/Edge only. Single startup check halts on other browsers.
   No Firefox/Safari fallback paths.
6. Export pipeline is **printer-driven**, not format-driven. The target
   printer (from `config/printers.json`) declares format + color mode +
   prep steps. Mimaki = textured 3MF Materials Extension or OBJ+MTL+PNG
   (textures preserved). Filament = 3MF with `<colorgroup>` (solid per
   part). Never collapse textures to solid colors for Mimaki targets.
7. One-mesh-one-shader is an enforced invariant. AssetLoader splits any
   `MultiMaterial` mesh into N single-material siblings at import time and
   stamps `sourceGroupId` on the SceneObject state entries so validator +
   exporter can re-union the part.
8. Module size soft targets in BLUEPRINT §0.5. Split if exceeded by 1.5×.

## Tech stack
- Babylon.js (CDN UMD via `<script defer>` — attaches `window.BABYLON`).
  The historical `babylon.module.js` ESM file never actually existed on
  the CDN, so we use the UMD global. Confirmed working with Babylon 9.x.
- Inline SVG icon registry in `core/Icons.js` (paths copied from Lucide
  as each phase needs them). The npm `lucide` package is abandoned at
  v1.14.0 with an incompatible API — don't try to import it.
- JSZip (CDN ESM via importmap)
- No bundler, no build step, no other libraries

## Dev workflow
- I run `npx http-server -p 5500 -c-1` in another terminal.
- After your changes, I refresh Chrome at http://localhost:5500.
- I'll tell you what I see; you debug from there.
- Open DevTools console errors are real — never tell me to "ignore harmless warnings."

## Build phases
- [x] Phase 1: Foundation (events, State, History, Input, Scene, Icons, Toast, StatusBar, layout)
- [x] Phase 2: Asset Pipeline (AssetLoader, ShaderLibrary stub, MeshValidator, AssetPanel)
- [x] Phase 3: Selection & Interaction (gizmos, Outliner, ContextMenu, Properties transform)
- [x] Phase 4: Shader System (full ShaderLibrary, ShaderPanel, UV overrides, swatches)
- [x] Phase 5: Print Pipeline (PrintManager, PrintPanel, OBJ+MTL export, bed preview)
- [x] Phase 6: Persistence & Polish (full save/load, autosave, ghost/relink, smart replace)
  — code + headless tests complete (49/49). **Live Chrome milestone NOT yet
  demonstrated** (closed 2026-05-17 on user instruction, human tester
  unavailable). First task next session: run the deferred STEP 0/STEP 1
  Chrome verification in PHASE_HANDOFF.md before any new feature work.
- [x] Phase 7 prep (2026-05-18): printer profile config, split-on-import +
  sourceGroupId, group-aware validator, Properties shader-slot 2-button +
  modal picker, printPreview default ON, edge 1px overlay-skip.
  See memory note `phase7_split_validation_ui.md`.
- [x] Phase 7: Mimaki output — 3MF Materials Extension texture export +
  import round-trip in `_build3MFModelMaterialsExt` and `ThreeMFLoader.js`.
  Code + headless tests complete (78/78). **Live Chrome milestone NOT yet
  demonstrated** (closed 2026-05-18, human tester unavailable). First task
  next session: run the deferred STEP 0/STEP 1/STEP 2 Chrome verification in
  PHASE_HANDOFF.md (Phase 6 + Phase 7 round-trip in a Mimaki slicer) before
  any new work. See memory note `phase7_close.md`.
- [x] Post-Phase-7 polish wave (2026-05-18, still LIVE-CHROME-UNVERIFIED):
  filename system (unique names + ratio suffix + save-picker + inline
  rename), OBJ solid-colour PNG synthesis (4×4 RGBA, dedup by RRGGBBAA,
  α dual-written to PNG + MTL `d`), Properties ↧ copy-from-active buttons
  on Transform / Shader / UV Override sections. 95/95 headless green
  (export 47, persistence 18, split-on-import 5, state-shape 10,
  threemf-materials-ext 6, validator 4, validator-group 5). See memory
  notes `export_filename_system.md`, `obj_solid_png_synthesis.md`,
  `copy_from_active_shipped.md`.

## Coding conventions
- ES modules. Named exports preferred.
- Functions over classes, except Commands and shader entries.
- JSDoc only on public API functions.
- No console.log in committed code (console.error for real errors only).
- No `// TODO` left in committed code.
- Constants at top of file, UPPER_SNAKE_CASE.
- All async UI entry points wrapped in safeAsync (BLUEPRINT §14.1).

## File layout (target — see BLUEPRINT §0.3 for full list)
- index.html, main.js
- config/{swatches,scale-presets,bed-presets}.json — editable data,
  imported via `with { type: 'json' }`; tune without touching code
- styles/{tokens,layout,components}.css
- core/{events,StateManager,HistoryManager,InputManager,SceneManager,
  AssetLoader,ShaderLibrary,MeshValidator,PersistenceManager,
  PrintManager,ThreeMFLoader,Icons}.js
- ui/{Outliner,PropertiesPanel,ShaderPanel,AssetPanel,ContextMenu,
  PrintPanel,StatusBar,Toast,Modal}.js

## Definition of done per phase
Each phase has a Milestone in BLUEPRINT §15. The phase is not done until
that milestone is demonstrably working in Chrome. Show me how to verify it.

## Phase handoff (do this every time a phase closes)
When the user has confirmed a phase milestone works, before you stop:
1. Flip the phase's checkbox in this file to `[x]`.
2. Rewrite `PHASE_HANDOFF.md` at the repo root. It is the ONLY pickup prompt
   for the next clear session — make it self-contained:
   - Which phase just closed + a 1-paragraph summary of what works.
   - Concrete deferred items / known scope cuts the user accepted.
   - Design decisions locked in this phase (link to memory notes).
   - Which phase is next, its BLUEPRINT §15 deliverables + milestone verbatim.
   - A STEP 0 / STEP 1 instruction block in the same style the user gave
     when starting Phase 3 (verify previous phase firstgi, then build).
3. Update / add memory notes for anything durable that doesn't already have
   one (design decisions, deferred features).
4. Commit only when the user asks you to.

`PHASE_HANDOFF.md` is a rolling document — overwrite it each phase. Old
phase docs live in `BLUEPRINT.md §15` (build phase history) and in memory
notes, not in stale handoff files.