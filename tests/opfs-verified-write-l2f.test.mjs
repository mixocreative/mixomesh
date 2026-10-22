// L2-05: WebKit 27.2 has a main-thread createWritable() whose close() commits
// a 0-byte file, and the app still said "Project saved". An OPFS write must
// check what landed before it reports success, and a short write must leave
// the previous save intact.
//   node --import ./tests/register-hooks.mjs --test tests/opfs-verified-write-l2f.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOpfsRoot, installOpfsEnv, makeMemFs } from './opfs-stub.mjs';
import { OpfsStorageAdapter as A, OPFS_PROJECTS_DIR } from '../src/core/storage/OpfsStorageAdapter.js';

const OLD = '{"v":"previous good save"}';
const NEW = '{"v":"new document, longer than the old one"}';
const bytes = s => new TextEncoder().encode(s);
const text = u8 => new TextDecoder().decode(u8);
const PROJ = `opfs/${OPFS_PROJECTS_DIR}`;

// The stub's handles with createWritable() replaced by WebKit's broken one:
// write() and close() resolve, nothing reaches the file.
function zeroByteWrites(handle) {
  if (handle.kind === 'file') {
    return { ...handle, async createWritable() { return { async write() {}, async close() {}, async abort() {} }; } };
  }
  return {
    ...handle,
    async getFileHandle(...a) { return zeroByteWrites(await handle.getFileHandle(...a)); },
    async getDirectoryHandle(...a) { return zeroByteWrites(await handle.getDirectoryHandle(...a)); },
  };
}

function withOpfs(broken, fn) {
  return async () => {
    const fs = makeMemFs();
    const { root } = createOpfsRoot(fs, 'opfs');
    fs.write(`${PROJ}/p.mixo`, bytes(OLD));
    const env = installOpfsEnv({ root: broken ? zeroByteWrites(root) : root });
    try { await fn(fs); } finally { env.restore(); }
  };
}

const projectRef = async () => (await A.pickOpenProject({ name: 'p' })).ref;
const names = fs => fs.children(PROJ).map(c => c.name).sort();

test('a write that lands 0 bytes is refused and the previous save survives', withOpfs(true, async (fs) => {
  const err = await A.writeFile(await projectRef(), NEW).then(() => null, e => e);
  assert.ok(err, 'writeFile reports the short write instead of success');
  assert.equal(err.previousKept, true, 'the error says the previous copy is intact');
  assert.match(err.message, /0 of \d+ bytes/);
  assert.equal(text(fs.get(`${PROJ}/p.mixo`).bytes), OLD, 'previous save untouched');
  assert.deepEqual(names(fs), ['p.mixo'], 'no staging file left behind');
}));

test('a healthy write replaces the file and leaves no staging file', withOpfs(false, async (fs) => {
  await A.writeFile(await projectRef(), NEW);
  assert.equal(text(fs.get(`${PROJ}/p.mixo`).bytes), NEW);
  assert.deepEqual(names(fs), ['p.mixo']);
}));
