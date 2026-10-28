# Support generation port: mixosupports to mixomesh

For a future Claude session in the mixomesh repo. All paths below are in `S:\ai\mixosupports` unless stated. Each step in section 8 needs its own spec and review before it is built.

## 1. Decisions already made (owner and lead)

- mixomesh becomes the generic 3D tool with auto supports. mixosupports becomes dental-only.
- Electron stays (automation server, batch jobs, 4 GB heap, file opening, publishing). WASM runs inside it.
- Shared: the Rust/WASM geometry engine, vendored as a built artifact like `manifold.wasm` with a VERSION check at load; the framework-free editing logic; the mixo-app-style tokens. UI components are not shared (mixosupports is React with three.js, mixomesh is Babylon with plain JS).
- Same UX as mixosupports: paint and erase the support area, select by paint, then edit each tip. It works on the models selected in the scene, with no auto-orientation. Keep it simpler.
- Tips preview and export go through the engine. Other geometry moves to WASM only when a benchmark shows at least 2x. Manifold and MeshFix stay.
- Licence: the owner decided (2026-10-29) that the code first modelled on Blender nodes and OpenVDB behaviour is re-implemented far enough to carry no licence issue (mixosupports D23). No audit is needed before porting.

## 2. Generic pipeline (not dental)

Units: mm, Y up. Settings arrive as one flat f64 array (section 3).

**Contact placement** (`crates/geometry-core/src/generic/placement/`, entry `mod.rs`). Automatic contacts on the model. Input: mesh, `scatterSpacing` (2 mm), `scatterAngle` (overhang, 50 deg preset), `scatterRidgeAngle` (45 deg), `reinforceOverhangEdges`, `scatterIslands`. Output: points, normals, a source class and an id. Streams: Poisson points on overhang faces (`poisson.rs`, seeded hash in `random.rs`); island minima merged within spacing (`minima.rs`, `merge.rs`) with vertical necks; edge anchors along boundaries and sharp ridges (`anchors.rs`); legacy ridge points when reinforcing is off (`ridges.rs`). It reproduces a Blender node tree in its stream order: licence-sensitive.

**Policy** (`generic/policy.rs`, contract in `supports/policy.rs`). Produces a `PolicyResult` as data: contacts = automatic, minus deleted ids, minus automatic ones a no-support zone covers, plus manual ones; every face allowed; structures (pillar, tree, brace, roof, cage, raft) as the settings ask. `AreaStamp::resolve` is the one brush-stamp rule: the last stamp covering the point on the same side (normal dot > 0) wins. Zones: `supports/zones.rs`.

**Support build** (`supports/build.rs`, parts in `supports/parts/`). Input: contacts, model, settings, mode (preview or export), label text. Output: closed solids tagged by part and contact id. `column.rs`: tip (round, square, cross; tapered or straight), neck, pillar, foot. `tree.rs` and `autotree.rs` (`autotree_safe.rs` when Safe Distance is non-zero): contacts within Merge Distance (2 to 4 mm) share a junction that lands on the model or drops a trunk. `brace.rs`: cross-bracing between neighbouring columns (angle 45 deg, spacing 2 mm, min height 3 mm). `raft.rs` with `raft_field.rs` and `raft_outline.rs`: floor 1 mm, wall 1.5 mm high and 0.5 mm thick leaning 30 deg, expand 3 mm, with gaps every third segment for drainage. `label.rs`, `font.rs`: embossed letters on a raft-corner pad (5 mm, 0.6 high). Landings use `supports/line_target.rs`: exact surface, then the remesh.

**Repair loop** (`supports/generate/mod.rs`, `repair.rs`). One `generate` call permits contacts (`permit.rs`), builds, checks the finished mesh exactly against the model, then repairs within a bounded budget: switch off a crossing Tree or Brace, re-aim the neck (`reaim.rs`: source normal, then straight down), try alternates, otherwise drop that contact, then a final build. Output: mesh, one verdict (clear, blocked, inconclusive), dropped ids; `timeoutMs` (host: 120 s) yields inconclusive, never clear.

