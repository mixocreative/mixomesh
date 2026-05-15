# MIXOMESH — Project Context

## What this is
Browser-based 3D model assembly tool for hobbyist colored 3D printing.
Babylon.js, vanilla JS, no build step, Chrome/Edge only.

## Authoritative spec
`BLUEPRINT.md` in this directory. Re-read the relevant section before
writing or modifying any module. Do not deviate from the contracts there.

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
6. OBJ + MTL is the primary export format (colored 3D printing).
7. Module size soft targets in BLUEPRINT §0.5. Split if exceeded by 1.5×.

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
- [ ] Phase 6: Persistence & Polish (full save/load, autosave, ghost/relink, smart replace)

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
- styles/{tokens,layout,components}.css
- core/{events,StateManager,HistoryManager,InputManager,SceneManager,
  AssetLoader,ShaderLibrary,MeshValidator,PersistenceManager,
  PrintManager,Icons}.js
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