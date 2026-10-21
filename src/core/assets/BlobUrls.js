// Shared blob-URL registry (split from AssetLoader.js — review L29).
// Mesh containers AND texture assets cache their source bytes behind object
// URLs keyed by assetId; persistence reads them back via getAssetBytes and
// reset revokes everything. One registry, two consumers (AssetLoader,
// TextureAssets), so ownership stays unambiguous.

const _blobUrls = new Map();   // assetId → object URL
// assetId → the Blob behind the URL, when known. The URL already keeps the
// Blob alive, so this costs nothing; it lets re-instantiation size-check and
// budget-check the source without reading it (heavy-mesh review I4).
const _blobs = new Map();

export function setBlobUrl(assetId, url, blob = null) {
  _blobUrls.set(assetId, url);
  if (blob) _blobs.set(assetId, blob); else _blobs.delete(assetId);
}
export function getBlobUrl(assetId) { return _blobUrls.get(assetId) ?? null; }
export function getBlob(assetId) { return _blobs.get(assetId) ?? null; }

export function revokeBlobUrl(assetId) {
  const url = _blobUrls.get(assetId);
  if (url) { URL.revokeObjectURL(url); _blobUrls.delete(assetId); }
  _blobs.delete(assetId);
}

export function revokeAllBlobUrls() {
  for (const url of _blobUrls.values()) URL.revokeObjectURL(url);
  _blobUrls.clear();
  _blobs.clear();
}
