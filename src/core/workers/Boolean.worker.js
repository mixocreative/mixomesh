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
    // Tagged so the client treats it as "worker cannot do Booleans" and falls
    // back inline, instead of reporting a load error for a valid Boolean.
    .catch(err => { _wasm = null; throw new Error(`manifold-unavailable: ${err?.message ?? err}`); });
  return _wasm;
}

serveTask(async ({ op, operands, manifoldUrl }, { progress }) => {
  // Stages only: neither step is measurable, so the activity row stays
  // indeterminate instead of showing a frozen percentage (review I6).
  progress({ stage: 'load' });
  const wasm = await manifold(manifoldUrl);
  progress({ stage: 'boolean' });
  const out = booleanArrays(wasm, op, operands);
  const transfer = [out.positions.buffer, out.indices.buffer, ...(out.normals ? [out.normals.buffer] : [])];
  return transferable(out, transfer);
});
