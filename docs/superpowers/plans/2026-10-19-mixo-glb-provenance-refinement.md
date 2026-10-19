# Manual Mixo GLB Print Refinement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve every Mixo GLB’s render-evaluated mesh as the normal view, while making an explicitly requested, progress-visible, crease-aware further refinement available for print.

**Architecture:** Blender emits optional v2 refinement metadata keyed to its final GLB primitives. Mixomesh accepts it only with its existing valid Mixo provenance. A module worker computes a temporary Loop-subdivided result; an undoable state setting chooses original/refined preview and the shared export context resolves the same representation.

**Tech Stack:** Blender Python/glTF; Vite ES modules; Babylon.js; module Web Workers; Node and Blender tests.

---

### Task 1: Export valid final-topology refinement metadata

**Files:**
- Modify: `S:\ai\mixo3dtool\mixo3d\helpers\glb_provenance.py`
- Modify: `S:\ai\mixo3dtool\mixo3d\helpers\marksharp.py`
- Modify: `S:\ai\mixo3dtool\mixo3d\io\glb.py`
- Modify: `S:\ai\mixo3dtool\mixo3d\io\mixomesh_glb.py`
- Modify: `S:\ai\mixo3dtool\mixo3d\helpers\mixomesh_contract.py`
- Modify: `S:\ai\mixo3dtool\docs\MIXOMESH_CONTRACT.md`
- Test: `S:\ai\mixo3dtool\tests\blender\run.py`

- [ ] **Step 1: Write a failing Blender fixture/export assertion.** Build a UV-seamed triangulated mesh containing a hard sharp edge and a fractional crease. Export through both GLB routes; decode the GLB JSON/accessors and assert render-evaluated geometry remains intact, v1 provenance remains intact, and each exported primitive has an optional `extras.mixo_print_refinement` payload whose local indices are within its POSITION accessor.

- [ ] **Step 2: Run the focused failure.**

Run: `set ONLY=mixo_glb_refinement_metadata && python tests/blender/run.py`

Expected: FAIL because no final-primitive payload is exported.

- [ ] **Step 3: Implement safe-copy evaluation and payload construction.** Evaluate only safe-copy objects through Blender’s depsgraph, triangulate the evaluation result, and build `{ version: 1, creaseByVertex, sharpEdges }`. `creaseByVertex` is the maximum incident crease clamped to `[0,1]`; each `sharpEdges` row is `[v0, v1, weight]`. Never reuse pre-modifier edge indices.

```python
def refinement_payload(final_mesh):
    return {"version": 1, "creaseByVertex": creases, "sharpEdges": edge_rows}
```

- [ ] **Step 4: Add a narrow GLB JSON post-export pass.** Map safe evaluated topology to each exporter-built primitive POSITION accessor, attach the payload to that primitive’s extras, and rewrite only the aligned GLB JSON chunk. Mapping failure omits only the payload, records a warning, and retains ordinary v1 Mixo export; it must never produce false sharp-edge indices.

- [ ] **Step 5: Update the contract.** Keep provenance marker version `1`; document independent optional payload version `1`, missing-payload behavior, primitive-local indexing, and full-res/render-evaluated invariants. Bump helper and document contract versions together.

- [ ] **Step 6: Verify and commit.**

Run: `set ONLY=mixo_glb_refinement_metadata && python tests/blender/run.py`

Expected: PASS, including UV splits and no source `.blend` mutation.

Run: `python -m pytest tests/unit -q`

Expected: PASS.

```powershell
git -C S:\ai\mixo3dtool add mixo3d/helpers/glb_provenance.py mixo3d/helpers/marksharp.py mixo3d/io/glb.py mixo3d/io/mixomesh_glb.py mixo3d/helpers/mixomesh_contract.py docs/MIXOMESH_CONTRACT.md tests/blender/run.py
git -C S:\ai\mixo3dtool commit -m "feat(export): add print refinement metadata"
```

### Task 2: Read and preserve refinement metadata through import

**Files:**
- Modify: `src/core/import/ImportMetadata.js`
- Modify: `src/core/assets/AssetRegistration.js`
- Modify: `src/core/assets/MeshSplit.js`
- Modify: `src/core/persist/ProjectSerializer.js`
- Modify: `src/core/persist/ProjectLoader.js`
- Test: `tests/import-metadata.test.mjs`
- Test: `tests/split-on-import.test.mjs`
- Test: `tests/persistence.test.mjs`
- Modify: `BLUEPRINT.md`

