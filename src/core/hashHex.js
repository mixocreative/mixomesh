/** Lower-case hex of a digest (shared by hash.js and workers/Hash.worker.js). */
export function hexOfDigest(digest) {
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}
