// Task 4.4: every renderer disk / handle / KV operation goes through the
// StorageAdapter. Spies on the live `storage` object prove the project
// open / save / recent / relink / import / export / remount paths use it, and
// a source scan pins the remaining direct File System Access / IndexedDB uses
// to the adapter itself (+ the documented DOM-only exceptions).
//   node --import ./tests/register-hooks.mjs tests/adapter-routing.test.mjs

import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { installEnv, calls, resetCalls } from './env.mjs';

installEnv();
console.error = () => {};
const { PersistenceManager } = await import('../src/core/PersistenceManager.js');
const { relinkAsset } = await import('../src/core/persist/ProjectLoader.js');
const { pushRecent } = await import('../src/core/persist/RecentProjects.js');
const { triggerDownload } = await import('../src/core/print/Download.js');
const { SceneManager } = await import('../src/core/SceneManager.js');
const { AssetLoader } = await import('../src/core/AssetLoader.js');
const { setState, getState } = await import('../src/core/StateManager.js');
const { Toast } = await import('../src/ui/Toast.js');
const { storage, BrowserStorageAdapter } = await import('../src/core/storage/StorageAdapter.js');

const toasts = [];
Toast.show = (msg, type) => { toasts.push({ msg, type }); };
SceneManager.saveCameraState = () => ({
  alpha: 0, beta: 0, radius: 1, target: { x: 0, y: 0, z: 0 }, isOrthographic: false,
});
AssetLoader.getBabylonMesh = () => null;
AssetLoader.getAssetBytes = async () => null;
// Headless scene shims so an empty project loads (same as persistence-load-guards).
const { Selection } = await import('../src/core/Selection.js');
const { MeshValidator } = await import('../src/core/MeshValidator.js');
MeshValidator.shouldAutoValidate = () => false;
SceneManager.getScene = () => ({ transformNodes: [], meshes: [], defaultMaterial: { name: 'grey' } });
for (const k of ['rebuildBed', 'setGrid', 'setCursorFromState', 'setWireframeEdgeColor', 'setOverlay',
  'applyRenderSettings', 'setScaleLock', 'setFollowMode', 'setCursorVisible', 'setActive', 'setSelected',
  'attachToSelection', 'updateBedPreview']) {
  SceneManager[k] = () => {};
}
Selection.clear = () => {};
Selection.set = () => {};
Selection.refresh = () => {};

let passed = 0, failed = 0;
const out = [];
async function test(name, fn) {
  try { await fn(); out.push(`PASS  ${name}`); passed++; }
  catch (e) { out.push(`FAIL  ${name}\n      ${e.stack || e.message}`); failed++; }
  finally { restoreSpies(); }
}

// ── Spy harness over the live adapter object ──
const originals = new Map();
const log = [];
function spy(method, impl) {
  if (!originals.has(method)) originals.set(method, storage[method]);
  storage[method] = async (...args) => { log.push([method, ...args]); return impl(...args); };
}
function restoreSpies() {
  for (const [m, fn] of originals) storage[m] = fn;
  originals.clear();
  log.length = 0;
}
const called = m => log.filter(([name]) => name === m);

// Any direct File System Access call is a routing bug: make them explode.
const forbid = name => () => { throw new Error(`direct ${name} call bypassed the StorageAdapter`); };
function forbidDirectFsa() {
  window.showOpenFilePicker = forbid('showOpenFilePicker');
  window.showSaveFilePicker = forbid('showSaveFilePicker');
  window.showDirectoryPicker = forbid('showDirectoryPicker');
}

const REF = { opaque: 'project-ref' };   // callers must treat refs as opaque

await test('storage is the browser adapter here (spies patch the live object)', () => {
  assert.equal(storage, BrowserStorageAdapter);
});

