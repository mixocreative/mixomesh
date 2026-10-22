// cia B-13: a damaged per-user settings blob resets silently today. The user is
// told once, and the damaged text is kept aside so nothing is destroyed.
import assert from 'node:assert/strict';
import { test, beforeEach } from 'node:test';
import { installEnv } from './env.mjs';

installEnv();
const store = new Map();
globalThis.localStorage = {
  getItem: k => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: k => { store.delete(k); },
};

const { SettingsStore } = await import('../src/core/SettingsStore.js');
const { subscribe } = await import('../src/core/StateManager.js');
const { EVENTS } = await import('../src/core/events.js');

const toasts = [];
subscribe(EVENTS.TOAST, p => toasts.push(p));
beforeEach(() => { store.clear(); toasts.length = 0; });

test('a missing blob is a first run, not damage', () => {
  SettingsStore.seedBootState();
  assert.equal(toasts.length, 0);
});

test('an unparsable blob warns once and is kept, not destroyed', () => {
  store.set('mx-settings-v1', '{"v":1,"settings":{"render":');
  SettingsStore.seedBootState();
  assert.equal(toasts.length, 1);
  assert.equal(toasts[0].type, 'warning');
  assert.ok([...store.values()].includes('{"v":1,"settings":{"render":'), 'damaged text still stored somewhere');
  SettingsStore.seedBootState();
  assert.equal(toasts.length, 1, 'reported once per session');
});

test('a blob of the wrong shape counts as damaged too', () => {
  store.set('mx-settings-v1', '[1,2,3]');
  SettingsStore.seedBootState();
  assert.equal(toasts.length, 1);
});

test('a valid blob loads silently', () => {
  store.set('mx-settings-v1', JSON.stringify({ v: 1, settings: { render: { exposure: 1.2 } } }));
  SettingsStore.seedBootState();
  assert.equal(toasts.length, 0);
});
