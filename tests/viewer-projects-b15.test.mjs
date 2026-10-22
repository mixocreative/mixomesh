// cia B-15: a storage read failure must not read as "No saved projects here
// yet" on the phone viewer; it shows an error with Retry, and Retry re-reads.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installEnv } from './env.mjs';

installEnv();

const children = new Map();
const listeners = {};
function fakeEl() {
  return {
    hidden: false, innerHTML: '', textContent: '', dataset: {}, style: {},
    classList: { add() {}, remove() {}, toggle() {} },
    setAttribute() {}, appendChild() {}, click() {}, getBoundingClientRect: () => ({ height: 0 }),
    addEventListener(type, fn) { listeners[type] = fn; },
    querySelector(sel) { if (!children.has(sel)) children.set(sel, fakeEl()); return children.get(sel); },
  };
}
globalThis.document = {
  createElement: () => fakeEl(),
  body: { dataset: {}, appendChild() {} },
  documentElement: { style: { setProperty() {} } },
  getElementById: () => null,
  querySelector: () => null,
};
globalThis.window = Object.assign(globalThis.window ?? {}, { matchMedia: () => ({ matches: true, addEventListener() {} }) });

const { ViewerMode } = await import('../src/ui/ViewerMode.js');
const { storage } = await import('../src/core/storage/StorageAdapter.js');

const tick = () => new Promise(r => setTimeout(r, 20));
const projects = () => children.get('.vm-projects');

test('a failing project list shows an error state with Retry, not the empty state', async () => {
  let fail = true;
  storage.listProjects = async () => {
    if (fail) throw new Error('quota');
    return [{ name: 'Gear.mixo', lastModified: Date.now(), ref: {} }];
  };
  ViewerMode.init();
  await tick();
  assert.ok(projects().innerHTML.includes('role="alert"'), 'error is announced');
  assert.ok(projects().innerHTML.includes('data-vm="retry"'), 'Retry button present');
  assert.ok(!projects().innerHTML.includes('No saved projects'), 'not rendered as an empty list');

  fail = false;
  listeners.click({ target: { closest: sel => (sel === '[data-vm]' ? { dataset: { vm: 'retry' } } : null) } });
  await tick();
  assert.ok(projects().innerHTML.includes('Gear'), 'Retry re-reads and lists the project');
  assert.ok(!projects().innerHTML.includes('role="alert"'));
});

test('an empty but healthy list still shows the empty hint', async () => {
  storage.listProjects = async () => [];
  ViewerMode.render();
  await tick();
  assert.ok(projects().innerHTML.includes('No saved projects'));
  assert.ok(!projects().innerHTML.includes('role="alert"'));
});
