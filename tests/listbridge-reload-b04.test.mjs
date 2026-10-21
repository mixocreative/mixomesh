// cia B-04: a publish that finishes while its window reloads (or the app dies mid-create) must not
// lose the listing id, and the next Publish of that project must not create a second listing.
// Real IPC wiring + runner + Cults3D adapter + transport; fetch is a fake Cults3D.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installEnv } from './env.mjs';

installEnv();
const core = await import('../src/listbridge/index.js');
const { pendingPublishes } = await import('../src/core/publish/PublishClient.js');
const require = createRequire(import.meta.url);
const { registerListbridgeIpc } = require('../electron/listbridge/index.cjs');

const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: s => Buffer.from(`ENC:${s}`, 'utf8'),
  decryptString: b => b.toString('utf8').slice(4),
};

function fakeCults() {
  const remote = { creations: [], createCalls: 0, hangCreate: false };
  const json = obj => ({ status: 200, headers: new Map(), text: async () => JSON.stringify(obj) });
  remote.fetchImpl = async (url, init) => {
    const body = typeof init.body === 'string' ? init.body : '';
    if (url.startsWith('https://s3.fake/')) return { status: 204, headers: new Map(), text: async () => '' };
    if (body.includes('createFileUploader') || body.includes('createImageUploader')) {
      const field = body.includes('createFileUploader') ? 'createFileUploader' : 'createImageUploader';
      return json({ data: { [field]: { errors: [], uploader: { url: 'https://s3.fake/', fields: [{ name: 'key', value: 'up/${filename}' }] } } } });
    }
    if (body.includes('createCreation')) {
      remote.createCalls++;
      const id = String(100 + remote.createCalls);
      const c = { id, slug: `s${id}`, name: JSON.parse(body).variables.name, url: `https://cults3d.com/x/s${id}`, visibility: 'SECRET' };
      remote.creations.push(c);
      if (remote.hangCreate) return new Promise(() => {});
      return json({ data: { createCreation: { errors: [], creation: c } } });
    }
    if (body.includes('creationsBatch')) return json({ data: { myself: { creationsBatch: { results: remote.creations } } } });
    if (body.includes('Confirm')) {
      const { variables } = JSON.parse(body);
      const c = remote.creations.find(x => x.slug === variables.slug);
      return json({ data: { creation: { ...c, blueprints: [{ id: 1, fileName: 'part.stl' }], illustrations: [{ id: 1 }] } } });
    }
    return json({ data: {} });
  };
  return remote;
}

function mainProcess(dir, remote) {
  const handlers = new Map();
  registerListbridgeIpc((c, fn) => handlers.set(c, fn), {
    userDataDir: dir, safeStorage, adapters: [core.cults3dAdapter], fetchImpl: remote.fetchImpl,
    loadCore: async () => core, sleep: async () => {}, confirm: { polls: 1, intervalMs: 1 },
  });
  return (sender, channel, ...args) => handlers.get(channel)({ sender }, ...args);
}

const pkg = () => core.createListing({
  title: 'Dragon Bust', description: 'd', tags: ['a'], license: 'cc', categoryHint: 'c1', visibility: 'secret',
  images: [{ name: 'hero.png', mime: 'image/png', bytes: new Uint8Array([1]), role: 'hero' }],
  files: [{ name: 'part.stl', mime: 'model/stl', bytes: new Uint8Array([2]) }],
});
const payload = (extra = {}) => {
  const p = pkg();
  return { platform: 'cults3d', accountId: 'default', manifest: core.toManifest(p), images: p.images.map(i => i.bytes), files: p.files.map(f => f.bytes), ...extra };
};

function reloadingWindow() {
  let alive = true;
  return { id: 1, isDestroyed: () => !alive, send: () => { alive = false; } };   // reloads on the first progress event
}

function renderer(call, projectId) {
  let state = { project: { id: projectId, listings: [] } };
  const api = {
    pending: key => call({ id: 1, isDestroyed: () => false, send() {} }, 'publish:pending', key),
    resolvePending: (jobId, action) => call({ id: 1, isDestroyed: () => false, send() {} }, 'publish:resolvePending', jobId, action),
  };
  return {
    deps: { caps: { publish: true }, api, getState: () => state, setState: fn => { state = fn(state); }, now: () => '2026-10-22T00:00:00.000Z' },
    listings: () => state.project.listings,
  };
}

test('a publish that finishes after its window reloaded is picked up by the reloaded window; no second listing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lb-b04-'));
  const remote = fakeCults();
  const call = mainProcess(dir, remote);
  const win = reloadingWindow();
  await call(win, 'publish:setCredentials', 'cults3d:default', { nickname: 'n', apiKey: 'k' });
  const out = await call(win, 'publish:start', payload({ projectKey: 'proj-1' }));
  assert.equal(out.ok, true, out.error);
  assert.equal(remote.createCalls, 1);

  const blocked = await call(win, 'publish:start', payload({ projectKey: 'proj-1' }));
  assert.equal(remote.createCalls, 1, 'Publish again before the reloaded window recorded the listing must not create another');
  assert.equal(blocked.ok, false);

  const r = renderer(mainProcess(dir, remote), 'proj-1');   // also survives an app restart (same userData)
  await pendingPublishes(r.deps);
  assert.equal(r.listings().length, 1);
  assert.equal(r.listings()[0].remoteId, '101', 'the reloaded window writes the listing record');
  assert.equal(r.listings()[0].title, 'Dragon Bust');
  assert.deepEqual(await r.deps.api.pending('proj-1'), [], 'acknowledged once recorded');
});

test('the app dies while createCreation is out: the project is blocked until a check finds the listing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lb-b04-'));
  const remote = fakeCults();
  remote.hangCreate = true;
  const call = mainProcess(dir, remote);
  const win = { id: 1, isDestroyed: () => false, send() {} };
  await call(win, 'publish:setCredentials', 'cults3d:default', { nickname: 'n', apiKey: 'k' });
  void call(win, 'publish:start', payload({ projectKey: 'proj-2' }));
  for (let i = 0; i < 50 && remote.createCalls === 0; i++) await new Promise(r => setTimeout(r, 5));
  assert.equal(remote.createCalls, 1);

  remote.hangCreate = false;
  const restarted = mainProcess(dir, remote);
  const blocked = await restarted(win, 'publish:start', payload({ projectKey: 'proj-2' }));
  assert.equal(blocked.ok, false);
  assert.equal(remote.createCalls, 1, 'no second create while the first is unaccounted for');

  const r = renderer(restarted, 'proj-2');
  const res = await pendingPublishes(r.deps);
  assert.equal(res.unresolved.length, 1);
  assert.equal(res.unresolved[0].state, 'unknown');
  const checked = await r.deps.api.resolvePending(res.unresolved[0].jobId, 'check');
  assert.equal(checked.state, 'created');
  await pendingPublishes(r.deps);
  assert.equal(r.listings()[0]?.remoteId, '101');
});
