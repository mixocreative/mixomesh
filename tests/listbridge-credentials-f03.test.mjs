// cia F-03: a credential file this Windows account can no longer decrypt (password reset, profile
// copied to a new PC, restored backup) must not lock the seller out: Connect works again, and the
// app says once that the saved accounts were reset. The unreadable file is kept aside, not deleted.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as core from '../src/listbridge/index.js';

const require = createRequire(import.meta.url);
const { createCredentialStore } = require('../electron/listbridge/credentials.cjs');
const { registerListbridgeIpc } = require('../electron/listbridge/index.cjs');

const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: s => Buffer.from(`enc:${s}`),
  decryptString: b => {
    const s = b.toString();
    if (!s.startsWith('enc:')) throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.');
    return s.slice(4);
  },
};

function strandedFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lb-f03-'));
  fs.writeFileSync(path.join(dir, 'listbridge-credentials.bin'), Buffer.from('opaque-dpapi-blob-from-another-profile'));
  return dir;
}

test('after a decrypt failure, connecting again works and the old file is kept aside', async () => {
  const dir = strandedFile();
  const store = createCredentialStore({ filePath: path.join(dir, 'listbridge-credentials.bin'), safeStorage });
  assert.equal(await store.has('cults3d:default'), false, 'an unreadable store reads as "not connected", not as an error');
  await store.set('cults3d:default', { nickname: 'n', apiKey: 'k' });
  assert.equal(await store.has('cults3d:default'), true);
  assert.ok(fs.readdirSync(dir).some(n => /^listbridge-credentials\.bin\.corrupt-/.test(n)), 'the unreadable file is renamed, not deleted');
});

test('the Publish tab is told once that saved accounts were reset', async () => {
  const dir = strandedFile();
  const handlers = new Map();
  registerListbridgeIpc((c, fn) => handlers.set(c, fn), {
    userDataDir: dir, safeStorage, adapters: [core.cults3dAdapter], fetchImpl: async () => { throw new Error('no network'); }, loadCore: async () => core,
  });
  const call = (c, ...a) => handlers.get(c)({ sender: { id: 1 } }, ...a);
  assert.equal((await call('publish:describe')).credentialsReset, true);
  assert.equal(await call('publish:hasCredentials', 'cults3d:default'), false);
  assert.deepEqual(await call('publish:setCredentials', 'cults3d:default', { nickname: 'n', apiKey: 'k' }), { ok: true });
  assert.equal((await call('publish:describe')).credentialsReset, undefined, 'said once');
});
