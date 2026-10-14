import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cults3dAdapter as a, ADAPTERS, createListing, assertAdapter } from '../src/listbridge/index.js';
import { base64Utf8, localeEnum } from '../src/listbridge/adapters/cults3d.js';

const pkg = (over = {}) => createListing({
  title: 'Dragon', description: 'Nice', tags: ['dragon', 'bust'], price: { amount: 4.5, currency: 'eur' },
  license: 'cults_cu', categoryHint: 'Q2F0', madeWithAi: false, locale: 'en',
  images: [{ name: 'a.png', mime: 'image/png', role: 'hero', bytes: new Uint8Array(1) }],
  files: [{ name: 'd.stl', mime: 'model/stl', bytes: new Uint8Array(1) }], ...over,
});
const keyed = {
  files: [{ name: 'd.stl', mime: 'x', bytes: new Uint8Array(1), key: 'cache/f/d.stl' }],
  images: [{ name: 'a.png', mime: 'image/png', role: 'hero', bytes: new Uint8Array(1), key: 'cache/i/a.png' }],
};
const hosted = {
  files: [{ name: 'd.stl', mime: 'x', bytes: new Uint8Array(1), url: 'https://t/d.stl' }],
  images: [{ name: 'a.png', mime: 'image/png', role: 'hero', bytes: new Uint8Array(1), url: 'https://t/a.png' }],
};
const res = (json, status = 200) => ({ status, ok: status < 400, headers: {}, text: '', json });

test('contract + describe (direct upload slots, tunnel as fallback)', () => {
  assertAdapter(a);
  assert.equal(ADAPTERS[0], a);
  const d = a.describe();
  assert.deepEqual([d.id, d.transfer, d.maxFiles, d.maxImages, d.credentials], ['cults3d', 'direct', 10, 10, ['nickname', 'apiKey']]);
  assert.deepEqual(d.transfers, ['direct', 'url']);
  assert.deepEqual(d.visibility, ['secret', 'public']);
  assert.equal(d.drafts, true);
  assert.equal(d.currencies.length, 26);
  assert.deepEqual(d.requires, ['categoryHint', 'license']);
  assert.equal(typeof a.buildConfirm, 'function');
  assert.equal(typeof a.buildUploadSlot, 'function');
  assert.equal(typeof a.buildListOptions, 'function');
});

test('base64 + authHeaders', () => {
  assert.equal(base64Utf8('Man'), 'TWFu');
  assert.equal(base64Utf8('Ma'), 'TWE=');
  assert.equal(base64Utf8('M'), 'TQ==');
  assert.equal(base64Utf8('é:ü'), Buffer.from('é:ü').toString('base64'));
  assert.equal(a.authHeaders({ nickname: 'nick', apiKey: 'k:ey' }).Authorization, `Basic ${Buffer.from('nick:k:ey').toString('base64')}`);
});

test('locale mapping: app locales to LocaleEnum', () => {
  assert.equal(localeEnum('en'), 'EN');
  assert.equal(localeEnum('ja'), 'JA');
  assert.equal(localeEnum('zh-Hant'), 'ZH');
  assert.equal(localeEnum('zh-TW'), 'ZH');
  assert.equal(localeEnum('de-AT'), 'DE');
  assert.equal(localeEnum('xx'), 'EN');
  assert.equal(localeEnum(''), 'EN');
});

test('validate: files, images, category + license required', () => {
  assert.deepEqual(a.validate(pkg()), []);
  assert.equal(a.validate(pkg({ files: [{ name: 'a.zip', mime: 'x', bytes: new Uint8Array(1) }] }))[0].code, 'no-printable-file');
  assert.equal(a.validate(pkg({ files: [{ name: 'a.exe', mime: 'x', bytes: new Uint8Array(1) }, { name: 'b.stl', mime: 'x', bytes: new Uint8Array(1) }] }))[0].code, 'file-type-unsupported');
  assert.equal(a.validate(pkg({ images: [{ name: 'a.gif', mime: 'image/gif', role: 'hero', bytes: new Uint8Array(1) }] }))[0].code, 'image-type-unsupported');
  assert.deepEqual(a.validate(pkg({ categoryHint: null, license: null })).map((i) => i.code), ['category-required', 'license-required']);
});

