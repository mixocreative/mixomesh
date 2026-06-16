# MIXOMESH full-application audit — 2026-06-16

## Remediation status (2026-06-16)

**Bonus fix (found via H1 round-trip smoke):** saving DURING an import/duplicate
bounce-in animation serialized the transient pop scaling (the bounce multiplies
live node scaling; `_serialiseSceneObjects` decomposes the world matrix). A
duplicate saved mid-pop reloaded permanently shrunk (~0.68×, frame-timing
dependent). Fix: `ImportBounce.settleImportBounce()` snaps all in-flight
bounces to resting scale; `_buildDocument` calls it before capturing transforms.

**Fixed + verified** (typecheck · 74 headless · build · i18n · browser + export smoke):
R1 (dup multi-primitive relink — `_remapDuplicateLogicalObjects`, regression-tested),
R2/R3 (exportRatios excluded from per-user settings SCHEMA + tests),
R4 (relinkAsset `_reBaked` guard), R5 (ShaderPanel assign expands logical parts),
R6 (multi-primitive active outline — `setActive` accepts a list),
R7 (followActive unions all part bounds), R8 (scale-tab example uses the active object),
M2 (validation stale-flag race — invalidation seq), M3 (unlit shader emissive colour),
M4 (imported UV transform harvested), M6 (follow suspended during offline render/capture),
M8 (G/R/S modal honours pivotMode), M9 (printPreview/baseColor inspectable-mesh guard).

**All HIGH + MEDIUM findings now resolved (2026-06-16).** The originally-deferred
batch (H1, M1, M5, M7, M10) was worked one at a time with a verification gate per
fix — see each entry below. Only the LOW findings remain open (tracked at the end).

- **H1 (HIGH) — duplicated objects collapse on reload. FIXED 2026-06-16.** Correct fix = give each
  duplicate its own `assetId` + cache its baked bytes at clone time so it
  serializes independently. The clone-on-restore shortcut breaks
  `containerMeshIndex` on the next save and leaks the clone on reset — do it
  properly with a round-trip test.
- **M1 — autoFix edits lost on reload. FIXED 2026-06-16.** The Print-tab
  Auto-Fix button records applied fix types on the SceneObject (`geometryFixes`);
  persistence serializes them and replays via `MeshValidator.replayGeometryFixes`
  on load, AFTER the ratio bake so the weld's absolute MERGE_DISTANCE behaves the
  same. Browser-smoke round-trip asserts a normal-flip survives reopen.
- **M5 — SmartReplaceCommand drops multi-part objects. GATED 2026-06-16.**
  `_smartReplace` (ContextMenu.js) now refuses with a toast when the active
  object or any target is a multi-part logical object (`logicalObjectPartIds > 1`),
  preventing the data loss. Full multi-part replace (clone the whole part set,
  replace each target as a unit) is the eventual fix; gated for now.
- **M7 — autosave loose-drop → ghost. FIXED 2026-06-16.** `_serialiseAssetLibrary`
  now embeds bytes on autosave (skipEmbed) when an asset has NO live-recovery
  tier (no dir/file handle) — handle-backed assets still skip (A9 perf intact),
  container-owned textures still never carry standalone bytes. The A9 test was
  rewritten (A9/M7) to assert both halves: handle-backed skips, loose-drop embeds.
- **M10 — cross-section fill clone doesn't follow live moves. FIXED 2026-06-16.**
  The fill clone now copies the source world matrix into its (unparented) TRS
  every frame in its existing onBeforeRender, so it stays locked to the solid
  through drags/gizmo/undo; `initViewEffects` also replays `_updateSectionViz`
  on `TRANSFORM_COMMITTED` to rebuild the bounds-based border. Clone stays
  parent=null (exclusion model intact). Browser-smoke `capFollows` guard.
- All **LOW** findings below remain open (tracked here).

---

# (original audit follows)
# MIXOMESH full-application audit — 2026-06-16

Multi-agent subsystem audit (11 reviewers + adversarial verification per
non-low finding). 51 raw findings → **44 confirmed**. Lens: the failure modes
hit this session — `.mixo` round-trip fidelity, source-of-truth/domain coupling,
logical-object completeness, undo correctness, perf, the Mimaki full-res lock.

Severities are the verifier-adjusted values. Medium/high were independently
re-checked against the code; low were passed through (reviewer confidence only).

---

## ⚠ Regressions introduced or exposed by THIS session's work
These stem from the per-object-ratio + multi-primitive-grouping changes and
should be fixed first.

