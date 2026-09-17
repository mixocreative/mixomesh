# Watertight Repair + Print Cost Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One-click watertight repair (holes + non-manifold) offered on import, anywhere later, and enforced at export; plus an instant print-cost quote (volume × density × price, support premium, overlap flag) on the Export tab; plus a polygon-budget HUD.

**Architecture:** Repair is a vendored MIT WASM engine (`MeshFixLib`, 8-stage pipeline, typed-array API) wrapped by one module `src/core/repair/MeshRepair.js`; the validator reports `holes` from its `diagnose()`, the existing Auto-Fix path calls it, and the export pipeline repairs **clones** in a new prep step. Cost is a pure module `src/core/print/PrintCost.js` fed by the same ExportContext the writers use, rendered in the Print panel with live inputs stored as per-user settings. Overlap is detected by AABB intersection and only flagged (no Boolean union — the summed volume is the conservative quote).

**Tech Stack:** Vite + Babylon 9.6.2 (existing), MeshFixLib (MIT, ~345 KB wasm, vendored under `public/vendor/meshfix/`), `manifold-3d@3.4.0` (vendored locally so CSG works offline), node:test headless suite, browser smoke via CDP.

## Global Constraints

- Never mutate live scene geometry silently. Repairs on the live mesh happen only via an explicit user click (Auto-Fix) or the opt-in setting, and are recorded in `sceneObject.geometryFixes` and undoable.
- Export repairs run on export CLONES only (PrintPipeline clones every mesh already).
- Fail closed: a repair that cannot make a mesh watertight leaves a warning; the export gate decides.
- No Boolean union for volume. Sum of per-object volumes; overlaps are flagged, not subtracted.
- All user-facing strings go through `t()`; add keys to `src/i18n/locales/{en,ja,zh-Hant}.json`; `npm run i18n:check` must stay at 0 gaps.
- Per-user settings live in `src/config/default-settings.json` + `SettingsStore.SCHEMA`; per-project content lives in state slices persisted by `ProjectSerializer`.
- Axis/winding: everything geometric goes through `src/core/print/PrintSpace.js` (verified 2026-09-17). Do not add rotations or blanket winding flips.
- Verification gate for every task: `npm run lint`, `npm test`, `npm run i18n:check`; browser smoke (`npm run test:browser`, `npm run test:export`) at the end of Tasks 3, 6, 8.
- Licences: MeshFixLib MIT (vendor the LICENSE file), manifold-3d Apache-2.0. `@goodtools/meshrepair` is GPL — do NOT use.
- Commit per task on `master` (solo-dev rule, no branches).

---

## File Structure

| File | Responsibility |
|---|---|
| `public/vendor/meshfix/{mesh-fix-lib.js,mesh-fix-core.js,mesh-fix-core.wasm,LICENSE}` | vendored MeshFixLib |
| `public/vendor/manifold-3d/{manifold.js,manifold.wasm,LICENSE}` | vendored Manifold for offline CSG2 |
| `src/core/repair/MeshRepair.js` | load MeshFixLib once; `diagnoseMesh(mesh)`, `repairMesh(mesh, opts)`; Babylon ↔ nested-array conversion; UV re-attachment; size cap |
| `src/core/MeshValidator.js` | new `holes` result from `diagnose()`; `autoFix` routes `holes`/`nonManifold` to MeshRepair |
| `src/core/print/PrintPrep.js`, `PrintFormats.js`, `PrintPipeline.js` | new `repair` prep step on clones; export gate data |
| `src/core/print/PrintCost.js` | pure: unit volumes (mm³), grams, cost, support premium, overlap flag |
| `src/config/printers.json` | per-printer `materials[]` (name, density g/cm³, default price/g, support material) |
| `src/config/default-settings.json`, `src/core/SettingsStore.js` | `cost` section (pricePerGram, supportPricePerGram, supportPercent, currency, materialId) + `print.strictExport`, `print.repairOnImport` |
| `src/ui/PrintPanel.js` | Repair-all button, export gate modal, Cost block with live inputs |
| `src/ui/Outliner.js`, `src/ui/ContextMenu.js`, `src/core/assets/AssetRegistration.js` | Fix entry points: badge click, context item, import toast action |
| `src/ui/MeshStats.js`, `src/core/storage/capabilities.js` | polygon budget in HUD |
| `tests/mesh-repair.test.mjs`, `tests/print-cost.test.mjs`, + edits to `validator.test.mjs`, `export.test.mjs`, `print-readiness.test.mjs`, `settings-store.test.mjs` | tests |

Interfaces shared across tasks (exact names):

```js
// src/core/repair/MeshRepair.js
export const REPAIR_TRIANGLE_CAP = 300_000;
export async function ensureRepairEngine();                 // loads /vendor/meshfix once; throws if unavailable
export async function diagnoseMesh(mesh);                   // → { boundaryEdges, nonManifoldEdges, components, isWatertight, triangles }
export async function repairMesh(mesh, opts = {});          // mutates mesh geometry; → { holesFilled, nmFixed, normalsFlipped, merged, isWatertight, changed }
export function meshToArrays(mesh);                         // → { V: number[][], T: number[][] } (positions in mesh-local BU)
export function arraysToMesh(mesh, V, T, originalPositions, originalUvs); // writes back; re-attaches UVs by nearest original vertex

// src/core/print/PrintCost.js
export function unitVolumesMM3(ctx);                        // → Map<logicalId, { volumeMM3, triangles, watertight }>
export function overlappingPairs(ctx);                      // → Array<[logicalIdA, logicalIdB]> (AABB test in print space)
export function quote(ctx, costSettings, material);         // → { volumeCM3, grams, materialCost, supportGrams, supportCost, total, currency, approximate:boolean, overlaps:number, reasons:string[] }
```

