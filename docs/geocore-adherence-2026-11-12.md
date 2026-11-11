# mixoMesh ↔ mixo-geocore adherence audit — 2026-11-12

**Verdict: mixoMesh adheres. It is just 51 ABI versions old.** The vendored copy is clean
(`--check` exits 0, every file byte-identical to geocore `6cc5385`), the stamp check *is* wired into
CI, and no app code re-implements a `host/` or `editing/` module. Re-vendoring 12 → 63 is **a day**,
not a project: almost every change between the two is additive, and the one real break is a field
rename TypeScript will enumerate. The cost of staying is real but not urgent — 1,644 lines of
mixoMesh's own repair stack and a whole second WASM engine that geocore 62/63 now makes redundant.

Pinned: ENGINE 12, commit `6cc5385`, 2026-10-30 (`public/vendor/mixo-geocore/SOURCE.json:4`).
Geocore HEAD: ENGINE 63, commit `b5a71ab`, 2026-11-07.

---

## 1. Does mixoMesh still hold to its own recorded architecture?

`src/support-engine/PORTED.md:10-15` says app glue only, naming two files. **Mostly true, with one
real finding and one bookkeeping miss.**

| Finding | Evidence | Severity |
|---|---|---|
| **`src/core/repair/` duplicates what geocore 62/63 now owns.** 1,644 lines of JS over a *second* vendored WASM engine (MeshFixLib, `public/vendor/meshfix/mesh-fix-core.wasm`) doing weld, degenerate removal, winding, non-manifold split, diagnose and hole capping. Geocore 63 now owns all six in Rust. | `src/core/repair/Weld.js:1-9` (weld), `Diagnose.js:1-6` (diagnose), `CapLoops.js:1-9` (hole fill), `MeshRepair.js:1-8` (the pipeline); vs geocore `host/core/repairMesh.ts`, `host/core/removeDegenerate.ts` | **Real drift.** Not a PORTED.md violation — that doc scopes only the support engine, and this code predates the geocore repair work (2026-09-18) — but it is now a second implementation of an engine-owned job. |
| **`src/support-engine/` holds 3 files PORTED.md does not declare.** All three are genuine glue, so the code is right and the doc is stale. | `analysisProtocol.ts:1-6` (job shapes over geocore types), `analysisWorker.entry.js:1-6` (Vite worker entry, `.js` on purpose), `progressLabel.ts:1-6` (i18n for engine stage codes) | **Doc fix.** One line in PORTED.md. |

**No thick wrapper blocking updates.** `src/panels/supports/` (18 files) is React UI over geocore
types — it imports `LiveSupportSettings`/`SettingKey` and renders them generically
(`SupportPanel.tsx:20`, `supportData.ts:75`), so a new setting in geocore surfaces without app
changes. `loadGeometry.js:5` re-exports the host loader rather than re-deriving it. Only one app file
calls the engine directly (`src/supports/spike.ts:86`); everything else goes through
`host/supports/jobRunner.ts`, which the re-vendor replaces wholesale. **That is why the ABI churn
below is cheap.**

---

## 2. What does mixoMesh import, and what would break?

41 distinct specifiers. Checked each against `git diff 6cc5385..b5a71ab`. Ranked by work:

| Call site | Module | Change | Work |
|---|---|---|---|
| `src/supports/live/supportInteraction.ts:190` + 4 test sites | `editing/addTip` | **`minFromUpDeg` → `overhangAngleDeg`** (engine 57), and the semantics invert: the aligner profile's `tipMinFromUpDeg` became `overhangAngleDeg` as `180 − x`. So `minFromUpDeg: 10` becomes `overhangAngleDeg: 170`. | **The only real break.** `AddSupportCommand.ts:12` does `Omit<AddTipInput, …>`, so `npm run typecheck` names every site. 5 edits + confirm the inversion is what's wanted. |
| `src/supports/commands/SettingsCommands.ts:47`, persisted settings records | `host/core/supports/settings` | Two **new required** fields: `neckMaxShift: 6`, `minClearance: 2` (engine 22). | **Migration.** Old `.mixo` saves have neither. Needs a default-fill on load (`src/supports/persist.test.ts` is the guard). This is what makes the band "a day" and not "small". |
| `src/supports/live/liveGeneration.ts:291` | *(behaviour, not API)* | Engine 58 drops the generic `scatterAngle` default from 50 to 45. mixoMesh passes `scatterAngle` straight through. | **Silent output change** on existing projects. Decide: pin 50, or accept 45 and say so. |
| `src/supports/spike.ts:86` | `host/supports/genericPlacement` | `placeGeneric` gains an optional 3rd `rules` param. | None — optional. |
| supports store / job layer | `host/core/supports/mesh`, `host/core/jobs`, `host/core/progress` | All **additive**: new optional result fields (`unresolved`, `footprint`, `modelLanded`, `lastResort`…), new optional `limits`/`rules` on jobs, new `GENERATE_PHASES` export. | None. Opt-in surface. |
| — | `host/supports/jobRunner` | `GENERATE_TIMEOUT_MS` **deleted**; `runSupportJob` gains optional `onPhase`. | **None** — the only consumer is inside the vendored file itself (`jobRunner.ts:48`). No app code imports it. |
| — | `geometryClient`, `meshClient`, `zones`, `supportCheck`, `vec3`, `unitSupports`, `zoneCheck`, `export`, `contactEdits`, `genericPolicy`, every `editing/*` except `addTip` | No export-signature change. | None. |

