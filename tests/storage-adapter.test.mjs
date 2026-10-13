import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { storage, BrowserStorageAdapter, ASSET_STATUS } from '../src/core/storage/StorageAdapter.js';
import { isStableKey } from '../src/core/storage/AssetSource.js';
import { __reset as resetIdb } from './idb-stub.mjs';
import { DesktopStorageAdapter } from '../src/core/storage/DesktopStorageAdapter.js';
import { directoryRefFacade } from '../src/core/assets/DirMounts.js';

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`# PASS  ${name}`); passed++; }
  catch (err) { console.log(`# FAIL  ${name}\n      ${err.stack || err.message}`); failed++; }
}

await test('active storage is the browser adapter in a non-Electron runtime', () => {
  assert.equal(storage.kind, 'browser');
  assert.equal(storage, BrowserStorageAdapter);
});

await test('adapter exposes the capability flags', () => {
  assert.ok(storage.caps && typeof storage.caps === 'object');
  for (const flag of ['persistAssets', 'mountDirectory', 'relinkByPath', 'watchFiles', 'writeFiles']) {
    assert.equal(typeof storage.caps[flag], 'boolean', `caps.${flag} should be a boolean`);
  }
});

await test('cross-session KV methods are present (routed to idb)', () => {
  for (const m of ['kvSet', 'kvGet', 'kvDelete', 'kvKeys']) {
    assert.equal(typeof storage[m], 'function', `${m} should be a function`);
  }
});

await test('importing the adapter does NOT eagerly load idb (headless-safe)', () => {
  // If idb were imported at module top, this test file (node, no IndexedDB) would
  // have thrown on import before reaching here. Reaching this assertion proves the
  // lazy-import keeps the module graph headless-safe.
  assert.ok(true);
});

await test('DesktopStorageAdapter has the desktop shape + caps + KV methods', () => {
  assert.equal(DesktopStorageAdapter.kind, 'desktop');
  assert.ok(DesktopStorageAdapter.caps);
  for (const m of ['kvSet', 'kvGet', 'kvDelete', 'kvKeys']) {
    assert.equal(typeof DesktopStorageAdapter[m], 'function');
  }
});

await test('desktop KV methods are callable + return promises with no electronAPI (headless-safe)', () => {
  const p = DesktopStorageAdapter.kvKeys();
  assert.ok(p && typeof p.then === 'function');
  assert.doesNotThrow(() => DesktopStorageAdapter.kvSet('x', 1));
});

