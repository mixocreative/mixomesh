# HANDOFF — Storage Adapter + Web/Windows-Electron split

> **ACTIVE WORK (2026-10-14): MIXOMESH overhaul — resume from `docs/handoff/overhaul-execution.md`.** Storage-adapter Phase 1a work described below is superseded by **ADR 0001 addendum (2026-10-14)** + **Blueprint.md §11** (overhaul Phase 4 complete).

> **2026-11-13, U5's UI IS BUILT AND PUSHED (`11aaae6`), gate green: 260 PASS / 0 FAIL, 229 vitest,
> i18n 992 / 0 gaps.** Double-click a multi-part object and you are inside it with its MESHES as the
> selectable depth; pick them, press Separate selection, and they become one new object. The plan's
> decision held — the click-depth scope was extended, no third mode.
>
> **Read `docs/plans/2026-11-12-parts-and-focus-mode.md` §U5 for what is built and what is left.**
> The short version of the three things worth knowing:
>
> - **The dimming is now the mode's own decision.** `INERT_SELECTORS` lived twice, once in TS and
>   once as a `:is(...)` list in layout.css. A mode names its panels once, `applyModeShell` marks
>   them `data-dimmed`, one generic CSS rule. The browser smoke reads the computed opacity of all
>   five panels (0.38, inert) — that guard is what made the move safe, and it is why Support Mode is
>   provably unchanged.
> - **`scopeChain` hid the breadcrumb inside an object**, because it walked only groups and produced
>   an empty chain. The one moment the operator most needs telling where they are. Fixed.
> - **C2 may be the wrong instrument, and that is the next decision, not the next task.** The plan
>   wanted the split to record its parent so generation could warn about two overlapping objects.
>   But what the warning needs is whether they OVERLAP — geometry, not history — and a geometric test
>   also catches two unrelated objects moved into each other, which a parent record never would. It
>   also sidesteps the save-format constraint. **Decide between them before building either.**
>
> **Gaps 2, 4, 5, 6 are not reachable from this UI**: it moves link fields only, so no geometry is
> minted, no origin is chosen, no ratio is combined. They go live with a TOPOLOGICAL split (gap 5).
>
> **mixoDental got the other half**: a `buried` finding in the check list with **Show**, so the
> operator can frame the overlap instead of reading a count. Its glossary guard caught the Gemini
> bridge drifting from 接触 to 接点, and its geometry guard caught two new files passing engine
> geometry unlisted. Both were right; both are in `da23596`.

> **2026-11-13, LATER: U5 GAPS 1 AND 3 ARE FIXED, ahead of the separator-mode UI, because both were
> live defects in the app as it shipped.**
>
> **A Join orphaned the swallowed object's supports.** They live on the LEAD and every read redirects
> there, so merging a supported object into an unsupported one left the record unreachable AND still
> in the save file: nothing stale, export not blocked, **the print goes out unsupported**. The Join
> now snapshots, drops and warns (`toast.joinDroppedSupports`, three locales); undo restores them.
> The record is read straight off `state.scene.objects` -- a core command must not import the support
> modules, and it is only a field there.
>
> **A split replaced a name the operator chose**: "hook" merged into "denture" came back as
> "denture.001". `_isDerivedName` now separates a derived name (the lead's own, the import's
> `<lead>_primitive1`, an earlier split's `<lead>.001`) from a chosen one. The import rename stays --
> the 2-part test pins it, and that one IS wanted.
>
> **What was NOT broken, and I checked instead of assuming:** the lead's own supports after a merge.
> The union changed, so they must go stale, and they already did -- `_applyLinkPatches` dispatches
> `OBJECT_UPDATED` per id, `sourceHash` covers the union, the stale watch forgets the hash on that
> event. Pinned at both seams rather than "fixed".
>
> **A process note worth keeping: the heredoc ate my regex escaping again** (it is in the memory
> rules). The mangled `ParentCommands.js` broke app boot, and one gate run died in `test:ui-style`
> with "Timed out waiting for app boot" -- a confusing symptom for a one-character cause. Write
> regexes and Windows paths with Write/Edit, never through a Bash heredoc.
>
> **NEXT on U5:** the UI (double-click to enter an object with PARTS as the depth, the isolation
> dimming, the notice and its accept button), C2's recorded parent, and gaps 2, 4, 5, 6.

> **2026-11-13, ENGINE 68 IS VENDORED HERE AND THE OVERLAP RULE IS LIVE (U7 DONE).** An object whose
> file holds several meshes now gets no support where they overlap -- the body-and-arm case the owner
> asked for -- on the generic path, in both apps.
>
> **The fix was smaller than the plan's recommendation and the reason generalises.** The plan said to
> give `PlacedPoint` a `face: u32`. The host never needed a face: it needed ONE BOOLEAN per contact,
> which the dental path has asked per tip since engine 50 (`Overlap::blocked`). Engine 66 exposed it
> (`contacts_buried`), engine 67 applies it in `runPlacementJob` (`host/supports/buriedContacts.ts`,
> pure, tested without the engine). Calling `part_tips` instead -- the obvious route -- would have
> renamed every contact to `part<N>-...`, and **contact ids are the keys of the save format**:
> `deleted`, `overrides` and the manual list in every saved project. When a new call would rename the
> thing a save format is keyed by, the call is the wrong size.
>
> **`PlacementResult.buried` carries the count, and the panel shows it** (`supportPanel.verdict.buried`,
> EN/JA/ZH-Hant, the Chinese through the Gemini bridge). A contact dropped without a word is the
> silence this codebase does not allow: the operator would see an overlap with no supports and no
> reason.
>
> **THE BASELINE EARNED ITSELF A THIRD TIME, and this one is the best of the three.** At engine 67 it
> reported `seam-cube-split` losing 16 of 92 contacts -- the sixteen bottom cells of an ordinary cube,
> whose vertices are split as a textured import's are. `surface::parts::split` never welds (correctly:
> a weld there would turn a crack into a seam) and ASSUMES the import weld has run; the ABI above it
> ran none, so 32 unconnected faces became 32 touching "parts". **Engine 68 welds in the two bindings**
> (`proximity::weld`, duplicates only, face order kept, no copy when nothing welds), guarded by
> `a_split_vertex_file_is_one_part_and_nothing_on_it_is_buried` -- verified by forging the weld away.
>
> **And then the honest half: this app's LIVE path was never hit.** `frame.ts` `weldByPosition` (1 um
> grid) runs before placement, for its own float-noise reasons. What was hit was the baseline, which
> skipped that step -- so it was measuring a path nobody runs. Fixed: `row()` now welds as
> `partsToEngine` does. Two lessons: an ABI that works only when the caller happens to have welded has
> an unchecked precondition, and a fixture family built from one helper (`box_mesh`) shares its blind
> spot, which is why the OTHER repo's baseline is what found this.
>
> **The new baseline row is `sunk-pair`**: two overlapping boxes, the only row where the rule can fire,
> and the only app-level proof that this pipeline carries it. `placed` there is the count AFTER the
> rule, so a row whose `placed` climbs back is the rule having stopped working.
>
> **NEXT: U5 (separator mode).** Its blocker is gone -- the plan's trap ("the separator mode must say
> nothing about supports") is lifted for the live path, because the live path now honours parts. What
> is still open: mixoDental reports a buried-dropped contact NOWHERE (it needs one problem kind, for a
> dental user who meets a multi-mesh generic object), and `file_parts` still lives in `dental/` so the
> generic ABI calls into a dental module.

