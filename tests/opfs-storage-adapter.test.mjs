// OPFS StorageAdapter tier (task 8.2) — behaviour the shared conformance suite
// (storage-adapter.test.mjs, `[opfs]`) does not cover: tier selection, the
// in-app project list, collision naming, the import-into-OPFS open fallback,
// share-sheet vs download, embedded-only links and the older-WebKit write path.
//   node --import ./tests/register-hooks.mjs tests/opfs-storage-adapter.test.mjs

import assert from 'node:assert/strict';
import { __reset as resetIdb } from './idb-stub.mjs';
import { createOpfsRoot, installOpfsEnv, makeMemFs } from './opfs-stub.mjs';
import {
  OpfsStorageAdapter as A, OPFS_PROJECTS_DIR, sanitizeProjectName, isTouchApple, setOpfsWriteTimeout, opfsWriteTimeoutFor,
} from '../src/core/storage/OpfsStorageAdapter.js';
import {
  detectStorageTier, detectCapabilities, storageTier, WEB_TRIANGLE_BUDGET, WEB_TRIANGLE_LIMIT, WEB_BOOLEAN_TRIANGLE_CAP,
} from '../src/core/storage/capabilities.js';
import { storage, ADAPTERS, BrowserStorageAdapter } from '../src/core/storage/StorageAdapter.js';
import { DesktopStorageAdapter } from '../src/core/storage/DesktopStorageAdapter.js';

console.warn = () => {};
let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`# PASS  ${name}`); passed++; }
  catch (err) { console.log(`# FAIL  ${name}\n      ${err.stack || err.message}`); failed++; }
}

const IPAD_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148';
const text = async blob => new TextDecoder().decode(new Uint8Array(await blob.arrayBuffer()));
const PROJ = `opfs/${OPFS_PROJECTS_DIR}`;

/** Fresh OPFS + env per test. */
async function withOpfs(opts, fn) {
  if (typeof opts === 'function') { fn = opts; opts = {}; }
  resetIdb();
  const fs = makeMemFs();
  const { root } = createOpfsRoot(fs, 'opfs', { withCreateWritable: opts.withCreateWritable !== false });
  const env = installOpfsEnv({ root, ...opts.env });
  try { await fn({ fs, env, root }); }
  finally { A.setSaveNamePrompt(null); env.restore(); resetIdb(); }
}

// ── Tier selection (UA → tier) ──

await test('tier: Electron → desktop; FSA → browser; OPFS without FSA → opfs; neither → browser (gate blocks)', () => {
  assert.equal(detectStorageTier({ desktop: true, hasFSA: true, hasOPFS: true }), 'desktop');
  assert.equal(detectStorageTier({ hasFSA: true, hasOPFS: true }), 'browser', 'Chrome / Edge desktop keep FSA');
  assert.equal(detectStorageTier({ hasFSA: false, hasOPFS: true }), 'opfs', 'Safari / iPadOS / iOS (WebKit)');
  assert.equal(detectStorageTier({ hasFSA: false, hasOPFS: false }), 'browser');
  assert.equal(detectStorageTier({}), 'browser');
});

await test('tier: opfs caps = no mount / relink / watch, in-place writes, IDB-backed persistence', () => {
  assert.deepEqual(detectCapabilities({ hasFSA: false, hasOPFS: true, hasIDB: true }), {
    persistAssets: true, mountDirectory: false, relinkByPath: false, watchFiles: false, writeFiles: true, publish: false,
    triangleBudget: WEB_TRIANGLE_BUDGET, triangleLimit: WEB_TRIANGLE_LIMIT, booleanTriangleCap: WEB_BOOLEAN_TRIANGLE_CAP,
  });
  assert.equal(detectCapabilities({ hasOPFS: true, hasIDB: false }).persistAssets, false);
  // FSA present wins: OPFS does not downgrade Chrome.
  assert.equal(detectCapabilities({ hasFSA: true, hasOPFS: true, hasIDB: true }).mountDirectory, true);
});

