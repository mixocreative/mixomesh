// cia F-01: a create whose answer is lost must never turn into a second listing.
// Real portable core + Cults3D adapter + runner + transport; only fetch (a fake Cults3D) is faked.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import * as core from '../src/listbridge/index.js';

const require = createRequire(import.meta.url);
const { createPublishRunner } = require('../electron/listbridge/jobs.cjs');
const { createTransport } = require('../electron/listbridge/transport.cjs');

function fakeCults({ createFails = 'drop', listShowsNew = true, existing = [] } = {}) {
  const remote = { creations: existing.map(c => ({ ...c })), createCalls: 0, createFails };
  let gate = null;
  remote.holdCreate = () => new Promise(r => { gate = r; });
  remote.releaseCreate = () => gate?.();
  const json = (obj, status = 200) => ({ status, headers: new Map(), text: async () => JSON.stringify(obj) });
  remote.fetchImpl = async (url, init) => {
    const body = typeof init.body === 'string' ? init.body : '';
    if (url.startsWith('https://s3.fake/')) return { status: 204, headers: new Map(), text: async () => '' };
    if (body.includes('createFileUploader') || body.includes('createImageUploader')) {
      const field = body.includes('createFileUploader') ? 'createFileUploader' : 'createImageUploader';
      return json({ data: { [field]: { errors: [], uploader: { url: 'https://s3.fake/', fields: [{ name: 'key', value: 'up/${filename}' }] } } } });
    }
    if (body.includes('createCreation')) {
      remote.createCalls++;
      const { variables } = JSON.parse(body);
      const id = String(100 + remote.createCalls);
      const c = { id, slug: `s${id}`, name: variables.name, url: `https://cults3d.com/en/3d-model/x/s${id}`, visibility: 'SECRET', fresh: true };
      remote.creations.push(c);
      if (gate) {
        // Like real fetch: an abort while the request is out rejects the call (Cults3D still made it).
        await new Promise((resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
          setTimeout(resolve, 20);
        });
      }
      const fail = remote.createFails;
      remote.createFails = null;
      if (fail === 'drop') throw new TypeError('fetch failed (socket hang up)');
      if (fail === '502') return json({ error: 'bad gateway' }, 502);
      return json({ data: { createCreation: { errors: [], creation: { id, slug: c.slug, url: c.url, visibility: 'SECRET' } } } });
    }
    if (body.includes('creationsBatch')) {
      const visible = remote.creations.filter(c => listShowsNew || !c.fresh);
      return json({ data: { myself: { creationsBatch: { total: visible.length, results: visible.map(({ fresh: _f, ...c }) => c) } } } });
    }
    if (body.includes('Confirm')) {
      const { variables } = JSON.parse(body);
      const c = remote.creations.find(x => x.slug === variables.slug);
      return json({ data: { creation: c ? { id: c.id, slug: c.slug, visibility: 'SECRET', url: c.url, blueprints: [{ id: 1, fileName: 'part.stl' }], illustrations: [{ id: 1 }] } : null } });
    }
    return json({ data: {} });
  };
  return remote;
}

function setup(remote) {
  return createPublishRunner({
    adapters: [core.cults3dAdapter],
    credentials: { get: async () => ({ nickname: 'n', apiKey: 'k' }) },
    transport: createTransport({ fetchImpl: remote.fetchImpl, sleep: async () => {} }),
    core, sleep: async () => {}, confirm: { polls: 1, intervalMs: 1 },
  });
}

const pkg = () => core.createListing({
  title: 'Dragon Bust', description: 'd', tags: ['a'], license: 'cc', categoryHint: 'c1', visibility: 'secret',
  images: [{ name: 'hero.png', mime: 'image/png', bytes: new Uint8Array([1]), role: 'hero' }],
  files: [{ name: 'part.stl', mime: 'model/stl', bytes: new Uint8Array([2]) }],
});

test('lost create answer: Retry finds the listing Cults3D made and sends no second createCreation', async () => {
  const remote = fakeCults({ existing: [{ id: '7', slug: 'old', name: 'Dragon Bust', url: 'https://cults3d.com/old', visibility: 'PUBLIC' }] });
  const runner = setup(remote);
  const first = await runner.start({ platform: 'cults3d', accountId: 'default', pkg: pkg() });
  assert.equal(first.ok, false);
  assert.equal(first.code, 'create-unknown', 'a lost answer is reported as unknown, not as a plain failure');
  assert.equal(remote.createCalls, 1);
  const second = await runner.retry(first.jobId);
  assert.equal(remote.createCalls, 1, 'Retry must not send createCreation again');
  assert.equal(second.ok, true, second.error);
  assert.equal(second.result.remoteId, '101', 'adopts the listing made by the first request, not the older one with the same name');
});

test('lost create answer that the lookup cannot see: Retry still never creates, the job stays unknown', async () => {
  const remote = fakeCults({ listShowsNew: false });
  const runner = setup(remote);
  const first = await runner.start({ platform: 'cults3d', accountId: 'default', pkg: pkg() });
  assert.equal(first.code, 'create-unknown');
  const second = await runner.retry(first.jobId);
  assert.equal(remote.createCalls, 1, 'no second createCreation while the first is unaccounted for');
  assert.equal(second.ok, false);
  assert.equal(second.code, 'create-unknown');
});

test('HTTP 502 on create is unknown too (the platform may have committed)', async () => {
  const remote = fakeCults({ createFails: '502', listShowsNew: false });
  const runner = setup(remote);
  const first = await runner.start({ platform: 'cults3d', accountId: 'default', pkg: pkg() });
  assert.equal(first.code, 'create-unknown');
  await runner.retry(first.jobId);
  assert.equal(remote.createCalls, 1);
});

test('Cancel while createCreation is in flight keeps the listing id that Cults3D returns', async () => {
  const remote = fakeCults({ createFails: null });
  const hold = remote.holdCreate();
  const runner = setup(remote);
  let jobId = null;
  const done = runner.start({ platform: 'cults3d', accountId: 'default', pkg: pkg(), onProgress: ev => {
    jobId = ev.jobId;
    if (ev.step === 'create' && ev.status === 'running') setTimeout(async () => { cancelled = runner.cancel(jobId); remote.releaseCreate(); }, 0);
  } });
  let cancelled = null;
  const out = await done;
  await cancelled;
  void hold;
  assert.equal(remote.createCalls, 1);
  assert.equal(out.result?.remoteId, '101', `the created listing id must reach the caller (got ${JSON.stringify(out)})`);
});
