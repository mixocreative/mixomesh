// Third-party notices for everything MIXOMESH ships (licence scan M1-M3).
//
//   node scripts/build-notices.mjs [--out dist/THIRD_PARTY_NOTICES.txt]
//
// Runs after `vite build` (npm "postbuild"), so the file lands in the web dist
// and — through electron-builder's `dist/**` plus an extraResources copy — in
// the desktop app. No dependency: walks the PRODUCTION dependency tree from
// package.json through node_modules/*/package.json and copies each package's
// own LICENSE / NOTICE files verbatim, then appends the non-npm material
// (Lucide/Feather icon paths, the bundled font, vendored WASM engines, HDRI
// environment maps).

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const LICENCE_FILE = /^(licen[cs]e|copying|notice)(\.(md|txt|markdown))?$/i;
const RULE = '='.repeat(78);

/** Licence choices for dual-licensed packages (we distribute under the permissive option). */
export const ELECTIONS = Object.freeze({
  jszip: 'MIT (jszip is dual-licensed "MIT OR GPL-3.0-or-later"; MIXOMESH uses it under the MIT licence).',
});

function readJson(path) { return JSON.parse(readFileSync(path, 'utf8')); }

/** Resolve a dependency's directory the way Node does (nested node_modules first). */
function resolvePkgDir(name, fromDir, root) {
  let dir = fromDir;
  for (;;) {
    const candidate = join(dir, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) return candidate;
    if (dir === root || dirname(dir) === dir) break;
    dir = dirname(dir);
    if (!dir.startsWith(root)) break;
  }
  const top = join(root, 'node_modules', name);
  return existsSync(join(top, 'package.json')) ? top : null;
}

/**
 * Production dependency tree (dependencies, optional and peer dependencies that are
 * installed; @types/* excluded),
 * de-duplicated by name@version, sorted by name.
 * @param {string} [root]
 */
export function productionPackages(root = ROOT) {
  const rootPkg = readJson(join(root, 'package.json'));
  const seen = new Map();
  const queue = Object.keys(rootPkg.dependencies ?? {}).map(name => ({ name, from: root }));
  while (queue.length) {
    const { name, from } = queue.shift();
    const dir = resolvePkgDir(name, from, root);
    if (!dir || name.startsWith('@types/')) continue;   // type-only packages ship nothing
    const pkg = readJson(join(dir, 'package.json'));
    const key = `${pkg.name}@${pkg.version}`;
    if (seen.has(key)) continue;
    const files = readdirSync(dir).filter(f => LICENCE_FILE.test(f)).sort();
    seen.set(key, {
      name: pkg.name, version: pkg.version,
      license: typeof pkg.license === 'string' ? pkg.license : (pkg.license?.type ?? (pkg.licenses ?? []).map(l => l.type).join(' OR ')) || 'UNKNOWN',
      repository: typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url ?? '',
      author: typeof pkg.author === 'string' ? pkg.author : pkg.author?.name ?? '',
      texts: files.map(f => ({ file: f, text: readFileSync(join(dir, f), 'utf8').trim() })),
    });
    // Installed peers ship too (e.g. babylonjs-gltf2interface for the glTF loader).
    for (const dep of [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.optionalDependencies ?? {}), ...Object.keys(pkg.peerDependencies ?? {})]) {
      queue.push({ name: dep, from: dir });
    }
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

const MIT_TEXT = (holder) => `Copyright (c) ${holder}

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.`;

const ISC_TEXT = (holder) => `Copyright (c) ${holder}

Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted, provided that the above copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.`;

function section(title, body) {
  return `${RULE}\n${title}\n${RULE}\n\n${body.trim()}\n\n`;
}

function packageSection(p) {
  const head = [
    `${p.name} ${p.version}`,
    `Licence: ${p.license}`,
    ELECTIONS[p.name] ? `Licence elected: ${ELECTIONS[p.name]}` : '',
    p.repository ? `Source: ${p.repository.replace(/^git\+/, '')}` : '',
  ].filter(Boolean).join('\n');
  const body = p.texts.length
    ? p.texts.map(t => `--- ${t.file} ---\n\n${t.text}`).join('\n\n')
    : /^MIT$/i.test(p.license) ? `(No licence file in the package; standard MIT text, copyright holder from package.json:)\n\n${MIT_TEXT(p.author || `${p.name} contributors`)}`
      : /^ISC$/i.test(p.license) ? `(No licence file in the package; standard ISC text, copyright holder from package.json:)\n\n${ISC_TEXT(p.author || `${p.name} contributors`)}`
        : `(No licence file in the package; licence identifier: ${p.license}.)`;
  return section(head, body);
}

/**
 * Build the notices text.
 * @param {{ root?: string }} [opts]
 */
export function buildNotices({ root = ROOT } = {}) {
  const pkgs = productionPackages(root);
  const read = (rel) => readFileSync(join(root, rel), 'utf8').trim();
  const parts = [];
  parts.push(`MIXOMESH — third-party notices\n\nMIXOMESH includes the software, data and fonts listed below. Each is\nused under the licence shown; full licence texts follow. Generated by\nscripts/build-notices.mjs from the installed packages.\n\nContents:\n${[
    ...pkgs.map(p => `  - ${p.name} ${p.version} (${p.license})`),
    '  - Lucide icons (ISC) incl. Feather (MIT) — icon path data',
    '  - Zen Kaku Gothic New font (SIL OFL 1.1)',
    '  - MeshFixLib (MIT), Manifold (Apache-2.0, embeds Clipper2 BSL-1.0 and oneTBB Apache-2.0) — vendored WASM',
    '  - Draco glTF decoder 1.5.7 (Apache-2.0) — vendored WASM',
    '  - HDRI environment maps from the Babylon.js Assets repository (CC BY 4.0)',
  ].join('\n')}\n\n`);
  for (const p of pkgs) parts.push(packageSection(p));
  parts.push(section('Lucide icons (ISC) and Feather icons (MIT)', read('scripts/notices/lucide-feather.txt')));
  parts.push(section('Zen Kaku Gothic New (fonts/OFL-zen-kaku-gothic-new.txt)', read('public/fonts/OFL-zen-kaku-gothic-new.txt')));
  parts.push(section('Vendored engines (vendor/NOTICE.md)', read('public/vendor/NOTICE.md')));
  parts.push(section('MeshFixLib licence (vendor/meshfix/LICENSE)', read('public/vendor/meshfix/LICENSE')));
  parts.push(section('Manifold licence (vendor/manifold-3d/LICENSE)', `${read('public/vendor/manifold-3d/LICENSE')}

Manifold's WebAssembly build also embeds Clipper2 (Boost Software License 1.0,
https://github.com/AngusJohnson/Clipper2) and oneTBB initialisation code
(Apache License 2.0, https://github.com/oneapi-src/oneTBB).`));
  parts.push(section('Draco glTF decoder licence (vendor/draco/LICENSE)', read('public/vendor/draco/LICENSE')));
  parts.push(section('HDRI environment maps (Babylon.js Assets, CC BY 4.0)', read('scripts/notices/environments.txt')));
  return parts.join('');
}

function main() {
  const i = process.argv.indexOf('--out');
  const out = resolve(ROOT, i > 0 ? process.argv[i + 1] : 'dist/THIRD_PARTY_NOTICES.txt');
  mkdirSync(dirname(out), { recursive: true });
  const text = buildNotices();
  writeFileSync(out, text);
  console.log(`third-party notices: ${out} (${Math.round(text.length / 1024)} KB)`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
