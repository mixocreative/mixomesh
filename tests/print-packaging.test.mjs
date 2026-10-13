// Unit tests for PrintPackaging (task 6.6f).
//   node --import ./tests/register-hooks.mjs tests/print-packaging.test.mjs

import assert from 'node:assert/strict';
import { installEnv, calls, resetCalls } from './env.mjs';

installEnv();
const { packageAndDownload, uniqueEntryPaths } = await import('../src/core/print/PrintPackaging.js');
const { instances } = await import('./jszip-stub.mjs');

let passed = 0, failed = 0;
const out = [];
async function test(name, fn) {
  try { await fn(); out.push(`PASS  ${name}`); passed++; }
  catch (e) { out.push(`FAIL  ${name}\n      ${e.stack || e.message}`); failed++; }
}

// Capturing save picker: records suggestedName/types and what gets written.
function installPicker({ cancel = false } = {}) {
  const rec = { opts: null, written: null };
  window.showSaveFilePicker = async (opts) => {
    rec.opts = opts;
    if (cancel) { const e = new Error('x'); e.name = 'AbortError'; throw e; }
    return { createWritable: async () => ({
      write: async (d) => { rec.written = d; }, close: async () => {},
    }) };
  };
  return rec;
}
const progressLog = () => { const log = []; const fn = (p, m) => log.push([p, m]); fn.log = log; return fn; };

await test('uniqueEntryPaths: distinct paths pass through by identity', () => {
  const entries = [{ path: 'a.obj', data: 1 }, { path: 'b.obj', data: 2 }];
  const r = uniqueEntryPaths(entries);
  assert.equal(r.length, 2);
  assert.ok(r[0] === entries[0] && r[1] === entries[1]);
});

await test('uniqueEntryPaths: case-insensitive duplicates get _2, _3 suffixes', () => {
  const r = uniqueEntryPaths([
    { path: 'Cube.obj', data: 1 }, { path: 'cube.obj', data: 2 }, { path: 'CUBE.OBJ', data: 3 },
  ]);
  assert.equal(r[0].path, 'Cube.obj');
  assert.equal(r[1].path, 'cube_2.obj');
  assert.equal(r[2].path, 'CUBE_3.OBJ');
  assert.equal(new Set(r.map(e => e.path.toLowerCase())).size, 3);
  assert.deepEqual(r.map(e => e.data), [1, 2, 3]);
});

await test('uniqueEntryPaths: suffix avoids colliding with an existing _2 entry', () => {
  const r = uniqueEntryPaths([
    { path: 'a.png', data: 1 }, { path: 'a_2.png', data: 2 }, { path: 'a.png', data: 3 },
  ]);
  assert.deepEqual(r.map(e => e.path), ['a.png', 'a_2.png', 'a_3.png']);
});

await test('uniqueEntryPaths: handles no extension and dotted directories', () => {
  const r = uniqueEntryPaths([
    { path: 'dir.v1/readme', data: 1 }, { path: 'dir.v1/README', data: 2 },
    { path: 'tex/a.png', data: 3 }, { path: 'tex/A.PNG', data: 4 },
  ]);
  assert.equal(r[1].path, 'dir.v1/README_2');   // dot in the dir is not an extension
  assert.equal(r[3].path, 'tex/A_2.PNG');
});

await test('uniqueEntryPaths: does not mutate input entries', () => {
  const entries = [{ path: 'x.txt', data: 'a' }, { path: 'X.txt', data: 'b' }];
  uniqueEntryPaths(entries);
  assert.equal(entries[1].path, 'X.txt');
  assert.equal(uniqueEntryPaths([]).length, 0);
});

await test('single-blob: passes Blob through, reports 0.98 only, uses filename ext', async () => {
  const rec = installPicker();
  const blob = new Blob(['solid'], { type: 'model/stl' });
  const prog = progressLog();
  const ok = await packageAndDownload({ kind: 'blob', data: blob, mime: 'model/stl', filename: 'Part.STL' }, 'STL', prog);
  assert.equal(ok, true);
  assert.ok(rec.written === blob, 'Blob must be written untouched');
  assert.equal(rec.opts.suggestedName, 'Part.STL');
  assert.deepEqual(Object.values(rec.opts.types[0].accept)[0], ['.stl']);
  assert.equal(rec.opts.types[0].description, 'STL file');
  assert.deepEqual(prog.log.map(x => x[0]), [0.98]);
});

await test('single-blob: wraps raw data in a Blob with mime (default octet-stream)', async () => {
  const rec = installPicker();
  await packageAndDownload({ kind: 'blob', data: 'abc', mime: 'text/plain', filename: 'a.txt' }, 'TXT', progressLog());
  assert.ok(rec.written instanceof Blob);
  assert.equal(rec.written.type, 'text/plain');
  await packageAndDownload({ kind: 'blob', data: new Uint8Array([1, 2]), filename: 'b.bin' }, 'BIN', progressLog());
  assert.equal(rec.written.type, 'application/octet-stream');
  assert.equal(rec.written.size, 2);
});

await test('zip: builds archive with uniquified entries, progress 0.9 then 0.98', async () => {
  const rec = installPicker();
  instances.length = 0;
  const prog = progressLog();
  const ok = await packageAndDownload({
    kind: 'zip', mime: 'application/zip', filename: 'bundle.zip',
    entries: [{ path: 'Cube.obj', data: 'a' }, { path: 'cube.obj', data: 'b' }, { path: 'tex.png', data: 'c' }],
  }, 'OBJ', prog);
  assert.equal(ok, true);
  assert.equal(instances.length, 1);
  assert.deepEqual(Object.keys(instances[0].files), ['Cube.obj', 'cube_2.obj', 'tex.png']);
  assert.equal(instances[0].files['cube_2.obj'], 'b');
  assert.deepEqual(prog.log.map(x => x[0]), [0.9, 0.98]);
  assert.equal(prog.log[0][1], 'Packaging…');
  assert.equal(prog.log[1][1], 'Downloading…');
  assert.equal(rec.opts.suggestedName, 'bundle.zip');
  assert.deepEqual(rec.written.names, ['Cube.obj', 'cube_2.obj', 'tex.png']);
});

await test('returns false when the user cancels the save picker', async () => {
  installPicker({ cancel: true });
  const ok = await packageAndDownload({ kind: 'blob', data: 'x', filename: 'a.ply' }, 'PLY', progressLog());
  assert.equal(ok, false);
});

await test('no picker: falls back to an anchor download with the filename', async () => {
  delete window.showSaveFilePicker;
  resetCalls();
  const ok = await packageAndDownload({ kind: 'blob', data: 'x', mime: 'model/vrml', filename: 'scene.wrl' }, 'WRL', progressLog());
  assert.equal(ok, true);
  assert.deepEqual(calls.downloads, ['scene.wrl']);
});

console.log('\n' + out.join('\n'));
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
