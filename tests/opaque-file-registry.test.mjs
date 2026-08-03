import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createOpaqueFileRegistry } = require('../electron/OpaqueFileRegistry.cjs');

const dirent = (name, kind) => ({
  name,
  isDirectory: () => kind === 'directory',
  isFile: () => kind === 'file',
});

const seen = [];
const registry = createOpaqueFileRegistry({
  randomUUID: (() => { let id = 0; return () => `id-${++id}`; })(),
  readdir: async path => {
    seen.push(['list', path]);
    return [dirent('sub', 'directory'), dirent('part.glb', 'file')];
  },
  readFile: async path => {
    seen.push(['read', path]);
    return Buffer.from([1, 2, 3]);
  },
});

const mount = registry.registerMount('C:\\private\\Library', 'Library');
assert.deepEqual(mount, { ref: 'mount_id-1', name: 'Library' });
assert.equal(JSON.stringify(mount).includes('private'), false);

const entries = await registry.listDirectory(mount.ref, 'Library');
assert.deepEqual(entries.map(({ name, path, kind }) => ({ name, path, kind })), [
  { name: 'sub', path: 'Library/sub', kind: 'directory' },
  { name: 'part.glb', path: 'Library/part.glb', kind: 'file' },
]);
assert.equal(entries.every(entry => entry.ref.startsWith('ref_')), true);
assert.equal(JSON.stringify(entries).includes('private'), false);
assert.deepEqual(seen[0], ['list', 'C:\\private\\Library']);

const file = entries.find(entry => entry.kind === 'file');
const payload = await registry.readFile(file.ref);
assert.equal(payload.name, 'part.glb');
assert.deepEqual([...new Uint8Array(payload.bytes)], [1, 2, 3]);
assert.equal(JSON.stringify(payload).includes('private'), false);
assert.deepEqual(seen[1], ['read', 'C:\\private\\Library\\part.glb']);

await assert.rejects(() => registry.listDirectory('C:\\private\\Library', ''), /Unknown directory reference/);
await assert.rejects(() => registry.readFile('C:\\private\\Library\\part.glb'), /Unknown file reference/);
