/**
 * Worker side of the WorkerTask protocol (see WorkerTask.ts; port of mixomesh `serveTask.js`).
 * A worker module calls `serveTask(handler)` once:
 *   handler(payload, { progress(fields), revision }) → result,
 *   or `transferable(result, buffers)` so the buffers move instead of being copied.
 * The request's revision is echoed on 'done' so the client can drop stale results. A thrown error's
 * string `code` and `vars` (an extension of mixomesh's contract) travel with its message.
 */

const TRANSFER = Symbol('transfer');

interface Transferred<R> {
  [TRANSFER]: true;
  result: R;
  transfer: Transferable[];
}

/** Wrap a result so its buffers are transferred, not copied. */
export function transferable<R>(result: R, transfer: Transferable[]): Transferred<R> {
  return { [TRANSFER]: true, result, transfer };
}

/** What a handler gets besides the payload: a progress poster and the request's revision (if any). */
export interface TaskContext {
  progress(fields: Record<string, unknown>): void;
  revision: number | undefined;
}

interface Scope {
  onmessage: ((event: { data: unknown }) => unknown) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
}

/**
 * Installs `handler` as the worker's message handler (call once per worker module). Replies 'done'
 * with the result (echoing the revision), or 'error' with the thrown message and its string `code`
 * and object `vars`. `scope` replaces the worker global in tests.
 */
export function serveTask<P, R>(handler: (payload: P, context: TaskContext) => R | Transferred<R> | Promise<R | Transferred<R>>, scope?: Scope): void {
  // Resolved per message (not once) so a stubbed global in tests still gets the replies.
  const target = () => scope ?? (self as unknown as Scope);
  target().onmessage = async (event) => {
    const message = event.data as { id: number; type: string; payload: P; revision?: number } | null;
    if (!message || message.type !== 'run') return;
    const { id, payload, revision } = message;
    const progress = (fields: Record<string, unknown>) => target().postMessage({ ...fields, id, type: 'progress' });
    try {
      const out = await handler(payload, { progress, revision });
      const wrapped = out !== null && typeof out === 'object' && TRANSFER in out;
      target().postMessage(
        { id, type: 'done', result: wrapped ? (out as Transferred<R>).result : out, ...(revision != null ? { revision } : {}) },
        wrapped ? (out as Transferred<R>).transfer : [],
      );
    } catch (error) {
      // An error code and its values cross with the message, so the client can explain it in any language.
      const { code, vars } = (error ?? {}) as { code?: unknown; vars?: unknown };
      target().postMessage({
        id, type: 'error', message: error instanceof Error ? error.message : String(error),
        ...(typeof code === 'string' ? { code } : {}),
        ...(vars && typeof vars === 'object' ? { vars } : {}),
      });
    }
  };
}