await test('tier: ADAPTERS map each tier to its impl; headless Node (no OPFS, no FSA) stays browser', () => {
  assert.equal(ADAPTERS.opfs, A);
  assert.equal(ADAPTERS.desktop, DesktopStorageAdapter);
  assert.equal(ADAPTERS.browser, BrowserStorageAdapter);
  assert.equal(storageTier, 'browser');
  assert.equal(storage, BrowserStorageAdapter);
  assert.equal(A.kind, 'opfs');
  for (const m of ['ready', 'kvSet', 'kvGet', 'kvDelete', 'kvKeys', 'mountDirectory', 'listDirectory', 'readFile',
    'resolveAsset', 'persistRef', 'restoreRef', 'deleteRef', 'findMoved', 'hasRef', 'pickOpenProject',
    'pickSaveProject', 'writeFile', 'pickImportAssets', 'saveExport', 'refForDrop',
    'listProjects', 'importProjectFile', 'deleteProject', 'setSaveNamePrompt']) {
    assert.equal(typeof A[m], 'function', m);
    if (BrowserStorageAdapter[m] === undefined) assert.ok(['listProjects', 'importProjectFile', 'deleteProject', 'setSaveNamePrompt'].includes(m), m);
  }
});

await test('isTouchApple: iPhone UA, iPadOS desktop UA with touch → true; Mac Safari → false', () => {
  assert.equal(isTouchApple({ userAgent: IPHONE_UA, platform: 'iPhone', maxTouchPoints: 5 }), true);
  assert.equal(isTouchApple({ userAgent: IPAD_UA, platform: 'MacIntel', maxTouchPoints: 5 }), true);
  assert.equal(isTouchApple({ userAgent: IPAD_UA, platform: 'MacIntel', maxTouchPoints: 0 }), false);
  assert.equal(isTouchApple(undefined), false);
});

// ── Boot gate ──

await test('ready(): no OPFS → "Browser not supported"; OPFS refused → "Storage unavailable"; ok → Projects/ + persist()', async () => {
  const prev = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  try {
    Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true, writable: true });
    await assert.rejects(A.ready(), e => e.storageUnavailable && e.title === 'Browser not supported');
  } finally { Object.defineProperty(globalThis, 'navigator', prev); }
  await withOpfs({}, async () => {
    const env = installOpfsEnv({ root: null });   // getDirectory rejects (private mode)
    try { await assert.rejects(A.ready(), e => e.storageUnavailable && e.title === 'Storage unavailable'); }
    finally { env.restore(); }
  });
  await withOpfs(async ({ fs, env }) => {
    await A.ready();
    assert.equal(fs.get(PROJ)?.kind, 'dir');
    assert.equal(env.rec.persistCalls, 1, 'asks for persistent storage (OPFS is the only copy)');
  });
});

// ── Save: in-app name, collisions ──

await test('pickSaveProject: no OS dialog; suggested name used; collisions get " (n)"; the name is reserved', async () => {
  await withOpfs(async ({ fs }) => {
    const first = await A.pickSaveProject('Robot.mixo');
    assert.equal(first.name, 'Robot.mixo');
    assert.equal(fs.get(`${PROJ}/Robot.mixo`)?.kind, 'file', 'reserved before the write');
    const second = await A.pickSaveProject('Robot.mixo');
    assert.equal(second.name, 'Robot (2).mixo', 'reservation blocks a second save from taking the name');
    await A.writeFile(first.ref, 'a');
    assert.equal((await A.pickSaveProject('Robot')).name, 'Robot (3).mixo', 'extension added; suffix continues');
    assert.equal((await A.pickSaveProject('Robot (2).mixo')).name, 'Robot (4).mixo', 'suffix not stacked');
  });
});

await test('sanitizeProjectName strips folders / reserved chars; empty → Untitled', () => {
  assert.equal(sanitizeProjectName('../../etc/passwd'), 'passwd.mixo');
  assert.equal(sanitizeProjectName('a:b*c?"<>|.MIXO'), 'abc.mixo');
  assert.equal(sanitizeProjectName('  '), 'Untitled.mixo');
  assert.equal(sanitizeProjectName('...'), 'Untitled.mixo');
  assert.equal(sanitizeProjectName('Part.v2'), 'Part.v2.mixo');
});

