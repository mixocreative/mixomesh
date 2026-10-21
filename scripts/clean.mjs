#!/usr/bin/env node
// Clean build: remove every generated output so a build never ships or serves
// leftovers — old hashed assets in dist/, a stale electron-builder release/,
// and Vite's dependency cache (node_modules/.vite), which can keep serving
// stale modules to dev workers across rebuilds. Runs automatically before
// `npm run build` and `npm run dist` (npm pre-scripts); `npm run clean` alone.
// Sources and installed packages are never touched.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const CLEAN_DIRS = ['dist', 'release', 'node_modules/.vite'];

/** Remove the generated directories under `root`. Returns the ones that existed. */
export function cleanBuildOutputs(root) {
  const removed = [];
  for (const rel of CLEAN_DIRS) {
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) continue;
    fs.rmSync(abs, { recursive: true, force: true });
    removed.push(rel);
  }
  return removed;
}

/**
 * Keep only the installer just built (and its .sha256) in `dir`; older
 * MIXOMESH-Setup-*.exe versions and their checksums are removed. Other files stay.
 */
export function pruneOldInstallers(dir, keepName) {
  if (!fs.existsSync(dir)) return [];
  const keep = new Set([keepName, `${keepName}.sha256`]);
  const removed = [];
  for (const name of fs.readdirSync(dir)) {
    if (!/^MIXOMESH-Setup-.+\.exe(\.sha256)?$/.test(name) || keep.has(name)) continue;
    fs.rmSync(path.join(dir, name), { force: true });
    removed.push(name);
  }
  return removed;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const removed = cleanBuildOutputs(root);
  console.log(removed.length ? `clean: removed ${removed.join(', ')}` : 'clean: nothing to remove');
}
