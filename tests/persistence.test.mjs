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
//       live exact path  >  content-hash scan of moved/renamed file
//       >  embedded static copy  >  null (ghost)
//   • sha256 / ext / arrToMap / migrate behave as the load path assumes
// The live Babylon scene round-trip stays a human Chrome check (STEP 1).

import assert from 'node:assert/strict';
import { installEnv } from './env.mjs';
import { putFileHandle as seedHandle, __reset as resetIdb } from './idb-stub.mjs';

installEnv();
console.error = () => {};

const { __test } = await import('../core/PersistenceManager.js');
const {
  _b64FromBuf, _bufFromB64, _sha256Hex, _extOf,
  _resolveAssetBlob, _scanDirForHash, _fileHandleAtPath,
  _arrToMap, _migrate,
} = __test;

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

await test('_migrate: passthrough (scalar gridSize ignored, not stripped)', () => {
  const doc = { version: '3.1', scene: { gridSize: 250 }, foo: 1 };
  assert.equal(_migrate(doc), doc);          // same reference, best-effort load
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
    contentHash: 'deadbeef',
    fileData: _b64FromBuf(u8([99, 99]).buffer),   // embedded decoy, must NOT win
  };
  const r = await _resolveAssetBlob(entry);
  assert.equal(r.live, true);
  eqBytes(await bytesOf(r.blob), live);
});

await test('priority 2: path miss → content-hash scan relinks the moved/renamed file', async () => {
  const live = [4, 5, 6, 7];
  const hash = await _sha256Hex(u8(live));
  // Saved path no longer exists; the file was renamed elsewhere in the dir.
  const root = dirHandle({ files: new Map([['totally-renamed.glb', live]]) });
  await seedHandle('DIRKEY', root);
  const entry = {
    filename: 'old.glb', extension: '.glb',
    directoryHandleKey: 'DIRKEY', originalPath: 'gone/old.glb',
    contentHash: hash,
    fileData: _b64FromBuf(u8([0]).buffer),
  };
  const r = await _resolveAssetBlob(entry);
  assert.equal(r.live, true, 'hash-matched file must count as live (relinked)');
  eqBytes(await bytesOf(r.blob), live);
});

await test('priority 3: no granted dir → falls back to embedded static copy', async () => {
  const embedded = [42, 0, 255, 128];
  const root = dirHandle({ files: new Map() }, { granted: false });   // permission denied
  await seedHandle('DIRKEY', root);
  const entry = {
    filename: 'x.glb', extension: '.glb',
    directoryHandleKey: 'DIRKEY', originalPath: 'x.glb',
    contentHash: 'nope',
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
    contentHash: await _sha256Hex(u8([123, 124])),   // matches nothing in dir
    fileData: _b64FromBuf(u8(embedded).buffer),
  };
  const r = await _resolveAssetBlob(entry);
  assert.equal(r.live, false);
  eqBytes(await bytesOf(r.blob), embedded);
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
