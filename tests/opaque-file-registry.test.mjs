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

// ── Task 4.2: persisted stable keys, restart survival, re-validation ─────────

const { createMemoryStore } = require('../electron/OpaqueFileRegistry.cjs');
const { createHash } = await import('node:crypto');

/** Tiny in-memory win32-ish fs: path → {kind, bytes?}. */
function memFs() {
  const nodes = new Map();
  const unreadable = new Set();
  const key = p => String(p).replace(/\//g, '\\').replace(/\\+$/, '');
  const enoent = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  const put = (p, node) => nodes.set(key(p), node);
  return {
    nodes, unreadable,
    dir: p => put(p, { kind: 'directory' }),
    file: (p, bytes) => put(p, { kind: 'file', bytes: Buffer.from(bytes) }),
    link: p => put(p, { kind: 'symlink' }),
    remove: p => nodes.delete(key(p)),
    deps: {
      platform: 'win32',
      readdir: async p => {
        const k = key(p);
        if (nodes.get(k)?.kind !== 'directory') throw enoent();
        return [...nodes.keys()]
          .filter(c => c.startsWith(`${k}\\`) && !c.slice(k.length + 1).includes('\\'))
          .map(c => ({
            name: c.slice(k.length + 1),
            isFile: () => nodes.get(c).kind === 'file',
            isDirectory: () => nodes.get(c).kind === 'directory',
            isSymbolicLink: () => nodes.get(c).kind === 'symlink',
          }));
      },
      readFile: async p => { const n = nodes.get(key(p)); if (n?.kind !== 'file') throw enoent(); return n.bytes; },
      stat: async p => {
        const n = nodes.get(key(p));
        if (!n) throw enoent();
        return { isDirectory: () => n.kind === 'directory', isFile: () => n.kind === 'file' };
      },
      access: async p => { if (unreadable.has(key(p))) throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); },
    },
  };
}

const KEY_RE = /^(dir|file)_[0-9a-f]{32}$/;
let cases = 0;
async function check(name, fn) {
  try { await fn(); cases++; } catch (err) { err.message = `${name}: ${err.message}`; throw err; }
}

await check('persistRef: unknown token throws; key is stable and path-free; survives restart', async () => {
  const fsm = memFs();
  fsm.dir('C:\\private\\Vault');
  fsm.file('C:\\private\\Vault\\a.glb', [1]);
  const store = createMemoryStore();
  const r1 = createOpaqueFileRegistry({ ...fsm.deps, store });
  await assert.rejects(() => r1.persistRef('mount_forged'), /Unknown/);
  await assert.rejects(() => r1.persistRef('C:\\private\\Vault'), /Unknown/);
  const mount = r1.registerMount('C:\\private\\Vault');
  const key = await r1.persistRef(mount.ref);
  assert.match(key, KEY_RE);
  assert.ok(key.startsWith('dir_'));
  assert.equal(key.includes('private'), false);
  // Case-insensitive on win32: the same folder typed differently → same key.
  assert.equal(await r1.persistRef(r1.registerMount('c:\\PRIVATE\\vault').ref), key);
  // Restart: new registry, same persisted store.
  const r2 = createOpaqueFileRegistry({ ...fsm.deps, store });
  const token = await r2.restoreRef(key);
  assert.match(token, /^mount_/);
  assert.equal(token.includes('private'), false);
  assert.deepEqual((await r2.listDirectory(token, '')).map(e => e.name), ['a.glb']);
  assert.equal(await r2.restoreRef(key), token, 'repeat restore reuses the session token (bounded)');
  // The store holds the absolute path — main-process only.
  assert.equal((await store.get(key)).absolutePath, 'C:\\private\\Vault');
});

