// PB.6 PublishClient + PB.7 ListingPackageExport. The "main process" is the REAL
// registerListbridgeIpc `publish:start` handler (fake adapter + fake transport), so
// the payload shape is validated by the code that actually consumes it.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installEnv } from './env.mjs';
import * as core from '../src/listbridge/index.js';

installEnv();
const require = createRequire(import.meta.url);
const { registerListbridgeIpc } = require('../electron/listbridge/index.cjs');
const RealJSZip = require('jszip');
const Client = await import('../src/core/publish/PublishClient.js');
const Pkg = await import('../src/core/publish/ListingPackageExport.js');

function fakeAdapter() {
  return {
    describe: () => ({
      id: 'fake', label: 'Fake', transfer: 'direct', maxFiles: 10, maxImages: 10, currencies: ['EUR'], fields: ['title'], credentials: ['user'],
    }),
    validate: () => [],
    authHeaders: () => ({}),
    buildCreate: pkg => ({ method: 'POST', url: 'https://fake.test/g', body: { title: pkg.title } }),
    buildUpdate: (id, pkg) => ({ method: 'POST', url: 'https://fake.test/g', body: { id, title: pkg.title } }),
    parseResult: res => {
      if (res.json?.errors?.length) throw new Error(res.json.errors[0].message);
      return res.json.data;
    },
  };
}

/** A fake electronAPI.listbridge whose start() runs the real IPC handler. */
function setup({ respond = () => ({ json: { data: { remoteId: 'R1', url: 'https://fake.test/c/R1', status: 'published' } } }) } = {}) {
  const handlers = new Map();
  registerListbridgeIpc((ch, fn) => handlers.set(ch, fn), {
    userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'pc-')),
    credentials: { has: async () => true, get: async () => ({ user: 'me' }), set: async () => {}, clear: async () => true },
    adapters: [fakeAdapter()],
    transport: { request: async req => ({ status: 200, ok: true, headers: {}, text: '', ...(await respond(req)) }) },
    loadCore: async () => core,
  });
  const listeners = new Set();
  const sender = { id: 1, isDestroyed: () => false, send: (_c, ev) => listeners.forEach(l => l(ev)) };
  const calls = [];
  const api = {
    start: async req => { calls.push(req); return handlers.get('publish:start')({ sender }, req); },
    retry: async id => ({ retried: id }),
    cancel: async id => ({ cancelled: id }),
    onProgress: cb => { listeners.add(cb); return () => listeners.delete(cb); },
  };
  let state = { project: { id: 'proj-test', listings: [] } };
  const sets = [];
  const deps = {
    caps: { publish: true }, api,
    getState: () => state,
    setState: fn => { state = fn(state); sets.push(state); },
    now: () => '2026-10-14T10:00:00.000Z',
    collectExportFiles: async (formats) => ({
      blocked: false, files: formats.map(f => ({ name: `Dragon.${f}`, mime: 'model/x', bytes: new Uint8Array([1, 2, 3]) })),
    }),
  };
  return { api, deps, calls, listeners, getListings: () => state.project.listings, sets };
}

const png = () => new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' });
const fields = { title: 'Dragon', description: 'desc', tags: ['a'], price: { amount: 4, currency: 'EUR' }, license: null, madeWithAi: false };

async function build(deps, extra = {}) {
  const r = await Client.buildListingPackage({
    listing: fields, exportSelection: { formats: ['stl', '3mf'] }, heroBlob: png(), galleryBlobs: [png()], ...extra,
  }, deps);
  assert.equal(r.blocked, false);
  return r.pkg;
}

test('caps.publish exists only in a desktop shell with the bridge', async () => {
  const { detectCapabilities } = await import('../src/core/storage/capabilities.js');
  const dc = { persistAssets: true, mountDirectory: true, relinkByPath: true, watchFiles: true, writeFiles: true };
  assert.equal(detectCapabilities({ desktop: true, desktopCaps: dc, hasListbridge: true }).publish, true);
  assert.equal(detectCapabilities({ desktop: true, desktopCaps: dc }).publish, false);
  assert.equal(detectCapabilities({ hasFSA: true, hasIDB: true, hasListbridge: true }).publish, false);
  assert.equal(detectCapabilities({ hasOPFS: true, hasIDB: true }).publish, false);
});

test('buildListingPackage: files from the export seam, hero + gallery images', async () => {
  const { deps } = setup();
  const pkg = await build(deps);
  assert.deepEqual(pkg.files.map(f => f.name), ['Dragon.stl', 'Dragon.3mf']);
  assert.deepEqual(pkg.images.map(i => [i.name, i.role]), [['hero.png', 'hero'], ['gallery-1.png', 'gallery']]);
  assert.deepEqual(core.validateListing(pkg), []);
});

test('buildListingPackage: a blocked readiness gate is returned, not files', async () => {
  const { deps } = setup();
  const gate = { blocked: true, code: 'EXPORT_NEEDS_ACKNOWLEDGEMENT', readinessIssues: [{ id: 'x' }] };
  const r = await Client.buildListingPackage({ listing: fields, exportSelection: { formats: ['stl'] }, heroBlob: png() },
    { ...deps, collectExportFiles: async () => gate });
  assert.deepEqual(r, gate);
});

