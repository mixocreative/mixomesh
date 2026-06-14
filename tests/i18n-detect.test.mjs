import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mapTag, detectFromNavigator } from '../src/i18n/detect.js';

const SUP = ['en', 'ja', 'zh-Hant'];

test('mapTag: zh-TW → zh-Hant', () => {
  assert.equal(mapTag('zh-TW', SUP), 'zh-Hant');
});

test('mapTag: zh-HK → zh-Hant', () => {
  assert.equal(mapTag('zh-HK', SUP), 'zh-Hant');
});

test('mapTag: zh-Hant → zh-Hant', () => {
  assert.equal(mapTag('zh-Hant', SUP), 'zh-Hant');
});

test('mapTag: zh-CN → null (no zh-Hans shipped)', () => {
  assert.equal(mapTag('zh-CN', SUP), null);
});

test('mapTag: bare zh → null', () => {
  assert.equal(mapTag('zh', SUP), null);
});

test('mapTag: ja-JP → ja', () => {
  assert.equal(mapTag('ja-JP', SUP), 'ja');
});

test('mapTag: en-GB → en', () => {
  assert.equal(mapTag('en-GB', SUP), 'en');
});

test('mapTag: fr-FR → null (unsupported)', () => {
  assert.equal(mapTag('fr-FR', SUP), null);
});

test('detectFromNavigator: first matching tag wins', () => {
  assert.equal(detectFromNavigator(['fr-FR', 'zh-TW', 'ja-JP'], SUP), 'zh-Hant');
});

test('detectFromNavigator: no match → null', () => {
  assert.equal(detectFromNavigator(['fr-FR', 'de-DE'], SUP), null);
});