await check('restoreRef re-validates: missing, wrong kind, unreadable, malformed key → null', async () => {
  const fsm = memFs();
  fsm.dir('C:\\v');
  fsm.file('C:\\v\\f.glb', [1, 2]);
  const store = createMemoryStore();
  const reg = createOpaqueFileRegistry({ ...fsm.deps, store });
  const dirKey = await reg.persistRef(reg.registerMount('C:\\v').ref);
  const fileKey = await reg.persistRef(reg.registerFile('C:\\v\\f.glb').ref);
  assert.ok(fileKey.startsWith('file_'));
  const fresh = () => createOpaqueFileRegistry({ ...fsm.deps, store });
  assert.match(await fresh().restoreRef(fileKey), /^ref_/);
  fsm.unreadable.add('C:\\v\\f.glb');
  assert.equal(await fresh().restoreRef(fileKey), null, 'unreadable file');
  fsm.unreadable.clear();
  fsm.remove('C:\\v\\f.glb');
  fsm.dir('C:\\v\\f.glb');
  assert.equal(await fresh().restoreRef(fileKey), null, 'replaced by a directory');
  fsm.remove('C:\\v');
  assert.equal(await fresh().restoreRef(dirKey), null, 'folder deleted');
  for (const bad of ['', 'dir_xyz', 'C:\\v', '../dir_00', null, 42, { key: dirKey }]) {
    assert.equal(await fresh().restoreRef(bad), null);
  }
  // A tampered store record whose kind disagrees with the key prefix fails closed.
  await store.set('dir_0123456789abcdef0123456789abcdef', { kind: 'file', absolutePath: 'C:\\v\\x', name: 'x' });
  assert.equal(await fresh().restoreRef('dir_0123456789abcdef0123456789abcdef'), null);
  await reg.deleteRef(dirKey);
  assert.equal(await store.get(dirKey), null);
});

await check('readStoredFile: relative reads stay inside the folder; missing → null', async () => {
  const fsm = memFs();
  fsm.dir('C:\\v');
  fsm.dir('C:\\v\\sub');
  fsm.file('C:\\v\\sub\\m.glb', [4, 5]);
  fsm.file('C:\\secret.glb', [6]);
  const reg = createOpaqueFileRegistry({ ...fsm.deps, store: createMemoryStore() });
  const key = await reg.persistRef(reg.registerMount('C:\\v').ref);
  const hit = await reg.readStoredFile(key, 'sub/m.glb');
  assert.equal(hit.name, 'm.glb');
  assert.deepEqual([...new Uint8Array(hit.bytes)], [4, 5]);
  assert.equal(JSON.stringify(hit).includes('C:'), false);
  assert.equal(await reg.readStoredFile(key, 'sub/gone.glb'), null);
  for (const bad of ['../secret.glb', 'sub\\..\\..\\secret.glb', 'C:\\secret.glb', '\\secret.glb', '', '.']) {
    await assert.rejects(() => reg.readStoredFile(key, bad), /Invalid relative path/, bad);
  }
  assert.equal(await reg.readStoredFile('dir_ffffffffffffffffffffffffffffffff', 'sub/m.glb'), null);
  const fileKey = await reg.persistRef(reg.registerFile('C:\\v\\sub\\m.glb').ref);
  assert.deepEqual([...new Uint8Array((await reg.readStoredFile(fileKey, null)).bytes)], [4, 5]);
  await assert.rejects(() => reg.readStoredFile(fileKey, 'other.glb'), /Invalid relative path/);
});

