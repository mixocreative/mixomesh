# CIA audit 2026-09-17 — import / export integrity (Screen tier)

Scope: whole `src/` mapped; sweeps walked at Screen depth on the import seam
(`ImportPipeline` / `AssetImport` / `ImportNormalizer` / `ThreeMFLoader` / `WorkerImport`),
the export seam (`PrintPipeline` / `ThreeMFWriter` / `ObjWriter` / STL / `ExportTextures`),
the `.mixo` persistence seam, and the test suite as an instrument. Domains on the map
NOT walked this run: boolean/slice-connector ops, render output (PNG/video), workspace UI,
Electron IPC beyond persistence (last walked 2026-06-16 full audit).

## Owner paragraph

Before this run every `.glb` import was rendered inside-out, every 3MF export was the
mirror image of the viewport and upside-down, STL exports were unreadable (big-endian),
and OBJ exports had inverted faces. All four are fixed, pinned by tests against a
PrusaSlicer-written file, and re-verified in PrusaSlicer and trimesh. A torn `.mixo`
load no longer leaves Ctrl+S pointing at your good file, and importing now counts as
unsaved work. Safe to use for print export again. **Do next:** open one real textured
model, export 3MF, and load it in your slicer once — the fix was proven on a
tetrahedron, not on a production model (S15 step 5 reachability). Then work the
OPEN list below (second pass closed C2/C4/H6/H1: export now fails closed on
texture loss, path collisions, prep errors and picker cancel).

## Fixed this run (commit on master, tests named)