**Safety checks** (`supports/safety/`). `clearance.rs` and `conflicts.rs`: exact support-versus-model intersections, with intentional tip reach proven by `reach.rs`. `births.rs` plus `generate/islands.rs`: finds print islands (downward or sideways births) and proves a chain of built links to the plate.

**Landing remesh** (`supports/remesh/`). Voxel remesh of the model (voxel = max(diagonal/2000, middle diameter); `voxelResolution` 16) from a signed distance (`sdf.rs`), grid (`grid.rs`), leaf merging (`leaf.rs`). It follows OpenVDB behaviour, so it is licence-sensitive.

## 2b. Complete generic feature inventory (port every row; nothing stays behind)

Owner, 2026-10-29: every generic support feature of mixosupports moves to mixomesh, including Roof and Cage. Tick each row off when its mixomesh step is done. Engine paths are under `crates/geometry-core/src/`, host paths under `src/`.

| Feature | Engine | Host logic and UI |
|---|---|---|
| Automatic contact placement (downward faces, islands, overhang edges, ridges) | `generic/placement/` | `supports/genericPlacement.ts`, `genericPolicy.ts` |
| Presets Light / Middle / Heavy / Custom, all limits | `supports/settings/read.rs` | `core/supports/settings.ts`, `components/SettingsPanel.tsx` |
| Contact tip shapes (round, square, cross; tapered, straight; sphere contact), neck, pillar, foot | `supports/parts/column.rs`, `profile.rs`, `landing.rs` | `components/ShapeBand.tsx`, `SettingsPanel.tsx` |
| Per-support overrides (reset, select customised) | `supports/edits.rs` | `editing/shapeEdit.ts` |
| Tree and Auto tree (merge distance, branch descent, safe distance) | `supports/parts/tree.rs`, `autotree.rs`, `autotree_safe.rs` | `SettingsPanel.tsx` |
| Cross-braces (truss: angle, spacing, min height, distance limit), **with brace pruning** (mixosupports B4 / D24): on every build the repair finds each brace segment that crosses the model (exact check on the finished mesh), rebuilds without exactly those segments (keyed by their endpoints on a 0.01 mm grid, up to two passes), and only switches all braces off if one still crosses. Dynamic: recomputed for whatever model, pose and columns the build has. For mixomesh to use it, its policy must give the repair a trial budget (mixosupports' generic policy uses budget 0, which only reports; the dental policy uses 8): set a small budget, at least 3, so pruning and its fallback can run. Fallback code 3 `brace-pruned` with its notice | `supports/parts/brace.rs`, `supports/generate/repair.rs`, `supports/safety/clearance.rs` | `SettingsPanel.tsx`; notice as in `DentalSupports.tsx` |
| Raft (outline, flared wall, drainage gaps) | `supports/parts/raft.rs`, `raft_field.rs`, `raft_outline.rs` | `SettingsPanel.tsx` |
| Object letter label on the raft | `supports/parts/label.rs`, `font.rs`, `labelFont.json` | `SettingsPanel.tsx` |
| **Roof** (multi-storey columns around the raft perimeter, ceiling braces, storey floors) | `supports/parts/roof.rs`, `plan.rs`, `structures.rs` | `core/supports/settings.ts` `ROOF_DEFAULTS` (roofGap, columnCount, columnDiameter, diagonal*, brace*, storey*) |
| **Cage** (rings at a pitch around the model, columns, top gap, side gap) | `supports/parts/roof.rs`, `plan.rs` | `settings.ts` `ROOF_DEFAULTS.CAGE` (cagePitch, cageTopGap, cageRingDiameter, cageSideGap, columnCount, columnDiameter) |
| Landing on the model (exact surface, then remesh) | `supports/line_target.rs`, `supports/remesh/` | `supports/landing.ts` |
| No-support zones (paint / erase) | `supports/zones.rs` | `core/supports/zones.ts`, `components/ZonesBar.tsx` |
| Manual add / remove, select (click, drag over), delete | `supports/edits.rs` | section 5 and 5b |
| Tips-only preview, low-poly preview | `supports/build.rs` | `previewMode`, `lowPolyMode` settings |
| Repair loop and verdict (clear / blocked / inconclusive), timeout | `supports/generate/`, `supports/safety/` | `supports/generateSupports.ts`, `jobRunner.ts` |
| Check for unsupported spots (islands), problem list, Show and Fix | `supports/safety/births.rs`, `generate/islands.rs` | `supports/checkSupports.ts`, `islandProblems.ts`, `omittedProblem.ts`, `components/ProblemList.tsx`, `useFixSpot.ts` |
| Export (active / separate / whole; printable or supports only) and the export gate | (mesh from `generate`, mode 1) | `supports/export.ts`, `exportGate.ts`, `components/useExport.ts` |
| Project save and open with all hand work | — | `components/useProjectFile.ts`, `openProject.ts`, `editing/project.ts` |
| Several objects per plate, each with its own supports | — | `components/ObjectList.tsx`, `supports/unitSupports.ts`, `supportFrame.ts` |
| **Move / rotate gizmo with plane handles** (owner likes it): axis arrows plus small plane squares (XY, YZ, XZ) that drag the selection locked to that plane; rotate rings; orbit off while dragging; one undo step per drag, committed on release | — | `components/ObjectViewport.tsx` `UnitTransformControls` (three-stdlib `TransformControls`, modes translate and rotate). Babylon: `GizmoManager` with `positionGizmoEnabled`, `gizmos.positionGizmo.planarGizmoEnabled = true`, `rotationGizmoEnabled`; commit on `onDragEndObservable` |
| Undo / redo with toasts | — | `editing/session.ts`, `components/UndoToast.tsx` |
| Job progress for long tasks | — | `components/JobActivity.tsx`, `workers/` |
| Heavy-model display decimation | `decimate_display` | viewport |
| Three languages (en, ja, zh-Hant Taiwan wording) | — | `src/i18n.ts` and locale files |
| **Hard-edge finder** (sharp folds by dihedral angle, chains, loop closing) | `dental/topology.rs` (welded edge graph, `Edge`, `components`, `shortest_route`), `dental/contour.rs` (`outer_contour`), `generic/placement/ridges.rs` (`mesh_edges`, `signed_edge_angles`), `generic/placement/anchors.rs` (`edge_anchors`); enclosed-hole finder `dental/opening.rs` | none yet as a tool: see below |

Roof and Cage follow a Blender add-on's multi-storey method: they are in the licence audit (A0) with the other files in section 1. Golden variants `roof` in `src/goldens/__snapshots__/` are their parity fixtures.

**Hard-edge finder as a generic mixomesh tool (owner, 2026-10-29).** The edge logic sits under `dental/`, but nothing in it is dental. Port it as its own engine call and tool, not only inside supports:
1. Weld the mesh and build the edge graph; every edge must have two faces (`topology.rs` `Context`).
2. An edge is hard at angle θ when |n1·n2| ≤ cos θ (the absolute value tolerates locally flipped winding).
3. Group hard edges into connected components; classify each as an open chain (two ends, all others degree 2), a closed loop or branched; measure it in mm (`components`).
4. Optional loop closing: join chain ends by the shortest path over a softer graph (θ = 20°, excluding the chains; Dijkstra on 3D edge length, `shortest_route`), keeping the pairing that gives one simple closed loop (`contour.rs`).
5. Optional enclosed-hole finder: rasterise the mesh along an axis, flood-fill from the border, lift edges near the enclosed hole back to 3D, at two resolutions that must agree (`opening.rs`).

Suggested ABI for mixomesh (to specify there): `hard_edges(model, angle_deg) -> { edges, component per edge, kind per component, length_mm per component }` and `close_loop(model, chain_a, chain_b, soft_angle_deg)`. UI: show the components coloured by length, click to select one, use a selected loop as a support-area seed, a cut line or an export of edges. On the dental reference: θ 60° gives the two longest chains 110.2 mm and 56.1 mm; the 20° joins are 10.55 mm and 40.39 mm.

## 3. Engine structure and ABI

- `crates/geometry-wasm` (wasm-bindgen, `Cargo.toml` pins wasm-bindgen 0.2.129) wraps `crates/geometry-core`. `scripts/build-geometry-wasm.mjs` runs wasm-pack twice: `pkg-node` (target nodejs, feature `test-abi`, for tests) and `pkg-browser` (target web, production ABI only). Vendor `pkg-browser`.
- `GeometrySession` (`crates/geometry-wasm/src/lib.rs`): `new(max_bytes)`, `load_mesh(positions f32, indices u32) -> handle`, `release_mesh`, `load_placed(handle, frame)`, `pick`, `pick_pixels`, `project_brush`, `transform`. Meshes are `u32` handles (`release_mesh`; `free()` results).
- Generic calls (`generic.rs`): `generic_place(model, settings)` returns a `GenericPlacement` (take_positions, normals, sources, ids). `generic_policy(...)` returns a `PolicyHandle`. Edit bookkeeping: `position_ids`, `remap_deleted_ids`, `rekey_hand_work`, `zoned_at`.
- Generate (`safety.rs`): `session.generate(model, ids, contacts, shapes, settings, mode, labelText, zones, policy, timeoutMs, revision, plateY)`. mode 0 preview, 1 export. `contacts` and `shapes` come from `supports/flat.rs` (stride per contact: point, normal, face, origin, landing fields, kind). `revision` is echoed so the host drops stale results. `plateY` is the plate height in the model's frame (0 for a model placed on the plate); a lift change (unit L) keeps the placed model and its caches and moves the plate; island heights come back relative to the plate. Results are `take_*` arrays (positions, indices, tags, dropped, issues, islands, rings) plus status, reason, trials, revision. Reference decoder: `src/supports/generateSupports.ts`.
- Version: `engine_version()` in `crates/geometry-core/src/lib.rs`, re-exported by the wasm crate. `src/workers/geometryVersion.ts` holds `HOST_GEOMETRY_VERSION` (9 at the time of writing) and `assertGeometryVersion`; both change together on any ABI change. mixomesh must check at load and refuse a mismatch.
- Worker protocol: `src/workers/meshProtocol.ts` (tasks `build`, `export`, `forget`; the model is sent once per unit by `sourceToken`, later jobs omit it), `meshWorker.ts`, `meshClient.ts`, `buildSessions.ts` (a persistent build session per unit), `geometryClient.ts`.
- `SupportJob` (`src/core/jobs.ts`): mesh, frame, optional plate, settings, contacts, labelText, mode. `src/supports/jobRunner.ts` `runSupportJob` moves contacts and zones to the build frame, builds the policy, calls `generateSupports`, returns the unit-local mesh.
- Host: `scripts/geometry-wasm-smoke.mjs` (loads `pkg-node`, asserts the version). `scripts/host-example.mjs` (`npm run host-example -- <stl> <out-dir>`) is the reference driver with no React and no import from `src/`: it calls the engine in order, one commented line per call, and writes `supported.stl` and `summary.json`. Its dental calls (`orient_dental`, `propose_dental_region`, `dental_tilt_scan`, `dental_policy`) are not ported. The generic driver is the same shape with `generic_place` and `generic_policy` in their place. Read the section "Driving the engine without the app" in `dentalwork/wasm-geometry-design.md`.
- `generate` takes the unit frame (added with engine_version 7). Automatic tip ids come from unit-local points, so they survive a lift or move.

## 4. Settings

`src/core/supports/settings.ts`. `PresetName` LIGHT, MIDDLE, HEAVY (editing a preset-owned key flips to CUSTOM). Presets (mm, light/middle/heavy): touch 0.5/0.8/1.0, neck 0.3/0.4/0.6, neck length 2/2/3, pillar 0.8/1.2/1.5, merge 2/3/4. Shared: max neck angle 45 deg, base 3 by 1.2 mm, voxel resolution 16. Defaults: point diameter and penetration 0.2 mm, scatter spacing 2, ridge angle 45, lift 5, `eraseRadius` 1.5, `previewMode` FULL or ONLY_TIP. `settingLimits` clamps like the old UI. `SHAPE_KEYS` are the per-support override keys; pillar diameter is object-wide. Rust reads the layout in `supports/settings/read.rs`; the packer is `src/supports/supportBuildWasm.ts`.

## 5. Editing UX (reproduce faithfully)

Framework-free `src/editing/` (copy the logic, not React):
- `session.ts` reducer, `types.ts` (modes `off`, `edit`, `zones`; skip `dental`; tools `add`, `select`; select style `click` or `brush`; brush mode `select` or `unselect`; zone kind `paint` or `erase`), `gesture.ts`, `commands.ts` (typed command registry), `keys.ts` (`keyAction`), `locks.ts`.
- `pick.ts` (click or context click, nearest hit, ignores orbit drags by pointer travel), `stroke.ts` (left press begins; a release anywhere, cancel, blur, or a move with no button held ends once), `selection.ts`, `removal.ts`, `regenerate.ts`.

Behaviour:
- **Zones mode** (support area): a Paint | Erase switch and a brush radius in mm (default 2). Paint marks no-support zones on the model, erase clears. A stroke lays a stamp each half radius of travel (`src/core/supports/zones.ts`). Stamps are unit-local and ordered; the last covering stamp wins. Zoned automatic contacts are dropped, manual ones stay.
- **Edit mode**: tool Add supports: click the model adds a manual contact; right-click or Ctrl+click on a support (or on the model within the click reach, `eraseRadius`) removes it; an Add | Remove switch is the touch path. Tool Select supports: Click picks one; Drag over paints a selection with a screen-space circle (8 to 80 px, default 24); Shift flips Select and Unselect. Delete or Backspace deletes the selection; Esc first clears the selection, then leaves the mode; Ctrl+Z and Ctrl+Shift+Z or Ctrl+Y undo and redo. Editing a tip setting with a selection writes a per-support `ShapeOverride` (`shape.reset`, `shape.selectCustomised`).
- Views: `src/components/EditBar.tsx` (`EditTools`), `ZonesBar.tsx`, `SurfaceBrushBar.tsx`, `src/components/viewport/supportLayers.tsx` (ghost tip at the pointer, remove ring with contacts that would go highlighted, brush ring), `useScreenBrush.ts`, `rustRaycast.ts` (picking through the engine).
- **Surviving regeneration**: contact = automatic minus deleted ids plus manual (`supports/edits.rs` `compose_contacts`). Automatic ids encode position on a 0.01 mm grid, so a deletion keeps hiding the same spot; after regenerating, `rekey_hand_work` moves deletions and overrides to the nearest new contact, and resets them when none is near (`src/editing/regenerate.ts`: kept, moved, reset). Manual contacts are never hidden or moved. Adapter: `src/supports/contactEdits.ts`.
- **Tips-only preview**: `previewMode` ONLY_TIP builds and draws only tips (build.rs `tip_only`, never when exporting), and only tips are picked.

### 5b. The three editing UIs to replicate exactly

These are the owner's named must-haves. mixomesh rebuilds each in Babylon to this behaviour. Read the source for exact numbers.

**A. Paint to select (Select supports, "Drag over").** A screen-space circle follows the pointer (8 to 80 px, default 24, "Circle size" field). Pressing and dragging selects every support whose body the circle passes over (along its path between pointer moves) and that is not hidden behind the model; Shift (or the Select | Unselect switch) unselects instead. Click style picks one support (the nearest tip within Click reach). Delete or Backspace deletes the selection; Esc clears it first, then leaves the mode. Selected tips are highlighted; tip settings edited with a selection become per-support overrides. Logic: `src/editing/dragOver.ts` (stroke and scheduler wiring), `screenBrush.ts` (circle hit test in screen space), `brushScheduler.ts` (one hit test per frame), `selection.ts`, `selectionHighlight.ts`; view: `src/components/viewport/useScreenBrush.ts`, `EditBar.tsx` (Click | Drag over, Circle size), `SurfaceBrushBar.tsx`.

**B. Paint area: add or edit where supports may go.** Paint | Erase switch, brush radius in mm (default 2), keys P and E in the dental steps. A stroke projects the brush onto the model surface and lays a stamp every half radius of travel (`src/editing/surfaceBrush.ts` `appendSurfaceStamps`, `stroke.ts`, `strokeQueue.ts`). Stamps are unit-local, ordered, and the last stamp covering a face on its own side wins (`AreaStamp::resolve` in Rust). In the dental flow, Paint means "supports allowed here" and painted faces that look down get their own tips at the outer spacing; in the generic flow the same brush marks no-support zones. mixomesh should offer the dental meaning (allowed area) on any selected model, since its supports are generic. The overlay draws only stamped triangles (`viewport/dentalLayers.tsx`, `SurfaceStampLayer`), and tips follow about 0.5 s after release (debounced worker job). Each stroke is one undo step.

**C. Add a support point.** Click on the model adds a manual tip. If a suggested or shown automatic tip lies within Click reach (`eraseRadius`, mm, default 1.5, "Click reach" field), the new tip snaps to it: its point and normal are copied and that automatic tip's id is deleted in the same undo step (`src/App.tsx` `addTip`, around the comment "Step 2, Add"). The engine supplies the snap targets: the policy's `suggested_points()` plus `candidate_points()` (`src/dental/placement.ts`). A warning is shown when the clicked face looks up (angle to plate up below the profile's `tipMinFromUpDeg`). Right-click or Ctrl+click on a support (or on the model within Click reach) removes it; an Add | Remove switch is the touch path. A ghost tip follows the pointer and the remove ring highlights what a right-click would take (`viewport/supportLayers.tsx`). Manual tips are never moved or hidden by regeneration.

Make the engaged tool unmistakable in mixomesh (owner, 2026-10-29): name it under the tool switch with what a click does, and use a crosshair cursor while adding.

## 6. Coordinate systems

The engine is right-handed, Y up. STL is Z-up: the reader maps STL (x, y, z) to web (x, z, -y), and export writes STL (x, y, z) = web (x, -z, y) (`src/supports/export.ts`). Babylon is left-handed by default. Adapter rule: either set `scene.useRightHandedSystem = true` (preferred, then three.js data maps 1:1 including winding), or convert at the boundary by negating Z of positions, normals and rotations and flipping triangle winding (swap two indices per triangle). `GeometrySession.transform` takes a handedness argument. Apply one rule in one adapter and test it with the parity fixture.

## 7. Tests to port as the parity harness

- Generic goldens: `src/goldens/goldens.test.ts`, `fixtures.ts`, `pipeline.ts`, snapshots in `src/goldens/__snapshots__/` (cube-overhang, knot, thin-slab, v-ridge; default, tree, roof, ridge variants).
- Host parity: `src/supports/genericParity.test.ts`, `src/workers/supportBuildParity.test.ts`.
- Rust: `crates/geometry-core/src/supports/generate/tests.rs` and `generate/tests/`, `supports/build/tests.rs`, `supports/safety/tests.rs`, plus `tools/blender-parity/` dumps (only if the placement is kept).
- Editing logic: `src/editing/*.test.ts` run as-is if the modules are copied.
- Walk scenarios in `scripts/walk.mjs`, generic parts: a1 to a5 (counts, drag-over, Delete), c and d (zone then export matches the screen), e (remove then add at one spot keeps the manual support), f1 to f4 (per-support settings, undo), g (Select to Unselect mid-queue), i1 to i3 (save and reopen keeps all hand work).

## 8. How the port is done (clean plan)

The port has three layers. Each has its own rule.

| Layer | What | How it moves | Proof it works |
|---|---|---|---|
| Engine | `crates/geometry-wasm/pkg-browser` (wasm + JS glue) | **Reused as built.** Copy into `vendor/mixo-geometry/` with a `VERSION` file holding `engine_version()`; never edit it in mixomesh. Upgrade by re-copying from a mixosupports commit and bumping `VERSION`. | Load check refuses a mismatch; generic goldens (section 7) give the same counts. |
| Logic | `src/editing/*.ts` (framework-free: session reducer, commands, keys, pick, stroke, strokeQueue, selection, removal, regenerate, shapeEdit, screenBrush, surfaceBrush, brushScheduler, locks, status), the settings layout and packer (`src/core/supports/settings.ts`, `src/supports/supportBuildWasm.ts`), the result decoder (`src/supports/generateSupports.ts`), contact edits (`src/supports/contactEdits.ts`), the worker protocol (`src/workers/meshProtocol.ts`, `meshWorker.ts`, `meshClient.ts`, `buildSessions.ts`) | **Ported as code, once.** Transpile TypeScript to plain ES modules with `esbuild` (types stripped, no bundling) into `src/support-engine/`; keep the file names. Drop the `dental` mode, `dental.*` commands and keys, and every import from `src/dental/`. After the copy, mixomesh owns the files: no sync back. | Their `*.test.ts` run in mixomesh (vitest runs on JS too) with the dental cases removed. |
| UI | React components and three.js layers | **Rebuilt** in mixomesh's own stack (Babylon, plain JS, mixo-app-style `tokens.css`/`base.css`). Nothing is copied. The behaviour contract below is the spec; the React files are for reading only. | The generic walk scenarios (section 7) re-written against mixomesh. |

**UI behaviour contract** (what the rebuilt UI must do; source files in brackets for reading):
- Support area (5b B): Paint | Erase switch, brush radius mm (default 2), a stamp each half radius, last covering stamp wins (`ZonesBar.tsx`, `src/core/supports/zones.ts`).
- Edit (5b A and C): Add supports (click adds, right-click or Ctrl+click removes within click reach, Add | Remove switch for touch) and Select supports (Click, or Drag over with a 8-80 px screen circle, Shift flips Select/Unselect, Delete removes, Esc clears then leaves) (`EditBar.tsx`, `SurfaceBrushBar.tsx`). Keys come from `keys.ts`; the dental P/E/A/S tool keys may be kept as plain tool keys.
- Per-support tip settings: editing a tip value with a selection writes a `ShapeOverride`; reset and select-customised actions.
- Pointer feedback: ghost tip, remove ring with the contacts it would take, brush ring (`viewport/supportLayers.tsx`, `dentalLayers.tsx` for the shared material trick: one material per marker kind, never recompiled per preview).
- Tips only view and a bottom view (camera below the plate shows only the model and tips).
- Live adjust: sliders rebuild through the worker with `revision`; stale results are dropped; the problem list greys until the new verdict lands.
- Problems: one notice per issue at full panel width, actions on their own row, panel scrolls as a whole.
- No auto-orientation, no print-angle scan, no start screen, no aligner profiles.

**Order** (each step is specified and reviewed before building):
- A0. Licence: decided (owner, 2026-10-29, mixosupports D23): no licence issue assumed; the code is treated as re-implemented. No audit blocks the port.
- A1. Vendor `pkg-browser` and add the load-time version check.
- A2. Port the logic layer (esbuild once) and its tests.
- A3. Spike: one selected mesh, generate in a worker, show tips in Babylon (decide right-handed scene per section 6), one golden matches.
- A4. Rebuild the support-area and edit UI against the contract.
- A5. Tips preview, per-support settings, export through the engine.
- A5b. Every remaining row of section 2b: Tree, Brace, Raft, Label, Roof, Cage, islands check, projects, several objects. Port each with its golden.
- A6. Save and reopen keeps all hand work (walk i1-i3 equivalent).
- A7. Benchmark-led moves of other geometry to WASM (2x or better only; `scripts/geometry-wasm-bench.mjs`).

## 9. What moves and what stays (owner, 2026-10-29: everything reusable moves)

Rule: every support-related piece moves to mixomesh. Only what is purely dental stays in mixosupports. Much of `dental/` is generic geometry under a dental name; port it under a neutral name. Whether mixomesh shows a feature in its UI (for example automatic orientation, which the owner kept out of the first mixomesh UI) is a separate decision: the code still moves.

| mixosupports module | Moves as (generic) | Stays (dental only) |
|---|---|---|
| `dental/topology.rs`, `contour.rs` | Hard-edge finder and loop closing (section 2b) | the aligner's ridge minimums (35 / 20 mm) as profile data |
| `dental/opening.rs` | Enclosed-hole finder (raster along an axis, flood fill, lift to edges, two resolutions) | "central opening" naming |
| `dental/orient.rs`, `orientation.rs`, `rim.rs`, `pose.rs` | Principal-axis orientation (thin axis, lighter end), pose from a target frame | aligner thresholds and the reference pose angles |
| `dental/tilt.rs` | Print-angle search: scan tilts, hard rules (resin trap, support crossing, slenderness, edge gaps), robust band, pick order, confirm build | aligner start tilt and margins as profile data |
| `dental/region.rs`, `bands.rs`, `field.rs`, `footprint.rs`, `cache.rs` | Surface-distance field from a loop (multi-source Dijkstra on the surface, signed by side), a band area [low, high] from it, cache kept across retunes | "fitting side" naming |
| `dental/sampling.rs`, `incidence.rs` | Even spacing along a closed loop (N = round(L / s)), tip on the band's middle line, minimum separation, move to a face reachable from below | default spacings as profile data |
| `dental/paint.rs`, `legacy.rs` | Painted-area tips (spaced points on painted downward faces), manual area from stamps, legacy face fill | — |
| `dental/policy.rs` | Area-policy pattern: candidates, alternates, permitted faces, stamp gating | the two-contour aligner policy as a preset of it |
| `dental/review.rs`, `dentalwork/batch-review/` | Review GLB layers and the folder review (batch run plus viewer with underside view) for any model | aligner layer names |
| `supports/safety/rings.rs` | Edge-gap coverage (largest gap against spacing) | — |
| `src/dental/arrange.ts` | Arrange several objects on the plate without overlap | — |
| `src/dental/label.ts` | Label text rules (8 characters, A-Z 0-9 -) | — |
| `src/dental/tuning.ts`, `placement.ts`, `confirmTilt.ts`, `diagnose.ts` | Area tuning (position, width, density), placement apply with hand-work rekeying, confirm-tilt flow, diagnostics | — |
| `src/components/useDentalPreview.ts`, `useDentalTuning.ts` | Live tip preview and live retune (debounced worker jobs, stale-result dropping) | — |
| `scripts/host-example.mjs` | Driver pattern for headless runs | the dental call order |
| `dental/profiles/`, `src/dental/alignerProfiles.ts`, `supportPreset.ts` | The profile mechanism (data file per object type, strict parsing) | the aligner profiles themselves |
| `src/dental/flow.ts`, `manualArea.ts`, `legacyArea.ts`, `useDentalFlow.ts`, `DentalBar.tsx`, `DentalSteps.tsx`, `DentalSupports.tsx`, `StartScreen.tsx` | The step-flow pattern (guided steps with Back, Exit, notices) | the aligner steps, aligner type cards, start screen wording |

Also not ported as is: React and three.js code (rebuilt per section 8). Licence: settled by D23 (treated as re-implemented); everything moves.

## 10. Code handed over from mixosupports

Owner rule: any mixosupports code that is removed later and could help mixomesh (for example the generic-mode UI at the dental-only step) is not deleted. It is first copied into `S:\ai\mixomesh\port\mixosupports\<area>\`, with a `README.md` handoff that gives what it is, the source path and commit, and how it maps onto this guide. Only then is it removed from mixosupports. That folder does not exist yet (nothing has been removed so far: the generic UI is still in mixosupports, hidden during the dental steps, so read it there). Check the folder before rebuilding anything.

---
Describes mixosupports main `adbe7c3` (engine_version 9). Date: 2026-10-29.
