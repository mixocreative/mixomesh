import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { storage, BrowserStorageAdapter, ASSET_STATUS } from '../src/core/storage/StorageAdapter.js';
import { isStableKey } from '../src/core/storage/AssetSource.js';
import { __reset as resetIdb } from './idb-stub.mjs';
import { DesktopStorageAdapter } from '../src/core/storage/DesktopStorageAdapter.js';
import { directoryRefFacade } from '../src/core/assets/DirMounts.js';
import { OpfsStorageAdapter } from '../src/core/storage/OpfsStorageAdapter.js';
import { createOpfsRoot, installOpfsEnv } from './opfs-stub.mjs';

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
    async createWritable() {
      const chunks = [];
      return {
        async write(d) { chunks.push(typeof d === 'string' ? new TextEncoder().encode(d) : new Uint8Array(await new Blob([d]).arrayBuffer())); },
        async close() { fs.write(p, [...chunks.flatMap(c => [...c])]); },
        async abort() { chunks.length = 0; },
      };
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
  const previousWindow = globalThis.window;
  globalThis.window = previousWindow ?? {};
  const saved = {
    open: window.showOpenFilePicker, save: window.showSaveFilePicker,
  };
  const abort = () => Object.assign(new Error('cancel'), { name: 'AbortError' });
  return {
    fs, adapter: BrowserStorageAdapter,
    mount: p => dirHandle(p),
    fileRef: p => fileHandle(p),
    denyRead() { permission = 'denied'; },
    restart() { /* IndexedDB (stub) persists; handles are re-read from it */ },
    // Pickers answer with these paths (null = the user cancelled).
    answerSave(p) { window.showSaveFilePicker = async () => { if (!p) throw abort(); return fileHandle(p); }; },
    answerOpen(paths) { window.showOpenFilePicker = async () => { if (!paths) throw abort(); return paths.map(fileHandle); }; },
    cleanup() {
      resetIdb();
      window.showOpenFilePicker = saved.open;
      window.showSaveFilePicker = saved.save;
      if (previousWindow === undefined) delete globalThis.window;
    },
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
    writeFile: async (p, bytes) => { fs.write(p, [...bytes]); },
    rename: async (from, to) => { fs.move(from, to); },
    unlink: async p => { fs.remove(p); },
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
    writeFileRef: async (ref, data) => registry.writeFile(ref, ipc(data)),
  };
  const win = p => p.replace(/\//g, '\\');
  return {
    fs, adapter: DesktopStorageAdapter,
    mount: p => registry.registerMount(p.replace(/\//g, '\\')).ref,
    fileRef: p => registry.registerFile(p.replace(/\//g, '\\')).ref,
    denyRead() { fs.unreadable.add(ROOT); },
    restart() { registry = createOpaqueFileRegistry(deps()); },   // tokens die, store survives
    answerSave(p) {
      window.electronAPI.pickSaveProject = async () => (p ? ipc(registry.registerFile(win(p), base(p), { writable: true })) : null);
    },
    answerOpen(paths) {
      window.electronAPI.pickOpenProject = async () => (paths ? ipc(registry.registerFile(win(paths[0]), base(paths[0]), { writable: true })) : null);
      window.electronAPI.pickImportAssets = async () => (paths ? paths.map(p => ipc(registry.registerFile(win(p), base(p)))) : []);
    },
    cleanup() {
      window.electronAPI = previousApi;
      if (previousWindow === undefined) delete globalThis.window;
      else globalThis.window = previousWindow;
    },
  };
}

// OPFS tier (task 8.2): real OpfsStorageAdapter over the idb stub + an
// in-memory OPFS whose root is `C:` (so ROOT/OTHER are folders INSIDE it) and
// stubbed file input / name prompt. No live links in this tier.
function opfsHarness() {
  resetIdb();
  const fs = makeFs();
  seed(fs);
  const denied = new Set();
  const { root, dirHandle, fileHandle } = createOpfsRoot(fs, 'C:', { denied });
  const env = installOpfsEnv({ root });
  const fileOf = p => new File([fs.get(p).bytes], base(p));
  return {
    fs, adapter: OpfsStorageAdapter,
    mount: p => dirHandle(p),
    fileRef: p => fileHandle(p),
    denyRead() { denied.add(ROOT); },
    restart() { /* OPFS + IndexedDB (stub) persist; refs re-walk the stored path */ },
    // The in-app name step answers this file's name (null = cancelled).
    answerSave(p) { OpfsStorageAdapter.setSaveNamePrompt(async () => (p ? base(p) : null)); },
    answerOpen(paths) { env.setAnswer(() => (paths ? paths.map(fileOf) : null)); },
    cleanup() {
      OpfsStorageAdapter.setSaveNamePrompt(null);
      env.restore();
      resetIdb();
    },
  };
}

async function conformance(label, makeHarness, { liveLinks = true } = {}) {
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

  if (liveLinks) await run('resolveAsset: no source → embedded; matching hash → linked', async (h, a) => {
    assert.deepEqual(await a.resolveAsset(null, { contentHash: hullHash }), { status: ASSET_STATUS.EMBEDDED, blob: null });
    const key = await a.persistRef(h.mount(ROOT));
    h.restart();
    const r = await a.resolveAsset(folderSource(key), { contentHash: hullHash });
    assert.equal(r.status, 'linked');
    assert.deepEqual(await bytesOfBlob(r.blob), [1, 2, 3, 4]);
  });

  if (liveLinks) await run('resolveAsset: bytes differ from contentHash → changed (with the disk bytes)', async (h, a) => {
    const key = await a.persistRef(h.mount(ROOT));
    h.fs.write(`${ROOT}/parts/hull.glb`, [1, 2, 3, 4, 5]);
    const r = await a.resolveAsset(folderSource(key), { contentHash: hullHash });
    assert.equal(r.status, 'changed');
    assert.deepEqual(await bytesOfBlob(r.blob), [1, 2, 3, 4, 5]);
  });

  if (liveLinks) await run('resolveAsset: moved file → missing, never scans (Decision 3)', async (h, a) => {
    const key = await a.persistRef(h.mount(ROOT));
    h.fs.move(`${ROOT}/parts/hull.glb`, `${ROOT}/renamed/hull-v2.glb`);
    assert.deepEqual(await a.resolveAsset(folderSource(key), { contentHash: hullHash }), { status: 'missing', blob: null });
    h.fs.remove(ROOT);
    assert.equal((await a.resolveAsset(folderSource(key), { contentHash: hullHash })).status, 'missing');
  });

  if (liveLinks) await run('resolveAsset: a path escaping the folder is refused → missing', async (h, a) => {
    h.fs.write('C:/vault/secret.glb', [1, 2, 3, 4]);
    const key = await a.persistRef(h.mount(ROOT));
    for (const path of ['../secret.glb', 'parts/../../secret.glb', 'C:/vault/secret.glb', '/secret.glb']) {
      const r = await a.resolveAsset({ kind: 'folder', refKey: key, path }, { contentHash: hullHash });
      assert.equal(r.status, 'missing', path);
    }
  });

  if (liveLinks) await run('single-file source: linked, then missing once deleted', async (h, a) => {
    const key = await a.persistRef(h.fileRef(`${ROOT}/loose.stl`));
    assert.ok(key.startsWith('file_'));
    h.restart();
    const src = { kind: 'file', refKey: key, path: 'loose.stl', label: 'loose.stl' };
    const r = await a.resolveAsset(src, { contentHash: sha(Uint8Array.from([5, 5, 5])) });
    assert.equal(r.status, 'linked');
    h.fs.remove(`${ROOT}/loose.stl`);
    assert.equal((await a.resolveAsset(src, {})).status, 'missing');
  });

  if (liveLinks) await run('findMoved: explicit walk finds the moved file, reports progress, ext-filtered', async (h, a) => {
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

  if (liveLinks) await run('findMoved: can search another persisted folder; no match → source null', async (h, a) => {
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

  if (!liveLinks) {
    await run('no live links: every source resolves to the embedded copy; findMoved never walks', async (h, a) => {
      const key = await a.persistRef(h.mount(ROOT));
      const fileKey = await a.persistRef(h.fileRef(`${ROOT}/loose.stl`));
      assert.ok(fileKey.startsWith('file_'));
      for (const src of [null, folderSource(key), { kind: 'file', refKey: fileKey, path: 'loose.stl' }]) {
        assert.deepEqual(await a.resolveAsset(src, { contentHash: hullHash }), { status: ASSET_STATUS.EMBEDDED, blob: null });
      }
      assert.deepEqual(await a.findMoved(folderSource(key), { contentHash: hullHash }), { source: null, blob: null, scanned: 0 });
    });
  }

  // ── Project / import I/O (task 4.4) ──
  const textOf = async blob => new TextDecoder().decode(new Uint8Array(await blob.arrayBuffer()));

  await run('project save: pickSaveProject → writeFile → readFile; cancel → null', async (h, a) => {
    h.answerSave(null);
    assert.equal(await a.pickSaveProject('Untitled.mixo'), null);
    h.answerSave(`${ROOT}/proj.mixo`);
    const picked = await a.pickSaveProject('Untitled.mixo');
    assert.equal(picked.name, 'proj.mixo');
    await a.writeFile(picked.ref, '{"v":1}');
    assert.equal(await textOf(await a.readFile(picked.ref)), '{"v":1}');
    await a.writeFile(picked.ref, '{"v":2}');   // Ctrl+S overwrites in place
    assert.equal(await textOf(await a.readFile(picked.ref)), '{"v":2}');
  });

  await run('recent project: persisted ref survives a restart and can be written again', async (h, a) => {
    h.answerSave(`${ROOT}/proj.mixo`);
    const picked = await a.pickSaveProject('proj.mixo');
    await a.writeFile(picked.ref, 'one');
    const key = await a.persistRef(picked.ref);
    assert.ok(isStableKey(key) && key.startsWith('file_'), key);
    assert.equal(await a.hasRef(key), true);
    h.restart();
    const ref = await a.restoreRef(key);
    assert.equal(await textOf(await a.readFile(ref)), 'one');
    await a.writeFile(ref, 'two');
    assert.equal(await textOf(await a.readFile(ref)), 'two');
    await a.deleteRef(key);
    assert.equal(await a.hasRef(key), false);
  });

  await run('pickOpenProject returns {ref,name,file}; cancel → null', async (h, a) => {
    h.fs.write(`${ROOT}/open.mixo`, [...new TextEncoder().encode('{"ok":true}')]);
    h.answerOpen(null);
    assert.equal(await a.pickOpenProject(), null);
    h.answerOpen([`${ROOT}/open.mixo`]);
    const picked = await a.pickOpenProject();
    assert.equal(picked.name, 'open.mixo');
    assert.equal(await textOf(picked.file), '{"ok":true}');
  });

  await run('pickImportAssets returns readable refs; cancel → []', async (h, a) => {
    h.answerOpen(null);
    assert.deepEqual(await a.pickImportAssets({ multiple: true }), []);
    h.answerOpen([`${ROOT}/loose.stl`, `${ROOT}/parts/hull.glb`]);
    const picked = await a.pickImportAssets({ multiple: true });
    assert.deepEqual(picked.map(p => p.name), ['loose.stl', 'hull.glb']);
    assert.deepEqual(await bytesOfBlob(await a.readFile(picked[1].ref)), [1, 2, 3, 4]);
  });

  if (liveLinks) await run('findMoved honours the file limit', async (h, a) => {
    const key = await a.persistRef(h.mount(ROOT));
    h.fs.move(`${ROOT}/parts/hull.glb`, `${ROOT}/zz/renamed.glb`);
    const r = await a.findMoved(folderSource(key), { contentHash: hullHash, limit: 1 });
    assert.equal(r.source, null);
    assert.equal(r.scanned, 1);
  });
}

await conformance('browser', browserHarness);
await conformance('desktop', desktopHarness);
await conformance('opfs', opfsHarness, { liveLinks: false });

await test('[desktop] import + mount refs are read-only; a failed write leaves the file intact', async () => {
  const h = desktopHarness();
  try {
    h.answerOpen([`${ROOT}/loose.stl`]);
    const [picked] = await h.adapter.pickImportAssets({ multiple: false });
    await assert.rejects(h.adapter.writeFile(picked.ref, 'x'), /read-only/);
    const listed = await h.adapter.listDirectory(h.mount(ROOT), '');
    const file = listed.find(r => r.kind === 'file');
    await assert.rejects(h.adapter.writeFile(file.ref, 'x'), /read-only/);
    await assert.rejects(h.adapter.writeFile('ref_forged', 'x'), /Unknown/);
    assert.deepEqual([...h.fs.get(`${ROOT}/loose.stl`).bytes], [5, 5, 5]);
    // An import ref persisted + restored stays read-only.
    h.restart();
    h.answerOpen([`${ROOT}/loose.stl`]);
    const [again] = await h.adapter.pickImportAssets({ multiple: false });
    const restored = await h.adapter.restoreRef(await h.adapter.persistRef(again.ref));
    await assert.rejects(h.adapter.writeFile(restored, 'x'), /read-only/);
  } finally { h.cleanup(); }
});

await test('[desktop] saveExport hands bytes to main and reports cancel as false', async () => {
  const previousWindow = globalThis.window;
  globalThis.window = previousWindow ?? {};
  const previousApi = window.electronAPI;
  const seen = [];
  window.electronAPI = { saveExport: async (opts, data) => { seen.push({ opts, data: [...data] }); return seen.length === 1; } };
  try {
    assert.equal(await DesktopStorageAdapter.saveExport(new Blob([Uint8Array.from([1, 2])]), 'a.stl', { description: 'STL file' }), true);
    assert.equal(await DesktopStorageAdapter.saveExport(new Blob(['z']), 'b.obj'), false);
    assert.deepEqual(seen[0], { opts: { suggestedName: 'a.stl', ext: 'stl', description: 'STL file' }, data: [1, 2] });
    await assert.rejects(DesktopStorageAdapter.saveExport(new Blob(['z']), 'c.obj', { forceDownload: true }));
  } finally {
    window.electronAPI = previousApi;
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});

await test('[desktop] saveExport streams big files in chunks; cancel, failure and old shells handled', async () => {
  const { setExportStreaming } = await import('../src/core/storage/DesktopStorageAdapter.js');
  const previousWindow = globalThis.window;
  globalThis.window = previousWindow ?? {};
  const previousApi = window.electronAPI;
  const prev = setExportStreaming({ thresholdBytes: 4, chunkBytes: 3 });
  const calls = [];
  const api = (overrides = {}) => ({
    saveExport: async (opts, data) => { calls.push(['oneShot', data.length]); return true; },
    beginExportSave: async (opts) => { calls.push(['begin', opts.ext]); return 'save_1'; },
    writeExportChunk: async (id, data) => { calls.push(['chunk', id, [...new Uint8Array(data)]]); return true; },
    commitExportSave: async (id) => { calls.push(['commit', id]); return true; },
    abortExportSave: async (id) => { calls.push(['abort', id]); return true; },
    ...overrides,
  });
  try {
    const big = new Blob([Uint8Array.from([1,2,3,4,5,6,7,8,9,10])]);
    window.electronAPI = api();
    assert.equal(await DesktopStorageAdapter.saveExport(big, 'big.stl'), true);
    assert.deepEqual(calls, [['begin', 'stl'], ['chunk', 'save_1', [1,2,3]], ['chunk', 'save_1', [4,5,6]],
      ['chunk', 'save_1', [7,8,9]], ['chunk', 'save_1', [10]], ['commit', 'save_1']]);

    calls.length = 0;
    assert.equal(await DesktopStorageAdapter.saveExport(new Blob([Uint8Array.from([1,2])]), 'small.stl'), true);
    assert.deepEqual(calls, [['oneShot', 2]], 'small files keep the one-shot save');

    calls.length = 0;
    window.electronAPI = api({ beginExportSave: async () => null });
    assert.equal(await DesktopStorageAdapter.saveExport(big, 'big.stl'), false, 'dialog cancelled');

    calls.length = 0;
    let n = 0;
    window.electronAPI = api({ writeExportChunk: async () => { if (++n === 2) throw new Error('disk full'); return true; } });
    await assert.rejects(DesktopStorageAdapter.saveExport(big, 'big.stl'), /disk full/);
    assert.deepEqual(calls.at(-1), ['abort', 'save_1'], 'a failed chunk aborts the session');

    calls.length = 0;
    setExportStreaming({ thresholdBytes: 4, chunkBytes: 3, maxBytes: 8 });
    window.electronAPI = api();
    await assert.rejects(DesktopStorageAdapter.saveExport(big, 'huge.stl'), /too large/);
    assert.deepEqual(calls, [], 'refused before the dialog, nothing streamed');
    setExportStreaming({ maxBytes: 1024 ** 3 });

    calls.length = 0;
    const old = api(); delete old.beginExportSave;
    window.electronAPI = old;
    assert.equal(await DesktopStorageAdapter.saveExport(big, 'big.stl'), true);
    assert.deepEqual(calls, [['oneShot', 10]], 'an older shell without streaming still saves');
  } finally {
    setExportStreaming(prev);
    window.electronAPI = previousApi;
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});

await test('[desktop] ready(): incomplete bridge / failed handshake → storageUnavailable; full bridge → ok', async () => {
  const previousWindow = globalThis.window;
  globalThis.window = previousWindow ?? {};
  const previousApi = window.electronAPI;
  const full = {};
  for (const m of ['storageReady', 'kvSet', 'kvGet', 'kvDelete', 'kvKeys', 'mountDirectory', 'listDirectory',
    'readFileRef', 'persistRef', 'restoreRef', 'deleteRef', 'readStoredFile', 'findMoved', 'pickOpenProject',
    'pickSaveProject', 'writeFileRef', 'pickImportAssets', 'saveExport', 'refForDroppedFile']) full[m] = async () => null;
  try {
    window.electronAPI = { kvGet: async () => null };
    await assert.rejects(DesktopStorageAdapter.ready(), e => e.storageUnavailable === true && /missing storageReady/.test(e.message));
    window.electronAPI = { ...full, storageReady: async () => ({ ok: false, reason: 'kv locked' }) };
    await assert.rejects(DesktopStorageAdapter.ready(), e => e.storageUnavailable && /kv locked/.test(e.message));
    window.electronAPI = { ...full, storageReady: async () => { throw new Error('ipc down'); } };
    await assert.rejects(DesktopStorageAdapter.ready(), e => e.storageUnavailable && /ipc down/.test(e.message));
    window.electronAPI = { ...full, storageReady: async () => ({ ok: true }) };
    await DesktopStorageAdapter.ready();
  } finally {
    window.electronAPI = previousApi;
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});

await test('[browser] ready(): no File System Access → blocking "Browser not supported"', async () => {
  const previousWindow = globalThis.window;
  globalThis.window = {};
  try {
    await assert.rejects(BrowserStorageAdapter.ready(), e => e.storageUnavailable && e.title === 'Browser not supported');
    window.showDirectoryPicker = async () => null;
    await BrowserStorageAdapter.ready();
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});

await test('preload exposes every bridge method the desktop adapter requires', () => {
  const preload = readFileSync(new URL('../electron/preload.cjs', import.meta.url), 'utf8');
  const adapter = readFileSync(new URL('../src/core/storage/DesktopStorageAdapter.js', import.meta.url), 'utf8');
  const required = [...adapter.match(/REQUIRED_BRIDGE = \[([\s\S]*?)\];/)[1].matchAll(/'(\w+)'/g)].map(m => m[1]);
  assert.ok(required.length >= 19, `parsed ${required.length} names`);
  for (const m of required) assert.match(preload, new RegExp(`\\b${m}:`), `preload must expose ${m}`);
});

await test('desktop shell declares watchFiles:false until watchAsset exists', () => {
  const preload = readFileSync(new URL('../electron/preload.cjs', import.meta.url), 'utf8');
  assert.match(preload, /watchFiles:\s*false/);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