> **2026-11-12, ENGINE 65 IS VENDORED HERE (`cf6d0b4`) AND THE GATE IS GREEN.** 53 ABI versions in
> one step, and the adherence audit's "a day, not a project" held: FIVE compile sites, all the
> `minFromUpDeg` -> `overhangAngleDeg` rename. Gate: typecheck 0, lint 0, node 1124/1124, vitest
> 224/224, consumers 283/283, all 23 suites of `test:all`, exit 0.
>
> **The two things that would have gone through silently:**
> - the LIVE site was `minFromUpDeg: 10`, not 0, and the engine documents the conversion as
>   `180 - this`, so it became **170**. Writing 10 compiles and changes which faces accept a manual
>   support. The plan's summary said "four `0` sites"; the adherence table had the 10 -> 170 case
>   right all along, so the lossy step was the summary.
> - an old `.mixo` hands the engine `undefined` for `neckMaxShift` / `minClearance`. Filled
>   GENERICALLY at `engineSettings` (`src/supports/live/jobInputs.ts`), the one place settings cross
>   to the engine. **Not** in `restoreSupports`: that imported `@mixo-geocore/host` into a module
>   that is plain JSON by design and is loaded by `tests/*.test.mjs` under BARE NODE, which cannot
>   resolve the alias -- 108 node tests broke while tsc and all 223 vitest tests passed.
>
> **`src/supports/engineBaseline.test.ts` + `tests/fixtures/engine-baseline.json` is the thing to
> keep using.** Eighteen rows, three fixtures x three presets x repair budget on/off, in process.
> `npm run baseline:check` compares; `UPDATE_BASELINE=1 npx vitest run src/supports/engineBaseline.test.ts`
> re-takes. **A baseline updated without reading the diff is worse than no baseline.** It earned
> itself twice on the first use: it made the re-vendor diff readable, and it caught a WRONG
> attribution -- cube-overhang's 70 -> 51 contacts looks exactly like the `scatterAngle` 50 -> 45
> default and is not. At engine 65 the count is 51 at 45, 50 and 60 alike; it is **engines 47/48**,
> an owner decision of 2026-11-01 already shipped in mixoDental. Decided (Fable): **take 45**, and
> `docs/geocore-adherence-2026-11-12.md:43` carries the measured cost.
>
> **A defect the new slope fixture found on the way:** a 47-degree tilted plate placed 66 contacts,
> the safety repair dropped all 66, 0 triangles were built -- and the verdict read **clear**, which
> the panel renders as "Supports clear the model". `Status::Clear` means "no body intersection found
> (not a print-stability claim)" and says so, so the engine was right and this app was making the
> claim. Fixed in `dea6474`: an empty build reports `nothing-built`, and a MISSING verdict is
> `inconclusive` rather than `clear`. **`npm run i18n:check` reported 0 gaps for the two missing
> translations**, because `GenerateRow` renders `supportPanel.verdict.${verdict.status}` and the
> scanner only sees literal keys; `ProblemList.test.tsx` now asserts all four statuses in all three
> locales.
>
> **U4's load-bearing half is done** (`24d71ab`): the isolation mask is `src/ui/isolation.ts`, ready
> for the separator mode, proven behaviour-neutral by the three browser suites that drive it. Only
> the mask -- the chrome dimming, the notice and Esc have no caller until U5, and a module built for
> a user that does not exist is a hub. Extracting it collapsed a duplication: the isolation layer was
> declared twice and `layers.test.ts` pinned the two equal by reading one out of the other's SOURCE
> with a regex.
>
> **NEXT: U5 (separator mode) and U7, in `docs/plans/2026-11-12-parts-and-focus-mode.md`.** U7's real
> blocker is recorded there and is not what the plan assumed: `part_tips` returns ids like
> `part0-auto-...` while contact ids are the save format's keys, and the cheap alternative needs a
> face per placed point, which `PlacedPoint` does not carry. The fix is additive -- give it
> `face: u32` -- and smaller than an id migration across every saved project.

