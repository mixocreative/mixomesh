// Boolean worker: union / subtract / intersect on raw arrays with the vendored
// manifold-3d, off the main thread (BooleanWorker.js is the client). The
// main thread passes manifold.js's absolute URL — a worker has no
// document.baseURI, and the Electron file:// build needs the real path.
import { booleanArrays } from '../geometry/booleanCore.js';
import { serveTask, transferable } from './serveTask.js';

let _wasm = null;

function manifold(url) {
  _wasm ??= import(/* @vite-ignore */ url)
    .then(async ({ default: Module }) => {
      const wasm = await Module();
      wasm.setup();
      return wasm;
    })
    .catch(err => { _wasm = null; throw err; });
  return _wasm;
}

serveTask(async ({ op, operands, manifoldUrl }) => {
  const wasm = await manifold(manifoldUrl);
  const out = booleanArrays(wasm, op, operands);
  const transfer = [out.positions.buffer, out.indices.buffer, ...(out.normals ? [out.normals.buffer] : [])];
  return transferable(out, transfer);
});