await test('save-name prompt: null cancels, string renames, {overwrite:true} replaces in place', async () => {
  await withOpfs(async ({ fs }) => {
    const seen = [];
    A.setSaveNamePrompt(async s => { seen.push(s); return null; });
    assert.equal(await A.pickSaveProject('Robot.mixo'), null);
    assert.deepEqual(seen, ['Robot.mixo']);
    assert.equal(fs.get(`${PROJ}/Robot.mixo`), undefined, 'cancel reserves nothing');
    A.setSaveNamePrompt(() => 'Arm');
    const arm = await A.pickSaveProject('Robot.mixo');
    assert.equal(arm.name, 'Arm.mixo');
    await A.writeFile(arm.ref, 'v1');
    A.setSaveNamePrompt(() => ({ name: 'Arm.mixo', overwrite: true }));
    const again = await A.pickSaveProject('x');
    assert.equal(again.name, 'Arm.mixo');
    await A.writeFile(again.ref, 'v2');
    assert.equal(await text(await A.readFile(arm.ref)), 'v2');
    A.setSaveNamePrompt(() => '   ');
    assert.equal(await A.pickSaveProject('x'), null, 'blank answer = cancel');
  });
});

// ── Project list / open / delete ──

await test('listProjects: .mixo only, newest first, empty reservations hidden', async () => {
  await withOpfs(async ({ fs }) => {
    assert.deepEqual(await A.listProjects(), []);
    for (const n of ['Old', 'New']) {
      const { ref } = await A.pickSaveProject(n);
      await A.writeFile(ref, `{"n":"${n}"}`);
    }
    await A.pickSaveProject('Pending');   // reserved, never written
    fs.write(`${PROJ}/notes.txt`, [1]);
    fs.mkdir(`${PROJ}/sub.mixo`);
    const list = await A.listProjects();
    assert.deepEqual(list.map(p => p.name), ['New.mixo', 'Old.mixo']);
    assert.ok(list[0].lastModified > list[1].lastModified);
    assert.equal(list[0].size, '{"n":"New"}'.length);
    const opened = await A.pickOpenProject({ ref: list[1].ref });
    assert.equal(opened.name, 'Old.mixo');
    assert.equal(await text(opened.file), '{"n":"Old"}');
    const byName = await A.pickOpenProject({ name: 'New' });
    assert.equal(await text(byName.file), '{"n":"New"}');
    assert.equal(await A.pickOpenProject({ name: 'Missing' }), null);
    assert.equal(await A.deleteProject('Old.mixo'), true);
    assert.deepEqual((await A.listProjects()).map(p => p.name), ['New.mixo']);
    assert.equal(await A.deleteProject('Old.mixo'), false);
  });
});

await test('pickOpenProject() fallback: <input accept=.mixo> → copied into OPFS (collision-safe); cancel → null', async () => {
  await withOpfs(async ({ env }) => {
    env.setAnswer(() => null);
    assert.equal(await A.pickOpenProject(), null);
    const { ref } = await A.pickSaveProject('Shared');
    await A.writeFile(ref, 'local');
    env.setAnswer(() => [new File(['{"from":"files-app"}'], 'Shared.mixo')]);
    const picked = await A.pickOpenProject();
    assert.equal(picked.name, 'Shared (2).mixo', 'never overwrites the local project');
    assert.equal(await text(picked.file), '{"from":"files-app"}');
    assert.equal(await text(await A.readFile(ref)), 'local');
    const input = env.rec.inputs.at(-1);
    assert.equal(input.type, 'file');
    assert.match(input.accept, /\.mixo/);
    assert.equal(input.multiple, false);
    assert.equal(input.connected, true, 'WebKit needs the input in the document');
    // The returned ref is a writable OPFS project (Ctrl+S after open).
    await A.writeFile(picked.ref, 'edited');
    assert.equal(await text(await A.readFile(picked.ref)), 'edited');
    assert.ok((await A.listProjects()).some(p => p.name === 'Shared (2).mixo'));
  });
});

// ── Import / drop / refs ──