**The WASM ABI churned hard** (engine 25 replaced `timeout_ms` with `limits`; 26 added `rules`; 60
added `on_phase`) — but every one of those is absorbed by `host/supports/jobRunner.ts` and
`host/core/jobs.ts`, which are *generated files the re-vendor overwrites*. mixoMesh never touches the
raw ABI. This is the vendoring model working as designed.

**17 files mixoMesh lacks** (one more than the 16 counted from outside — `editing/uiFixture.ts` is a
test helper). 12 are `host/dental/denture*`/`dentalKind` — irrelevant. The 5 that matter:
`host/core/repairMesh.ts`, `host/core/removeDegenerate.ts`, `host/supports/generateRules.ts`,
`host/supports/generateLimits.ts`, `host/supports/plateArrange.ts`.

---

## 3. What is it losing?

From the version log in `host/geometryVersion.js` (geocore `b5a71ab`). Of 51 versions, most are
dentistry. These are the ones a general mesh tool should want:

**Worth the upgrade on its own:**

- **62 + 63 — Rust mesh repair and diagnose.** `diagnose_mesh` returns a *per-physical-body* report
  (triangles, signed volume, closed, boundary loops with each loop's length in mm, non-manifold
  edges, bowtie vertices, winding consistency, noise shells) where mixoMesh's `Diagnose.js` returns
  far less. `repair_mesh` welds, drops collapsed triangles, splits non-manifold edges and bowties,
  fixes winding per body — and critically **guarantees the physical-body invariant**: a step that
  would move a face between bodies abandons the repair and hands the file back *unchanged*, not a
  throw. 63 adds hole filling with a caller-set `max_fill_loop_mm` and a per-loop outcome code
  (filled / too-long / non-planar / self-intersecting / too-many-edges / …). This is a direct,
  better-specified replacement for `src/core/repair/` — and it would let mixoMesh **delete 1,644
  lines of JS and drop the MeshFixLib WASM engine entirely**. It also fixes a known mixoMesh gotcha
  recorded in memory: engine nondeterminism. *Guess, flagged:* I did not verify geocore's repair
  matches MeshFixLib's output quality on mixoMesh's 12 photogrammetry scans. That real-scan
  comparison is the whole basis for the deletion claim and must be run before acting on it.
- **46 — route speed, same results.** Slab test on BVH nodes and faces: `knot.stl` generic job
  **78 s → 21 s native**. Pure win, no behaviour change. mixoMesh is the app most likely to hit big
  generic meshes.

**Genuinely useful, general-purpose:**

- **53 — plate auto-arrange.** `arrange_plate(width, depth, …)` packs cases by footprint with a
  `plateGapMm` (6 mm) default, deterministic, frozen-case aware; `take_footprint()` gives the case
  outline. mixoMesh has **no arrange implementation at all** (searched — only i18n strings and
  context-menu entries match "arrange"), so this is new capability, not a replacement. For a
  multi-object print-prep tool this is a visible feature.
- **37 + 49 — the grid raft.** Opt-in (`raftGrid` off by default). 49 redesigned it: 2 mm tall,
  triangle grid of ridges turned off the outline's dominant edges, ridges narrowing to a 0.3 mm flat
  top, edge-band wall leaning out 40°. Useful to mixoMesh **only if it ever prints on resin**; for
  Mimaki UV-inkjet and filament (its stated targets, `AGENTS.md:8-16`) a raft is less relevant.
  *Honest read: lower value here than the task brief assumed.*
- **30 — the space map** replaces the route drop map and outline raster; `outlineGridMm` renamed to
  `spaceCellMm` (same slot). Placement is *meant* to stay equal. Infrastructure, invisible.
