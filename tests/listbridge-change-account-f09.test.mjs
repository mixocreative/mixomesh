// cia F-09: "Change account" with a typo, or while offline, must not delete the account that works.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as core from '../src/listbridge/index.js';

const require = createRequire(import.meta.url);
const { registerListbridgeIpc } = require('../electron/listbridge/index.cjs');

function main() {
  const net = { online: true, goodAuth: `Basic ${Buffer.from('nick:GOOD').toString('base64')}` };
  const handlers = new Map();
  registerListbridgeIpc((c, fn) => handlers.set(c, fn), {
    userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'lb-f09-')),
    safeStorage: { isEncryptionAvailable: () => true, encryptString: s => Buffer.from(s), decryptString: b => b.toString() },
    adapters: [core.cults3dAdapter], loadCore: async () => core, sleep: async () => {},
    fetchImpl: async (_url, init) => {
      if (!net.online) throw new TypeError('fetch failed (getaddrinfo ENOTFOUND cults3d.com)');
      const ok = init.headers.Authorization === net.goodAuth;
      return { status: ok ? 200 : 401, headers: new Map(), text: async () => JSON.stringify(ok ? { data: { me: { nick: 'nick' } } } : {}) };
    },
  });
  return { net, call: (c, ...a) => handlers.get(c)({ sender: { id: 1 } }, ...a) };
}

test('a new key that fails its test is not saved; the working account stays', async () => {
  const { call } = main();
  assert.equal((await call('publish:setCredentials', 'cults3d:default', { nickname: 'nick', apiKey: 'GOOD' })).ok, true);
  const typo = await call('publish:setCredentials', 'cults3d:default', { nickname: 'nick', apiKey: 'G00D' });
  assert.equal(typo.ok, false);
  assert.equal(await call('publish:hasCredentials', 'cults3d:default'), true);
  assert.equal((await call('publish:testConnection', 'cults3d:default')).ok, true, 'the saved record is still the working one');
});

test('changing the account while offline keeps the working account', async () => {
  const { call, net } = main();
  await call('publish:setCredentials', 'cults3d:default', { nickname: 'nick', apiKey: 'GOOD' });
  net.online = false;
  const r = await call('publish:setCredentials', 'cults3d:default', { nickname: 'nick', apiKey: 'NEW' });
  assert.equal(r.ok, false);
  net.online = true;
  assert.equal((await call('publish:testConnection', 'cults3d:default')).ok, true);
});
