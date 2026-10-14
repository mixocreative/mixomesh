// Pinned cloudflared release + verified download. Shared by scripts/fetch-cloudflared.mjs
// (dev: vendor/cloudflared/) and the runtime (first use: <userData>/listbridge/cloudflared.exe).
//
// Pinned 2026-10-14 from release 2026.10.0 (published 2026-10-05). The exe hash is the one
// listed in the release notes and matches the GitHub asset digest; the LICENSE hash is of
// LICENSE at tag 2026.10.0. To bump: change VERSION, copy the new hashes, re-run the tests.
//
// Safety: bytes are hashed BEFORE anything touches the destination; a mismatch throws and
// writes nothing. A verified download goes to a unique temp file next to the destination and
// is renamed into place (a crash never leaves a half-written cloudflared.exe). Concurrent
// callers for the same destination share ONE download.

const { createHash, randomBytes } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const VERSION = '2026.10.0';
const EXE_NAME = 'cloudflared-windows-amd64.exe';
const FILES = Object.freeze([
  Object.freeze({
    name: EXE_NAME,
    url: `https://github.com/cloudflare/cloudflared/releases/download/${VERSION}/${EXE_NAME}`,
    sha256: '86aee4017b26625cee8484c113558f48effa4cd47f7aa05fcf425604e5d2b23c',
  }),
  Object.freeze({
    name: 'LICENSE',
    url: `https://raw.githubusercontent.com/cloudflare/cloudflared/${VERSION}/LICENSE`,
    sha256: '58d1e17ffe5109a7ae296caafcadfdbe6a7d176f0bc4ab01e12a689b0499d8bd',
  }),
]);
const EXE_FILE = FILES[0];

const sha256Hex = buf => createHash('sha256').update(buf).digest('hex');

async function downloadBytes(url, fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch is not available');
  const res = await fetchImpl(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Download `file` ({url, sha256}), verify, and atomically write to `dest`. Returns byte length. */
async function downloadVerifiedTo(file, dest, { fetchImpl } = {}) {
  const buf = await downloadBytes(file.url, fetchImpl);
  const got = sha256Hex(buf);
  if (got !== file.sha256) throw new Error(`SHA-256 mismatch for downloaded ${file.name}: got ${got}, expected ${file.sha256}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, dest);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
    throw err;
  }
  return buf.length;
}

const inflight = new Map();   // dest → Promise<string>

/** Runtime: make sure the pinned cloudflared exists at `dest` (download once, verified). */
function ensureCloudflaredAt(dest, { fetchImpl, file = EXE_FILE, exists = p => fs.existsSync(p) } = {}) {
  if (exists(dest)) return Promise.resolve(dest);
  let p = inflight.get(dest);
  if (!p) {
    p = downloadVerifiedTo(file, dest, { fetchImpl }).then(() => dest).finally(() => inflight.delete(dest));
    inflight.set(dest, p);
  }
  return p;
}

module.exports = { VERSION, FILES, EXE_FILE, EXE_NAME, sha256Hex, downloadBytes, downloadVerifiedTo, ensureCloudflaredAt };
