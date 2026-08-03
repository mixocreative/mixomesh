import { sha256Hex } from '../hash.js';

const _images = new Map(); // sha256 → frozen { hash, blob, width, height, mimeType }

function asArrayBuffer(bytes) {
  if (bytes instanceof Blob) return bytes.arrayBuffer();
  if (bytes instanceof ArrayBuffer) return Promise.resolve(bytes);
  if (ArrayBuffer.isView(bytes)) {
    return Promise.resolve(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  }
  throw new TypeError('Image identity requires Blob, ArrayBuffer, or typed-array bytes');
}

/** SHA-256 identity of canonical encoded image bytes; filenames never participate. */
export async function hashImage(bytes) {
  return sha256Hex(await asArrayBuffer(bytes));
}

/** Store one canonical image payload. Equal bytes retain the first payload. */
export async function storeTextureImage(blob, width = 0, height = 0, knownHash = null) {
  const actualHash = await hashImage(blob);
  if (knownHash && knownHash !== actualHash) throw new Error('Texture image hash mismatch');
  const hash = actualHash;
  if (!_images.has(hash)) {
    _images.set(hash, Object.freeze({
      hash,
      blob,
      width: width | 0,
      height: height | 0,
      mimeType: blob.type || 'application/octet-stream',
    }));
  } else if (width > 0 && height > 0) {
    const current = _images.get(hash);
    if (!current.width || !current.height) {
      _images.set(hash, Object.freeze({ ...current, width: width | 0, height: height | 0 }));
    }
  }
  return hash;
}

export function updateTextureImageDimensions(hash, width, height) {
  const current = _images.get(hash);
  if (!current || current.width && current.height || width <= 0 || height <= 0) return;
  _images.set(hash, Object.freeze({ ...current, width: width | 0, height: height | 0 }));
}

export function getTextureImage(hash) { return _images.get(hash) ?? null; }
export function listTextureImages() { return Object.freeze([..._images.values()]); }
export function clearTextureImages() { _images.clear(); }