- [ ] **Step 1: Add failing acceptance tests.** Cover valid payload, out-of-range index/NaN/unknown version, Mixo v1 without payload, and an unmarked file with a spoofed payload. Assert metadata belongs only to logical-object leads and remains correctly associated after a multi-material primitive split.

- [ ] **Step 2: Run the focused failures.**

Run: `node --test tests/import-metadata.test.mjs tests/split-on-import.test.mjs tests/persistence.test.mjs`

Expected: FAIL for new refinement cases.

- [ ] **Step 3: Add strict extraction.** Add `normalizeMixoRefinement(value, vertexCount)` and `extractMixoRefinement(mesh)` beside `extractMixoProvenance`. Return only `{ version: 1, creaseByVertex: Float32Array, sharpEdges: Uint32Array }` or `null`; copy inputs, clamp valid crease values, reject malformed rows wholesale, and never infer edge metadata from an arbitrary mesh angle.

- [ ] **Step 4: Register and persist safely.** Store source descriptors lead-only with primitive identifiers; split children retain remapped local data. Serializer converts typed arrays to JSON-safe arrays; loader revalidates and drops invalid descriptors. No derived output is persisted.

- [ ] **Step 5: Update Blueprint, rerun tests, commit.**

Run: `node --test tests/import-metadata.test.mjs tests/split-on-import.test.mjs tests/persistence.test.mjs`

Expected: PASS.

```powershell
git add src/core/import/ImportMetadata.js src/core/assets/AssetRegistration.js src/core/assets/MeshSplit.js src/core/persist/ProjectSerializer.js src/core/persist/ProjectLoader.js BLUEPRINT.md tests/import-metadata.test.mjs tests/split-on-import.test.mjs tests/persistence.test.mjs
git commit -m "feat(import): retain Mixo refinement metadata"
```

### Task 3: Implement a cancellable crease-aware worker

**Files:**
- Create: `src/core/workers/MixoRefine.worker.js`
- Create: `src/core/MixoRefinementWorker.js`
- Create: `src/core/refinement/Topology.js`
- Create: `src/core/refinement/DerivedMeshes.js`
- Modify: `src/core/events.js`
- Test: `tests/mixo-refinement-topology.test.mjs`
- Test: `tests/mixo-refinement-worker.test.mjs`
- Modify: `BLUEPRINT.md`

- [ ] **Step 1: Write pure topology failures.** Test Level 0 identity, one Loop step on a triangle, UV-seam position welding, explicit sharp-edge retention, fractional crease weighting, and clear rejection of empty/non-manifold/oversized input.

- [ ] **Step 2: Run the failure.**

Run: `node --test tests/mixo-refinement-topology.test.mjs`

Expected: FAIL because the worker/topology modules are absent.

- [ ] **Step 3: Implement pure data refinement.** `Topology.js` deterministically welds identical finite positions for topology only, propagates maximum crease and maps sharp pairs. The worker performs Loop subdivision level-by-level, posts `{ type:'progress', phase, completed, total }`, transfers only new buffers, and contains no Babylon/DOM calls.

- [ ] **Step 4: Implement lifecycle/cancellation.** Follow `ValidateWorker.js`: monotonic job ID, pending map, timeout/restart, `AbortSignal`, full message validation, and late-result discard. `DerivedMeshes.js` creates temporary non-pickable Babylon siblings only after result validation; source meshes are never overwritten.

- [ ] **Step 5: Add protocol tests, update Blueprint, commit.** Use the `FakeWorker` style from `tests/worker-import.test.mjs` to prove progress forwarding, cancellation, error/restart, and stale result discard.

Run: `node --test tests/mixo-refinement-topology.test.mjs tests/mixo-refinement-worker.test.mjs`

Expected: PASS.

```powershell
git add src/core/workers/MixoRefine.worker.js src/core/MixoRefinementWorker.js src/core/refinement src/core/events.js BLUEPRINT.md tests/mixo-refinement-topology.test.mjs tests/mixo-refinement-worker.test.mjs
git commit -m "feat(print): add Mixo refinement worker"
```

### Task 4: Add manual state, preview controls, and failure recovery

**Files:**
- Create: `src/core/commands/RefinementCommands.js`
- Create: `src/core/refinement/RefinementController.js`
- Modify: `src/core/HistoryManager.js`
- Modify: `src/core/StateManager.js`
- Modify: `src/core/events.js`
- Modify: `src/ui/PropertiesPanel.js`
- Modify: `src/ui/Outliner.js`
- Modify: `src/styles/components.css`
- Test: `tests/refinement-commands.test.mjs`
- Test: `tests/properties-panel.test.mjs`
- Modify: `BLUEPRINT.md`

