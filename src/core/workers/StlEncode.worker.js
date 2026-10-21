// Binary STL encoding off the main thread for large exports (StlWriter.js is
// the client). Same pure encoder as the inline path, so bytes are identical.
import { encodeBinarySTLFromArrays } from '../print/stlEncode.js';
import { serveTask, transferable } from './serveTask.js';

serveTask(({ parts, solidName }) => {
  const bytes = encodeBinarySTLFromArrays(parts, solidName);
  return transferable(bytes, [bytes.buffer]);
});
