// Re-vendor (or verify) the Draco glTF decoder under public/vendor/draco/.
//
// Real-world glTF/GLB scans are KHR_draco_mesh_compression. Babylon's default
// decoder URLs point at cdn.babylonjs.com, which the Content-Security-Policy
// blocks and offline machines cannot reach, so the decoder ships with the app
// (src/core/DracoSetup.js points Babylon at it). The vendored files are
// committed; this script reproduces them from upstream and pins each one by
// SHA-256, the same way scripts/fetch-cloudflared.mjs pins cloudflared.
//
//   node scripts/fetch-draco.mjs           download from upstream, verify, write
//   node scripts/fetch-draco.mjs --check   verify the committed files (no network)

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DRACO_VERSION = '1.5.7';
const UPSTREAM = `https://raw.githubusercontent.com/google/draco/${DRACO_VERSION}`;
const OUT_DIR = join(fileURLToPath(new URL('..', import.meta.url)), 'public', 'vendor', 'draco');

// sha256 of the UPSTREAM bytes. The .wasm also matches the one inside
// `npm pack draco3dgltf@1.5.7` byte for byte.
const FILES = [
  { name: 'draco_wasm_wrapper_gltf.js', src: 'javascript/draco_wasm_wrapper_gltf.js', sha256: '8bb2952d2ba7d67e1414f8df819410cb0434a666be53f671fff75f68843d76f6' },
  { name: 'draco_decoder_gltf.wasm', src: 'javascript/draco_decoder_gltf.wasm', sha256: '712db3449ae2041d6e8a224c395bda6cedb49e51322fae38b7db9beb8b381889' },
  { name: 'LICENSE', src: 'LICENSE', sha256: 'd3709b0fb4b8a94bbb1d02b8a2e484f258b0d9c5c5a01f940391f3fe662cd1a4' },
];

const HEADER = Buffer.from(`// VENDORED THIRD-PARTY FILE — do not edit. Draco glTF decoder | https://github.com/google/draco | Apache-2.0 | draco ${DRACO_VERSION} | see public/vendor/NOTICE.md\n`);

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const withHeader = (name, bytes) => (name.endsWith('.js') ? Buffer.concat([HEADER, bytes]) : bytes);
const withoutHeader = (name, bytes) => (name.endsWith('.js') && bytes.subarray(0, HEADER.length).equals(HEADER)
  ? bytes.subarray(HEADER.length) : bytes);
// Upstream text files are LF; a Windows checkout with core.autocrlf turns them CRLF.
const asUpstream = (name, bytes) => (name.endsWith('.wasm') ? bytes
  : withoutHeader(name, Buffer.from(bytes.toString('latin1').replace(/\r\n/g, '\n'), 'latin1')));

async function download(file) {
  const res = await fetch(`${UPSTREAM}/${file.src}`);
  if (!res.ok) throw new Error(`GET ${UPSTREAM}/${file.src}: HTTP ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const got = sha256(bytes);
  if (got !== file.sha256) throw new Error(`SHA-256 mismatch for upstream ${file.src}: got ${got}, expected ${file.sha256}`);
  return bytes;
}

async function main() {
  const checkOnly = process.argv.includes('--check');
  mkdirSync(OUT_DIR, { recursive: true });
  for (const file of FILES) {
    const dest = join(OUT_DIR, file.name);
    if (!checkOnly) writeFileSync(dest, withHeader(file.name, await download(file)));
    if (!existsSync(dest)) throw new Error(`public/vendor/draco/${file.name} is missing (run: node scripts/fetch-draco.mjs)`);
    const got = sha256(asUpstream(file.name, readFileSync(dest)));
    if (got !== file.sha256) throw new Error(`public/vendor/draco/${file.name} does not match draco ${DRACO_VERSION}: sha256 ${got}`);
  }
  console.log(`draco ${DRACO_VERSION} decoder verified in public/vendor/draco`);
}

main().catch(err => {
  console.error(`fetch-draco: ${err.message}`);
  process.exit(1);
});
