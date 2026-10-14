import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeListing, normalizeListings, upsertListing, findListing } from '../src/core/publish/Listings.js';
import { installEnv } from './env.mjs';

installEnv();
const { migrate } = await import('../src/core/persist/ProjectLoader.js');
const { SCHEMA_VERSION } = await import('../src/core/persist/constants.js');

const base = { platform: 'cults3d', accountId: 'a1', title: 'Dragon', status: 'draft' };

test('schema version is 3.5', () => assert.equal(SCHEMA_VERSION, '3.5'));

test('normalizeListing fills defaults and coerces types', () => {
  const r = normalizeListing({ ...base, price: '4.5', tags: ['a', 3, '', 'b'], madeWithAi: 'yes', status: 'bogus', publishedAt: 'nope', fileNames: 'x' });
  assert.equal(r.price, 4.5);
  assert.deepEqual(r.tags, ['a', 'b']);
  assert.equal(r.madeWithAi, false);
  assert.equal(r.status, 'draft');
  assert.equal(r.publishedAt, null);
  assert.deepEqual(r.fileNames, []);
  assert.equal(r.remoteId, null);
  assert.equal(r.description, '');
});

test('normalizeListing strips unknown and secret-like keys', () => {
  const r = normalizeListing({ ...base, apiKey: 'k', secret: 's', token: 't', password: 'p', access_token: 'x', extra: 1, bytes: new Uint8Array(3) });
  for (const k of ['apiKey', 'secret', 'token', 'password', 'access_token', 'extra', 'bytes']) assert.equal(k in r, false, k);
  assert.ok(!JSON.stringify(r).includes('"k"'));
});

test('normalizeListing rejects non-objects and platform-less records', () => {
  assert.equal(normalizeListing(null), null);
  assert.equal(normalizeListing({ title: 'x' }), null);
  assert.deepEqual(normalizeListings('x'), []);
});

test('upsert: draft updated in place, then promoted by remoteId without duplicating', () => {
  let l = upsertListing([], base);
  l = upsertListing(l, { ...base, title: 'Dragon v2' });
  assert.equal(l.length, 1);
  assert.equal(l[0].title, 'Dragon v2');
  l = upsertListing(l, { ...base, title: 'Dragon v2', remoteId: 'R1', status: 'published' });
  assert.equal(l.length, 1);
  assert.equal(l[0].remoteId, 'R1');
  l = upsertListing(l, { ...base, title: 'Dragon v3', remoteId: 'R1', status: 'published' });
  assert.equal(l.length, 1, 'published listing is never duplicated');
  assert.equal(l[0].title, 'Dragon v3');
});

test('upsert: different account or remoteId is a separate listing; input not mutated', () => {
  const a = upsertListing([], { ...base, remoteId: 'R1', status: 'published' });
  const snap = JSON.stringify(a);
  const b = upsertListing(a, { ...base, accountId: 'a2' });
  assert.equal(b.length, 2);
  const c = upsertListing(b, { ...base, remoteId: 'R2', status: 'published' });
  assert.equal(c.length, 3);
  assert.equal(JSON.stringify(a), snap);
});

test('findListing by platform + account', () => {
  const l = upsertListing(upsertListing([], base), { ...base, accountId: 'a2', title: 'Other' });
  assert.equal(findListing(l, 'cults3d', 'a2').title, 'Other');
  assert.equal(findListing(l, 'cults3d', 'zz'), null);
  assert.equal(findListing(undefined, 'cults3d'), null);
});

test('migrate 3.4 -> 3.5 adds listings [] and stamps version', () => {
  const doc = { version: '3.4', project: { name: 'P', id: 'x' } };
  const m = migrate(doc);
  assert.equal(m.version, '3.5');
  assert.deepEqual(m.project.listings, []);
  assert.equal('listings' in doc.project, false, 'caller doc untouched');
  assert.deepEqual(migrate({ version: '3.4' }).project.listings, []);
});

test('migrate normalizes listings already present; idempotent; future minor untouched', () => {
  const m = migrate({ version: '3.4', project: { listings: [{ ...base, token: 'zzz' }, 7] } });
  assert.equal(m.project.listings.length, 1);
  assert.equal('token' in m.project.listings[0], false);
  assert.deepEqual(migrate(m), m);
  const f = migrate({ version: '3.6', project: { name: 'F' } });
  assert.equal(f.version, '3.6');
  assert.equal('listings' in f.project, false);
});
