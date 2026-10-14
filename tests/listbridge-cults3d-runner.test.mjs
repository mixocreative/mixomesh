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
  const { call, seen } = setup(() => (mode.v === 'ok' ? { status: 200, body: { data: { myself: { user: { nick: 'me' } } } } }
    : mode.v === 'gql' ? { status: 200, body: { errors: [{ message: 'nope' }] } } : { status: 401, body: {} }));
  assert.equal((await call('publish:testConnection', 'cults3d:me')).ok, false);   // no creds yet
  assert.deepEqual(await call('publish:setCredentials', 'cults3d:me', { nickname: 'nick', apiKey: KEY }), { ok: true });
  const r = await call('publish:testConnection', 'cults3d:me');
  assert.equal(r.ok, true);
  const hdr = seen.at(-1).init.headers;
  assert.equal(hdr.Authorization, `Basic ${Buffer.from(`nick:${KEY}`).toString('base64')}`);
  assert.equal(seen.at(-1).url, 'https://cults3d.com/graphql');
  assert.match(JSON.parse(seen.at(-1).init.body).query, /myself/);
  mode.v = 'gql';
  assert.equal((await call('publish:testConnection', 'cults3d:me')).ok, false);
  mode.v = '401';
  const bad = await call('publish:testConnection', 'cults3d:me');
  assert.equal(bad.ok, false);
  assert.ok(!JSON.stringify(bad).includes(KEY));
});
