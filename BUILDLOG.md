# MIXOMESH Build Log

Append-only build history, split out of Blueprint.md PART 15 (arch review
A10) so the canonical spec stops accumulating stale narrative. Newest
entries go at the bottom of the relevant section.

### Completed Phases

- **Phase 1 — Foundation:** events, state/history/input managers, scene bootstrap, icon registry, toast/status UI, layout shell. Milestone: empty viewport, MMB orbit, axes + grid, status bar live, `Ctrl+Z` registered.
- **Phase 2 — Asset Pipeline:** AssetLoader, ShaderLibrary registration stub, MeshValidator, AssetPanel. Milestone: mount directory, drop GLB, see thumbnail, get validation toast.
- **Phase 3 — Selection & Interaction:** selection model, Babylon gizmos, Outliner, ContextMenu, Properties transforms/source unit, viewport shortcuts. Milestone: click-select, modal transform with snapping, grouping, frame, undo.
- **Phase 4 — Shader System (closed 2026-05-14):** full ShaderLibrary, ShaderPanel, shader/UV Properties sections, merge-strategy modal, imported texture readback, right-panel splitter, LMB horizontal-plane drag. Deferred at close: copy-from-active, user-swatch persistence, multi-material-per-mesh, sub-section collapse persistence.
- **Phase 5 — Print Pipeline (closed and Chrome-verified 2026-05-15):** PrintManager, PrintPanel, pre-export validation gate, bed preview, OBJ+MTL export, STL/3MF groundwork, collections, working-ratio re-bake, transform baking, scale lock, viewport toolbar, nav cube, CAD mouse remap. Deferred at close: nav cube corner/edge snaps, deeper camera-follow testing, old v3.1 scalar `scene.gridSize` styling migration.

### Later Build History

- **Persistence & Export Hardening (closed 2026-05-17):** PersistenceManager save/open/new/recent/autosave/relink, embedded `.mixo` asset bytes + live relink tiers, ghost UI, Smart Replace, Transform Swab, import-transform normalization, structured export pipeline, non-destructive export clone prep, progress overlay, axis/winding switches for 3MF.
- **Mimaki Textured 3MF (closed 2026-05-18):** printer-driven 3MF dispatch, `_build3MFModelMaterialsExt`, 3MF Materials Extension loader path, per-vertex UV emission, OPC texture parts, per-part relationships/content types, `weldSolidOnly`, texture dedup, solid fallback via colorgroup, mixed textured/solid packages.
- **Post-Mimaki polish wave (2026-05-18):** filename system with unique names/ratio suffix/save picker/inline rename, OBJ solid-colour PNG synthesis (4×4 RGBA, dedup by RRGGBBAA, alpha in PNG + MTL `d`), Properties copy-from-active buttons for Transform / Shader / UV Override, split-on-import validation UI refinements.
- **Vite-only cleanup (2026-06-08):** removed the legacy root runtime (`main.js`, `index.vite.html`, root `core/`, `ui/`, `config/`, `styles/`, and `scripts/serve.mjs`). `index.html` is now the Vite shell, app code/data live under `src/`, tests import from `src/`, and the verified command set is `npm run typecheck`, `npm run build`, `npm run test`, `npm run test:browser`.

- **Review remediation wave (2026-06-11):** deep code review (31 findings) + Blueprint architecture review; fixed 4 critical (blank texture export via Promise readPixels, reload texture loss, delete-undo pivot corruption, dead group validation) + safety/hygiene bundles; texture identity contract (10b, .mixo 3.2), position-based dirty, validation result cache (A6) with Outliner badges + export warning gate; module split pass (commands/, assets/, print/ writers, scene/ outline+bed); functional Chrome export smoke (`npm run test:export`); TS runtime mirrors deleted (A7); autosave embed-skip (A9). 19 headless test files.