test('buildCreate: live-schema arguments with upload keys', () => {
  const r = a.buildCreate(pkg(), keyed);
  assert.equal(r.url, 'https://cults3d.com/graphql');
  assert.match(r.body.query, /^mutation CreateCreation\(\$name: String!/);
  assert.match(r.body.query, /createCreation\(name: \$name,/);
  assert.match(r.body.query, /\$categoryId: ID!/);
  assert.ok(!r.body.query.includes('Dragon'));
  const v = r.body.variables;
  assert.deepEqual(v.fileKeys, ['cache/f/d.stl']);
  assert.deepEqual(v.imageKeys, ['cache/i/a.png']);
  assert.ok(!('fileUrls' in v) && !('imageUrls' in v));
  assert.equal(v.downloadPrice, 4.5);
  assert.equal(v.currency, 'EUR');
  assert.equal(v.locale, 'EN');
  assert.equal(v.categoryId, 'Q2F0');
  assert.equal(v.licenseCode, 'cults_cu');
  assert.deepEqual(v.usages, ['3dp']);
  assert.equal(v.madeWithAi, false);
  assert.equal(v.visibility, 'SECRET');   // first publish is secret by default
  assert.equal(a.buildCreate(pkg({ visibility: 'public' }), keyed).body.variables.visibility, 'PUBLIC');
  assert.equal(a.buildCreate(pkg({ madeWithAi: true, locale: 'zh-Hant', subCategoryIds: ['S1'] }), keyed).body.variables.madeWithAi, true);
  const z = a.buildCreate(pkg({ locale: 'zh-Hant', subCategoryIds: ['S1'] }), keyed).body.variables;
  assert.equal(z.locale, 'ZH');
  assert.deepEqual(z.subCategoryIds, ['S1']);
  const free = a.buildCreate(pkg({ price: null, tags: [] }), keyed).body;
  assert.ok(!/downloadPrice|currency|tagNames/.test(free.query));
});

test('buildCreate: public links still work (tunnel fallback); neither key nor link throws', () => {
  const r = a.buildCreate(pkg(), hosted);
  assert.deepEqual(r.body.variables.fileUrls, ['https://t/d.stl']);
  assert.deepEqual(r.body.variables.imageUrls, ['https://t/a.png']);
  assert.ok(!('fileKeys' in r.body.variables));
  assert.throws(() => a.buildCreate(pkg(), { ...keyed, files: [{ ...keyed.files[0], key: undefined }] }), /uploaded key or a public link/);
});

test('buildUpdate: metadata only, optional-typed arguments', () => {
  const r = a.buildUpdate('C1', pkg(), keyed);
  assert.match(r.body.query, /^mutation UpdateCreation\(\$id: ID!/);
  assert.match(r.body.query, /\$name: String,/);
  assert.match(r.body.query, /\$categoryId: ID,/);
  assert.equal(r.body.variables.id, 'C1');
  assert.equal(r.body.variables.visibility, 'SECRET');
  for (const k of ['fileUrls', 'fileKeys', 'imageUrls', 'imageKeys']) assert.ok(!(k in r.body.variables));
});

test('upload slot: request + parse (key from the key field, ${filename} substituted)', () => {
  assert.match(a.buildUploadSlot('file', { name: 'd.stl', mime: 'x' }).body.query, /createFileUploader/);
  assert.match(a.buildUploadSlot('image', { name: 'a.png', mime: 'x' }).body.query, /createImageUploader/);
  const slot = a.parseUploadSlot(res({ data: { createFileUploader: { errors: [], uploader: { url: 'https://s3.example/b', fields: [{ name: 'key', value: 'u/1/${filename}' }, { name: 'policy', value: 'P' }] } } } }), { name: 'd.stl' });
  assert.deepEqual(slot, { url: 'https://s3.example/b', fields: [{ name: 'key', value: 'u/1/${filename}' }, { name: 'policy', value: 'P' }], key: 'u/1/d.stl' });
  const noName = a.parseUploadSlot(res({ data: { createImageUploader: { errors: [], uploader: { url: 'https://s3.example/b', fields: [{ name: 'Key', value: 'u/2/x.png' }] } } } }));
  assert.equal(noName.key, 'u/2/x.png');
  const fail = (json) => { try { a.parseUploadSlot(res(json)); } catch (e) { return e; } return null; };
  assert.equal(fail({ data: { createFileUploader: { errors: ['quota'], uploader: null } } }).code, 'upload-slot-failed');
  assert.match(fail({ data: { createFileUploader: { errors: ['quota'], uploader: null } } }).message, /quota/);
  assert.equal(fail({ errors: [{ message: 'nope' }] }).code, 'upload-slot-failed');
  assert.equal(fail({ data: { createFileUploader: { errors: [], uploader: { url: 'http://insecure/b', fields: [] } } } }).issues[0].code, 'no-upload-slot');
  assert.equal(fail({ data: { createFileUploader: { errors: [], uploader: { url: 'https://s3/b', fields: [{ name: 'policy', value: 'P' }] } } } }).issues[0].code, 'no-upload-key');
});

test('parseResult success + error mapping', () => {
  const ok = a.parseResult(res({ data: { createCreation: { creation: { id: 'X', slug: 'dragon', url: 'https://c/x', visibility: 'SECRET' }, errors: [] } } }));
  assert.deepEqual(ok, { remoteId: 'X', url: 'https://c/x', status: 'secret', slug: 'dragon' });
  assert.equal(a.parseResult(res({ data: { updateCreation: { creation: { id: 'X', slug: 's', url: 'u', visibility: 'PUBLIC' }, errors: [] } } })).status, 'published');
  const bad = (json, status = 200) => {
    try { a.parseResult(res(json, status)); } catch (e) { return e; }
    return null;
  };
  assert.equal(bad({ errors: [{ message: 'Unknown argument' }] }).issues[0].code, 'graphql-error');
  const e2 = bad({ data: { createCreation: { creation: null, errors: ['Name is too short'] } } });
  assert.deepEqual(e2.issues.map((i) => i.code), ['creation-error']);
  assert.match(e2.message, /Name is too short/);
  assert.equal(bad(null, 422).issues[0].code, 'bad-response');
  assert.equal(bad({ data: { createCreation: { creation: null, errors: [] } } }).issues[0].code, 'no-creation');
});

test('confirm: blueprints cover the model files, illustrations cover the images', () => {
  const req = a.buildConfirm({ remoteId: 'X', slug: 'dragon', url: 'u', status: 'secret' });
  assert.match(req.body.query, /creation\(slug: \$slug\)/);
  assert.deepEqual(req.body.variables, { slug: 'dragon' });
  assert.throws(() => a.buildConfirm({ remoteId: 'X', url: '', status: 's' }), /slug/);
  const ctx = { files: [{ name: 'a.stl' }, { name: 'b.obj' }, { name: 'c.pdf' }], images: [{ name: 'h.png' }] };
  const reply = (blueprints, illustrations, vis = 'SECRET') => res({ data: { creation: { id: 'X', slug: 'd', url: 'https://c/d', visibility: vis, blueprints: blueprints.map((id) => ({ id })), illustrations: illustrations.map((id) => ({ id })) } } });
  assert.equal(a.parseConfirm(reply(['1'], ['i']), ctx).confirmed, false);                  // 1 of 2 model files
  assert.equal(a.parseConfirm(reply(['1', '2'], []), ctx).confirmed, false);                // no image yet
  const done = a.parseConfirm(reply(['1', '2'], ['i'], 'PUBLIC'), ctx);
  assert.deepEqual(done, { confirmed: true, status: 'published', url: 'https://c/d' });
  assert.equal(a.parseConfirm(res({ data: { creation: null } }), ctx).confirmed, false);
  assert.equal(a.parseConfirm(reply([], []), { ...ctx, update: true }).confirmed, true);    // updates re-send no files
  assert.throws(() => a.parseConfirm(res({ errors: [{ message: 'boom' }] }), ctx), /boom/);
});

test('list options: one query, parsed to categories + licenses', () => {
  const reqs = a.buildListOptions({ locale: 'ja' });
  assert.equal(reqs.length, 1);
  assert.match(reqs[0].body.query, /licenses \{ code name\(locale: JA\) allowsCommercialUse availableOnFreeDesigns availableOnPricedDesigns \}/);
  assert.match(reqs[0].body.query, /categories \{ id name\(locale: JA\) children/);
  const out = a.parseListOptions([res({ data: {
    categories: [{ id: 'C1', name: 'Art', children: [{ id: 'C2', name: 'Busts' }] }, { id: 'C3', name: 'Toys', children: [] }],
    licenses: [{ code: 'cults_cu', name: 'Personal', allowsCommercialUse: false, availableOnFreeDesigns: true, availableOnPricedDesigns: true },
      { code: 'cc0', name: 'CC0', allowsCommercialUse: true, availableOnFreeDesigns: true, availableOnPricedDesigns: false }],
  } })]);
  assert.deepEqual(out.categories[0], { id: 'C1', name: 'Art', children: [{ id: 'C2', name: 'Busts' }] });
  assert.deepEqual(out.licenses[1], { code: 'cc0', name: 'CC0', free: true, priced: false, commercial: true });
  assert.throws(() => a.parseListOptions([res({ errors: [{ message: 'denied' }] })]), /denied/);
  assert.throws(() => a.parseListOptions([res(null, 500)]), /could not load/);
});

test('testConnection asks for me { nick }', () => {
  const r = a.testConnection();
  assert.equal(r.method, 'POST');
  assert.match(r.body.query, /me \{ nick \}/);
});