> **2026-11-12 — ALL THIRTEEN findings of `docs/cia-audit-2026-11-12.md` are CLOSED, and master is
> PUSHED at `e67d09e`** (CI green: lint, typecheck, `npm test`, `i18n:check`, build; Pages deployed
> 06:28 UTC). The three HIGHs went first. MX-01: `MeshRepair.diagnoseMesh` now welds by position before it asks the engine, so a
> UV seam stops counting as a hole — the weld went into that shared seam, not into one call site, so
> all three raw-mesh diagnose callers are covered; `repairMesh` keeps getting RAW geometry on purpose
> (the engine merges for itself, `arraysToMesh` needs the original UVs). MX-02: a failed autosave
> recovery MOVES the snapshot to `autosavefailed_<projectId>` instead of deleting it; the boot scan
> ignores it, only an explicit Discard clears it — **open debt: no UI offers a salvaged snapshot
> back.** MX-03: `restoreSupports` returns `{ supports, dropped }` and the loader toasts the names it
> could not restore. Guards: `tests/diagnose-weld-mx01.test.mjs`,
> `tests/autosave-recover-keeps-snapshot-mx02.test.mjs`, `tests/load-dropped-supports-mx03.test.mjs`,
> plus a `validateMesh` case in `tests/validator.test.mjs`.
>
> **The MEDIUM/LOW findings are closed too**, each in its own commit: MX-04 `66b5ccd` (strict export
> says "model parts", because supports can never be a manifold), MX-05 `b18047f` (a bundle names its
> format, so five formats write five files), MX-06 `c4caa6c` (the exported bytes are read by
> something that is not the writer), MX-07 `bc40c9e` (the smoke allowlist is scoped by what the line
> is and reports what it silenced), MX-08 `8ff27db` (a support build that returns nothing is named,
> not skipped), MX-09/MX-10 `7394385` (the exports and state fields nothing reads are deleted),
> MX-11 `c3e1ef1` (the single read of an object's supports on load is pinned), MX-12 `b8b65bf` (the
> app route has an `h1`; the unit-suffix clip was fixed upstream in mixo-app-style `fc11115` and the
> copies re-taken in `e67d09e`), MX-13 `aac3211` (one surface for every boot failure).
>
> **What is NOT shipped: the desktop app.** `installers/` still holds only
> `MIXOMESH-Setup-0.3.1.exe` from 2026-10-23, while `package.json` is 0.3.2 — so no installer
> contains any of the thirteen fixes. `npm run dist` is runnable (electron-builder 26.15.3 is a
> devDependency) but has not been run since. The installer is also unsigned, which SmartScreen warns
> on, and `electron-builder.yml` has no `publish` key, so there is no update channel for anyone who
> already installed 0.3.1. The web app on Pages IS current.

