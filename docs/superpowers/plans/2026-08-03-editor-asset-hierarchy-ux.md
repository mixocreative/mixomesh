# Editor Asset, Hierarchy, and Print UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Make hierarchy, asset browsing, shared shader/image identity, print readiness, and print placement predictable without expanding MIXOMESH into a general DCC.

**Architecture:** Ship four independently releasable slices in dependency order: hierarchy integrity, storage-backed asset indexing, exact shader/image identity, then print/user-flow hardening. Pure modules own policy, Commands own reversible mutations, and UI modules render projections and dispatch typed events.

**Tech Stack:** Babylon.js 9.6.2, Vite 8, JavaScript ES modules, type-only TypeScript contracts, Electron IPC, Node test runner, CDP browser smoke tests, JSON i18n.

---

## File map and test budget

| Slice | New responsibility | Primary files | Expensive gate |
| --- | --- | --- | --- |
| A | Hierarchy lifecycle and row semantics | `core/hierarchy/HierarchyIntegrity.js`, `HierarchyCommands.js`, `Outliner.js` | browser smoke |
| B | Opaque directory index and scoped browser | `storage/*`, `assets/AssetIndex.js`, `AssetPanel.js`, Electron bridge | browser + Electron |
| C | Exact shader/image identity | `TextureImageStore.js`, `ShaderSignature.js`, persistence, shader commands/UI | browser + export |
| D | Readiness, bed fit, import CTA, placement, close flow | `print/BedFit.js`, `PrintReadiness.js`, placement/UI/persistence | all gates |

Work on one slice at a time. Use focused tests for red/green loops; run
lint/typecheck/build once at each slice boundary. Do not run all browser/export/
Electron smokes after every small edit.

**Progress (2026-08-03):** Tasks 1–4 shipped in `776cba6`, `40803d2`,
`153bbf2`, and `947de76`. Task 5 shipped in `7da2184`; Task 6 shipped in
`be2d9d9`; Task 7 shipped in `46ca2fe`; Task 8 shipped in `99571b9`; Task 9
shipped in `d153ef3`; Task 10 shipped in `970e3d4`. Task 11 passed every release
gate and is recorded by the final documentation commit. The plan is complete.

## Task 1: Pin the build-volume-only contract

**Files:**
- Modify: `tests/hygiene.test.mjs`
- Modify: `BLUEPRINT.md`
- Modify: `AGENTS.md`

- [x] Add a profile-schema test:

```js
for (const [id, profile] of Object.entries(printers)) {
  assert.deepEqual(Object.keys(profile).sort(), ['bed', 'displayName', 'vendor'], id);
  assert.equal(['format', 'pipeline', 'colorMode'].some(k => k in profile), false, id);
}
```

- [x] Run `node --import ./tests/register-hooks.mjs --test tests/hygiene.test.mjs`.
  Expected: PASS against the current runtime config.
- [x] Ensure both canonical documents state: profiles provide build-volume
  reference only; OBJ/3MF/STL are explicit; content chooses textured versus
  solid representation.
- [x] Commit:

```powershell
git add AGENTS.md BLUEPRINT.md tests/hygiene.test.mjs
git commit -m "docs: pin build volume profile contract"
```

## Task 2: Define and test hierarchy integrity

**Files:**
- Create: `src/core/hierarchy/HierarchyIntegrity.js`
- Create: `tests/hierarchy-integrity.test.mjs`
- Modify: `BLUEPRINT.md`

- [x] Write failing tests for stale-child removal, recursive imported-group
  pruning, preserved empty user groups, and old-group migration:

```js
const groups = {
  root: { id: 'root', parentId: null, childIds: [], origin: 'import' },
  leaf: { id: 'leaf', parentId: 'root', childIds: ['mesh'], origin: 'import' },
  user: { id: 'user', parentId: null, childIds: ['mesh'], origin: 'user' },
};
assert.deepEqual(planHierarchyRemoval(groups, new Set(['mesh'])).pruneIds.sort(), ['leaf', 'root']);
assert.deepEqual(planHierarchyRemoval({ user: groups.user }, new Set(['mesh'])).pruneIds, []);
assert.equal(normalizeGroupOrigin({}).origin, 'user');
```

