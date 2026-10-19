# Mixo GLB Provenance and Print Refinement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mark every Blender-add-on GLB as Mixo-authored, preserve the Blender render-evaluated mesh as the import baseline, and offer optional, crease-aware further subdivision for print in Mixomesh.

**Architecture:** Blender continues to export the evaluated modifier result; its marker is provenance and a record of the authored viewport/render Subsurf settings, never an instruction to replay Blender modifiers. Mixomesh reads the marker into per-logical-object state, presents a restrained print-refinement control, and uses one worker-produced derived mesh for both refined viewport display and export.

**Tech Stack:** Blender 5.2 Python/glTF exporter; Vite JavaScript; Babylon.js; Web Workers; Node and Blender test suites.

---

### Task 1: Versioned Blender GLB marker

**Files:**

- Modify: `S:\ai\mixo3dtool\mixo3d\helpers\marksharp.py`
- Modify: `S:\ai\mixo3dtool\mixo3d\io\glb.py`
- Modify: `S:\ai\mixo3dtool\mixo3d\io\mixomesh_glb.py`
- Modify: `S:\ai\mixo3dtool\tests\blender\run.py`
- Modify: `S:\ai\mixo3dtool\docs\MIXOMESH_CONTRACT.md`

- [ ] Write a Blender regression case that exports an AR GLB and Mixomesh GLB containing a Subsurf modifier with `levels=1` and `render_levels=2`, then asserts node extras include `mixo_origin="mixo3d"`, marker version `1`, viewport level `1`, and render level `2` while the output geometry remains render-evaluated.
- [ ] Run the focused Blender case and confirm it fails because no marker exists.
- [ ] Add a safe-copy-only marker writer in `marksharp.py`; it writes marker fields for every mesh object, uses zero levels when no Subsurf modifier exists, and does not alter modifier evaluation or texture handling.
- [ ] Route both GLB writers through that writer and preserve the existing `export_apply`, embedded material, and full-resolution texture behavior.
- [ ] Run the focused Blender case and the add-on unit suite; update the external contract, architecture/session notes, and contract version.
- [ ] Commit the add-on contract/exporter change.

### Task 2: Mixomesh marker ingestion and persistence

**Files:**

- Modify: `src/core/import/ImportMetadata.js`
- Modify: `src/core/assets/AssetImport.js`
- Modify: `src/core/assets/AssetRegistration.js`
- Modify: `src/core/persist/ProjectSerializer.js`
- Modify: `src/core/persist/ProjectLoader.js`
- Modify: `tests/import-metadata.test.mjs`
- Modify: `tests/persistence.test.mjs`
- Modify: `BLUEPRINT.md`

- [ ] Write failing metadata tests for a valid marker, a missing marker, and an unsupported marker version; assert marker data attaches to the logical-object lead rather than to imported internal material siblings.
- [ ] Run the focused test and confirm it fails because no marker parser exists.
- [ ] Add a strict marker parser that reads glTF node extras, normalizes integer subdivision levels, rejects unsupported versions, and never treats arbitrary GLBs as Mixo-authored.
- [ ] Carry the normalized provenance through import registration and project save/load without changing the source render mesh.
- [ ] Run focused metadata/persistence tests and update BLUEPRINT’s import schema and rationale.
- [ ] Commit the Mixomesh marker-read/persistence change.

### Task 3: Optional derived print-refinement pipeline

**Files:**

- Create: `src/core/workers/Subdivide.worker.js`
- Create: `src/core/SubdivisionWorker.js`
- Create: `src/core/commands/SubdivisionCommands.js`
- Modify: `src/core/events.js`
- Modify: `src/core/HistoryManager.js`
- Modify: `src/core/assets/MeshSplit.js`
- Modify: `src/core/print/PrintPipeline.js`
- Modify: `src/ui/PropertiesPanel.js`
- Modify: `src/ui/Outliner.js`
- Modify: `tests/subdivision-worker.test.mjs`
- Modify: `tests/export.test.mjs`
- Modify: `BLUEPRINT.md`

- [ ] Write worker tests for level zero identity, one Loop subdivision of a triangle, crease-edge preservation, cancellation/stale-result discard, and worker failure retaining the original render mesh.
- [ ] Run the focused tests and confirm they fail because the worker/API is absent.
- [ ] Implement a pure-data Loop worker and main-thread cache keyed by logical object, source geometry revision, and requested extra level; preserve a single material per output mesh and do not mutate source meshes.
- [ ] Preserve imported custom attribute data before material splitting and construct crease topology before any split/reorder can lose it; use explicit sharp-edge records as authoritative, not vertex crease values alone.
- [ ] Add an undoable per-logical-object `printRefinement` state (`enabled`, `level`, `status`) and typed events. The imported Blender render mesh is always level zero; refinement is additional.
- [ ] Add a compact Mixo badge in the Outliner and a Properties section showing Blender viewport/render source levels, a `Refine for print` switch, level 1/2 controls, and Original/Refined viewport selection. Default is original and refinement disabled.
- [ ] Teach export clones to use the same derived mesh currently selected for that object; if a requested refinement is unavailable, retain original geometry and require an explicit user choice rather than silently claiming a refined export.
- [ ] Run focused worker/export/UI tests and update BLUEPRINT’s state, worker, export, error, and UI contracts.
- [ ] Commit the Mixomesh refinement feature.

### Task 4: Final cross-repository verification and delivery

**Files:**

- Modify: `S:\ai\mixo3dtool\docs\SESSION_STATE.md`
- Modify: `HANDOFF.md` only if a resumable run remains.

- [ ] Run `python -m pytest tests/unit -q` and the full Blender headless suite in `S:\ai\mixo3dtool`.
- [ ] Run `npm run lint`, `npm run typecheck`, `npm run build`, `npm run test`, `npm run test:browser`, and `npm run test:export` in `S:\ai\mixomesh`.
- [ ] Inspect both diffs and verify all requested behavior, source-preserving invariants, BLUEPRINT/contract updates, and no unrelated changes.
- [ ] Commit session documentation, push both `master` branches to their configured `origin`, and report the commit hashes and fresh verification evidence.
