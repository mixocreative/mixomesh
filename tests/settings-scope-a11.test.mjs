// cia A-11: changing one setting persists only that setting. Opening a .mixo
// still shows the file's printer and render values ("file wins"), but they
// never leak into the user's personal defaults that New starts from.
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
const { StateManager, getState, setState, dispatch } = await import('../src/core/StateManager.js');
const { EVENTS } = await import('../src/core/events.js');

document.getElementById ??= () => null;
SettingsStore.init();
const stored = () => JSON.parse(store.get('mx-settings-v1')).settings;

function boot(personal) {
  store.clear();
  store.set('mx-settings-v1', JSON.stringify({ v: 1, settings: personal }));
  StateManager.replaceState(StateManager.freshState());
  SettingsStore.seedBootState();
}

function openFile({ printer, exposure }) {
  setState(s => ({
    ...s,
    print: { ...s.print, targetPrinterId: printer },
    scene: { ...s.scene, render: { ...s.scene.render, exposure } },
  }), { silent: true });
  dispatch(EVENTS.PROJECT_LOADED, {});
}

function startNew() {
  StateManager.replaceState(StateManager.freshState());
  SettingsStore.seedBootState();
}

beforeEach(() => store.clear());

test('a tweak after opening a file keeps the personal printer and render defaults', () => {
  boot({ print: { targetPrinterId: 'my-printer' }, render: { exposure: 0.9 } });
  openFile({ printer: 'their-printer', exposure: 2.5 });
  assert.equal(getState().print.targetPrinterId, 'their-printer', 'file wins on open');

  setState(s => ({ ...s, gizmo: { ...s.gizmo, space: 'local' } }), { silent: true });
  SettingsStore.save();

  assert.equal(stored().print.targetPrinterId, 'my-printer');
  assert.equal(stored().render.exposure, 0.9);
  assert.equal(stored().gizmo.space, 'local', 'the tweaked key is saved');

  startNew();
  assert.equal(getState().print.targetPrinterId, 'my-printer');
  assert.equal(getState().scene.render.exposure, 0.9);
  assert.equal(getState().gizmo.space, 'local');
});

test('changing a value the file set saves only that value', () => {
  boot({ print: { targetPrinterId: 'my-printer' }, render: { exposure: 0.9 } });
  openFile({ printer: 'their-printer', exposure: 2.5 });
  setState(s => ({ ...s, scene: { ...s.scene, render: { ...s.scene.render, contrast: 1.4 } } }), { silent: true });
  SettingsStore.save();
  assert.equal(stored().render.contrast, 1.4);
  assert.equal(stored().render.exposure, 0.9);
  assert.equal(stored().print.targetPrinterId, 'my-printer');
});

test('without an open, a tweak still saves (first run writes the blob)', () => {
  StateManager.replaceState(StateManager.freshState());
  SettingsStore.seedBootState();
  setState(s => ({ ...s, print: { ...s.print, targetPrinterId: 'picked' } }), { silent: true });
  SettingsStore.save();
  assert.equal(stored().print.targetPrinterId, 'picked');
});
