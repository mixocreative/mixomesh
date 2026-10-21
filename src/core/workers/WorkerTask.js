// WorkerTask — the ONE client-side job runner for MIXOMESH's Web Workers.
// Owns the message protocol (see serveTask.js for the worker side):
//   request  { id, type: 'run', payload, revision? }
//   replies  { id, type: 'progress', ...fields }
//            { id, type: 'done', result, revision? }
//            { id, type: 'error', message }
// Each client passes its own `create` factory (Vite needs the literal
// `new Worker(new URL('./X.worker.js', import.meta.url), { type: 'module' })`
// at the call site to bundle the worker) or null when Worker is unavailable.
//
// Failure isolation: a timeout or crash on a persistent worker terminates it;
// the failing job rejects with its own reason, the other in-flight jobs reject
// with code 'restarted' (crash: everyone gets the crash message), and the next
// run() starts a fresh worker. Named WorkerTask, not JobRunner — that is the
// Electron CLI batch runner (electron/JobRunner.cjs).

const DEFAULT_TIMEOUT_MS = 120_000;

function coded(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function abortError(name) {
  return new DOMException(`${name} aborted`, 'AbortError');
}

export class WorkerTask {
  /**
   * @param {object} opts
   * @param {(() => Worker) | null} opts.create  worker factory; null = no Worker
   * @param {'persistent'|'per-job'} [opts.mode]
   * @param {'parallel'|'serial'} [opts.concurrency]
   * @param {number} [opts.timeoutMs]
   * @param {(payload: any) => any} [opts.fallback]  main-thread implementation
   * @param {string} [opts.name]  used in error messages
   */
  constructor({ create, mode = 'persistent', concurrency = 'parallel', timeoutMs = DEFAULT_TIMEOUT_MS, fallback, name = 'worker task' }) {
    this._create = create;
    this._mode = mode;
    this._serial = concurrency === 'serial';
    this._timeoutMs = timeoutMs;
    this._fallback = fallback;
    this._name = name;
    this._worker = null;
    this._jobs = new Map();   // id → job (persistent mode)
    this._seq = 0;
    this._chain = Promise.resolve();
  }

  /**
   * Run one job. Resolves with the worker's `result`.
   * @param {any} payload
   * @param {{ transfer?: Transferable[], signal?: AbortSignal, timeoutMs?: number,
   *           onProgress?: (e: object) => void, revision?: number }} [opts]
   */
  run(payload, opts = {}) {
    if (opts.signal?.aborted) return Promise.reject(abortError(this._name));
    if (!this._serial) return this._start(payload, opts);
    const next = this._chain.then(() => this._start(payload, opts));
    this._chain = next.catch(() => {});
    return next;
  }

  /** Terminate the persistent worker (pending jobs reject 'restarted'). */
  terminate() {
    this._restart(null, coded(`${this._name} terminated`, 'restarted'));
  }

  _start(payload, opts) {
    if (opts.signal?.aborted) return Promise.reject(abortError(this._name));
    let worker;
    try {
      if (!this._create) throw coded(`${this._name} requires a Web Worker`, 'unavailable');
      worker = this._mode === 'per-job' ? this._create() : (this._worker ??= this._wire(this._create()));
    } catch (error) {
      if (this._fallback) return Promise.resolve().then(() => this._fallback(payload));
      return Promise.reject(error.code ? error : coded(`${this._name} requires a Web Worker (${error.message})`, 'unavailable'));
    }
    return new Promise((resolve, reject) => {
      const id = ++this._seq;
      const job = { id, worker, resolve, reject, opts, timer: null, abort: null };
      job.timer = setTimeout(
        () => this._timeout(job),
        opts.timeoutMs ?? this._timeoutMs,
      );
      if (opts.signal) {
        job.abort = () => this._settle(job, abortError(this._name));
        opts.signal.addEventListener('abort', job.abort, { once: true });
      }
      if (this._mode === 'per-job') {
        worker.onmessage = e => this._onMessage(e.data, job);
        worker.onerror = e => this._settle(job, new Error(e?.message || `${this._name} crashed`));
      } else {
        this._jobs.set(id, job);
      }
      try {
        worker.postMessage({ id, type: 'run', payload, ...(opts.revision != null ? { revision: opts.revision } : {}) }, opts.transfer ?? []);
      } catch (error) {
        this._settle(job, error);
      }
    });
  }

  _wire(worker) {
    worker.onmessage = e => {
      const msg = e.data;
      if (!msg || typeof msg !== 'object') return;
      const job = this._jobs.get(msg.id);
      if (job) this._onMessage(msg, job);
    };
    worker.onerror = e => this._restart(null, new Error(e?.message || `${this._name} crashed`));
    return worker;
  }

  _onMessage(msg, job) {
    if (!msg || typeof msg !== 'object' || msg.id !== job.id) return;
    if (msg.type === 'progress') {
      const { id: _id, type: _type, ...fields } = msg;
      try { job.opts.onProgress?.(fields); } catch (error) { this._settle(job, error); }
      return;
    }
    if (msg.type === 'done') {
      if (job.opts.revision != null && msg.revision !== job.opts.revision) {
        this._settle(job, coded(`stale ${this._name} result`, 'stale'));
      } else {
        this._settle(job, null, msg.result);
      }
      return;
    }
    if (msg.type === 'error') this._settle(job, new Error(msg.message || `${this._name} failed`));
  }

  _timeout(job) {
    const ms = job.opts.timeoutMs ?? this._timeoutMs;
    const error = coded(`${this._name} timed out after ${ms} ms`, 'timeout');
    if (this._mode === 'per-job') this._settle(job, error);
    else this._restart(job, error);
  }

  /** Persistent worker failed: kill it, reject `job` with `error` and the rest with 'restarted'
   *  (or every job with `error` when job is null — a crash affects all of them). */
  _restart(job, error) {
    const worker = this._worker;
    this._worker = null;
    if (worker) { worker.onmessage = null; worker.onerror = null; worker.terminate(); }
    for (const other of [...this._jobs.values()]) {
      const reason = !job || other === job ? error : coded(`${this._name} restarted: ${error.message}`, 'restarted');
      this._settle(other, reason);
    }
  }

  _settle(job, error, result) {
    if (job.done) return;
    job.done = true;
    clearTimeout(job.timer);
    job.opts.signal?.removeEventListener('abort', job.abort);
    this._jobs.delete(job.id);
    if (this._mode === 'per-job') {
      job.worker.onmessage = null; job.worker.onerror = null;
      job.worker.terminate();
    }
    if (error) job.reject(error); else job.resolve(result);
  }
}
