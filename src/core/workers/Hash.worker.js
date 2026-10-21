// sha256 of an import's source bytes off the UI thread (heavy-mesh spec §4):
// the worker reads the Blob itself (a Blob crosses postMessage by reference),
// so the main thread never holds a copy of a 500 MB file just to hash it, and
// WebCrypto's synchronous input copy happens here, not on the UI thread.
import { serveTask } from './serveTask.js';
import { hexOfDigest } from '../hashHex.js';

serveTask(async ({ blob }, { progress }) => {
  // Stages only (neither step reports real progress) — review I6.
  progress({ stage: 'read' });
  const buf = await blob.arrayBuffer();
  progress({ stage: 'hash' });
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return hexOfDigest(digest);
});