- **R1 (HIGH) — Duplicating a glTF multi-primitive object splits it into N unlinked objects.** `HierarchyCommands._remapDuplicateLogicalObjects` only remaps `logicalObjectId` inside the `if (sourceObj.sourceGroupId)` branch; multi-primitive parts (sourceGroupId=null) lose their grouping on duplicate. Fix: remap `logicalObjectId` for the logicalObjectId-only case too (use `leadCloneByOldLead`), mint a new sourceGroupId only when the source had one.
- **R2 (MEDIUM) — exportRatios leaks across projects via per-user localStorage.** `SettingsStore` `print` slice is `fields:null` (whole-object), so `print.exportRatios` (per-project content) is persisted to `mx-settings-v1` and `seedBootState` re-applies it on New/boot → a fresh project inherits the last one's targets. Fix: narrow the `print` SCHEMA to an allow-list excluding `exportRatios` (+ update settings-store test). (R3 below is the same root cause.)
- **R3 (MEDIUM) — print SCHEMA stale vs the redesign** — same fix as R2; realign SCHEMA + config + the settings-store test's intent.
- **R4 (MEDIUM) — relinkAsset re-bakes ratio without the `_reBaked` guard.** `_loadProject` passes the WeakSet; `relinkAsset` (line 781) doesn't → if two objects alias one restored mesh, ratio bakes twice (compounded scale). Fix: thread a shared WeakSet, mirroring `_loadProject`.
- **R5 (MEDIUM) — Shader Assign button only shades the lead primitive.** `ShaderPanel` assign passes raw `Selection.getSelectedIds()` (lead ids) without `logicalObjectCommandIds` expansion (Outliner + Properties slot both expand). A multi-primitive object re-shades only one part. Fix: expand before `ShaderAssignCommand`.
- **R6 (LOW) — Active multi-primitive object shows two outline colours.** `Selection._applyVisuals` marks only the lead part active; sibling primitives go to the selected (dim) tint. Fix: treat all `logicalObjectPartIds(activeId)` as active.
- **R7 (LOW) — followActive camera centres on one primitive** of a multi-part object. Fix: union all part bounds.
- **R8 (LOW) — Scale-tab example dims** use the active object's ratio for `selected[0]` (mixed-ratio multi-select). Fix: use the queried mesh's own ratio.

## HIGH (verified)
- **H1 — Duplicated objects collapse into one geometry on reload.** `cloneMeshAsNewObject` keeps the source's `assetId`+`containerMeshIndex` and gives the clone unique live geometry that is **never serialized** (one blob per assetId). On reload both objects resolve to the same `res.geom[idx]` mesh → independently-scaled/ratio'd duplicates merge into one shape; only the first's ratio/last's transform survive. Fix: give each duplicate its own assetId + cache its baked bytes, OR in `_loadProject` clone+`makeGeometryUnique` when an index is already claimed and re-apply that object's ratio. (Pre-existing; same family as the restore bug we fixed. No duplicate save/reload test exists.)
- (R1 is also HIGH — listed above.)

