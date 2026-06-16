// Off-main-thread base64 encoder (audit #3): manual save / explicit .mixo embed
// base64-encodes asset bytes, which for a single large asset blocks the main
// thread (measured ~400 ms for 100 MB). The main thread (Base64Worker.js)
// transfers a COPY of the bytes here so the live buffer is never detached; this
// worker runs the SAME shared codec the sync fallback uses, so the output is
// byte-identical regardless of which path produced it.
import { encodeBase64 } from './base64Codec.js';

self.onmessage = (e) => {
  const { id, buffer } = e.data ?? {};
  try {
    self.postMessage({ id, b64: encodeBase64(buffer) });
  } catch (err) {
    self.postMessage({ id, error: err?.message ?? 'base64 encode failed' });
  }
};