| ID | Sev | Finding | Fix | Test |
|---|---|---|---|---|
| X1 | CRITICAL | glTF imports rendered inside-out: `ImportNormalizer.js` called `flipFaces` after Babylon's `bakeTransformIntoVertices` had already flipped for det<0 (double flip). Validator flagged every import "inverted"; every export inherited it. Confirmed by cull-on/off screenshots. | second flip removed | `import-normalizer.test.mjs` "baked ONCE" |
| X2 | CRITICAL | 3MF export mirrored + upside-down: `RotationX(-90°)` on left-handed data (+Y → -Z) with a blanket winding flip. Loader had the exact inverse, so round-trips hid it. Confirmed: exported tetra = point inversion of PrusaSlicer's file. | ONE seam `print/PrintSpace.js` (reflection `(-x,-z,y)` / `(-x,z,-y)`), per-mesh winding from Babylon's side flag; loader keeps file order; 3MF rests on bed | `print-space.test.mjs`, `threemf-components.test.mjs` (Prusa XML embedded), `export.test.mjs` ClockWise/CSG tests |
| X3 | CRITICAL | STL written big-endian (`CreateSTL(..., isLittleEndian=false)`): PrusaSlicer read size 0 / volume 0. Babylon's STL also mirrors (own Y/Z swap). | `print/StlWriter.js`, LE, through PrintSpace | `print-space.test.mjs` STL block; `export.test.mjs` byte checks |
| X4 | HIGH | OBJ inside-out (consequence of X1; Babylon's OBJ serializer honours the stale ClockWise flag) | X1 | live probe: trimesh volume +1000 |
| X5 | HIGH | CSG re-bake output (native winding) kept the clone's glTF ClockWise flag → STL/solid-3MF inverted after Manifold | `_csgRebake` resets flag to CounterClockWise | `export.test.mjs` "CSG re-bake resets" |
| P1 | CRITICAL | `PersistenceManager.open/openRecent` bound `_fileHandle` BEFORE `loadProject`; a torn load (world reset, then throw) + Ctrl+S overwrote the user's only copy with an empty scene | bind after successful load | `persistence-open.test.mjs` |
| P2 | HIGH | Import never marked the project dirty → close-without-save prompt skipped after dropping models | `markDirty()` at end of `loadFromBlob` / `instantiateAsset` | `library-import.test.mjs` dirty test |
| L1 | HIGH | 3MF loader ignored `unit` (inch/meter files arrive 25.4×/1000× wrong, silently) | `UNIT_TO_MM`, unknown unit throws | `threemf-components.test.mjs` |
| L2 | HIGH | 3MF loader never bounds-checked `v1/v2/v3`; NaN coords coerced to 0 | throws with object/triangle index | `threemf-components.test.mjs` |
| C2 | CRITICAL | Texture readback failure failed OPEN: OBJ shipped without `map_Kd`, 3MF fell to colorgroup, success toast | `ExportTextures` throws (`_readTextureOrThrow`) — export aborts with the texture named | `threemf-materials-ext.test.mjs` "fail closed" |
| C4 | CRITICAL | JSZip overwrote colliding entry paths (`Cube`/`cube`, `a/b`/`a:b`) → a part silently missing | `PrintPackaging.uniqueEntryPaths` suffixes `_2`, case-insensitive | `export.test.mjs` "paths collide" |
| H6 | HIGH | Save-picker cancel toasted "✓ Exported"; multi-ratio batch re-prompted | `triggerDownload` returns false → info "cancelled" toast, batch stops | `export.test.mjs` "picker cancelled" |
| H1 | HIGH | Non-`PrintPrep.` prep errors swallowed → part exported at raw BU scale | every prep error aborts the export, step + mesh named | `export.test.mjs` "prep step throws" |
| M7 | MEDIUM | OBJ `usemtl`/`o`/`mtllib` with embedded spaces → most parsers (Mimaki prep tool, MeshLab, Blender) truncate the token and drop the texture | `objToken` sanitiser applied to BOTH OBJ and MTL sides | `export.test.mjs` "material ids with spaces" |
| L1 | LOW | MTL wrote both `d` and `Tr`; parsers disagree on `Tr` semantics; `Kd` unclamped | `d` only, `Kd`/`Ka`/`Ks`/`Ke` clamped to [0,1] | same test |
| M5 | MEDIUM | Textured 3MF `<object pid>` without `pindex` (Core §4.1 requires it) | `pindex="0"` emitted | `threemf-materials-ext.test.mjs` |

Live verification (headless Chrome via the app's own import + export paths, tetra fixture):
3MF → PrusaSlicer `manifold=yes volume=1000`, z 0..20 (rests on bed); trimesh `+1000`,
winding consistent. OBJ → `+1000`. STL → LE count 4, `+1000`. PrusaSlicer 3MF import →
Babylon apex at +Y. Cull-on screenshot = cull-off screenshot (outward).

## Mimaki practice (decided 2026-09-17)
Primary hand-off = **OBJ + MTL + PNG** (oldest, most-documented full-colour path in the
Mimaki prep tool; plain text, inspectable). Textured 3MF stays as the second option.
Both now: single-token OBJ directives, `d`-only opacity, clamped colours, `pindex` on
every `pid`, outward CCW winding, right-handed Z-up (3MF) / Y-up (OBJ), sRGB PNG at
source resolution, one texture per mesh, UVs in 0–1. UNVERIFIED: the Mimaki prep tool
itself was not on this machine; its manual is the authority for texture caps.

## OPEN — owner decisions / next work (graded, evidence in agent reports of this run)

### CRITICAL / HIGH
- **H4 re-graded to LOW / partly wrong.** Babylon binds `albedoColor` raw (`pbrBaseMaterial.js:1662`, no linear conversion), and the app's colour picker stores sRGB hex → `albedoColor` → export hex is the identity of what the user picked. Only glTF-imported FLAT colours (`baseColorFactor`, linear by spec) export darker than intended; textured parts are unaffected. Fix if wanted: convert `baseColorFactor` to gamma at glTF import (ShaderLibrary), not at export.
- **H5 bed-fit readiness computed in a frame no writer produces** (`PrintReadiness.js:91-99`) — "below-bed"/"overflow" warnings describe a fictional placement. Fix: route through `PrintSpace` + the writer's seating.
- **H3 (persist) ghost assets silent at load** + project then unsaveable (`ProjectLoader.js:227,262` → ghost, success toast; `ProjectSerializer.js:151` throws on save). Fix: load summary modal listing ghosts with Relink; exclude ghosts from portable-save requirement or offer "save without".
- **H1 (persist) no schema/version validation on load** (`migrate` returns doc, `version` never read; `resetWorld()` before any validation). Fix: validate shape + version before reset.
- **F20 import racing project load / new** — no in-flight guard; import can mint objects into the next project. Fix: `_importDepth` gate in `loadProject`/`newProject` (wait or refuse).
- **F17 worker hang has no timeout** — a stuck OBJ worker job wedges every later import behind the overlay. Fix: per-job timeout → fallback + `_importEnd`.
- **3MF multi-mesh logical unit round-trip loses colours/UVs** — writer emits per-triangle `pid/p1..p3`, loader reads only object-level `pid` (`ThreeMFLoader.js:259,309`). Fix: per-triangle material resolution in the loader.
- **M6 Electron unrestricted `fs:readFile/writeFile` IPC** (`electron/main.cjs:71-75`), no callers — dead attack surface. Fix: delete.

### MEDIUM (selected)
- Multi-file drop: concurrent import failures overwrite each other's modal (`Modal.open` replaces); no "N of M imported" summary.
- Concurrent shader-merge prompts: second import cancels the first with `undefined` → silent rename.
- 3MF dangling `objectid` / malformed `transform` → part silently dropped / identity.
- Validator never emits severity `error` → export validation gate is vacuous; "auto-fixed on export" message promises a step that does not exist (`MeshValidator.js:347`, `PrintPipeline.js:325`).
- Stale validation cache → silent "ready".
- Units with no indices dropped silently (empty `<build>` possible after CSG).
- Batch export re-reads live state per target (selection/rename mid-batch changes reference).
- saveAs binds handle + renames before the write can fail (0-byte file left).
- Autosave races load/save; poisoned autosave re-offered every boot; keyed by name.
- Dirty bypass for `geometryFixes`, `bedDimensions`, `objBakeSolidTextures` (persisted, silent).
- No `contentHash` check of embedded mesh bytes on load.
- Electron KV store non-atomic (whole-file rewrite, lose-update race).
- 3MF `backFaceCulling=false` on loader materials hides winding errors in the viewport (kept: tolerant of foreign files; validator reports).

### LOW: see agent reports (worker msg shape trusted, first-`ratio`-extra wins, 64-sibling cap silent, loader drops object names, alpha FF only, etc.).

## Sweep lines (S1–S24)

- S1 stale snapshot — 1 finding (M8 batch re-reads `getState()` per target; `ExportTextures.js:43,55` bypass `ctx.state`). Sites: `PrintPipeline.js:185,206,266,275`, `ExportContext.js:92-128`, `AssetImport.js:164,281`. Quote: `const state = getState();` (`PrintPipeline.js:266`).
- S2 TOCTOU — no DB/queue rows in this system; import/load interleave filed under S23 (F20). Sites: `ProjectLoader.js:149`, `AssetImport.js:131-246`.
- S3 catch posture — 9 findings (C2 texture, H1 prep, H6 cancel, F1/F3/F4/F5/F6, persist L2). Sites: `ExportTextures.js:97,165`, `PrintPipeline.js:314`, `Download.js:16`, `Status.js:50`, `WorkerImport.js:35`, `ObjSiblings.js:186,204,256`, `ProjectLoader.js:262`, `Autosave.js:48`, `AssetResolver.js:53-77`. Quote: `if (e?.message?.startsWith('PrintPrep.')) throw e; console.error(` (`PrintPipeline.js:314`).
- S4 external field semantics — 3MF Core §3.4 `unit` (was ignored → L1 fixed), §4.1 `pindex` required with `pid` (M5 open), §4.1.3 CCW-outward (X2 fixed). OBJ/MTL `d`/`Tr` both written (L1). Sites: `ThreeMFWriter.js:26-40,241,354,423`, `ThreeMFLoader.js:171-214`, `ObjWriter.js:167`.
- S5 control → consumer — 0 dead live controls; every `ctx.options/prefs` field has a consumer (`ObjWriter.js:37`, `PrintPipeline.js:267,323,348`, `PrintPrep.js:33`, `PrintNaming.js:24-54`). Dead code: `PrintReadiness.formats`, `ExportPlanner.buildExportPlan`, `ExportPipeline.ts` types, `getPrinterProfile` (L11).
- S6 deferred-work — 5 hits, none critical: `StorageAdapter.js:10` (Phase 2 note), `ViewportDrop.js:166` (dir handles ignored), `Workspace.js:6` (presets follow-up), 2 comment-only. Open gaps, tracked in HANDOFF.md.
- S7 skipped tests — `skipped 0`; `browser-webgpu-check.mjs:116` prints SKIP + exit 0 without WebGPU (green on every CI) — unverified, not green.
- S8 written = run — every test added this run executed: `npm test` → `# tests 133 / pass 133`; `test:browser` PASS; `test:export` PASS (counts below).
- S9 rename residue — `_serializeSTL` removed, no residue (`grep` clean); `Y_UP_TO_Z_UP`/`THREEMF_REVERSE_WINDING` gone from `src/`; Blueprint updated.
- S10 environment truth — PrusaSlicer 2.9.3 + trimesh 4.8.1 probed before diagnosis; Blender present but has no native 3MF reader (not used).
- S11 boundary schema — 3MF: F7/F9 fixed; F10/F11/F12/F13 open. Worker→main F14 trusted raw. `.mixo`: H1 no version/shape validation. Sites: `ThreeMFLoader.js:243-283,325`, `WorkerImport.js:26-33,106-118`, `ProjectLoader.js:118-123,182`.
- S12 cascade — F16 (multi-drop no summary), F17 (worker no timeout), L9 (validate worker no timeout), M2 autosave race. Failure-mode table: texture readback fails → C2 silent; picker cancel → H6 false success; prep throw → H1 silent; worker hang → overlay forever.
- S13 orphan — dead: `ExportPlanner.buildExportPlan`, `ExportPipeline.ts`, `PrinterProfiles.getPrinterProfile`, `PrintReadiness.formats`, Electron `fs:*` IPC; designed-not-wired: HANDOFF Phase 1b/1c items (registered there, not orphans).
- S14 scope — stated at top; not walked: boolean/slice, render output, workspace UI.
- S15 four-corner — non-commerce; the object that crosses corners is the MODEL: viewport ↔ file ↔ slicer ↔ printer. Table: viewport (Babylon) / exported file / PrusaSlicer / trimesh for the tetra: before = 3 disagreements (mirror, up, endianness); after = 0. Reachability: production model NOT yet walked in a real slicer (owner action above).
- S16 terminal states — export outcomes: success ✓ toast; cancel ✗ false success (H6); texture drop ✗ nothing (C2); unit drop ✗ nothing (M4); worker hang ✗ overlay forever (L9); batch partial → modal, no per-file summary. Import: F24 empty OBJ → nothing.
- S17 off-system controls — `targetPrinterId` is a bed reference only (documented cosmetic); no local setting claims to constrain the slicer. 0 findings.
- S18 enumeration vs authority — 3MF namespaces/content types/rel types verified against Core 1.x + Materials 1.2 (`ThreeMFWriter.js:27-39`); `unit` table (§3.4) enumerated; `pindex` rule cell FAIL (M5). Binary STL layout enumerated (80/4/50). Matrix in agent report. UNVERIFIED: Bambu/Orca/Cura/Mimaki consumers (no files on disk).
- S19 environment — web app; no host requirements beyond Chrome/Edge + WebGL2 (documented). n/a for this scope.
- S20 detectors — `i18n-check` (reports count, no floor), `hygiene.test` (vacuous on empty printers.json), `MeshValidator` (was flagging every glTF as inverted — now silent on correct meshes: coverage separately reported via `validatedAt`). Outermost check: NONE (no CI).
- S21 suite as instrument — `npm test`: 133 files-as-tests, ~350 inner cases; assertion counts per file in agent report. Vacuous: `state-shape.test.mjs:166-211` (tests spread semantics), `export-context.test.mjs:217` (`assert.ok(true)`), `validator.test.mjs:428` (conditional assert), `print-readiness.test.mjs:548` (compares constant to itself). JSZip stubbed headlessly (OPC container never parsed headless; smoke does). Self-agreeing codec: was the entire 3MF round-trip (fixed: Prusa fixture). Secrets in diffs: none.
- S22 surfaces — import: 6 GAPs (F3/F4/F5/F19 console-only, F7-F11 nothing, F24 nothing, F6 ghost not in modal); export: C2/M4/H1 nothing, H6 wrong surface. Render guards with no fixture: ghost badge path, `portableSaveBlocked` only via toolbar not Ctrl+S.
- S23 arrivals — import ×{duplicate drop (new asset, by design), during load (F20 UNHANDLED), cancel (F21 none), zero-byte (F24 silent), concurrent (F1/F2 modal clobber)}. Persistence: autosave tick during load (M2 UNHANDLED).
- S24 contract tests — before: every format class (b) self-round-trip; after: 3MF import/export class (d) PrusaSlicer fixture + (e) live PrusaSlicer/trimesh probes. Still UNVERIFIED consumers: Bambu Studio, OrcaSlicer, Cura, Mimaki slicer, 3D Builder; OBJ/STL/glTF import still (b)/(e)-inline only.

## Step 6

1. Fast lint + scope tests: ✅ eslint clean, tsc clean, 131/131 at start.
2. Universal integrity: ❌ 4 CRITICAL + 12 HIGH found; 9 fixed (table above), rest OPEN. Commerce: none.
2b. VSM map: 6 System-1 seams (import, export, persist, render, boolean, UI), 3* = tests/*, 3 = state/settings/config/printers.json, 4 = Babylon loaders + slicer files, 5 = Status.js/catch policy.
3. Full suite: ✅ `npm test` 133/133 on HEAD (this commit); `test:browser` PASS; `test:export` PASS; build ✅.
4. Runtime walk: ✅ headless Chrome import→export→PrusaSlicer for glb/3MF/OBJ/STL; cull screenshots; ⏭ production-model slicer eyeball (owner, 1 action).
5. Fixes applied: 16 (X1-X5, P1, P2, L1, L2, C2, C4, H6, H1, M7, M5, MTL d/Kd) | Escalated: 7 HIGH+ listed above (H4 re-graded LOW).
6. Tier: Screen — elapsed ≈ 3 h.
7. Skill score: not run (no `tools/score.py` fixture run this session).