await check('findMoved: hash walk with progress, ext filter, symlinks skipped, limit, input validation', async () => {
  const fsm = memFs();
  fsm.dir('C:\\v');
  fsm.dir('C:\\v\\a');
  fsm.file('C:\\v\\a\\decoy.glb', [0]);
  fsm.file('C:\\v\\a\\same.stl', [7, 7]);
  fsm.link('C:\\v\\loop');
  fsm.dir('C:\\v\\b');
  fsm.file('C:\\v\\b\\moved.glb', [7, 7]);
  const reg = createOpaqueFileRegistry({ ...fsm.deps, store: createMemoryStore() });
  const key = await reg.persistRef(reg.registerMount('C:\\v').ref);
  const contentHash = createHash('sha256').update(Buffer.from([7, 7])).digest('hex');
  const seenProgress = [];
  const hit = await reg.findMoved({ refKey: key, contentHash, ext: '.glb' }, p => seenProgress.push(p.scanned));
  assert.equal(hit.path, 'b/moved.glb');
  assert.equal(hit.scanned, 2);
  assert.deepEqual(seenProgress, [1, 2]);
  assert.deepEqual([...new Uint8Array(hit.bytes)], [7, 7]);
  assert.equal(JSON.stringify({ ...hit, bytes: null }).includes('C:'), false);
  assert.equal((await reg.findMoved({ refKey: key, contentHash, ext: '.glb', limit: 1 })).path, null);
  assert.equal((await reg.findMoved({ refKey: 'dir_ffffffffffffffffffffffffffffffff', contentHash })).path, null);
  await assert.rejects(() => reg.findMoved({ refKey: key, contentHash: 'nothex' }), /Invalid content hash/);
});

await check('listing / mounting / restoring the same folder twice yields the SAME tokens (registry does not grow)', async () => {
  const fsm = memFs();
  fsm.dir('C:\\v');
  fsm.dir('C:\\v\\sub');
  fsm.file('C:\\v\\a.glb', [1]);
  const store = createMemoryStore();
  const reg = createOpaqueFileRegistry({ ...fsm.deps, store });
  const m1 = reg.registerMount('C:\\v');
  assert.equal(reg.registerMount('c:\\V').ref, m1.ref, 'same folder (case-insensitive) → same mount token');
  const first = await reg.listDirectory(m1.ref, '');
  const second = await reg.listDirectory(m1.ref, '');
  assert.deepEqual(second.map(e => e.ref), first.map(e => e.ref), 'relisting reuses every child token');
  const key = await reg.persistRef(m1.ref);
  assert.equal(await reg.restoreRef(key), m1.ref, 'restore reuses the live mount token');
  assert.equal(await reg.restoreRef(key), m1.ref);
  const sub = first.find(e => e.kind === 'directory');
  assert.deepEqual((await reg.listDirectory(sub.ref, 'sub')).map(e => e.ref), [], 'empty child folder lists cleanly');
});

// ── Task 6.2: dialog descriptors + write rules ──────────────────────────────

const {
  sanitizeSuggestedName, exportDialogOptions, withExtension, EXPORT_EXTENSIONS, MAX_WRITE_BYTES,
} = require('../electron/OpaqueFileRegistry.cjs');

await check('suggestedName: folders, drives, reserved/control chars and device names never reach the dialog', async () => {
  assert.equal(sanitizeSuggestedName('Robot.mixo', 'F'), 'Robot.mixo');
  assert.equal(sanitizeSuggestedName('C:\\Users\\me\\..\\evil.mixo', 'F'), 'evil.mixo');
  assert.equal(sanitizeSuggestedName('../../etc/passwd', 'F'), 'passwd');
  assert.equal(sanitizeSuggestedName('\\\\server\\share\\x.zip', 'F'), 'x.zip');
  assert.equal(sanitizeSuggestedName('C:evil.mixo', 'F'), 'evil.mixo');
  assert.equal(sanitizeSuggestedName('a<b>c:d"e|f?g*h.stl', 'F'), 'abcdefgh.stl');
  assert.equal(sanitizeSuggestedName('tab\there\u0000.obj', 'F'), 'tabhere.obj');
  assert.equal(sanitizeSuggestedName('  ..hidden.  ', 'F'), 'hidden');
  for (const bad of ['', '   ', '..', '/', 'C:\\', 'CON', 'con.mixo', 'LPT1.zip', 'nul', null, undefined, 42, {}]) {
    assert.equal(sanitizeSuggestedName(bad, 'F'), 'F', String(bad));
  }
  assert.equal(sanitizeSuggestedName('x'.repeat(5000), 'F').length, 200);
});

