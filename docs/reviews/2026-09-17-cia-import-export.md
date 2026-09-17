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


## Wave 1 (same day, 7 commits ef3a19c..c67954d) — every HIGH closed

| ID | Fix | Test |
|---|---|---|
| F17 worker hang | per-job timeout (120 s), worker terminated + recreated, main-thread fallback | `worker-import.test.mjs` |
| M6/M7 Electron | unconfined `fs:readFile/writeFile` IPC deleted; KV store = `electron/KvStore.cjs` (temp+rename, serialised, corrupt-file quarantine) | `kv-store.test.mjs`, Electron smoke boots |
| H5 bed-fit frame | readiness bounds go through `PrintSpace`, seated like the 3MF writer; `below-bed` only for world-placed OBJ/STL; null bed axis = unlimited | `print-readiness`, `bed-fit` |
| 3MF multi-material round-trip | loader groups triangles by (pid, pindex/texgroup) → one mesh per material, wrapper node + `sourceGroupId` = one logical object | `threemf-loader-materials.test.mjs` (5) |
| Validator winding (new, found by X1) | `_checkInvertedNormals` now flag-aware (CW: V<0 inverted; CCW: V>0 inverted) — CCW meshes (native, 3MF/OBJ/STL) no longer falsely "inverted"; message no longer promises an export auto-fix | `validator.test.mjs` (11) |
| H4 colour space | contract: record hex = sRGB; PBR albedo = linear; `ColorSpace.js` converts at every ShaderLibrary site and once in writers | `shader-live-update`, `export`, `materials-ext` |
| persist H1 | `ProjectValidator.validateDocument` before `resetWorld`; newer major refused; corrupt JSON = clear message | `persistence-load-guards.test.mjs` |
| persist H3 | ghosts surfaced in a `ghostAssets` modal + warning toast; ghost entries save with `ghost: true` (project no longer unsaveable) | load-guards, `portable-project` |
| M1 saveAs | write first, bind + rename after | `persistence-saveas.test.mjs` |
| F20 race | `LoadGate`: load refuses while importing; import refuses while loading | load-guards |
| M2 autosave | tick skips during load/import; poisoned autosave deleted on failed recovery | load-guards |
| M5 contentHash | embedded bytes hashed on load; mismatch → ghost, not torn load | `persistence.test.mjs` |
| M4 dirty | `geometryFixes`, `bedDimensions`, `objBakeSolidTextures` writes mark dirty | `dirty-tracking` |

Verification on c67954d: headless 138/138, lint 0, tsc clean, i18n 0 gaps, build ok, browser smoke PASS, export smoke PASS, Electron smoke PASS (headful).


## Wave 2 (same day) — MEDIUM list closed

| Item | Fix | Test |
|---|---|---|
| F10/F11 3MF loader | dangling `<item>`/`<component>` refs, missing `p:path` parts and malformed transforms THROW | `threemf-components` strictness test |
| F1/F2/F16 multi-file drop | sequential in drop order; one "Imported N of M" toast or one combined failure modal; single-file path unchanged | (UI, not headless-testable; browser smoke boots) |
| F24 empty file | `loadFromBlob`/`instantiateAsset` throw "no geometry found" when nothing was minted (library GLBs exempt) | `library-import` (unchanged path) |
| F14 worker payload | `done` message shape validated (positions ×3, index range, finite TRS) → reject → main-thread fallback | `worker-import` F14 |
| M8 batch state | one `getState()` snapshot per export batch, threaded into ExportTextures/writers | `export.test` "ONE state snapshot" |
| M4 empty parts | zero-triangle clone after prep aborts the export (all formats) | `export.test` "zero triangles" |
| M3 stale cache | readiness issue `validation-pending` (warning) for missing/stale validation; export-time validation stays the hard gate | `export.test` "validation-pending" |
| Boolean colour | result diffuse read via `materialSrgbColor` (PBR source no longer darker) | — (browser smoke) |
| Group inverted check | welded-union inverted check enabled with the siblings' shared side flag; mixed flags skip | `validator-group` (unchanged) |

