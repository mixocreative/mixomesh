// Shared, pure base64 encoder used by BOTH the main-thread sync path
// (PersistenceManager._b64FromBuf) and the off-thread Base64 worker, so their
// output is byte-identical by construction (audit #3). No DOM / Babylon deps,
// so it's safe to import inside a module worker. `btoa` is a global on the main
// thread, in Web Workers, and in Node 16+ (the headless test runtime).
export function encodeBase64(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let bin = '';
  const CHUNK = 0x8000;   // stay under the fromCharCode argument-count limit
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}
