// Headless persistence tests. Run:
//   node --import ./tests/register-hooks.mjs --test tests/persistence.test.mjs
//
// Drives the REAL PersistenceManager internal helpers (exported as __test)
// with the in-memory idb stub (via the resolve hook) and Node-native
// crypto/Blob/atob/btoa. These guard the Phase-6 milestone invariants that a
// human can't eyeball reliably:
//   • embedded mesh bytes survive a base64 round-trip EXACTLY (incl. the
//     0x8000 chunk boundary in _b64FromBuf and full 0..255 byte range)
//   • _resolveAssetBlob honours the locked priority order:
//       live exact path  >  (content-hash scan retired: load never scans)
//       >  embedded static copy  >  null (ghost)
//   • sha256 / ext / arrToMap / migrate behave as the load path assumes
// The live Babylon scene round-trip stays a human Chrome check (STEP 1).

import assert from 'node:assert/strict';
import { installEnv } from './env.mjs';
import { putFileHandle as seedHandle, __reset as resetIdb } from './idb-stub.mjs';

installEnv();
console.error = () => {};

const { __test } = await import('../src/core/PersistenceManager.js');
const {
  _b64FromBuf, _bufFromB64, _sha256Hex, _extOf,
  _resolveAssetBlob, _scanDirForHash, _fileHandleAtPath,
  _arrToMap, _migrate,
} = __test;
const { encodeBase64Async } = await import('../src/core/Base64Worker.js');
const { normalizeLoadedMixoProvenance } = (await import('../src/core/persist/ProjectLoader.js')).__test;
const { serialiseMixoProvenance, serialiseMixoRefinement, serialisePrintRefinement } = (await import('../src/core/persist/ProjectSerializer.js')).__test;
const { normalizeLoadedMixoRefinement, normalizeLoadedPrintRefinement } = (await import('../src/core/persist/ProjectLoader.js')).__test;

// ── Fake File System Access handles ──────────────────────

function u8(bytes) { return bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes); }

function fakeFile(bytes) {
  const b = u8(bytes);
  return { __u8: b, async arrayBuffer() { return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); } };
}
function fileHandle(name, bytes) {
  return { kind: 'file', name, async getFile() { return fakeFile(bytes); } };
}
/** tree = { files?: Map<name,bytes>, dirs?: Map<name,dirHandle> } */
function dirHandle(tree, { granted = true } = {}) {
  const files = tree.files ?? new Map();
  const dirs  = tree.dirs  ?? new Map();
  return {
    kind: 'directory',
    async requestPermission() { return granted ? 'granted' : 'denied'; },
    async getDirectoryHandle(n) {
      if (!dirs.has(n)) throw new Error(`no dir ${n}`);
      return dirs.get(n);
    },
    async getFileHandle(n) {
      if (!files.has(n)) throw new Error(`no file ${n}`);
      return fileHandle(n, files.get(n));
    },
    async *entries() {
      for (const [n, b] of files) yield [n, fileHandle(n, b)];
      for (const [n, d] of dirs)  yield [n, d];
    },
  };
}

async function bytesOf(blob) {
  return new Uint8Array(await blob.arrayBuffer());
}
function eqBytes(a, b, msg) {
  assert.deepEqual([...a], [...b], msg);
}

// ── Runner (mirrors export/validator harness) ────────────

let passed = 0, failed = 0;
const out = [];
async function test(name, fn) {
  resetIdb();
  try { await fn(); out.push(`PASS  ${name}`); passed++; }
  catch (err) { out.push(`FAIL  ${name}\n      ${err.stack || err.message}`); failed++; }
}

// ── base64 byte fidelity ─────────────────────────────────

await test('base64: empty buffer round-trips', () => {
  eqBytes(_bufFromB64(_b64FromBuf(new Uint8Array(0).buffer)), []);
});

await test('base64: full 0..255 byte range survives exactly', () => {
  const src = Uint8Array.from({ length: 256 }, (_, i) => i);
  eqBytes(_bufFromB64(_b64FromBuf(src.buffer)), src);
});

await test('base64: > 0x8000 crosses the String.fromCharCode chunk boundary intact', () => {
  // 100,003 bytes — spans ~3 chunks; deterministic pseudo-random pattern.
  const n = 100003;
  const src = new Uint8Array(n);
  for (let i = 0; i < n; i++) src[i] = (i * 31 + 7) & 0xff;
  const round = _bufFromB64(_b64FromBuf(src.buffer));
  assert.equal(round.length, n);
  eqBytes(round, src, 'byte mismatch across chunk boundary');
});

