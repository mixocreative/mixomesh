// Recent-projects list (idb kv) + save-time viewport thumbnail.

import { capturePng } from '../RenderOutput.js';
import { kvSet, kvGet, putFileHandle } from '../idb.js';
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

export async function pushRecent(name, handle) {
  const handleKey = `recent_${Date.now().toString(36)}`;
  try { await putFileHandle(handleKey, handle); } catch { /* */ }
  const thumb = await _screenshot();
  let list = (await kvGet(RECENT_KEY)) || [];
  list = list.filter(r => r.name !== name);
  list.unshift({ name, path: name + FILE_EXT, savedAt: new Date().toISOString(), handleKey, thumbnailDataUrl: thumb });
  if (list.length > RECENT_MAX) list = list.slice(0, RECENT_MAX);
  await kvSet(RECENT_KEY, list);
}

/** @returns {Promise<Array>} recent project entries (most-recent first). */
export async function getRecentProjects() {
  return (await kvGet(RECENT_KEY)) || [];
}
