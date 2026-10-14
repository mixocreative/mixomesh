// Cults3D adapter through the real runner wiring: publish:describe + publish:testConnection
// against a fake GraphQL server (fake fetch). node --test tests/listbridge-cults3d-runner.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as core from '../src/listbridge/index.js';

const require = createRequire(import.meta.url);
const { registerListbridgeIpc } = require('../electron/listbridge/index.cjs');
const KEY = 'CULTS_SECRET_KEY_987';

const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(`ENC:${Buffer.from(s).reverse().toString('latin1')}`, 'latin1'),
  decryptString: (b) => Buffer.from(b.toString('latin1').slice(4), 'latin1').reverse().toString('utf8'),
};

function setup(responder) {
  const handlers = new Map();
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, init });
    const r = responder(init);
    const text = JSON.stringify(r.body ?? {});
    return { ok: r.status < 400, status: r.status, headers: new Map(), text: async () => text, json: async () => JSON.parse(text) };
  };
  registerListbridgeIpc((c, fn) => handlers.set(c, fn), {
    userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'lb-c3d-')), safeStorage,
    adapters: core.ADAPTERS, fetchImpl, loadCore: async () => core, sleep: async () => {},
  });
  return { call: (c, ...a) => handlers.get(c)({ sender: { id: 1 } }, ...a), seen };
}

test('describe lists cults3d first and flags testConnection', async () => {
  const { call } = setup(() => ({ status: 200 }));
  const d = await call('publish:describe');
  assert.equal(d.platforms[0].id, 'cults3d');
  assert.equal(d.platforms[0].testConnection, true);
  assert.deepEqual(d.platforms[0].credentials, ['nickname', 'apiKey']);
});

test('testConnection: ok / graphql error / 401, sends Basic auth', async () => {
  const mode = { v: 'ok' };
  const { call, seen } = setup(() => (mode.v === 'ok' ? { status: 200, body: { data: { me: { nick: "me" } } } }
    : mode.v === 'gql' ? { status: 200, body: { errors: [{ message: 'nope' }] } } : { status: 401, body: {} }));
  assert.equal((await call('publish:testConnection', 'cults3d:me')).ok, false);   // no creds yet
  assert.deepEqual(await call('publish:setCredentials', 'cults3d:me', { nickname: 'nick', apiKey: KEY }), { ok: true });
  const r = await call('publish:testConnection', 'cults3d:me');
  assert.equal(r.ok, true);
  const hdr = seen.at(-1).init.headers;
  assert.equal(hdr.Authorization, `Basic ${Buffer.from(`nick:${KEY}`).toString('base64')}`);
  assert.equal(seen.at(-1).url, 'https://cults3d.com/graphql');
  assert.match(JSON.parse(seen.at(-1).init.body).query, /me { nick }/);
  mode.v = 'gql';
  assert.equal((await call('publish:testConnection', 'cults3d:me')).ok, false);
  mode.v = '401';
  const bad = await call('publish:testConnection', 'cults3d:me');
  assert.equal(bad.ok, false);
  assert.ok(!JSON.stringify(bad).includes(KEY));
});

test('publish:describe carries the upload / visibility / list-options capabilities', async () => {
  const { call } = setup(() => ({ status: 200 }));
  const p = (await call('publish:describe')).platforms[0];
  assert.equal(p.transfer, 'direct');
  assert.deepEqual(p.transfers, ['direct', 'url']);
  assert.deepEqual(p.visibility, ['secret', 'public']);
  assert.equal(p.drafts, true);
  assert.equal(p.listOptions, true);
  assert.deepEqual(p.requires, ['categoryHint', 'license']);
});

test('publish:listOptions: needs credentials, parses, caches 10 min per platform+locale, never throws', async () => {
  let hits = 0;
  let mode = 'ok';
  const body = { data: {
    categories: [{ id: 'C1', name: 'Art', children: [{ id: 'C2', name: 'Busts' }] }],
    licenses: [{ code: 'cults_cu', name: 'Personal', allowsCommercialUse: false, availableOnFreeDesigns: true, availableOnPricedDesigns: true }],
  } };
  const { call, seen } = setup(() => { hits++; return mode === 'ok' ? { status: 200, body } : mode === '401' ? { status: 401, body: {} } : { status: 200, body: { errors: [{ message: 'boom' }] } }; });
  assert.deepEqual(await call('publish:listOptions', 'cults3d', 'en'), { ok: false, message: 'No saved credentials for this account.' });
  assert.equal(hits, 0);
  await call('publish:setCredentials', 'cults3d:default', { nickname: 'nick', apiKey: KEY });
  const r = await call('publish:listOptions', 'cults3d', 'ja');
  assert.equal(r.ok, true);
  assert.deepEqual(r.categories[0].children, [{ id: 'C2', name: 'Busts' }]);
  assert.deepEqual(r.licenses[0], { code: 'cults_cu', name: 'Personal', free: true, priced: true, commercial: false });
  assert.match(JSON.parse(seen.at(-1).init.body).query, /name\(locale: JA\)/);
  assert.equal(seen.at(-1).init.headers.Authorization, `Basic ${Buffer.from(`nick:${KEY}`).toString('base64')}`);
  assert.deepEqual(await call('publish:listOptions', 'cults3d', 'ja'), r);
  assert.equal(hits, 1, 'second call is served from the cache');
  await call('publish:listOptions', 'cults3d', 'en');
  assert.equal(hits, 2, 'another locale is another cache entry');
  await call('publish:setCredentials', 'cults3d:default', { nickname: 'nick', apiKey: KEY });
  await call('publish:listOptions', 'cults3d', 'ja');
  assert.equal(hits, 3, 'saving credentials drops the cache');
  mode = '401'; await call('publish:setCredentials', 'cults3d:default', { nickname: 'nick', apiKey: KEY });
  const bad = await call('publish:listOptions', 'cults3d', 'ja');
  assert.deepEqual([bad.ok, bad.message], [false, 'The platform rejected these credentials.']);
  mode = 'gql'; await call('publish:setCredentials', 'cults3d:default', { nickname: 'nick', apiKey: KEY });
  const g = await call('publish:listOptions', 'cults3d', 'ja');
  assert.equal(g.ok, false);
  assert.match(g.message, /boom/);
  assert.ok(!JSON.stringify([bad, g]).includes(KEY));
  await assert.rejects(call('publish:listOptions', 'nope', 'en'), /unknown platform/);
});