await check('export descriptor: only whitelisted extensions; description is plain capped text', async () => {
  for (const ext of EXPORT_EXTENSIONS) {
    const o = exportDialogOptions({ suggestedName: `part.${ext}`, ext, description: 'Model' });
    assert.equal(o.ext, ext);
    assert.equal(o.defaultName, `part.${ext}`);
    assert.deepEqual(o.filters, [{ name: 'Model', extensions: [ext] }]);
  }
  const norm = exportDialogOptions({ suggestedName: 'C:\\secret\\Robot', ext: '.3MF', description: 'Bad\nLabel' + 'x'.repeat(200) });
  assert.equal(norm.ext, '3mf');
  assert.equal(norm.defaultName, 'Robot.3mf', 'folder stripped, extension appended');
  assert.equal(norm.filters[0].name.includes('\n'), false);
  assert.equal(norm.filters[0].name.length, 80);
  assert.equal(exportDialogOptions({ ext: 'stl' }).defaultName, 'export.stl');
  assert.equal(exportDialogOptions({ ext: 'png', description: '' }).filters[0].name, 'PNG file');
  for (const bad of ['exe', 'bat', 'lnk', 'js', 'html', 'mixo', 'stl;exe', '', '*', null, undefined]) {
    assert.throws(() => exportDialogOptions({ suggestedName: 'x', ext: bad }), /not allowed/, String(bad));
  }
  assert.throws(() => exportDialogOptions(null), /not allowed/);
  assert.equal(withExtension('a.MIXO', 'mixo'), 'a.MIXO');
  assert.equal(withExtension('a.zip', 'mixo'), 'a.zip.mixo');
  assert.equal(MAX_WRITE_BYTES, 1024 * 1024 * 1024, '1 GiB cap');
});

/** Write-capturing fs: every temp write + rename lands in `disk`. */
function writeFs() {
  const fsm = memFs();
  const disk = new Map();
  const temps = new Map();
  const deps = {
    ...fsm.deps,
    writeFile: async (p, bytes) => { temps.set(p, Buffer.from(bytes)); },
    rename: async (from, to) => { disk.set(to, temps.get(from)); temps.delete(from); },
    unlink: async p => { temps.delete(p); },
  };
  return { fsm, disk, temps, deps };
}

await check('writes: only project-dialog tokens are writable; import/mount/drop tokens stay read-only', async () => {
  const { fsm, disk, deps } = writeFs();
  fsm.dir('C:\\p');
  fsm.file('C:\\p\\scene.mixo', [1]);
  const reg = createOpaqueFileRegistry({ ...deps, store: createMemoryStore() });
  // Imported / dropped first (read-only)…
  const imported = reg.registerFile('C:\\p\\scene.mixo');
  await assert.rejects(() => reg.writeFile(imported.ref, 'x'), /read-only/);
  // …then the user picks the SAME path in the project save dialog.
  const saved = reg.registerFile('C:\\p\\scene.mixo', 'scene.mixo', { writable: true });
  assert.notEqual(saved.ref, imported.ref, 'a dialog grant mints its own token');
  await assert.rejects(() => reg.writeFile(imported.ref, 'x'), /read-only/, 'the earlier read-only token is NOT upgraded');
  assert.equal(await reg.writeFile(saved.ref, 'hello'), true);
  assert.equal(disk.get('C:\\p\\scene.mixo').toString(), 'hello', 'atomic temp + rename onto the target');
  assert.equal(reg.registerFile('c:\\P\\scene.mixo', 'scene.mixo', { writable: true }).ref, saved.ref,
    'repeat grant reuses the writable token');
  // Mount-listing tokens are read-only.
  const mount = reg.registerMount('C:\\p');
  const [child] = await reg.listDirectory(mount.ref, '');
  await assert.rejects(() => reg.writeFile(child.ref, 'x'), /read-only/);
  // Unknown / forged / directory tokens.
  for (const bad of ['ref_forged', 'C:\\p\\scene.mixo', mount.ref, '', null]) {
    await assert.rejects(() => reg.writeFile(bad, 'x'), /Unknown/, String(bad));
  }
  await assert.rejects(() => reg.writeFile(saved.ref, { not: 'bytes' }), /expects text or bytes/);
  await assert.rejects(() => reg.writeFile(saved.ref, 42), /expects text or bytes/);
});

