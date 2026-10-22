// cia W-05: opening or recovering a project while the user is in Print must
// not leave the Layout button dead. The workspace is the user's, not the
// project's: after the load the screen and the state agree, and switching
// works on the first click.
//   node --import ./tests/register-hooks.mjs --test tests/workspace-after-open-w05.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installEnv } from './env.mjs';

installEnv();
const fakeEl = () => ({ style: { setProperty() {} }, classList: { toggle() {}, add() {}, remove() {} } });
const els = { app: fakeEl(), 'right-panel': fakeEl(), 'asset-panel': fakeEl() };
globalThis.document.getElementById = id => els[id] ?? null;
globalThis.document.body.dataset = {};
globalThis.document.querySelectorAll = () => [];
globalThis.requestAnimationFrame = fn => fn();

const { setWorkspace, init } = await import('../src/ui/Workspace.js');
const { getState, replaceState, freshState, dispatch } = await import('../src/core/StateManager.js');
const { EVENTS } = await import('../src/core/events.js');

init();
const shown = () => globalThis.document.body.dataset.workspace;

for (const [name, event] of [['Open', EVENTS.PROJECT_LOADED], ['New', EVENTS.PROJECT_NEW]]) {
  test(`after ${name} from Print, Layout switches on the first click`, () => {
    setWorkspace('print');
    assert.equal(shown(), 'print');
    replaceState(freshState());          // what every load / New does to the world state
    dispatch(event, {});
    assert.equal(getState().ui.workspace, shown(), 'state and screen agree after the load');
    setWorkspace('layout');
    assert.equal(shown(), 'layout', 'the Layout button is not dead');
  });
}
