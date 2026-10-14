// PB.0a: the Cults3D introspection reporter, driven by a fixture. No network.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import { buildFindings, readCredentials, main } from '../scripts/cults-introspect.mjs';

const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/cults3d-introspection-sample.json', import.meta.url), 'utf8'));
const md = buildFindings(fixture, { headers: { 'x-ratelimit-remaining': '29', 'content-type': 'x', 'retry-after': '5' } });

test('findings has the six sections in order', () => {
  const heads = [...md.matchAll(/^## (\d)\./gm)].map((m) => m[1]);
  assert.deepEqual(heads, ['1', '2', '3', '4', '5', '6']);
});
test('section 1: args, nested inputs, visibility enum', () => {
  assert.match(md, /`price\.currency`: `CurrencyEnum`/);
  assert.match(md, /`visibility`: `VisibilityEnum` \(enum: DRAFT, PUBLISHED\)/);
  assert.match(md, /Description-format fields: `description`/);
  assert.match(md, /### updateCreation/);
});
test('section 2: license enum values and categories query', () => {
  assert.match(md, /`LicenseEnum`: CC_BY, PERSONAL/);
  assert.match(md, /categories\(\): \[Category\]/);
});
test('section 3: AI field detected', () => assert.match(md, /createCreation\(aiGenerated: Boolean\)/));
test('section 4: upload mutation found, tunnel becomes fallback', () => {
  assert.match(md, /createSignedUpload\(filename: String\)/);
  assert.match(md, /tunnel becomes a fallback/);
});
test('section 5: read-back queries and Creation status fields', () => {
  assert.match(md, /myCreations\(limit: Int\)/);
  assert.match(md, /Not present: creations/);
  assert.match(md, /`publishedStatus: String`/);
});
test('section 6: only rate-limit headers listed', () => {
  assert.match(md, /`x-ratelimit-remaining`: `29`/);
  assert.match(md, /`retry-after`/);
  assert.doesNotMatch(md, /content-type/);
});
test('upload verdict flips when absent', () => {
  const copy = structuredClone(fixture);
  const m = copy.data.__schema.types.find((t) => t.name === 'Mutation');
  m.fields = m.fields.filter((f) => f.name !== 'createSignedUpload');
  assert.match(buildFindings(copy), /no native upload path found/);
});
test('missing env: exit 2, no request', async () => {
  let calls = 0;
  const origErr = console.error;
  console.error = () => {};
  const code = await main({}, () => { calls++; });
  console.error = origErr;
  assert.equal(code, 2);
  assert.equal(calls, 0);
  assert.equal(readCredentials({ CULTS_USER: 'a' }), null);
});
