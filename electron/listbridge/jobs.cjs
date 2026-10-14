// Listbridge publish runner (ADR 0004 "Failure model", plan PB.4).
//
// One publish = one resumable job:
//   validate → bundle → host → create|update → confirm → cleanup
//   * validate: core validateListing (adapter limits) + adapter.validate.
//   * bundle:   planBundle(files, maxFiles); over the limit → one zip (zip is injected).
//   * host:     transfer 'url': put every file + image on the file host, presign GET.
//               Each hosted key is recorded the moment put() returns, so a retry never
//               re-uploads it and cancel / cleanup can always remove it.
//               transfer 'direct' + adapter.buildUploadSlot (PB.3b, Cults3D): the step is an UPLOAD:
//               per file / image, ask the platform for a slot (authenticated, rate-limit aware),
//               then POST the bytes to the slot as multipart/form-data (the slot's fields in order,
//               then the `file` part; NO platform credentials go to that host), and record the
//               returned key the moment the POST succeeds, so a retry never re-uploads a finished
//               item. No file host / tunnel is involved. An UPDATE (remoteId) skips uploads: the
//               platform's update call takes no files.
//               Errors: slot request failed -> code `upload-slot-failed`; storage POST failed ->
//               `upload-failed`. Progress: { step:'host', status:'running', phase:'upload', done, total }.
//   * create:   adapter.buildCreate(pkg, ctx) + authHeaders → transport → parseResult
//               (update: buildUpdate(remoteId, …) when the job has a remoteId).
//   * confirm:  adapter.buildConfirm/parseConfirm polling when the adapter has them.
//   * cleanup:  remove hosted objects. Runs only after confirm (or on cancel); if it fails the
//               objects are kept, the job reports it, and retry() resumes at cleanup.
// Hosts with `waitUntilPublic` (the tunnel) must pass its readiness gate at the end of `host`,
// BEFORE create/update hands any URL to the platform (timeout -> code `tunnel-not-public`).
// Hosts with `requiresUptime: true` (filehosts/tunnel.cjs: links served from this computer)
// are HELD (plan PB.12): the confirm step keeps the job (and the links) alive until
//   * host.stats() says every hosted object (files AND images) was fully served at least
//     once, AND, when the adapter has buildConfirm/parseConfirm, the platform says ingested;
//   * a host without stats() falls back to the adapter query, or (no adapter query either)
//     to a plain time-box: the whole hold window, then done.
// The hold lasts confirm.holdMs (default 15 min; extendHold(jobId, ms) adds up to 60 min per
// call) and reports structured progress { step:'confirm', status:'running', hold:true,
// served, total, holdRemainingMs } every poll. When it expires the job FAILS at confirm with
// the host and its URLs kept, so Retry resumes the wait on the SAME links (no re-put).
// Terminal paths for an uptime host:
//   * done / cancelled -> host.close() immediately;
//   * failed -> kept only for a retry window = the remaining hold time, or (hold already over /
//     failure before the hold) confirm.retryWindowMs (default 15 min); then close()d
//     automatically. After that Retry re-hosts the files and UPDATES the listing with fresh
//     links. App quit closes every host (index.cjs closeAll()).
// A failed step leaves the job resumable: retry(jobId) restarts AT that step, reusing the
// already-hosted keys / URLs (re-presigned only if the link would expire soon).
//
// Pure Node: adapters, credentials, transport, file host factory, zip, the portable core
// (validateListing / planBundle — ESM, loaded by the caller) and the clock are injected.

const crypto = require('node:crypto');

const STEPS = Object.freeze(['validate', 'bundle', 'host', 'publish', 'confirm', 'cleanup']);
const PRESIGN_SEC = 3600;
const PRESIGN_MARGIN_MS = 10 * 60 * 1000;
const HOLD_MS = 15 * 60 * 1000;
const RETRY_WINDOW_MS = 15 * 60 * 1000;
const MAX_EXTEND_MS = 60 * 60 * 1000;