await test('base64: output is STANDARD base64 (matches a canonical reference, not just self-consistent)', () => {
  // Round-trip alone can't catch an encoder that's self-consistent but emits
  // non-standard base64 (e.g. wrong chunk alignment, swapped alphabet). Pin
  // _b64FromBuf against Node's canonical Buffer base64 across byte patterns
  // that exercise the 3-byte base64 grouping + padding (len % 3 ∈ {0,1,2}) and
  // the 0x8000 String.fromCharCode chunking. This is also the byte-identical
  // guard the deferred #3 worker-offload refactor must keep green.
  const cases = [
    Uint8Array.from({ length: 256 }, (_, i) => i),                 // full byte range
    Uint8Array.from({ length: 255 }, (_, i) => (i * 7) & 0xff),    // len % 3 == 0
    Uint8Array.from({ length: 256 }, (_, i) => (i * 7) & 0xff),    // len % 3 == 1
    Uint8Array.from({ length: 257 }, (_, i) => (i * 7) & 0xff),    // len % 3 == 2
    Uint8Array.from({ length: 0x8001 }, (_, i) => (i * 31 + 7) & 0xff), // crosses chunk
  ];
  for (const src of cases) {
    const got = _b64FromBuf(src.buffer);
    const ref = Buffer.from(src).toString('base64');
    assert.equal(got, ref, `non-standard base64 for length ${src.length}`);
  }
});

await test('base64: encodeBase64Async (save-path worker offload) is byte-identical to the sync codec', async () => {
  // Headless has no Worker, so this exercises the sync FALLBACK — the same
  // shared codec — which must equal `_b64FromBuf` exactly. The real worker path
  // is covered end-to-end by the browser smoke's _buildDocument round-trips.
  for (const len of [0, 1, 2, 3, 255, 256, 257, 0x8001]) {
    const src = Uint8Array.from({ length: len }, (_, i) => (i * 31 + 7) & 0xff);
    const viaWorker = await encodeBase64Async(src.buffer);
    assert.equal(viaWorker, _b64FromBuf(src.buffer), `worker/sync mismatch at length ${len}`);
    // And it survives the decode (no corruption introduced by the async path).
    eqBytes(_bufFromB64(viaWorker), src, `round-trip mismatch at length ${len}`);
  }
});

// ── sha256 / ext ─────────────────────────────────────────

