# One notion of parts, and the UI that lets the operator own it

**Status: plan, not approved. Nothing here is started.** Written 2026-11-12, after the owner asked
whether everything he had specified was organised and planned. It was not — half of it was in two
handoffs and one piece was only in conversation. This is the single ordered list.

The owner set the order himself: **geocore first, before any further app review.** Both apps vendor
from geocore, so fixing it upstream costs one re-vendor each instead of two app-side workarounds
that then have to be unwound.

---

## 1. What was asked, and where each piece lands

| # | What the owner asked for | Unit | Repo | Gated by |
|---|---|---|---|---|
| A | Generic support generation available in mixoMesh | **U7** | mixomesh | U6 |
| B | Faces where two meshes of one object intersect get no support | **U1** | geocore | — |
| C | Dental main object keeps its special treatment; the other meshes get supports on their **exposed faces only** | exists (dental), **U1** (generic) | geocore | — |
| D | The same overlap rule applies to generic supports (body + arm) | **U1**, surfaced by **U7** | geocore → mixomesh | U1 |
| E | Mesh-count detection respected in **both** apps | **U1** + **U3** + **U6** | all three | U1 |
| F | Fix mesh / fill holes / weld vertices while respecting independent meshes | **U2** | geocore | — |
| G | Identify meshes when loaded to the scene; repair only on request | **U2** (decided: identify at load, repair never at load) | geocore | — |
| H | Split meshes into objects; merge objects into one | **U5** | mixomesh | U4 |
| I | Support gen respects by object (overlap inside one object gets nothing) | **U1** + **U7** | geocore → mixomesh | U6 |
| J | Merge uses the active object's origin | **already true** (`JoinCommand`; the active object becomes the lead) | mixomesh | — |
| K | Split origin "each mesh's centre" | **U5**, corrected: the bounding-box centre of the **picked set**, since N meshes become ONE object with one origin | mixomesh | U4 |
| L | A separate mode for splitting: hide everything, isolate the active object, dim its parts, click / shift-click to pick, picked parts brighten, confirm makes one new object | **U4** + **U5** | mixomesh | — |
| M | In that mode, grey or darken all UI and background; a notice says what to do; a button accepts | **U4** | mixomesh | — |
| N | Rename objects easily | **exists** (F2, row double-click, context menu, scene-wide `.001` collision rule) — **U5** adds part-row rename and makes the collision visible | mixomesh | U4 |

**Two of these were in no document before this one:** M (the focus treatment) and the fact that A is
blocked behind a 12 → 65 re-vendor rather than being a feature that can be written.

---

## 2. The order, and the one sequencing trap

```
U1 ─ geocore: one part list for both policies          ─┐
U2 ─ geocore: repair splits parts before it welds      ─┤── engine 65
                                                        │
U3 ─ mixodental: re-vendor 64 → 65                     ←┘
U6 ─ mixomesh: re-vendor 12 → 65                       ←┘
U7 ─ mixomesh: generic supports honour parts           ← U6

U4 ─ mixomesh: the focus-mode module                    (no engine dependency: can run in parallel with U1/U2)
U5 ─ mixomesh: scope depth = parts, separate + merge    ← U4 AND U1 step 4 (see 3b/C3)
```

**THE TRAP: U4 and U5 can ship before the engine, but they must not promise what only U7 delivers.**
On engine 12 `partsToEngine` (`src/supports/frame.ts:105`) concatenates and welds and nothing more,
so **merged overlapping parts get tips in the overlap today**. If the separator mode tells the
operator that grouping controls support placement before U7 lands, the UI is making a claim the
engine cannot keep. Until U7: the mode groups, renames and separates, and says nothing about
supports.

**The rule the whole plan serves**, worth holding onto because the first draft of it was wrong:

> An object is one print — the engine decides from geometry which faces of **that one object** are
> buried and never supports them; grouping decides only which meshes are in the object; and two
> **separate** objects that overlap are a collision to **report**, not a fusion to assume.