Still open (LOW / by policy): missing-MTL console-only (field policy), 64-sibling cap silent, `.mixo` old-major accepted through migrate, 3MF loader materials `backFaceCulling=false` (tolerant of foreign files), i18n-check/hygiene detectors have no zero-coverage floor, Mimaki prep tool + Bambu/Orca/Cura consumers unverified (no software on disk).

## OPEN — owner decisions / next work (graded, evidence in agent reports of this run)

### CRITICAL / HIGH
- none open after wave 1.

### MEDIUM (selected)
- Multi-file drop: concurrent import failures overwrite each other's modal (`Modal.open` replaces); no "N of M imported" summary.
- Concurrent shader-merge prompts: second import cancels the first with `undefined` → silent rename.
- 3MF dangling `objectid` / malformed `transform` → part silently dropped / identity.
- ~~Validator never emits severity `error` → export validation gate is vacuous; "auto-fixed on export" message promises a step that does not exist (`MeshValidator.js:347`, `PrintPipeline.js:325`).~~
  **CLOSED 2026-09-18 (watertight-repair-and-cost, commits `2b92c6e..ebaa05d`, fix wave `eb49e18..`, + this doc pass).**

  **Stated plainly, because two consumers had quietly keyed on the opposite
  (fix wave, CIA F1): the validator NEVER emits severity `error`. It never
  will — non-manifold geometry is deliberately a warning (owner rule: a
  colour-print assembly tool works with downloaded display models that are
  routinely non-watertight, and slicers auto-repair them). The ONLY hard
  geometry block in the app is the opt-in `print.strictExport` setting.**
  Consequences, now enforced in code:
  - Anything that MEANS "watertight / has geometry issues" must test result
    TYPES (`holes` / `nonManifold` / `invertedNormals`), never
    `severity === 'error'` or `hasErrors(results)`. The status-bar HUD badge
    (`src/ui/MeshStats.js`) tested `hasErrors` and was therefore structurally
    blind — it could only ever read `✓ watertight`. Fixed; three verdicts
    pinned in `tests/mesh-stats.test.mjs`.
  - The `severity === 'error'` branches that remain (`PrintPipeline.
    _validateExportMeshes`, the Outliner/PrintPanel row icons, the
    error-list modal) are for VALIDATOR CRASHES only — `_validateExportMeshes`
    synthesises an `error` when `validateMesh` itself throws, so broken
    validation blocks the export instead of passing it. Those branches are
    correct as written and were deliberately left alone.
  - No new error tier was invented.
  The promised auto-fix step now exists: `MeshValidator.js` gained a `holes`
  check (open boundary edges) whose Auto-Fix runs the vendored MeshFixLib
  engine (`src/core/repair/MeshRepair.js`, MIT, `public/vendor/meshfix/`) to
  actually fill holes, not just flag them — closing "no hole filling". The
  export gate is no longer vacuous either: every export clone is repaired on
  the fly (`ExportContext.repairReport`/`repairSkipped`), and the opt-in
  `print.strictExport` setting makes a CONFIRMED still-open clone a hard
  block (`PrintPipeline.js` throws before writing the file) — the first path
  in this pipeline that can actually fail closed on geometry, not just warn.
  The three-way `exportGate` UI modal (Fix & Export / Export Anyway / Cancel)
  replaces the old two-button confirm. Live-verified end-to-end
  (`npm run test:repair`): an open tetrahedron's hole is filled
  (`holesFilled: 1` — the engine's own counter; this line read `3` until the
  fix wave threaded the real report through instead of re-labelling the
  boundary-edge count, review M2), the exported 3MF is watertight (volume 1000.0000 mm³
  vs. an expected +1000, 0.000% error; every edge used exactly twice), and
  PrusaSlicer 2.9.3 independently reports `manifold = yes`, `volume =
  1000.000000` on the same file. See `Blueprint.md` §9 *Watertight repair
  (MeshFixLib)* and §12 *Export Gate* / *Cost quote* for the full contract.
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
