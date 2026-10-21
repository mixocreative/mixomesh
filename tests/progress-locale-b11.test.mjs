// cia B-11: a Japanese or Traditional Chinese user reads the export and import
// progress overlay in their language, not hard-coded English.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installEnv } from './env.mjs';
import ja from '../src/i18n/locales/ja.json' with { type: 'json' };

installEnv();
document.documentElement ??= { setAttribute() {} };
const { setLocale } = await import('../src/i18n/index.js');
const { buildExportBlob } = await import('../src/core/print/PrintPackaging.js');

test('the export packaging step is reported in the user locale', async () => {
  setLocale('ja');
  const seen = [];
  await buildExportBlob({ kind: 'zip', mime: 'application/zip', entries: [{ path: 'a.obj', data: 'a' }] },
    (_f, label) => seen.push(label));
  setLocale('en');
  assert.deepEqual(seen, [ja['progress.packaging']]);
});
