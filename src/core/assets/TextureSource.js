// Full-res texture source registry (perf wave 2026-06-13 — the viewport
// texture cap's safety net).
//
// THE LOCK: Mimaki export reads pixels straight off the LIVE GPU texture
// (print/ExportTextures.js → TextureReadback.readTextureRGBA). That made any
// viewport-side texture downscale unsafe — capping the GPU texture would
// silently degrade the export. This registry breaks that coupling: we capture
// each texture's full-res, export-ready PNG ONCE (before any cap is applied)
// and hand THAT to the export path. With a source on file the viewport GPU
// texture can be downscaled freely (VRAM relief on heavy 4096² scenes) while
// the export stays bit-for-bit full resolution.
//
// Why store the export PNG and not the original file bytes: capturing via the
// SAME textureToPngBlob() the export uses guarantees orientation/encoding
// parity by construction (the glTF↔3MF Y-flip contract lives in one place —
// TextureReadback.EXPORT_FLIP_Y). The stored blob is literally what a full-res
// GPU readback would have produced, frozen before the cap touches the texture.

const _sources = new Map();   // assetId → { blob, width, height }

/**
 * Record a texture's full-res export PNG under its asset id. Idempotent —
 * first writer wins (capture happens pre-cap; a later capped readback must
 * never overwrite the full-res source).
 * @param {string} assetId
 * @param {Blob} blob   export-ready PNG (textureToPngBlob output)
 * @param {number} width
 * @param {number} height
 */
export function setTextureSource(assetId, blob, width, height) {
  if (!assetId || !blob || _sources.has(assetId)) return;
  _sources.set(assetId, { blob, width, height });
}

/** @returns {{ blob: Blob, width: number, height: number }|null} */
export function getTextureSource(assetId) {
  return _sources.get(assetId) ?? null;
}

/** @returns {boolean} */
export function hasTextureSource(assetId) {
  return _sources.has(assetId);
}

/** Drop one source (texture asset released). */
export function clearTextureSource(assetId) {
  _sources.delete(assetId);
}

/** Drop every source (new/load project — mirrors resetTextures). */
export function clearTextureSources() {
  _sources.clear();
}
