// cia B-01: the automation-API off switch must fail closed. A corrupt or unreadable
// mixo-kv.json at startup keeps the API OFF and carries a notice the renderer shows.

import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { createKvStore } = require('../electron/KvStore.cjs');
const { readApiEnabled, API_KV_KEY } = require('../electron/ApiServer.cjs');

const quiet = { log: () => {} };

async function tempFile() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mixo-apiflag-'));
  return { dir, file: path.join(dir, 'mixo-kv.json') };
}

test('healthy file: user off stays off, absent flag means on', async () => {
  const { dir, file } = await tempFile();
  try {
    const kv = createKvStore(file, quiet);
    assert.deepEqual(await readApiEnabled(kv), { enabled: true, notice: null });
    await kv.set(API_KV_KEY, false);
    assert.deepEqual(await readApiEnabled(createKvStore(file, quiet)), { enabled: false, notice: null });
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('corrupt file: API stays off, the user is told, and the next start stays off too', async () => {
  const { dir, file } = await tempFile();
  try {
    await fs.writeFile(file, '{"api_enabled":false,"recent":[');
    const flag = await readApiEnabled(createKvStore(file, quiet));
    assert.equal(flag.enabled, false);
    assert.equal(flag.notice, 'settings-unreadable');
    assert.equal((await readApiEnabled(createKvStore(file, quiet))).enabled, false, 'restart after quarantine');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('corrupt file already quarantined by an earlier read in this process still reads as off', async () => {
  const { dir, file } = await tempFile();
  try {
    await fs.writeFile(file, 'not json');
    const kv = createKvStore(file, quiet);
    await kv.keys();
    const flag = await readApiEnabled(kv);
    assert.deepEqual(flag, { enabled: false, notice: 'settings-unreadable' });
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('locked file (EBUSY): API stays off with a notice', async () => {
  const kv = createKvStore('C:\\nowhere\\mixo-kv.json', {
    ...quiet,
    readFile: async () => { const e = new Error('EBUSY'); e.code = 'EBUSY'; throw e; },
  });
  assert.deepEqual(await readApiEnabled(kv), { enabled: false, notice: 'settings-unreadable' });
});

test('renderer shows the notice once at startup when main kept the API off', async () => {
  const { createApiBridge } = await import('../src/core/api/ApiBridge.js');
  const run = async status => {
    const toasts = [];
    createApiBridge({
      bridge: { onApiRequest: () => () => {}, respondApi: async () => {}, getApiStatus: async () => status },
      createDispatcher: async () => ({ dispatch: async () => null }),
      toast: (m, type) => toasts.push({ m, type }),
    }).init();
    await new Promise(r => setImmediate(r));
    return toasts;
  };
  const shown = await run({ enabled: false, running: false, notice: 'settings-unreadable' });
  assert.equal(shown.length, 1);
  assert.equal(shown[0].type, 'warning');
  assert.deepEqual(await run({ enabled: false, running: false, notice: null }), []);
});
