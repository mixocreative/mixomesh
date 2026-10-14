// Native-upload runner flow (plan PB.3b): the real Cults3D adapter through the real job runner with a
// fake transport (no network): slot request -> multipart POST -> keys -> createCreation -> confirm.
//   node --import ./tests/register-hooks.mjs --test tests/listbridge-upload.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import * as core from '../src/listbridge/index.js';

const require = createRequire(import.meta.url);
const { createPublishRunner } = require('../electron/listbridge/jobs.cjs');

const GQL = 'https://cults3d.com/graphql';
const S3 = 'https://s3.example/bucket';
const AUTH = `Basic ${Buffer.from('nick:KEY').toString('base64')}`;

function makePkg({ files = 2, images = 1, visibility } = {}) {
  return core.createListing({
    title: 'Dragon', description: 'D', tags: ['a'], price: { amount: 4, currency: 'EUR' }, license: 'cults_cu',
    categoryHint: 'C1', visibility,
    images: Array.from({ length: images }, (_, i) => ({ name: `img${i}.png`, mime: 'image/png', bytes: new Uint8Array([1, i]), role: i === 0 ? 'hero' : 'gallery' })),
    files: Array.from({ length: files }, (_, i) => ({ name: `part${i}.stl`, mime: 'model/stl', bytes: new Uint8Array([2, i, 255]) })),
  });
}

function parseMultipart(req) {
  const ct = req.headers['Content-Type'];
  const boundary = /boundary=(.+)$/.exec(ct)[1];
  const text = Buffer.from(req.body).toString('latin1');
  return text.split(`--${boundary}`).slice(1, -1).map((chunk) => {
    const [head, ...rest] = chunk.replace(/^\r\n/, '').split('\r\n\r\n');
    const body = rest.join('\r\n\r\n').replace(/\r\n$/, '');
    return { name: /name="([^"]*)"/.exec(head)[1], filename: /filename="([^"]*)"/.exec(head)?.[1], head, bytes: Buffer.from(body, 'latin1') };
  });
}

function world({ failPost = null, slotError = false, confirmAfter = 1 } = {}) {
  const log = { slots: [], posts: [], gql: [], reqs: [] };
  let n = 0;
  let confirms = 0;
  const postFails = failPost || {};   // shared by reference: a test flips it to simulate recovery
  const transport = {
    request: async (req) => {
      log.reqs.push(req);
      const json = (data, status = 200) => ({ status, ok: status < 400, headers: {}, json: data, text: JSON.stringify(data) });
      if (req.url === GQL) {
        const q = req.body.query;
        log.gql.push(req);
        if (/createFileUploader|createImageUploader/.test(q)) {
          if (slotError) return json({ data: { createFileUploader: { errors: ['quota exceeded'], uploader: null } } });
          n++;
          log.slots.push(/createFileUploader/.test(q) ? 'file' : 'image');
          const field = /createFileUploader/.test(q) ? 'createFileUploader' : 'createImageUploader';
          return json({ data: { [field]: { errors: [], uploader: { url: S3, fields: [{ name: 'key', value: `up/${n}/\${filename}` }, { name: 'policy', value: 'POLICY' }] } } } });
        }
        if (/createCreation|updateCreation/.test(q)) {
          const isUpdate = /updateCreation/.test(q);
          return json({ data: { [isUpdate ? 'updateCreation' : 'createCreation']: { creation: { id: 'C-1', slug: 'dragon', url: 'https://cults3d.com/en/dragon', visibility: req.body.variables.visibility }, errors: [] } } });
        }
        if (/ListOptions/.test(q)) return json({ data: { licenses: [], categories: [] } });
        if (/Confirm/.test(q)) {
          confirms++;
          const ready = confirms >= confirmAfter;
          const stl = log.posts.filter((p) => p.file.filename.endsWith('.stl')).length;
          return json({ data: { creation: { id: 'C-1', slug: 'dragon', url: 'https://cults3d.com/en/dragon', visibility: 'SECRET',
            blueprints: ready ? Array.from({ length: stl }, (_, i) => ({ id: i })) : [], illustrations: ready ? [{ id: 1 }] : [] } } });
        }
      }
      if (req.url === S3) {
        const parts = parseMultipart(req);
        const file = parts.find((p) => p.name === 'file');
        const fails = postFails[file.filename];
        if (fails > 0) {
          postFails[file.filename]--;
          return { status: 403, ok: false, headers: {}, json: null, text: '<Error><Code>AccessDenied</Code><Message>Policy expired</Message><StringToSign>SECRETISH</StringToSign></Error>' };
        }
        log.posts.push({ parts, file, order: parts.map((p) => p.name) });
        return { status: 204, ok: true, headers: {}, json: null, text: '' };
      }
      throw new Error(`unexpected request ${req.url}`);
    },
  };
  const credentials = { get: async () => ({ nickname: 'nick', apiKey: 'KEY' }) };
  const events = [];
  const runner = createPublishRunner({
    adapters: [core.cults3dAdapter], credentials, transport, core, sleep: async () => {},
    confirm: { polls: 3, intervalMs: 0 }, emit: (e) => events.push(e),
  });
  return { runner, log, events };
}

const start = (w, over = {}) => w.runner.start({ platform: 'cults3d', accountId: 'default', pkg: makePkg(), ...over });

