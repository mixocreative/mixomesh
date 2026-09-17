// electron/KvStore.cjs — audit M7: atomic temp+rename writes, serialised
// mutations (no lost updates under concurrent set), corrupt-file quarantine.
// Pure Node, real temp dir; fs.rename is stubbed through the deps seam only
// where a failure has to be simulated.

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { createKvStore } = require('../electron/KvStore.cjs');

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mixo-kv-'));
const file = path.join(dir, 'mixo-kv.json');
const listDir = async () => (await fs.readdir(dir)).sort();
const readJson = async () => JSON.parse(await fs.readFile(file, 'utf8'));

try {
  // ── missing file → empty store, no file created by reads ──
  {
    const kv = createKvStore(file);
    assert.equal(await kv.get('nope'), null);
    assert.deepEqual(await kv.keys(), []);
    assert.deepEqual(await listDir(), []);
  }

  // ── basic set/get/delete round-trip, and no temp file left behind ──
  {
    const kv = createKvStore(file);
    await kv.set('a', { n: 1 });
    await kv.set('b', 'two');
    assert.deepEqual(await kv.get('a'), { n: 1 });
    assert.equal(await kv.get('b'), 'two');
    assert.deepEqual((await kv.keys()).sort(), ['a', 'b']);
    await kv.delete('a');
    assert.equal(await kv.get('a'), null);
    assert.deepEqual(await kv.keys(), ['b']);
    assert.deepEqual(await listDir(), ['mixo-kv.json']);
    assert.deepEqual(await readJson(), { b: 'two' });
  }

  // ── atomic replace: a rename failure leaves the previous file intact and no partial/temp file ──
  {
    let failNext = false;
    const kv = createKvStore(file, {
      rename: async (from, to) => {
        if (failNext) { failNext = false; throw new Error('simulated rename failure'); }
        return fs.rename(from, to);
      },
    });
    await kv.set('keep', 'before');
    const snapshot = await fs.readFile(file, 'utf8');
    failNext = true;
    await assert.rejects(() => kv.set('keep', 'after'), /simulated rename failure/);
    assert.equal(await fs.readFile(file, 'utf8'), snapshot, 'target file untouched after failed write');
    assert.deepEqual(await listDir(), ['mixo-kv.json'], 'no temp file left after failed write');
    // the chain survives the rejection: next op works and the value is still the old one
    assert.equal(await kv.get('keep'), 'before');
    await kv.set('keep', 'after');
    assert.equal(await kv.get('keep'), 'after');
  }

  // ── writeFile failure (disk full etc.) also never touches the target ──
  {
    let failNext = false;
    const kv = createKvStore(file, {
      writeFile: async (p, data) => {
        if (failNext) { failNext = false; throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }); }
        return fs.writeFile(p, data);
      },
    });
    const snapshot = await fs.readFile(file, 'utf8');
    failNext = true;
    await assert.rejects(() => kv.set('x', 1), /ENOSPC/);
    assert.equal(await fs.readFile(file, 'utf8'), snapshot);
    assert.deepEqual(await listDir(), ['mixo-kv.json']);
  }

  // ── serialised concurrent sets: 20 un-awaited sets, all 20 keys land, writes never overlap ──
  {
    await fs.rm(file, { force: true });
    let inFlight = 0, maxInFlight = 0;
    const kv = createKvStore(file, {
      writeFile: async (p, data) => {
        inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise(r => setTimeout(r, 2));   // widen the race window
        await fs.writeFile(p, data);
        inFlight--;
      },
    });
    const pending = [];
    for (let i = 0; i < 20; i++) pending.push(kv.set(`k${i}`, i));
    // interleave reads too — they must observe a consistent object, never a partial file
    pending.push(kv.keys());
    await Promise.all(pending);
    const keys = (await kv.keys()).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
    assert.deepEqual(keys, Array.from({ length: 20 }, (_, i) => `k${i}`));
    for (let i = 0; i < 20; i++) assert.equal(await kv.get(`k${i}`), i);
    assert.equal(maxInFlight, 1, 'read-modify-write cycles never interleave');
    assert.deepEqual(await listDir(), ['mixo-kv.json']);
    assert.equal(Object.keys(await readJson()).length, 20);
  }

  // ── corrupt file quarantine: garbage JSON is moved aside + logged, store starts empty, then recovers ──
  {
    await fs.writeFile(file, '{"autosave": {"truncated": tr');
    const logs = [];
    const kv = createKvStore(file, { log: (...a) => logs.push(a.join(' ')), now: () => Date.UTC(2026, 8, 17, 12, 30, 45) });
    assert.equal(await kv.get('autosave'), null);
    const entries = await listDir();
    const corrupt = entries.filter(n => n.startsWith('mixo-kv.json.corrupt-'));
    assert.equal(corrupt.length, 1, `exactly one quarantine file, got ${entries}`);
    assert.equal(corrupt[0], 'mixo-kv.json.corrupt-2026-09-17T12-30-45-000Z');
    assert.equal(await fs.readFile(path.join(dir, corrupt[0]), 'utf8'), '{"autosave": {"truncated": tr', 'corrupt bytes preserved verbatim');
    assert.equal(entries.includes('mixo-kv.json'), false, 'a read never recreates the file');
    assert.equal(logs.length, 1);
    assert.match(logs[0], /unreadable/);
    assert.match(logs[0], /corrupt-2026-09-17T12-30-45-000Z/);
    // store works again from empty
    await kv.set('fresh', true);
    assert.deepEqual(await readJson(), { fresh: true });
    assert.deepEqual(await kv.keys(), ['fresh']);
    assert.equal(logs.length, 1, 'no further quarantine once the file is valid');
    await fs.rm(path.join(dir, corrupt[0]));
  }

  // ── valid JSON that is not an object (array / scalar) is quarantined too ──
  {
    await fs.writeFile(file, '[1,2,3]');
    const logs = [];
    const kv = createKvStore(file, { log: (...a) => logs.push(a.join(' ')), now: () => Date.UTC(2026, 0, 1) });
    assert.deepEqual(await kv.keys(), []);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /an array/);
    assert.equal((await listDir()).some(n => n.includes('.corrupt-2026-01-01T')), true);
  }

  // ── non-ENOENT read errors propagate (never silently masked as an empty store) ──
  {
    const kv = createKvStore(file, {
      readFile: async () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); },
    });
    await assert.rejects(() => kv.get('x'), /EACCES/);
    await assert.rejects(() => kv.set('x', 1), /EACCES/);
  }

  assert.throws(() => createKvStore(''), /filePath is required/);

  console.log('PASS kv-store: atomic rename, serialised sets, corrupt-file quarantine');
} finally {
  await fs.rm(dir, { recursive: true, force: true });
}