> **2026-11-12, LATER - `npm run test:all` WAS RUN FOR THE FIRST TIME IN WEEKS AND IT WAS RED.**
> Three failures, none of which `npm test` or CI can see (CI runs lint, typecheck, `npm test`,
> `i18n:check`, build - not the 25 browser smokes). Two are fixed here; the third needs a decision.
> `&&` chaining means one red suite hides every suite after it, so each fix revealed the next.
>
> **1. FIXED - a mesh smaller than the weld cell was welded away and then called watertight.**
> `test:outliner-hover` imports one open triangle; the importer normalises it to 0.02 mm across and
> the weld cell is 0.1 mm, so all three vertices fell in one cell, the triangle was dropped as
> degenerate, and the engine was handed an EMPTY mesh - `boundaryEdges: 0, triangles: 0,
> isWatertight: true`. Measured live: `validation: { results: [] }`. No Repair pill, no warning,
> strict export would have passed it. **MX-01's weld caused it**: before that fix the engine read
> the raw arrays and saw three open edges, and `_checkNonManifold` welds at the same
> `MERGE_DISTANCE` and skips degenerates, so after MX-01 no reader in the app could see sub-cell
> geometry. `diagnoseMesh` now reads the raw arrays when the weld annihilates the mesh
> (`MeshRepair.js`), with two guards in `tests/diagnose-weld-mx01.test.mjs`. Forged the fix away to
> check them: the new guard fails, the four original MX-01 tests still pass.
>
> **This is a patch on a weld that is wrong by design, and the real fix is the re-vendor.**
> mixoMesh welds at an absolute `WELD_DISTANCE = 1e-4` Babylon units with no edge guard and no
> body-gap floor, so it also stitches two shells that pass within 0.1 mm. geocore solved this
> properly in `core/proximity.rs`: `Weld` is `max(1e-7 mm, 1e-6 x bounding-box diagonal)` and
> refuses any merge that joins two vertices sharing an edge or puts an edge on more than two faces,
> and it sits three orders of magnitude below a fixed 0.005 mm `BodyGap` - `repair/weld.rs` asserts
> `distance_mm * 50 < BodyGap`, so "welding never fuses two bodies" is true by arithmetic. That is
> what `docs/geocore-adherence-2026-11-12.md` means by deleting the 1,644-line repair stack.
>
> **2. FIXED - the engine smoke test pinned engine 11 as a literal while the vendor has been 12
> since 2026-10-30.** `tests/browser-support-engine-smoke.mjs` had `const EXPECTED_ENGINE = 11`, so
> it had been red for thirteen days through three Pages deploys. It now reads `engineVersion` from
> `public/vendor/mixo-geocore/SOURCE.json`: the assert exists to catch the app loading something
> other than what it vendored, and a literal cannot do that job. All three shapes pass -
> engine_version 12, 70 tips, 18004/18004/18244 support triangles.
>
> **3. OPEN, NEEDS A DECISION - `test:support-workers` asserts a golden captured for different
> settings, and only ever passed by coincidence.** It reports **68 tips** against
> `GOLDEN.tips = 70` and fails in the first (dev) mode. Do NOT change the golden number: 70 is
> correct. Checked against the authority - geocore's own
> `goldens/__snapshots__/cube-overhang.default.json` has 70 `placement.points` at the VENDORED
> commit `6cc5385` (engine 12), and at `21c7840` and `6bf349a` too. The two app paths use different
> presets: `__mxSupportEngineProbe` runs `runSupportSpike({ preset: 'LIGHT' })` and gets 70, while
> this test presses the panel's Generate button, which runs **preset MIDDLE** (the settings dump in
> the failure output confirms it). Both are asserted against the same golden. engine 11 -> 12
> (`14e4f82`, "proximity weld, no coordinate snapping") separated two counts that happened to agree
> at engine 10, which is when the golden was captured. geocore has no golden for MIDDLE (its
> variants are default / roof / tree / low-poly, which are settings variants, not presets).
> **Recommended fix: make the test generate with the settings the golden was captured from (select
> the LIGHT preset before pressing Generate) and say so in a comment**, so the number stays anchored
> to an independent source. The alternative - capturing a MIDDLE golden from mixoMesh's own run - is
> the app blessing its own output, which is what the export reader (MX-06) exists to avoid. Not
> done here because it changes what the test exercises, and that is a roadmap call.

