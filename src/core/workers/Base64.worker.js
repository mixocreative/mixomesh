// Off-main-thread base64 encoder (audit #3): manual save / explicit .mixo embed
// base64-encodes asset bytes, which for a single large asset blocks the main
// thread (measured ~400 ms for 100 MB). The main thread (Base64Worker.js)
// transfers a COPY of the bytes here so the live buffer is never detached; this
// worker runs the SAME shared codec the sync fallback uses, so the output is
// byte-identical regardless of which path produced it.
import { encodeBase64 } from './base64Codec.js';
import { serveTask } from './serveTask.js';

serveTask(({ buffer }, { progress }) => encodeBase64(buffer, (fraction) => progress({ stage: 'encode', fraction })));