await check('writes: size cap refuses oversize payloads before touching disk', async () => {
  const { disk, temps, deps } = writeFs();
  const reg = createOpaqueFileRegistry({ ...deps, store: createMemoryStore(), maxWriteBytes: 8 });
  const { ref } = reg.registerFile('C:\\p\\a.mixo', 'a.mixo', { writable: true });
  assert.equal(await reg.writeFile(ref, new Uint8Array(8)), true, 'exactly at the cap is fine');
  await assert.rejects(() => reg.writeFile(ref, new Uint8Array(9)), /too large/);
  await assert.rejects(() => reg.writeFile(ref, 'x'.repeat(9)), /too large/);
  await assert.rejects(() => reg.writeDialogTarget('C:\\p\\e.stl', new ArrayBuffer(9)), /too large/);
  assert.equal(temps.size, 0);
  assert.equal(disk.size, 1);
});

await check('export writes (writeDialogTarget) mint no token and need an absolute main-chosen path', async () => {
  const { fsm, disk, deps } = writeFs();
  fsm.file('C:\\p\\part.stl', [1]);
  const reg = createOpaqueFileRegistry({ ...deps, store: createMemoryStore() });
  const imported = reg.registerFile('C:\\p\\part.stl');
  assert.equal(await reg.writeDialogTarget('C:\\p\\part.stl', new Uint8Array([9])), true);
  assert.deepEqual([...disk.get('C:\\p\\part.stl')], [9]);
  await assert.rejects(() => reg.writeFile(imported.ref, 'x'), /read-only/,
    'exporting over a file does not make its token writable');
  for (const bad of ['part.stl', '..\\x.stl', '', null, 7]) {
    await assert.rejects(() => reg.writeDialogTarget(bad, 'x'), /Invalid save target/, String(bad));
  }
});

await check('recents: the writable grant persists, survives restart, and a read-only persist never strips it', async () => {
  const { fsm, deps } = writeFs();
  fsm.dir('C:\\p');
  fsm.file('C:\\p\\scene.mixo', [1]);
  const store = createMemoryStore();
  const reg = createOpaqueFileRegistry({ ...deps, store });
  const saved = reg.registerFile('C:\\p\\scene.mixo', 'scene.mixo', { writable: true });
  const key = await reg.persistRef(saved.ref);
  assert.equal((await store.get(key)).writable, true);
  // Persisting a read-only token of the same file keeps the earlier grant.
  assert.equal(await reg.persistRef(reg.registerFile('C:\\p\\scene.mixo').ref), key);
  assert.equal((await store.get(key)).writable, true);
  const reg2 = createOpaqueFileRegistry({ ...deps, store });
  const token = await reg2.restoreRef(key);
  assert.match(token, /^ref_/);
  assert.equal(await reg2.writeFile(token, 'again'), true, 'restored project key is writable');
  // A file only ever persisted read-only restores read-only.
  fsm.file('C:\\p\\tex.png', [2]);
  const texKey = await reg.persistRef(reg.registerFile('C:\\p\\tex.png').ref);
  assert.equal((await store.get(texKey)).writable, undefined);
  const texToken = await reg2.restoreRef(texKey);
  await assert.rejects(() => reg2.writeFile(texToken, 'x'), /read-only/);
});

assert.equal(cases, 11);
