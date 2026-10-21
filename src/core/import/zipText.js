// Stream a zip entry as decoded text chunks (heavy-mesh spec §4): JSZip's
// internalStream → TextDecoder(stream) so a model part larger than V8's
// string limit never becomes one string. Falls back to async('text') for
// zip stand-ins that have no stream (test stubs, pre-parsed packages).

const HIGH_WATER = 8;

/**
 * @param {{ internalStream?: Function, async: Function, _data?: { uncompressedSize?: number } }} file  JSZip entry
 * @param {{ onProgress?: (fraction: number) => void }} [opts]
 * @returns {AsyncGenerator<string>}
 */
export async function* zipEntryTextChunks(file, { onProgress } = {}) {
  if (typeof file?.internalStream !== 'function') {
    yield await file.async('text');
    onProgress?.(1);
    return;
  }
  const total = file._data?.uncompressedSize ?? 0;
  const decoder = new TextDecoder();
  const queue = [];
  let done = false;
  let failure = null;
  let wake = null;
  let seen = 0;
  const notify = () => { const w = wake; wake = null; w?.(); };
  const stream = file.internalStream('uint8array');
  stream.on('data', (chunk) => {
    seen += chunk.length;
    queue.push(decoder.decode(chunk, { stream: true }));
    if (queue.length >= HIGH_WATER) stream.pause();
    notify();
  });
  stream.on('error', (err) => { failure = err; notify(); });
  stream.on('end', () => { done = true; notify(); });
  stream.resume();
  for (;;) {
    if (queue.length) {
      const text = queue.shift();
      if (queue.length < HIGH_WATER / 2) stream.resume();
      if (text) yield text;
      if (total) onProgress?.(Math.min(1, seen / total));
      continue;
    }
    if (failure) throw failure;
    if (done) break;
    await new Promise(resolve => { wake = resolve; });
  }
  const tail = decoder.decode();
  if (tail) yield tail;
  onProgress?.(1);
}
