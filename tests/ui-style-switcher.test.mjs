import assert from 'node:assert/strict';
import { test } from 'node:test';

function makeElement(tag) {
  const listeners = new Map();
  const el = {
    tagName: tag, id: '', value: '', selected: false, textContent: '', className: '',
    dataset: {}, attrs: {}, children: [],
    set innerHTML(_) { el.children = []; },
    appendChild(c) { el.children.push(c); return c; },
    setAttribute(k, v) { el.attrs[k] = String(v); },
    querySelector(sel) { return sel === '#ui-style-switcher' ? el.children[0] ?? null : null; },
    querySelectorAll(sel) { return sel === 'option' ? el.children : []; },
    addEventListener(type, fn) { listeners.set(type, fn); },
    fire(type) { listeners.get(type)?.(); },
  };
  return el;
}

const saved = new Map();
globalThis.location = { hostname: 'localhost', search: '' };
globalThis.window = { addEventListener() {} };
globalThis.localStorage = {
  getItem: k => saved.get(k) ?? null,
  setItem: (k, v) => saved.set(k, v),
};
globalThis.document = { documentElement: makeElement('html'), createElement: makeElement };

const { UiStyleSwitcher } = await import('../src/ui/UiStyleSwitcher.js');
const { STORAGE_KEY } = await import('../src/core/uiStyleStore.js');

test('switcher lists New then Original and selects the current style', () => {
  document.documentElement.dataset.uiStyle = 'new';
  const host = makeElement('span');
  UiStyleSwitcher.mount(host);
  const sel = host.children[0];
  assert.equal(sel.id, 'ui-style-switcher');
  assert.deepEqual(sel.children.map(o => o.value), ['new', 'original']);
  assert.equal(sel.value, 'new');
  assert.ok(sel.attrs['aria-label']);
});

test('choosing Original applies and persists it', () => {
  document.documentElement.dataset.uiStyle = 'new';
  const host = makeElement('span');
  UiStyleSwitcher.mount(host);
  const sel = host.children[0];
  sel.value = 'original';
  sel.fire('change');
  assert.equal(document.documentElement.dataset.uiStyle, 'original');
  assert.deepEqual(JSON.parse(saved.get(STORAGE_KEY)), { v: 1, style: 'original' });
});

test('refresh re-syncs the select to the applied style', () => {
  const host = makeElement('span');
  UiStyleSwitcher.mount(host);
  document.documentElement.dataset.uiStyle = 'original';
  UiStyleSwitcher.refresh(host);
  assert.equal(host.children[0].value, 'original');
});
