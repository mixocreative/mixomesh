# Ledger: React UI, WASM geometry, Support Mode

Plan: `docs/plans/2026-10-29-react-wasm-supports.md` (rev 2, reviewed by Fable + egm design /
readiness / zoom-out). Replaces `docs/handoff/support-port.md` (A1 done = engine 9 vendored,
commit bb55c8e). Only the main session writes this file (D3).

## Resume

1. Read the plan section 0 (directives) and this ledger.
2. Find the first row that is not `done`; its "next" column is the exact next step.
3. Refresh the cross-repo graph (D4), then dispatch the worker named in plan section 4.

## Baselines

P0.3b (de9726a), cpuFrameMs mean/p95 ms, median of 5: pillow-1M orbit 0.9/1.2 gizmo 1.0/1.3; pillow-5M orbit 0.9/1.1 gizmo 0.9/1.2; textured-2M (4096²) orbit 1.0/1.3 gizmo 1.0/1.3; reactCommitMs 0 (no roots yet). Reproduce: `node scripts/heavy-mesh/generate.mjs --sizes 1 --3mf 0 --ascii 0 --glb 2` then `node scripts/heavy-mesh/measure.mjs --files pillow-1M.stl,pillow-5M.stl,pillow-textured-2M.glb --runs 5`.

P0.3 (f2a283b): frame intervals at vsync cap 16.7 ms for 1M and 5M pillows (orbit and gizmo drag) = "holds 60 fps". Real gate metric (CPU frame ms) comes with P0.6. Reproduce: `node scripts/heavy-mesh/generate.mjs --sizes 1,5 --3mf 0 --ascii 0` then `node scripts/heavy-mesh/measure.mjs --files pillow-1M.stl,pillow-5M.stl --runs 5`.

## Tasks

