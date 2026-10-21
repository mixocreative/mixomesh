import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installEnv } from './env.mjs';
installEnv();
const { readStyle, applyStyle, STORAGE_KEY, UI_STYLES } = await import('../src/core/UiStyle.js');

function store(value) {
  return { getItem: key => (key === STORAGE_KEY ? value : null) };
}
const throwing = { getItem() { throw new Error('denied'); } };

test('styles are new and original, new first', () => {
  assert.deepEqual(UI_STYLES, ['new', 'original']);
  assert.equal(STORAGE_KEY, 'mx-ui-style-v1');
});

test('readStyle defaults to new when nothing is stored', () => {
  assert.equal(readStyle(store(null)), 'new');
});

test('readStyle defaults to new on unparsable JSON', () => {
  assert.equal(readStyle(store('{bad')), 'new');
});

test('readStyle defaults to new on an unknown style', () => {
  assert.equal(readStyle(store(JSON.stringify({ v: 1, style: 'weird' }))), 'new');
});

test('readStyle defaults to new when storage throws', () => {
  assert.equal(readStyle(throwing), 'new');
});

test('readStyle returns a stored original', () => {
  assert.equal(readStyle(store(JSON.stringify({ v: 1, style: 'original' }))), 'original');
});

test('applyStyle writes data-ui-style on the root', () => {
  const root = { dataset: {} };
  applyStyle('original', root);
  assert.equal(root.dataset.uiStyle, 'original');
});

test('applyStyle normalises an unknown style to new', () => {
  const root = { dataset: {} };
  applyStyle('weird', root);
  assert.equal(root.dataset.uiStyle, 'new');
});
