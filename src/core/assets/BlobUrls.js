// Shared blob-URL registry (split from AssetLoader.js — review L29).
// Mesh containers AND texture assets cache their source bytes behind object
// URLs keyed by assetId; persistence reads them back via getAssetBytes and
// reset revokes everything. One registry, two consumers (AssetLoader,
// TextureAssets), so ownership stays unambiguous.

const _blobUrls = new Map();   // assetId → object URL

export function setBlobUrl(assetId, url) { _blobUrls.set(assetId, url); }
export function getBlobUrl(assetId) { return _blobUrls.get(assetId) ?? null; }

export function revokeBlobUrl(assetId) {
  const url = _blobUrls.get(assetId);
  if (url) { URL.revokeObjectURL(url); _blobUrls.delete(assetId); }
}

export function revokeAllBlobUrls() {
  for (const url of _blobUrls.values()) URL.revokeObjectURL(url);
  _blobUrls.clear();
}