test('publish: payload passes the real publish:start validation; progress forwarded; listing upserted', async () => {
  const { deps, calls, getListings, listeners } = setup();
  const pkg = await build(deps);
  const events = [];
  const out = await Client.publish(pkg, { platform: 'fake', accountId: 'me' }, e => events.push(e), deps);
  assert.equal(out.ok, true, out.error);
  assert.equal(calls[0].platform, 'fake');
  assert.equal(calls[0].manifest.title, 'Dragon');
  assert.equal(calls[0].files.length, 2);
  assert.ok(events.length > 0 && events.every(e => e.jobId === out.jobId), 'progress forwarded');
  assert.equal(listeners.size, 0, 'unsubscribed after the job');
  const [rec] = getListings();
  assert.equal(rec.remoteId, 'R1');
  assert.equal(rec.status, 'published');
  assert.equal(rec.url, 'https://fake.test/c/R1');
  assert.deepEqual(rec.fileNames, ['Dragon.stl', 'Dragon.3mf']);
  assert.equal(rec.price, 4);
  // update path: same remoteId never duplicates
  await Client.publish(pkg, { platform: 'fake', accountId: 'me', remoteId: 'R1' }, null, deps);
  assert.equal(getListings().length, 1);
});

test('publish: failure of a first publish leaves listings untouched; failed update flags the record', async () => {
  const bad = setup({ respond: () => ({ json: { errors: [{ message: 'nope' }] } }) });
  const pkg = await build(bad.deps);
  const out = await Client.publish(pkg, { platform: 'fake', accountId: 'me' }, null, bad.deps);
  assert.equal(out.ok, false);
  assert.deepEqual(bad.getListings(), []);
  assert.equal(bad.sets.length, 0);

  const ok = setup();
  await Client.publish(await build(ok.deps), { platform: 'fake', accountId: 'me' }, null, ok.deps);
  const failing = { ...ok.deps, api: { ...ok.api, start: async () => ({ ok: false, status: 'failed', error: 'boom', failedStep: 'update' }) } };
  await Client.publish(await build(ok.deps), { platform: 'fake', accountId: 'me', remoteId: 'R1' }, null, failing);
  assert.equal(ok.getListings().length, 1);
  assert.equal(ok.getListings()[0].status, 'failed');
  assert.equal(ok.getListings()[0].remoteId, 'R1');
});

test('retry / cancel pass through; unavailable runtime throws clearly', async () => {
  const { deps } = setup();
  assert.deepEqual(await Client.retry('j1', deps), { retried: 'j1' });
  assert.deepEqual(await Client.cancel('j1', deps), { cancelled: 'j1' });
  assert.equal(Client.isAvailable(deps), true);
  const off = { ...deps, caps: { publish: false } };
  assert.equal(Client.isAvailable(off), false);
  await assert.rejects(Client.publish({ images: [], files: [] }, { platform: 'fake', accountId: 'me' }, null, off), /desktop app/);
  await assert.rejects(Client.retry('j', off), /desktop app/);
  await assert.rejects(Client.cancel('j', off), /desktop app/);
});

test('package zip round-trips through fromManifest; save goes through storage.saveExport', async () => {
  const { deps } = setup();
  const pkg = await build(deps);
  const bytes = await Pkg.buildListingPackageZip(pkg, { JSZip: RealJSZip });
  const zip = await RealJSZip.loadAsync(bytes);
  assert.deepEqual(Object.keys(zip.files).sort(), ['files/', 'files/Dragon.3mf', 'files/Dragon.stl', 'images/', 'images/gallery-1.png', 'images/hero.png', 'listing.json'].sort());
  const back = await Pkg.readListingPackageZip(bytes, { JSZip: RealJSZip });
  assert.deepEqual(core.toManifest(back), core.toManifest(pkg));
  assert.deepEqual(back.files.map(f => [...f.bytes]), pkg.files.map(f => [...f.bytes]));
  assert.deepEqual(back.images.map(i => [...i.bytes]), pkg.images.map(i => [...i.bytes]));

  const saved = [];
  const storage = { saveExport: async (blob, name, hint) => { saved.push([blob, name, hint]); return true; } };
  assert.equal(await Pkg.saveListingPackage(pkg, { storage, JSZip: RealJSZip }), true);
  assert.equal(saved[0][1], 'Dragon.listbridge.zip');
  assert.equal(saved[0][2].ext, 'zip');
  assert.equal(Pkg.listingPackageFileName({ title: 'a/b:c' }), 'a_b_c.listbridge.zip');
});

// ── PB.14: early remoteId persistence + Keep waiting ─────────────────────

