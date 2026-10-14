// Listbridge publish runner (ADR 0004 "Failure model", plan PB.4).
//
// One publish = one resumable job:
//   validate → bundle → host → create|update → confirm → cleanup
//   * validate: core validateListing (adapter limits) + adapter.validate.
//   * bundle:   planBundle(files, maxFiles); over the limit → one zip (zip is injected).
//   * host:     only for transfer 'url': put every file + image on the file host, presign GET.
//               Each hosted key is recorded the moment put() returns, so a retry never
//               re-uploads it and cancel / cleanup can always remove it.
//   * create:   adapter.buildCreate(pkg, ctx) + authHeaders → transport → parseResult
//               (update: buildUpdate(remoteId, …) when the job has a remoteId).
//   * confirm:  adapter.buildConfirm/parseConfirm polling when the adapter has them.
//   * cleanup:  remove hosted objects. Runs only after confirm (or on cancel); if it fails the
//               objects are kept, the job reports it, and retry() resumes at cleanup.
// A failed step leaves the job resumable: retry(jobId) restarts AT that step, reusing the
// already-hosted keys / URLs (re-presigned only if the link would expire soon).
//
// Pure Node: adapters, credentials, transport, file host factory, zip, the portable core
// (validateListing / planBundle — ESM, loaded by the caller) and the clock are injected.

const crypto = require('node:crypto');

const STEPS = Object.freeze(['validate', 'bundle', 'host', 'publish', 'confirm', 'cleanup']);
const PRESIGN_SEC = 3600;
const PRESIGN_MARGIN_MS = 10 * 60 * 1000;

const errMessage = err => String(err?.message || err || 'unknown error');

/**
 * @param {object} deps
 * @param {Array<any>} deps.adapters                     Listbridge adapters (core/adapter.js contract)
 * @param {{ get(id: string): Promise<any> }} deps.credentials
 * @param {{ request(req: any): Promise<any> }} deps.transport
 * @param {(record: any) => { put: Function, presignGet: Function, remove: Function }} [deps.makeFileHost]
 * @param {(files: Array<{name:string,bytes:Uint8Array}>) => Promise<Uint8Array>} [deps.zip]
 * @param {{ validateListing: Function, planBundle: Function }} deps.core
 * @param {(event: any) => void} [deps.emit]               default progress sink
 * @param {(ms: number) => Promise<void>} [deps.sleep]
 * @param {() => number} [deps.now]
 * @param {{ polls?: number, intervalMs?: number }} [deps.confirm]
 */
