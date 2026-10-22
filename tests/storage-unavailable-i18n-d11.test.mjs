// cia D-11: the Safari / iPad storage boot gate explains itself in the user's
// language, not in hard-coded English. The adapter names the text; the boot
// screen translates it after the locale is detected.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installOpfsEnv } from './opfs-stub.mjs';

const { OpfsStorageAdapter } = await import('../src/core/storage/OpfsStorageAdapter.js');
const locale = (name) => JSON.parse(readFileSync(new URL(`../src/i18n/locales/${name}.json`, import.meta.url), 'utf8'));
const [en, ja, zh] = ['en', 'ja', 'zh-Hant'].map(locale);

async function gateError(root) {
  const env = installOpfsEnv({ root });
  try { return await OpfsStorageAdapter.ready().then(() => null, e => e); }
  finally { env.restore(); }
}

test('a refused private file storage names a text that every locale translates', async () => {
  const err = await gateError(null);
  assert.ok(err?.storageUnavailable, 'the boot gate blocks');
  assert.equal(err.textKey, 'storage.opfs.unavailable');
  for (const part of ['title', 'body']) {
    const key = `${err.textKey}.${part}`;
    assert.ok(en[key], `${key} exists`);
    assert.notEqual(ja[key], en[key], `${key} is translated to Japanese`);
    assert.notEqual(zh[key], en[key], `${key} is translated to Traditional Chinese`);
  }
});

test('the boot screen detects the locale first and shows the translated text', () => {
  const main = readFileSync(new URL('../src/app/main.ts', import.meta.url), 'utf8');
  const gate = main.slice(main.indexOf('async function gateStorage'), main.indexOf('async function bootstrap'));
  assert.ok(gate.indexOf('i18n.init()') >= 0 && gate.indexOf('i18n.init()') < gate.indexOf('storage.ready()'),
    'i18n.init() runs before storage.ready()');
  assert.match(gate, /i18n\.t\(`\$\{e\.textKey\}\.title`\)/, 'the screen title is translated from the key');
});
