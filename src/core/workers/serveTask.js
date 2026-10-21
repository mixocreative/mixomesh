// Worker side of the WorkerTask protocol (see WorkerTask.js). A worker module
// calls serveTask(handler) once:
//   handler(payload, { progress(fields), revision }) → result
//     or { result, transfer: Transferable[] } via the `transferable()` wrapper.
// The revision from the request is echoed on 'done' so the client can drop
// stale results.

const TRANSFER = Symbol('transfer');

/** Wrap a result so its buffers are transferred, not copied. */
export function transferable(result, transfer) {
  return { [TRANSFER]: true, result, transfer };
}

export function serveTask(handler, scope = self) {
  scope.onmessage = async (event) => {
    const msg = event.data;
    if (!msg || msg.type !== 'run') return;
    const { id, payload, revision } = msg;
    const progress = (fields) => scope.postMessage({ ...fields, id, type: 'progress' });
    try {
      const out = await handler(payload, { progress, revision });
      const wrapped = out && out[TRANSFER];
      scope.postMessage(
        { id, type: 'done', result: wrapped ? out.result : out, ...(revision != null ? { revision } : {}) },
        wrapped ? out.transfer : [],
      );
    } catch (err) {
      scope.postMessage({ id, type: 'error', message: err?.message ?? String(err) });
    }
  };
}
