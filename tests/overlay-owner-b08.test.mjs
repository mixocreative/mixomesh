// B-08 / A-03: an import that starts and ends while an export runs must leave
// the export's blocking overlay up, with its own Cancel.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installEnv } from './env.mjs';
import { binaryStlChunks } from '../scripts/heavy-mesh/generate.mjs';

installEnv();

function makeElement(tag = 'div') {
  const listeners = new Map();
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
    addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(fn); },
  };
  return el;
}
const docListeners = [];
const body = makeElement('body');
let root = null;
body.appendChild = (child) => { child.parentElement = body; root = child; };
globalThis.document = {
  ...globalThis.document, body,
  getElementById: () => null,
  createElement: makeElement,
  addEventListener(type, fn, capture) { docListeners.push({ type, fn, capture }); },
};
const pressEscape = () => {
  const ev = { type: 'keydown', key: 'Escape', defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {} };
  for (const l of docListeners) if (l.type === 'keydown') l.fn(ev);
  return ev;
};
const visible = () => !!root && !root.classList.contains('hidden');
const title = () => root?.querySelector('.po-title').textContent;

const B = window.BABYLON;
const { ProgressOverlay } = await import('../src/ui/ProgressOverlay.js');
const { StateManager } = await import('../src/core/StateManager.js');
const { AssetLoader } = await import('../src/core/AssetLoader.js');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

test('an import finishing mid-export leaves the export overlay and its Cancel', async () => {
  StateManager.replaceState(StateManager.freshState());
  const exportAbort = new AbortController();
  const exportOverlay = ProgressOverlay.open('Exporting', { controller: exportAbort });
  B.SceneLoader = { LoadAssetContainerAsync: async () => { await sleep(700); throw new Error('import done'); } };
  await assert.rejects(AssetLoader.loadFromBlob(new Blob([Buffer.concat([...binaryStlChunks(2)])]), 'late.stl'), /import done/);
  await sleep(600);   // past the import overlay's minimum visible time
  assert.equal(visible(), true, 'export still running: overlay stays up');
  assert.equal(title(), 'Exporting');
  assert.equal(pressEscape().defaultPrevented, true, 'keyboard still blocked');
  assert.equal(exportAbort.signal.aborted, true, 'Esc cancels the export');
  exportOverlay.close();
  assert.equal(visible(), false);
});

test('sessions stack: closing the newest brings the one underneath back with its Cancel', async () => {
  let cancelledA = 0, cancelledB = 0;
  const a = ProgressOverlay.open('Repairing', { onCancel: () => { cancelledA++; } });
  const b = ProgressOverlay.open('Boolean', { onCancel: () => { cancelledB++; } });
  assert.equal(title(), 'Boolean');
  b.close();
  assert.equal(title(), 'Repairing');
  pressEscape();
  assert.deepEqual([cancelledA, cancelledB], [1, 0]);
  a.close();
  assert.equal(visible(), false);
  const quick = ProgressOverlay.open('Fast', { delayMs: 50 });
  quick.close();
  await sleep(80);
  assert.equal(visible(), false, 'work that ends before the delay never shows');
});

test('a finished session lingering for its minimum time no longer blocks the keyboard', async () => {
  const s = ProgressOverlay.open('Loading model');
  s.close();
  const done = ProgressOverlay.open('Loading model', { minVisibleMs: 200 });
  await sleep(10);
  done.close();
  assert.equal(visible(), true, 'still drawn for its minimum time');
  assert.equal(pressEscape().defaultPrevented, false, 'Esc reaches the app');
  await sleep(250);
  assert.equal(visible(), false);
});
