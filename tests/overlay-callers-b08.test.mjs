// B-08: every blocking operation owns its overlay session. A repair started
// while another repair (an automation request, a second click) is still running
// must not take the first one's overlay down with it when it ends.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installEnv } from './env.mjs';

installEnv();

function makeElement(tag = 'div') {
  const bySelector = new Map();
  const el = {
    tagName: tag.toUpperCase(), id: '', className: '', parentElement: null, style: {}, textContent: '', hidden: false,
    set innerHTML(_) {
      for (const cls of ['po-bar', 'po-pct', 'po-msg', 'po-title', 'po-cancel']) {
        const child = makeElement('div');
        child.className = cls;
        bySelector.set(`.${cls}`, child);
      }
    },
    classList: {
      add(name) { el.className = [...new Set([...el.className.split(/\s+/).filter(Boolean), name])].join(' '); },
      remove(name) { el.className = el.className.split(/\s+/).filter(c => c && c !== name).join(' '); },
      contains(name) { return el.className.split(/\s+/).includes(name); },
    },
    querySelector(sel) { return bySelector.get(sel) ?? null; },
    addEventListener() {},
  };
  return el;
}
const body = makeElement('body');
let root = null;
body.appendChild = (child) => { child.parentElement = body; root = child; };
globalThis.document = {
  ...globalThis.document, body,
  getElementById: () => null,
  createElement: makeElement,
  addEventListener() {},
};
const visible = () => !!root && !root.classList.contains('hidden');
const title = () => root?.querySelector('.po-title').textContent;

const { MeshValidator } = await import('../src/core/MeshValidator.js');
const { repairWithOverlay } = await import('../src/ui/RepairFeedback.js');

test('a repair that ends while an earlier repair runs leaves the earlier overlay up', async () => {
  const pending = new Map();
  MeshValidator.repairObjects = (ids) => new Promise(resolve => pending.set(ids[0], resolve));
  const done = { holesFilled: 0, nmFixed: 0, repaired: 0, failed: [] };

  const first = repairWithOverlay(['a'], { title: 'Repairing A' });
  const second = repairWithOverlay(['b'], { title: 'Repairing B' });
  assert.equal(title(), 'Repairing B');
  pending.get('b')(done);
  await second;
  await new Promise(r => setTimeout(r, 700));
  assert.equal(visible(), true, 'repair A still running: its overlay stays up');
  assert.equal(title(), 'Repairing A');
  pending.get('a')(done);
  await first;
  await new Promise(r => setTimeout(r, 700));
  assert.equal(visible(), false, 'both repairs done: overlay gone');
});