await test('pickImportAssets: <input multiple> Files as read-only refs; persistRef/writeFile refuse them', async () => {
  await withOpfs(async ({ env }) => {
    env.setAnswer(() => [new File([Uint8Array.from([1, 2])], 'a.glb'), new File(['x'], 'b.stl')]);
    const picked = await A.pickImportAssets({ multiple: true });
    assert.deepEqual(picked.map(p => p.name), ['a.glb', 'b.stl']);
    assert.equal(env.rec.inputs.at(-1).multiple, true);
    assert.equal(env.rec.inputs.at(-1).accept, '');
    assert.deepEqual([...new Uint8Array(await (await A.readFile(picked[0].ref)).arrayBuffer())], [1, 2]);
    await assert.rejects(A.persistRef(picked[0].ref), TypeError);
    await assert.rejects(A.writeFile(picked[0].ref, 'x'), /read-only/);
    await A.pickImportAssets({ multiple: false });
    assert.equal(env.rec.inputs.at(-1).multiple, false);
    env.setAnswer(() => null);
    assert.deepEqual(await A.pickImportAssets(), []);
  });
});

await test('no live links: refForDrop → null (sync promise), mountDirectory throws, any source → embedded', async () => {
  await withOpfs(async () => {
    const p = A.refForDrop({ kind: 'file', getAsFile: () => new File(['x'], 'x.glb') });
    assert.ok(p instanceof Promise);
    assert.equal(await p, null);
    await assert.rejects(A.mountDirectory(), /unavailable/);
    const r = await A.resolveAsset({ kind: 'folder', refKey: 'dir_00000000000000000000000000000001', path: 'a.glb' }, { contentHash: 'ff' });
    assert.deepEqual(r, { status: 'embedded', blob: null });
  });
});

await test('recent-project ref: path-derived stable key, restore re-walks OPFS, gone → null', async () => {
  await withOpfs(async ({ fs }) => {
    const { ref } = await A.pickSaveProject('Recent');
    await A.writeFile(ref, 'r1');
    const key = await A.persistRef(ref);
    assert.match(key, /^file_[0-9a-f]{32}$/);
    assert.equal(await A.persistRef(ref), key, 'same file → same key (rewrites do not change it)');
    assert.equal(await A.hasRef(key), true);
    assert.equal(await text(await A.readFile(await A.restoreRef(key))), 'r1');
    fs.remove(`${PROJ}/Recent.mixo`);
    assert.equal(await A.restoreRef(key), null);
    assert.equal(await A.hasRef(key), true, 'hasRef = record stored (no walk), like the browser tier');
    await A.deleteRef(key);
    assert.equal(await A.hasRef(key), false);
    assert.equal(await A.restoreRef('file_ffffffffffffffffffffffffffffffff'), null);
  });
});

// ── Export: share sheet vs download ──

const shareOk = (calls = []) => ({ canShare: d => !!d?.files?.length, share: async d => { calls.push(d); } });

await test('saveExport on iPad/iPhone with canShare(files) → share sheet (File named as suggested)', async () => {
  for (const env of [
    { userAgent: IPAD_UA, platform: 'MacIntel', maxTouchPoints: 5 },
    { userAgent: IPHONE_UA, platform: 'iPhone', maxTouchPoints: 5 },
  ]) {
    await withOpfs({ env: { ...env, share: shareOk() } }, async ({ env: e }) => {
      assert.equal(await A.saveExport(new Blob(['stl']), 'part.stl', { ext: 'stl' }), true);
      assert.equal(e.rec.shares.length, 1);
      assert.equal(e.rec.downloads.length, 0);
      const f = e.rec.shares[0].files[0];
      assert.equal(f.name, 'part.stl');
      assert.equal(await text(f), 'stl');
    });
  }
});

await test('saveExport downloads on Mac Safari, when canShare refuses, with share:false or forceDownload', async () => {
  await withOpfs({ env: { share: shareOk() } }, async ({ env }) => {   // Mac Safari (no touch)
    assert.equal(await A.saveExport(new Blob(['x']), 'a.obj'), true);
    assert.deepEqual(env.rec.downloads.map(d => d.name), ['a.obj']);
    assert.equal(env.rec.shares.length, 0);
    assert.equal(await A.saveExport(new Blob(['x']), 'b.obj', { share: true }), true, 'share:true forces the sheet');
    assert.equal(env.rec.shares.length, 1);
  });
  await withOpfs({ env: { userAgent: IPHONE_UA, share: { canShare: () => false, share: async () => {} } } }, async ({ env }) => {
    await A.saveExport(new Blob(['x']), 'c.3mf');
    assert.deepEqual(env.rec.downloads.map(d => d.name), ['c.3mf']);
  });
  await withOpfs({ env: { userAgent: IPHONE_UA, share: shareOk() } }, async ({ env }) => {
    await A.saveExport(new Blob(['x']), 'd.zip', { share: false });
    await A.saveExport(new Blob(['x']), 'e.zip', { forceDownload: true });
    assert.deepEqual(env.rec.downloads.map(d => d.name), ['d.zip', 'e.zip']);
    assert.equal(env.rec.shares.length, 0);
  });
  await withOpfs({ env: { userAgent: IPHONE_UA } }, async ({ env }) => {   // no Web Share at all
    await A.saveExport(new Blob(['x']), 'f.stl');
    assert.deepEqual(env.rec.downloads.map(d => d.name), ['f.stl']);
  });
});

