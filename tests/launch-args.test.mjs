import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseLaunchArgv, validateLaunchPath, LAUNCH_EXTENSIONS, MAX_LAUNCH_OPENS, MAX_API_IMPORTS, OUTPUT_EXTENSIONS } = require('../electron/LaunchArgs.cjs');
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

// ---- API.3: outputDir / outputFile ----
assert.equal(MAX_API_IMPORTS, MAX_LAUNCH_OPENS);
assert.deepEqual([...OUTPUT_EXTENSIONS].sort(), ['3mf', 'json', 'mtl', 'obj', 'ply', 'png', 'stl', 'wrl', 'zip']);
const ro = new Set(['c:\\work\\ro', 'c:\\work\\locked.stl']);
const fso = {
  ...mkFs(
    { 'c:\\work': D, 'c:\\work\\out': D, 'c:\\work\\ro': D, 'c:\\work\\f.stl': F, 'c:\\work\\locked.stl': F, 'c:\\work\\x.glb': F, 'c:\\work\\d.stl': D, 'c:\\work\\out\\a.3mf': F },
    { 'c:\\work\\ln.stl': 'C:\\work\\x.glb' },
  ),
  access: async (p, mode) => { assert.equal(mode, 2); if (ro.has(p.toLowerCase())) throw new Error('EACCES'); },
};
const O = (raw, kind, o = {}) => validateLaunchPath(raw, { kind, cwd: 'C:\\work', ...fso, ...o });
const orej = async (raw, kind, reason, o) => {
  const r = await O(raw, kind, o);
  assert.equal(r.ok, false, raw);
  assert.equal(r.reason, reason, raw);
  assert.equal(/[\\/]/.test(r.reason + r.name), false, 'leaks directory');
};
assert.deepEqual(await O('out', 'outputDir'), { ok: true, absolutePath: 'C:\\work\\out', name: 'out', ext: '' });
await orej('f.stl', 'outputDir', 'not a directory');
await orej('nope', 'outputDir', 'not found or not accessible');
await orej('ro', 'outputDir', 'not writable');
await orej('out', 'outputDir', 'not writable', { access: undefined });
await orej('\\\\.\\C:\\work\\out', 'outputDir', 'device path syntax not allowed');
await orej('\\\\srv\\s\\o', 'outputDir', 'network (UNC) paths not allowed');
await orej('NUL', 'outputDir', 'reserved device name');
// outputFile
assert.deepEqual(await O('out\\new.stl', 'outputFile'), { ok: true, absolutePath: 'C:\\work\\out\\new.stl', name: 'new.stl', ext: 'stl', exists: false });
const ex = await O('out\\a.3mf', 'outputFile');
assert.deepEqual([ex.ok, ex.exists, ex.absolutePath], [true, true, 'C:\\work\\out\\a.3mf']);
await orej('out\\new.glb', 'outputFile', 'unsupported file type');
await orej('out\\new', 'outputFile', 'unsupported file type');
await orej('nodir\\new.stl', 'outputFile', 'not found or not accessible');
await orej('f.stl\\new.stl', 'outputFile', 'not a directory');
await orej('d.stl', 'outputFile', 'not a regular file');
await orej('ro\\new.stl', 'outputFile', 'not writable');
await orej('locked.stl', 'outputFile', 'not writable');
await orej('ln.stl', 'outputFile', 'unsupported file type'); // symlink target ext is checked
await orej('out\\new.stl:ads', 'outputFile', 'invalid characters in path');
await orej('\\\\.\\C:\\work\\a.stl', 'outputFile', 'device path syntax not allowed');
await orej('con.stl', 'outputFile', 'reserved device name');
await orej('out\\new.stl', 'outputFile', 'not writable', { access: undefined });
