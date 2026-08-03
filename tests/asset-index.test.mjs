import assert from 'node:assert/strict';
import {
  createAssetIndex,
  queryAssets,
  nearestFolderPath,
  scanAssetMount,
} from '../src/core/assets/AssetIndex.js';

const rows = [
  { mountKey: 'm1', name: 'kits', path: '', parentPath: '', kind: 'folder', ref: 'm1' },
  { mountKey: 'm1', name: 'a.glb', path: 'kits/a.glb', parentPath: 'kits', kind: 'file', assetKind: 'mesh', ref: 'a' },
  { mountKey: 'm1', name: 'parts', path: 'kits/parts', parentPath: 'kits', kind: 'folder', ref: 'parts' },
  { mountKey: 'm1', name: 'wheel.glb', path: 'kits/parts/wheel.glb', parentPath: 'kits/parts', kind: 'file', assetKind: 'mesh', ref: 'wheel' },
  { mountKey: 'm1', name: 'wheel.png', path: 'kits/parts/wheel.png', parentPath: 'kits/parts', kind: 'file', assetKind: 'texture', ref: 'texture' },
  { mountKey: 'm1', name: 'wheel.glb', path: 'kits/parts/wheel.glb', parentPath: 'kits/parts', kind: 'file', assetKind: 'mesh', ref: 'duplicate' },
  { mountKey: 'm2', name: 'other', path: '', parentPath: '', kind: 'folder', ref: 'm2' },
  { mountKey: 'm2', name: 'wheel.glb', path: 'other/wheel.glb', parentPath: 'other', kind: 'file', assetKind: 'mesh', ref: 'other-wheel' },
];

const index = createAssetIndex(rows);
assert.equal(Object.isFrozen(index), true);
assert.equal(Object.isFrozen(index.files), true);
assert.equal(index.files.length, 4, 'same mount + path appears once');

assert.deepEqual(queryAssets(index, {
  mountKey: 'm1', folderPath: 'kits', text: '', scope: 'folder', kind: 'all',
}).map(x => x.path), ['kits/a.glb']);

assert.deepEqual(queryAssets(index, {
  mountKey: 'm1', folderPath: 'kits', text: 'wheel', scope: 'descendants', kind: 'mesh',
}).map(x => x.path), ['kits/parts/wheel.glb']);

assert.deepEqual(queryAssets(index, {
  mountKey: 'm1', folderPath: 'kits', text: 'wheel', scope: 'all', kind: 'texture',
}).map(x => `${x.mountKey}:${x.path}`), ['m1:kits/parts/wheel.png']);

assert.deepEqual(queryAssets(index, {
  mountKey: 'm1', folderPath: 'kits', text: 'wheel', scope: 'all', kind: 'mesh',
}).map(x => `${x.mountKey}:${x.path}`), [
  'm1:kits/parts/wheel.glb',
  'm2:other/wheel.glb',
]);

assert.deepEqual(queryAssets(index, {
  mountKey: 'm1', folderPath: 'kits', text: 'parts/wheel', scope: 'descendants', kind: 'all',
}).map(x => x.path), ['kits/parts/wheel.glb', 'kits/parts/wheel.png']);

assert.equal(nearestFolderPath(index, 'm1', 'kits/parts/missing/deeper'), 'kits/parts');
assert.equal(nearestFolderPath(index, 'm1', 'gone'), '');
assert.equal(nearestFolderPath(index, 'missing', 'anything'), null);

const directoryRows = new Map([
  ['root', [
    { name: 'parts', path: 'Library/parts', kind: 'directory', ref: 'parts-ref' },
    { name: 'readme.txt', path: 'Library/readme.txt', kind: 'file', ref: 'ignored' },
    { name: 'body.glb', path: 'Library/body.glb', kind: 'file', ref: 'body-ref' },
  ]],
  ['parts-ref', [
    { name: 'paint.png', path: 'Library/parts/paint.png', kind: 'file', ref: 'paint-ref' },
  ]],
]);
const scanCalls = [];
const scanned = await scanAssetMount({
  async listDirectory(ref, displayPath) {
    scanCalls.push([ref, displayPath]);
    return directoryRows.get(ref) ?? [];
  },
}, { mountKey: 'library-1', name: 'Library', ref: 'root' });
assert.deepEqual(scanCalls, [['root', 'Library'], ['parts-ref', 'Library/parts']]);
assert.deepEqual(scanned.files.map(file => ({ path: file.path, sourcePath: file.sourcePath, kind: file.assetKind })), [
  { path: 'Library/body.glb', sourcePath: 'body.glb', kind: 'mesh' },
  { path: 'Library/parts/paint.png', sourcePath: 'parts/paint.png', kind: 'texture' },
]);