---

## 3. The units

### U1 — geocore: one part list, both policies (engine 65)

`surface::parts::split` is already in the shared path (`crates/geometry-core/src/surface/parts.rs:218`).
What is dental-only is the masking.

1. Move `hidden_faces` and `inside_other` out of `dental/denture/parts.rs` into the shared surface
   path.
2. **Drop the "any `Fused`" condition** (`dental/denture/parts.rs:80`): today the hidden mask is
   computed only when something overlaps the *target*, so two add-ons overlapping each other get no
   mask. Rare in a dental file; the normal case for a body and two arms.
3. Give the generic policy the part list and the hidden mask, so "outward-facing" means outward *per
   part* and buried faces get nothing. **By promoting `add_on_tips` out of `dental/`, NOT by adding
   a mask to `generate_placement` — that was tried on 2026-11-12 and measured insufficient:** the
   edge/ridge and island streams reach faces independently of the downward map, so masking the
   downward faces emptied the regions and still left 184 contacts, and `PlacedPoint` carries no face
   to filter on. Reverted. See `docs/parts-weld-repair.md` §8 in geocore, which owns this fact.
4. **A host-declared target.** The engine picks the largest part as target and calls a small one
   debris — "reported, never supported" (`surface/parts.rs:16-18`). The operator's active object is
   not necessarily the engine's main body, so the host must be able to say which part is the target.
5. Expose the part list and roles to the host, for step 5 of the dental plan's §3c (show roles before
   generate).

**Done when:** a generic build on a two-body mesh plants nothing on faces buried inside the other
body; two add-ons overlapping each other are masked; the goldens are re-taken and `engine_version()`
is 65; the 16 snapshots pass.

**Open question for the owner, with my answer:** should a `debris` part in a *generic* (non-dental)
object still get no supports? **My answer: no — report it, support it.** "Debris" is a dental
judgement about scan noise; in a generic object a small part is as likely to be a deliberate detail.
Make the debris rule dental-only and have the generic policy support every part it is given.

### U2 — geocore: repair splits parts before it welds

Fable measured engine 64's repair on synthetic denture-and-hook cases. Two failures, both on the
owner's exact case:

- A shared **patch** of identical triangulation makes every patch edge four-faced, so the patch is
  **torn off both shells** — two watertight solids became six open pieces, and with fill on, 8
  triangles were invented and it reported watertight.
- If either shell is **open** where they meet, the two **fuse into one closed shell, reported
  watertight, with no alarm.**

The cause: `weld_map` merges every bit-identical position unconditionally
(`core/proximity.rs:219-220`); the edge guard is only in the near pass. What saves *closed* shells is
the later non-manifold split, which handles point and line contact but not an area patch.
`pair_around` (`surface/parts.rs:110`) resolves it and the manifold step does not call it.

1. **Split parts first**, on the import-welded mesh, before the repair weld.
2. Forbid the exact-pass weld from merging across two parts.
3. Have the manifold step use `pair_around` where it can pair, instead of shattering a four-faced
   edge.
4. Fill **per part**.
5. Recognise a zero-area rim as a **crack** and report it as such, not as `fill-degenerate`.
6. Leave `merge_near` uncalled. It has no topology guard and would collapse real short edges.

**Done when:** the shared-patch case keeps both shells whole; two open rims meeting are **reported**
rather than fused; each case has a test; and the honest guarantee is no longer only "closed shells
are never fused".

**And repair stays an explicit operator action, never a step at load.** What belongs at load is the
lossless half — weld at noise scale, split parts, diagnose, report — which is what mixoDental's
import already does. Repair changes what gets printed, so it needs the operator's hand and a
before/after.

### U3 — mixodental: re-vendor 64 → 65

Mechanical, after U1 and U2. The 64 re-vendor's receipt is the template: `npm run gate` with the 13
real scans is the evidence that engine output did not move.

