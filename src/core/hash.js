/**
 * sha256 hex of an ArrayBuffer — the §10b texture/asset identity scope.
 * Shared by AssetLoader (import-time contentHash) and PersistenceManager
 * (embed hashing + directory hash-scan resolve).
 */
export async function sha256Hex(buf) {
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}