test('extendHold passes through to the bridge; unavailable runtime throws clearly', async () => {
  const { deps } = setup();
  const seen = [];
  const d = { ...deps, api: { ...deps.api, extendHold: async (id, ms) => { seen.push([id, ms]); return { ok: true, holdRemainingMs: ms }; } } };
  assert.deepEqual(await Client.extendHold('j1', 900000, d), { ok: true, holdRemainingMs: 900000 });
  assert.deepEqual(seen, [['j1', 900000]]);
  await assert.rejects(Client.extendHold('j1', 1, { ...d, caps: { publish: false } }), /desktop app/);
});

test('listOptions passes platform + locale through; bridge errors become { ok:false }', async () => {
  const { deps } = setup();
  const seen = [];
  const d = { ...deps, api: { ...deps.api, listOptions: async (p, l) => { seen.push([p, l]); return { ok: true, categories: [], licenses: [] }; } } };
  assert.deepEqual(await Client.listOptions('cults3d', 'ja', d), { ok: true, categories: [], licenses: [] });
  assert.deepEqual(seen, [['cults3d', 'ja']]);
  const boom = { ...deps, api: { ...deps.api, listOptions: async () => { throw new Error('ipc down'); } } };
  assert.deepEqual(await Client.listOptions('cults3d', 'en', boom), { ok: false, message: 'ipc down' });
  assert.equal((await Client.listOptions('cults3d', 'en', { ...deps, api: { ...deps.api, listOptions: undefined } })).ok, false);
  await assert.rejects(Client.listOptions('cults3d', 'en', { ...d, caps: { publish: false } }), /desktop app/);
});

test('record keeps visibility + sub-categories; a secret result stays a draft record', async () => {
  const { deps, getListings } = setup();
  const pkg = await build(deps);
  pkg.visibility = 'secret'; pkg.subCategoryIds = ['S1'];
  const d = { ...deps, api: { ...deps.api, start: async () => ({ ok: true, status: 'done', result: { remoteId: 'r9', url: 'https://c/x', status: 'secret' } }), onProgress: () => () => {} } };
  await Client.publish(pkg, { platform: 'cults3d', accountId: 'default' }, undefined, d);
  const rec = getListings()[0];
  assert.deepEqual([rec.remoteId, rec.status, rec.visibility, rec.subCategoryIds], ['r9', 'draft', 'secret', ['S1']]);
});

test('early remoteId: the create-done progress event persists the record BEFORE the job settles', async () => {
  const { deps, getListings, sets } = setup();
  const pkg = await build(deps);
  let during = null;
  // The job reports create-done, then the renderer "dies" (start never resolves with an outcome).
  const listeners = new Set();
  const crashing = {
    ...deps,
    api: {
      ...deps.api,
      onProgress: cb => { listeners.add(cb); return () => listeners.delete(cb); },
      start: async () => {
        listeners.forEach(cb => cb({ jobId: 'j', step: 'create', status: 'done', message: 'x', remoteId: 'R9', url: 'https://fake.test/c/R9' }));
        during = JSON.parse(JSON.stringify(getListings()));
        throw new Error('window reloaded');
      },
    },
  };
  await assert.rejects(Client.publish(pkg, { platform: 'fake', accountId: 'me' }, null, crashing), /window reloaded/);
  assert.equal(during.length, 1, 'written while the job was still running');
  assert.equal(during[0].remoteId, 'R9');
  assert.equal(during[0].status, 'failed');
  assert.equal(during[0].url, 'https://fake.test/c/R9');
  assert.equal(getListings().length, 1);
  assert.equal(listeners.size, 0, 'unsubscribed even when start throws');
  assert.equal(sets.length, 1);
});

test('early remoteId: the outcome upgrades the early record in place; an update of a known remoteId writes nothing early', async () => {
  const { deps, getListings, sets } = setup();
  const pkg = await build(deps);
  const events = [];
  await Client.publish(pkg, { platform: 'fake', accountId: 'me' }, e => events.push(e), deps);
  assert.ok(events.some(e => e.step === 'create' && e.status === 'done' && e.remoteId === 'R1'), 'forwarded to the caller too');
  assert.equal(getListings().length, 1);
  assert.equal(getListings()[0].status, 'published', 'upgraded on outcome');
  assert.equal(sets.length, 2, 'early write + outcome write');
  const before = sets.length;
  await Client.publish(pkg, { platform: 'fake', accountId: 'me', remoteId: 'R1' }, null, deps);
  assert.equal(sets.length, before + 1, 'update: only the outcome write');
  assert.equal(getListings().length, 1);
});

test('early remoteId: retryPublish persists it too (links-lost retry creates nothing new, but a first create on retry is kept)', async () => {
  const { deps, getListings } = setup();
  const pkg = await build(deps);
  const listeners = new Set();
  const d = { ...deps, api: { ...deps.api, onProgress: cb => { listeners.add(cb); return () => listeners.delete(cb); },
    retry: async () => { listeners.forEach(cb => cb({ jobId: 'j', step: 'create', status: 'done', remoteId: 'R2' })); throw new Error('quit'); } } };
  await assert.rejects(Client.retryPublish('j', pkg, { platform: 'fake', accountId: 'me' }, null, d), /quit/);
  assert.equal(getListings()[0].remoteId, 'R2');
  assert.equal(listeners.size, 0);
});
