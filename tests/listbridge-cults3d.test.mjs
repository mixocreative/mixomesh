import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cults3dAdapter as a, ADAPTERS, createListing, assertAdapter } from '../src/listbridge/index.js';
import { base64Utf8 } from '../src/listbridge/adapters/cults3d.js';

const pkg = (over = {}) => createListing({
  title: 'Dragon', description: 'Nice', tags: ['dragon', 'bust'], price: { amount: 4.5, currency: 'eur' },
  license: 'cults_cu', categoryHint: 'Q2F0', madeWithAi: false, locale: 'en',
  images: [{ name: 'a.png', mime: 'image/png', role: 'hero', bytes: new Uint8Array(1) }],
  files: [{ name: 'd.stl', mime: 'model/stl', bytes: new Uint8Array(1) }], ...over,
});
const ctx = {
  files: [{ name: 'd.stl', mime: 'x', bytes: new Uint8Array(1), url: 'https://t/d.stl' }],
  images: [{ name: 'a.png', mime: 'image/png', role: 'hero', bytes: new Uint8Array(1), url: 'https://t/a.png' }],
};

test('contract + describe', () => {
  assertAdapter(a);
  assert.equal(ADAPTERS[0], a);
  const d = a.describe();
  assert.deepEqual([d.id, d.transfer, d.maxFiles, d.maxImages, d.credentials], ['cults3d', 'url', 10, 10, ['nickname', 'apiKey']]);
  assert.equal(a.buildConfirm, undefined);
});

test('base64 + authHeaders', () => {
  assert.equal(base64Utf8('Man'), 'TWFu');
  assert.equal(base64Utf8('Ma'), 'TWE=');
  assert.equal(base64Utf8('M'), 'TQ==');
  assert.equal(base64Utf8('é:ü'), Buffer.from('é:ü').toString('base64'));
  assert.equal(a.authHeaders({ nickname: 'nick', apiKey: 'k:ey' }).Authorization, `Basic ${Buffer.from('nick:k:ey').toString('base64')}`);
});

test('validate', () => {
  assert.deepEqual(a.validate(pkg()), []);
  assert.equal(a.validate(pkg({ files: [{ name: 'a.zip', mime: 'x', bytes: new Uint8Array(1) }] }))[0].code, 'no-printable-file');
  assert.equal(a.validate(pkg({ files: [{ name: 'a.exe', mime: 'x', bytes: new Uint8Array(1) }, { name: 'b.stl', mime: 'x', bytes: new Uint8Array(1) }] }))[0].code, 'file-type-unsupported');
  assert.equal(a.validate(pkg({ images: [{ name: 'a.gif', mime: 'image/gif', role: 'hero', bytes: new Uint8Array(1) }] }))[0].code, 'image-type-unsupported');
});

test('buildCreate uses variables and hosted urls', () => {
  const r = a.buildCreate(pkg(), ctx);
  assert.equal(r.url, 'https://cults3d.com/graphql');
  assert.match(r.body.query, /^mutation CreateCreation\(\$name: String!/);
  assert.match(r.body.query, /createCreation\(name: \$name,/);
  assert.ok(!r.body.query.includes('Dragon'));
  assert.deepEqual(r.body.variables.fileUrls, ['https://t/d.stl']);
  assert.deepEqual(r.body.variables.imageUrls, ['https://t/a.png']);
  assert.equal(r.body.variables.downloadPrice, 4.5);
  assert.equal(r.body.variables.currency, 'EUR');
  assert.equal(r.body.variables.locale, 'EN');
  assert.ok(!('visibility' in r.body.variables));
  const free = a.buildCreate(pkg({ price: null, license: null, categoryHint: null, tags: [] }), ctx).body;
  assert.ok(!/downloadPrice|currency|licenseCode|categoryId|tagNames/.test(free.query));
  assert.throws(() => a.buildCreate(pkg(), { ...ctx, files: [{ ...ctx.files[0], url: undefined }] }), /public link/);
});

test('buildUpdate', () => {
  const r = a.buildUpdate('C1', pkg(), ctx);
  assert.match(r.body.query, /^mutation UpdateCreation\(\$id: ID!/);
  assert.equal(r.body.variables.id, 'C1');
  assert.ok(!('fileUrls' in r.body.variables));
});

test('parseResult success + error mapping', () => {
  const ok = a.parseResult({ status: 200, ok: true, headers: {}, text: '', json: { data: { createCreation: { creation: { id: 'X', url: 'https://c/x' }, errors: [] } } } });
  assert.deepEqual(ok, { remoteId: 'X', url: 'https://c/x', status: 'submitted' });
  const bad = (json, status = 200) => {
    try { a.parseResult({ status, ok: status < 400, headers: {}, text: '', json }); } catch (e) { return e; }
    return null;
  };
  assert.equal(bad({ errors: [{ message: 'Unknown argument' }] }).issues[0].code, 'graphql-error');
  const e2 = bad({ data: { createCreation: { creation: null, errors: ['Name is too short'] } } });
  assert.deepEqual(e2.issues.map((i) => i.code), ['creation-error']);
  assert.match(e2.message, /Name is too short/);
  assert.equal(bad(null, 422).issues[0].code, 'bad-response');
  assert.equal(bad({ data: { createCreation: { creation: null, errors: [] } } }).issues[0].code, 'no-creation');
});

test('testConnection', () => {
  const r = a.testConnection();
  assert.equal(r.method, 'POST');
  assert.match(r.body.query, /myself/);
});