const errMessage = err => String(err?.message || err || 'unknown error');

const FILE_PART_TYPE = 'application/octet-stream';
const quoteHeader = v => String(v).replace(/[\r\n"]/g, '_');

/**
 * multipart/form-data body for an S3-style presigned POST: every field in order, then the
 * `file` part LAST (S3 ignores anything after it). Returns { body: Uint8Array, contentType }.
 */
function buildMultipart(fields, file) {
  const boundary = `----mixomesh${crypto.randomBytes(12).toString('hex')}`;
  const chunks = [];
  for (const f of fields) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${quoteHeader(f.name)}"\r\n\r\n${f.value}\r\n`, 'utf8'));
  }
  chunks.push(Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${quoteHeader(file.name)}"\r\n`
    + `Content-Type: ${file.mime || FILE_PART_TYPE}\r\n\r\n`, 'utf8'));
  chunks.push(Buffer.from(file.bytes.buffer, file.bytes.byteOffset, file.bytes.byteLength));
  chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'));
  return { body: new Uint8Array(Buffer.concat(chunks)), contentType: `multipart/form-data; boundary=${boundary}` };
}

// "<Code>…</Code><Message>…</Message>" from an S3 error body (nothing else: the rest can echo the policy).
function s3Reason(text) {
  const pick = tag => (new RegExp(`<${tag}>([^<]{1,200})</${tag}>`).exec(String(text || '')) || [])[1];
  return [pick('Code'), pick('Message')].filter(Boolean).join(': ');
}

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
 * @param {{ polls?: number, intervalMs?: number, holdMs?: number, retryWindowMs?: number, publicWaitMs?: number }} [deps.confirm]
 *   polls / intervalMs: adapter confirm polling (non-uptime hosts); intervalMs is also the hold
 *   poll interval; holdMs: uptime-host hold; retryWindowMs: failed-job link lifetime.
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
  const holdMs = Math.max(0, confirmOpts.holdMs ?? HOLD_MS);
  const retryWindowMs = Math.max(0, confirmOpts.retryWindowMs ?? RETRY_WINDOW_MS);
  const publicWaitMs = Math.max(0, confirmOpts.publicWaitMs ?? 120_000);
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
    /** @type {any} */ (e).code = 'cancelled';
    return e;
  }
  const checkCancel = job => { if (job.cancelRequested) throw cancelledError(); };

  async function authHeadersFor(job) {
    if (typeof job.adapter.authHeaders !== 'function') return {};
    const record = await credentials.get(`${job.platform}:${job.accountId}`);
    if (!record) throw Object.assign(new Error(`No saved credentials for ${job.platform} account "${job.accountId}".`), { code: 'no-credentials' });
    return job.adapter.authHeaders(record) || {};
  }

  async function fileHostFor(job) {
    if (job.fileHost) return job.fileHost;
    if (typeof makeFileHost !== 'function') throw Object.assign(new Error('Listbridge: no file host is configured.'), { code: 'no-file-host' });
    if (!job.fileHostId) throw Object.assign(new Error('This platform needs a file host: choose one before publishing.'), { code: 'no-file-host' });
    const record = await credentials.get(`filehost:${job.fileHostId}`);
    if (!record) throw Object.assign(new Error(`No saved credentials for file host "${job.fileHostId}".`), { code: 'no-credentials' });
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
      if (job.desc.transfer !== 'url') {
        if (typeof job.adapter.buildUploadSlot === 'function') return uploadItems(job);
        return { skipped: true, message: 'Skipped: the platform takes direct uploads.' };
      }
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
            have.url = await host.presignGet(have.key, PRESIGN_SEC);
            have.expiresAt = now() + PRESIGN_SEC * 1000;
          }
          continue;
        }
        const { key } = await host.put(it.name, it.bytes, it.mime);
        // Record first, so cleanup knows about the object even if presigning throws.
        const rec = { key, url: null, expiresAt: 0 };
        job.hosted.set(it.slot, rec);
        rec.url = await host.presignGet(key, PRESIGN_SEC);
        rec.expiresAt = now() + PRESIGN_SEC * 1000;
        uploaded++;
        report(job, 'host', 'running', `Uploaded ${it.name} (${uploaded}/${items.length}).`);
      }
      // Readiness gate (PB.16): a brand-new tunnel hostname must resolve and serve before ANY
      // URL reaches the platform, or its early lookup poisons DNS with a cached NXDOMAIN.
      if (typeof host.waitUntilPublic === 'function') {
        checkCancel(job);
        const msg = 'Making the temporary links reachable…';
        report(job, 'host', 'running', msg, { phase: 'dns' });
        await host.waitUntilPublic({
          timeoutMs: publicWaitMs,
          cancelled: () => job.cancelRequested,
          onProgress: p => report(job, 'host', 'running', msg, { phase: p.phase }),
        });
        checkCancel(job);
        // The gate may have restarted a dead tunnel: links must carry the current origin.
        for (const rec of job.hosted.values()) {
          rec.url = await host.presignGet(rec.key, PRESIGN_SEC);
          rec.expiresAt = now() + PRESIGN_SEC * 1000;
        }
      }
      return `${items.length} item(s) hosted${uploaded < items.length ? ` (${items.length - uploaded} reused)` : ''}.`;
    },

    async publish(job) {
      const ctx = buildContext(job);
      const spec = job.remoteId
        ? job.adapter.buildUpdate(job.remoteId, job.pkg, ctx)
        : job.adapter.buildCreate(job.pkg, ctx);
      const res = await send(job, spec);
      try {
        job.result = job.adapter.parseResult(res);
      } catch (err) {
        // parseResult failed: the platform rejected/reported an error
        const e = new Error(errMessage(err));
        /** @type {any} */ (e).code = 'platform-rejected';
        throw e;
      }
      if (!job.result || !job.result.remoteId) throw Object.assign(new Error('The platform response did not include a listing id.'), { code: 'platform-rejected' });
      return `${job.remoteId ? 'Updated' : 'Created'} listing ${job.result.remoteId}.`;
    },

    async confirm(job) {
      const hasConfirm = typeof job.adapter.buildConfirm === 'function';
      if (job.fileHost?.requiresUptime && job.hosted.size) return holdUntilConfirmed(job, hasConfirm);
      if (!hasConfirm) {
        return { skipped: true, message: 'Platform accepted the listing.' };
      }
      for (let i = 0; i < confirmPolls; i++) {
        checkCancel(job);
        const res = await send(job, job.adapter.buildConfirm(job.result, buildContext(job)), 'all');
        let c;
        try {
          c = job.adapter.parseConfirm(res, buildContext(job)) || {};
        } catch (err) {
          const e = new Error(errMessage(err));
          /** @type {any} */ (e).code = 'platform-rejected';
          throw e;
        }
        if (c.confirmed) {
          if (c.status) job.result.status = c.status;
          if (c.url) job.result.url = c.url;
          return 'Platform confirmed the files.';
        }
        if (i < confirmPolls - 1) await sleep(confirmIntervalMs);
      }
      throw Object.assign(new Error('The platform has not confirmed the files yet. Retry to check again; hosted files are kept until then.'), { code: 'not-confirmed' });
    },

    async cleanup(job) {
      if (!job.hosted.size) return { skipped: true, message: 'Nothing to clean up.' };
      const left = await removeHosted(job);
      if (left.length) {
        const e = new Error(`${left.length} hosted file(s) could not be removed yet; retry to remove them.`);
        /** @type {any} */ (e).leftover = left;
        /** @type {any} */ (e).code = 'cleanup-left';
        throw e;
      }
      return 'Hosted copies removed.';
    },
  };

  // Native upload (transfer 'direct' + buildUploadSlot): slot request, then multipart POST, per item.
  async function uploadItems(job) {
    if (job.remoteId) return { skipped: true, message: 'Skipped: updating the listing details only (files are not re-sent).' };
    const items = [
      ...job.deliverFiles.map((f, i) => ({ slot: `file:${i}`, kind: 'file', name: f.name, mime: f.mime, bytes: f.bytes })),
      ...job.pkg.images.map((im, i) => ({ slot: `image:${i}`, kind: 'image', name: im.name, mime: im.mime, bytes: im.bytes })),
    ];
    const total = items.length;
    let done = items.filter(it => job.uploaded.has(it.slot)).length;
    report(job, 'host', 'running', `Uploading (${done}/${total})…`, { phase: 'upload', done, total });
    for (const it of items) {
      checkCancel(job);
      if (job.uploaded.has(it.slot)) continue;
      const slot = await requestSlot(job, it);
      const key = await postToSlot(job, slot, it);
      job.uploaded.set(it.slot, { key });
      done++;
      report(job, 'host', 'running', `Uploaded ${it.name} (${done}/${total}).`, { phase: 'upload', done, total });
    }
    return `${total} item(s) uploaded.`;
  }

  async function requestSlot(job, it) {
    try {
      const res = await send(job, job.adapter.buildUploadSlot(it.kind, { name: it.name, mime: it.mime }), 'all');
      return job.adapter.parseUploadSlot(res, { name: it.name, mime: it.mime });
    } catch (err) {
      if (err?.cancelled || job.cancelRequested || err?.code === 'no-credentials') throw err;
      const e = new Error(errMessage(err));
      /** @type {any} */ (e).code = 'upload-slot-failed';
      if (err?.issues) /** @type {any} */ (e).issues = err.issues;
      throw e;
    }
  }

  // POST the bytes to the presigned slot. Never sends platform credentials; returns the object key.
  async function postToSlot(job, slot, it) {
    const { body, contentType } = buildMultipart(slot.fields, it);
    job.abort = new AbortController();
    let res;
    try {
      res = await transport.request({
        url: slot.url, method: 'POST', body, headers: { 'Content-Type': contentType },
        timeoutMs: Math.min(30 * 60 * 1000, Math.max(60_000, Math.ceil(it.bytes.byteLength / 50_000) * 1000)),
        signal: job.abort.signal, retry: 'all',
      });
    } catch (err) {
      if (err?.cancelled || job.cancelRequested) throw err;
      throw Object.assign(new Error(`Uploading "${it.name}" failed: ${errMessage(err)}`), { code: 'upload-failed' });
    } finally {
      job.abort = null;
    }
    if (!res.ok) {
      const why = s3Reason(res.text);
      throw Object.assign(new Error(`Uploading "${it.name}" failed (HTTP ${res.status}${why ? `: ${why}` : ''}).`), { code: 'upload-failed' });
    }
    return slot.key;
  }

  // Uptime hosts: keep the links alive while the platform downloads (see header).
  async function holdUntilConfirmed(job, hasConfirm) {
    const label = job.desc.label || job.platform;
    const host = job.fileHost;
    const hasStats = typeof host.stats === 'function';
    job.holdDeadline = now() + holdMs;
    let st = null;
    for (;;) {
      checkCancel(job);
      await keepLinksAlive(job, host);
      st = hasStats ? readStats(host) : null;
      const allServed = !st || st.served >= st.total;
      if (st && allServed && !hasConfirm) {
        job.holdDeadline = null;
        return `${label} downloaded all ${st.total} file(s).`;
      }
      if (allServed && hasConfirm) {
        let c;
        try {
          c = job.adapter.parseConfirm(await send(job, job.adapter.buildConfirm(job.result, buildContext(job)), 'all'), buildContext(job)) || {};
        } catch (err) {
          const e = new Error(errMessage(err));
          /** @type {any} */ (e).code = 'platform-rejected';
          throw e;
        }
        if (c.confirmed) {
          if (c.status) job.result.status = c.status;
          if (c.url) job.result.url = c.url;
          job.holdDeadline = null;
          return 'Platform confirmed the files.';
        }
      }
      const left = Math.max(0, job.holdDeadline - now());
      const count = st ? ` (${st.served}/${st.total})` : '';
      report(job, 'confirm', 'running', `Keep MIXOMESH open while ${label} downloads the files${count}.`, {
        hold: true, holdRemainingMs: left, ...(st ? { served: st.served, total: st.total } : {}),
      });
      if (left <= 0) break;
      await sleep(Math.min(confirmIntervalMs, left));
    }
    job.holdDeadline = null;
    const mins = Math.max(1, Math.round(holdMs / 60000));
    if (!st && !hasConfirm) return `Kept the temporary links open for ${mins} min while ${label} downloaded the files.`;
    const progress = st ? ` (${st.served}/${st.total} downloaded)` : '';
    throw Object.assign(new Error(`${label} has not finished downloading the files${progress} after ${mins} min. The temporary links stay open for now: Retry to keep waiting.`), { code: 'not-confirmed' });
  }

  function readStats(host) {
    const st = host.stats() || {};
    const total = Number(st.total) || 0;
    return { served: Math.min(Number(st.served) || 0, total), total };
  }

  // A held link must not hit its presign expiry. Tunnel URLs are token-based, so re-presigning
  // only moves the expiry; the URL the platform already has stays the same.
  async function keepLinksAlive(job, host) {
    for (const rec of job.hosted.values()) {
      if (rec.expiresAt - now() >= PRESIGN_MARGIN_MS) continue;
      rec.url = await host.presignGet(rec.key, PRESIGN_SEC);
      rec.expiresAt = now() + PRESIGN_SEC * 1000;
    }
  }

  // Failed job on an uptime host: keep the links for a Retry, but not forever.
  function scheduleClose(job, ms) {
    clearTimeout(job.closeTimer);
    job.closeAt = now() + ms;
    job.closeTimer = setTimeout(() => { closeHost(job).catch(() => {}); }, ms);
    job.closeTimer.unref?.();
  }

  // Close an uptime host (tunnel). Its objects lived only in that host, so they are gone:
  // forget them and remember that a retry has to host the files again.
  async function closeHost(job) {
    clearTimeout(job.closeTimer);
    job.closeTimer = null;
    job.closeAt = null;
    const host = job.fileHost;
    if (!host || typeof host.close !== 'function') return;
    job.fileHost = null;
    if (job.hosted.size) { job.hosted.clear(); job.linksLost = true; }
    try { await host.close(); } catch { /* best effort: the process is going away anyway */ }
  }

  function buildContext(job) {
    const hosted = slot => job.hosted.get(slot)?.url;
    const keyed = slot => job.uploaded.get(slot)?.key;
    const extra = slot => ({
      ...(hosted(slot) ? { url: hosted(slot) } : {}),
      ...(keyed(slot) ? { key: keyed(slot) } : {}),
    });
    return {
      ...(job.remoteId ? { update: true } : {}),
      files: job.deliverFiles.map((f, i) => ({ ...f, ...extra(`file:${i}`) })),
      images: job.pkg.images.map((im, i) => ({
        name: im.name, mime: im.mime, role: im.role, bytes: im.bytes, ...extra(`image:${i}`),
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
        const e = new Error(`The platform answered HTTP ${res.status}${res.status === 401 || res.status === 403 ? ' (check the account credentials)' : ''}.`);
        /** @type {any} */ (e).code = 'platform-http';
        throw e;
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
      ...base, ok: false, failedStep: job.failedStep, error: job.error, code: job.code ?? null,
      ...(job.issues ? { issues: job.issues } : {}),
      ...(job.result ? { result: { ...job.result } } : {}),
      ...(job.leftover ? { leftover: [...job.leftover] } : {}),
    };
  }

  async function runFrom(job) {
    job.status = 'running';
    clearTimeout(job.closeTimer);
    job.closeTimer = null;
    job.closeAt = null;
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
          // create / update: carry the remote id so the renderer can persist it immediately,
          // before confirm / cleanup, and a crash or quit after this point cannot duplicate (PB.14).
          const created = name === 'publish' && job.result?.remoteId
            ? { remoteId: job.result.remoteId, ...(job.result.url ? { url: job.result.url } : {}) } : {};
          report(job, step, 'done', msg, { ...(r?.skipped ? { skipped: true } : {}), ...created });
        } catch (err) {
          if (err?.cancelled || job.cancelRequested) throw cancelledError();
          job.failedStep = step;
          job.error = errMessage(err);
          job.code = err?.code ?? null;
          job.issues = err?.issues ?? null;
          job.leftover = err?.leftover ?? null;
          job.status = 'failed';
          let linksOpenMs = null;
          if (job.fileHost?.requiresUptime) {
            // Retry window: what is left of the hold, else a fresh window.
            const holdLeft = job.holdDeadline ? job.holdDeadline - now() : 0;
            linksOpenMs = holdLeft > 0 ? holdLeft : retryWindowMs;
            scheduleClose(job, linksOpenMs);
          }
          job.holdDeadline = null;
          report(job, step, 'failed', job.error, {
            ...(job.issues ? { issues: job.issues } : {}),
            ...(linksOpenMs != null ? { linksOpenMs } : {}),
          });
          return outcome(job);
        }
        job.stepIndex++;
      }
      await closeHost(job);
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
    if (job.fileHost?.requiresUptime) {
      await closeHost(job);   // objects die with the host
      left = [];
    }
    job.status = 'cancelled';
    job.code = 'cancelled';
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
      stepIndex: 0, status: 'pending', hosted: new Map(), uploaded: new Map(), deliverFiles: null, result: null,
      fileHost: null, cancelRequested: false, abort: null, running: null, closeTimer: null, closeAt: null,
      holdDeadline: null, linksLost: false, error: null, code: null, issues: null, failedStep: null, leftover: null,
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
      if (job.linksLost && job.stepIndex > STEPS.indexOf('host')) {
        // The temporary links were closed: host again, then update the listing created earlier.
        job.stepIndex = STEPS.indexOf('host');
        if (job.result?.remoteId) job.remoteId = job.result.remoteId;
      }
      job.linksLost = false;
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
    /**
     * "Keep waiting" (decision D2): add up to 60 min to a running hold, or to a failed job's
     * retry window (its links stay open longer). Resolves { ok, holdRemainingMs?, linksOpenMs?, message? }.
     */
    async extendHold(jobId, ms) {
      const job = jobs.get(jobId);
      if (!job) throw new Error(`Listbridge: unknown job "${jobId}"`);
      const n = Number(ms);
      if (!Number.isFinite(n) || n <= 0) throw new Error('Listbridge: extendHold needs a positive number of milliseconds.');
      const add = Math.min(n, MAX_EXTEND_MS);
      if (job.status === 'running' && job.holdDeadline) {
        job.holdDeadline += add;
        return { ok: true, holdRemainingMs: Math.max(0, job.holdDeadline - now()) };
      }
      if (job.status === 'failed' && job.closeTimer && job.fileHost) {
        const left = Math.max(0, (job.closeAt ?? now()) - now()) + add;
        scheduleClose(job, left);
        try { await keepLinksAlive(job, job.fileHost); } catch { /* links keep their old expiry */ }
        return { ok: true, linksOpenMs: left };
      }
      return { ok: false, message: 'This publish is not waiting for the platform.' };
    },
    get(jobId) {
      const job = jobs.get(jobId);
      return job ? outcome(job) : null;
    },
    has: jobId => jobs.has(jobId),
    /** Jobs that are executing right now (a failed job waiting for Retry is not running). */
    runningJobs: () => [...jobs.values()].filter(j => j.status === 'running')
      .map(j => ({ jobId: j.id, platform: j.platform, label: j.desc.label || j.platform })),
    hasRunningJobs: () => [...jobs.values()].some(j => j.status === 'running'),
  });
}

module.exports = { createPublishRunner, STEPS, MAX_EXTEND_MS };
