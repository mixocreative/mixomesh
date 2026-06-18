import test from 'node:test';
import assert from 'node:assert/strict';

function classListFor(el) {
  const tokens = () => new Set(String(el.className || '').split(/\s+/).filter(Boolean));
  const write = (set) => { el.className = [...set].join(' '); };
  return {
    add(name) { const set = tokens(); set.add(name); write(set); },
    remove(name) { const set = tokens(); set.delete(name); write(set); },
    contains(name) { return tokens().has(name); },
  };
}

function makeElement(tag = 'div') {
  const listeners = new Map();
  const bySelector = new Map();
  const el = {
    tagName: tag.toUpperCase(),
    id: '',
    className: '',
    parentElement: null,
    style: {},
    textContent: '',
    tabIndex: 0,
    set innerHTML(_) {
      for (const cls of ['po-bar', 'po-pct', 'po-msg', 'po-title']) {
        const child = makeElement('div');
        child.className = cls;
        bySelector.set(`.${cls}`, child);
      }
    },
    get classList() { return classListFor(el); },
    querySelector(sel) { return bySelector.get(sel) ?? null; },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    focus() { document.activeElement = el; },
  };
  return el;
}

function makeDocument() {
  const listeners = new Map();
  const body = makeElement('body');
  const doc = {
    activeElement: body,
    body,
    documentElement: makeElement('html'),
    getElementById() { return null; },
    createElement: makeElement,
    addEventListener(type, fn, opts) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push({ fn, capture: opts === true || !!opts?.capture });
    },
    dispatchEvent(event) {
      const list = listeners.get(event.type) ?? [];
      for (const { fn, capture } of list) {
        if (!capture) continue;
        fn(event);
        if (event.__stopped) return !event.defaultPrevented;
      }
      for (const { fn, capture } of list) {
        if (capture) continue;
        fn(event);
        if (event.__stopped) return !event.defaultPrevented;
      }
      return !event.defaultPrevented;
    },
  };
  body.appendChild = (child) => { child.parentElement = body; };
  return doc;
}

function keyboardEvent() {
  return {
    type: 'keydown',
    key: 'G',
    defaultPrevented: false,
    __stopped: false,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() { this.__stopped = true; },
  };
}

globalThis.location = { hostname: 'localhost', search: '' };
globalThis.document = makeDocument();
globalThis.window = { BABYLON: {} };

const { ProgressOverlay } = await import('../src/ui/ProgressOverlay.js');

test('ProgressOverlay blocks document-level keydown while visible', () => {
  let delivered = 0;
  document.addEventListener('keydown', () => { delivered++; });

  ProgressOverlay.show('Exporting');
  const ev = keyboardEvent();
  document.dispatchEvent(ev);

  assert.equal(ev.defaultPrevented, true);
  assert.equal(delivered, 0, 'background keyboard listener should not run');
});

test('ProgressOverlay releases document-level keydown after hide', () => {
  ProgressOverlay.hide();
  let delivered = 0;
  document.addEventListener('keydown', () => { delivered++; });

  const ev = keyboardEvent();
  document.dispatchEvent(ev);

  assert.equal(ev.defaultPrevented, false);
  assert.equal(delivered, 1);
});