await test('saveAs → pickSaveProject + writeFile; save() rewrites the SAME ref; recents via persistRef', async () => {
  forbidDirectFsa();
  setState(s => ({ ...s, project: { ...s.project, name: 'Before' } }), { silent: true });
  const writes = [];
  spy('pickSaveProject', async () => ({ ref: REF, name: 'Routed.mixo' }));
  spy('writeFile', async (ref, text) => { writes.push({ ref, text }); });
  spy('persistRef', async () => 'file_00000000000000000000000000000001');
  spy('kvGet', async () => []);
  spy('kvSet', async () => {});
  spy('kvDelete', async () => {});
  assert.equal(await PersistenceManager.saveAs(), true);
  assert.equal(called('pickSaveProject')[0][1], 'Before.mixo', 'suggested name');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].ref, REF);
  assert.equal(JSON.parse(writes[0].text).project.name, 'Routed');
  assert.equal(getState().project.name, 'Routed');
  assert.equal(called('persistRef')[0][1], REF, 'recent entry persists the project ref through the adapter');
  const recents = called('kvSet').find(([, key]) => key === 'recent_projects')[2];
  assert.equal(recents[0].handleKey, 'file_00000000000000000000000000000001');

  assert.equal(await PersistenceManager.save(), true);
  assert.equal(writes.length, 2);
  assert.equal(writes[1].ref, REF, 'Ctrl+S writes back to the bound ref');
  assert.equal(called('pickSaveProject').length, 1, 'no second picker');
});

await test('saveAs cancelled (adapter → null) → false, nothing written', async () => {
  forbidDirectFsa();
  spy('pickSaveProject', async () => null);
  spy('writeFile', async () => { throw new Error('must not write'); });
  assert.equal(await PersistenceManager.saveAs(), false);
});

await test('open() → pickOpenProject; the picked ref becomes the save target', async () => {
  forbidDirectFsa();
  const doc = JSON.stringify({ version: '3.4', project: { name: 'Opened', id: 'p_open' }, scene: {} });
  spy('pickOpenProject', async () => ({ ref: REF, name: 'Opened.mixo', file: new Blob([doc]) }));
  const writes = [];
  spy('writeFile', async (ref) => { writes.push(ref); });
  spy('persistRef', async () => 'file_00000000000000000000000000000002');
  spy('kvGet', async () => []);
  spy('kvSet', async () => {});
  spy('kvDelete', async () => {});
  spy('kvKeys', async () => []);
  await PersistenceManager.open();
  assert.equal(called('pickOpenProject').length, 1);
  assert.equal(getState().project.name, 'Opened');
  await PersistenceManager.save();
  assert.deepEqual(writes, [REF]);
});

await test('openRecent → hasRef / restoreRef / readFile; lost vs permission-denied are distinct', async () => {
  forbidDirectFsa();
  spy('hasRef', async key => key !== 'gone');
  spy('restoreRef', async key => (key === 'denied' ? null : REF));
  const doc = JSON.stringify({ version: '3.4', project: { name: 'Recent', id: 'p_rec' }, scene: {} });
  spy('readFile', async () => new Blob([doc]));
  spy('kvKeys', async () => []);
  spy('kvDelete', async () => {});
  toasts.length = 0;
  await PersistenceManager.openRecent({ handleKey: 'gone' });
  assert.equal(called('restoreRef').length, 0, 'missing key: no permission prompt');
  assert.equal(toasts.at(-1).type, 'error');
  await PersistenceManager.openRecent({ handleKey: 'denied' });
  assert.equal(toasts.at(-1).type, 'warning');
  await PersistenceManager.openRecent({ handleKey: 'ok' });
  assert.equal(called('readFile')[0][1], REF);
  assert.equal(getState().project.name, 'Recent');
});

await test('pushRecent replaces a same-name entry and forgets its now-unreferenced ref', async () => {
  let list = [
    { name: 'Proj', handleKey: 'file_old' },
    { name: 'Other', handleKey: 'file_other' },
  ];
  spy('persistRef', async () => 'file_new');
  spy('kvGet', async () => list);
  spy('kvSet', async (_k, v) => { list = v; });
  spy('deleteRef', async () => {});
  await pushRecent('Proj', REF);
  assert.deepEqual(list.map(r => r.handleKey), ['file_new', 'file_other']);
  assert.deepEqual(called('deleteRef').map(([, k]) => k), ['file_old']);
});

await test('relinkAsset → pickImportAssets (cancel = no-op, no direct picker)', async () => {
  forbidDirectFsa();
  spy('pickImportAssets', async () => []);
  await relinkAsset('asset_x');
  assert.deepEqual(called('pickImportAssets')[0][1], { multiple: false });
});