- [x] Run `node --import ./tests/register-hooks.mjs --test tests/hierarchy-integrity.test.mjs`.
  Expected: FAIL because the module does not exist.
- [x] Implement the pure API:

```js
export function normalizeGroupOrigin(group) {
  return { ...group, origin: group.origin === 'import' ? 'import' : 'user' };
}

export function planHierarchyRemoval(groups, removedIds) {
  const next = Object.fromEntries(Object.entries(groups).map(([id, g]) => [id, {
    ...normalizeGroupOrigin(g),
    childIds: (g.childIds ?? []).filter(childId => !removedIds.has(childId)),
  }]));
  const pruneIds = [];
  let changed = true;
  while (changed) {
    changed = false;
    for (const g of Object.values(next)) {
      const liveSubgroup = Object.values(next).some(x =>
        x.parentId === g.id && !pruneIds.includes(x.id));
      if (g.origin === 'import' && !g.childIds.length && !liveSubgroup && !pruneIds.includes(g.id)) {
        pruneIds.push(g.id);
        changed = true;
      }
    }
  }
  return { groups: next, pruneIds };
}
```

- [x] Add `origin: 'import' | 'user'` to the canonical Blueprint `GroupNode`
  schema; absent persisted values normalize to `'user'`.
- [x] Re-run the focused test. Expected: PASS.
- [x] Commit:

```powershell
git add src/core/hierarchy/HierarchyIntegrity.js tests/hierarchy-integrity.test.mjs BLUEPRINT.md
git commit -m "feat: define hierarchy lifecycle policy"
```

## Task 3: Repair delete/undo group state

**Files:**
- Modify: `src/core/commands/HierarchyCommands.js`
- Modify: `src/core/import/ImportHierarchy.js`
- Modify: `src/core/persist/ProjectLoader.js`
- Modify: `tests/safety-commands.test.mjs`
- Modify: `tests/persistence.test.mjs`
- Modify: `BLUEPRINT.md`

- [x] Add a failing command test. After execute, no group may contain a deleted
  id; empty imported ancestors are gone; an empty user group remains. Undo must
  deep-equal the original groups and redo must deep-equal the first result:

```js
const before = structuredClone(getState().scene.groups);
const cmd = new DeleteCommand(['mesh']);
cmd.execute();
assert.equal(Object.values(getState().scene.groups).some(g => g.childIds.includes('mesh')), false);
cmd.undo();
assert.deepEqual(getState().scene.groups, before);
```

- [x] Run `node --import ./tests/register-hooks.mjs --test tests/safety-commands.test.mjs`.
  Expected: FAIL on stale membership.
- [x] In `DeleteCommand`, snapshot `groups` before the first execution, compute
  and retain the after snapshot, and apply snapshots via `setState(...,
  { silent: true })`. Dispose/recreate pruned Babylon TransformNodes through
  core hierarchy helpers. Dispatch typed events and `markDirty()` once.
- [x] Stamp imported groups with `origin: 'import'`, `GroupCommand` groups with
  `origin: 'user'`, and normalize absent values during project load.
- [x] Run:

```powershell
node --import ./tests/register-hooks.mjs --test tests/safety-commands.test.mjs tests/persistence.test.mjs
```

  Expected: PASS including old-document migration.
- [x] Commit:

```powershell
git add src/core/commands/HierarchyCommands.js src/core/import/ImportHierarchy.js src/core/persist/ProjectLoader.js tests/safety-commands.test.mjs tests/persistence.test.mjs BLUEPRINT.md
git commit -m "fix: preserve sound hierarchy across delete undo"
```

## Task 4: Clarify Outliner semantics and reveal flow

**Files:**
- Modify: `src/core/Icons.js`
- Modify: `src/ui/Outliner.js`
- Modify: `src/ui/ContextMenu.js`
- Modify: `src/styles/components.css`
- Modify: `src/i18n/locales/en.json`
- Modify: `src/i18n/locales/ja.json`
- Modify: `src/i18n/locales/zh-Hant.json`
- Modify: `tests/browser-smoke.mjs`
- Modify: `BLUEPRINT.md`