> **DECIDED by Fable, 2026-11-12, and TWO OF MY CLAIMS ABOVE ARE WRONG.** Fable ran the in-process
> path (no browser, no worker) on the vendored engine at each commit and measured it, which is why
> its answer beats mine.
>
> **What actually causes 68, and it is not the weld and not the preset.** It is the REPAIR BUDGET.
> cube-overhang, MIDDLE, in-process: engine 10 gives 70 tips `blocked` at any budget; engines 11 and
> 12 give 70 tips `blocked` at budget 0 and **68 tips, 2 dropped, `clear` at budget 3**. LIGHT gives
> 70 tips `clear` at every budget on 10 and 12. The engine side changed at **engine 11** (geocore
> `091d3fb`, "generic policy takes the repair budget from the host"), and the app side at mixoMesh
> **`60459cf`** (P5.1-P5.4), which added `repairBudget: REPAIR_BUDGET` (3) to `buildJob` in
> `src/supports/live/jobInputs.ts`. So: my "engine 11 -> 12 proximity weld separated the counts" was
> WRONG, and "the operative difference is the preset" was WRONG - the probe's `supportJob()` sets no
> `repairBudget` (engine default 0) while the live `buildJob` sets 3, so the two tests differ in TWO
> inputs, and MIDDLE through the probe would still report 70. "Never valid, only coincidence" is half
> right: at engine 10 the assertion held because the budget did nothing, not because two counts
> happened to agree.
>
> **68 IS LEGITIMATE - the repair is doing its job**, not a defect in the live worker path. Placement
> still returns 70 points; the safety repair then drops the two contacts at the overhang edge
> (`auto-215_100_485` and `auto-215_100_-485`) where MIDDLE's thicker supports cross the model, and
> the verdict moves from `blocked` to `clear`.
>
> **VERDICT C, not A and not B.** Keep the smoke on the panel's DEFAULT path and replace the count
> equality with a conservation check anchored to geocore's number. `tests/browser-support-worker-shapes-smoke.mjs`
> line ~170 becomes three assertions: `stats.last.points === GOLDEN.placementPoints` (70, from
> geocore's snapshot); `stats.last.tips + stats.last.dropped === stats.last.points`; and
> `stats.last.verdict === 'clear'`, which holds only if the repair ran in the worker. That needs two
> fields on `liveStats.last` in `src/supports/live/liveGeneration.ts` (~271): `points` and `dropped`
> (`built.dropped.length` is already computed on the next line). **As a separate commit**, one vitest
> case in `src/supports/features.test.ts` for MIDDLE with `REPAIR_BUDGET`: 70 placed, exactly those
> two ids dropped, verdict `clear` - labelled as the app's OWN characterisation, to be re-taken on
> re-vendor. It runs under `npm test`, so CI sees it; the browser smokes never are.
>
> Why not the two I offered: **A (select LIGHT)** goes green for the wrong reason - LIGHT at budget 3
> drops nothing, so the smoke would stop exercising the repair path in the worker, which is the only
> thing separating the live route from the probe route. **B (pin 68)** takes the number from the
> writer (the MX-06 pattern) and breaks at the pending re-vendor, where nobody could tell a
> regression from a legitimate change. C's own cost, stated: it does not bound HOW MANY contacts are
> dropped, which is the gap the unit test fills cheaply and in CI.
>
> **OPEN UX QUESTION Fable raised and did not check: does the panel tell the operator that 2
> contacts were dropped on a default Generate?** If it does not, that is a finding of its own - a
> silent change to what gets printed - and it is exactly the "nothing dies silently" class.

> **VERDICT C IS IMPLEMENTED, 2026-11-12, and `test:support-workers` is green in all three shapes.**
> `liveStats.last` gained `points` (what placement produced) and `dropped` (`built.dropped.length`),
> and the smoke asserts three things instead of one absolute count: `points ===
> GOLDEN.placementPoints`, `tips + dropped === points`, and `verdict === 'clear'` (only reachable if
> the repair ran in the worker). **The measurement that settles the argument: dev and preview report
> 70 placed = 68 tips + 2 dropped, and ELECTRON reports 70 = 69 + 1.** Pinning 68 would have passed
> twice and failed in Electron - so option B was not merely inelegant, it was wrong. It also means
> *which* contacts the repair drops is not stable across shapes; recorded, not smoothed over. The CI
> half is `src/supports/features.test.ts` (18/18): MIDDLE at `REPAIR_BUDGET` places 70, drops
> exactly `auto-215_100_±485`, verdict `clear`; without the budget it keeps all 70 and can only
> reach `blocked`. Labelled a CHARACTERISATION, to be re-taken on re-vendor, not defended.

> **`npm run test:all` IS GREEN END TO END, the first clean full run in weeks** (2026-11-12): all 23
> suites, exit 0, node **1124/1124**, vitest **221/221**, consumers **283/283**, and
> `test:support-workers` in all three shapes.
>
> **A FLAKE WORTH KNOWING ABOUT.** The run before this one failed at `test:repair` with "Timed out
> waiting for Vite app" while Vite had already printed `ready in 558 ms` on port 1719. It passed
> alone and passed in the next full run, so it is a flake and not a defect. But 23 suites chained
> with `&&`, most of them starting their own Vite, means one start-up hiccup fails the chain and
> hides every suite after it - which is exactly how two real defects hid behind each other earlier
> that day. **The fix is a retry on the HTTP probe, not a longer timeout**, and it is worth doing
> before the separator mode adds more browser tests. Recorded in section 4 of
> `docs/plans/2026-11-12-parts-and-focus-mode.md`.

> **THE SPLIT / MERGE UX THE OWNER DESIGNED: Fable judges it SOUND WITH CHANGES, and about half of
> it already exists.** Full reasoning in the session; the load-bearing parts:
>
> **The correct rule, in one sentence:** an object is one print - the engine decides from geometry
> which faces of THAT ONE OBJECT are buried and never supports them, grouping decides only which
> meshes are in the object, and two separate objects that overlap are a collision to REPORT, not a
> fusion to assume.
>
> **The owner's wording "respects by object" was right and my correction of it was wrong.** The
> buried-face rule cannot hold "regardless of grouping": supports are stored per object in the
> lead's local frame and hashed per object, and `src/supports/stale.ts:1-8` makes translation never
> stale them. A cross-object rule would make moving B invalidate A's supports, and no other object
> is passed to a support job as an obstacle.
>
> **Already built:** `JoinCommand` (`src/core/commands/ParentCommands.js:619-700`, "Merge into one
> object", active object becomes the lead - so "active's origin" is already true);
> `SplitToPartsCommand` (`:556-603`, "Separate by material", all parts at once); click-depth scope
> with a breadcrumb (`src/core/Selection.js:358-431`, groups only); isolation with a layer mask and
> inert panels (`src/supports/SupportMode.ts:119-134`); rename by F2, row double-click and context
> menu, with a scene-wide `.001` collision rule (`HierarchyCommands.js:156-173`) that is silent.
>
> **Decision: EXTEND THE SCOPE, do not add a third mode.** Double-click on an object is unbound
> today (`src/core/InputManager.js:375`). Bind it to enter the object with PARTS as the selectable
> depth, reuse Support Mode's mask for the dimming, and give it one action, "Separate selection",
> producing one new object. Mutual exclusion with Support Mode is free because `InputManager._mode`
> is a single slot. Gizmo off inside.
>
> **The gaps, worst first:**
> 1. **Merge silently hides the other object's supports.** Supports live on the lead only
>    (`src/supports/store.ts:15-26`) and the link snapshot excludes them (`ParentCommands.js:531`).
>    If the lead had none, nothing is stale, export is not blocked, and **the print goes out
>    unsupported**. The orphan record is still saved.
> 2. **Merge then Repair reaches 3d's failures**: repair runs on the welded union of a logical object
>    (`src/core/repair/RepairSession.js:205-217`), which for two touching solids is the fuse/tear
>    case reported as watertight. The record replays at load, so repair -> split -> save reloads as
>    different geometry.
> 3. **The overlap promise is FALSE on engine 12.** `partsToEngine` only concatenates and welds
>    (`src/supports/frame.ts:105`); merged overlapping parts get tips in the overlap today. This
>    proposal fires section 4's re-vendor trigger ("a named engine feature it cannot have at 12").
>    The scene-graph half can ship now; the STL half and the overlap rule wait for engine 65.
> 4. Merge, save, reload loses the joined object's provenance and refinement
>    (`ProjectSerializer.js:277-296`).
> 5. **The lead is not the engine's target.** The engine picks the largest part as target and calls a
>    small one debris, "reported, never supported" (`surface/parts.rs:16-18`), so a merged small hook
>    gets nothing and the user's active object is not the engine's main body. The engine needs a
>    host-declared target, and 3c step 5 (show roles before generate) belongs in this scope view.
> 6. Hidden faces need CLOSED parts (`inside_other` is a parity test), so an open scan gets no mask
>    and the UI must say so.
> 7. Split destroys names: parts are renamed `<lead>.00N` (`ParentCommands.js:580`), so "hook" merged
>    then separated returns as "denture.001", and part rows cannot be renamed.
> 8. **The origin rule contradicts itself:** N picked meshes become ONE object, which has one origin,
>    not "each mesh's centre". Use the bounding-box centre of the picked set, and only where new
>    geometry is minted.
> 9. Engine part ids are not stable, so a topological split must mint owned geometry as derived
>    assets the way Boolean does (`BooleanCommands.js:162-178`) and implement
>    `retainedTriangles`/`release` or the undo cap evicts history.
> 10. Export uses the lead's ratio (`PrintPipeline.js:452`); merging objects with different ratios is
>     unguarded and was not traced.
>
> **Persistence: ADD NO PER-OBJECT FIELD.** `logicalObjectId` and `isInternalPart` are already saved
> at schema 3.6, and an older build whitelists per-object fields on load (`ProjectLoader.js:596-618`)
> - a new one is dropped and then lost on that build's next save. Derived assets make split results
> plain objects to any build.
>
> **Babylon: do NOT use `Mesh.MergeMeshes`.** It bakes world transforms into one vertex buffer, its
> multi-material form produces exactly the MultiMaterial mesh the import path exists to eliminate
> (`src/core/assets/MeshSplit.js:1-15`), and it breaks the `containerMeshIndex` reload depends on.
> The existing link model is the right one. C9 (deleting `src/core/repair/` for geocore's Rust
> repair) is untouched and still gated on the 12-scan comparison.

> **2026-10-22 /cia run (`docs/reviews/2026-10-22-cia-full.md`): every owner decision is closed.**
> W-13 bda8066, A-11 84dd6ef, E-03 7a5df43, F-08 632fefe; W-00 and C-06 kept as is (recorded in
> Blueprint). Master is NOT pushed; after pushing, read the first CI run (it now runs
> lint/typecheck/tests/i18n before deploy). Open: a real iPad / iPhone measurement to raise the
> unmeasured WebKit budget (1M / 3M).

> **2026-10-22 — Release 0.3.0 shipped (master 4e7a81e, tag v0.3.0, Pages live,
> installer `installers/MIXOMESH-Setup-0.3.0.exe`).** Heavy-mesh handling per
> `docs/superpowers/specs/2026-10-21-heavy-mesh-handling.md` (plan in
> `docs/superpowers/plans/`): STL/3MF import in a worker with weld + crease split,
> pre-parse refusal, measured budgets (web 2.5M warn / 10M refuse, desktop 6M / 24M),
> one progress surface for every worker job (NN/g timing, Cancel), BVH picking,
> faceted shading by default (shader) + per-user Smooth shading toggle, undo memory
> trim, statistics HUD (Selected n/total · Faces · Vertices, before → after),
> generated `THIRD_PARTY_NOTICES.txt` in web + desktop builds (Babylon Apache,
> Lucide ISC, env files = BabylonJS/Assets CC BY 4.0), automation sessions not
> throttled. Nothing in progress.

> **2026-10-21 — Workers & memory foundation landed (ADR 0006).** One worker
> runner (`src/core/workers/WorkerTask.js` + `serveTask.js`) for every worker;
> geometry revisions + single-copy extraction (`src/core/geometry/GeometryStore.js`);
> Booleans in a Manifold worker (`booleanCore.js`, caps 250k web / 1M desktop);
> lean STL + STL worker; chunked desktop export save (`export:beginSave` etc.).
> New heavy work (supports, slicer) follows the rules in `docs/adr/0006-workers-and-memory.md`.
> Clean builds: `npm run build` / `dist` first delete `dist/`, `release/` and
> `node_modules/.vite` (`scripts/clean.mjs`; the Vite cache is kept while a dev
> server listens on 5173). `release/` is therefore gone after a plain build —
> run `npm run dist` again before `npm run smoke:packaged`. The installer build
> keeps only the newest setup in `installers/`.

> **2026-10-21 — UI style switch (New / Original) landed.** Spec
> `docs/superpowers/specs/2026-10-21-ui-style-switch-design.md`, plan
> `docs/superpowers/plans/2026-10-21-ui-style-switch.md`. New = mixo-app-style
> Dense (default), Original = washi. Files: `src/core/uiStyleStore.js`,
> `src/core/UiStyle.js`, `src/app/ui-style-boot.js`, `src/ui/UiStyleSwitcher.js`,
> `src/styles/style-new.css`, `src/ui/Workspace.js` (per-style widths). Tests:
> `tests/ui-style*.test.mjs`, `tests/style-new-scope.test.mjs`,
> `npm run test:ui-style`. Screenshots: `UI_STYLE=new|original LOCALE=ja
> SIZES=1366x768 node scripts/ui-screenshot.mjs <dir>`.

**Purpose of this file:** durable resume point. If a session is cut off mid-operation,
THIS is the first file to read. It tracks the goal, decisions, plan, and exactly
what is done vs next. Update it at every safe boundary (before each commit).

Workflow: solo dev — **all work on `master`, no feature branches** (merged 2026-06-17).
Commit at each green boundary. This tracker persists across sessions.

---

## Goal (verbatim intent)

Audit code structure + UI design with subagents → decide the cleanest maintainable
approach to make MIXOMESH run as BOTH a web app and a Windows Electron desktop app
from one codebase → implement it. Update all architecture docs. Commit. Keep this
handoff current so a token cutoff is resumable by this or another AI.

## Locked scope decisions (do not re-litigate)

- **Targets now: Web + Windows (Electron). Mac DEFERRED** until Win+Web are production-level.
  Mac is additive later (behind the adapter), not a rewrite.
- **Electron, not Tauri** — Chromium renderer = the Chrome/CDP engine the test suite
  already targets → full engine parity, no re-test matrix (Babylon/WebGL2, WebCodecs,
  readPixels Mimaki lock, Workers, File System Access).
- **One codebase, capability-tiered `StorageAdapter`.** Runtime detected at boot
  (`window.electronAPI` → desktop, else web). App logic/UI branch on capability FLAGS,
  never on "is Electron" checks scattered around.
- **Web = ephemeral assets.** Import glb by picker → snapshot bytes → embed in `.mixo`.
  No asset DB, no folder mounts, no relink. `caps.persistAssets=false`.
- **Desktop = real fs, offline.** Absolute paths, live relink, folder mounts, file-watch.
- **`.mixo` is the interop/sync contract (already hybrid).** ALWAYS embed bytes; desktop
  ALSO stores path as an optional live tier. Cross-runtime open falls to embedded bytes →
  byte-identical geometry. The portable file is the sync unit (synced folder = poor-man's sync).

## Target architecture (the seam)

```
StorageAdapter (interface)
  caps: { persistAssets, relinkByPath, watchFiles, mountDirectory, writeFiles }
  pickOpen() / pickSave() / read(ref) / write(ref, bytes)
  resolveAsset(ref) / watch(ref, cb) / recentProjects()
impls:
  BrowserStorageAdapter  (File System Access + idb; current behavior)
  DesktopStorageAdapter  (Electron IPC → Node fs; Phase 2)
```
Core (render, edit, ratio, validation, export, .mixo schema) stays runtime-agnostic.
FS-only features (mount / relink / watch / recent-by-path) gate behind `caps`.

## Phased plan

- **Phase 0 — Audit + ADR (IN PROGRESS).** Subagents map storage coupling + UI capability
  gating + confirm core is FS-agnostic. Synthesize → ADR.
- **Phase 1 — StorageAdapter extraction (web-only, behavior unchanged).** Move current
  File System Access / idb / persist / assets calls behind the interface. All 101 headless
  + browser smoke + export stay green. NO Electron yet. Also cleans the asset-DB tier soup.
- **Phase 2 — Windows Electron shell + DesktopStorageAdapter (Node fs via IPC).**
- **Phase 3 — electron-builder (NSIS) installer, optional auto-update, security hardening
  (contextIsolation, no nodeIntegration, IPC allowlist).**
- **Mac — parked.**

## Progress log (update every boundary)

- [x] Branch `feat/storage-adapter` created.
- [x] HANDOFF.md scaffold written + committed (4ccca59).
- [x] Audit subagents dispatched (2 haiku agents: storage-coupling + UI-gating).
- [x] ADR skeleton written: `docs/adr/0001-storage-adapter-web-electron.md`
      (2 sections marked `[TO FILL after audit]`: StorageAdapter surface + UI gating map).
- [x] Audit findings synthesized → both ADR sections filled (263047a UI + interface after).
- [x] ADR complete: domain-level adapter w/ OPAQUE REFS (not FSA primitives), LEAF/LEAKED
      refactor order, core-agnostic confirmed. `docs/adr/0001-...md`.
- [x] Architecture docs updated: AGENTS.md + Blueprint.md pointers (74ae80d), memory
      `storage_adapter_direction.md` + MEMORY.md index.
- [x] Phase 1a: capability model `src/core/storage/capabilities.js` + `tests/capabilities.test.mjs`
      (5 asserts) (fda14cc); first UI gate = AssetPanel Mount button behind `caps.mountDirectory` (6a03deb).
- [x] De-flaked the dup round-trip smoke (settle source bounce before duplicating) (0b1a7d2)
      — 3× green. IMPORTANT: keeps the green-gate reliable for handoff.
- [x] Phase 1b (directory slice): `src/core/storage/StorageAdapter.js` domain interface +
      `BrowserStorageAdapter` delegating to today's code (opaque ref = FileSystemHandle);
      boot `storage` singleton; desktop directory refs are main-process registry tokens.
- [x] Phase 1b: route LEAF modules through the adapter (idb.js, persist/*, DirMounts,
      TextureAssets, Download, PersistenceManager doc I/O).
- [x] Phase 1b: gate remaining UI controls behind caps — ProjectMenu open/save/saveAs
      (`writeFiles`), recent (`persistAssets`), relink (`relinkByPath`); ViewportDrop OS-file handle.
- [x] Phase 1c: refactor LEAKED modules (AssetImport `_fileHandleKeyFor`, ObjSiblings dir-walk,
      AssetPanel `_scanDirectory`/`_cacheHandles`, ViewportDrop DataTransferItem) to go via adapter.
- [x] Phase 2 (directory slice): Windows Electron shell + `DesktopStorageAdapter`; mounted
      assets use allowlisted opaque-ref IPC and never expose OS paths to the renderer.
- [x] Phase 3: electron-builder (NSIS) installer (`build-installer.cmd`, `electron-builder.yml`) and security hardening. Auto-update is not built.
- Verify green (typecheck · 102 headless · build · browser smoke ×N · export) at EACH commit.

## AUDIT RESULTS (captured — do NOT re-run the agents)

- **Core seams runtime-agnostic (do not touch):** ImportNormalizer, ScaleMath,
  print/ExportContext, print/PrintPipeline (+PrintPrep/ObjWriter/ThreeMFWriter).
  PersistenceManager OWNS the I/O funnel → adapter injects there.
- **LEAF (wrap cleanly):** idb.js, PersistenceManager doc I/O, persist/AssetResolver,
  persist/RecentProjects, persist/Autosave, assets/DirMounts, assets/TextureAssets, print/Download.
- **LEAKED (pull FS out first):** assets/AssetImport (`_fileHandleKeyFor`→persistHandle),
  assets/ObjSiblings (dir walk), ui/AssetPanel (`_scanDirectory`/`_cacheHandles`), ui/ViewportDrop
  (OS DataTransferItem handles).
- **UI controls throwing-on-web today (gate behind caps):** ProjectMenu open/save/saveAs/recent/
  relink; AssetPanel Mount Directory; ViewportDrop OS-file drop; exports degrade to blob-download
  already. Full `file:line` map in the ADR §UI capability-gating.
- **caps set:** persistAssets, mountDirectory, relinkByPath, watchFiles, writeFiles.

## RESUME POINTER (read this to continue)

**Current step:** Phase 0 (audit + ADR) DONE. Phase 1a (capability model + first UI gate)
DONE + committed + green. Next = Phase 1b.
**Next action on resume:** Build `src/core/storage/StorageAdapter.js` per ADR §"StorageAdapter
surface" — the domain interface (JSDoc typedef) + `BrowserStorageAdapter` that DELEGATES to
today's functions (PersistenceManager pickers, idb.js, DirMounts, AssetResolver, Download),
with `ref` = opaque FileSystemHandle and `.mixo` descriptors `{path?,contentHash,handleKey?}`.
Export a boot `storage` singleton (browser impl for now). Then incrementally route the LEAF
call sites through it (list in Progress log + AUDIT RESULTS), one module per commit, keeping
the suite green. Then gate the remaining UI controls (ProjectMenu open/save/saveAs/recent/relink)
behind their caps like AssetPanel's mount button already does. THEN Phase 1c (LEAKED refactor).
Do NOT add Electron until Phase 1 is fully green. Behavior on Chrome must stay identical
throughout (all caps true → nothing hides, nothing changes).

**Watch-outs:**
- The browser smoke has import-bounce timing sensitivity; if a size round-trip flakes,
  the fix is `settleImportBounce()` before measuring/cloning (see 0b1a7d2), not a longer wait.
- `caps` is imported from `src/core/storage/capabilities.js`; override in tests via `setCapabilities`.
- Solo dev: work directly on `master`, commit at each green boundary (no feature branches).

## Verify commands

`npm run typecheck` · `npm test` (101 pass) · `npm run build` · `npm run test:browser` · `npm run test:export`

## Key files (storage coupling — from initial grep)

`src/core/idb.js`, `src/core/persist/*` (Autosave, ProjectLoader, RecentProjects, AssetResolver),
`src/core/assets/*` (AssetImport, DirMounts), pickers in `src/app/main.ts`, `src/ui/AssetPanel.js`,
`src/ui/ViewportDrop.js`, `src/ui/ShaderPanel.js`, `src/core/print/Download.js`, `src/core/PersistenceManager.js`.

## Open questions / risks

- Windows code-signing: optional at first (SmartScreen warning) — decide before release.
- `.mixo` size on web (always-embed) — acceptable; heavy scenes = big files (known).
- Keep `master` untouched until Phase 1 is green + reviewed.
