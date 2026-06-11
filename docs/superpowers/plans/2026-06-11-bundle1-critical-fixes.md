# Bundle 1: Critical Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the four surgical critical/high findings from `docs/reviews/2026-06-11-deep-review.md` — C4 (validator meshId key), C3 (Delete→Undo disposed pivot), H5 (SmartReplace parent capture), C1 (texture readback for export) — and verify texture export in live Chrome.

**Architecture:** Three are one-to-five-line ordering/key fixes with headless regression tests. C1 extracts one shared texture-readback utility (`src/core/assets/TextureReadback.js`) that correctly awaits Babylon's Promise-returning `readPixels()`, normalizes Float32/RGB buffers, and Y-flips — then both AssetLoader (thumbnails) and PrintManager (export PNGs) consume it. Live-Chrome verification closes the deferred Phase 6/7 milestone for textured export.

**Tech Stack:** Vanilla ES modules, Node built-in test harness (`npm test` runs `tests/*.test.mjs` via `node --import ./tests/register-hooks.mjs`), Babylon stub in `tests/env.mjs`, Vite dev server for live verify.

**Conventions that matter here:**
- Test files are self-running scripts: they `installEnv()` BEFORE importing any `src/core/*`, use `node:assert/strict`, hand-rolled `test(name, fn)` accumulator, `process.exit(failed ? 1 : 0)`. Copy the shape of `tests/validator-group.test.mjs`.
- Monkey-patching exported manager objects (`AssetLoader.getBabylonMesh = ...`) is the established test seam.
- Run a single test file: `node --import ./tests/register-hooks.mjs tests/<file>.test.mjs`
- Run everything: `npm test`

---

### Task 1: C4 — MeshValidator looks up SceneObject by mesh name instead of meshId

**Files:**
- Modify: `src/core/MeshValidator.js:243`
- Modify: `tests/validator-group.test.mjs` (buildHalfMesh + new regression test)

- [ ] **Step 1: Write the failing regression test**

In `tests/validator-group.test.mjs`, first add `metadata` to the mesh factory. In `buildHalfMesh(name, tris)` the returned object currently starts with `name,` — change the factory signature and returned object to:

```js
function buildHalfMesh(name, tris, meshId = name) {
  // ... positions/indices building unchanged ...
  return {
    name,
    metadata: { meshId },
    getVerticesData: () => new Float32Array(positions),
    // ... rest unchanged ...
```

Then add this test before the `console.log` footer:

```js
await test('validateMesh routes by metadata.meshId, not Babylon mesh name', async () => {
  // Real imports produce mesh.name like "Cube__part0" while the SceneObject
  // key is the minted meshId — they NEVER match. Regression for review C4.
  const lo = buildHalfMesh('Cube__part0', LO_TRIS, 'mesh_aaa_1');
  const hi = buildHalfMesh('Cube__part1', HI_TRIS, 'mesh_aaa_2');
  seedState([
    { id: 'mesh_aaa_1', sourceGroupId: 'grp_meta', mesh: lo },
    { id: 'mesh_aaa_2', sourceGroupId: 'grp_meta', mesh: hi },
  ]);
  const results = await MeshValidator.validateMesh(lo);
  assert.equal(nm(results), undefined,
    `divergent-name sibling must still route through the group union, got ${JSON.stringify(results)}`);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import ./tests/register-hooks.mjs tests/validator-group.test.mjs`
Expected: new test FAILS (per-mesh path flags the open shell as nonManifold); all prior tests still pass (name==id there).

- [ ] **Step 3: Fix the lookup**

In `src/core/MeshValidator.js` `validateMesh()`, replace:

```js
const sceneObj = getState().scene.objects?.[mesh.name];
```

with:

```js
// SceneObjects are keyed by minted meshId (stamped on mesh.metadata at
// registration) — Babylon mesh.name is unrelated and collides across imports.
const sceneObj = getState().scene.objects?.[mesh.metadata?.meshId];
```

No name fallback — a fallback would silently resurrect the bug for renamed meshes.

- [ ] **Step 4: Run the file, then the whole suite**