- [x] Add a failing browser block for `Import → Group → Object`. Viewport/object
  selection must select only the object row, expand its ancestors, reveal it,
  and use different icons for all three kinds. Empty user groups show `Empty`.
- [x] Run `npm run test:browser`. Expected: FAIL on semantics/reveal assertions.
- [x] Use `Package` for Import, a hierarchy/pivot icon for Group, and `Box` for
  Object. Add translated type tooltips/badges.
- [x] Subscribe to `ACTIVE_OBJECT_CHANGED`; expand collection/group ancestors
  and call `scrollIntoView({ block: 'nearest' })` on the object row without
  selecting its ancestors.
- [x] Add navigation actions **Select Parent**, **Select Siblings**, **Select
  Import Members**, and **Reveal in Outliner**. They change selection/UI state,
  not history.
- [x] Add name search that retains ancestor rows of matching descendants.
  Defer drag-reparent until lifecycle behavior has shipped.
- [x] Run `npm run i18n:check` and `npm run test:browser`. Expected: PASS.
- [x] Commit:

```powershell
git add src/core/Icons.js src/ui/Outliner.js src/ui/ContextMenu.js src/styles/components.css src/i18n tests/browser-smoke.mjs BLUEPRINT.md
git commit -m "feat: clarify outliner hierarchy and reveal selection"
```

## Task 5: Complete opaque directory operations

**Files:**
- Modify: `src/core/storage/StorageAdapter.js`
- Modify: `src/core/storage/DesktopStorageAdapter.js`
- Modify: `src/core/assets/DirMounts.js`
- Modify: `electron/preload.cjs`
- Modify: `electron/main.cjs`
- Modify: `tests/storage-adapter.test.mjs`
- Modify: `tests/electron-smoke.mjs`
- Modify: `docs/adr/0001-storage-adapter-web-electron.md`
- Modify: `BLUEPRINT.md`

- [x] Add failing adapter-contract tests for `mountDirectory`, `listDirectory`,
  and `readFile`, using this runtime-neutral result shape:

```js
{ name: 'tank.glb', path: 'kits/tank.glb', kind: 'file', ref: opaqueRef }
{ name: 'kits', path: 'kits', kind: 'directory', ref: opaqueRef }
```

- [x] Run `node --import ./tests/register-hooks.mjs --test tests/storage-adapter.test.mjs`.
  Expected: FAIL because directory methods are declarations only.
- [x] Implement browser methods over File System Access handles. Implement
  desktop refs as opaque ids mapped to validated paths in the main process.
  Reject traversal and any resolved path outside the selected mount root.
- [x] Route `DirMounts` through `storage`; live refs remain module-local and
  project state stores only serializable descriptors.
- [x] Run the storage test and `npm run test:electron`. Expected: PASS with no
  console, GPU, or IPC errors.
- [x] Commit:

```powershell
git add src/core/storage src/core/assets/DirMounts.js electron tests/storage-adapter.test.mjs tests/electron-smoke.mjs docs/adr/0001-storage-adapter-web-electron.md BLUEPRINT.md
git commit -m "feat: route asset directories through storage adapter"
```

## Task 6: Add the indexed, scoped Asset browser

**Files:**
- Create: `src/core/assets/AssetIndex.js`
- Create: `tests/asset-index.test.mjs`
- Modify: `src/ui/AssetPanel.js`
- Modify: `src/styles/components.css`
- Modify: `src/i18n/locales/en.json`
- Modify: `src/i18n/locales/ja.json`
- Modify: `src/i18n/locales/zh-Hant.json`
- Modify: `tests/browser-smoke.mjs`
- Modify: `BLUEPRINT.md`

- [x] Write failing pure tests for exact-folder browse, descendant search,
  all-library search, kind filter, stable sorting, one result per file, and
  relative-path provenance:

```js
assert.deepEqual(queryAssets(index, {
  mountKey: 'm1', folderPath: 'kits', text: '', scope: 'folder', kind: 'all',
}).map(x => x.path), ['kits/a.glb']);
assert.deepEqual(queryAssets(index, {
  mountKey: 'm1', folderPath: 'kits', text: 'wheel', scope: 'descendants', kind: 'mesh',
}).map(x => x.path), ['kits/parts/wheel.glb']);
```

