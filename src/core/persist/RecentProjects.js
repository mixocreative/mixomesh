// Recent-projects list (adapter KV) + save-time viewport thumbnail. The file
// ref is persisted through `storage.persistRef` (task 4.4) — browser: handle in
// IndexedDB; desktop: stable `file_` key, path kept main-side — so recents and
// their refs live in the SAME runtime store on both builds.

import { capturePng } from '../RenderOutput.js';
import { storage } from '../storage/StorageAdapter.js';
import { RECENT_KEY, RECENT_MAX, FILE_EXT } from './constants.js';

async function _screenshot() {
  try {
    // Routed through RenderOutput.capturePng so it works on BOTH engines —
    // CreateScreenshotUsingRenderTargetAsync returns empty on WebGPU.
    const blob = await capturePng({ width: 240, height: 160 });
    return await new Promise((res) => {
      const fr = new FileReader();
      fr.onload = () => res(fr.result);
      fr.onerror = () => res(null);
      fr.readAsDataURL(blob);
    });
  } catch { return null; }
}

export async function pushRecent(name, ref) {
  let handleKey = null;
  try { handleKey = ref ? await storage.persistRef(ref) : null; }
  catch { /* entry still listed; opening it reports the lost file */ }
  const thumb = await _screenshot();
  let list = (await storage.kvGet(RECENT_KEY)) || [];
  const dropped = list.filter(r => r.name === name);
  list = list.filter(r => r.name !== name);
  list.unshift({ name, path: name + FILE_EXT, savedAt: new Date().toISOString(), handleKey, thumbnailDataUrl: thumb });
  if (list.length > RECENT_MAX) {
    dropped.push(...list.slice(RECENT_MAX));
    list = list.slice(0, RECENT_MAX);
  }
  await storage.kvSet(RECENT_KEY, list);
  // Forget refs no surviving entry points at (the browser file key changes with
  // size/mtime, so every save would otherwise leave one stale handle behind).
  const kept = new Set(list.map(r => r.handleKey));
  for (const r of dropped) {
    if (r.handleKey && !kept.has(r.handleKey)) {
      try { await storage.deleteRef(r.handleKey); } catch { /* best effort */ }
    }
  }
}

/** @returns {Promise<Array>} recent project entries (most-recent first). */
export async function getRecentProjects() {
  return (await storage.kvGet(RECENT_KEY)) || [];
}
