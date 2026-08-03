# MIXOMESH — Project Context

> **Runtime direction (2026-06-17):** moving toward ONE codebase serving a Web
> build + a Windows Electron desktop build via a capability-tiered
> `StorageAdapter` (opaque refs; `.mixo` = interop contract). Design:
> `docs/adr/0001-storage-adapter-web-electron.md`. In-progress resume state:
> `HANDOFF.md` (read first when continuing that work). macOS deferred.

## What this is
Browser-based 3D model assembly tool for **full-color 3D printing**.

- **Primary target: Mimaki UV-inkjet color printers** (3DUJ-553 default,
  3DUJ-2207 + variants). These consume textured 3MF via the Materials
  Extension OR OBJ+MTL+PNG. Continuous-tone textures preserved end-to-end
  — Mimaki paints ~10M colors per surface, *not* one solid color per part.
- **Secondary target: filament multi-color printers** (Bambu X1C, Prusa XL,
  OrcaSlicer/PrusaSlicer pipeline). 3MF with `<colorgroup>` + per-object
  `pindex` for filament zone assignment. One solid color per part.

Printer/build-volume reference data is data-driven via
`src/config/printers.json` (display name, vendor, and bed dimensions only).
Adding a build-volume preset = adding a JSON row, not editing code. Export
format remains an explicit OBJ / 3MF / STL choice and is independent of the
selected printer.

Babylon.js, Chrome/Edge only. The supported runtime is Vite + TypeScript:
`index.html` loads `src/app/boot.ts`, which builds `window.BABYLON` from
pinned Babylon npm packages and starts `src/app/main.ts`.

## Authoritative spec — fail-safe rebuild contract
`BLUEPRINT.md` is the **canonical rebuild spec**. If the entire `src/core/` and
`src/ui/` folders were deleted tomorrow, the project must be reconstructible from
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
3. All inter-module communication uses typed events from `src/core/events.js`.
   No raw event-name strings in calling code.
4. Use Babylon.js built-ins per BLUEPRINT §0.4 "Babylon-First Rule" before
   writing custom geometry/scene/IO code.
5. Chrome/Edge only. Single startup check halts on other browsers.
   No Firefox/Safari fallback paths.
6. Export format is **button-driven**, not printer-driven. The selected printer
   is a build-volume reference only and must not hide, switch, or block OBJ /
   3MF / STL. Export content selects the representation: textured 3MF uses the
   Materials Extension; solid 3MF uses `<colorgroup>`; OBJ uses MTL + PNG when
   textures exist. Never collapse texture data merely because of a printer
   preset.
7. One-mesh-one-shader is an enforced invariant. AssetLoader splits any
   `MultiMaterial` mesh into N single-material siblings at import time and
   stamps `sourceGroupId` on the SceneObject state entries so validator +
   exporter can re-union the part.
8. Module size soft targets in BLUEPRINT §0.5. Split if exceeded by 1.5×.

## Tech stack
- Runtime: Vite + TypeScript with pinned Babylon npm packages. `src/app/boot.ts`
  attaches the npm Babylon namespace to `window.BABYLON` for the existing JS
  modules under `src/`.
- Dependency bootstrap is npm-first. Use `node scripts/install-deps.mjs` so
  installs use repo-local `.tmp/` and `.npm-cache/`; Bun is optional tooling,
  not a project dependency.
- Inline SVG icon registry in `src/core/Icons.js` (paths copied from Lucide
  as each phase needs them). The npm `lucide` package is abandoned at
  v1.14.0 with an incompatible API — don't try to import it.
- JSZip is the npm package used by the Vite runtime and Node tests.

## Dev workflow
- After dependencies install, run `npm run dev`, then
  open http://127.0.0.1:5173/index.html.
- I'll tell you what I see; you debug from there.
- Open DevTools console errors are real — never tell me to "ignore harmless warnings."

## Build status
- Current baseline: Vite-only runtime. `index.html` loads `src/app/boot.ts`
  and `src/app/main.ts`; app code/data live under `src/`.
- Legacy root runtime removed: `core/`, `ui/`, `config/`, `styles/`,
  `main.js`, `index.vite.html`, and `scripts/serve.mjs`.
- Verification baseline: bare `npm run lint`, `npm run typecheck`,
  `npm run build`, `npm run test`, `npm run test:browser`, and
  `npm run test:export` pass.
  Do not hard-code total test counts in instructions; counts drift as coverage
  changes.
- Historical build notes live in `BUILDLOG.md`; `BLUEPRINT.md §15` keeps the
  current baseline, locked decisions, and accepted scope cuts.

## Coding conventions
- ES modules. Named exports preferred.
- Functions over classes, except Commands and shader entries.
- JSDoc only on public API functions.
- No console.log in committed code (console.error for real errors only).
- No `// TODO` left in committed code.
- Constants at top of file, UPPER_SNAKE_CASE.
- All async UI entry points wrapped in safeAsync (BLUEPRINT §14.1).

## File layout (target — see BLUEPRINT §0.3 for full list)
- index.html
- src/config/{printers,swatches,scale-presets}.json — editable data,
  imported via `with { type: 'json' }`; tune without touching code
- src/styles/{tokens,layout,components}.css
- src/core/{events,StateManager,HistoryManager,InputManager,SceneManager,
  AssetLoader,ShaderLibrary,MeshValidator,PersistenceManager,
  PrintManager,ThreeMFLoader,Icons}.js
- src/ui/{Outliner,PropertiesPanel,ShaderPanel,AssetPanel,ContextMenu,
  PrintPanel,StatusBar,Toast,Modal}.js

## Definition of done
Use the verification commands above for the current baseline. Add focused
Chrome or slicer checks only when a change affects browser-only or external
consumer behaviour that the automated tests cannot cover.