- [x] Run `node --import ./tests/register-hooks.mjs --test tests/asset-index.test.mjs`.
  Expected: FAIL because the module does not exist.
- [x] Implement an immutable `files`/`folders` index and pure query:

```js
export function queryAssets(index, q) {
  const needle = q.text.trim().toLocaleLowerCase();
  return index.files.filter(file => inScope(file, q))
    .filter(file => q.kind === 'all' || file.assetKind === q.kind)
    .filter(file => !needle || `${file.name}\n${file.path}`.toLocaleLowerCase().includes(needle))
    .toSorted(compareAssetRows);
}
```

- [x] Index only on mount/refresh. In the Sources pane add Session `All`,
  `Used`, `Unused`, `Issues` plus mounted trees. In Assets add breadcrumb,
  scope, kind filter, count, and relative path. Search defaults to descendants
  unless the user explicitly chose another scope.
- [x] Add refresh/unmount; preserve selected path or fall back to its nearest
  existing ancestor. Retain multiple mounts in-session.
- [x] Run the focused test, `npm run i18n:check`, and `npm run test:browser`.
  Expected: PASS.
- [x] Commit:

```powershell
git add src/core/assets/AssetIndex.js src/ui/AssetPanel.js src/styles/components.css src/i18n tests/asset-index.test.mjs tests/browser-smoke.mjs BLUEPRINT.md
git commit -m "feat: add scoped indexed asset browser"
```

## Task 7: Content-address image bytes and texture views

**Files:**
- Create: `src/core/assets/TextureImageStore.js`
- Create: `src/core/assets/TextureView.js`
- Modify: `src/core/assets/TextureSource.js`
- Modify: `src/core/assets/TextureAssets.js`
- Modify: `src/core/persist/ProjectSerializer.js`
- Modify: `src/core/persist/ProjectLoader.js`
- Modify: `src/import/ImportPipeline.ts`
- Modify: `tests/texture-identity.test.mjs`
- Modify: `tests/texture-source.test.mjs`
- Modify: `tests/persistence.test.mjs`
- Modify: `BLUEPRINT.md`

- [x] Write failing tests for same-name/different bytes, same bytes/different
  names, same image/different sampler, and one persisted blob for two views:

```js
assert.notEqual(await hashImage(bytesA), await hashImage(bytesB));
assert.equal(await hashImage(bytesA), await hashImage(bytesACopy));
assert.notEqual(textureViewKey({ imageContentHash: h, wrapU: 1 }),
                textureViewKey({ imageContentHash: h, wrapU: 2 }));
assert.equal(uniqueEmbeddedBlobCount(twoViewsSameHash), 1);
```

- [x] Run the three focused tests. Expected: FAIL because resource and view
  identity are not separated.
- [x] Hash loose-image original bytes before upload. For GPU-only embedded
  images, hash the existing full-resolution PNG from capture-before-cap. Store
  one blob per SHA-256. Texture AssetEntries add:

```js
{
  imageContentHash,
  textureView: { colorSpace, invertY, wrapU, wrapV, samplingMode },
}
```

  UV transform remains a shader field.
- [x] Persist one image payload per hash. Restore image blobs, then texture
  views, then shaders. Equal images with different views create separate
  Babylon textures backed by shared bytes.
- [x] Run focused tests and `npm run test:export`. Expected: PASS with pixels
  retained and duplicate embedded bytes emitted once.
- [x] Commit:

```powershell
git add src/core/assets src/core/persist src/import/ImportPipeline.ts tests/texture-identity.test.mjs tests/texture-source.test.mjs tests/persistence.test.mjs BLUEPRINT.md
git commit -m "feat: content address texture image bytes"
```

## Task 8: Make shader sharing exact and explicit

**Files:**
- Create: `src/core/shaders/ShaderSignature.js`
- Create: `tests/shader-identity.test.mjs`
- Modify: `src/core/ShaderLibrary.js`
- Modify: `src/core/commands/ShaderCommands.js`
- Modify: `src/core/HistoryManager.js`
- Modify: `src/ui/ShaderPanel.js`
- Modify: `src/i18n/locales/en.json`
- Modify: `src/i18n/locales/ja.json`
- Modify: `src/i18n/locales/zh-Hant.json`
- Modify: `tests/shader-live-update.test.mjs`
- Modify: `tests/browser-smoke.mjs`
- Modify: `BLUEPRINT.md`

