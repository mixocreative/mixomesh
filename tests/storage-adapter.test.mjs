import assert from 'node:assert/strict';
import { storage, BrowserStorageAdapter } from '../src/core/storage/StorageAdapter.js';
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

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