- **41 — hard tip rules.** Every support path leaves the surface outward and stays outside the model;
  tips that don't face down are left out, with the rule named (`tip-check:facing / fold / neck-inward
  / inside / cone`). Correctness, applies to generic meshes.
- **29 — trunk supports** replace trunk legs (helper pillar + short neck + braces). Generic.
- **26 + 25 + 60 — the rules/limits/phase ABI.** Lets a host override planner rules, set time
  limits with a `stop_reason()`, and drive a staged progress bar from nine real engine phases
  instead of a spinner. mixoMesh already has the i18n plumbing for stage codes
  (`progressLabel.ts:1-6`) and would get a better bar nearly free.

**Not relevant to mixoMesh:** 13-24, 27-28, 31-35, 42-45, 47-48, 50-52, 54-59, 61 — denture and
aligner profiles, rim detection, resin traps, tilt scans, oral-cavity rays, socket masks. Roughly 35
of the 51 versions. 56 (file-part splitting) is dental-scoped but the underlying `surface/parts.rs`
idea would suit multi-shell imports; not exposed generically.

---

## 4. Is the stamp mechanism sound?

**Yes, and it is wired — including in CI.** The outside suspicion that "the check exists and nothing
runs it" is **wrong**.

- Stamp: `public/vendor/mixo-geocore/SOURCE.json` — repo, commit, commit date, `engineVersion`, and a
  sha256 per vendored file, covering both the engine in `public/` and the TypeScript in
  `vendor/mixo-geocore/{host,editing}`.
- `node scripts/vendor-geometry.mjs --check` → **exit 0**: *"mixo-geocore engine 12 (6cc5385)
  verified in public/vendor/mixo-geocore and vendor/mixo-geocore"*.
- It runs on every push: `tests/geometry-engine.test.mjs:41-44` spawns `--check` and asserts
  `status === 0` → picked up by `test:node` (`tests/*.test.mjs`) → `npm test`
  (`package.json:14`) → `.github/workflows/deploy.yml:38`.
- A second guard at `tests/geometry-engine.test.mjs:33-39` asserts the version gate refuses
  `HOST_GEOMETRY_VERSION ± 1`, and `tests/vendor-release.test.mjs:46-61` proves the release path
  catches both a tampered tarball and a hand edit to a vendored file.

**No fix needed.** There is no `vendor:check` npm script (only `vendor:geometry`,
`package.json:59`) and there does not need to be — the check runs as a node test, which is strictly
better, because it cannot be skipped by someone running `npm test` instead of a bespoke script. If a
convenience alias is wanted anyway, it is one line: `"vendor:check": "node
scripts/vendor-geometry.mjs --check"`. Not applied.

---

## Cost to re-vendor 12 → 63: **a day**

Not *small*, not *a project*.

**Why not small:** two new required settings fields (`neckMaxShift`, `minClearance`) mean old `.mixo`
saves need a default-fill migration with a persistence test; the `minFromUpDeg` → `overhangAngleDeg`
rename inverts its semantics so the 5 sites need thought, not search-and-replace; `scatterAngle`'s
default silently moves 50 → 45, which changes support output on existing projects and is an owner
decision; and the support smoke suite is ~10 scripts (`test:supports-*`, `test:support-*`) that all
need a run, three of them in browser/preview/Electron variants.

**Why not a project:** every vendored file is replaced wholesale, so the hard ABI churn (engine
25/26/60 reshaping `generate`) never reaches app code. `npm run typecheck` enumerates the entire
blast radius *before* anything runs, and that radius is 5 call sites plus one migration. The vendored
copy is unmodified, so there is nothing to re-apply. `--check` and the version gate make a partial or
botched vendor fail loudly rather than silently.

**Sequence:** `vendor:geometry --from S:\ai\mixo-geocore --packages-only` → `typecheck` → fix the 5
sites + the settings migration → decide `scatterAngle` → `npm test` → the supports smokes →
real-scan gate on both apps (memory rule) before touching `src/core/repair/`.

The repair-stack deletion is a **separate, later** piece of work — it needs the real-scan comparison
first, and bundling it with the re-vendor would make both un-reviewable.

## Is the gap costing anything today?

**Not in correctness — in duplicated work.** mixoMesh ships and its tests pass. What it pays is
1,644 lines plus a second WASM engine it maintains alone, a 3.7× slower route on heavy generic
meshes, and no plate arrange. Nothing is broken; the bill is maintenance, and it grows every time
geocore ships repair work mixoMesh then has to not use.

## Not checked

Did not run mixoMesh's test suite or typecheck against engine 63 (reading task, as instructed), so
the break list is from export-signature diffs and `path:line` call-site greps, **not** from a compiler
— there may be further type errors inside the 20 differing files' internals. Did not diff `editing/`
module *behaviour* beyond exported signatures, did not read geocore's `crates/` Rust side, and did
**not** verify that geocore's `repair_mesh`/`diagnose_mesh` matches MeshFixLib's quality on the 12
photogrammetry scans — which is the one thing that would confirm or kill the "delete 1,644 lines"
claim. The engine-12 `.wasm` was not executed against engine-63 fixtures, so silent behavioural
changes beyond `scatterAngle` (e.g. engine 59's socket-mask rule) are unverified for mixoMesh.
