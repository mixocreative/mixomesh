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
import net from 'node:net';

export const CLEAN_DIRS = ['dist', 'release', 'node_modules/.vite'];

/** The `npm run dev` port (package.json "dev": vite --port 5173). */
export const DEV_PORT = 5173;

/** Remove the generated directories under `root`. Returns the ones that existed.
 *  `keepViteCache`: leave node_modules/.vite (a running dev server owns it). */
export function cleanBuildOutputs(root, { keepViteCache = false } = {}) {
  const removed = [];
  for (const rel of CLEAN_DIRS) {
    if (keepViteCache && rel === 'node_modules/.vite') continue;
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

/** Is something accepting connections on 127.0.0.1:port? */
export function isPortListening(port, timeoutMs = 300) {
  return new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const done = result => { socket.destroy(); resolve(result); };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  // Deleting Vite's dep cache under a running dev server breaks that server.
  const keepViteCache = await isPortListening(DEV_PORT);
  const removed = cleanBuildOutputs(root, { keepViteCache });
  console.log(removed.length ? `clean: removed ${removed.join(', ')}` : 'clean: nothing to remove');
  if (keepViteCache) console.log(`clean: kept node_modules/.vite (dev server running on ${DEV_PORT})`);
}
