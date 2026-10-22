// cia B-13 (desktop half): when the desktop app finds its saved app data file
// unreadable (quarantined at startup), the user is told once instead of silently
// losing recent projects, autosave and preferences.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installEnv } from './env.mjs';

installEnv();
const { subscribe } = await import('../src/core/StateManager.js');
const { EVENTS } = await import('../src/core/events.js');
const { reportKvDamage } = await import('../src/core/persist/KvDamage.js');
const { DesktopStorageAdapter } = await import('../src/core/storage/DesktopStorageAdapter.js');

function toastsDuring(fn) {
  const seen = [];
  const off = subscribe(EVENTS.TOAST, p => seen.push(p));
  return fn().then(r => { off?.(); return { r, seen }; });
}

test('a quarantined desktop KV file shows one warning', async () => {
  window.electronAPI = { kvDamaged: async () => true };
  const { r, seen } = await toastsDuring(() => reportKvDamage(DesktopStorageAdapter));
  assert.equal(r, true);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].type, 'warning');
  assert.notEqual(seen[0].message, 'toast.appDataDamaged', 'the warning has text in every locale');
});

test('a clean KV file, a browser adapter or a failing bridge show nothing', async () => {
  window.electronAPI = { kvDamaged: async () => false };
  assert.equal((await toastsDuring(() => reportKvDamage(DesktopStorageAdapter))).seen.length, 0);
  assert.equal((await toastsDuring(() => reportKvDamage({}))).seen.length, 0);
  window.electronAPI = { kvDamaged: async () => { throw new Error('no handler'); } };
  assert.equal((await toastsDuring(() => reportKvDamage(DesktopStorageAdapter))).seen.length, 0);
  delete window.electronAPI;
});
