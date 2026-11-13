# src/supports/ — the map

29 files: support generation, ported from mixoDental and sharing the same vendored engine. The
port's history and what stayed shared is in `../../docs/support-generation-port.md`; this is the
map of the code.

**The one rule to carry in before reading anything here:** the engine works in millimetres in a
right-handed frame; Babylon works in build units in a left-handed one. `frame.ts` is the only
place that conversion lives, and every number crossing in or out goes through it. A conversion
written anywhere else is the bug class this folder is shaped to prevent.

## The boundary — read these two first

| File | Job |
|---|---|
| `frame.ts` | the coordinate contract: `ENGINE_MM_PER_BU`, `WELD_CELL_MM`, `pointToEngine` and its inverses. Its test pins a unit cube counter-clockwise-outward in the engine's convention, which is what makes a sign error fail loudly instead of quietly |
| `BabylonViewportPort.ts` | screen ↔ world for the support tools, tested against a `NullEngine` scene so the round trip has a test with no browser |

## The job path

| File | Job |
|---|---|
| `supportJob.ts` | **the call into the engine**: presets, the local model, `toLocal`, `supportJob`. The place a support build actually happens |
| `objectModel.ts` | the object as the engine needs it: lead position, world parts, a version. Multi-part objects are expanded here, once |
| `sceneSource.ts` | the staged scene the job reads — pose and lead-local parts, captured rather than read live |
| `sourceHash.ts` | `hashEngineMesh` / `hashParts`: the identity a cache and a staleness check key on |
| `model.ts` | the shared types: `SupportPose`, `StaleReason`, `PackedStamps`, `PlacementSignature` |
| `supportCache.ts` | built meshes kept by hash, so a rebuild that changes nothing costs nothing |
| `rekey.ts`-side tests (`rekey.test.ts`) | regenerate-and-rekey through the real engine, on the real `pkg` |

## Staleness — when a built support stops being true

`stale.ts` owns it, and the rule is in its test: **built supports go stale on rotate, scale and
repair (geometry changes), not on move.** Getting that boundary wrong either throws away work the
user wants or keeps supports that no longer touch the model. `installStaleWatch` is what subscribes
it to the scene.

## Mode and commands

| File | Job |
|---|---|
| `SupportMode.ts` | the Support Mode controller: `supportTargets`, `isSupportsCommand`, the escape stages, and `INERT_SELECTORS`. **Its event subscriptions must stay in step with its sibling `../ui/PartScopeMode.ts`** — they drifted once, and the fix was to make both lists cover object removal, restore and asset instantiation |
| `SupportModeUI.tsx` | the panel |
| `commands.test.ts` | the contract every support command owes: **does and undoes as exactly one `HistoryManager` step.** If you add a command, this is the test that must cover it |
| `store.ts` | `readSupports` / `writeSupports` and who owns them |
| `persist.test.ts` | saved and reopened supports. MX-03's rule: a dropped support is **dropped AND reported**, carrying the object's name |

## Geometry helpers

| File | Job |
|---|---|
| `crossObject.ts` | bounds and overlap between *different* objects. **This is the caller that legitimately declares its parts** — see the warning below |
| `noiseShells.ts` | which shells are noise, by volume (`NOISE_MM3`) |
| `label.ts` | the printed label: `sanitizeLabel`, `labelFromName`, length cap |
| `spike.ts` | the single-support spike path |
| `features.test.ts` | tree, brace with pruning, raft and label through the real job path |

## The engine baseline, and why one row reads "blocked"

`engineBaseline.test.ts` compares this app's own output against
`tests/fixtures/engine-baseline.json`, a **committed capture**. `UPDATE_BASELINE=1` re-takes it;
do that only after reading the diff row by row.

Its `sunk-pair` row reads `tips 33 / verdict blocked` **by decision, not by accident.** The generic
placement path deliberately applies no overlap rule, so a support lands on a buried face and the
build says so loudly. The invariant behind that lives in the engine, in
`vendor/mixo-geocore/host/supports/README.md`: **the overlap rule takes its parts from the CALLER,
never from topology.** `crossObject.ts` is one of the two callers allowed to use it, because it
genuinely knows its parts. A re-land conditioned on shell count, manifoldness or weld tolerance is
exactly what that invariant refuses — a file with several shells is not an object with several
parts, and acting as if it were cost 92% of one build's supports.

## Testing

`testEnv.ts` is a **side-effect module: import it first** in any node vitest file that loads
`../core/*`. A test that imports core modules without it is testing a different environment than it
thinks.