await test('saveExport: share sheet dismissed → false (cancel); share refused → falls back to download', async () => {
  const thrower = name => ({ canShare: () => true, share: async () => { throw Object.assign(new Error(name), { name }); } });
  await withOpfs({ env: { userAgent: IPHONE_UA, share: thrower('AbortError') } }, async ({ env }) => {
    assert.equal(await A.saveExport(new Blob(['x']), 'a.stl'), false);
    assert.equal(env.rec.downloads.length, 0);
  });
  await withOpfs({ env: { userAgent: IPHONE_UA, share: thrower('NotAllowedError') } }, async ({ env }) => {
    assert.equal(await A.saveExport(new Blob(['x']), 'a.stl'), true);
    assert.deepEqual(env.rec.downloads.map(d => d.name), ['a.stl']);
  });
});

await test('OPFS write timeout grows with the file (truncate-then-write must not be cut off)', () => {
  assert.equal(opfsWriteTimeoutFor(0), 60_000);
  assert.equal(opfsWriteTimeoutFor(500 * 1024 * 1024), 60_000 + 500_000, '+1 s per MB');
});

// ── Older WebKit: no main-thread createWritable ──

await test('writeFile without createWritable → OPFS write worker gets the file\'s OPFS path + a copy of the bytes', async () => {
  await withOpfs({ withCreateWritable: false }, async ({ fs }) => {
    const posted = [];
    const prevWorker = globalThis.Worker;
    globalThis.Worker = class {
      constructor(url, opts) { this.url = String(url); this.opts = opts; }
      postMessage(msg, transfer) {
        posted.push({ url: this.url, opts: this.opts, msg: msg.payload, transfer });
        fs.write(`opfs/${msg.payload.path.join('/')}`, [...msg.payload.bytes]);
        queueMicrotask(() => this.onmessage({ data: { id: msg.id, type: 'done', result: true } }));
      }
      terminate() { this.terminated = true; }
    };
    try {
      const { ref } = await A.pickSaveProject('Old');
      const src = new TextEncoder().encode('{"v":1}');
      await A.writeFile(ref, src);
      assert.equal(posted.length, 1);
      assert.match(posted[0].url, /OpfsWrite\.worker\.js$/);
      assert.equal(posted[0].opts.type, 'module');
      assert.deepEqual(posted[0].msg.path, [OPFS_PROJECTS_DIR, 'Old.mixo']);
      assert.notEqual(posted[0].msg.bytes.buffer, src.buffer, 'caller buffer is not transferred away');
      assert.equal(src.byteLength, 7);
      assert.equal(await text(await A.readFile(ref)), '{"v":1}');
      globalThis.Worker = class { postMessage(msg) { queueMicrotask(() => this.onmessage({ data: { id: msg.id, type: 'error', message: 'quota' } })); } terminate() {} };
      await assert.rejects(A.writeFile(ref, 'x'), /quota/);
      // A worker that never answers no longer hangs the save (it used to).
      const prevTimeout = setOpfsWriteTimeout(20);
      let killed = false;
      globalThis.Worker = class { postMessage() {} terminate() { killed = true; } };
      try {
        await assert.rejects(A.writeFile(ref, 'x'), /timed out/);
        assert.equal(killed, true, 'hung write worker terminated');
      } finally { setOpfsWriteTimeout(prevTimeout); }
    } finally { globalThis.Worker = prevWorker; }
  });
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
