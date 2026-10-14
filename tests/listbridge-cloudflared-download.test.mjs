// First-use cloudflared download (installer no longer bundles it). No network: fake fetch.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pin = require('../electron/listbridge/cloudflaredPin.cjs');
const { resolveCloudflared, downloadedPath, createTunnelFileHost, DOWNLOAD_FAILED_MESSAGE } = require('../electron/listbridge/filehosts/tunnel.cjs');

const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mixo-cf-'));
const BYTES = Buffer.from('pretend this is cloudflared.exe');
const GOOD = pin.sha256Hex(BYTES);
// Same code path as production, with a test pin (hash of BYTES, or a wrong one).
const withHash = (h, fn) => fn(h);
const PIN = h => ({ name: 'cf.exe', url: 'https://example.invalid/cf.exe', sha256: h });
const okFetch = (calls) => async (url) => { calls.push(url); return new Response(BYTES); };
// Hermetic: never see a real cloudflared in Program Files / PATH on the dev machine.
const iso = ud => ({ which: () => null, platform: 'win32', env: { ProgramFiles: path.join(ud, 'pf'), 'ProgramFiles(x86)': path.join(ud, 'pf86') } });

test('pin: exe is pinned to a release URL with a 64-hex SHA-256', () => {
  assert.match(pin.EXE_FILE.sha256, /^[0-9a-f]{64}$/);
  assert.ok(pin.EXE_FILE.url.includes(pin.VERSION));
});

test('resolver: a downloaded copy in userData is used with no network', async () => {
  const ud = mk();
  const dest = downloadedPath(ud, 'win32');
  fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, 'x');
  const calls = [];
  const r = await resolveCloudflared({ userDataDir: ud, ...iso(ud), pinFile: PIN(GOOD), fetchImpl: okFetch(calls), exists: p => p === dest });
  assert.equal(r.path, dest);
  assert.equal(calls.length, 0);
});

test('download: matching hash → file written, progress reported, then reused', async () => {
  await withHash(GOOD, async () => {
    const ud = mk();
    const calls = []; const prog = [];
    const r = await resolveCloudflared({ userDataDir: ud, ...iso(ud), pinFile: PIN(GOOD), fetchImpl: okFetch(calls), onProgress: p => prog.push(p) });
    assert.equal(r.path, downloadedPath(ud, 'win32'));
    assert.deepEqual(fs.readFileSync(r.path), BYTES);
    assert.deepEqual(prog, [{ phase: 'download-tool', message: 'Downloading the link tool (one time)…' }]);
    assert.equal(fs.readdirSync(path.dirname(r.path)).length, 1, 'no temp file left');
    const r2 = await resolveCloudflared({ userDataDir: ud, ...iso(ud), pinFile: PIN(GOOD), fetchImpl: okFetch(calls) });
    assert.equal(r2.path, r.path);
    assert.equal(calls.length, 1, 'second resolve does not download');
  });
});

test('download: mismatched hash → rejected, nothing left behind', async () => {
  await withHash('0'.repeat(64), async () => {
    const ud = mk();
    const r = await resolveCloudflared({ userDataDir: ud, ...iso(ud), pinFile: PIN('0'.repeat(64)), fetchImpl: okFetch([]) });
    assert.deepEqual(r, { path: null, error: DOWNLOAD_FAILED_MESSAGE });
    const dir = path.join(ud, 'listbridge');
    assert.deepEqual(fs.existsSync(dir) ? fs.readdirSync(dir) : [], []);
  });
});

test('download: HTTP failure → cloudflared-missing from the host', async () => {
  const ud = mk();
  const host = createTunnelFileHost({
    resolveBinary: o => resolveCloudflared({ userDataDir: ud, ...iso(ud), pinFile: PIN(GOOD), fetchImpl: async () => new Response('no', { status: 503 }), ...o }),
  });
  await assert.rejects(host.prepare(), e => e.code === 'cloudflared-missing' && e.message === DOWNLOAD_FAILED_MESSAGE);
  await host.close();
});

test('download: concurrent first-use calls download once', async () => {
  await withHash(GOOD, async () => {
    const ud = mk();
    const calls = [];
    const slow = async url => { calls.push(url); await new Promise(r => setTimeout(r, 30)); return new Response(BYTES); };
    const rs = await Promise.all([1, 2, 3, 4].map(() => resolveCloudflared({ userDataDir: ud, ...iso(ud), pinFile: PIN(GOOD), fetchImpl: slow })));
    assert.equal(calls.length, 1);
    assert.ok(rs.every(r => r.path === downloadedPath(ud, 'win32')));
  });
});

test('host.prepare reports download-tool progress via resolveBinary', async () => {
  await withHash(GOOD, async () => {
    const ud = mk(); const prog = [];
    const host = createTunnelFileHost({
      resolveBinary: o => resolveCloudflared({ userDataDir: ud, ...iso(ud), pinFile: PIN(GOOD), fetchImpl: okFetch([]), ...o }),
    });
    await host.prepare({ onProgress: p => prog.push(p.phase) });
    assert.deepEqual(prog, ['download-tool']);
    await host.close();
  });
});