- [x] Write failing signature tests: names do not matter; every supported
  appearance field and texture-view key does; unsupported features make a
  material ineligible for automatic merge:

```js
assert.equal(signature({ ...base, name: 'A' }).key, signature({ ...base, name: 'B' }).key);
assert.notEqual(signature(base).key, signature({ ...base, opacity: 0.5 }).key);
assert.equal(signature({ ...base, clearCoat: true }).eligible, false);
```

- [x] Run the new test. Expected: FAIL because the module does not exist.
- [x] Return `{ eligible, key, reasons }` from `ShaderSignature`. Import-time
  dedupe silently reuses only eligible exact matches. Preserve the current
  same-name/different-content modal.
- [x] Add `ShaderConsolidateCommand`: snapshot changed object shader ids and
  removed shader/material entries; execute rewires to the chosen canonical
  shader; undo restores all links and entries. Use existing duplication for
  **Make Unique**.
- [x] Show duplicate candidate groups with field equality and linked-object
  counts. Never run consolidation continuously after edits.
- [x] Run the new test, `shader-live-update`, i18n check, and browser smoke.
  Expected: PASS including edit-one-updates-all and undo.
- [x] Commit:

```powershell
git add src/core/shaders/ShaderSignature.js src/core/ShaderLibrary.js src/core/commands/ShaderCommands.js src/core/HistoryManager.js src/ui/ShaderPanel.js src/i18n tests/shader-identity.test.mjs tests/shader-live-update.test.mjs tests/browser-smoke.mjs BLUEPRINT.md
git commit -m "feat: make shader sharing exact and explicit"
```

## Task 9: Add bed fit and readiness projections

**Files:**
- Create: `src/core/print/BedFit.js`
- Create: `src/core/print/PrintReadiness.js`
- Create: `tests/bed-fit.test.mjs`
- Create: `tests/print-readiness.test.mjs`
- Modify: `src/ui/PrintPanel.js`
- Modify: `src/core/print/PrintPipeline.js`
- Modify: `src/i18n/locales/en.json`
- Modify: `src/i18n/locales/ja.json`
- Modify: `src/i18n/locales/zh-Hant.json`
- Modify: `tests/export.test.mjs`
- Modify: `tests/browser-smoke.mjs`
- Modify: `BLUEPRINT.md`

- [x] Write failing tests for exact fit, each axis overflow, below-bed geometry,
  no print parts, unconfirmed units, missing textures, multiple ratios, and
  format independence:

```js
assert.deepEqual(checkBedFit(
  { min: [0, 0, 0], max: [101, 100, 100] }, { x: 100, y: 100, z: 100 }),
  { fits: false, overflowMM: { x: 1, y: 0, z: 0 }, belowBedMM: 0 });
assert.equal(buildReadiness(ctx).issues.find(x => x.code === 'bed-overflow').severity, 'warning');
```

- [x] Run both new tests. Expected: FAIL because modules do not exist.
- [x] Emit stable untranslated issue records, for example:

```js
{ code: 'bed-overflow', severity: 'warning', objectIds, data: { overflowMM } }
{ code: 'no-print-parts', severity: 'error', objectIds: [], data: {} }
```

  Geometry/source errors block; bed overflow and unit uncertainty warn and
  require acknowledgement. No issue hides a format button.
- [x] Rename UI to **Build Volume Preset**. Render readiness and export summary
  above persistent OBJ/3MF/STL buttons; issue rows focus the relevant object or
  field.
- [x] Run focused tests, i18n check, browser smoke, and export smoke. Expected:
  PASS; every format remains available for every profile.
- [x] Commit:

```powershell
git add src/core/print src/ui/PrintPanel.js src/i18n tests/bed-fit.test.mjs tests/print-readiness.test.mjs tests/export.test.mjs tests/browser-smoke.mjs BLUEPRINT.md
git commit -m "feat: add print readiness and build volume fit"
```

## Task 10: Finish import, placement, and dirty-close flows