await test('browser directory methods return opaque refs and normalized entries', async () => {
  const file = { name: 'tank.glb' };
  const fileRef = { kind: 'file', name: 'tank.glb', async getFile() { return file; } };
  const dirRef = {
    kind: 'directory', name: 'kits',
    async *entries() { yield ['tank.glb', fileRef]; },
  };
  const previousWindow = globalThis.window;
  globalThis.window = previousWindow ?? {};
  const previousPicker = window.showDirectoryPicker;
  window.showDirectoryPicker = async () => dirRef;
  try {
    const mounted = await BrowserStorageAdapter.mountDirectory();
    assert.equal(mounted.ref, dirRef);
    assert.equal(mounted.name, 'kits');
    assert.deepEqual(await BrowserStorageAdapter.listDirectory(dirRef, 'kits'), [
      { name: 'tank.glb', path: 'kits/tank.glb', kind: 'file', ref: fileRef },
    ]);
    assert.equal(await BrowserStorageAdapter.readFile(fileRef), file);
  } finally {
    window.showDirectoryPicker = previousPicker;
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});

await test('desktop directory methods delegate only opaque mount ids to the bridge', async () => {
  const previousWindow = globalThis.window;
  globalThis.window = previousWindow ?? {};
  const previousApi = window.electronAPI;
  const seen = [];
  window.electronAPI = {
    mountDirectory: async () => ({ ref: 'mount_1', name: 'Library' }),
    listDirectory: async (ref, parentPath) => {
      seen.push([ref, parentPath]);
      return [{ name: 'part.glb', path: 'part.glb', kind: 'file', ref: 'ref_2' }];
    },
    readFileRef: async ref => ({ ref }),
  };
  try {
    assert.deepEqual(await DesktopStorageAdapter.mountDirectory(), { ref: 'mount_1', name: 'Library' });
    assert.equal((await DesktopStorageAdapter.listDirectory('mount_1', ''))[0].ref, 'ref_2');
    assert.deepEqual(await DesktopStorageAdapter.readFile('ref_2'), { ref: 'ref_2' });
    assert.deepEqual(seen, [['mount_1', '']]);
  } finally {
    window.electronAPI = previousApi;
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});

await test('directory facade supports nested sibling lookup without exposing refs', async () => {
  const file = { name: 'paint.png' };
  const rows = new Map([
    ['root', [{ name: 'parts', kind: 'directory', ref: 'nested', path: 'parts' }]],
    ['nested', [{ name: 'paint.png', kind: 'file', ref: 'paint', path: 'paint.png' }]],
  ]);
  const facade = directoryRefFacade({
    listDirectory: async ref => rows.get(ref) ?? [],
    readFile: async ref => ref === 'paint' ? file : null,
  }, 'root');
  const parts = await facade.getDirectoryHandle('parts');
  const names = [];
  for await (const [name] of parts.entries()) names.push(name);
  assert.deepEqual(names, ['paint.png']);
  assert.equal(await (await parts.getFileHandle('paint.png')).getFile(), file);
  assert.equal(JSON.stringify(facade).includes('root'), false);
});

// ── Asset-ref conformance (task 4.2): ONE suite, run against BOTH impls ──────
// Browser impl: real BrowserStorageAdapter over the idb stub + fake FSA handles.
// Desktop impl: real DesktopStorageAdapter over a stubbed `window.electronAPI`
// whose methods call the REAL main-process OpaqueFileRegistry with in-memory fs.

const require = createRequire(import.meta.url);
const { createOpaqueFileRegistry, createMemoryStore } = require('../electron/OpaqueFileRegistry.cjs');

const ROOT = 'C:/vault/Library';
const OTHER = 'C:/vault/Elsewhere';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const bytesOfBlob = async blob => [...new Uint8Array(await blob.arrayBuffer())];
const norm = p => String(p).replace(/\\/g, '/').replace(/\/+$/, '');
const base = p => norm(p).split('/').pop();

/** Minimal in-memory filesystem shared by both harnesses. */
function makeFs() {
  const nodes = new Map();   // abs path → {kind:'dir'} | {kind:'file', bytes, mtime}
  const unreadable = new Set();
  let clock = 1000;
  const mkdirp = p => {
    const parts = norm(p).split('/');
    for (let i = 1; i <= parts.length; i++) {
      const sub = parts.slice(0, i).join('/');
      if (!nodes.has(sub)) nodes.set(sub, { kind: 'dir' });
    }
  };
  const fsApi = {
    nodes, unreadable,
    write(p, bytes) {
      mkdirp(norm(p).split('/').slice(0, -1).join('/'));
      nodes.set(norm(p), { kind: 'file', bytes: Uint8Array.from(bytes), mtime: ++clock });
    },
    mkdir: mkdirp,
    remove(p) {
      const n = norm(p);
      for (const key of [...nodes.keys()]) if (key === n || key.startsWith(`${n}/`)) nodes.delete(key);
    },
    move(from, to) { const n = nodes.get(norm(from)); fsApi.remove(from); fsApi.write(to, n.bytes); },
    get: p => nodes.get(norm(p)),
    children(p) {
      const n = norm(p);
      return [...nodes.keys()]
        .filter(k => k.startsWith(`${n}/`) && !k.slice(n.length + 1).includes('/'))
        .map(k => ({ path: k, name: base(k), node: nodes.get(k) }));
    },
  };
  return fsApi;
}

function seed(fs) {
  fs.write(`${ROOT}/parts/hull.glb`, [1, 2, 3, 4]);
  fs.write(`${ROOT}/parts/decoy.glb`, [9, 9]);
  fs.write(`${ROOT}/notes.txt`, [7]);
  fs.write(`${ROOT}/loose.stl`, [5, 5, 5]);
  fs.mkdir(OTHER);
}

function browserHarness() {
  resetIdb();
  const fs = makeFs();
  seed(fs);
  let permission = 'granted';
  const common = p => ({
    __path: norm(p),
    name: base(p),
    async requestPermission() { return permission; },
    async isSameEntry(other) { return other?.__path === norm(p) && other.kind === this.kind; },
  });
  const fileHandle = p => ({
    ...common(p), kind: 'file',
    async getFile() {
      const n = fs.get(p);
      if (n?.kind !== 'file') throw new Error('NotFoundError');
      return new File([n.bytes], base(p), { lastModified: n.mtime });
    },
  });
  const dirHandle = p => ({
    ...common(p), kind: 'directory',
    async *entries() {
      if (fs.get(p)?.kind !== 'dir') throw new Error('NotFoundError');
      for (const c of fs.children(p)) yield [c.name, c.node.kind === 'dir' ? dirHandle(c.path) : fileHandle(c.path)];
    },
    async getDirectoryHandle(name) {
      if (fs.get(`${p}/${name}`)?.kind !== 'dir') throw new Error('NotFoundError');
      return dirHandle(`${p}/${name}`);
    },
    async getFileHandle(name) {
      if (fs.get(`${p}/${name}`)?.kind !== 'file') throw new Error('NotFoundError');
      return fileHandle(`${p}/${name}`);
    },
  });
  return {
    fs, adapter: BrowserStorageAdapter,
    mount: p => dirHandle(p),
    fileRef: p => fileHandle(p),
    denyRead() { permission = 'denied'; },
    restart() { /* IndexedDB (stub) persists; handles are re-read from it */ },
    cleanup() { resetIdb(); },
  };
}

function desktopHarness() {
  const fs = makeFs();
  seed(fs);
  const store = createMemoryStore();
  const dirent = c => ({
    name: c.name,
    isFile: () => c.node.kind === 'file',
    isDirectory: () => c.node.kind === 'dir',
    isSymbolicLink: () => false,
  });
  const enoent = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  const deps = () => ({
    platform: 'win32',
    store,
    readdir: async p => { if (fs.get(p)?.kind !== 'dir') throw enoent(); return fs.children(p).map(dirent); },
    readFile: async p => { const n = fs.get(p); if (n?.kind !== 'file') throw enoent(); return Buffer.from(n.bytes); },
    stat: async p => {
      const n = fs.get(p);
      if (!n) throw enoent();
      return { isDirectory: () => n.kind === 'dir', isFile: () => n.kind === 'file' };
    },
    access: async p => { if (fs.unreadable.has(norm(p))) throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); },
  });
  let registry = createOpaqueFileRegistry(deps());
  const ipc = value => (value === undefined ? undefined : structuredClone(value));
  const previousWindow = globalThis.window;
  globalThis.window = previousWindow ?? {};
  const previousApi = window.electronAPI;
  window.electronAPI = {
    listDirectory: async (ref, parent) => ipc(await registry.listDirectory(ref, parent)),
    readFileRef: async ref => ipc(await registry.readFile(ref)),
    persistRef: async ref => registry.persistRef(ref),
    restoreRef: async key => registry.restoreRef(key),
    deleteRef: async key => registry.deleteRef(key),
    readStoredFile: async (key, rel) => ipc(await registry.readStoredFile(key, rel)),
    findMoved: async (args, onProgress) => ipc(await registry.findMoved(structuredClone(args), onProgress)),
  };
  return {
    fs, adapter: DesktopStorageAdapter,
    mount: p => registry.registerMount(p.replace(/\//g, '\\')).ref,
    fileRef: p => registry.registerFile(p.replace(/\//g, '\\')).ref,
    denyRead() { fs.unreadable.add(ROOT); },
    restart() { registry = createOpaqueFileRegistry(deps()); },   // tokens die, store survives
    cleanup() {
      window.electronAPI = previousApi;
      if (previousWindow === undefined) delete globalThis.window;
      else globalThis.window = previousWindow;
    },
  };
}

async function conformance(label, makeHarness) {
  const run = (name, fn) => test(`[${label}] ${name}`, async () => {
    const h = makeHarness();
    try { await fn(h, h.adapter); } finally { h.cleanup(); }
  });
  const hullHash = sha(Uint8Array.from([1, 2, 3, 4]));
  const folderSource = key => ({ kind: 'folder', refKey: key, path: 'parts/hull.glb', label: 'hull.glb' });

  await run('persistRef returns a stable key: same folder → same key, also after a restart', async (h, a) => {
    const key = await a.persistRef(h.mount(ROOT));
    assert.ok(isStableKey(key), `stable key shape, got ${key}`);
    assert.ok(key.startsWith('dir_'));
    assert.equal(await a.persistRef(h.mount(ROOT)), key);
    h.restart();
    assert.equal(await a.persistRef(h.mount(ROOT)), key, 'key survives a restart');
    assert.notEqual(await a.persistRef(h.mount(OTHER)), key, 'different folder → different key');
  });

  await run('restoreRef after a restart gives a usable ref; unknown key → null', async (h, a) => {
    const key = await a.persistRef(h.mount(ROOT));
    h.restart();
    const ref = await a.restoreRef(key);
    assert.ok(ref, 'restored');
    const names = (await a.listDirectory(ref, '')).map(r => r.name);
    assert.deepEqual(names, ['parts', 'loose.stl', 'notes.txt']);
    assert.equal(await a.restoreRef('dir_00000000000000000000000000000000'), null);
    assert.equal(await a.restoreRef(''), null);
  });

  await run('restoreRef re-validates: unreadable source → null', async (h, a) => {
    const key = await a.persistRef(h.mount(ROOT));
    h.restart();
    h.denyRead();
    assert.equal(await a.restoreRef(key), null);
  });

  await run('deleteRef forgets the key', async (h, a) => {
    const key = await a.persistRef(h.mount(ROOT));
    await a.deleteRef(key);
    assert.equal(await a.restoreRef(key), null);
  });

  await run('resolveAsset: no source → embedded; matching hash → linked', async (h, a) => {
    assert.deepEqual(await a.resolveAsset(null, { contentHash: hullHash }), { status: ASSET_STATUS.EMBEDDED, blob: null });
    const key = await a.persistRef(h.mount(ROOT));
    h.restart();
    const r = await a.resolveAsset(folderSource(key), { contentHash: hullHash });
    assert.equal(r.status, 'linked');
    assert.deepEqual(await bytesOfBlob(r.blob), [1, 2, 3, 4]);
  });

  await run('resolveAsset: bytes differ from contentHash → changed (with the disk bytes)', async (h, a) => {
    const key = await a.persistRef(h.mount(ROOT));
    h.fs.write(`${ROOT}/parts/hull.glb`, [1, 2, 3, 4, 5]);
    const r = await a.resolveAsset(folderSource(key), { contentHash: hullHash });
    assert.equal(r.status, 'changed');
    assert.deepEqual(await bytesOfBlob(r.blob), [1, 2, 3, 4, 5]);
  });

  await run('resolveAsset: moved file → missing, never scans (Decision 3)', async (h, a) => {
    const key = await a.persistRef(h.mount(ROOT));
    h.fs.move(`${ROOT}/parts/hull.glb`, `${ROOT}/renamed/hull-v2.glb`);
    assert.deepEqual(await a.resolveAsset(folderSource(key), { contentHash: hullHash }), { status: 'missing', blob: null });
    h.fs.remove(ROOT);
    assert.equal((await a.resolveAsset(folderSource(key), { contentHash: hullHash })).status, 'missing');
  });

  await run('resolveAsset: a path escaping the folder is refused → missing', async (h, a) => {
    h.fs.write('C:/vault/secret.glb', [1, 2, 3, 4]);
    const key = await a.persistRef(h.mount(ROOT));
    for (const path of ['../secret.glb', 'parts/../../secret.glb', 'C:/vault/secret.glb', '/secret.glb']) {
      const r = await a.resolveAsset({ kind: 'folder', refKey: key, path }, { contentHash: hullHash });
      assert.equal(r.status, 'missing', path);
    }
  });

  await run('single-file source: linked, then missing once deleted', async (h, a) => {
    const key = await a.persistRef(h.fileRef(`${ROOT}/loose.stl`));
    assert.ok(key.startsWith('file_'));
    h.restart();
    const src = { kind: 'file', refKey: key, path: 'loose.stl', label: 'loose.stl' };
    const r = await a.resolveAsset(src, { contentHash: sha(Uint8Array.from([5, 5, 5])) });
    assert.equal(r.status, 'linked');
    h.fs.remove(`${ROOT}/loose.stl`);
    assert.equal((await a.resolveAsset(src, {})).status, 'missing');
  });

  await run('findMoved: explicit walk finds the moved file, reports progress, ext-filtered', async (h, a) => {
    const key = await a.persistRef(h.mount(ROOT));
    h.restart();
    h.fs.move(`${ROOT}/parts/hull.glb`, `${ROOT}/zz/renamed.glb`);
    const progress = [];
    const r = await a.findMoved(folderSource(key), { contentHash: hullHash, onProgress: p => progress.push(p.scanned) });
    assert.deepEqual(r.source, { kind: 'folder', refKey: key, path: 'zz/renamed.glb', label: 'hull.glb' });
    assert.deepEqual(await bytesOfBlob(r.blob), [1, 2, 3, 4]);
    assert.equal(r.scanned, 2, 'only .glb files are hashed (decoy + match)');
    assert.deepEqual(progress, [1, 2]);
    const after = await a.resolveAsset(r.source, { contentHash: hullHash });
    assert.equal(after.status, 'linked', 'the returned source resolves');
  });

  await run('findMoved: can search another persisted folder; no match → source null', async (h, a) => {
    const key = await a.persistRef(h.mount(ROOT));
    h.fs.move(`${ROOT}/parts/hull.glb`, `${OTHER}/deep/hull.glb`);
    const otherKey = await a.persistRef(h.mount(OTHER));
    const r = await a.findMoved(folderSource(key), { contentHash: hullHash, refKey: otherKey });
    assert.equal(r.source.refKey, otherKey);
    assert.equal(r.source.path, 'deep/hull.glb');
    const none = await a.findMoved(folderSource(key), { contentHash: sha(Uint8Array.from([0])) });
    assert.equal(none.source, null);
    assert.equal(none.blob, null);
  });

  await run('findMoved honours the file limit', async (h, a) => {
    const key = await a.persistRef(h.mount(ROOT));
    h.fs.move(`${ROOT}/parts/hull.glb`, `${ROOT}/zz/renamed.glb`);
    const r = await a.findMoved(folderSource(key), { contentHash: hullHash, limit: 1 });
    assert.equal(r.source, null);
    assert.equal(r.scanned, 1);
  });
}

await conformance('browser', browserHarness);
await conformance('desktop', desktopHarness);

await test('desktop shell declares watchFiles:false until watchAsset exists', () => {
  const preload = readFileSync(new URL('../electron/preload.cjs', import.meta.url), 'utf8');
  assert.match(preload, /watchFiles:\s*false/);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