function createPublishRunner({
  adapters = [], credentials, transport, makeFileHost, zip, core, emit = () => {},
  sleep = ms => new Promise(r => setTimeout(r, ms)), now = Date.now,
  confirm: confirmOpts = {}, newId = () => `job_${crypto.randomBytes(8).toString('hex')}`,
} = {}) {
  if (!core || typeof core.validateListing !== 'function' || typeof core.planBundle !== 'function') {
    throw new Error('Listbridge runner: core { validateListing, planBundle } is required');
  }
  if (!transport || typeof transport.request !== 'function') throw new Error('Listbridge runner: transport is required');
  if (!credentials || typeof credentials.get !== 'function') throw new Error('Listbridge runner: credentials store is required');
  const byId = new Map();
  for (const a of adapters) {
    const d = a.describe();
    if (byId.has(d.id)) throw new Error(`Listbridge runner: duplicate adapter "${d.id}"`);
    byId.set(d.id, a);
  }
  const confirmPolls = Math.max(1, confirmOpts.polls ?? 10);
  const confirmIntervalMs = confirmOpts.intervalMs ?? 5000;
  const jobs = new Map();

  const adapterFor = platform => {
    const a = byId.get(platform);
    if (!a) throw new Error(`Listbridge: no adapter for platform "${platform}"`);
    return a;
  };

  function report(job, step, status, message, extra = {}) {
    const event = { jobId: job.id, step, status, message, ...extra };
    try { (job.onProgress || emit)(event); } catch { /* a broken listener must not break the job */ }
  }

  function cancelledError() {
    const e = new Error('Publish cancelled');
    /** @type {any} */ (e).cancelled = true;
    return e;
  }
  const checkCancel = job => { if (job.cancelRequested) throw cancelledError(); };

  async function authHeadersFor(job) {
    if (typeof job.adapter.authHeaders !== 'function') return {};
    const record = await credentials.get(`${job.platform}:${job.accountId}`);
    if (!record) throw new Error(`No saved credentials for ${job.platform} account "${job.accountId}".`);
    return job.adapter.authHeaders(record) || {};
  }

  async function fileHostFor(job) {
    if (job.fileHost) return job.fileHost;
    if (typeof makeFileHost !== 'function') throw new Error('Listbridge: no file host is configured.');
    if (!job.fileHostId) throw new Error('This platform needs a file host: choose one before publishing.');
    const record = await credentials.get(`filehost:${job.fileHostId}`);
    if (!record) throw new Error(`No saved credentials for file host "${job.fileHostId}".`);
    job.fileHost = makeFileHost(record);
    return job.fileHost;
  }

  // ── Steps ────────────────────────────────────────────────────────────────

  const steps = {
    async validate(job) {
      const d = job.desc;
      const issues = [
        ...core.validateListing(job.pkg, { maxImages: d.maxImages, currencies: d.currencies }),
        ...(job.adapter.validate(job.pkg) || []),
      ];
      if (issues.length) {
        const e = new Error(`Listing is not ready: ${issues.map(i => i.message).join(' ')}`);
        /** @type {any} */ (e).issues = issues;
        throw e;
      }
      return 'Listing is valid.';
    },

    async bundle(job) {
      const files = job.pkg.files;
      const plan = core.planBundle(files, job.desc.maxFiles, { zipName: job.zipName });
      if (!plan.bundles.length) {
        job.deliverFiles = plan.loose.map(f => ({ name: f.name, mime: f.mime, bytes: f.bytes }));
        return `${files.length} file(s), no zip needed.`;
      }
      if (typeof zip !== 'function') throw new Error('Listbridge: a zip is needed but no zip function is configured.');
      const out = [...plan.loose.map(f => ({ name: f.name, mime: f.mime, bytes: f.bytes }))];
      for (const b of plan.bundles) {
        out.push({ name: b.name, mime: 'application/zip', bytes: await zip(b.files) });
      }
      job.deliverFiles = out;
      return `${files.length} files zipped into ${plan.bundles.map(b => b.name).join(', ')}.`;
    },

    async host(job) {
      if (job.desc.transfer !== 'url') return { skipped: true, message: 'Skipped: the platform takes direct uploads.' };
      const host = await fileHostFor(job);
      const items = [
        ...job.deliverFiles.map((f, i) => ({ slot: `file:${i}`, name: f.name, mime: f.mime, bytes: f.bytes })),
        ...job.pkg.images.map((im, i) => ({ slot: `image:${i}`, name: im.name, mime: im.mime, bytes: im.bytes })),
      ];
      let uploaded = 0;
      for (const it of items) {
        checkCancel(job);
        const have = job.hosted.get(it.slot);
        if (have) {
          if (have.expiresAt - now() < PRESIGN_MARGIN_MS) {
            have.url = host.presignGet(have.key, PRESIGN_SEC);
            have.expiresAt = now() + PRESIGN_SEC * 1000;
          }
          continue;
        }
        const { key } = await host.put(it.name, it.bytes, it.mime);
        // Record first, so cleanup knows about the object even if presigning throws.
        const rec = { key, url: null, expiresAt: 0 };
        job.hosted.set(it.slot, rec);
        rec.url = host.presignGet(key, PRESIGN_SEC);
        rec.expiresAt = now() + PRESIGN_SEC * 1000;
        uploaded++;
        report(job, 'host', 'running', `Uploaded ${it.name} (${uploaded}/${items.length}).`);
      }
      return `${items.length} item(s) hosted${uploaded < items.length ? ` (${items.length - uploaded} reused)` : ''}.`;
    },

    async publish(job) {
      const ctx = buildContext(job);
      const spec = job.remoteId
        ? job.adapter.buildUpdate(job.remoteId, job.pkg, ctx)
        : job.adapter.buildCreate(job.pkg, ctx);
      const res = await send(job, spec);
      job.result = job.adapter.parseResult(res);
      if (!job.result || !job.result.remoteId) throw new Error('The platform response did not include a listing id.');
      return `${job.remoteId ? 'Updated' : 'Created'} listing ${job.result.remoteId}.`;
    },

    async confirm(job) {
      if (typeof job.adapter.buildConfirm !== 'function') {
        return { skipped: true, message: 'Platform accepted the listing.' };
      }
      for (let i = 0; i < confirmPolls; i++) {
        checkCancel(job);
        const res = await send(job, job.adapter.buildConfirm(job.result), 'all');
        const c = job.adapter.parseConfirm(res) || {};
        if (c.confirmed) {
          if (c.status) job.result.status = c.status;
          if (c.url) job.result.url = c.url;
          return 'Platform confirmed the files.';
        }
        if (i < confirmPolls - 1) await sleep(confirmIntervalMs);
      }
      throw new Error('The platform has not confirmed the files yet. Retry to check again; hosted files are kept until then.');
    },

    async cleanup(job) {
      if (!job.hosted.size) return { skipped: true, message: 'Nothing to clean up.' };
      const left = await removeHosted(job);
      if (left.length) {
        const e = new Error(`${left.length} hosted file(s) could not be removed yet; retry to remove them.`);
        /** @type {any} */ (e).leftover = left;
        throw e;
      }
      return 'Hosted copies removed.';
    },
  };

  function buildContext(job) {
    const hosted = slot => job.hosted.get(slot)?.url;
    return {
      files: job.deliverFiles.map((f, i) => ({ ...f, ...(hosted(`file:${i}`) ? { url: hosted(`file:${i}`) } : {}) })),
      images: job.pkg.images.map((im, i) => ({
        name: im.name, mime: im.mime, role: im.role, bytes: im.bytes,
        ...(hosted(`image:${i}`) ? { url: hosted(`image:${i}`) } : {}),
      })),
    };
  }

  async function send(job, spec, retry = 'rate-limit') {
    const auth = await authHeadersFor(job);
    job.abort = new AbortController();
    try {
      const res = await transport.request({
        url: spec.url, method: spec.method, body: spec.body,
        headers: { ...(spec.headers || {}), ...auth },
        signal: job.abort.signal, retry,
      });
      if (res.status >= 400 && res.status !== 422) {
        // 422 / GraphQL errors are the adapter's to explain; other HTTP failures are generic.
        throw new Error(`The platform answered HTTP ${res.status}${res.status === 401 || res.status === 403 ? ' (check the account credentials)' : ''}.`);
      }
      return res;
    } finally {
      job.abort = null;
    }
  }

  // Remove every hosted object; returns the keys that could not be removed (kept in job.hosted).
  async function removeHosted(job) {
    if (!job.hosted.size) return [];
    const host = await fileHostFor(job);
    const left = [];
    for (const [slot, rec] of [...job.hosted]) {
      try {
        await host.remove(rec.key);
        job.hosted.delete(slot);
      } catch {
        left.push(rec.key);
      }
    }
    return left;
  }

  // ── Job lifecycle ───────────────────────────────────────────────────────

  function outcome(job) {
    const base = { jobId: job.id, status: job.status };
    if (job.status === 'done') return { ...base, ok: true, result: { ...job.result } };
    return {
      ...base, ok: false, failedStep: job.failedStep, error: job.error,
      ...(job.issues ? { issues: job.issues } : {}),
      ...(job.result ? { result: { ...job.result } } : {}),
      ...(job.leftover ? { leftover: [...job.leftover] } : {}),
    };
  }

  async function runFrom(job) {
    job.status = 'running';
    job.error = null; job.issues = null; job.failedStep = null; job.leftover = null;
    try {
      while (job.stepIndex < STEPS.length) {
        checkCancel(job);
        const name = STEPS[job.stepIndex];
        const step = name === 'publish' ? (job.remoteId ? 'update' : 'create') : name;
        report(job, step, 'running', `${step}…`);
        try {
          const r = await steps[name](job);
          const msg = typeof r === 'string' ? r : r?.message;
          report(job, step, 'done', msg, r?.skipped ? { skipped: true } : {});
        } catch (err) {
          if (err?.cancelled || job.cancelRequested) throw cancelledError();
          job.failedStep = step;
          job.error = errMessage(err);
          job.issues = err?.issues ?? null;
          job.leftover = err?.leftover ?? null;
          job.status = 'failed';
          report(job, step, 'failed', job.error, job.issues ? { issues: job.issues } : {});
          return outcome(job);
        }
        job.stepIndex++;
      }
      job.status = 'done';
      job.pkg = null; job.deliverFiles = null;   // release bytes once published
      return outcome(job);
    } catch (err) {
      if (!err?.cancelled) throw err;
      return finishCancel(job);
    }
  }

  async function finishCancel(job) {
    report(job, 'cleanup', 'running', 'Cancelled — removing hosted copies…');
    let left = [];
    try { left = await removeHosted(job); } catch { left = [...job.hosted.values()].map(r => r.key); }
    job.status = 'cancelled';
    job.leftover = left.length ? left : null;
    job.error = 'Publish cancelled';
    job.pkg = null; job.deliverFiles = null;
    report(job, 'cleanup', left.length ? 'failed' : 'done',
      left.length ? `${left.length} hosted file(s) could not be removed.` : 'Cancelled; hosted copies removed.');
    return outcome(job);
  }

  /**
   * Register a job without running it. Returns the jobId.
   * @param {{ platform: string, accountId: string, fileHostId?: string, remoteId?: string,
   *   pkg: any, onProgress?: (e: any) => void, zipName?: string }} opts
   */
  function create({ platform, accountId, fileHostId, remoteId, pkg, onProgress, zipName } = {}) {
    const adapter = adapterFor(platform);
    if (typeof accountId !== 'string' || !accountId) throw new Error('Listbridge: accountId is required.');
    if (!pkg || typeof pkg !== 'object') throw new Error('Listbridge: a listing package is required.');
    const id = newId();
    jobs.set(id, {
      id, platform, accountId, fileHostId: fileHostId || null, remoteId: remoteId || null,
      adapter, desc: adapter.describe(), pkg, onProgress, zipName: zipName || 'files.zip',
      stepIndex: 0, status: 'pending', hosted: new Map(), deliverFiles: null, result: null,
      fileHost: null, cancelRequested: false, abort: null, running: null,
    });
    return id;
  }

  function run(jobId) {
    const job = jobs.get(jobId);
    if (!job) return Promise.reject(new Error(`Listbridge: unknown job "${jobId}"`));
    if (job.running) return job.running;
    if (job.status === 'done' || job.status === 'cancelled') return Promise.resolve(outcome(job));
    job.running = runFrom(job).finally(() => { job.running = null; });
    return job.running;
  }

  return Object.freeze({
    STEPS,
    create,
    run,
    /** create + run; resolves with the outcome. */
    start: opts => run(create(opts)),
    /** Resume a failed job at its failed step (hosted objects are reused). */
    retry(jobId, { onProgress } = {}) {
      const job = jobs.get(jobId);
      if (!job) return Promise.reject(new Error(`Listbridge: unknown job "${jobId}"`));
      if (job.status !== 'failed') return Promise.reject(new Error(`Listbridge: job is ${job.status}, nothing to retry.`));
      if (onProgress) job.onProgress = onProgress;
      return run(jobId);
    },
    /** Stop a job and remove its hosted objects. A finished job cannot be cancelled. */
    async cancel(jobId) {
      const job = jobs.get(jobId);
      if (!job) throw new Error(`Listbridge: unknown job "${jobId}"`);
      if (job.status === 'done' || job.status === 'cancelled') return outcome(job);
      job.cancelRequested = true;
      if (job.running) {
        job.abort?.abort();
        return job.running;
      }
      return finishCancel(job);
    },
    get(jobId) {
      const job = jobs.get(jobId);
      return job ? outcome(job) : null;
    },
    has: jobId => jobs.has(jobId),
  });
}

module.exports = { createPublishRunner, STEPS };