Run: `node --import ./tests/register-hooks.mjs tests/validator-group.test.mjs` → all PASS.
Run: `npm test` → all files PASS (validator.test.mjs uses bare meshes without metadata — those take the per-mesh path by design and still pass).

- [ ] **Step 5: Commit**

```bash
git add src/core/MeshValidator.js tests/validator-group.test.mjs
git commit -m "fix(validator): key SceneObject lookup by metadata.meshId

mesh.name never matches the objects map key in the live app, so
group-aware union validation silently never ran outside tests."
```

---

### Task 2: C3 — DeleteCommand undo re-parents to the disposed selection pivot

**Files:**
- Modify: `src/core/HistoryManager.js` (DeleteCommand)
- Create: `tests/history-pivot.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `tests/history-pivot.test.mjs`:

```js
// Regression tests for review C3 + H5: commands constructed while the gizmo
// selection-pivot is attached must restore CANONICAL parents on undo, never
// the temporary (disposed) pivot node.
//   node --import ./tests/register-hooks.mjs tests/history-pivot.test.mjs

import assert from 'node:assert/strict';
import { installEnv } from './env.mjs';

installEnv();
const { DeleteCommand, SmartReplaceCommand } = await import('../src/core/HistoryManager.js');
const { AssetLoader }  = await import('../src/core/AssetLoader.js');
const { SceneManager } = await import('../src/core/SceneManager.js');
const { Selection }    = await import('../src/core/Selection.js');
const { setState, getState } = await import('../src/core/StateManager.js');

// ── Fakes ────────────────────────────────────────────────────────────────
function fakeVec(x = 0, y = 0, z = 0) {
  return { x, y, z,
    set(a, b, c) { this.x = a; this.y = b; this.z = c; return this; },
    clone() { return fakeVec(this.x, this.y, this.z); },
  };
}
function fakeMesh(meshId, name, parent = null) {
  return {
    name,
    metadata: { meshId },
    parent,
    enabled: true,
    position: fakeVec(),
    scaling: fakeVec(1, 1, 1),
    rotationQuaternion: { x: 0, y: 0, z: 0, w: 1 },
    absoluteScaling: fakeVec(1, 1, 1),
    absoluteRotationQuaternion: { x: 0, y: 0, z: 0, w: 1 },
    setParent(p) { this.parent = p; },
    setEnabled(v) { this.enabled = v; },
    computeWorldMatrix() {},
    getAbsolutePosition() { return this.position.clone(); },
    clone(cloneName) { const c = fakeMesh(null, cloneName, this.parent); return c; },
  };
}

const meshes = new Map();
AssetLoader.getBabylonMesh = (id) => meshes.get(id) ?? null;

// The pivot lifecycle stub: while "attached", meshes are parented to
// pivotNode. Detaching ([] selection) restores canonical parents and
// disposes the pivot — exactly what SceneManager._detachPivot does.
let pivotNode = null;
let canonicalParents = new Map();   // mesh → canonical parent
SceneManager.attachToSelection = (list) => {
  if (!list || !list.length) {
    if (pivotNode) {
      for (const [m, p] of canonicalParents) m.parent = p;
      pivotNode.disposed = true;
      pivotNode = null;
      canonicalParents = new Map();
    }
  }
};
SceneManager.setActive = () => {};
SceneManager.setSelected = () => {};
Selection.refresh = () => {};
Selection.clear = () => {};
Selection.set = () => {};

function attachPivot(list) {
  pivotNode = { name: 'selectionPivot', disposed: false };
  for (const m of list) { canonicalParents.set(m, m.parent); m.parent = pivotNode; }
  return pivotNode;
}

function seedObjects(objs) {
  meshes.clear();
  for (const o of objs) if (o.mesh) meshes.set(o.id, o.mesh);
  setState(s => ({
    ...s,
    scene: {
      ...s.scene,
      objects: Object.fromEntries(objs.map(o => [o.id, {
        id: o.id, name: o.id, assetId: 'a1', parentId: null, shaderId: null,
        visible: true, locked: false, isGhost: false, isPrintPart: true,
        collectionId: null, sourceGroupId: null,
      }])),
    },
  }), { silent: true });
}

