// Fetch + verify the cloudflared binary that the desktop app ships (Listbridge PB.5b).
//
// MIXOMESH publishes to URL-only marketplaces through a Cloudflare QUICK tunnel (no account),
// so the packaged app bundles cloudflared (electron-builder.yml extraResources →
// resources/listbridge/cloudflared.exe + its Apache-2.0 LICENSE). This script downloads a
// PINNED release from the official GitHub releases into vendor/cloudflared/ (gitignored
// binary) and verifies PINNED SHA-256 hashes. `npm run dist` runs it first, so packaging
// fails if the binary is missing and cannot be fetched, or if any hash mismatches.
//
//   node scripts/fetch-cloudflared.mjs           download if missing, then verify
//   node scripts/fetch-cloudflared.mjs --check   verify only (no network)
//
// Pinned 2026-10-14 from release 2026.10.0 (published 2026-10-05). The exe hash is the one
// listed in the release notes ("cloudflared-windows-amd64.exe: 86aee4…") and matches the
// GitHub asset digest (api.github.com/repos/cloudflare/cloudflared/releases/latest);
// the LICENSE hash is of LICENSE at tag 2026.10.0.
// To bump: change VERSION, copy the new hashes from the release page, re-run.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = '2026.10.0';
const FILES = [
  {
    name: 'cloudflared-windows-amd64.exe',
    url: `https://github.com/cloudflare/cloudflared/releases/download/${VERSION}/cloudflared-windows-amd64.exe`,
    sha256: '86aee4017b26625cee8484c113558f48effa4cd47f7aa05fcf425604e5d2b23c',
  },
  {
    name: 'LICENSE',
    url: `https://raw.githubusercontent.com/cloudflare/cloudflared/${VERSION}/LICENSE`,
    sha256: '58d1e17ffe5109a7ae296caafcadfdbe6a7d176f0bc4ab01e12a689b0499d8bd',
  },
];

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'vendor', 'cloudflared');
const checkOnly = process.argv.includes('--check');

const sha256 = buf => createHash('sha256').update(buf).digest('hex');

async function download(url) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status} for ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const f of FILES) {
    const dest = path.join(OUT_DIR, f.name);
    if (!fs.existsSync(dest)) {
      if (checkOnly) throw new Error(`${path.relative(ROOT, dest)} is missing (run: node scripts/fetch-cloudflared.mjs)`);
      process.stdout.write(`fetching ${f.name} (cloudflared ${VERSION})… `);
      const buf = await download(f.url);
      const got = sha256(buf);
      if (got !== f.sha256) throw new Error(`SHA-256 mismatch for downloaded ${f.name}: got ${got}, expected ${f.sha256}`);
      const tmp = `${dest}.tmp`;
      fs.writeFileSync(tmp, buf);
      fs.renameSync(tmp, dest);
      process.stdout.write(`${(buf.length / 1048576).toFixed(1)} MB\n`);
    }
    const got = sha256(fs.readFileSync(dest));
    if (got !== f.sha256) {
      throw new Error(`SHA-256 mismatch for ${path.relative(ROOT, dest)}: got ${got}, expected ${f.sha256}. Delete it and re-run.`);
    }
  }
  console.log(`cloudflared ${VERSION} verified in ${path.relative(ROOT, OUT_DIR)}`);
}

main().catch(err => {
  console.error(`fetch-cloudflared: ${err.message}`);
  process.exit(1);
});