await test('triggerDownload → saveExport; a failed save falls back through the adapter (forceDownload)', async () => {
  forbidDirectFsa();
  spy('saveExport', async (_b, _n, hint) => {
    if (!hint.forceDownload) throw new Error('disk full');
    return true;
  });
  const blob = new Blob(['x']);
  assert.equal(await triggerDownload(blob, 'part.stl', { ext: 'stl' }), true);
  const seen = called('saveExport');
  assert.equal(seen.length, 2);
  assert.equal(seen[0][2], 'part.stl');
  assert.equal(seen[1][3].forceDownload, true);
  assert.ok(toasts.some(t => t.type === 'warning' && /disk full/.test(t.msg)));
});

await test('triggerDownload: cancel (false) is passed through, no fallback', async () => {
  spy('saveExport', async () => false);
  assert.equal(await triggerDownload(new Blob(['x']), 'part.stl'), false);
  assert.equal(called('saveExport').length, 1);
});

await test('browser saveExport without a picker uses the anchor download (unchanged web fallback)', async () => {
  resetCalls();
  delete window.showSaveFilePicker;
  assert.equal(await BrowserStorageAdapter.saveExport(new Blob(['x']), 'model.obj'), true);
  assert.deepEqual(calls.downloads, ['model.obj']);
});

// ── UI leaf sites (DOM-light imports) ──
globalThis.document.getElementById = () => null;
globalThis.document.querySelector = () => null;
const { promptImport } = await import('../src/ui/ViewportDrop.js');
const { promptRemount } = await import('../src/ui/AssetPanel.js');

await test('ViewportDrop.promptImport → pickImportAssets + readFile (cancel = no-op)', async () => {
  forbidDirectFsa();
  spy('pickImportAssets', async () => []);
  spy('readFile', async () => { throw new Error('must not read'); });
  await promptImport();
  assert.equal(called('pickImportAssets').length, 1);
  spy('pickImportAssets', async () => [{ ref: REF, name: 'notes.txt' }]);
  spy('readFile', async () => new File(['x'], 'notes.txt'));
  toasts.length = 0;
  await promptImport();
  assert.equal(called('readFile')[0][1], REF);
  assert.ok(toasts.length, 'non-mesh pick tells the user');
});

await test('AssetPanel.promptRemount → storage.kvGet + hasRef (no idb, no permission prompt before the modal)', async () => {
  const { setCapabilities } = await import('../src/core/storage/capabilities.js');
  setCapabilities({ persistAssets: true });   // Node has no IndexedDB → detected false
  spy('kvGet', async () => ({ key: 'dir_00000000000000000000000000000003', name: 'Kit' }));
  spy('hasRef', async () => false);
  spy('restoreRef', async () => { throw new Error('must not prompt before the modal'); });
  await promptRemount();
  assert.equal(called('kvGet')[0][1], 'last_mount_dir');
  assert.equal(called('hasRef')[0][1], 'dir_00000000000000000000000000000003');
});

// ── Source scan: no direct FSA / IndexedDB outside the adapter ──
const SRC = new URL('../src/', import.meta.url);
function walk(dir) {
  const outFiles = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) outFiles.push(...walk(p));
    else if (/\.(js|ts|mjs)$/.test(name)) outFiles.push(p);
  }
  return outFiles;
}
const FORBIDDEN = /showOpenFilePicker|showSaveFilePicker|showDirectoryPicker|createWritable\(|indexedDB|requestPermission\(|getAsFileSystemHandle|from '(?:\.\.?\/)+(?:core\/)?idb\.js'/;
// file → reason. Anything else matching FORBIDDEN fails the test.
const ALLOWED = {
  'core/idb.js': 'the IndexedDB implementation the browser adapter wraps',
  'core/storage/StorageAdapter.js': 'BrowserStorageAdapter — the one FSA/idb owner',
  'core/storage/capabilities.js': 'feature detection only (no calls)',
  'core/storage/OpfsStorageAdapter.js': 'OpfsStorageAdapter (task 8.2) — the OPFS tier owner',
};

await test('no direct File System Access / IndexedDB use outside the adapter (allowlist documented)', () => {
  const root = SRC.pathname.replace(/^\/([A-Za-z]:)/, '$1');
  const hits = [];
  for (const file of walk(root)) {
    const rel = relative(root, file).replace(/\\/g, '/');
    const text = readFileSync(file, 'utf8');
    text.split('\n').forEach((line, i) => {
      if (/^\s*(\/\/|\*)/.test(line)) return;   // comments
      if (FORBIDDEN.test(line) && !ALLOWED[rel]) hits.push(`${rel}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(hits, []);
});

console.log('\n' + out.join('\n'));
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