**Files:**
- Create: `src/ui/ViewportEmptyState.js`
- Create: `src/core/placement/BedPlacement.js`
- Create: `tests/bed-placement.test.mjs`
- Modify: `src/core/commands/PlacementCommands.js`
- Modify: `src/core/HistoryManager.js`
- Modify: `src/ui/CursorPanel.js`
- Modify: `src/ui/ContextMenu.js`
- Modify: `src/ui/ProjectMenu.js`
- Modify: `src/core/PersistenceManager.js`
- Modify: `src/app/main.ts`
- Modify: `electron/main.cjs`
- Modify: `electron/preload.cjs`
- Modify: `src/styles/components.css`
- Modify: `src/i18n/locales/en.json`
- Modify: `src/i18n/locales/ja.json`
- Modify: `src/i18n/locales/zh-Hant.json`
- Modify: `tests/persistence-abort.test.mjs`
- Modify: `tests/electron-smoke.mjs`
- Modify: `tests/browser-smoke.mjs`
- Modify: `BLUEPRINT.md`

- [x] Write failing pure placement tests for **Drop to Bed**, **Center on Bed**,
  and selected-face-normal-to-up **Place Face on Bed**. Pin the final bed offset
  after rotation.
- [x] Implement each as one undoable absolute-transform command; multi-select
  is one history entry and locked objects are skipped/reported.
- [x] Add zero-object **Import Model** and **Open Project** actions. Import uses
  the existing asset picker; Open uses `PersistenceManager.open()`. Hide the
  overlay when a displayable object exists.
- [x] Replace glyph-only placement labels (`X⊣`, `X⊟`, `⊐`) with visible labels
  at normal width and translated `title`/`aria-label` at every width.
- [x] Add close-flow tests with one shared result vocabulary:

```js
{ action: 'save' | 'discard' | 'cancel' }
```

  Browser uses native `beforeunload`; Electron asks renderer dirty state and
  presents one Save/Discard/Cancel prompt. Failed save never closes. Autosave
  recovery remains available after abnormal exit.
- [x] Run placement, persistence-abort, i18n, browser, and Electron tests.
  Expected: PASS without console/GPU/IPC errors.
- [x] Commit:

```powershell
git add src/ui src/core/placement src/core/commands/PlacementCommands.js src/core/HistoryManager.js src/core/PersistenceManager.js src/app/main.ts electron src/styles/components.css src/i18n tests/bed-placement.test.mjs tests/persistence-abort.test.mjs tests/electron-smoke.mjs tests/browser-smoke.mjs BLUEPRINT.md
git commit -m "feat: complete import placement and close flows"
```

## Task 11: Final release and documentation gate

**Files:**
- Modify: `BLUEPRINT.md`
- Modify: `BUILDLOG.md`

- [x] Run in order:

```powershell
npm run lint
npm run typecheck
npm run build
npm test
npm run test:browser
npm run test:export
npm run test:electron
```

  Expected: every command exits 0, with no console, GPU, IPC, or export errors.
  Investigate Electron GPU command-buffer output; do not waive it.
- [x] Audit stale claims/placeholders:

```powershell
rg -n "printer-driven|not undoable|content dedupe|TBD|TODO|PLANNED" AGENTS.md BLUEPRINT.md docs/superpowers
```

  Every hit must be explicit history or match shipped behavior.
- [x] Update the Blueprint baseline and Build Log only after all gates pass.
- [x] Commit:

```powershell
git add BLUEPRINT.md BUILDLOG.md
git commit -m "docs: record editor workflow hardening baseline"
```

## Token-economy protocol

1. Read only the task's listed Blueprint section and files; locate symbols with
   `rg` before loading large modules.
2. Keep policy in small pure modules so Node tests avoid Babylon, DOM, IndexedDB,
   and Electron setup.
3. Add one failing behavior at a time. Use the focused command during red/green.
4. Edit all three locale files as one mechanical batch, then run i18n once.
5. Run browser smoke once per UI slice, export smoke only after Tasks 7/9, and
   Electron smoke only after Tasks 5/10.
6. Commit per task. A failure then requires inspecting one small diff, not
   rebuilding context for the whole roadmap.
7. Exclude Favorites, ratings, tags, cloud sync, saved searches, drag-reparent,
   full auto-arrange, and perceptual image matching from this plan.