let passed = 0, failed = 0;
const out = [];
async function test(name, fn) {
  try { await fn(); out.push(`PASS  ${name}`); passed++; }
  catch (e) { out.push(`FAIL  ${name}\n      ${e.stack || e.message}`); failed++; }
}

await test('Delete → Undo restores canonical parent, not the disposed pivot', async () => {
  const groupNode = { name: 'GroupA' };
  const m = fakeMesh('m1', 'PartA', groupNode);
  seedObjects([{ id: 'm1', mesh: m }]);
  const pivot = attachPivot([m]);          // selection active → mesh under pivot

  const cmd = new DeleteCommand(['m1']);   // constructed WHILE pivot attached
  cmd.execute();
  assert.equal(m.enabled, false, 'execute soft-disables the mesh');

  cmd.undo();
  assert.equal(m.enabled, true, 'undo re-enables the mesh');
  assert.notEqual(m.parent, pivot, 'undo must NOT re-parent to the disposed pivot');
  assert.equal(m.parent, groupNode, 'undo restores the canonical parent');
  assert.ok(getState().scene.objects.m1, 'undo restores the state entry');
});

await test('SmartReplace → Undo restores the target\'s canonical parent', async () => {
  const groupNode = { name: 'GroupB' };
  const active = fakeMesh('act', 'ActivePart', null);
  const target = fakeMesh('tgt', 'TargetPart', groupNode);
  seedObjects([{ id: 'act', mesh: active }, { id: 'tgt', mesh: target }]);

  // cloneMeshAsNewObject seam: mint a fake clone + state entry like the real one.
  let cloneCount = 0;
  AssetLoader.cloneMeshAsNewObject = (sourceId) => {
    const newId = `clone_${++cloneCount}`;
    const c = fakeMesh(newId, `${sourceId}.dup`, null);
    meshes.set(newId, c);
    setState(s => ({
      ...s,
      scene: { ...s.scene, objects: { ...s.scene.objects, [newId]: {
        ...s.scene.objects[sourceId], id: newId, name: `${sourceId}.dup`,
      } } },
    }), { silent: true });
    return newId;
  };
  AssetLoader.restoreCloneToScene = () => {};

  attachPivot([active, target]);           // both selected → both under pivot

  const cmd = new SmartReplaceCommand(['act', 'tgt'], 'act');
  cmd.execute();
  assert.equal(target.enabled, false, 'execute soft-disables the replaced target');

  cmd.undo();
  assert.equal(target.enabled, true, 'undo re-enables the original');
  assert.equal(target.parent, groupNode,
    `undo must restore the canonical parent, got ${target.parent?.name ?? target.parent}`);
});