- [ ] **Step 1: Write state/undo tests.** Cover default Off/original/idle, undo/redo, no automatic job on import/load, stale request after reopen, source invalidation, and cancellation/failure retaining original preview.

- [ ] **Step 2: Implement command/controller ownership.** `SetPrintRefinementCommand` changes only selected level/preview intent. `RefinementController` owns worker/derived meshes and emits typed changed/progress/ready/failed/cancelled/stale events; UI mutates neither Babylon nor state directly.

- [ ] **Step 3: Implement the Properties journey.** Valid Mixo items show a labelled source badge, authored levels, Off/Level 1/Level 2 choices, and **Build preview**. Active work shows phase, measurable progress, current batch object, and **Cancel**. Failure is inline `role="alert"` text plus **Retry**/**Use original**. Ready state exposes explicit Original/Refined preview choices. Existing v1 Mixo items show “Re-export from Mixo3D Tools” and no build control.

- [ ] **Step 4: Implement Outliner and keyboard support.** Add a compact Mixo/refinement status decoration only to a lead row. It uses an existing SVG icon with `aria-hidden="true"`; its accessible row text includes source/status. Assert visible focus, labels, status, alerts, and ordinary-GLB absence.

- [ ] **Step 5: Update Blueprint, test, commit.**

Run: `node --test tests/refinement-commands.test.mjs tests/properties-panel.test.mjs`

Expected: PASS.

```powershell
git add src/core/commands/RefinementCommands.js src/core/refinement/RefinementController.js src/core/HistoryManager.js src/core/StateManager.js src/core/events.js src/ui/PropertiesPanel.js src/ui/Outliner.js src/styles/components.css BLUEPRINT.md tests/refinement-commands.test.mjs tests/properties-panel.test.mjs
git commit -m "feat(ui): add manual print refinement controls"
```

### Task 5: Export exactly the selected representation

**Files:**
- Modify: `src/core/print/ExportContext.js`
- Modify: `src/core/print/PrintPipeline.js`
- Modify: `src/core/print/PrintReadiness.js`
- Modify: `src/ui/print/ExportTab.js`
- Test: `tests/export-context.test.mjs`
- Test: `tests/export.test.mjs`
- Test: `tests/browser-export-smoke.mjs`
- Modify: `BLUEPRINT.md`

- [ ] **Step 1: Add export failures.** Cover original default, selected ready refined output, one stale/failed refined item in a batch, user-selected original fallback, multi-material logical objects, and source mesh immutability across STL/3MF/high-res GLB.

- [ ] **Step 2: Extend the shared immutable context.** Add frozen per-unit `representation: 'original'|'refined'` plus its resolved mesh list. Both `previewExportContext()` and real export use the resolver. A queued/stale/failed requested refinement returns a structured blocking issue, never an unannounced fallback.

- [ ] **Step 3: Wire ExportTab.** List each object’s chosen representation. Blocking UI offers Build, Retry, Use original, or Cancel; the primary action never says “refined” when an original fallback is selected.

- [ ] **Step 4: Route resolved clones through existing validation/serialization.** Preserve current scale, pivot, texture-source, repair/weld, and disposal behavior; do not add a parallel exporter.

- [ ] **Step 5: Update Blueprint, verify, commit.**

Run: `node --test tests/export-context.test.mjs tests/export.test.mjs tests/browser-export-smoke.mjs`

Expected: PASS.

```powershell
git add src/core/print/ExportContext.js src/core/print/PrintPipeline.js src/core/print/PrintReadiness.js src/ui/print/ExportTab.js BLUEPRINT.md tests/export-context.test.mjs tests/export.test.mjs tests/browser-export-smoke.mjs
git commit -m "feat(export): honor selected print refinement"
```

### Task 6: Cross-repository verification and delivery

**Files:**
- Modify: `S:\ai\mixo3dtool\docs\SESSION_STATE.md`
- Modify: `HANDOFF.md` only if a detached verification run remains unfinished.

- [ ] **Step 1: Run add-on verification.**

Run: `python -m pytest tests/unit -q; python tests/blender/run.py`

Expected: PASS; report external Blender timeouts as incomplete, never as passes.

- [ ] **Step 2: Run the Mixomesh baseline.**

Run: `npm run lint; npm run typecheck; npm run build; npm run test; npm run test:browser; npm run test:export`

Expected: every command exits 0.

- [ ] **Step 3: Inspect scope and push under existing owner authority.** Preserve unrelated `package-lock.json` work, commit session notes separately, push both repositories only after clean scoped review, and report hashes plus fresh evidence.
