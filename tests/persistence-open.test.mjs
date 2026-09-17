// PersistenceManager.open(): the save target binds only AFTER a successful
// load. A torn load (world reset, then a throw) must leave Ctrl+S with no
// handle, so it prompts instead of overwriting the user's only good file.
//   node --import ./tests/register-hooks.mjs tests/persistence-open.test.mjs

import assert from 'node:assert/strict';
import { installEnv } from './env.mjs';

installEnv();

const { PersistenceManager } = await import('../src/core/PersistenceManager.js');
const { Toast } = await import('../src/ui/Toast.js');
Toast.show = () => {};
console.error = () => {};

let passed = 0, failed = 0;
const out = [];
async function test(name, fn) {
  try { await fn(); out.push(`PASS  ${name}`); passed++; }
  catch (err) { out.push(`FAIL  ${name}\n      ${err.stack || err.message}`); failed++; }
}

function fakeHandle(docText) {
  const h = {
    name: 'good.mixo', kind: 'file', writes: 0,
    async getFile() { return { text: async () => docText }; },
    async createWritable() { h.writes++; return { write: async () => {}, close: async () => {} }; },
    async requestPermission() { return 'granted'; },
  };
  return h;
}

// A texture image whose recorded hash does not match its bytes makes
// loadProject throw AFTER resetWorld() — the torn-load shape.
const TORN_DOC = JSON.stringify({
  version: '3.3',
  project: { name: 'Good' },
  scene: {},
  textureImages: [{ hash: 'deadbeef', fileData: 'AAAA', width: 1, height: 1, mimeType: 'image/png' }],
});

await test('open(): load throws → no file handle bound → save() prompts (Save As) instead of writing the opened file', async () => {
  const handle = fakeHandle(TORN_DOC);
  window.showOpenFilePicker = async () => [handle];
  let pickerOpened = 0;
  window.showSaveFilePicker = async () => { pickerOpened++; throw Object.assign(new Error('cancel'), { name: 'AbortError' }); };
  await assert.rejects(PersistenceManager.open());
  const saved = await PersistenceManager.save();
  assert.equal(saved, false, 'save fell through to the picker and the picker was cancelled');
  assert.equal(pickerOpened, 1, 'Save As picker was shown');
  assert.equal(handle.writes, 0, 'the opened file was NEVER written');
});

console.log('\n' + out.join('\n'));
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
