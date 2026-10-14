import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseLaunchArgv, validateLaunchPath, LAUNCH_EXTENSIONS, MAX_LAUNCH_OPENS } = require('../electron/LaunchArgs.cjs');
const { MAX_WRITE_BYTES } = require('../electron/OpaqueFileRegistry.cjs');

const P = (argv, isPackaged = true) => parseLaunchArgv(argv, { isPackaged });

// argv offsets
assert.deepEqual(P(['M.exe', 'a.glb']).opens, ['a.glb']);
assert.deepEqual(P(['electron.exe', 'main.cjs', 'a.glb'], false).opens, ['a.glb']);
assert.deepEqual(P(['electron.exe', 'main.cjs'], false).opens, []);
assert.deepEqual(P(['M.exe']), { opens: [], library: null, ignored: [], truncated: 0 });
// flags and positionals
assert.deepEqual(P(['M.exe', '--open', 'C:\\x\\a.glb', '--open=C:\\x\\b.stl']).opens, ['C:\\x\\a.glb', 'C:\\x\\b.stl']);
assert.equal(P(['M.exe', '--library', 'C:\\l', '--library=C:\\m']).library, 'C:\\m');
assert.deepEqual(P(['M.exe', 'C:\\s p\\scene.MIXO']).opens, ['C:\\s p\\scene.MIXO']);
assert.deepEqual(P(['M.exe', '--open']).opens, []);
// chromium switches and --flag value ambiguity
const sw = P(['M.exe', '--inspect', '--remote-debugging-port=9222', '--no-sandbox', '--user-data-dir=C:\\u', '--flag', 'val.txt', '--other', 'x.glb']);
assert.deepEqual(sw.opens, ['x.glb']);
assert.ok(sw.ignored.includes('--inspect') && sw.ignored.includes('val.txt'));
assert.equal(sw.library, null);
// --
assert.deepEqual(P(['M.exe', '--', '--open', 'a.glb']).opens, ['a.glb']);
assert.deepEqual(P(['M.exe', '--', '--open']).ignored, ['--open']);
// cap
const capped = P(['M.exe', ...Array.from({ length: 40 }, (_, i) => `f${i}.glb`)]);
assert.equal(capped.opens.length, MAX_LAUNCH_OPENS);
assert.equal(capped.truncated, 8);
assert.deepEqual([...LAUNCH_EXTENSIONS], ['mixo', 'glb', 'gltf', '3mf', 'obj', 'stl']);

// validation with injected fs
const mkFs = (files = {}, links = {}) => ({
  realpath: async p => {
    const k = p.toLowerCase();
    if (links[k]) return links[k];
    if (k in files) return p;
    throw new Error('ENOENT');
  },
  stat: async p => {
    const f = files[p.toLowerCase()];
    if (!f) throw new Error('ENOENT');
    return { isFile: () => f.t === 'f', isDirectory: () => f.t === 'd', size: f.size ?? 1 };
  },
});
const F = { t: 'f' };
const D = { t: 'd' };
const fsx = mkFs(
  { 'c:\\work\\a.glb': F, 'c:\\work\\big.glb': { t: 'f', size: 100 }, 'c:\\work\\lib': D, 'c:\\real\\t.obj': F, 'c:\\real\\t.exe': F, 'c:\\work\\sub\\b.stl': F },
  { 'c:\\work\\link.glb': 'C:\\real\\t.obj', 'c:\\work\\evil.glb': 'C:\\real\\t.exe' },
);
const V = (raw, o = {}) => validateLaunchPath(raw, { kind: 'file', cwd: 'C:\\work', ...fsx, ...o });
const rej = async (raw, reason, o) => {
  const r = await V(raw, o);
  assert.equal(r.ok, false, raw);
  assert.equal(r.reason, reason, raw);
  assert.equal(/[\\/]/.test(r.reason + r.name), false, 'leaks directory');
};

assert.deepEqual(await V('a.glb'), { ok: true, absolutePath: 'C:\\work\\a.glb', name: 'a.glb', ext: 'glb' });
assert.equal((await V('sub\\b.stl')).absolutePath, 'C:\\work\\sub\\b.stl');
assert.equal((await V('sub\\..\\a.glb')).ok, true);
assert.equal((await V('C:\\work\\A.GLB')).ext, 'glb');
await rej('\\\\?\\C:\\work\\a.glb', 'device path syntax not allowed');
await rej('\\\\.\\C:\\work\\a.glb', 'device path syntax not allowed');
await rej('\\\\srv\\share\\a.glb', 'network (UNC) paths not allowed');
await rej('C:\\work\\a.glb:stream', 'invalid characters in path');
await rej('a.glb:$DATA', 'invalid characters in path');
await rej('a\u0000.glb', 'invalid characters in path');
await rej('C:a.glb', 'drive-relative path not allowed');
await rej('NUL.glb', 'reserved device name');
await rej('C:\\work\\com1\\a.glb', 'reserved device name');
await rej('a.exe', 'unsupported file type');
await rej('missing.glb', 'not found or not accessible');
await rej('', 'empty path');
await rej('..\\x\\y.glb', 'not found or not accessible');
await rej('lib', 'unsupported file type');
await rej('a.glb', 'file too large', { maxBytes: 0 });
await rej('big.glb', 'file too large', { maxBytes: 50 });
await rej('a.glb', 'no working directory', { cwd: 'rel' });
await rej('a.glb', 'not a directory', { kind: 'directory' });
// symlink: the realpath target is what gets checked
const link = await V('link.glb');
assert.deepEqual([link.ok, link.absolutePath, link.ext, link.name], [true, 'C:\\real\\t.obj', 'obj', 'link.glb']);
await rej('evil.glb', 'unsupported file type');
// directory kind
const lib = await V('lib', { kind: 'directory' });
assert.deepEqual([lib.ok, lib.absolutePath], [true, 'C:\\work\\lib']);
const dirAsFile = await validateLaunchPath('lib.glb', { kind: 'file', cwd: 'C:\\work', ...mkFs({ 'c:\\work\\lib.glb': D }) });
assert.equal(dirAsFile.reason, 'not a regular file');
// default size cap = MAX_WRITE_BYTES
assert.equal(MAX_WRITE_BYTES, 1024 ** 3);
const huge = await validateLaunchPath('h.glb', { kind: 'file', cwd: 'C:\\work', ...mkFs({ 'c:\\work\\h.glb': { t: 'f', size: MAX_WRITE_BYTES + 1 } }) });
assert.equal(huge.reason, 'file too large');
