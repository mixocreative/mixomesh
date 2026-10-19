# Manual Mixo Print Refinement Design

## Decision

Mixomesh treats a Mixo-authored GLB as a fully render-evaluated, textured
baseline. It never automatically changes that geometry. A user may explicitly
create an additional print-refinement preview for an eligible logical object;
only that completed preview may be exported as refined geometry.

This is not an attempt to replay Blender's Subdivision Surface modifier. The
Blender GLB has already applied the render modifier stack. Refinement is an
extra, crease-aware subdivision of the exported final mesh, intended for print
quality where the user asks for it.

## Export and import contract

The existing four-field Mixo provenance marker remains the eligibility gate:

```text
mixo_origin = "mixo3d"
mixo_marker_version = 1
mixo_viewport_subdiv_level = non-negative integer
mixo_render_subdiv_level = non-negative integer
```

It identifies the source and reports authored Blender levels; it never selects
or runs a refinement level. A future marker revision adds an optional
`mixo_print_refinement` payload per exported primitive. It must be indexed to
the final exported primitive, not the pre-modifier Blender cage:

- `crease`: an optional float weight per final vertex, in `[0, 1]`;
- `sharpEdges`: optional final-primitive local vertex-index pairs;
- `topologyVersion`: the version of this refinement payload.

`sharpEdges` is authoritative. A vertex crease alone can only contribute a
weighted crease when both endpoints carry a positive value. Missing,
malformed, or unsupported refinement data does not invalidate the GLB: the
object retains its Mixo badge, shows the authored-level information, and marks
print refinement unavailable with the exact reason. Non-Mixo files are never
offered the control.

The GLB remains self-contained: render-applied geometry, PBR materials, and
full-size textures are unchanged. The extension is additive metadata only.

## Object state and safety boundary

Each logical-object lead owns an undoable `printRefinement` setting:

```js
{
  requestedLevel: 0 | 1 | 2,
  preview: 'original' | 'refined',
  status: 'idle' | 'queued' | 'building' | 'ready' | 'failed' | 'cancelled' | 'stale',
  error: null | { code, message }
}
```

`requestedLevel: 0` is off. The imported Babylon meshes remain immutable
sources. A worker creates an unregistered transferable geometry result; the
main thread validates it, then creates temporary derived display/export meshes.
No result may replace a source mesh in place. Changes are dispatched through
`StateManager`, are represented by commands for undo/redo, and use typed
events. Derived meshes are invalidated when their source geometry or object
transform representation changes.

The project stores the user's requested level and preview intent but not a
high-poly cache. On reopen it restores as `stale` with a visible "Build
preview" action. This keeps `.mixo` portable and avoids automatic memory/CPU
work or stale geometry.

## User journey

1. **Import.** The GLB enters exactly as exported. A Mixo logical-object lead
   has a labelled Mixo 3D badge in the Outliner and Properties; ordinary GLBs
   do not.
2. **Inspect.** The Properties section says "Print refinement" and reports
   Blender's authored viewport/render levels as information only. Its default
   is `Off — original GLB`.
3. **Opt in.** The user selects Level 1 or Level 2 and presses **Build
   preview**. This is batchable for multiple selected eligible logical objects,
   but each object retains an independent level and result.
4. **Work visibly.** A persistent status row reports `Queued`, `Reading
   topology`, `Refining`, `Validating`, and `Ready`; it includes percentage
   only when the worker can measure it, current object count/name for batches,
   and a Cancel action. The old/original preview remains visible throughout.
5. **Inspect result.** When ready, the user explicitly switches
   `Preview: Original | Refined`. The refined result has a visible temporary
   preview indicator. Switching back is immediate and lossless.
6. **Export.** Export context lists, per affected object, `Original` or
   `Refined Level N`. The primary action names the choice. A refined export
   cannot proceed when any selected refined result is queued, stale, cancelled,
   or failed; it offers **Build**, **Retry**, **Use original**, and **Cancel**.
7. **Failure/cancellation.** Failure never changes the viewport or export
   selection silently. It gives an announced, actionable error and retains the
   original GLB. Cancel leaves the original preview intact. A later retry is a
   new worker job, and stale worker messages are discarded by job/source
   revision identifiers.

The UI follows the existing dense desktop pattern: an icon is supplementary,
not the only indication; all controls have visible labels, keyboard focus, and
screen-reader status/error announcements. Progress and errors are inline to
the affected refinement section, not transient toast-only messages.

## Algorithm and execution

A dedicated Web Worker owns pure typed-array topology work. The main thread
extracts positions, indices, normal/UV/material partition information and
validated refinement metadata. Before building adjacency, it welds coincident
positions into topology IDs solely for subdivision; rendering seams remain
split in the output so textures/materials remain correct. Maximum crease
weights propagate to welded IDs and sharp pairs map through that weld.

The first implementation uses Loop subdivision for triangulated primitives.
It preserves explicit sharp edges and supports weighted crease blending. It
must reject unsupported/non-manifold input with a clear failure rather than
guessing at watertight print output. Multi-primitive logical objects are
processed independently and reassembled under the same logical object so the
one-mesh-one-shader invariant remains true.

Jobs are cancellable between subdivision phases. Worker messages contain a
monotonic job id and source revision; the main thread ignores obsolete results.
Worker construction, transfer, malformed metadata, validation, and memory
limit failures all become visible `failed` states with recoverable actions.

## Validation and export

The derived output goes through the existing mesh/print validation path before
it can become `ready`. It must retain material assignment and UV continuity;
it may not silently downscale texture sources or alter print scale. Export uses
the same `ExportContext` selection used by preview, so there is no separate
hidden export mode. STL/3MF/high-resolution GLB consume refined geometry only
when the ready refined representation is explicitly selected; otherwise all
formats use original geometry.

## Acceptance criteria

- A valid Mixo GLB loads/render-displays identically before any user action.
- Refinement is unavailable, with explanation, for a Mixo v1 marker without a
  compatible refinement payload and absent for non-Mixo GLBs.
- Starting, progressing, cancelling, failing, retrying, and completing a job
  never freezes the UI or silently changes the exported representation.
- Explicit final-topology sharp/crease metadata influences Level 1/2 output;
  UV/hard-normal split vertices do not tear the refined surface.
- Original and refined views can be selected deliberately, and export records
  exactly the selected representation.
- Reopening a project never silently rebuilds a high-poly result; it asks the
  user to rebuild a stale requested preview.