### U4 — mixomesh: the focus-mode module

**This is the piece the owner asked about by name, and it is the right call for a reason that is
already in the code: there are about to be two callers.** `SupportMode.ts:119-134` holds
`applyMask` / `clearMask` as a closure, and the separator mode needs exactly the same behaviour.
Fable's reading agrees: "the mask is a closure and needs extracting to reuse."

It also passes this repo's extraction test — **a module is clean when its output is narrower than its
input.** It takes which objects stay lit; it hands back everything else dimmed, the chrome inert, Esc
wired and undo scoped. That is a job, not a hub.

**It is parameterised per caller, because the owner's requirement is that the UI chooses what to dim
and whether to hide other objects at all.** One call:

```
enterFocus({
  name,      // -> #app[data-mode="<name>"], and the undo scope's label
  keep,      // object ids that stay lit. EMPTY = do not touch the scene at all
  live,      // the panels that stay interactive. Everything else dims AND disables
  notice,    // { message, primary: { label, onPick }, onCancel }
})
```

**`live` declares what stays bright, never what dims — and that direction is the whole safety
property.** List what to dim and every panel added later stays interactive in every focus mode by
accident, which is a bug nobody notices until a user clicks it mid-task. List what stays live and a
new panel dims by default; the worst case is a panel the caller forgot to allow, which the user
reports in a sentence.

`keep: []` is a real and useful case: the chrome dims, the viewport is untouched, nothing is hidden.
That is what an "inspect this problem" mode wants — focus without isolation. So the module serves
three callers, not one:

| caller | keep | live |
|---|---|---|
| separator mode (U5) | the active object | outliner + the focus notice |
| Support Mode (today's behaviour, unchanged) | the selected objects | the support panel |
| a future problem-inspect mode | `[]` — scene untouched | the problem list |

**What the module owns:**

| | |
|---|---|
| the layer mask | from `keep`; and a restore that puts every `layerMask` back exactly |
| the mode attribute | `#app[data-mode="<name>"]` for per-mode styling, if a mode wants any |
| the chrome | every panel not in `live` gets `data-focus="dim"` and is genuinely disabled — `disabled` or `pointer-events: none`, never greyed-but-clickable. **One CSS rule on `[data-focus="dim"]` serves every mode**, so adding a mode needs no new CSS |
| the notice slot | one `.mx-notice` with `.mx-notice-actions`, always live whatever `live` says |
| the keys | Esc cancels; mutual exclusion is free because `InputManager._mode` is a single slot |
| undo | scoped on enter, released on exit |

**What it must NOT own:** what the mode *does*. Separating parts, generating supports — that stays
with each caller, or the module becomes the hub this repo's rule exists to prevent.

**The inversion to get right (M):** the existing `.mx-modal-scrim` is `position: fixed; inset: 0` and
covers the canvas. Focus mode needs the opposite — **dim the chrome, leave the viewport bright**, with
the isolated object the one thing at full brightness. So it is a new treatment built from the same
tokens, not the existing scrim reused.

**Notice copy, in the house style — say the effect and the count, never "Accept":**

| state | notice | primary |
|---|---|---|
| nothing picked | "Click the parts to separate. Shift-click to add." | **Separate** — disabled, and the notice says why |
| 3 picked | "3 parts selected." | **Separate 3 parts into a new object** |
| all picked | "That is every part; nothing would be left." | disabled |

Every element gets a unique stable `data-ui` name (`focus-notice`, `focus-accept`, `focus-cancel`).

**Done when:** Support Mode uses the module with **no behaviour change** and every browser smoke that
drives it still passes. That is the whole acceptance test — an extraction that changes behaviour is a
rewrite wearing an extraction's name.

### U5 — mixomesh: scope depth = parts, separate and merge

Half of this exists. `JoinCommand` merges and the active object already becomes the lead;
`SplitToPartsCommand` separates by material, all parts at once; the click-depth scope (click = whole,
double-click = enter, Esc = out) works **on groups only** (`src/core/Selection.js:358-431`).

**Decision: extend the scope, do not add a third mode.** Double-click on an object is unbound today
(`src/core/InputManager.js:375`). Bind it to enter the object with **parts** as the selectable depth,
use U4 for the isolation, and give it one action: "Separate selection" → one new object. Gizmo off
inside.

With the gaps Fable ranked, worst first:

1. **Merge must not hide the other object's supports.** They live on the lead only
   (`src/supports/store.ts:15-26`) and the link snapshot excludes them
   (`ParentCommands.js:531`), so if the lead had none, nothing is stale, export is not blocked and
   **the print goes out unsupported**. Drop the merged-away record with a visible warning.
2. **Merge then Repair** runs on the welded union of a logical object
   (`src/core/repair/RepairSession.js:205-217`) — U2's case. And the repair record replays at load
   (`ProjectLoader.js:624-632`), so repair → split → save reloads as different geometry. Block or
   invalidate; do not leave it to chance.
3. **Names**: parts are renamed `<lead>.00N` (`ParentCommands.js:580`), so "hook" merged then
   separated returns as "denture.001". Keep the original name through a merge, derive on split, and
   let part rows be renamed (`Outliner.js:478, 649` makes them inert today).
4. **Origin**: the bounding-box centre of the picked set, and only where new geometry is minted.
   Nothing may move in world space — the plate position is what matters.
5. **A topological split must mint owned geometry** as derived assets, the way Boolean does
   (`BooleanCommands.js:162-178`), because engine part ids are not stable. It must implement
   `retainedTriangles` / `release` or the undo cap evicts history
   (`HistoryManager.js:77-94`).
6. **Export uses the lead's ratio** (`PrintPipeline.js:452`); merging objects with different ratios
   is unguarded.

**Two hard constraints:**

- **Add no new per-object field to the save format.** `logicalObjectId` and `isInternalPart` are
  already saved at schema 3.6, and an older build whitelists per-object fields on load
  (`ProjectLoader.js:596-618`) — a new one is dropped, then lost on that build's next save. Derived
  assets make split results plain objects to any build.
- **Never `Mesh.MergeMeshes`.** It bakes world transforms into one vertex buffer, its multi-material
  form produces exactly the MultiMaterial mesh the import path exists to eliminate
  (`src/core/assets/MeshSplit.js:1-15`), and it breaks the `containerMeshIndex` reload depends on.
  The link model already in place is the right one.

**Done when:** a user can enter an object, pick parts, separate them into one named object, merge it
back, and undo each in one step; supports are never silently orphaned; and a project saved after a
split reloads identically on a build that predates it.

#### 2026-11-13: gaps 1 and 3 are FIXED, ahead of the UI, because both were live defects

Neither needed the separator mode. Both were wrong in the app as it shipped, so they went in first.

**Gap 1 — a Join orphaned the swallowed object's supports.** Supports live on the lead and every read
redirects there (`src/supports/store.ts`), so merging a supported object into an unsupported one left
the record unreachable AND still in the save file: nothing stale, export not blocked, **the print
goes out unsupported**. `JoinCommand` now snapshots those records, drops them, and raises a warning
toast naming the objects (`toast.joinDroppedSupports`, three locales); undo restores them whole. The
record is read straight off `state.scene.objects` -- a command in core must not import the support
modules, and the record is only a field there. Guarded in `tests/split-join.test.mjs`, verified by
removing the drop and watching the test fail.

**What was NOT a defect, checked rather than assumed:** the lead's own supports after a merge. The
logical object's geometry union changed, so they must go stale -- and they do: `_applyLinkPatches`
already dispatches `OBJECT_UPDATED` per patched id, `sourceHash` already covers the whole union
(`sceneSource.ts`), and the stale watch forgets the hash on that event. Now pinned at both seams:
the join test asserts the lead is reported updated, and `stale.test.ts` asserts a membership change
marks it `geometry` (through a PART id too) and clears on undo.

**Gap 3 — a split replaced a name the operator chose.** `SplitToPartsCommand` renamed every non-lead
part `<lead>.00N` unconditionally, so "hook" merged into "denture" came back as "denture.001".
`_isDerivedName` now tells a derived name (the lead's own name, the import's `<lead>_primitive1`, an
earlier split's `<lead>.001`) from one the operator chose, and only derived names are replaced. The
import case the 2-part test pins is unchanged, which is the point: that rename IS wanted.

**Still open for U5**: the UI itself (double-click to enter an object with parts as the depth, the
isolation dimming, the notice and its accept button), C2's recorded parent, gap 2 (merge then
Repair), gap 4 (origin), gap 5 (derived assets with `retainedTriangles`/`release`) and gap 6 (the
lead's export ratio).

### U6 — mixomesh: re-vendor 12 → 65

The plan's §4 (in `S:\ai\mixodental\docs\design\2026-11-12-three-repo-refactor-plan.md`) holds the
steps and they stand: **capture and commit the engine-12 baseline first**, estimate with the
type-checker and the smokes rather than signature diffs, `scatterAngle` 50 → 45,
`minFromUpDeg` → `overhangAngleDeg` where the four `0` sites become **180**, and default-fill
`neckMaxShift` / `minClearance` in `SupportsPersist.js:36-44` for old `.mixo` saves.

**This plan is what fires §4's trigger** — "mixoMesh needs a named engine feature it cannot have at
12". That feature is the part list.

### U7 — mixomesh: generic supports honour parts

Only reachable after U6. `partsToEngine` (`src/supports/frame.ts:105`) stops being a concatenate-and-
weld and starts passing the part list; the hidden mask reaches the generic policy; and the overlap
promise becomes true, at which point the separator mode may say so.

**Done when** a body-and-arm object gets no tips in the overlap, and the part count and roles are
shown before generate.

#### U7 is NOT a drop-in, and the blocker is contact IDS (found 2026-11-12, after U6 landed)

The obvious reading of this unit is "call `part_tips` instead of `placeGeneric`". That cannot be
done as written, for a reason worth stating before anyone tries it:

**`part_tips` returns different contact ids.** `supports::part_tips::tips_on_part` builds them as
`format!("part{part}-{id}")`, so a contact the generic path calls `auto-215_100_-485` becomes
`part0-auto-215_100_-485`. And **contact ids are the save format's keys**: `deleted`, `overrides`
and the manual list in every `.mixo` record are keyed by them. Switching the live path to
`part_tips` invalidates the hand work in every project the app has ever saved.

**And the cheap alternative does not exist yet either.** The obvious way to keep the ids is to place
as now and then drop any contact standing on a buried face -- but `PlacedPoint` carries
`id`, `position`, `normal`, `source` and **no face**
(`crates/geometry-core/src/generic/placement/mod.rs:83-90`), so the host cannot tell which contact is
on which face. `part_tips` knows (it returns `tip_faces`), which is precisely the thing that cannot
be used without the id change.

**Recommended: add the face to the generic placement's output.** `PlacedPoint` gains `face: u32`,
which is additive, needs no id change, needs no save migration, and lets the host drop buried
contacts itself from the mask `part_tips` already exposes. That is an engine change (66) and a small
one; the alternative is an id migration across every saved project, which is not a small one.

**Until then the mask is reachable but unusable in the live path**, so the separator mode must keep
saying nothing about supports (the trap at the top of this plan), and a body-and-arm object still
gets tips in its overlap. The requirement is not met and this is why.

#### DONE at engine 67, and the fix was smaller than the one recommended above

The recommendation was to give `PlacedPoint` a `face: u32`. Reading it through, that is wider than it
looked: `Candidate` carries no face either, so a face would have to be threaded through all four
placement streams, and an edge anchor sits on a boundary between faces, so "its face" is a design
question rather than a lookup. `tips_on_part` answers that question with a nearest-triangle search
AFTER placement, which is the hint: the face is derived, not carried.

And the host never needed a face. It needed **one boolean per contact** -- is this contact buried
inside another part of the same object -- which is what the dental path has asked per tip since
engine 50 (`Overlap::blocked`). So:

- **engine 66** exposed it: `contacts_buried(positions, indices, points, radius, debrisMm)`, one byte
  per point. Placement is untouched, so no contact is renamed and no saved project needs migrating.
- **engine 67** applies it: `runPlacementJob` drops what it marks
  (`host/supports/buriedContacts.ts`, pure and tested without the engine), so EVERY generic
  placement in both apps now honours the overlap rule, not only the dental one. Free on a
  single-part file: the engine returns all-false without running a test.
- The own-part lookup went down into `Overlap::own_part`, which uses the ray index it already
  builds instead of scanning every face. A full-scan comparison in `parts.rs` guards the answers,
  because a speed-up is invisible unless it is wrong.

**The requirement is met**: a body-and-arm object keeps each mesh's own supports and gets none in the
overlap, and the system still knows which part is which (`faceParts`, `parts`, `hidden` from
`partTips`). What U5's separator mode may now say about supports follows from this, so the trap at
the top of this plan is lifted for the LIVE path.

---

## 3b. Coherence pass: what contradicts, and what each app means by "overlap"

Checked 2026-11-12, after the owner asked whether the functions, intentions and UX all complement
rather than contradict. Most do. Four did not, and one of those is an ordering bug in this plan.

### C1 — THE TWO APPS MEAN OPPOSITE THINGS BY "TWO OBJECTS OVERLAP", and that is fine

mixoDental's stance is already in its UI: the Arrange command's hint reads *"Move the objects so
none overlaps another."* Overlapping objects there are an **arrange error** — a plate problem with a
button to fix it — and `PlateLedger` reserves plate space so two concurrent imports cannot land on
each other. Nothing in mixoDental reports a geometric collision between objects, because the app's
whole stance is that the state should not exist.

mixoMesh is an editor. **Overlapping objects are normal and intended** — an arm on a body is the
example the owner gave. And the separator mode's entire purpose is to *create* that state
deliberately.

So the engine's rule is right to be per-object, and **each app owns what an inter-object overlap
means**: an error to fix, or a normal state. The engine reports; the host judges. Written down
because the opposite reading — one shared verdict on inter-object overlap — would make one of the
two apps wrong by construction.

### C2 — SPLITTING UN-MASKS THE OVERLAP, AND NOTHING CATCHES IT (the real contradiction)

The rule holds *within one object*: the engine masks faces of one object buried inside another part
of **that same object**. So:

- body + arm as ONE object → the overlap is masked → no supports there. Correct.
- separate them into TWO objects → the overlap is no longer within one object → **the mask stops
  applying and both get supports inside solid material.**

Those supports can be neither printed nor removed. It is the owner's original worry, arriving
through the door the separator mode opens. And nothing would catch it: mixoDental has no
inter-object collision report (C1), and mixoMesh has none either.

**Recommended fix, and it is cheap: the split RECORDS THE PARENT.** Then generation can say, at the
moment it matters:

> These 2 objects were split from one assembly and overlap. Supports in the overlap cannot be
> printed. **Merge them** / **Generate anyway**.

Why this and not the alternatives: masking across objects would break the per-object storage the
rule exists to protect (moving B would stale A's supports); forbidding the split would remove the
feature; and saying nothing is the silent failure this codebase audits for. A recorded parent is one
field the serialiser already has a home for — `logicalObjectId` — and it makes the warning possible
without changing what supports are.

**This is a precondition on U5, not a nice-to-have.** A separator mode that ships without it turns a
masked overlap into an unprintable one on the first use.

**2026-11-13: C2 stopped being theoretical.** When it was written the generic path ignored parts, so
"splitting un-masks the overlap" described a mask that was not applied either way. Engine 67 applies
it, so the asymmetry is now real and measurable: one object with an overlap gets no contacts there
(`sunk-pair` in the baseline), and the same geometry as two objects gets them. Nothing else changed
about the recommendation.

**A related coherence check, and it comes out clean.** A user hand-adding a support onto a buried
face is NOT a new hole: the engine's tip rules (engine 41) already leave out a hand-placed tip whose
path would enter the model, and the build reports it through `dropped`, which the panel shows. So the
automatic path drops buried contacts before the build and the manual path drops them during it --
two mechanisms, one outcome, both visible. Nothing to reconcile.

### C3 — AN ORDERING BUG IN THIS PLAN: U5 needs U1 step 4, not only U4

The dependency diagram above says U5 depends on U4 (the focus module). It also depends on **U1 step
4, the host-declared target**, and for a reason Fable measured: the engine picks the **largest part**
as the target, while `JoinCommand` makes the **active object** the lead. Merge a small hook into a
denture and the operator's active object is the hook, the engine's target is the denture, and the
lead is what decides where supports are stored and which ratio export uses. Those must agree before
a merge UI exists, or merging quietly produces the wrong target.

So: **U5 depends on U4 and on U1 step 4.** The diagram is corrected.

### C4 — "DEBRIS IS DENTAL-ONLY" LEAVES NOISE SHELLS SUPPORTED

My recommendation in U1 stands — `debris` is a dental judgement about scan noise, and in a generic
object a small part is as likely to be a deliberate detail, so the generic policy should support
every part it is given. But the consequence has to be carried with it: **a generic object with scan
noise will get supports on the noise.**

The complement already exists in the engine — the noise-shell report (0.001 mm³, "report only",
never deleted). It has to surface in the generic flow so the operator can remove the shells rather
than print them. Without that, this recommendation trades one silent wrong for another.

### What checks out

- **Grouping does not decide physics.** The rule is per-object and geometric; grouping decides only
  which meshes are in the object. Settled, and the owner's original "respects by object" was the
  correct wording.
- **Identify at load, repair on request.** Complementary: the lossless half runs at import, the
  lossy half waits for a hand. Nothing in the plan asks repair to run unasked.
- **`keep: []` and isolation.** The focus module serves focus-without-isolation and
  focus-with-isolation from one call; the separator mode is one caller of three.
- **Dimmed means disabled, and the outliner stays live.** No conflict: the outliner is in `live`
  precisely because the operator verifies the picked set there.
- **Merge takes the active object's origin; split takes the bounding-box centre of the picked set.**
  Asymmetric but not contradictory — merge has an obvious anchor and split does not. Worth knowing
  that **merge → split → merge is not origin-identity**; nothing moves in world space, so for print
  prep this is benign, and it is written here rather than discovered.
- **An open scan gets no hidden mask** (`inside_other` is a parity test needing a closed part), so
  the UI must say so rather than imply the overlap was handled. Already U1's gap 6.

## 4. Not in this plan, on purpose

- **Pushing or publishing anything.** mixoMesh's push deploys to Pages; that is the owner's call.
- **The 0.3.2 installer.** Unsigned, no update channel, and `installers/` still holds 0.3.1 from
  2026-10-23. A release decision, not this plan's.
- **`test:all`'s flakiness.** One Vite start-up probe timed out on 2026-11-12 while Vite had printed
  ready; the suite passes alone. 23 suites chained with `&&`, most starting their own Vite, means one
  hiccup fails the chain and hides every suite after it — which is how two real defects hid behind
  each other earlier that day. The fix is a retry on the probe, not a longer timeout. Worth doing
  before U5 adds more browser tests, and written down here rather than left as folklore.