---

### Task 1: Vendor MeshFixLib + Manifold; engine loader with a size cap

**Files:**
- Create: `public/vendor/meshfix/mesh-fix-lib.js`, `public/vendor/meshfix/mesh-fix-core.js`, `public/vendor/meshfix/mesh-fix-core.wasm`, `public/vendor/meshfix/LICENSE` (copied verbatim from https://github.com/hololocheck/MeshFixLib — MIT)
- Create: `public/vendor/manifold-3d/manifold.js`, `public/vendor/manifold-3d/manifold.wasm`, `public/vendor/manifold-3d/LICENSE` (from `npm pack manifold-3d@3.4.0`, Apache-2.0)
- Create: `src/core/repair/MeshRepair.js`
- Modify: `src/core/print/PrintPipeline.js:41-52` (`_ensureCSG2` → pass `manifoldUrl`)
- Modify: `src/core/BooleanService.js:85-94` (same `manifoldUrl`)
- Test: `tests/mesh-repair.test.mjs`

**Interfaces:**
- Produces: `ensureRepairEngine`, `diagnoseMesh`, `repairMesh`, `meshToArrays`, `arraysToMesh`, `REPAIR_TRIANGLE_CAP` (signatures above). Headless tests inject a fake engine via `MeshRepair.__test.setEngine(fake)`.

- [ ] **Step 1: Vendor the files**

```bash
cd S:/ai/mixomesh
mkdir -p public/vendor/meshfix public/vendor/manifold-3d
curl -L -o public/vendor/meshfix/mesh-fix-lib.js  https://raw.githubusercontent.com/hololocheck/MeshFixLib/main/mesh-fix-lib.js
curl -L -o public/vendor/meshfix/mesh-fix-core.js https://raw.githubusercontent.com/hololocheck/MeshFixLib/main/build/mesh-fix-core.js
curl -L -o public/vendor/meshfix/mesh-fix-core.wasm https://raw.githubusercontent.com/hololocheck/MeshFixLib/main/build/mesh-fix-core.wasm
curl -L -o public/vendor/meshfix/LICENSE https://raw.githubusercontent.com/hololocheck/MeshFixLib/main/LICENSE
cd /tmp && npm pack manifold-3d@3.4.0 && tar xzf manifold-3d-3.4.0.tgz
cp package/manifold.js package/manifold.wasm package/LICENSE S:/ai/mixomesh/public/vendor/manifold-3d/
```
Check the first 20 lines of each `.js` say what the README claims (ES module export named `MeshFixLib`; Manifold `export default Module`). If `mesh-fix-lib.js` imports `jszip`, replace that import line with `import JSZip from 'jszip'` only if the 3MF helpers are needed — we never call them; delete the 3MF section or leave the import resolvable via Vite (jszip is a project dependency).

- [ ] **Step 2: Write the failing test**

```js
// tests/mesh-repair.test.mjs
import assert from 'node:assert/strict';
import { installEnv } from './env.mjs';
installEnv();
const R = await import('../src/core/repair/MeshRepair.js');

let passed = 0, failed = 0; const out = [];
async function test(name, fn) { try { await fn(); out.push(`PASS  ${name}`); passed++; } catch (e) { out.push(`FAIL  ${name}\n      ${e.stack || e.message}`); failed++; } }

function fakeMesh(positions, indices, uvs = null) {
  const data = { position: Float32Array.from(positions), uv: uvs ? Float32Array.from(uvs) : null };
  let idx = Array.from(indices);
  return {
    name: 'm', sideOrientation: 1, material: null,
    getVerticesData: (k) => data[k], getIndices: () => idx,
    setVerticesData: (k, v) => { data[k] = Float32Array.from(v); },
    setIndices: (v) => { idx = Array.from(v); },
    createNormals() {}, refreshBoundingInfo() {},
    getTotalVertices: () => data.position.length / 3,
  };
}
// Open tetra: three faces, one missing → 3 boundary edges.
const OPEN_POS = [0,0,0, 10,0,0, 0,20,0, 0,0,30];
const OPEN_IDX = [0,2,1, 0,1,3, 0,3,2];

await test('meshToArrays / arraysToMesh round-trip and UV re-attachment by nearest vertex', () => {
  const m = fakeMesh(OPEN_POS, OPEN_IDX, [0,0, 1,0, 0,1, 1,1]);
  const { V, T } = R.meshToArrays(m);
  assert.deepEqual(V[1], [10, 0, 0]); assert.deepEqual(T[0], [0, 2, 1]);
  // engine output: same vertices reordered + one new triangle closing the hole
  const V2 = [V[3], V[0], V[1], V[2]]; const T2 = [[1,3,2],[1,2,0],[1,0,3],[2,3,0]];
  R.arraysToMesh(m, V2, T2, Float32Array.from(OPEN_POS), Float32Array.from([0,0, 1,0, 0,1, 1,1]));
  assert.equal(m.getTotalVertices(), 4);
  assert.deepEqual(Array.from(m.getVerticesData('uv')).slice(0, 2), [1, 1], 'first new vertex (was #3) got vertex #3 UVs');
  assert.equal(m.getIndices().length, 12);
});

await test('repairMesh uses the engine, reports holesFilled and watertight, refuses over the cap', async () => {
  R.__test.setEngine({
    diagnose: (V, T) => ({ v: V.length, t: T.length, boundary: 3, nonManifold: 0, windingInconsistencies: 0, oppositeWindingPairs: 0, components: 1, isWatertight: false }),
    repairObject: async (V, T) => ({ V, T: [...T, [1, 2, 3]], report: { holesFilled: 1, nmFixed: 0, normalsFlipped: 0, merged: 0 } }),
  });
  const m = fakeMesh(OPEN_POS, OPEN_IDX);
  const d = await R.diagnoseMesh(m);
  assert.equal(d.boundaryEdges, 3); assert.equal(d.isWatertight, false);
  const r = await R.repairMesh(m);
  assert.equal(r.holesFilled, 1); assert.equal(r.changed, true); assert.equal(m.getIndices().length, 12);
  const big = fakeMesh(OPEN_POS, new Array(R.REPAIR_TRIANGLE_CAP * 3 + 3).fill(0));
  await assert.rejects(R.repairMesh(big), /too large to repair in the browser/);
});

console.log('\n' + out.join('\n')); console.log(`\n${passed} passed, ${failed} failed\n`); process.exit(failed ? 1 : 0);
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --import ./tests/register-hooks.mjs tests/mesh-repair.test.mjs`
Expected: FAIL — `Cannot find module '../src/core/repair/MeshRepair.js'`

- [ ] **Step 4: Implement MeshRepair.js**

```js
// src/core/repair/MeshRepair.js
// One-click watertight repair. Engine = vendored MeshFixLib (MIT, public/vendor/meshfix):
// merge → degenerate → winding → duplicates → normals → non-manifold edges/vertices → hole fill.
// Runs on the main thread inside the ProgressOverlay; capped so a tab cannot be blown.
const CLOCKWISE = 0;
export const REPAIR_TRIANGLE_CAP = 300_000;
let _engine = null; let _loading = null;

export async function ensureRepairEngine() {
  if (_engine) return _engine;
  if (!_loading) {
    _loading = (async () => {
      const mod = await import(/* @vite-ignore */ `${import.meta.env?.BASE_URL ?? '/'}vendor/meshfix/mesh-fix-lib.js`);
      const lib = new mod.default();
      await lib.init(`${import.meta.env?.BASE_URL ?? '/'}vendor/meshfix/`);
      _engine = lib; return lib;
    })().catch(err => { _loading = null; throw new Error(`Mesh repair engine unavailable: ${err?.message ?? err}`); });
  }
  return _loading;
}

export function meshToArrays(mesh) {
  const p = mesh.getVerticesData('position'); const idx = mesh.getIndices() ?? [];
  const V = []; for (let i = 0; i < p.length; i += 3) V.push([p[i], p[i + 1], p[i + 2]]);
  const T = []; for (let i = 0; i + 2 < idx.length; i += 3) T.push([idx[i], idx[i + 1], idx[i + 2]]);
  return { V, T };
}

// Write repaired arrays back. MeshFixLib re-indexes, so UVs are re-attached
// by nearest ORIGINAL vertex (grid hash, exact hits first). Filled triangles
// inherit the UV of their nearest source vertex — a smear inside a hole is
// acceptable; a lost texture on the rest of the part is not.
export function arraysToMesh(mesh, V, T, originalPositions, originalUvs) {
  const pos = new Float32Array(V.length * 3);
  for (let i = 0; i < V.length; i++) { pos[i * 3] = V[i][0]; pos[i * 3 + 1] = V[i][1]; pos[i * 3 + 2] = V[i][2]; }
  const ind = new Uint32Array(T.length * 3);
  for (let i = 0; i < T.length; i++) { ind[i * 3] = T[i][0]; ind[i * 3 + 1] = T[i][1]; ind[i * 3 + 2] = T[i][2]; }
  mesh.setVerticesData('position', pos, true);
  if (originalUvs && originalPositions) {
    const lookup = _nearestIndex(originalPositions);
    const uv = new Float32Array(V.length * 2);
    for (let i = 0; i < V.length; i++) { const j = lookup(V[i]); uv[i * 2] = originalUvs[j * 2]; uv[i * 2 + 1] = originalUvs[j * 2 + 1]; }
    mesh.setVerticesData('uv', uv, true);
  }
  mesh.setIndices(ind, null, true);
  mesh.createNormals?.(true); mesh.refreshBoundingInfo?.();
}

function _nearestIndex(positions) {
  const n = positions.length / 3; const cell = 1e-4; const map = new Map();
  const key = (x, y, z) => `${Math.round(x / cell)}:${Math.round(y / cell)}:${Math.round(z / cell)}`;
  for (let i = 0; i < n; i++) map.set(key(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]), i);
  return ([x, y, z]) => {
    const hit = map.get(key(x, y, z)); if (hit !== undefined) return hit;
    let best = 0, bd = Infinity;
    for (let i = 0; i < n; i++) { const dx = positions[i * 3] - x, dy = positions[i * 3 + 1] - y, dz = positions[i * 3 + 2] - z; const d = dx * dx + dy * dy + dz * dz; if (d < bd) { bd = d; best = i; } }
    return best;
  };
}

export async function diagnoseMesh(mesh) {
  const lib = await ensureRepairEngine(); const { V, T } = meshToArrays(mesh);
  const d = lib.diagnose(V, T);
  return { boundaryEdges: d.boundary, nonManifoldEdges: d.nonManifold, components: d.components, isWatertight: !!d.isWatertight, triangles: T.length };
}

export async function repairMesh(mesh, opts = {}) {
  const tris = (mesh.getIndices()?.length ?? 0) / 3;
  if (tris > (opts.triangleCap ?? REPAIR_TRIANGLE_CAP)) throw new Error(`"${mesh.name}" is too large to repair in the browser (${tris} triangles > ${REPAIR_TRIANGLE_CAP})`);
  const lib = await ensureRepairEngine(); const { V, T } = meshToArrays(mesh);
  const originalPositions = Float32Array.from(mesh.getVerticesData('position'));
  const originalUvs = mesh.getVerticesData('uv') ? Float32Array.from(mesh.getVerticesData('uv')) : null;
  const out = await lib.repairObject(V, T, opts.onProgress, { removeSmallShells: false, repairSelfIntersections: false, ...opts.engine });
  const r = out.report ?? {};
  const changed = (r.holesFilled | 0) + (r.nmFixed | 0) + (r.normalsFlipped | 0) + (r.merged | 0) + (r.degenerateRemoved | 0) > 0 || out.T.length !== T.length;
  if (changed) arraysToMesh(mesh, out.V, out.T, originalPositions, originalUvs);
  // Repaired output is native (CounterClockWise) winding; a ClockWise-flagged glTF clone must be re-tagged (same rule as PrintPipeline._csgRebake).
  if (changed && mesh.sideOrientation === CLOCKWISE) mesh.sideOrientation = 1;
  const after = lib.diagnose(out.V, out.T);
  return { holesFilled: r.holesFilled | 0, nmFixed: r.nmFixed | 0, normalsFlipped: r.normalsFlipped | 0, merged: r.merged | 0, isWatertight: !!after.isWatertight, changed };
}

export const __test = { setEngine(e) { _engine = e; _loading = Promise.resolve(e); } };
```

Also in `PrintPipeline._ensureCSG2` and `BooleanService._ensureCsg2`, call `B.InitializeCSG2Async({ manifoldUrl: `${import.meta.env?.BASE_URL ?? '/'}vendor/manifold-3d` })` (path without trailing slash; Babylon appends `/manifold.js`). Electron loads `dist/index.html` from file, so `BASE_URL` must resolve relative — verify with `npm run test:electron` in Task 8.

- [ ] **Step 5: Run test to verify it passes**

Run: `node --import ./tests/register-hooks.mjs tests/mesh-repair.test.mjs` → `2 passed, 0 failed`. Then `npm run lint`.

- [ ] **Step 6: Commit**

```bash
git add public/vendor src/core/repair/MeshRepair.js src/core/print/PrintPipeline.js src/core/BooleanService.js tests/mesh-repair.test.mjs
git commit -m "feat: vendored MeshFixLib repair engine + local Manifold (offline CSG)"
```

---

### Task 2: Validator reports `holes`; Auto-Fix repairs holes + non-manifold through the engine

**Files:**
- Modify: `src/core/MeshValidator.js` (`validateMesh` single-part path ~lines 326-410; `autoFix` ~483; `applyGeometryFix` ~435)
- Modify: `src/ui/PrintPanel.js:300-360` (per-result Auto-Fix already calls `MeshValidator.autoFix(mesh, results)` — no change unless the result type list is hard-coded)
- Test: `tests/validator.test.mjs`

**Interfaces:**
- Consumes: `diagnoseMesh`, `repairMesh` from Task 1.
- Produces: validation result `{ type: 'holes', severity: 'warning', count: <boundaryEdges>, autoFixAvailable: true, fixed: false, message }`; `applyGeometryFix(mesh, 'holes')` and `applyGeometryFix(mesh, 'nonManifold')` both call `repairMesh`; `geometryFixes` records `'holes'` like the others.

- [ ] **Step 1: Write the failing tests** (append to `tests/validator.test.mjs`, reuse its `buildMesh` helper)

```js
await test('open mesh → holes warning with count, auto-fix available', async () => {
  const R = await import('../src/core/repair/MeshRepair.js');
  R.__test.setEngine({ diagnose: () => ({ boundary: 3, nonManifold: 0, components: 1, isWatertight: false }), repairObject: async (V, T) => ({ V, T: [...T, [1,2,3]], report: { holesFilled: 1 } }) });
  const m = buildMesh([[0,2,1],[0,1,3],[0,3,2]]);           // 3 of 4 tetra faces
  const results = await MeshValidator.validateMesh(m);
  const holes = results.find(r => r.type === 'holes');
  assert.ok(holes, 'holes reported'); assert.equal(holes.count, 3); assert.equal(holes.autoFixAvailable, true);
  await MeshValidator.autoFix(m, results);
  assert.equal(m.getIndices().length, 12, 'engine closed the hole');
  assert.equal(holes.fixed, true);
});
await test('engine unavailable → holes still reported, autoFixAvailable false, no throw', async () => {
  const R = await import('../src/core/repair/MeshRepair.js');
  R.__test.setEngine(null);
  const m = buildMesh([[0,2,1],[0,1,3],[0,3,2]]);
  const results = await MeshValidator.validateMesh(m);
  const holes = results.find(r => r.type === 'holes');
  assert.ok(holes); assert.equal(holes.autoFixAvailable, false);
});
```

- [ ] **Step 2: Run to verify it fails** — `node --import ./tests/register-hooks.mjs tests/validator.test.mjs` → both FAIL (`holes` undefined).

- [ ] **Step 3: Implement**

In `validateMesh` single-part branch, after the `_topology` call:
```js
let repairDiag = null;
try { repairDiag = await diagnoseMesh(mesh); } catch { /* engine missing: fall back to edge count only */ }
const boundary = repairDiag?.boundaryEdges ?? badEdgeCount;
if (boundary > 0) results.push({
  type: 'holes', severity: 'warning', count: boundary,
  autoFixAvailable: !!repairDiag,   // engine present ⇒ repair can run
  fixed: false,
  message: `${boundary} open edge${boundary === 1 ? '' : 's'} (holes) — Auto-Fix fills them`,
});
```
(Keep the existing `nonManifold` result; when `repairDiag` is present set its `autoFixAvailable: true` too.)
In `applyGeometryFix(mesh, type)`: `if (type === 'holes' || type === 'nonManifold') { const r = await repairMesh(mesh); return r.changed; }` — make `applyGeometryFix` async if it is not; update `autoFix` to `await` it and to mark `result.fixed = true` when it returns truthy. Import: `import { diagnoseMesh, repairMesh } from './repair/MeshRepair.js';`. `__test.setEngine(null)` must make `diagnoseMesh` throw (`ensureRepairEngine` with `_engine = null` and `_loading = Promise.reject(...)` — implement `setEngine(null)` as `_engine = null; _loading = Promise.reject(new Error('no engine'));` and swallow the unhandled rejection with `.catch(() => {})`).

- [ ] **Step 4: Run** — validator tests pass; `npm test`; `npm run lint`.

- [ ] **Step 5: Commit** — `git commit -am "feat: validator reports holes; Auto-Fix repairs holes + non-manifold via MeshFixLib"`

---

### Task 3: Fix entry points — import toast action, Outliner badge, context menu, Print panel "Repair all"

**Files:**
- Modify: `src/core/assets/AssetRegistration.js:221-250` (`queueValidation` → the `toast.validateWarnings` toast gets an `onClick` when any result is fixable)
- Modify: `src/ui/Outliner.js:~286-310` (status icon click → `VALIDATION_FOCUS_REQUESTED` + fix), `src/ui/ContextMenu.js:~145-160` (new item `action: 'repair-geometry'`)
- Modify: `src/ui/PrintPanel.js` (a "Repair all" button above the per-object list)
- Modify: `src/core/MeshValidator.js` (export `repairObject(meshId)` = validate → autoFix → re-validate → record `geometryFixes` + `markDirty` + history entry, so every entry point shares one path)
- Modify: `src/i18n/locales/*.json` — keys `toast.validateWarningsFix` ("⚠ {name}: {warns} warning(s) — click to Auto-Fix"), `context.repairGeometry` ("Repair geometry"), `print.repairAll` ("Repair all"), `toast.repaired` ("✓ {name}: {holes} hole(s) filled, {nm} non-manifold edge(s) fixed")
- Test: `tests/validator.test.mjs` (repairObject records fixes and dirties), UI wiring checked by `npm run test:browser` (add an assert that `#pp-repair-all` exists when a warning is cached)

**Interfaces:**
- Produces: `MeshValidator.repairObject(meshId) → Promise<{ holesFilled, nmFixed, remaining: results[] }>`.

- [ ] **Step 1: Failing test** (validator.test.mjs): register a fake mesh in `AssetLoader.getBabylonMesh` map + a scene object, call `repairObject('m1')`, assert `getState().scene.objects.m1.geometryFixes` contains `'holes'`, `PersistenceManager.isDirty()` true, returned `remaining` has no `holes`.
- [ ] **Step 2: Run → FAIL** (`repairObject is not a function`).
- [ ] **Step 3: Implement `repairObject`** in MeshValidator (uses `validateMesh`, `autoFix`, `setState` on `geometryFixes`, `markDirty`, then `validateMesh` again and writes the cache). Wire: toast `onClick: () => repairObject(meshId)` when `results.some(r => r.autoFixAvailable)`; Outliner warning icon `title` becomes "click to repair", click → `repairObject`; ContextMenu item calls `repairObject` for every selected object; PrintPanel "Repair all" iterates objects with fixable cached results (sequential, ProgressOverlay).
- [ ] **Step 4: Run** validator test, `npm test`, `npm run lint`, `npm run i18n:check`, `npm run test:browser`.
- [ ] **Step 5: Commit** — `"feat: one-click geometry repair from import toast, outliner, context menu, print panel"`.

---

### Task 4: Export gate — repair clones, three-way prompt, strict setting

**Files:**
- Modify: `src/core/print/PrintPrep.js` (new step `repair(mesh, ctx)` → `repairMesh` on the CLONE, errors collected into `ctx.repairSkipped` like `csgSkipped`), `PrintFormats.js` (insert `'repair'` after `weld`/`weldSolidOnly` in all three prep lists), `PrintPipeline.js` (`_runExport`: when `options.repair === false` skip the step; after prep, if any clone is still not watertight and `state.print.strictExport` is true → throw `_exportError('Parts are not watertight', list)`)
- Modify: `src/ui/PrintPanel.js:504-531` (`runExport`: replace `_confirmExportWithWarnings` with a modal `exportGate` offering **Auto-fix and export** / **Export anyway** / **Cancel**; "Auto-fix" = call `repairObject` on each affected object, re-read readiness, then export; "Export anyway" passes `{ repair: true }` so clones are still repaired and the acknowledgement is toasted `toast.exportedWithWarnings`), `src/ui/Modal.js` registry for `exportGate`
- Modify: `src/config/default-settings.json` (`print.strictExport: false`), `src/core/SettingsStore.js` SCHEMA `print` fields += `'strictExport'`, `src/ui/PrintPanel.js` toggle `#pp-strict-export`
- Modify: locales — `print.exportGate.title`, `print.exportGate.fixAndExport`, `print.exportGate.exportAnyway`, `print.exportGate.cancel`, `print.strictExport`, `toast.exportedWithWarnings`
- Test: `tests/export.test.mjs` (repair step runs on clones only: registry mesh untouched, clone `__repaired`; strict mode blocks when engine reports not watertight; non-strict exports with `ctx.repairSkipped` and a warning toast), `tests/settings-store.test.mjs` (`strictExport` persists per user)

**Interfaces:**
- Consumes: `repairMesh` (Task 1), `repairObject` (Task 3).
- Produces: `ctx.repairSkipped: string[]`, export option `repair?: boolean`, setting `print.strictExport`.

- [ ] **Step 1: Failing tests** (export.test.mjs): stub `MeshRepair.__test.setEngine` with a spy; export OBJ; assert spy called with the clone (name ends `__export`) and never with the registry mesh; with engine returning `isWatertight:false` and `state.print.strictExport = true` → rejects `/not watertight/`; with strict false → resolves, toasts include `warning` mentioning the part.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** prep step, format lists, strict check, modal + panel wiring, settings schema.
- [ ] **Step 4: Run** export tests, settings tests, `npm test`, `npm run lint`, `npm run i18n:check`.
- [ ] **Step 5: Commit** — `"feat: export gate repairs clones; fix-and-export / export-anyway / cancel; strict export setting"`.

---

### Task 5: Opt-in "Repair on import" setting

**Files:**
- Modify: `src/config/default-settings.json` (`print.repairOnImport: false`), `SettingsStore.js` SCHEMA `print` fields += `'repairOnImport'`, `src/core/assets/AssetRegistration.js:221-250` (`queueValidation`: after validation completes, if setting on and any result is fixable → `repairObject(meshId)` then toast `toast.repaired`), `src/ui/PrintPanel.js` toggle `#pp-repair-on-import`, locales `print.repairOnImport`
- Test: `tests/library-import.test.mjs` (with setting on and a fake engine, `loadFromBlob` ends with `geometryFixes` containing `'holes'`; with setting off it does not)

- [ ] Steps: failing test → run → implement → run (`npm test`, lint, i18n) → commit `"feat: opt-in repair on import"`.

---

### Task 6: Print cost — materials table, PrintCost.js, Export-tab block with instant recompute

**Files:**
- Modify: `src/config/printers.json` — every printer gets `"materials": [{ "id": "...", "name": "...", "densityGcm3": <n>, "pricePerGram": <n>, "supportDensityGcm3": <n>, "supportPricePerGram": <n>, "defaultSupportPercent": <n> }]`. Seed: Mimaki 3DUJ `{ id:'mimaki-model', name:'Model resin (MH-100)', densityGcm3:1.1, pricePerGram:0.5, supportDensityGcm3:1.1, supportPricePerGram:0.2, defaultSupportPercent:40 }`; FDM printers `{ id:'pla', name:'PLA', densityGcm3:1.24, pricePerGram:0.03, supportDensityGcm3:1.24, supportPricePerGram:0.03, defaultSupportPercent:15 }`; `custom` gets PLA. Prices are placeholders the user edits in the panel.
- Create: `src/core/print/PrintCost.js`
- Modify: `src/config/default-settings.json` — new section `"cost": { "materialId": "", "pricePerGram": 0, "supportPricePerGram": 0, "supportPercent": 0, "currency": "USD" }` (0 = "use the material default"); `SettingsStore.js` SCHEMA += `{ key: 'cost', path: ['cost'], fields: null }`, `SECTIONS.cost`, and `StateManager.INITIAL_STATE` gets `cost` from defaults
- Modify: `src/ui/PrintPanel.js` — new "Cost" block on the Export tab: material `<select>` (from the selected printer's `materials`), inputs `#pp-cost-price` (per gram), `#pp-cost-support-price`, `#pp-cost-support-pct`, currency text; a result line `"{volume} cm³ · {grams} g · {materialCost} + support {supportCost} = {total} {currency}"` and an `approximate` badge with reasons. Re-rendered on `input` events (write settings via `setState` SILENT + `SettingsStore` save) and on `VALIDATION_COMPLETE`, `HISTORY_*`, `SELECTION_CHANGED` (same list the readiness block already listens to).
- Modify: locales — `print.cost.title`, `print.cost.material`, `print.cost.pricePerGram`, `print.cost.supportPrice`, `print.cost.supportPercent`, `print.cost.result`, `print.cost.approximate`, `print.cost.reasonNotWatertight` ("{n} part(s) not watertight — volume approximate"), `print.cost.reasonOverlap` ("{n} overlapping pair(s) counted twice"), `print.cost.reasonTooBig`
- Test: `tests/print-cost.test.mjs`, `tests/settings-store.test.mjs`, `tests/hygiene.test.mjs` (every printer row has ≥1 material with positive density)

**Interfaces:**
- Consumes: `buildExportContext`, `collectPrintUnits` (ExportContext.js), `positionsToPrintSpace`, `printIndices`, `signedVolume` (PrintSpace.js), validation cache in `state.scene.validation`.
- Produces: `unitVolumesMM3(ctx)`, `overlappingPairs(ctx)`, `quote(ctx, costSettings, material)` (signatures in File Structure).

- [ ] **Step 1: Failing test**

```js
// tests/print-cost.test.mjs (harness like export.test.mjs: installEnv, StateManager, fake meshes with real positions/indices)
const tetra = { pos: [0,0,0, -10,0,0, 0,20,0, 0,0,30], idx: [0,1,2, 0,3,1, 0,2,3, 1,3,2] }; // Babylon copy of the 1000 mm³ tetra (CW-flagged)
await test('unitVolumesMM3: 1000 mm³ tetra at ratio 1, ×8 at ratio 2', () => {
  const ctx = ctxWith([{ id: 'a', mesh: fakeMesh(tetra, { side: 0 }) }], { target: null });
  assert.ok(Math.abs(unitVolumesMM3(ctx).get('a').volumeMM3 - 1000) < 1e-6);
  const ctx2 = ctxWith([{ id: 'a', mesh: fakeMesh(tetra, { side: 0 }) }], { target: 2 });   // print at 2× reference
  assert.ok(Math.abs(unitVolumesMM3(ctx2).get('a').volumeMM3 - 8000) < 1e-3);
});
await test('quote: grams = cm³ × density; support premium; overlap flagged not subtracted', () => {
  const ctx = ctxWith([{ id: 'a', mesh: fakeMesh(tetra) }, { id: 'b', mesh: fakeMesh(tetra, { offset: [2, 0, 0] }) }]);
  const q = quote(ctx, { pricePerGram: 0.5, supportPricePerGram: 0.2, supportPercent: 40, currency: 'USD' }, { densityGcm3: 1.1, supportDensityGcm3: 1.1 });
  assert.ok(Math.abs(q.volumeCM3 - 2) < 1e-6, 'sum of both (overlap NOT subtracted)');
  assert.ok(Math.abs(q.grams - 2.2) < 1e-6); assert.ok(Math.abs(q.materialCost - 1.1) < 1e-6);
  assert.ok(Math.abs(q.supportGrams - 0.88) < 1e-6); assert.ok(Math.abs(q.total - (1.1 + 0.176)) < 1e-6);
  assert.equal(q.overlaps, 1); assert.equal(q.approximate, true); assert.ok(q.reasons.some(r => /overlap/.test(r)));
});
await test('quote: not-watertight part → approximate with reason; missing price → total null', () => { /* validation cache with a holes result → approximate; pricePerGram 0 and material without price → total null, reasons include "no price" */ });
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement PrintCost.js**

```js
import { positionsToPrintSpace, printIndices, signedVolume } from './PrintSpace.js';
const BU_TO_MM = 1000;
export function unitVolumesMM3(ctx) {
  const out = new Map();
  for (const unit of ctx.units) {
    let vol = 0, tris = 0;
    for (const part of unit.parts) {
      const mesh = part.mesh; if (!mesh?.getVerticesData) continue;
      mesh.computeWorldMatrix?.(true);
      const local = mesh.getVerticesData('position'); const idx = printIndices(mesh);
      const world = _toWorld(local, mesh.getWorldMatrix?.());           // BU, world
      const mm = new Float32Array(world.length);
      for (let i = 0; i < world.length; i += 3) {                       // pivot-anchored ratio like PrintPrep.flattenWorld
        mm[i]     = ((world[i]     - ctx.pivot.x) * ctx.ratioFactor + ctx.pivot.x) * BU_TO_MM;
        mm[i + 1] = ((world[i + 1] - ctx.pivot.y) * ctx.ratioFactor + ctx.pivot.y) * BU_TO_MM;
        mm[i + 2] = ((world[i + 2] - ctx.pivot.z) * ctx.ratioFactor + ctx.pivot.z) * BU_TO_MM;
      }
      vol += signedVolume(positionsToPrintSpace(mm), idx); tris += idx.length / 3;
    }
    const watertight = !_hasOpenResult(ctx.state, unit);
    out.set(unit.logicalId, { volumeMM3: Math.abs(vol), triangles: tris, watertight });
  }
  return out;
}
export function overlappingPairs(ctx) { /* per-unit world AABB in mm; pairwise intersect with 0.01 mm epsilon; return id pairs */ }
export function quote(ctx, s, material) {
  const vols = unitVolumesMM3(ctx); const pairs = overlappingPairs(ctx);
  const volumeCM3 = [...vols.values()].reduce((a, v) => a + v.volumeMM3, 0) / 1000;
  const density = material?.densityGcm3; const price = s.pricePerGram || material?.pricePerGram || 0;
  const sDensity = material?.supportDensityGcm3 ?? density; const sPrice = s.supportPricePerGram || material?.supportPricePerGram || price;
  const pct = s.supportPercent || material?.defaultSupportPercent || 0;
  const grams = density ? volumeCM3 * density : null;
  const supportGrams = grams != null ? volumeCM3 * (pct / 100) * sDensity : null;
  const reasons = [];
  const open = [...vols.values()].filter(v => !v.watertight).length; if (open) reasons.push(`notWatertight:${open}`);
  if (pairs.length) reasons.push(`overlap:${pairs.length}`);
  if (!price) reasons.push('noPrice');
  const materialCost = grams != null && price ? grams * price : null;
  const supportCost = supportGrams != null && sPrice ? supportGrams * sPrice : null;
  return { volumeCM3, grams, materialCost, supportGrams, supportCost, total: materialCost != null && supportCost != null ? materialCost + supportCost : null, currency: s.currency || 'USD', approximate: reasons.length > 0, overlaps: pairs.length, reasons };
}
```
(`_toWorld` = `Vector3.TransformCoordinates` per vertex or identity when no matrix; `_hasOpenResult` reads `state.scene.validation[partId].results` for `holes`/`nonManifold`. Reasons are codes; the panel maps them to i18n.)

- [ ] **Step 4: Panel** — render block; on any input, `setState(s => ({ ...s, cost: { ...s.cost, [field]: value } }), SILENT)` + `SettingsStore.save()`, then re-render the result line synchronously (`quote` is O(triangles), fine for the 300k budget; above it show "—" and reason `tooBig`).
- [ ] **Step 5: Run** print-cost, settings-store, hygiene, `npm test`, lint, i18n; `npm run test:browser` (add assert `#pp-cost-total` renders a number for the smoke's textured quad — a plane has volume 0, so assert the block exists and reads `0.00 cm³`).
- [ ] **Step 6: Commit** — `"feat: print cost quote (volume × density × price, support premium, overlap flag) on the Export tab"`.

---

### Task 7: Polygon budget in the HUD

**Files:**
- Modify: `src/core/storage/capabilities.js` (add `caps.triangleBudget`: web `1_500_000`, desktop `6_000_000` — same tiering as `DEFAULT_BOOLEAN_TRIANGLE_CAP` / the 100k auto-validate skip), `src/ui/MeshStats.js` (status-bar centre shows `tris 342k / 1.5M`, class `hud-warn` at ≥ 70 %, `hud-danger` at ≥ 90 %, tooltip `t('hud.triangleBudget')`), `src/styles/components/*.css` (two colour classes using existing tokens), locales `hud.triangleBudget` ("Scene triangles vs. the safe budget for this build — above it imports slow down and the tab may crash")
- Modify: `src/core/assets/AssetImport.js` — before `container.addAllToScene()`, if scene triangles + incoming > budget → `Toast.show(t('toast.triangleBudget', {…}), 'warning')` (import still proceeds; the user was told).
- Test: `tests/capabilities.test.mjs` (budget present per runtime), `tests/hygiene.test.mjs` (budget > repair cap > boolean cap ordering holds), browser smoke asserts the HUD text matches `/tris \d/`.

- [ ] Steps: failing tests → run → implement → run (`npm test`, lint, i18n, `test:browser`) → commit `"feat: HUD triangle budget with warn/danger thresholds"`.

---

### Task 8: Docs, Blueprint, live verification

**Files:**
- Modify: `Blueprint.md` — new section "Watertight repair + cost quote" (engine, licences, entry points, gate states green/amber/red, strict setting, cost formula, overlap policy, budget); update the Export Gate section (three-way modal); file layout rows for `repair/MeshRepair.js`, `print/PrintCost.js`, `public/vendor/*`.
- Modify: `docs/reviews/2026-09-17-cia-import-export.md` — close "validator never blocks" and "no hole filling" notes.
- Modify: `README.md` — one line: repair engine + cost quote, licences.

- [ ] **Step 1:** `npm run build && npm run test:browser && npm run test:export && npm run test:electron` — all PASS; Electron run proves the local Manifold + MeshFix paths load from `file://` (if `BASE_URL` breaks under `file://`, switch both loaders to `new URL('../../public/vendor/...', import.meta.url)`-style relative resolution and re-run).
- [ ] **Step 2:** Live probe (headless Chrome, reuse the pattern in `tests/browser-export-smoke.mjs`): import an open tetra GLB (three faces), click Repair via `MeshValidator.repairObject`, export 3MF, read with trimesh: `watertight True`, volume `+1000`. Record the numbers in the Blueprint section.
- [ ] **Step 3:** Commit `"docs: watertight repair + cost quote contract"`.

---

## Self-review

- Spec coverage: import badge + button (T3), anytime button (T3), export must-detect-must-prompt (T4), green/amber/red + strict (T4), auto on import opt-in (T5), reuse not reinvent (T1, MIT engine), cost = volume × density × price + support % (T6), dirty meshes → repair then approximate flag (T2/T6), overlap = flag only, no Boolean (T6), quick panel inputs with instant result (T6), polygon budget HUD (T7), offline Manifold (T1).
- Placeholders: none; every step has code or an exact command. Task 6 step 3 leaves two helpers (`_toWorld`, `_hasOpenResult`) described in one line each with their exact inputs.
- Names: `repairMesh` / `diagnoseMesh` / `repairObject` / `unitVolumesMM3` / `overlappingPairs` / `quote` / `REPAIR_TRIANGLE_CAP` / `print.strictExport` / `print.repairOnImport` / `cost` section — used consistently across tasks.
- Open risk (say it, do not hide it): MeshFixLib's UV loss on repaired textured parts is mitigated by nearest-vertex re-attachment, not exact. Textured Mimaki parts should be repaired on the export clone only (Task 4 default) unless the user clicks Auto-Fix on purpose.