| Task | Status | Commit | Verified / next |
|---|---|---|---|
| P0.0 | done 2026-10-29 | (this commit) | ledger created from plan rev 2 |
| P0.1 | done | f5020db | node 1086 + vitest green, build CSP byte-identical, lint/typecheck clean, test:browser + test:electron PASS, dev CSP allows refresh preamble (hash). vitest = 2 projects (.ts node, .tsx jsdom). |
| P0.2 | done | 48df345 | mountPanel/useStore/useCommand/useT + error boundary; 5 vitest (selective re-render, one history step, batch = one undo, unmount leak-free, boundary reports). |
| P0.3 | done (partial) | f2a283b | gizmoDragFrameMs added; median of 5: pillow-1M orbit 16.7/17.1, gizmo 16.7/17.2; pillow-5M orbit 16.7/17.0, gizmo 16.7/17.2 (mean/p95 ms). All at the 60 Hz vsync cap: cannot show a 5% regression. No textured fixture (generate.mjs has none). P0.6 adds CPU frame time (Babylon EngineInstrumentation frameTimeCounter) + React commit time as the gate, and a 4096² textured fixture. |
| P0.4a | done | f7fa058..a4a506a | 8 kit fields, 29 vitest, gallery kit.html (dev only, not in build), screenshot .tmp/kit-gallery.png checked by main (mixo-app-style correct); CSS = unchanged copies of mixo-app-style bbf53ee scoped under .mx-kit by generated kit.scoped.css (freshness test). Repo typecheck + lint clean after P1.1+P0.4a. |
| P0.4b | done | 9a09573 | Section (tri-state, header buttons stopPropagation), FieldRow, Modal (trap/Esc/focus return), Toast(+Provider/Host), ProgressRow, KeyCaps, Notice; 57 vitest; screenshot .tmp/kit-gallery-containers.png checked by main. Agent used Playwright from another project (scratch script only): later agents use scripts/ui-screenshot.mjs. |
| P0.3b | done | de9726a | cpuFrameMs (begin→end frame) + reactCommitMs (dev-only Profiler in mountPanel, checked DEV-gated). Gate = mean +max(0.1 ms,10%), median of 5. 4096² textured 2M GLB fixture added. |
| P0.5 | done | 4939cb0 | docs/ui.md (203 lines): layers, add panel, add kit control, live vs commit, strings, checks + perf gate; paths grep-verified. useStore has no production caller yet (doc says so). |
| P0.6 | done | 5e87036 (+34ffa3e) | StatsHud + TransformSheet in React (kit), "original" style removed (grep proof), node 1066 + vitest 67, build, test:browser, test:ui-style green. Perf gate PASS (cpuFrameMs mean ≤ baseline+max(0.1ms,10%) on 3 fixtures), 0 React commits during gizmo drag. Screenshot .tmp/p06-shots/ui-layout.png checked (Apply button oversized: polish later). Main fixed: probe lint, hint via Gemini. Open: i18n:check red on 7 hardcoded strings in src/support-engine (P1.1) → fixed in PE.2 (geocore returns codes, app translates). **Checkpoint 1** evidence = this row. |
| P1.1 | done | 624a34b | 66 files src/support-engine/ (PORTED.md); no dental; geometryClient rewritten on loadGeometryEngine (configureGeometry(glueUrl)); lint + npm test green; tsc clean in support-engine. ABI-bound parts move to mixo-geocore/host in PE.2. |
| P1.2 | retired → PE.2 | | tests + goldens run in mixo-geocore |
| PE.1 | done | geocore 6ea602d | S:\ai\mixo-geocore: 51 engine commits kept (filter-branch on scratch clone, = mixosupports count) + scaffold; cargo test ok, wasm build both pkgs, smoke engine 9; GitHub mixocreative/mixo-geocore PRIVATE, empty (verified), remote added, not pushed. Goldens vitest waits for PE.2 (imports app code). |
| PE.2 | todo | | |
| PE.3 | todo | | |
| PE.4 | todo | | |
| PE.5 | todo | | owner: mixosupports switches this mission |
| PE.6 | todo | | owner: rename to mixoDental (not distributed) |
| P2.1 | todo | | after PE.4 |
| P2.2 | todo | | |
| P3.1 | todo | | |
| P3.2 | todo | | |
| P3.3 | todo | | |
| P3.4 | todo | | |
| P3.5 | todo | | |
| P3.6 | todo | | |
| P4.1 | todo | | |
| P4.2 | todo | | |
| P4.3 | todo | | |
| P5.1 | todo | | |
| P5.2 | todo | | |
| P5.3 | todo | | |
| P5.4 | todo | | |
| P5.5 | todo | | |
| P5.6 | todo | | |
| P5.7 | todo | | |
| P5.8 | todo | | |
| P5.9 | todo | | |
| P5.10 | todo | | |
| P5.11 | todo | | |
| P5.12 | todo | | |
| P5.13 | todo | | |
| P5.14 | todo | | bevel-robust edge detection (owner question) |
| P6.1 | todo | | |
| P6.2 | todo | | |
| P7.last | todo | | |
| P8.1 | todo | | |
| P8.2 | todo | | |
| P8.3 | todo | | |
| P8.4 | todo | | |
| P9.1 | todo | | |
| P9.2 | todo | | |
| P9.3 | todo | | |
| P7 Toast | todo | | |
| P7 Modal | todo | | |
| P7 ProgressOverlay | todo | | |
| P7 JobActivity | todo | | |
| P7 BootBanner | todo | | |
| P7 StatusBar | todo | | |
| P7 ViewportEmptyState | todo | | |
| P7 ViewportToggles | todo | | |
| P7 ViewportToolbar | todo | | |
| P7 NavCube | todo | | |
| P7 MeshStats | todo | | |
| P7 LocaleSwitcher | todo | | |
| P7 ScopeBreadcrumb | todo | | |
| P7 CursorPanel | todo | | |
| P7 ContextMenu | todo | | |
| P7 ProjectMenu | todo | | |
| P7 SourcesModal | todo | | |
| P7 ImportError | todo | | |
| P7 Onboarding | todo | | |
| P7 RepairFeedback | todo | | |
| P7 CopyPaste | todo | | |
| P7 FindMoved | todo | | |
| P7 ViewportDrop | todo | | |
| P7 SliceConnectorSession | todo | | |
| P7 ViewerMode | todo | | |
| P7 Outliner | todo | | |
| P7 AssetPanel | todo | | |
| P7 ShaderPanel | todo | | |
| P7 ScenePanel | todo | | |
| P7 RefinementSection | todo | | |
| P7 ReadinessStrip | todo | | |
| P7 PrintSizes | todo | | |
| P7 PrinterTab | todo | | |
| P7 ExportTab | todo | | |
| P7 CostBlock | todo | | |
| P7 PublishModel | todo | | |
| P7 PublishTab | todo | | |
| P7 PrintPanel | todo | | |
| P7 PropertiesPanel | todo | | |
| P7 Workspace | todo | | |
| P7 PanelSheets | todo | | |
| P7 RenderFrame | todo | | |
| P7 AppShell | todo | | |
