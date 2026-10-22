// cia D-13: Strict export is a per-user preference the .mixo never stores, so
// toggling it must not mark the project unsaved (Save would write nothing new).
import test from 'node:test';
import assert from 'node:assert/strict';
import { installEnv } from './env.mjs';

installEnv();
const toggles = new Map();
const fakeRoot = () => ({
  set innerHTML(_) {},
  querySelector: () => null,
  querySelectorAll(sel) {
    if (sel !== '#pp-strict-export') return [];
    const cb = { tagName: 'INPUT', checked: false, addEventListener(type, fn) { toggles.set(sel, (checked) => { cb.checked = checked; fn({ type }); }); } };
    return [cb];
  },
});
globalThis.document.createElement = fakeRoot;

const { PersistenceManager } = await import('../src/core/PersistenceManager.js');
const { dispatch, getState } = await import('../src/core/StateManager.js');
const { EVENTS } = await import('../src/core/events.js');
const { renderExportTab } = await import('../src/ui/print/ExportTab.js');
PersistenceManager.init();

test('toggling Strict export changes the preference without dirtying the project', () => {
  dispatch(EVENTS.PROJECT_SAVED, {});
  assert.equal(PersistenceManager.isDirty(), false);
  renderExportTab({ readiness: { issues: [], canExport: true }, preview: null, runExport() {}, rerender() {} });
  const on = !getState().print?.strictExport;
  toggles.get('#pp-strict-export')(on);
  assert.equal(getState().print.strictExport, on, 'the preference changed');
  assert.equal(PersistenceManager.isDirty(), false, 'the project still reads saved');
});
