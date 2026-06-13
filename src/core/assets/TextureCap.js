// Viewport texture cap (perf wave 2026-06-13). Downsamples the GPU copy of a
// texture for VRAM relief on heavy 4096²+ scenes WITHOUT touching export
// fidelity — export reads the full-res source from TextureSource.js, not the
// GPU. Safe to cap as aggressively as the viewport tolerates.
//
// Capture-then-cap order matters: the full-res export PNG must be frozen
// BEFORE the GPU texture is downscaled, or the source would already be lossy.
// captureAndCap() enforces that order at the import seam.
//
// Re-upload orientation: the stored PNG is display-oriented (it is the same
// single-flip readback the asset-panel thumbnails use, which render upright —
// and export uses the same flip, so source == display == original-file
// orientation). Feeding it back through Texture.updateURL with the texture's
// existing invertY (false) reproduces the original GPU upload exactly, just at
// a smaller size. No extra flip.

import { textureToPngBlob } from './TextureReadback.js';
import { setTextureSource, getTextureSource } from './TextureSource.js';
import { getState } from '../StateManager.js';

const _capUrls = new Map();   // assetId → object URL currently applied (for revoke)

/** Active cap in px (0 / undefined = off, full resolution). */
export function currentCapPx() {
  const c = getState().scene?.render?.textureCapPx;
  return Number.isFinite(c) && c > 0 ? c : 0;
}

function _maxDim(texture) {
  const s = texture?.getSize?.();
  return Math.max(s?.width | 0, s?.height | 0);
}

/**
 * Capture the full-res export source (once) then apply the active cap to the
 * GPU texture. Called from the texture-asset registration seam after the
 * texture is ready. Failures are swallowed — a missing source just means this
 * texture can't be capped (export still reads the GPU as before).
 * @param {string} assetId
 * @param {BABYLON.BaseTexture} texture
 */
export async function captureAndCap(assetId, texture) {
  if (!assetId || !texture) return;
  try {
    if (!getTextureSource(assetId)) {
      const blob = await textureToPngBlob(texture);   // export-ready, full res
      if (blob) {
        const s = texture.getSize?.() ?? {};
        setTextureSource(assetId, blob, s.width | 0, s.height | 0);
      }
    }
  } catch (err) {
    console.warn(`Texture source capture failed for ${assetId}:`, err);
  }
  await applyCapToTexture(assetId, texture, currentCapPx());
}

/**
 * Resize the GPU texture to the cap (or restore to full when capPx is off).
 * Re-decodes from the stored full-res source so a downscale is never permanent
 * — raising the cap restores detail. No-op when no source was captured or the
 * environment can't rasterize (headless without canvas).
 * @param {string} assetId
 * @param {BABYLON.BaseTexture} texture
 * @param {number} capPx   0 = off / full resolution
 */
export async function applyCapToTexture(assetId, texture, capPx) {
  const src = getTextureSource(assetId);
  if (!src || typeof document === 'undefined'
      || typeof createImageBitmap !== 'function'
      || typeof texture?.updateURL !== 'function') return;

  const srcMax = Math.max(src.width, src.height) || 0;
  if (!srcMax) return;
  const targetMax = (!capPx || capPx >= srcMax) ? srcMax : capPx;
  if (_maxDim(texture) === targetMax) return;   // already there

  let bitmap;
  try {
    bitmap = await createImageBitmap(src.blob);
  } catch (err) {
    console.warn(`Texture cap decode failed for ${assetId}:`, err);
    return;
  }
  const scale = targetMax / srcMax;
  const w = Math.max(1, Math.round(src.width * scale));
  const h = Math.max(1, Math.round(src.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();

  const url = await new Promise(res =>
    canvas.toBlob(b => res(b ? URL.createObjectURL(b) : null), 'image/png'));
  if (!url) return;
  const prev = _capUrls.get(assetId);
  texture.updateURL(url);
  _capUrls.set(assetId, url);
  if (prev) URL.revokeObjectURL(prev);
}

/** Forget an asset's cap URL (texture released). */
export function clearCapUrl(assetId) {
  const url = _capUrls.get(assetId);
  if (url) { URL.revokeObjectURL(url); _capUrls.delete(assetId); }
}

/** Revoke all cap URLs (reset). */
export function clearCapUrls() {
  for (const url of _capUrls.values()) URL.revokeObjectURL(url);
  _capUrls.clear();
}
