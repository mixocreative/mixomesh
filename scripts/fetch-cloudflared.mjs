// Fetch + verify the cloudflared binary into vendor/cloudflared/ for DEV use (Listbridge PB.5b).
//
// The installer does NOT bundle cloudflared (Cults3D uploads natively). The packaged app
// downloads the same pinned, SHA-256-verified release once, on first use of a URL-only
// platform (electron/listbridge/cloudflaredPin.cjs, shared with this script). In a dev
// checkout, tunnel.cjs finds the copy fetched here under vendor/.
//
//   node scripts/fetch-cloudflared.mjs           download if missing, then verify
//   node scripts/fetch-cloudflared.mjs --check   verify only (no network)

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const { VERSION, FILES, sha256Hex, downloadVerifiedTo } = createRequire(import.meta.url)('../electron/listbridge/cloudflaredPin.cjs');

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'vendor', 'cloudflared');
const checkOnly = process.argv.includes('--check');

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const f of FILES) {
    const dest = path.join(OUT_DIR, f.name);
    if (!fs.existsSync(dest)) {
      if (checkOnly) throw new Error(`${path.relative(ROOT, dest)} is missing (run: node scripts/fetch-cloudflared.mjs)`);
      process.stdout.write(`fetching ${f.name} (cloudflared ${VERSION})… `);
      const n = await downloadVerifiedTo(f, dest);
      process.stdout.write(`${(n / 1048576).toFixed(1)} MB\n`);
    }
    const got = sha256Hex(fs.readFileSync(dest));
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
