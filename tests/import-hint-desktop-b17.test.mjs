// cia B-17: the import-refusal hint must not send desktop users to "the desktop
// app". The base hint is runtime-neutral; the *Web variant carries the pointer.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';

const POINTER = { en: /desktop app/i, ja: /デスクトップ版/, 'zh-Hant': /桌面版/ };
const KEYS = ['import.fix.polygons', 'import.fix.memory', 'import.fix.timeout'];

for (const lang of Object.keys(POINTER)) {
  const table = JSON.parse(readFileSync(new URL(`../src/i18n/locales/${lang}.json`, import.meta.url), 'utf8'));
  test(`${lang}: base import hints never mention the desktop app, Web variants do`, () => {
    for (const key of KEYS) {
      assert.ok(table[key], `${key} exists`);
      assert.doesNotMatch(table[key], POINTER[lang], `${key} is neutral`);
      assert.match(table[`${key}Web`] ?? '', POINTER[lang], `${key}Web points at the desktop app`);
    }
  });
}