await test('sha256: known vectors (empty, "abc")', async () => {
  assert.equal(await _sha256Hex(new Uint8Array(0)),
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(await _sha256Hex(new TextEncoder().encode('abc')),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

await test('_extOf: lowercased, dotless → empty', () => {
  assert.equal(_extOf('sub/Model.GLB'), '.glb');
  assert.equal(_extOf('archive.tar.gz'), '.gz');
  assert.equal(_extOf('noext'), '');
});

// ── _arrToMap / _migrate ─────────────────────────────────

await test('_arrToMap: keys by id, null-safe', () => {
  assert.deepEqual(_arrToMap([{ id: 'a', v: 1 }, { id: 'b', v: 2 }]),
    { a: { id: 'a', v: 1 }, b: { id: 'b', v: 2 } });
  assert.deepEqual(_arrToMap(undefined), {});
});

await test('_migrate: never mutates the caller doc; 3.1 gridSize ignored, not stripped', () => {
  const doc = { version: '3.1', scene: { gridSize: 250 }, foo: 1 };
  const snapshot = JSON.parse(JSON.stringify(doc));
  const m = _migrate(doc);
  assert.notEqual(m, doc, 'migrate returns a new top-level object');
  assert.deepEqual(doc, snapshot, 'caller doc untouched');
  assert.equal(m.version, '3.5');
  assert.deepEqual(m.scene, { gridSize: 250 });
});

// ── Schema 3.4 ladder (task 4.1) ─────────────────────────

function doc33() {
  return {
    version: '3.3',
    project: { name: 'P', id: 'pid-1', lastSavedAt: null },
    print: { exportTargets: [{ kind: 'ratio', value: 72 }], exportRatios: [72], referenceObjectId: null },
    assetLibrary: [
      { id: 'a_dir', name: 'hull', filename: 'hull.glb', extension: '.glb', kind: 'mesh',
        directoryHandleKey: 'dir_Parts_1700000000000', originalPath: 'sub/hull.glb', fileHandleKey: null, displayName: null },
      { id: 'a_fh', name: 'drop', filename: 'drop.glb', extension: '.glb', kind: 'mesh',
        directoryHandleKey: null, originalPath: null, fileHandleKey: 'fh_drop_1' },
      { id: 'a_loose', name: 'loose', filename: 'loose.stl', extension: '.stl', kind: 'mesh',
        directoryHandleKey: null, fileHandleKey: null, fileData: 'AAAA' },
      { id: 'a_part', name: 'part', filename: 'kit.glb', extension: '.glb', kind: 'mesh',
        displayName: 'kit / wheel' },
    ],
    sceneObjects: [{ id: 'o1', name: 'hull', assetId: 'a_dir', ratio: 72, logicalObjectId: null }],
  };
}

await test('_migrate: 3.3 → 3.4 derives source descriptor + displayName per asset', () => {
  const doc = doc33();
  const snapshot = JSON.parse(JSON.stringify(doc));
  const m = _migrate(doc);
  assert.equal(m.version, '3.5');
  const byId = Object.fromEntries(m.assetLibrary.map(a => [a.id, a]));
  assert.deepEqual(byId.a_dir.source, { kind: 'folder', refKey: 'dir_Parts_1700000000000', path: 'sub/hull.glb', label: 'Parts' });
  assert.deepEqual(byId.a_fh.source, { kind: 'file', refKey: 'fh_drop_1', path: 'drop.glb', label: 'drop.glb' });
  assert.equal(byId.a_loose.source, null, 'loose drop / embedded-only → null source');
  assert.equal(byId.a_loose.fileData, 'AAAA', 'embedded bytes carried by reference');
  assert.equal(byId.a_dir.displayName, 'hull.glb', 'null displayName falls back to the filename');
  assert.equal(byId.a_part.displayName, 'kit / wheel', 'an existing displayName is kept');
  // Legacy keys untouched (still the runtime resolver inputs for one minor).
  assert.equal(byId.a_dir.directoryHandleKey, 'dir_Parts_1700000000000');
  assert.equal(byId.a_dir.originalPath, 'sub/hull.glb');
  assert.deepEqual(doc, snapshot, 'caller doc untouched');
});

await test('_migrate: 3.4 doc passes through unchanged and the ladder is idempotent', () => {
  const m1 = _migrate(doc33());
  const m2 = _migrate(m1);
  assert.deepEqual(m2, m1, '3.4 → 3.4 round trip identical');
  const m3 = _migrate(JSON.parse(JSON.stringify(m1)));
  assert.deepEqual(m3, m1, 'JSON round trip of a migrated doc is stable');
});

await test('_migrate: legacy 3.1 / 3.2 still resolve (exportRatios, targetRatio, workingRatio, sourceGroupId)', () => {
  const m31 = _migrate({ version: '3.1', print: { exportRatios: [144, -1] } });
  assert.deepEqual(m31.print.exportTargets, [{ kind: 'ratio', value: 144 }], '1.17 exportRatios → exportTargets');
  assert.equal(m31.print.referenceObjectId, null, '1.15 referenceObjectId default');

  const m32 = _migrate({
    version: '3.2',
    print: { targetRatio: 35, workingRatio: 12 },
    sceneObjects: [
      { id: 'lead', assetId: 'a', sourceGroupId: 'sg' },
      { id: 'part', assetId: 'a', sourceGroupId: 'sg', isInternalPart: true, ratio: 24 },
    ],
  });
  assert.deepEqual(m32.print.exportTargets, [{ kind: 'ratio', value: 35 }], 'pre-redesign targetRatio');
  const [lead, part] = m32.sceneObjects;
  assert.equal(lead.ratio, 12, 'global workingRatio folded into objects without a ratio');
  assert.equal(part.ratio, 24, "an object's own ratio wins");
  assert.equal(lead.logicalObjectId, 'lead', '2.7 seed: lead links to itself');
  assert.equal(part.logicalObjectId, 'lead');
  assert.equal(lead.isInternalPart, false);
  assert.equal(part.isInternalPart, true);

  const mNoVersion = _migrate({ assetLibrary: [{ id: 'x', filename: 'x.obj' }] });
  assert.equal(mNoVersion.version, '3.5', 'pre-versioned save reads as 3.0 and migrates');
  assert.equal(mNoVersion.assetLibrary[0].source, null);
  assert.equal(mNoVersion.assetLibrary[0].displayName, 'x.obj');
});

await test('_migrate: 1.13 seeds ratioSource from the asset modelRatio; an explicit value is kept', () => {
  const m = _migrate({
    version: '3.3',
    assetLibrary: [
      { id: 'gltf', filename: 'tank.glb', modelRatio: 72 },
      { id: 'stl', filename: 'kit.stl', modelRatio: 1 },
      { id: 'obj', filename: 'old.obj' },
    ],
    sceneObjects: [
      { id: 'a', assetId: 'gltf', ratio: 72 },
      { id: 'b', assetId: 'stl', ratio: 1 },
      { id: 'c', assetId: 'obj' },
      { id: 'd', assetId: 'stl', ratio: 72, ratioSource: 'user' },
      { id: 'e', assetId: 'gone' },
    ],
  });
  const by = Object.fromEntries(m.sceneObjects.map(o => [o.id, o.ratioSource]));
  assert.deepEqual(by, { a: 'file', b: 'default', c: 'default', d: 'user', e: 'default' });
  assert.deepEqual(_migrate(m).sceneObjects.map(o => o.ratioSource), ['file', 'default', 'default', 'user', 'default'],
    'idempotent');
});

await test('ratioSourceOf / seedRatioSource: explicit wins, else derived from the asset', async () => {
  const { ratioSourceOf, seedRatioSource } = await import('../src/core/HistoryManager.js');
  assert.equal(seedRatioSource(72), 'file');
  assert.equal(seedRatioSource(1), 'default');
  assert.equal(seedRatioSource(undefined), 'default');
  assert.equal(ratioSourceOf({ ratioSource: 'user' }, { modelRatio: 72 }), 'user');
  assert.equal(ratioSourceOf({}, { modelRatio: 35 }), 'file');
  assert.equal(ratioSourceOf({ ratioSource: 'bogus' }, null), 'default');
});

await test('_migrate: newer minor (3.6) loads best-effort; unknown top-level keys preserved', async () => {
  const { preservedTopLevelKeys } = await import('../src/core/persist/ProjectValidator.js');
  const doc = { version: '3.6', futureThing: { a: 1 }, assetLibrary: [{ id: 'x', filename: 'x.glb' }], print: {} };
  const m = _migrate(doc);
  assert.equal(m.version, '3.6', 'a newer minor keeps its stamp');
  assert.deepEqual(m.futureThing, { a: 1 });
  assert.equal('source' in m.assetLibrary[0], false, 'no down-ladder steps run on a newer minor');
  assert.deepEqual(preservedTopLevelKeys(doc), { futureThing: { a: 1 } }, 'only unknown keys preserved');
  assert.deepEqual(preservedTopLevelKeys({ version: '3.5', junk: 1 }), {}, 'same minor: nothing preserved');
  assert.deepEqual(preservedTopLevelKeys({ version: '3.3', junk: 1 }), {}, 'older minor: legacy noise dropped');
});

await test('Mixo provenance survives the JSON persistence boundary only on the logical-object lead', () => {
  const persisted = JSON.parse(JSON.stringify({
    sceneObjects: [
      { id: 'lead', isInternalPart: false, mixoProvenance: serialiseMixoProvenance({ isInternalPart: false, mixoProvenance: {
        origin: 'mixo3d', markerVersion: 1, viewportSubdivLevel: 1, renderSubdivLevel: 2,
      } }) },
      { id: 'part', isInternalPart: true, mixoProvenance: serialiseMixoProvenance({ isInternalPart: true, mixoProvenance: {
        origin: 'mixo3d', markerVersion: 1, viewportSubdivLevel: 1, renderSubdivLevel: 2,
      } }) },
    ],
  }));
  assert.deepEqual(normalizeLoadedMixoProvenance(persisted.sceneObjects[0]), {
    origin: 'mixo3d', markerVersion: 1, viewportSubdivLevel: 1, renderSubdivLevel: 2,
  });
  assert.equal(normalizeLoadedMixoProvenance(persisted.sceneObjects[1]), null);
  assert.equal(normalizeLoadedMixoProvenance({ isInternalPart: false, mixoProvenance: {
    origin: 'mixo3d', markerVersion: 2, viewportSubdivLevel: 1, renderSubdivLevel: 2,
  } }), null, 'unsupported marker cannot regain Mixo provenance from a project file');
});

await test('Mixo primitive refinement survives JSON only on a valid-provenance lead and revalidates on load', () => {
  const provenance = { origin: 'mixo3d', markerVersion: 1, viewportSubdivLevel: 1, renderSubdivLevel: 2 };
  const refinement = [{ primitiveId: 'p0', version: 1, creaseByVertex: new Float32Array([0, 0.5, 1]), sharpEdges: new Uint32Array([0, 1, 0x3f800000]) }];
  const persisted = JSON.parse(JSON.stringify({
    lead: serialiseMixoRefinement({ isInternalPart: false, mixoProvenance: provenance, mixoRefinement: refinement }),
    part: serialiseMixoRefinement({ isInternalPart: true, mixoProvenance: provenance, mixoRefinement: refinement }),
  }));
  assert.deepEqual(persisted.lead[0].creaseByVertex, [0, 0.5, 1]);
  assert.deepEqual(persisted.lead[0].sharpEdges, [[0, 1, 1]]);
  assert.equal(persisted.part, undefined);
  const restored = normalizeLoadedMixoRefinement({ isInternalPart: false, mixoProvenance: provenance, mixoRefinement: persisted.lead }, new Map([['p0', 3]]));
  assert.ok(restored?.[0]?.creaseByVertex instanceof Float32Array);
  assert.deepEqual([...restored[0].sharpEdges], [0, 1, 0x3f800000]);
  const second = { primitiveId: 'p1', version: 1, creaseByVertex: [0, 0, 0, 1], sharpEdges: [[2, 3, 0.5]] };
  const multi = normalizeLoadedMixoRefinement({ isInternalPart: false, mixoProvenance: provenance, mixoRefinement: [...persisted.lead, second] }, new Map([['p0', 3], ['p1', 4]]));
  assert.equal(multi?.length, 2, 'each primitive uses its own vertex count');
  assert.equal(normalizeLoadedMixoRefinement({ isInternalPart: false, mixoProvenance: provenance, mixoRefinement: [persisted.lead[0], persisted.lead[0]] }, new Map([['p0', 3]])), null, 'duplicate primitive identity is malformed');
  assert.equal(normalizeLoadedMixoRefinement({ isInternalPart: false, mixoProvenance: provenance, mixoRefinement: [...persisted.lead, second] }, new Map([['p0', 3], ['p1', 3]])), null);
  assert.equal(normalizeLoadedMixoRefinement({ isInternalPart: false, mixoProvenance: provenance, mixoRefinement: [{ ...persisted.lead[0], sharpEdges: [[0, 9, 1]] }] }, new Map([['p0', 3]])), null);
  assert.equal(normalizeLoadedMixoRefinement({ isInternalPart: false, mixoRefinement: persisted.lead }, new Map([['p0', 3]])), null);
});

await test('print-refinement persistence keeps only intent and reopens refined requests as stale', () => {
  const provenance = { origin: 'mixo3d', markerVersion: 1, viewportSubdivLevel: 1, renderSubdivLevel: 2 };
  const object = { isInternalPart: false, mixoProvenance: provenance,
    printRefinement: { requestedLevel: 2, preview: 'refined', status: 'ready', error: null } };
  const persisted = JSON.parse(JSON.stringify(serialisePrintRefinement(object)));
  assert.deepEqual(persisted, { requestedLevel: 2, preview: 'refined' });
  const restored = normalizeLoadedPrintRefinement({ ...object, printRefinement: persisted }, provenance, [{}]);
  assert.deepEqual(restored, { requestedLevel: 2, preview: 'refined', status: 'stale', error: null });
  assert.equal(serialisePrintRefinement({ ...object, isInternalPart: true }), undefined);
  assert.deepEqual(normalizeLoadedPrintRefinement({ ...object, printRefinement: persisted }, provenance, null),
    { requestedLevel: 0, preview: 'original', status: 'idle', error: null });
});

// ── _fileHandleAtPath ────────────────────────────────────

await test('_fileHandleAtPath: walks nested dirs, splits on / and \\', async () => {
  const inner = dirHandle({ files: new Map([['model.glb', [1, 2, 3]]]) });
  const root  = dirHandle({ dirs: new Map([['sub', inner]]) });
  const fh1 = await _fileHandleAtPath(root, 'sub/model.glb');
  const fh2 = await _fileHandleAtPath(root, 'sub\\model.glb');
  eqBytes(await bytesOf(await fh1.getFile()), [1, 2, 3]);
  eqBytes(await bytesOf(await fh2.getFile()), [1, 2, 3]);
});

// ── _scanDirForHash ──────────────────────────────────────

await test('_scanDirForHash: finds a renamed file by content hash (recursive, ext-filtered)', async () => {
  const target = [9, 8, 7, 6, 5];
  const hash = await _sha256Hex(u8(target));
  const sub  = dirHandle({ files: new Map([['renamed-Copy.glb', target]]) });
  const root = dirHandle({
    files: new Map([['decoy.glb', [0, 0, 0]]]),
    dirs:  new Map([['nested', sub]]),
  });
  const found = await _scanDirForHash(root, hash, '.glb');
  assert.ok(found, 'expected to find the renamed file');
  eqBytes(await bytesOf(found), target);

  // ext filter excludes non-matching extensions
  assert.equal(await _scanDirForHash(root, hash, '.stl'), null);
});

// ── _resolveAssetBlob priority order (the locked decision) ─

await test('priority 1: live file at exact originalPath wins over embedded', async () => {
  const live = [11, 22, 33];
  const root = dirHandle({ dirs: new Map([['parts', dirHandle({ files: new Map([['hull.glb', live]]) })]]) });
  await seedHandle('DIRKEY', root);
  const entry = {
    filename: 'hull.glb', extension: '.glb',
    directoryHandleKey: 'DIRKEY', originalPath: 'parts/hull.glb',
    contentHash: await _sha256Hex(u8(live)),
    fileData: _b64FromBuf(u8([99, 99]).buffer),   // embedded decoy, must NOT win
  };
  const r = await _resolveAssetBlob(entry);
  assert.equal(r.live, true);
  eqBytes(await bytesOf(r.blob), live);
});

await test('priority 2 (retired, Decision 3): path miss does NOT scan - falls back to embedded copy', async () => {
  const live = [4, 5, 6, 7];
  const embedded = [0];
  const hash = await _sha256Hex(u8(embedded).buffer);
  // Saved path gone; a renamed copy sits in the dir but load must not hunt for it.
  const root = dirHandle({ files: new Map([['totally-renamed.glb', live]]) });
  await seedHandle('DIRKEY', root);
  const entry = {
    filename: 'old.glb', extension: '.glb',
    directoryHandleKey: 'DIRKEY', originalPath: 'gone/old.glb',
    contentHash: hash,
    fileData: _b64FromBuf(u8(embedded).buffer),
  };
  const r = await _resolveAssetBlob(entry);
  assert.equal(r.live, false, 'no scan on load: embedded snapshot, not the renamed file');
  eqBytes(await bytesOf(r.blob), embedded);
  assert.equal(r.status, 'missing');
});

await test('priority 3: no granted dir → falls back to embedded static copy', async () => {
  const embedded = [42, 0, 255, 128];
  const root = dirHandle({ files: new Map() }, { granted: false });   // permission denied
  await seedHandle('DIRKEY', root);
  const entry = {
    filename: 'x.glb', extension: '.glb',
    directoryHandleKey: 'DIRKEY', originalPath: 'x.glb',
    contentHash: await _sha256Hex(u8(embedded).buffer),   // matches the embedded copy
    fileData: _b64FromBuf(u8(embedded).buffer),
  };
  const r = await _resolveAssetBlob(entry);
  assert.equal(r.live, false, 'embedded copy is static, not live');
  eqBytes(await bytesOf(r.blob), embedded);
});

await test('priority 3b: dir present, path miss, NO hash match → embedded fallback', async () => {
  const embedded = [1, 2, 3, 4, 5];
  const root = dirHandle({ files: new Map([['unrelated.glb', [9, 9]]]) });
  await seedHandle('DIRKEY', root);
  const entry = {
    filename: 'y.glb', extension: '.glb',
    directoryHandleKey: 'DIRKEY', originalPath: 'gone/y.glb',
    contentHash: await _sha256Hex(u8(embedded).buffer),   // matches nothing in dir, matches embedded
    fileData: _b64FromBuf(u8(embedded).buffer),
  };
  const r = await _resolveAssetBlob(entry);
  assert.equal(r.live, false);
  eqBytes(await bytesOf(r.blob), embedded);
});

await test('M5: embedded bytes whose sha256 disagrees with contentHash → null (ghost), logged', async () => {
  const logged = [];
  const prev = console.error;
  console.error = (...a) => logged.push(a.map(String).join(' '));
  try {
    const r = await _resolveAssetBlob({
      filename: 't.glb', extension: '.glb',
      directoryHandleKey: null, originalPath: null,
      contentHash: await _sha256Hex(u8([1, 2, 3]).buffer),
      fileData: _b64FromBuf(u8([1, 2, 4]).buffer),   // tampered
    });
    assert.equal(r, null, 'tampered embed must not resolve');
    assert.ok(logged.some(l => /contentHash/.test(l)), 'mismatch is logged');
  } finally { console.error = prev; }
});

await test('M5: embedded bytes with NO contentHash still resolve (legacy docs)', async () => {
  const r = await _resolveAssetBlob({
    filename: 'l.glb', extension: '.glb', contentHash: null,
    fileData: _b64FromBuf(u8([5, 6]).buffer),
  });
  eqBytes(await bytesOf(r.blob), [5, 6]);
});

await test('priority 4: no live, no embedded → null (caller makes a ghost)', async () => {
  assert.equal(await _resolveAssetBlob({
    filename: 'g.glb', extension: '.glb',
    directoryHandleKey: null, originalPath: null,
    contentHash: null, fileData: null,
  }), null);
});

// ── fileHandleKey tier (loose-drop relink) ────────────────

await test('fileHandleKey: granted file handle resolves live (above embedded)', async () => {
  const live = [200, 201, 202];
  await seedHandle('FH_DROP', {
    kind: 'file',
    async requestPermission() { return 'granted'; },
    async getFile() { return fakeFile(live); },
  });
  const r = await _resolveAssetBlob({
    filename: 'drop.glb', extension: '.glb',
    fileHandleKey: 'FH_DROP',
    fileData: _b64FromBuf(u8([0, 0]).buffer),
  });
  assert.equal(r.live, true);
  eqBytes(await bytesOf(r.blob), live);
});

await test('fileHandleKey: denied permission → falls through to embedded', async () => {
  const embedded = [50, 60, 70];
  await seedHandle('FH_DENY', {
    kind: 'file',
    async requestPermission() { return 'denied'; },
    async getFile() { throw new Error('should not be called'); },
  });
  const r = await _resolveAssetBlob({
    filename: 'drop.glb', extension: '.glb',
    fileHandleKey: 'FH_DENY',
    fileData: _b64FromBuf(u8(embedded).buffer),
  });
  assert.equal(r.live, false);
  eqBytes(await bytesOf(r.blob), embedded);
});

await test('fileHandleKey: directory handle (live dir) takes priority over loose file handle', async () => {
  const dirLive  = [1, 1, 1];
  const fileLive = [9, 9, 9];
  const root = dirHandle({ files: new Map([['drop.glb', dirLive]]) });
  await seedHandle('DIRKEY', root);
  await seedHandle('FH_DROP', {
    kind: 'file',
    async requestPermission() { return 'granted'; },
    async getFile() { return fakeFile(fileLive); },
  });
  const r = await _resolveAssetBlob({
    filename: 'drop.glb', extension: '.glb',
    directoryHandleKey: 'DIRKEY', originalPath: 'drop.glb',
    fileHandleKey: 'FH_DROP',
    fileData: _b64FromBuf(u8([0]).buffer),
  });
  assert.equal(r.live, true);
  eqBytes(await bytesOf(r.blob), dirLive);
});

await test('no directoryHandleKey but embedded present → static (not ghost)', async () => {
  const embedded = [7, 7, 7];
  const r = await _resolveAssetBlob({
    filename: 'e.glb', extension: '.glb',
    directoryHandleKey: null, originalPath: null,
    contentHash: null, fileData: _b64FromBuf(u8(embedded).buffer),
  });
  assert.equal(r.live, false);
  eqBytes(await bytesOf(r.blob), embedded);
});

// ── Report ───────────────────────────────────────────────

console.log('\n' + out.join('\n'));
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