test('direct upload: slots (authenticated) -> multipart POST (no credentials) -> keys in createCreation -> confirmed', async () => {
  const w = world();
  const out = await start(w);
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.deepEqual(w.log.slots, ['file', 'file', 'image']);
  for (const r of w.log.gql) assert.equal(r.headers.Authorization, AUTH);                         // GraphQL is authenticated
  for (const r of w.log.reqs.filter((x) => x.url === S3)) {
    assert.equal(r.headers.Authorization, undefined);                                              // the storage host never sees credentials
    assert.match(r.headers['Content-Type'], /^multipart\/form-data; boundary=/);
  }
  const first = w.log.posts[0];
  assert.deepEqual(first.order, ['key', 'policy', 'file']);                                       // fields in order, file part LAST
  assert.equal(first.parts[0].bytes.toString(), 'up/1/${filename}');                              // S3 expands ${filename} itself; the key we keep is substituted
  assert.equal(first.file.filename, 'part0.stl');
  assert.deepEqual([...first.file.bytes], [2, 0, 255]);                                           // binary survives (0xff byte)
  const create = w.log.gql.find((r) => /createCreation/.test(r.body.query)).body.variables;
  assert.deepEqual(create.fileKeys, ['up/1/part0.stl', 'up/2/part1.stl']);
  assert.deepEqual(create.imageKeys, ['up/3/img0.png']);
  assert.ok(!('fileUrls' in create));
  assert.equal(create.visibility, 'SECRET');
  assert.equal(out.result.status, 'secret');
  const up = w.events.filter((e) => e.step === 'host' && e.phase === 'upload');
  assert.deepEqual([up[0].done, up[0].total], [0, 3]);
  assert.deepEqual([up.at(-1).done, up.at(-1).total], [3, 3]);
  assert.ok(w.events.some((e) => e.step === 'cleanup' && e.skipped), 'no hosted copies: cleanup is skipped');
});

test('confirm polls until the platform shows the blueprints and the illustration', async () => {
  const w = world({ confirmAfter: 3 });
  const out = await start(w);
  assert.equal(out.ok, true);
  assert.equal(w.log.gql.filter((r) => /Confirm/.test(r.body.query)).length, 3);
});

test('a failed storage upload reports upload-failed with only the S3 Code + Message', async () => {
  const w = world({ failPost: { 'part1.stl': 99 } });
  const out = await start(w);
  assert.equal(out.ok, false);
  assert.equal(out.failedStep, 'host');
  assert.equal(out.code, 'upload-failed');
  assert.match(out.error, /part1\.stl.*HTTP 403.*AccessDenied: Policy expired/);
  assert.ok(!out.error.includes('SECRETISH'), 'only Code + Message of the storage error are shown');
  assert.ok(!w.log.gql.some((r) => /createCreation/.test(r.body.query)), 'nothing was created yet');
});

test('retry after recovery re-uploads nothing that already finished', async () => {
  const fail = { 'part1.stl': 99 };
  const w = world({ failPost: fail });
  const out = await start(w);
  assert.equal(out.failedStep, 'host');
  assert.deepEqual(w.log.posts.map((p) => p.file.filename), ['part0.stl']);
  fail['part1.stl'] = 0;                                                                           // storage recovers (shared by reference inside the world)
  const out2 = await w.runner.retry(out.jobId);
  assert.equal(out2.ok, true, JSON.stringify(out2));
  assert.deepEqual(w.log.posts.map((p) => p.file.filename), ['part0.stl', 'part1.stl', 'img0.png']);   // part0 NOT re-sent
  assert.equal(w.log.slots.filter((s) => s === 'file').length, 3);                                 // part0 once, part1 twice (its first slot was spent on the failed POST)
  const create = w.log.gql.find((r) => /createCreation/.test(r.body.query)).body.variables;
  assert.equal(create.fileKeys.length, 2);
});

test('slot refusal -> code upload-slot-failed with the platform message', async () => {
  const w = world({ slotError: true });
  const out = await start(w);
  assert.equal(out.ok, false);
  assert.equal(out.failedStep, 'host');
  assert.equal(out.code, 'upload-slot-failed');
  assert.match(out.error, /quota exceeded/);
  assert.equal(w.log.posts.length, 0);
});

test('an update (remoteId) skips uploads, sends metadata only, and confirms without file counts', async () => {
  const w = world();
  const out = await start(w, { remoteId: 'C-1', pkg: makePkg({ visibility: 'public' }) });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(w.log.slots.length, 0);
  assert.equal(w.log.posts.length, 0);
  const up = w.log.gql.find((r) => /updateCreation/.test(r.body.query)).body.variables;
  assert.equal(up.id, 'C-1');
  assert.equal(up.visibility, 'PUBLIC');
  assert.ok(!('fileKeys' in up));
  assert.ok(w.events.some((e) => e.step === 'host' && e.skipped));
});

test('cancel during the upload step stops cleanly (no create)', async () => {
  const w = world();
  const id = w.runner.create({ platform: 'cults3d', accountId: 'default', pkg: makePkg(), onProgress: (e) => { if (e.phase === 'upload' && e.done === 1) w.runner.cancel(id); } });
  const out = await w.runner.run(id);
  assert.equal(out.status, 'cancelled');
  assert.ok(!w.log.gql.some((r) => /createCreation/.test(r.body.query)));
});
