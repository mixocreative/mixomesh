# Ported from mixosupports (commit adbe7c3)

Task P1.1 of `docs/plans/2026-10-29-react-wasm-supports.md`. TypeScript copies, file names kept.
Source paths are relative to mixosupports `src/` (same relative path unless noted). mixomesh owns
these files now; no sync back. The A1 files `geometryVersion.js` and `loadGeometry.js` are untouched.

| mixomesh path (`src/support-engine/`) | source in mixosupports (`src/`) |
|---|---|
| `core/analysis/mesh.ts` | `core/analysis/mesh.ts` |
| `core/analysis/supportCheck.ts` | `core/analysis/supportCheck.ts` |
| `core/analysis/types.ts` | `core/analysis/types.ts` |
| `core/budget.ts` | `core/budget.ts` |
| `core/jobGate.ts` | `core/jobGate.ts` |
| `core/jobs.ts` | `core/jobs.ts` |
| `core/supports/mesh.ts` | `core/supports/mesh.ts` |
| `core/supports/meshQuery.ts` | `core/supports/meshQuery.ts` |
| `core/supports/settings.ts` | `core/supports/settings.ts` |
| `core/supports/zones.ts` | `core/supports/zones.ts` |
| `core/transform.ts` | `core/transform.ts` |
| `core/vec3.ts` | `core/vec3.ts` |
| `editing/brushScheduler.ts` | `editing/brushScheduler.ts` |
| `editing/check.ts` | `editing/check.ts` |
| `editing/commands.ts` | `editing/commands.ts` |
| `editing/dragOver.ts` | `editing/dragOver.ts` |
| `editing/errors.ts` | `editing/errors.ts` |
| `editing/gesture.ts` | `editing/gesture.ts` |
| `editing/hoverProbe.ts` | `editing/hoverProbe.ts` |
| `editing/keys.ts` | `editing/keys.ts` |
| `editing/locks.ts` | `editing/locks.ts` |
| `editing/numberInput.ts` | `editing/numberInput.ts` |
| `editing/pick.ts` | `editing/pick.ts` |
| `editing/project.ts` | `editing/project.ts` |
| `editing/regenerate.ts` | `editing/regenerate.ts` |
| `editing/removal.ts` | `editing/removal.ts` |
| `editing/screenBrush.ts` | `editing/screenBrush.ts` |
| `editing/selection.ts` | `editing/selection.ts` |
| `editing/selectionHighlight.ts` | `editing/selectionHighlight.ts` |
| `editing/session.ts` | `editing/session.ts` |
| `editing/shapeEdit.ts` | `editing/shapeEdit.ts` |
| `editing/status.ts` | `editing/status.ts` |
| `editing/stroke.ts` | `editing/stroke.ts` |
| `editing/strokeQueue.ts` | `editing/strokeQueue.ts` |
| `editing/surfaceBrush.ts` | `editing/surfaceBrush.ts` |
| `editing/toast.ts` | `editing/toast.ts` |
| `editing/types.ts` | `editing/types.ts` |
| `editing/view.ts` | `editing/view.ts` |
| `state/projectTypes.ts` | types only, extracted from `state/project.ts` |
| `state/transform.ts` | `state/transform.ts` |
| `state/transformEngine.ts` | `state/transformEngine.ts` |
| `supports/checkSupports.ts` | `supports/checkSupports.ts` |
| `supports/contactEdits.ts` | `supports/contactEdits.ts` |
| `supports/export.ts` | `supports/export.ts` |
| `supports/exportGate.ts` | `supports/exportGate.ts` |
| `supports/generateSupports.ts` | `supports/generateSupports.ts` |
| `supports/genericPlacement.ts` | `supports/genericPlacement.ts` |
| `supports/genericPolicy.ts` | `supports/genericPolicy.ts` |
| `supports/islandProblems.ts` | `supports/islandProblems.ts` |
| `supports/jobRunner.ts` | `supports/jobRunner.ts` |
| `supports/landing.ts` | `supports/landing.ts` |
| `supports/omittedProblem.ts` | `supports/omittedProblem.ts` |
| `supports/supportBuildWasm.ts` | `supports/supportBuildWasm.ts` |
| `supports/supportEngine.ts` | `supports/supportEngine.ts` |
| `supports/supportFrame.ts` | `supports/supportFrame.ts` |
| `supports/unitSupports.ts` | `supports/unitSupports.ts` |
| `workers/WorkerTask.ts` | `workers/WorkerTask.ts` |
| `workers/buildSessions.ts` | `workers/buildSessions.ts` |
| `workers/geometryClient.ts` | REWRITTEN (loadGeometryEngine-based; not copied) |
| `workers/jobActivity.ts` | `workers/jobActivity.ts` |
| `workers/meshClient.ts` | `workers/meshClient.ts` |
| `workers/meshProtocol.ts` | `workers/meshProtocol.ts` |
| `workers/meshWorker.ts` | `workers/meshWorker.ts` |
| `workers/serveTask.ts` | `workers/serveTask.ts` |
| `workers/sourceCache.ts` | `workers/sourceCache.ts` |

## Removed

- The aligner-specific mode (the plan names it in D-notes): `EditMode` value for it, the `EditTool`
  values `paint`/`erase` (its area brushes), every session field and event of that flow, its
  commands and keys, the auto-support command for it, its gestures and status lines, the
  `StepKind` for its area step, `SupportJob` policy field, the placement job type for it, the rim
  coverage and structure-fallback fields of `GeneratedSupportMesh`, its policy path in `jobRunner`
  and its default label in `unitSupports`. No import from the removed source folder.
- `meshClient` no longer sends a `policyToken` (it existed only for that mode's policy object); the
  optional field stays in `meshProtocol` / `buildSessions`, unused.
- `PolicyHandle` now lives in `supports/generateSupports.ts` (was in `core/analysis/` engine types).
- `orientationOnly` is defined in `supports/jobRunner.ts` (was in the removed folder).
- Undo (D21): `editing/session.ts` holds view state only and never had an undo stack; nothing of
  `state/history.ts` was ported. `startsEditing` stays as a plain predicate for the host.
- `state/projectTypes.ts` keeps only the scene types of `state/project.ts`; the scene reducer,
  normalisers and (de)serialisation are not ported (P3.1 designs the mixomesh data model).
- `ZoneStamp` is a type alias (lint rejects an empty interface). `use` callback parameters renamed
  `run` (react-hooks lint rule).

## Rewritten

- `workers/geometryClient.ts`: `configureGeometry(glueUrl, wasm?)` then `geometryReady()` load the
  engine through `loadGeometryEngine` (version-checked) and register it with the support and
  transform engine holders. Types come from the vendored `.d.ts` (type import only). No static
  wasm imports, no `?url`.

## Left out

- `*.test.ts` and `editing/uiFixture.ts`: ported in P1.2.
- All React / three.js view code (`components/`, `viewport/`, `App.tsx`, `main.tsx`).
- `workers/analysis*`, `importClient|importWorker`, `projectClient|projectWorker`, `stlSession`,
  `factories`: not in the P1.1 list (analysis carries the removed mode's job kinds; the others are
  mixosupports' own import/project flow).
- `supports/selection.ts`, `supports/zoneCheck.ts`: not in the list.
- `state/history.ts`, `state/runtime.ts`, `state/import.ts`, the scene reducer: D21.
- `supports/export.ts` is copied whole (the support-mesh encoder is its main part); trimming it is
  left to P4.2, which owns the export seam.
