import test from 'node:test';
import assert from 'node:assert/strict';

function makeElement() {
  const listeners = new Map();
  const el = {
    className: '', id: '', tabIndex: 0, children: [], _html: '',
    classList: {
      add(c) { if (!el.className.split(' ').includes(c)) el.className = `${el.className} ${c}`.trim(); },
      remove(c) { el.className = el.className.split(' ').filter(x => x && x !== c).join(' '); },
    },
    set innerHTML(v) { el._html = v; el.children = []; },
    get innerHTML() { return el._html; },
    appendChild(c) { el.children.push(c); return c; },
    setAttribute() {}, hasAttribute() { return false; },
    querySelector() { return null; }, querySelectorAll() { return []; },
    addEventListener(t, fn) { listeners.set(t, fn); },
    focus() {},
  };
  return el;
}
const body = makeElement();
globalThis.document = {
  body, activeElement: null,
  getElementById() { return null; },
  createElement: makeElement,
  addEventListener() {},
};
globalThis.HTMLElement = class {};
globalThis.requestAnimationFrame = (fn) => fn();
globalThis.location = { hostname: 'localhost', search: '' };
globalThis.window = {};

const { Modal } = await import('../src/ui/Modal.js');
const { dispatch } = await import('../src/core/StateManager.js');
const { EVENTS } = await import('../src/core/events.js');

const shown = [];
Modal.register('a', ({ data }) => { shown.push(data.name); return 'x'; });
Modal.init();

test('second open queues until the first closes; order preserved, onClose once each', () => {
  const closed = [];
  dispatch(EVENTS.MODAL_OPEN, { id: 'a', name: 'one', onClose: (r) => closed.push(['one', r]) });
  dispatch(EVENTS.MODAL_OPEN, { id: 'a', name: 'two', onClose: (r) => closed.push(['two', r]) });
  dispatch(EVENTS.MODAL_OPEN, { id: 'a', name: 'three', onClose: (r) => closed.push(['three', r]) });
  assert.deepEqual(shown, ['one'], 'only the first is shown');
  assert.deepEqual(closed, []);

  Modal.close('r1');
  assert.deepEqual(shown, ['one', 'two']);
  assert.deepEqual(closed, [['one', 'r1']]);

  Modal.close('r2');
  assert.deepEqual(shown, ['one', 'two', 'three']);
  Modal.close('r3');
  assert.deepEqual(closed, [['one', 'r1'], ['two', 'r2'], ['three', 'r3']]);

  Modal.close('extra');   // nothing open: no double fire
  assert.equal(closed.length, 3);
});

test('blocking open replaces the current modal (closing it once) and queue still drains', () => {
  shown.length = 0;
  const closed = [];
  dispatch(EVENTS.MODAL_OPEN, { id: 'a', name: 'base', onClose: () => closed.push('base') });
  dispatch(EVENTS.MODAL_OPEN, { id: 'a', name: 'waiting', onClose: () => closed.push('waiting') });
  dispatch(EVENTS.MODAL_OPEN, { id: 'a', name: 'gate', blocking: true, onClose: () => closed.push('gate') });
  assert.deepEqual(shown, ['base', 'gate']);
  assert.deepEqual(closed, ['base']);
  Modal.close();
  assert.deepEqual(shown, ['base', 'gate', 'waiting']);
  Modal.close();
  assert.deepEqual(closed, ['base', 'gate', 'waiting']);
});
