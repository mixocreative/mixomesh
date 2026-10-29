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
| PE.1 | done | geocore 6ea602d | S:\ai\mixo-geocore: 51 engine commits kept (filter-branch on scratch clone, = mixoDental count) + scaffold; cargo test ok, wasm build both pkgs, smoke engine 9; GitHub mixocreative/mixo-geocore PRIVATE, empty (verified), remote added, not pushed. Goldens vitest waits for PE.2 (imports app code). |
| PE.2 | done | geocore 006c8dc, mixomesh 2488894 | geocore: host/ + editing/ (ViewportPort: size, screenToRay, worldToScreen, pick, brushView; planAddTip; arrange), D22 lint + test, 725 tests incl. 16 goldens byte-identical to mixoDental (main re-ran). mixomesh: vendor/mixo-geocore/{host,editing} (--packages-only), src/support-engine = loadGeometry.js + meshWorker.entry.ts + progressLabel.ts; 7 strings → PROGRESS_STAGE codes + locale keys (Gemini). Follow-ups: command labels / StatusMessage in editing/commands.ts, status.ts still English-as-key (→ P3.4 maps codes); dropped tests to recover in P3: selection, pickIndexes, transformParity (three.js), reducer-dependent landing/unitSupports cases. |
| PE.3 | done (local) | geocore a1fa01f | ci.yml + release.yml (actions SHA-pinned, gh release create), scripts/assemble-release.mjs (4 tgz + SHA256SUMS verified, tag must equal engine_version), scripts/ci-local.mjs passes all CI steps (725 tests). First real CI run + release only after push (P9.3). |
| PE.4 | done | e7ee08d | public/vendor/mixo-geocore + vendor/mixo-geocore/{host,editing}; vendor-geometry --from / --release v<N> (gh, SHA256SUMS) / --check (every file vs SOURCE.json, VERSION = engine_version = HOST); fake-release tests (good, tampered, version mismatch); geocore assemble-release output unpacks + passes; npm test, lint, typecheck, i18n, build, test:browser, test:electron green. Wasm bytes now from geocore build (goldens pass there). |
| PE.5 | done (partial) | mixosupports 6dd8011, c3281b2 | Engine vendored, crates/ + Rust build/CI gone (no cargo for dev/build/test), 23 modules redirected, three.js ViewportPort (+4 tests, not wired yet). Tests 1211→1215, walk 112/112 before+after, 34 headless exports incl. dental reference identical; walk supports.stl differed once (drag-over pointer timing), identical on rerun. ~25 dental-aware generic modules still local → PE.5b. |
| PE.5b | done | geocore 476ae5c, mixosupports 806aaee, mixomesh bad54a8 | host/dental/ (11 dental analysis modules, placement, legacyArea, tuning, alignerProfiles, label, generated profileFiles.ts checked vs engine JSON); editing/modes.ts extension points (registerEditMode, registerCommands, registerStepHints + type augmentation ExtraEditModes/Tools/...); engine ABI unchanged (v9). mixosupports: 83 local modules deleted, keeps src/dental/editingMode.ts + engineSource.ts + meshWorker.entry.ts; three.js ViewportPort wired; scripts/check-no-duplicates.mjs (182 vs 94, planted copy caught). Tests: geocore 742 vitest + 238 cargo; mixosupports 1215→852 (deleted tests duplicated geocore); mixomesh 1070+106. Exports 38/38 hashes identical, walk 112/112 twice. Note: agent ran one `git checkout HEAD -- <its own edited file>` in mixosupports (D1 breach, no other agent there, no harm). Behaviour: structure-fallback flag now only on dental jobs (only dental review reads it). |
| PE.6 | done except folder | geocore e639040, mixomesh 50bfbb7 + vendor refresh, mixodental (amended; see git log -3) | GitHub mixocreative/mixo-supports → mixocreative/mixodental (remote updated); Pages base /mixodental/ (vite + docs; confirm on first deploy after push); package name, .mixodental project extension, localStorage key, header app value, BrandLogo ("Dental" live text + TODO outline glyphs); memory copied to S--ai-mixodental; vendored files redone via vendor script (--check + geometry-engine test pass). Tests: mixodental 852 + build + walk 112; geocore 742; mixomesh 1070. Agent corrupted reference-aligner.stl by bulk replace → restored + re-tested. BLOCKED: local folder rename S:\ai\mixosupports → S:\ai\mixodental (cwd held by a Codex session: node_repl, mcp-for-blender, python; and Ollama app/serve) → owner closes them, then main renames + restarts graphify watcher. Leftover comments "mixosupports" in mixomesh src/kit/styles/*.css, src/supports/commands/AddSupportCommand.ts, RegenerateRekeyCommand.ts (cleanup in P9.1). |
| PW.1 | todo | | Cults3D web publish via relay; needs owner Cloudflare + Cults key |
| PD.1 | done | mixoDental 26f696f | Permitted area vermilion #E83F25, outside-area overhang low points blue #1E50A2 (generic_place islands = lowest vertex per downward region; permitted faces from dental_policy; disc via brush-stamp rule; src/dental/areaRisk.ts, no geometry math), listed with Show me; contour line ink. 857 vitest, build, walk 113/113 (new check u10c) ON ENGINE 10; reference aligner: 4 blue spots at default area; screenshot .tmp/pd1/step2-area.png checked by main. Exports identical with/without change (dental ones match PE.5 baseline; generic differ only by engine 10, expected). Risk list capped at 2 visible rows. |
| PW.2 | done | f1af56e | Upgraded existing PWA: SW cache per build hash, waiting worker + update toast (en/ja/zh-Hant, Gemini), file_handlers .stl .3mf .obj .glb .gltf .mixo, launchQueue -> same runner as desktop --open; browser-pwa-smoke: SW controlling, offline reload boots, launchQueue file opens; CSP unchanged; no SW under file:// (test). Only on real Pages: install prompt, Windows file association, real launchQueue, update toast on 2nd deploy (P9.3 checklist). |
| PW.2b | done | 0c9009e | SW prefetch-vendor on idle (not saveData, not file://, not dev): 10 engine files, 2.76 MB; cache id hashes engine list; pwa smoke: all engines served from cache offline. |
| P2.1 | done | da6470a, d5d2f66 | src/supports/frame.ts: Babylon (x,y,z) BU ↔ engine (x,y,−z)·1000 mm (BU_TO_MM, ExportContext.js:37); winding swap only for CW-front meshes (same rule as PrintSpace.printIndices — plan text corrected by this); engine copy welded + snapped to 1 µm grid (float noise gave 48 vs 62 tips). cube-overhang 62 = golden (ids match); seam cube 86 tips = plain cube (110 + 40 false edges without weld); trimesh support volume +1021 mm³, 90 closed parts outward; cull on/off + inverted control screenshots .tmp/p21 checked by main. D20 verified. Gates green. Open → P3: lift/plate (decision recorded in plan P3 contract), placement on main thread (worker protocol lacks placement task → geocore host, after PE.5b), PNG render must hide support layer (P3.3), validator says seam-textured closed cube "not watertight" (existing validator issue → investigate in P3.3/P9). Trigger: window.__mxSupportSpike() (dev). |
| P2.2 | done | c64eeb2 | tests/browser-support-engine-smoke.mjs dev / --preview / --electron all PASS: engine 9, 62 tips, no console/CSP errors (test:supports-engine in test:all). Fix: Electron gave 54 tips from float32 world noise → toLocal snaps to 1 µm (engine-side fix added to P5.14). Production probe hook window.__mxSupportEngineProbe (lazy, inert). Electron mode ignores one known sandboxed_renderer debugger message (1/6 runs) but asserts electronAPI. **Checkpoint 2** evidence = P2.1 + P2.2 rows. |
| P3.1 | done | caaa122 | src/supports/model.ts (object.supports on logical lead: settings, deleted, manual, overrides, stamps base64 >10k, sourceHash, pose, placed, revision, stale), runtime caches supportCache.ts; 9 commands (AddSupport+snap, DeleteSupports, StampStroke, Set/ResetOverride, ChangeSettings, ApplyPreset, LiftForSupports, RegenerateRekey) + commitSupportEdits batch; stale: rotate/scale → pose, repair/ratio bake/refinement/relink → geometry, translate never, derived so undo clears. 1070 node + 106 vitest, lint, typecheck, i18n (957), build, test:browser green. Open → P3.2: batch loses supportsCommand marker (mode-scoped undo must look inside batches); → P3.5/P4.1: rebuild placement after project load before Add can snap; "remove all supports → drop to bed" command missing; → P3.3: multi-part hash assumes parts fixed relative to lead. |
| P3.2 | done | 1906e11 | src/supports/SupportMode.ts (enter/exit/toggle/escape, addEscapeHook selection|tool, onChange), SupportModeUI.tsx (header button, "Support Mode — N objects", Done, Shift+S); isolation = Babylon layer mask 0x10000000 (not visibility); InputManager sticky mode + HistoryManager.setScope (mode-scoped undo; BatchCommand.supportsCommand getter fixes P3.1 batch issue); SUPPORT_MODE_CHANGED event; exits on new/load project or losing targets. tests/browser-support-mode-smoke.mjs (test:support-mode) PASS incl. save+export with all objects; 10 vitest; screenshot .tmp/p32 checked by main. Open: renders during mode omit masked objects → rule sent to P3.3 (renders ignore mask, exclude support layers); entering blocked in phone read-only viewer (intended). |
| P3.3 | done | bc5d1fc | BabylonViewportPort (+vitest), layers (supportMeshLayer, pointerLayers ghost/remove ring/brush ring, zoneOverlay stamped tris only, materials shared per part kind), one predicate isSupportLayerMesh (metadata tag, single registered root) used by WorldExtents, TriangleCount, MeshStats, MeshValidator, SelectionOutline, thumbnails, BoxSelect, export units; PNG/video hide layers and ignore isolation mask (seeIsolatedObjects). Smoke (test:support-layers): 62 tips, engine pick hits own tip 53–54/62 (rest occluded), brush ring 0 px error, PNG + STL hash identical with/without layers, render in mode == outside. Perf 1M (swiftshader): cpuFrameMs 2.91 with 971 tips / 208k tris; generation 15.1 s (watch in P3.5/P8). Weak: BoxSelect comparison empty both ways. Pre-existing: capturePng includes gizmo + outline. Zone overlay does not refine coarse faces (P5). |
| P3.4 | done | 4c6b603 | src/panels/supports/: SupportPanel (presets, tip/neck/pillar/foot/lift/preview, settingLimits, preset→Custom flip, per-support overrides + Reset + Select customised + (mixed)), EditBar (Add|Select, Click|Drag over 8–80 px, Add|Remove, click reach, engaged-tool sentence), ZonesBar (Paint|Erase, 2 mm), ProblemList, ViewToggles, GenerateRow; session store runs shared reducer, Esc hooks, A/S/P/E keys. 173 unit + 1070 node, i18n, build, test:support-mode green. Screenshot .tmp/p34 checked by main (style OK). Seams → P3.5: supportUi.ts handlers (generate, cancelJob, showProblem, setBottomView, fitView) + job/problems state; lift change must re-run LiftForSupports; layers must read session store (brush ring, ghost tip); showProblem moves camera; shared StatusMessage/command labels still unmapped; multi-object: settings apply to one picked target → needs visible target picker. ja/zh-Hant via Gemini default model (Pro quota out). |
| P3.5 | done (partial) | ff32c75 | Wired: Generate (+lift) → debounced latest-only scheduler (src/supports/live/jobScheduler.ts), analysis worker (placement/check) + mesh worker, stale results dropped, lift change = one undo step, Remove all + Drop to bed, Show/Fix, Bottom/Fit view, problem list greying, verdict line, object picker + Apply to all, gestures via @mixo-geocore/editing, 29 keys en/ja/zh-Hant. RTX 3090: cube 0.34–0.88 s 62 tips clear; 1M 14.3–16.6 s (placement ~10 s, build ~4 s) 971 tips; 10 rapid changes → 1 job/1 result; longest main-thread task 80 ms. Screens .tmp/p35. Gaps → P3.6: Electron run of the new analysis worker (D23), stale-on-entry smoke, hand-added support before first Generate draws nothing (UX bug), Fix flow only unit-tested, 20 s respawn only unit-tested. → P5.2: generic repair budget + brace-pruned flag need geocore change. → P8: 1M placement ~10 s is the top WASM target. INCIDENT: agent ran `taskkill /IM chrome.exe` (may have closed owner's Chrome) → rule D3b added. |
| P3.6 | done | 776f463 | tests/browser-supports-walk.mjs (test:supports-walk, 48 checks, torus 110 tips): a1–a5, c, d (drawn == cache; export compare waits P4.2), e, f1–f4, g (CPU ×4) all pass; re-run by main on engine 10: 48/48 green. Gaps closed: workers under dev/preview/Electron (test:support-workers in test:all); stale-on-entry regenerate keeps manual support; BUG fixed: Add before first Generate (engine loads on mode entry, first Add starts build); BUG fixed: delete-all left stale drawing/raft (empty build now clears + re-checks); Show/Fix end to end; 20 s respawn fired at 19.4 s (inert test hook). Also fixed: Delete key in mode; click-through on non-taking supports. **Checkpoint 3** (Support Mode UX) evidence = P3.1–P3.6 rows + .tmp/p32, p34, p35, p36 screenshots. |
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
| P5.13 | done | — | Checked 2026-10-29 by main: S:\ai\mixomesh\port\ does not exist and mixoDental has no port\ folder → nothing handed over; the generic UI is still live in mixoDental (read it there). |
| P5.14 | done | geocore 2dae014 + 6bf349a, mixoDental 5d205c5, mixomesh ddd35d9 | ENGINE 10. core/crease.rs shared by generic placement + dental hard edges: 1 µm snap + weld, geodesic inset (thin facets no longer drop samples), near-planar patches (10°) with max bevel width W (scatterMaxBevelWidth, default 2.5 mm, dental 2.0; 8th generic_place value, 7-value calls still work). Probe re-run by main on engine 10: bevel r1/r2 edge points 0→14 (sharp 19 incl. 5 remesh island points; edge supports equal), rounded V ridge 0→9, split == welded (39/9 and 32/9), noise identical. W tests: 1/2 mm bevels detected, 10 mm fillet not, spheres none, 0.02 mm jitter none. Goldens re-baselined with reasons: cube-overhang 62→70 (corner samples no longer dropped), knot 150→152, thin-slab points moved (snap reseeds), v-ridge +2 edge. Dental chains 110.19/56.10, dental exports byte-identical; 32 generic exports changed (intended). Walk recheck closed by PD.1: mixoDental walk 113/113 on engine 10. |
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