## MEDIUM (verified)
- **M1 — `autoFix` mutates live vertices that are never serialized.** Weld (MergeByDistance) + inverted-normal index flip write to the live mesh; reload rebuilds from original bytes + ratio only → the "fix" vanishes on reopen (model reloads with the same defects). Fix: persist a per-object "edits applied" record and re-apply on load, or re-serialize the repaired geometry; at minimum flag autoFix as viewport-only.
- **M2 — Validation stale-marking race.** `validateMesh` awaits the worker; an edit committed during that window marks the cache stale, then the resolving `_cacheResults` clobbers it `stale:false` → Outliner/Print show a fresh/valid badge for changed geometry. Fix: capture a generation token at start; skip/flag the cache write if invalidated since.
- **M3 — Unlit shader colour never reaches emissive.** `unlit` StandardMaterial has `disableLighting=true` but only `diffuseColor` is set; visible colour comes from `emissiveColor` (left white) → every unlit shader renders white in viewport AND exports `Ke 1 1 1`. (The app's own `_setBaseColorMode` proves the emissive-vs-diffuse semantics.) Fix: drive `emissiveColor` from the chosen colour for unlit.
- **M4 — Imported UV transform discarded.** `_buildEntryFromMaterial` hard-codes `uvBase` to identity, dropping a texture's uOffset/uScale/wAng on import; lost on `.mixo` round-trip too. Fix: harvest the transform from the imported texture.
- **M5 — SmartReplaceCommand drops multi-part objects.** It doesn't expand via `logicalObjectPartIds`: clones only the active lead, replaces target by lead only → source parts lost, target non-lead parts orphaned (still print-flagged). Fix: route through the logical layer (or gate it off for multi-part objects).
- **M6 — Offline turntable recorder reframes in followActive.** `_applyFollowTarget` (onBeforeRender) overwrites `camera.target` every offline frame in follow modes, so the recorded video wobbles/reframes and differs from the live preview. Fix: force `free` follow mode during recording/pose-capture, restore after.
- **M7 — Autosave turns loose drag-dropped (handle-less) assets into ghosts.** Autosave skips embedding bytes; a loose drop has no dir/file handle and (on non-Chrome / revoked-permission / fallback paths) no `fileHandleKey` → crash-recovery has nothing to resolve → ghost. Fix: embed bytes in autosave for assets lacking any live-recovery tier.
- **M8 — Keyboard G/R/S modal ignores `pivotMode`.** `_enterModal` always pivots about the selection median; `cursor`/`active`/`world` modes (honored by the gizmo) are not respected. Fix: branch on `pivotMode` like `PivotSession._computePivotPosition`.
- **M9 — printPreview/baseColor modes mutate viz/bed/section materials.** Unlike `_setUvCheckerMode`, they iterate all meshes with no content guard → can alter the cross-section cap, back-face viz, grid/floor/bed, FRONT-label materials and capture wrong "originals". Fix: add the same content/viz guard.
- **M10 — Cross-section fill clone is baked static.** The amber interior fill bakes the source world matrix at clone time; moving the model while a section is active detaches the fill from the cut. Fix: rebuild/track on TRANSFORM_COMMITTED.

## LOW (reviewer-reported, not independently verified)
Persistence: SceneObject `sourceUnit` never serialized (latent; geometry still correct); `_resolveAssetBlob` tier-1 doesn't hash-verify the path file (silent wrong-file restore); manual save re-base64s every asset on the main thread (heavy-scene stall). Import: `restoreContainer` leaks OBJ sibling URLs on throw; unique-name `.dup` fallback can collide (breaks export-filename uniqueness at 999+ same-stem). Validation: group cache fan-out can leave stale sibling entries; `_buildGroupUnion` 32-bit index overflow has no guard. Scale/export: ThreeMFLoader leaks unused texture blob URLs; 3MF re-import isn't a scale round-trip (documented); solid-PNG vs MTL `d` desync only for NaN alpha. Scene: selection mask renderList lacks a dispose observer. Render-output: `_waitReady` 2 s cap can spuriously fail heavy-asset capture; dead MediaRecorder-era `pickVideoFormat`/`turntableAlpha`. Camera: per-frame `angularSensibility` writes are dead (orbit uses a fixed constant). Shaders: per-import dedupe is O(M×S) twice; UV-override export relies on Babylon `Texture.clone()` copying `metadata.mixoAssetId` (full-res-lock risk if it doesn't). UI: Properties full-rebuild on every transform commit (incl. shader previews); `_printPartsHaveWarnings` dereferences `e.results` without optional chaining; ViewportToggles don't re-push overlay modes on PROJECT_LOADED; ratio no-op on parts without a live mesh. Input: BoxSelect allocates a Ray per mesh per pointermove. Selection: cursor visibility (`pivotMode==='cursor'`) not restored on load; copy-`Object` stale-lead reconciliation. Settings: bedDimensions can desync from targetPrinterId across New.

## LOW triage verdicts (2026-06-16 — each verified against the code)
**Fixed:** restoreContainer OBJ-URL leak on throw (#4, catch mirrors live import);
`_printPartsHaveWarnings` optional-chains `e.results` (#18); dead MediaRecorder-era
`turntableAlpha`/`pickVideoFormat` removed (#13); bedDimensions↔targetPrinterId drift
pinned by a config-source-of-truth test (#24); UV-override texture clone now copies
`metadata` explicitly so `mixoAssetId` survives → full-res export source resolves
(#16, Mimaki lock); ThreeMFLoader revokes blob URLs for unreferenced texture2d parts (#8).

**`#21` premise wrong:** BoxSelect's `getForwardRay` allocation is per-mesh at the
single `end()` resolve, not per pointermove (`update()` only redraws the div). One-shot
over N meshes — not a per-frame cost; left as-is.

**Not a bug / intentional (verified, left as-is):**
- `_resolveAssetBlob` tier-1 path-trust is the **live-link** contract — it lets an
  edit-in-place (re-export to the same path) flow through on reload; contentHash is
  the tier-2 relink for *moved/renamed* files, not a tier-1 gate. Hash-gating tier-1
  would break edit-in-place.
- ViewportToggles don't re-push overlay modes on PROJECT_LOADED because `_loadProject`
  already re-applies EVERY overlay via `setOverlay` (routes printPreview/baseColor/
  uvChecker/wireframeEdges to their mode fns) after meshes are bound — central, not the panel's job.
- `angularSensibility` writes are LIVE (radius-scaled orbit feel in `_applyFollowTarget`), not dead.
- selection mask renderList is rebuilt every selection change (a mesh can't linger
  disposed in normal flow); a per-add dispose observer would itself leak observers.
- `_buildGroupUnion` Uint32 overflow needs >4 billion verts — physically unreachable.

**#3 manual-save main-thread base64 — FIXED 2026-06-16.** Measured first: a headless bench
of the chunked-`fromCharCode`+`btoa` path showed 41 / 193 / 402 ms for a single 10 / 50 /
100 MB asset, synchronous on the main thread (only on manual save / explicit .mixo embed —
autosave skips embedding via A9). Fix: a Web Worker offload that keeps the save path safe:
- One shared pure codec (`src/core/workers/base64Codec.js`) feeds BOTH the worker
  (`Base64.worker.js`) and the sync fallback, so output is byte-identical by construction.
- `Base64Worker.encodeBase64Async` COPIES the bytes and transfers the copy (the live buffer
  is never detached), and falls back to the sync codec when `Worker` is unavailable
  (headless) or the worker errors — so no project-corruption risk on this critical path.
- `_serialiseAssetLibrary` awaits `encodeBase64Async`; `_b64FromBuf` now delegates to the
  shared codec. Guards: STANDARD-base64 reference test + an async/sync byte-identity test
  (`tests/persistence.test.mjs`, which hits the sync fallback headless), plus an EXPLICIT
  browser-smoke pin that runs `encodeBase64Async` through the REAL Chrome worker across the
  0x8000 chunk boundary and asserts it equals `_b64FromBuf` (and never detaches the source);
  the existing `_buildDocument`→`_loadProject` round-trips also embed + decode via the real
  worker. typecheck + 72 headless + build + browser smoke + export smoke green.

**#17 Properties full-rebuild per transform commit — VERIFIED non-issue.** The rebuild
is subscribed to `TRANSFORM_COMMITTED`, which fires at drag-END / nudge (via
`PivotSession._onGizmoDragEnd`), NOT per frame; and `renderShaderPreview` returns a cheap
CSS swatch or a PRE-BAKED thumbnail data-URL (generated once at import via
`_generateThumbnailFor`, never re-rendered). A once-per-commit `innerHTML` rebuild of cheap
strings is the standard property-panel pattern — no per-frame or expensive work. Won't-fix.

**#15 per-import shader dedupe O(M×S) — MEASURED, reclassified won't-fix.** A headless
bench of the real signature scan: M=50/S=200 → 1.1 ms, M=200/S=500 → 13 ms, and only an
*implausible* M=500/S=1000 simultaneous import → 78 ms (a one-time import cost, not
per-frame). The incremental `signature→id` Map (map variants measured 0.2–1.1 ms) only
matters at scales this hobbyist-print tool won't see, and the refactor is behavior-
sensitive (within/cross-import dedup ordering + the `replace`-branch signature change)
and can't even be guarded headlessly (env mock materials fail `_detectType`'s `instanceof`).
Not worth the regression risk for a sub-15 ms realistic-scale cost.

**Won't-fix — below the value/risk threshold (each verified, dispositioned):**
- #5 `.dup` name collision — only at 999 objects sharing one stem (implausible here);
  fixing means touching 6 name-generators for a scenario that won't occur.
- #6 group-cache stale sibling — ungroup-only edge on a *non-blocking* badge; deletes
  already `_dropEntry`, and the M2 seq machinery handles the real in-flight races.
- #20 ratio no-op on a part with no live mesh — correct by design (a ghost has no geometry
  to bake; the ratio is still recorded in state).
- #23 copy-`Object` stale-lead — the deletion case is already guarded (`sourceGone` toast);
  the residual is a narrow re-structure-after-copy edge.
- #1 SceneObject `sourceUnit` not serialized — latent; `asset.sourceUnit` is the
  authoritative serialized source the import seed actually uses.
- #9 3MF re-import scale round-trip — documented limitation.

Solid-PNG/MTL `d` NaN-alpha desync (#10) — **FIXED**: a shared `_safeAlpha01`
treats a non-finite material alpha as opaque (1) in both the PNG α byte and the MTL
`d`/`Tr` lines, so a NaN alpha can't emit a literal "NaN" or make the two disagree.
Headless regression test added.

Cursor visibility on load (#22) — **FIXED**: `_loadProject` now syncs
`setCursorVisible(pivotMode === 'cursor')` after restoring selection.

## Recurring themes
1. **Logical-object completeness** — the multi-primitive grouping I added is now load-bearing across consumers; several (DuplicateCommand, SmartReplace, ShaderPanel assign, outline, follow-camera) weren't updated to expand parts. The expansion helper exists (`logicalObjectPartIds`/`logicalObjectCommandIds`) — these are "forgot to call it" sites.
2. **Baked/live state not in saved state** — H1, M1, M3-restore, M4 are the same class we fixed for ratio: anything baked into vertices/materials that isn't reconstructable from saved fields is lost on reopen.
3. **Content vs per-user-setting boundary** — R2/R3 (exportRatios) and the bedDimensions low are the SettingsStore allow-list not matching what's actually project content.