console.log('\n' + out.join('\n'));
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
```

- [ ] **Step 2: Run test to verify both fail**

Run: `node --import ./tests/register-hooks.mjs tests/history-pivot.test.mjs`
Expected: test 1 FAILS (`m.parent` is the disposed pivot); test 2 FAILS (`target.parent` is null).

- [ ] **Step 3: Fix DeleteCommand**

In `src/core/HistoryManager.js`, `DeleteCommand`:

Constructor — drop the parent capture. Change the snapshot push to:

```js
this._snapshots.push({ id, obj: { ...obj }, mesh, prevParent: null });
```

`execute()` — capture the parent inside the detached-pivot block, before unparenting:

```js
  execute() {
    _withDetachedPivot(() => {
      for (const s of this._snapshots) {
        // Captured HERE (post-detach) so it is the canonical parent — at
        // construction time the mesh may sit under the temporary selection
        // pivot, which is disposed during detach (review C3).
        s.prevParent = s.mesh.parent ?? null;
        s.mesh.setParent(null);
        s.mesh.setEnabled(false);
        // ... rest unchanged
```

(Redo is safe: undo restores `prevParent`, so re-executing re-captures the same value.)

- [ ] **Step 4: Run test — first test passes, second still fails**

Run: `node --import ./tests/register-hooks.mjs tests/history-pivot.test.mjs`
Expected: 1 PASS, 1 FAIL.

- [ ] **Step 5: Commit**

```bash
git add src/core/HistoryManager.js tests/history-pivot.test.mjs
git commit -m "fix(history): capture Delete prevParent after pivot detach

Constructor-time capture saw the temporary selectionPivot, which is
disposed during execute; undo re-parented meshes to a dead node."
```

---

### Task 3: H5 — SmartReplaceCommand captures oldParent after setParent(null)

**Files:**
- Modify: `src/core/HistoryManager.js` (SmartReplaceCommand.execute)
- Test: `tests/history-pivot.test.mjs` (already written in Task 2)

- [ ] **Step 1: Fix the capture order**

In `SmartReplaceCommand.execute()` (first-run branch), the current sequence is:

```js
        oldMesh.setParent(null);
        oldMesh.setEnabled(false);
        const oldParent = oldMesh.parent ?? null;
```

Replace with:

```js
        const oldParent = oldMesh.parent ?? null;   // BEFORE unparenting (review H5)
        oldMesh.setParent(null);
        oldMesh.setEnabled(false);
```

- [ ] **Step 2: Run test to verify both pass**

Run: `node --import ./tests/register-hooks.mjs tests/history-pivot.test.mjs`
Expected: 2 passed, 0 failed.

- [ ] **Step 3: Run the whole suite**

Run: `npm test`
Expected: all PASS.

- [ ] **Step 4: Commit**

```bash
git add src/core/HistoryManager.js
git commit -m "fix(history): capture SmartReplace oldParent before unparenting

parent was read after setParent(null), so undo always dropped the
target's group membership."
```

---

### Task 4: C1 — shared texture readback (Promise readPixels, float/RGB, Y-flip)

**Files:**
- Create: `src/core/assets/TextureReadback.js`
- Create: `tests/texture-readback.test.mjs`
- Modify: `src/core/PrintManager.js` (`_textureToBlob`)
- Modify: `src/core/AssetLoader.js` (`_readTextureToDataUrl`)
- Modify: `Blueprint.md` §0.3 file layout (one line)

- [ ] **Step 1: Write the failing unit test**

Create `tests/texture-readback.test.mjs`:

```js
// Unit tests for the shared texture readback normalizer (review C1).
//   node --import ./tests/register-hooks.mjs tests/texture-readback.test.mjs

import assert from 'node:assert/strict';
import { installEnv } from './env.mjs';

installEnv();
const { readTextureRGBA, flipRGBAVertically } =
  await import('../src/core/assets/TextureReadback.js');

function fakeTexture(pixels, w, h, { promised = false } = {}) {
  return {
    name: 't',
    getSize: () => ({ width: w, height: h }),
    readPixels: () => (promised ? Promise.resolve(pixels) : pixels),
  };
}

let passed = 0, failed = 0;
const out = [];
async function test(name, fn) {
  try { await fn(); out.push(`PASS  ${name}`); passed++; }
  catch (e) { out.push(`FAIL  ${name}\n      ${e.stack || e.message}`); failed++; }
}

await test('sync Uint8 RGBA passes through', async () => {
  const px = new Uint8Array([1, 2, 3, 4]);
  const r = await readTextureRGBA(fakeTexture(px, 1, 1));
  assert.deepEqual([...r.rgba], [1, 2, 3, 4]);
  assert.equal(r.width, 1); assert.equal(r.height, 1);
});

await test('PROMISE-returning readPixels is awaited (modern Babylon)', async () => {
  const px = new Uint8Array([9, 8, 7, 255]);
  const r = await readTextureRGBA(fakeTexture(px, 1, 1, { promised: true }));
  assert.ok(r, 'must not treat the Promise as a pixel buffer');
  assert.deepEqual([...r.rgba], [9, 8, 7, 255]);
});

await test('RGB stride expands to RGBA with opaque alpha', async () => {
  const px = new Uint8Array([10, 20, 30]);
  const r = await readTextureRGBA(fakeTexture(px, 1, 1));
  assert.deepEqual([...r.rgba], [10, 20, 30, 255]);
});

await test('Float32 RGBA converts to clamped bytes', async () => {
  const px = new Float32Array([0, 0.5, 1, 2]);     // 2 → clamps to 255
  const r = await readTextureRGBA(fakeTexture(px, 1, 1, { promised: true }));
  assert.deepEqual([...r.rgba], [0, 128, 255, 255]);
});

await test('null on missing size or pixels', async () => {
  assert.equal(await readTextureRGBA({ getSize: () => null, readPixels: () => null }), null);
  assert.equal(await readTextureRGBA(fakeTexture(null, 2, 2)), null);
});

await test('flipRGBAVertically swaps rows in place', async () => {
  // 1×2 image: top px (1,1,1,1), bottom px (2,2,2,2).
  const buf = new Uint8ClampedArray([1, 1, 1, 1, 2, 2, 2, 2]);
  flipRGBAVertically(buf, 1, 2);
  assert.deepEqual([...buf], [2, 2, 2, 2, 1, 1, 1, 1]);
});

console.log('\n' + out.join('\n'));
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import ./tests/register-hooks.mjs tests/texture-readback.test.mjs`
Expected: FAIL — `Cannot find module '../src/core/assets/TextureReadback.js'`.

- [ ] **Step 3: Implement the module**

Create `src/core/assets/TextureReadback.js`:

```js
// Shared GPU-texture readback (review C1). The ONLY correct way to get pixel
// bytes out of a Babylon texture in this codebase — modern Babylon's
// readPixels() returns a Promise, GL rows come back bottom-up, and PBR
// textures may read back as Float32 or RGB-stride buffers. AssetLoader
// thumbnails and PrintManager texture export both route through here so the
// handling can't drift apart again.

/**
 * Read a texture into a normalized RGBA byte buffer.
 * Awaits Promise-returning readPixels, converts Float32 → Uint8, expands
 * RGB stride → RGBA. Rows are in GL order (bottom-up) — callers that need
 * image order apply {@link flipRGBAVertically}.
 * @returns {Promise<{rgba: Uint8ClampedArray, width: number, height: number}|null>}
 */
export async function readTextureRGBA(texture) {
  const size = texture?.getSize?.();
  const w = size?.width | 0;
  const h = size?.height | 0;
  if (!w || !h) return null;

  let pixels = texture.readPixels?.();
  if (pixels && typeof pixels.then === 'function') pixels = await pixels;
  if (!pixels) return null;

  let rgba;
  if (pixels instanceof Uint8Array || pixels instanceof Uint8ClampedArray) {
    const u8 = pixels instanceof Uint8ClampedArray
      ? pixels
      : new Uint8ClampedArray(pixels.buffer, pixels.byteOffset, pixels.byteLength);
    if (u8.length === w * h * 4) {
      rgba = u8;
    } else if (u8.length === w * h * 3) {
      rgba = new Uint8ClampedArray(w * h * 4);
      for (let i = 0, j = 0; i < u8.length; i += 3, j += 4) {
        rgba[j] = u8[i]; rgba[j + 1] = u8[i + 1]; rgba[j + 2] = u8[i + 2]; rgba[j + 3] = 255;
      }
    } else {
      return null;
    }
  } else if (pixels instanceof Float32Array) {
    const stride = pixels.length === w * h * 4 ? 4 : pixels.length === w * h * 3 ? 3 : 0;
    if (!stride) return null;
    rgba = new Uint8ClampedArray(w * h * 4);
    for (let i = 0, j = 0; i < pixels.length; i += stride, j += 4) {
      rgba[j]     = Math.round(Math.max(0, Math.min(1, pixels[i]))     * 255);
      rgba[j + 1] = Math.round(Math.max(0, Math.min(1, pixels[i + 1])) * 255);
      rgba[j + 2] = Math.round(Math.max(0, Math.min(1, pixels[i + 2])) * 255);
      rgba[j + 3] = stride === 4 ? Math.round(Math.max(0, Math.min(1, pixels[i + 3])) * 255) : 255;
    }
  } else {
    return null;
  }
  return { rgba, width: w, height: h };
}

/** Swap pixel rows in place — GL bottom-up → image top-down. Pure. */
export function flipRGBAVertically(rgba, width, height) {
  const rowBytes = width * 4;
  const tmp = new Uint8ClampedArray(rowBytes);
  for (let top = 0, bot = height - 1; top < bot; top++, bot--) {
    const a = top * rowBytes, b = bot * rowBytes;
    tmp.set(rgba.subarray(a, a + rowBytes));
    rgba.copyWithin(a, b, b + rowBytes);
    rgba.set(tmp, b);
  }
  return rgba;
}

// Textures upload with invertY=false (glTF convention), so readback rows are
// GL bottom-up; flipping restores source-image orientation. Verified live for
// thumbnails; the export live-verify step (Bundle 1 Task 6) confirms the same
// flag holds for slicer-side UV orientation. ONE switch — flip here, nowhere else.
export const EXPORT_FLIP_Y = true;

/**
 * Encode a texture as a PNG Blob at native size (export path).
 * @returns {Promise<Blob|null>}
 */
export async function textureToPngBlob(texture, { flipY = EXPORT_FLIP_Y } = {}) {
  const r = await readTextureRGBA(texture);
  if (!r) return null;
  if (flipY) flipRGBAVertically(r.rgba, r.width, r.height);
  const canvas = document.createElement('canvas');
  canvas.width = r.width;
  canvas.height = r.height;
  const ctx = canvas.getContext('2d');
  ctx.putImageData(new ImageData(r.rgba, r.width, r.height), 0, 0);
  return new Promise((resolve, reject) => {
    canvas.toBlob(b => (b ? resolve(b) : reject(new Error('toBlob produced no blob'))), 'image/png');
  });
}

/**
 * Encode a texture as a square data-URL thumbnail (asset panel path).
 * @returns {Promise<string|null>}
 */
export async function textureToDataUrl(texture, targetSize) {
  const r = await readTextureRGBA(texture);
  if (!r) return null;
  flipRGBAVertically(r.rgba, r.width, r.height);
  const source = document.createElement('canvas');
  source.width = r.width;
  source.height = r.height;
  source.getContext('2d').putImageData(new ImageData(r.rgba, r.width, r.height), 0, 0);
  const thumb = document.createElement('canvas');
  thumb.width = targetSize;
  thumb.height = targetSize;
  thumb.getContext('2d').drawImage(source, 0, 0, targetSize, targetSize);
  return thumb.toDataURL('image/png');
}
```

- [ ] **Step 4: Run unit test to verify it passes**

Run: `node --import ./tests/register-hooks.mjs tests/texture-readback.test.mjs`
Expected: 6 passed, 0 failed.

- [ ] **Step 5: Rewire PrintManager**

In `src/core/PrintManager.js`:

Add import (with the other `./print/` imports near the top):

```js
import { textureToPngBlob } from './assets/TextureReadback.js';
```

(Path note: PrintManager sits in `src/core/`, so the specifier is `./assets/TextureReadback.js`.)

Replace the entire `_textureToBlob` function (the `async function _textureToBlob(texture) { ... }` block with the canvas/readPixels body) with:

```js
/** Convert a Babylon texture to a PNG blob via the shared readback seam. */
async function _textureToBlob(texture) {
  const blob = await textureToPngBlob(texture);
  if (!blob) throw new Error(`Texture readback failed for ${texture?.name ?? 'texture'}`);
  return blob;
}
```

- [ ] **Step 6: Rewire AssetLoader**

In `src/core/AssetLoader.js`:

Add to the existing `./assets/AssetTypes.js` import block region:

```js
import { textureToDataUrl } from './assets/TextureReadback.js';
```

In `_generateImportedTextureThumbnail`, replace the line

```js
    const dataUrl = await _readTextureToDataUrl(texture, TEX_THUMB_SIZE);
```

with

```js
    const dataUrl = await textureToDataUrl(texture, TEX_THUMB_SIZE);
```

Delete the now-unused `_readTextureToDataUrl` function entirely (the ~58-line block from its JSDoc through its closing brace). Keep `_awaitTextureReady` (still used).

- [ ] **Step 7: Run the whole suite**

Run: `npm test`
Expected: all PASS. (Export tests use textureless stub materials, so `_textureToBlob` isn't on their hot path; this step catches import-graph breakage.)

- [ ] **Step 8: Update Blueprint file layout**

In `Blueprint.md` §0.3, under `    assets/`, after the `AssetTypes.js` line, add:

```
      TextureReadback.js   ← shared GPU readback: Promise readPixels, float/RGB, Y-flip
```

- [ ] **Step 9: Commit**

```bash
git add src/core/assets/TextureReadback.js tests/texture-readback.test.mjs src/core/PrintManager.js src/core/AssetLoader.js Blueprint.md
git commit -m "fix(export): await readPixels via shared texture readback

PrintManager._textureToBlob called readPixels() synchronously; modern
Babylon returns a Promise, so imageData.data.set(promise) wrote nothing
and Mimaki texture exports shipped blank PNGs. The headless Babylon shim
returns sync arrays, which is why 78 green tests never caught it. One
shared readback module now handles await/float/RGB/Y-flip for both
thumbnails and export."
```

---

### Task 5: Full regression sweep

**Files:** none (verification)

- [ ] **Step 1: Run the complete suite**

Run: `npm test`
Expected: all test files PASS, 0 failed.

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: clean (no TS mirrors touched; this guards the allowJs import graph).

---

### Task 6: Live Chrome verification (deferred Phase 6/7 milestone)

**Files:** none (manual verification, evidence required before claiming done)

- [ ] **Step 1: Boot the app**

Run: `npm run dev` (background), open `http://localhost:5173` in Chrome.
Expected: viewport renders, no console errors at boot.

- [ ] **Step 2: Import a textured model**

Drag any textured `.glb` onto the viewport. Expected: model renders WITH texture; asset panel shows a non-blank texture thumbnail (exercises the new readback in the thumbnail path — upright orientation confirms the Y-flip).

- [ ] **Step 3: Export Mimaki textured 3MF**

Print panel → Bed tab → printer `Mimaki 3DUJ-553`; Export tab → "Export 3MF (color)". Save the file.

- [ ] **Step 4: Inspect the package**

Rename `.3mf` → `.zip`, extract, open `3D/Textures/*.png` in an image viewer.
Expected: the actual texture image — not transparent/black, not vertically mirrored. `3D/3dmodel.model` contains `<m:texture2d>` + `<m:texture2dgroup>` blocks.

- [ ] **Step 5: Slicer round-trip (best available)**

Re-import the exported `.3mf` back into MIXOMESH (drag onto viewport): texture must reappear with correct orientation. If a Mimaki/3MF-capable slicer is installed, open the file there too and confirm texture placement.

- [ ] **Step 6: Record the result**

Append a `## Live verification — 2026-06-11` section to `docs/reviews/2026-06-11-deep-review.md` noting pass/fail per step. If orientation is wrong in step 4/5, flip `EXPORT_FLIP_Y` in `src/core/assets/TextureReadback.js` — that constant is the single switch — and re-run steps 3–5.

- [ ] **Step 7: Commit verification note**

```bash
git add docs/reviews/2026-06-11-deep-review.md
git commit -m "docs(review): record bundle-1 live Chrome verification"
```

---

## Self-review notes

- Spec coverage: C1 (Task 4+6), C3 (Task 2), C4 (Task 1), H5 (Tasks 2–3). Bundle 1 complete; C2/H6–H9 and M/L items are Bundles 2–4 (separate plans, written after this bundle lands).
- Existing `validator-group` tests survive Task 1 because `buildHalfMesh` gains `metadata.meshId` defaulting to `name`.
- Task 2's pivot stub mirrors `SceneManager._detachPivot` semantics (restore canonical parents, dispose pivot) without needing a Babylon scene.
- `env.mjs` needs no changes: canvas stub already supports `createImageData`/`putImageData`/`toBlob`; `ImageData` is not constructed in any headless-tested path (unit tests stop at `readTextureRGBA`/`flipRGBAVertically`).
