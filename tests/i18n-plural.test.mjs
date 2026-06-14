import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parsePlural } from '../src/i18n/plural.js';

const T_EN = '{n, plural, =0{No objects} one{1 object} other{# objects}}';
const T_JA = '{n, plural, =0{オブジェクトなし} other{オブジェクト # 件}}';

test('parsePlural picks =0 arm for n=0 (EN)', () => {
  assert.equal(parsePlural(T_EN, 0, 'en'), 'No objects');
});

test('parsePlural picks "one" arm for n=1 (EN)', () => {
  assert.equal(parsePlural(T_EN, 1, 'en'), '1 object');
});

test('parsePlural picks "other" arm + replaces # for n=5 (EN)', () => {
  assert.equal(parsePlural(T_EN, 5, 'en'), '5 objects');
});

test('parsePlural picks "other" arm for n=1 in JA (no plural distinction)', () => {
  assert.equal(parsePlural(T_JA, 1, 'ja'), 'オブジェクト 1 件');
});

test('parsePlural returns undefined for malformed templates', () => {
  assert.equal(parsePlural('not a plural', 1, 'en'), undefined);
});
