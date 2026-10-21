// cia D-02: Cults3D's updateCreation takes no files or images, so "Update listing" must neither
// offer them nor need them, and the project record must not claim new files were uploaded.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installEnv } from './env.mjs';

installEnv();
const core = await import('../src/listbridge/index.js');
const M = await import('../src/ui/print/PublishModel.js');
const Client = await import('../src/core/publish/PublishClient.js');
const require = createRequire(import.meta.url);
const { registerListbridgeIpc } = require('../electron/listbridge/index.cjs');

const schema = JSON.parse(fs.readFileSync(new URL('../docs/reference/cults3d-schema.json', import.meta.url), 'utf8'));
const updateArgs = schema.types.find(t => t.name === 'ApplicationMutation').fields.find(f => f.name === 'updateCreation').args.map(a => a.name);

function main() {
  const handlers = new Map();
  const sent = [];
  const fetchImpl = async (url, init) => {
    const body = String(init.body ?? '');
    sent.push(body);
    const json = obj => ({ status: 200, headers: new Map(), text: async () => JSON.stringify(obj) });
    if (body.includes('updateCreation')) return json({ data: { updateCreation: { errors: [], creation: { id: '7', slug: 's7', url: 'https://cults3d.com/x/s7', visibility: 'SECRET' } } } });
    if (body.includes('Confirm')) return json({ data: { creation: { id: '7', slug: 's7', visibility: 'SECRET', url: 'https://cults3d.com/x/s7', blueprints: [{ id: 1 }], illustrations: [{ id: 1 }] } } });
    return json({ data: {} });
  };
  registerListbridgeIpc((c, fn) => handlers.set(c, fn), {
    userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'lb-d02-')),
    safeStorage: { isEncryptionAvailable: () => true, encryptString: s => Buffer.from(s), decryptString: b => b.toString() },
    adapters: [core.cults3dAdapter], fetchImpl, loadCore: async () => core, sleep: async () => {}, confirm: { polls: 1, intervalMs: 1 },
  });
  const sender = { id: 1, isDestroyed: () => false, send() {} };
  return { call: (c, ...a) => handlers.get(c)({ sender }, ...a), sent };
}

test('the schema really has no file or image arguments on updateCreation (the premise of this fix)', () => {
  for (const a of ['fileKeys', 'fileUrls', 'imageKeys', 'imageUrls']) assert.ok(!updateArgs.includes(a), a);
});

test('describe says Cults3D cannot replace files on update', async () => {
  const { call } = main();
  const d = (await call('publish:describe')).platforms.find(p => p.id === 'cults3d');
  assert.equal(d.updateFiles, false);
});

test('a metadata-only update needs no export, no hero and no upload, and reaches updateCreation', async () => {
  const { call, sent } = main();
  await call('publish:setCredentials', 'cults3d:default', { nickname: 'n', apiKey: 'k' });
  const pkg = core.createListing({ title: 'Dragon v2', description: 'd', tags: [], license: 'cc', categoryHint: 'c1', visibility: 'secret', images: [], files: [] });
  const out = await call('publish:start', { platform: 'cults3d', accountId: 'default', remoteId: '7', manifest: core.toManifest(pkg), images: [], files: [] });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.ok(sent.some(b => b.includes('updateCreation')));
  assert.ok(!sent.some(b => /create(File|Image)Uploader/.test(b)), 'nothing is uploaded on update');
});

test('Publish tab: on update the file checklist, hero and gallery are not offered, and the form needs none of them', () => {
  const cults = { id: 'cults3d', updateFiles: false, maxImages: 10, currencies: ['EUR'], requires: ['categoryHint', 'license'] };
  assert.deepEqual(M.listingScope(cults, '7'), { files: false, images: false });
  assert.deepEqual(M.listingScope(cults, null), { files: true, images: true });
  const form = { ...M.emptyForm('Dragon v2', 'EUR'), description: 'd', category: 'c1', license: 'cc' };
  const issues = M.validateForm({ form, hasHero: false, galleryCount: 0, fileCount: 0, limits: { maxImages: 10 }, requires: cults.requires, scope: M.listingScope(cults, '7') });
  assert.deepEqual(issues, []);
  assert.deepEqual(M.stepPlan(true, M.listingScope(cults, '7')), ['validate', 'update', 'confirm', 'cleanup']);
});

test('the listing record after an update keeps the files of the first publish', async () => {
  let state = { project: { id: 'p1', listings: [{ platform: 'cults3d', accountId: 'default', title: 'Dragon', remoteId: '7', fileNames: ['Dragon.stl'], status: 'draft' }] } };
  const api = { start: async () => ({ jobId: 'job_1', ok: true, status: 'done', result: { remoteId: '7', url: 'https://cults3d.com/x/s7', status: 'secret' } }), onProgress: () => () => {} };
  const deps = { caps: { publish: true }, api, getState: () => state, setState: fn => { state = fn(state); }, now: () => '2026-10-22T00:00:00.000Z' };
  const pkg = core.createListing({ title: 'Dragon v2', description: 'd', tags: [], license: 'cc', categoryHint: 'c1', visibility: 'secret', images: [], files: [] });
  await Client.publish(pkg, { platform: 'cults3d', accountId: 'default', remoteId: '7' }, null, deps);
  const rec = state.project.listings.find(l => l.remoteId === '7');
  assert.equal(rec.title, 'Dragon v2');
  assert.deepEqual(rec.fileNames, ['Dragon.stl'], 'an update uploads nothing, so the record keeps the first publish\'s files');
});
