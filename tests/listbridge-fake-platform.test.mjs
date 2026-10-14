// PB.15: the dress-rehearsal fake platform must NEVER register in a packaged build.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import * as core from '../src/listbridge/index.js';

const require = createRequire(import.meta.url);
const { fakePlatformAdapters } = require('../electron/listbridge/fakePlatform.cjs');

const URL_OK = 'http://127.0.0.1:45678/graphql';
const env = { LISTBRIDGE_FAKE_PLATFORM: '1', LISTBRIDGE_FAKE_URL: URL_OK };
const realAdapters = [...core.ADAPTERS];

test('packaged build ignores LISTBRIDGE_FAKE_PLATFORM entirely', () => {
  assert.equal(fakePlatformAdapters({ isPackaged: true, env, realAdapters }), null);
});

test('unpackaged without the switch / without a loopback URL keeps the real adapters', () => {
  assert.equal(fakePlatformAdapters({ isPackaged: false, env: {}, realAdapters }), null);
  assert.equal(fakePlatformAdapters({ isPackaged: false, env: { LISTBRIDGE_FAKE_PLATFORM: '1' }, realAdapters }), null);
  assert.equal(fakePlatformAdapters({ isPackaged: false, env: { ...env, LISTBRIDGE_FAKE_URL: 'https://evil.example/graphql' }, realAdapters }), null);
  assert.equal(fakePlatformAdapters({ isPackaged: false, env: { ...env, LISTBRIDGE_FAKE_PLATFORM: 'true' }, realAdapters }), null);
});

test('unpackaged + switch: a fake cults3d (direct uploads) pointing at the local server, real payload builders', () => {
  const out = fakePlatformAdapters({ isPackaged: false, env, realAdapters });
  assert.equal(out.length, 1);
  const fake = out[0];
  assert.equal(fake.describe().id, 'cults3d');
  assert.equal(fake.describe().transfer, 'direct');
  core.assertAdapter(fake);
  const pkg = core.createListing({ title: 'T', description: 'D', tags: ['a'], license: 'cults_cu', categoryHint: 'C1', images: [{ name: 'h.png', mime: 'image/png', bytes: new Uint8Array([1]), role: 'hero' }], files: [{ name: 'a.stl', mime: 'model/stl', bytes: new Uint8Array([1]) }] });
  const ctx = { files: [{ name: 'a.stl', key: 'k/a.stl' }], images: [{ name: 'h.png', key: 'k/h.png' }] };
  const spec = fake.buildCreate(pkg, ctx);
  assert.equal(spec.url, URL_OK);
  assert.deepEqual(spec.body.variables.fileKeys, ['k/a.stl']);
  assert.match(spec.body.query, /createCreation/);
  assert.equal(fake.buildUploadSlot('file', { name: 'a.stl' }).url, URL_OK);
  assert.equal(fake.buildListOptions()[0].url, URL_OK);
  assert.equal(fake.buildConfirm({ slug: 's' }).url, URL_OK);
  const slot = fake.parseUploadSlot({ status: 200, json: { data: { createFileUploader: { errors: [], uploader: { url: 'http://127.0.0.1:1/up', fields: [{ name: 'key', value: 'u/${filename}' }] } } } } }, { name: 'a.stl' });
  assert.deepEqual(slot, { url: 'http://127.0.0.1:1/up', fields: [{ name: 'key', value: 'u/${filename}' }], key: 'u/a.stl' });
});

test('main.cjs hands app.isPackaged to the guard (no other path registers the fake)', () => {
  const main = readFileSync(new URL('../electron/main.cjs', import.meta.url), 'utf8');
  assert.match(main, /fakePlatformAdapters\(\{ isPackaged: app\.isPackaged,/);
  assert.equal((main.match(/LISTBRIDGE_FAKE/g) || []).length, 0, 'main.cjs must not read the env itself');
});
