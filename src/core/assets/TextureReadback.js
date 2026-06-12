// Shared GPU-texture readback (review C1). The ONLY correct way to get pixel
// bytes out of a Babylon texture in this codebase — modern Babylon's
// readPixels() returns a Promise, GL rows come back bottom-up, and PBR
// textures may read back as Float32 or RGB-stride buffers. AssetLoader
// thumbnails and PrintManager texture export both route through here so the
// handling can't drift apart again.

/**
 * Read a texture into a normalized RGBA byte buffer.
 * Awaits Promise-returning readPixels, converts Float32 → Uint8, expands
 * RGB stride → RGBA. Rows are in GL order (bottom-up) — callers that need
 * image order apply {@link flipRGBAVertically}.
 * @returns {Promise<{rgba: Uint8ClampedArray, width: number, height: number}|null>}
 */
export async function readTextureRGBA(texture) {
  // Real Babylon textures expose both; some stubs/raw textures only one.
  const size = texture?.getSize?.() ?? texture?.getBaseSize?.();
  const w = size?.width | 0;
  const h = size?.height | 0;
  if (!w || !h) return null;

  let pixels = texture.readPixels?.();
  if (pixels && typeof pixels.then === 'function') pixels = await pixels;
  if (!pixels) return null;

  let rgba;
  if (pixels instanceof Uint8Array || pixels instanceof Uint8ClampedArray) {
    const u8 = pixels instanceof Uint8ClampedArray
      ? pixels
      : new Uint8ClampedArray(pixels.buffer, pixels.byteOffset, pixels.byteLength);
    if (u8.length === w * h * 4) {
      rgba = u8;
    } else if (u8.length === w * h * 3) {
      rgba = new Uint8ClampedArray(w * h * 4);
      for (let i = 0, j = 0; i < u8.length; i += 3, j += 4) {
        rgba[j] = u8[i]; rgba[j + 1] = u8[i + 1]; rgba[j + 2] = u8[i + 2]; rgba[j + 3] = 255;
      }
    } else {
      return null;
    }
  } else if (pixels instanceof Float32Array) {
    const stride = pixels.length === w * h * 4 ? 4 : pixels.length === w * h * 3 ? 3 : 0;
    if (!stride) return null;
    rgba = new Uint8ClampedArray(w * h * 4);
    for (let i = 0, j = 0; i < pixels.length; i += stride, j += 4) {
      rgba[j]     = Math.round(Math.max(0, Math.min(1, pixels[i]))     * 255);
      rgba[j + 1] = Math.round(Math.max(0, Math.min(1, pixels[i + 1])) * 255);
      rgba[j + 2] = Math.round(Math.max(0, Math.min(1, pixels[i + 2])) * 255);
      rgba[j + 3] = stride === 4 ? Math.round(Math.max(0, Math.min(1, pixels[i + 3])) * 255) : 255;
    }
  } else {
    return null;
  }
  return { rgba, width: w, height: h };
}

// Paint an RGBA buffer onto a 2d context via createImageData + data.set —
// avoids the ImageData constructor, which the headless canvas stub lacks.
function _putRGBA(ctx, rgba, width, height) {
  const imageData = ctx.createImageData(width, height);
  imageData.data.set(rgba);
  ctx.putImageData(imageData, 0, 0);
}

/** Swap pixel rows in place — GL bottom-up → image top-down. Pure. */
export function flipRGBAVertically(rgba, width, height) {
  const rowBytes = width * 4;
  const tmp = new Uint8ClampedArray(rowBytes);
  for (let top = 0, bot = height - 1; top < bot; top++, bot--) {
    const a = top * rowBytes, b = bot * rowBytes;
    tmp.set(rgba.subarray(a, a + rowBytes));
    rgba.copyWithin(a, b, b + rowBytes);
    rgba.set(tmp, b);
  }
  return rgba;
}

// Texture-orientation contract (pinned mechanically by the Y-flip assert in
// tests/browser-export-smoke.mjs): glTF UV origin is TOP-left, 3MF Materials
// texture space origin is BOTTOM-left, and our writer passes UVs through
// unchanged — so the exported PNG must be the VERTICAL FLIP of the source
// image. EXPORT_FLIP_Y = true produces exactly that. ONE switch — flip here,
// nowhere else; the smoke fails if either side drifts.
export const EXPORT_FLIP_Y = true;

/**
 * Encode a texture as a PNG Blob at native size (export path).
 * @returns {Promise<Blob|null>}
 */
export async function textureToPngBlob(texture, { flipY = EXPORT_FLIP_Y } = {}) {
  const r = await readTextureRGBA(texture);
  if (!r) return null;
  if (flipY) flipRGBAVertically(r.rgba, r.width, r.height);
  const canvas = document.createElement('canvas');
  canvas.width = r.width;
  canvas.height = r.height;
  const ctx = canvas.getContext('2d');
  _putRGBA(ctx, r.rgba, r.width, r.height);
  return new Promise((resolve, reject) => {
    canvas.toBlob(b => (b ? resolve(b) : reject(new Error('toBlob produced no blob'))), 'image/png');
  });
}

/**
 * Encode a texture as a square data-URL thumbnail (asset panel path).
 * @returns {Promise<string|null>}
 */
export async function textureToDataUrl(texture, targetSize) {
  const r = await readTextureRGBA(texture);
  if (!r) return null;
  flipRGBAVertically(r.rgba, r.width, r.height);
  const source = document.createElement('canvas');
  source.width = r.width;
  source.height = r.height;
  _putRGBA(source.getContext('2d'), r.rgba, r.width, r.height);
  const thumb = document.createElement('canvas');
  thumb.width = targetSize;
  thumb.height = targetSize;
  thumb.getContext('2d').drawImage(source, 0, 0, targetSize, targetSize);
  return thumb.toDataURL('image/png');
}
