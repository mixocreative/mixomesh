'use strict';
// JobRunner (API.7, ADR 0005): `--job job.json --result result.json` batch runner.
//
// Pure factory, no Electron import. Everything with side effects is injected:
//   fs            { stat, readFile, writeFile, rename, unlink }   (fs/promises shape)
//   net           node:net shape (createConnection) — only used by the pipe-client path
//   dispatchLocal (method, params) -> Promise<{ok:true,result}|{ok:false,error}>   ApiServer.dispatchLocal
//   readSession   () -> Promise<{pipe, token, ...}>   reads <userData>/api/session.json
//   validatePath  (raw, kind) -> Promise<{ok,absolutePath,name,reason}>   LaunchArgs.validateLaunchPath, cwd bound
//   clock         { now, setTimeout, clearTimeout }
//   waitReady     () -> Promise<boolean>   first-instance renderer readiness (launch:pull handshake)
//   localAvailable() -> boolean            false when the API server is not running in this process
//   stderr        (line) -> void           human diagnostics; NEVER receives the session token
//
// Two ways to run the same steps:
//   mode 'local'  : this process is the app. Each step goes through ApiServer.dispatchLocal, so
//                   path rewriting, overwrite rules and file writes are identical to the pipe.
//   mode 'remote' : another instance already owns the app. Connect to its pipe as a client
//                   (hello with the session token) and run the steps there; its window stays.
//
// Exit codes: 0 ok · 2 a step failed (or the result file could not be written) · 3 bad job /
// bad arguments · 4 timeout (20 min total, or the app never became ready) · 5 the API of the
// running app is unavailable (disabled, no session file, pipe refused).

const { StringDecoder } = require('node:string_decoder');

const API_VERSION = 1;
const EXIT = Object.freeze({ OK: 0, STEP_FAILED: 2, BAD_JOB: 3, TIMEOUT: 4, UNAVAILABLE: 5 });
const LIMITS = Object.freeze({
  maxSteps: 64,
  maxJobBytes: 1024 * 1024,
  totalMs: 20 * 60 * 1000,
  readyMs: 120 * 1000,
  connectMs: 10 * 1000,
  maxFrameBytes: 8 * 1024 * 1024,
});
// Methods that make no sense in a one-shot job (a subscription needs a live socket).
const JOB_FORBIDDEN_METHODS = Object.freeze(['events.subscribe']);

const isPlainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v)
  && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);

const wireError = (code, message, data) => {
  const e = { code, message: String(message) };
  if (data !== undefined) e.data = data;
  return e;
};

/** Normalise any error shape (ApiServer wire error, JSON-RPC error, thrown) to {code:'E_…', message}. */
function toStepError(err) {
  const code = err && typeof err === 'object' && typeof err.data?.code === 'string' ? err.data.code
    : err && typeof err === 'object' && typeof err.code === 'string' && /^E_/.test(err.code) ? err.code
      : 'E_INTERNAL';
  const message = err && typeof err === 'object' && typeof err.message === 'string' ? err.message : 'internal error';
  const out = { code, message };
  const extra = err && typeof err === 'object' ? err.data : undefined;
  if (isPlainObject(extra)) {
    const { code: _drop, ...rest } = extra;
    if (Object.keys(rest).length) out.data = rest;
  }
  return out;
}

/**
 * Validate a parsed job document. Param-level validation is done per step by the API itself
 * (E_INVALID_PARAMS in that step's result); here only the envelope is checked.
 * @returns {{ok:true, job:{steps:{method:string,params:object}[], stopOnError:boolean}}|{ok:false, error:object}}
 */
function validateJob(doc, { methodNames = [] } = {}) {
  const bad = message => ({ ok: false, error: wireError('E_INVALID_PARAMS', message) });
  if (!isPlainObject(doc)) return bad('job must be a JSON object');
  if (doc.apiVersion !== API_VERSION) return bad(`job.apiVersion must be ${API_VERSION}`);
  if (!Array.isArray(doc.steps) || doc.steps.length === 0) return bad('job.steps must be a non-empty array');
  if (doc.steps.length > LIMITS.maxSteps) return bad(`job.steps has more than ${LIMITS.maxSteps} steps`);
  if (doc.stopOnError !== undefined && typeof doc.stopOnError !== 'boolean') return bad('job.stopOnError must be a boolean');
  const steps = [];
  for (let i = 0; i < doc.steps.length; i++) {
    const s = doc.steps[i];
    if (!isPlainObject(s)) return bad(`steps[${i}] must be an object`);
    if (typeof s.method !== 'string' || s.method === '') return bad(`steps[${i}].method must be a string`);
    if (methodNames.length && !methodNames.includes(s.method)) return bad(`steps[${i}]: unknown method "${s.method.slice(0, 64)}"`);
    if (JOB_FORBIDDEN_METHODS.includes(s.method)) return bad(`steps[${i}]: "${s.method}" is not available in a job`);
    if (s.params !== undefined && !isPlainObject(s.params)) return bad(`steps[${i}].params must be an object`);
    steps.push({ method: s.method, params: s.params ?? {} });
  }
  return { ok: true, job: { steps, stopOnError: doc.stopOnError !== false } };
}

function createJobRunner(deps) {
  const {
    fs, net, dispatchLocal, readSession, validatePath, clock,
  } = deps;
  const waitReady = deps.waitReady ?? (async () => true);
  const localAvailable = deps.localAvailable ?? (() => true);
  const stderr = deps.stderr ?? (() => {});
  const methodNames = deps.methodNames ?? [];
  const limits = { ...LIMITS, ...(deps.limits || {}) };
  const suffix = deps.tmpSuffix ?? (() => Math.random().toString(16).slice(2, 10));
  const now = () => clock.now();
  const setT = (fn, ms) => clock.setTimeout(fn, ms);
  const clearT = t => clock.clearTimeout(t);

  let abortFn = null;
  /** Fail the running job from outside (renderer crash). Safe to call at any time. */
  function abort(message) { if (abortFn) abortFn(String(message || 'aborted')); }

  /** Resolve with `p`'s value, or with `{timedOut:true}` / `{aborted}` first. */
  function raceWith(p, ms, abortPromise) {
    let timer;
    const timeout = new Promise(resolve => { timer = setT(() => resolve({ timedOut: true }), Math.max(0, ms)); });
    return Promise.race([p.then(value => ({ value })), timeout, abortPromise]).finally(() => clearT(timer));
  }

  async function writeResult(resultPath, report) {
    const tmp = `${resultPath}.${suffix()}.tmp`;
    try {
      await fs.writeFile(tmp, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
      await fs.rename(tmp, resultPath);   // overwrite allowed: it is the caller's own result file
      return true;
    } catch {
      try { await fs.unlink(tmp); } catch { /* nothing to clean */ }
      return false;
    }
  }

  async function runSteps(job, call, abortPromise) {
    const deadline = now() + limits.totalMs;
    const steps = [];
    let failed = false;
    let timedOut = false;
    for (const step of job.steps) {
      const left = deadline - now();
      const t0 = now();
      if (left <= 0) { timedOut = true; break; }

      const guarded = Promise.resolve().then(() => call(step.method, step.params))
        .catch(() => ({ ok: false, error: wireError('E_INTERNAL', 'internal error') }));
      const raced = await raceWith(guarded, left, abortPromise);
      if (raced.timedOut) {
        steps.push({ method: step.method, ok: false, error: wireError('E_TIMEOUT', 'the job ran out of time (20 minutes in total)'), ms: now() - t0 });
        timedOut = true;
        break;
      }
      if (raced.aborted) {
        steps.push({ method: step.method, ok: false, error: wireError('E_INTERNAL', raced.aborted), ms: now() - t0 });
        failed = true;
        break;
      }
      const out = raced.value;
      if (out && out.ok === true) {
        steps.push({ method: step.method, ok: true, result: out.result === undefined ? null : out.result, ms: now() - t0 });
      } else {
        failed = true;
        steps.push({ method: step.method, ok: false, error: toStepError(out?.error), ms: now() - t0 });
        if (job.stopOnError) break;
      }
    }
    const code = timedOut ? EXIT.TIMEOUT : failed ? EXIT.STEP_FAILED : EXIT.OK;
    return { code, report: { apiVersion: API_VERSION, ok: code === EXIT.OK, steps } };
  }

  // ---------------------------------------------------------------- pipe client (lock loser)
  /** Connect + hello. Rejects with an Error whose `.unavailable` is a safe, token-free message. */
  function openClient(session) {
    const unavailable = reason => Object.assign(new Error(reason), { unavailable: reason });
    return new Promise((resolve, reject) => {
      let socket;
      try { socket = net.createConnection(session.pipe); } catch { reject(unavailable('could not connect to the running MIXOMESH')); return; }
      const decoder = new StringDecoder('utf8');
      const pending = new Map();
      let buf = '';
      let seq = 0;
      let dead = null;
      let helloDone = false;
      const failAll = reason => {
        if (!dead) dead = reason;
        for (const [id, p] of pending) { pending.delete(id); p.resolve({ ok: false, error: wireError('E_INTERNAL', dead) }); }
      };
      const connectTimer = setT(() => {
        if (helloDone) return;
        try { socket.destroy(); } catch { /* ok */ }
        reject(unavailable('the running MIXOMESH did not answer in time'));
      }, limits.connectMs);
      const send = obj => socket.write(`${JSON.stringify(obj)}\n`);
      const request = (method, params) => new Promise(res => {
        if (dead) { res({ ok: false, error: wireError('E_INTERNAL', dead) }); return; }
        const id = ++seq;
        pending.set(id, { resolve: res });
        try { send({ jsonrpc: '2.0', id, method, params }); } catch { pending.delete(id); res({ ok: false, error: wireError('E_INTERNAL', 'the connection to the running MIXOMESH was lost') }); }
      });
      const onFrame = line => {
        let msg;
        try { msg = JSON.parse(line); } catch { return; }
        if (!isPlainObject(msg) || typeof msg.id !== 'number' || !pending.has(msg.id)) return;
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) p.resolve({ ok: false, error: toStepError(msg.error) });
        else p.resolve({ ok: true, result: msg.result });
      };
      socket.on('data', chunk => {
        buf += typeof chunk === 'string' ? chunk : decoder.write(chunk);
        if (buf.length > limits.maxFrameBytes) { failAll('the running MIXOMESH sent an oversized reply'); try { socket.destroy(); } catch { /* ok */ } return; }
        let nl;
        while ((nl = buf.indexOf('\n')) !== -1) { const line = buf.slice(0, nl); buf = buf.slice(nl + 1); if (line.trim()) onFrame(line); }
      });
      const onGone = () => {
        clearT(connectTimer);
        if (!helloDone) { reject(unavailable('the running MIXOMESH refused the connection')); return; }
        failAll('the connection to the running MIXOMESH was lost');
      };
      socket.on('error', onGone);
      socket.on('close', onGone);
      socket.on('connect', () => {
        request('hello', { token: session.token, apiVersion: API_VERSION }).then(r => {
          clearT(connectTimer);
          if (!r.ok) { try { socket.destroy(); } catch { /* ok */ } reject(unavailable('the running MIXOMESH rejected the session (is the API enabled? restart it)')); return; }
          helloDone = true;
          resolve({
            call: request,
            close: () => { try { socket.end(); } catch { /* ok */ } try { socket.destroy(); } catch { /* ok */ } },
          });
        });
      });
    });
  }

  /**
   * Run a whole job. Never throws. Writes the result file when its path is usable.
   * @param {{job:string, result:string, mode:'local'|'remote'}} args  raw CLI values
   * @returns {Promise<{exitCode:number}>}
   */
  async function run({ job: jobArg, result: resultArg, mode }) {
    const finish = async (code, report, resultPath) => {
      if (resultPath) {
        const wrote = await writeResult(resultPath, report);
        if (!wrote) {
          stderr('--job: the result file could not be written');
          return { exitCode: code === EXIT.OK ? EXIT.STEP_FAILED : code };
        }
      }
      if (code !== EXIT.OK && report.error) stderr(`--job: ${report.error.message}`);
      return { exitCode: code };
    };
    const failReport = (error, steps = []) => ({ apiVersion: API_VERSION, ok: false, error, steps });

    if (typeof resultArg !== 'string' || resultArg === '') {
      stderr('--job requires --result <file.json> (the result is written there)');
      return { exitCode: EXIT.BAD_JOB };
    }
    const resOk = await validatePath(resultArg, 'outputFile');
    if (!resOk.ok || resOk.ext !== 'json') {
      stderr(`--result "${resOk.name}": ${resOk.ok ? 'must be a .json file' : resOk.reason}`);
      return { exitCode: EXIT.BAD_JOB };
    }
    const resultPath = resOk.absolutePath;
    const badJob = message => finish(EXIT.BAD_JOB, failReport(wireError('E_INVALID_PARAMS', message)), resultPath);

    if (typeof jobArg !== 'string' || jobArg === '') return badJob('--job needs a file');
    const jobOk = await validatePath(jobArg, 'jobFile');
    if (!jobOk.ok) return badJob(`--job "${jobOk.name}": ${jobOk.reason}`);
    let text;
    try {
      const st = await fs.stat(jobOk.absolutePath);
      if (st.size > limits.maxJobBytes) return badJob('job file is larger than 1 MiB');
      text = await fs.readFile(jobOk.absolutePath, 'utf8');
    } catch { return badJob('job file could not be read'); }
    if (Buffer.byteLength(text, 'utf8') > limits.maxJobBytes) return badJob('job file is larger than 1 MiB');
    let doc;
    try { doc = JSON.parse(text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text); } catch { return badJob('job file is not valid JSON'); }
    const checked = validateJob(doc, { methodNames });
    if (!checked.ok) return finish(EXIT.BAD_JOB, failReport(checked.error), resultPath);

    const abortPromise = new Promise(resolve => { abortFn = message => resolve({ aborted: message }); });
    try {
      if (mode === 'remote') {
        let session;
        try { session = await readSession(); } catch { session = null; }
        if (!isPlainObject(session) || typeof session.pipe !== 'string' || typeof session.token !== 'string' || !session.pipe || !session.token) {
          return finish(EXIT.UNAVAILABLE, failReport(wireError('E_UNSUPPORTED', 'MIXOMESH is already running but its automation API is not available (disabled in Preferences, or no session file)')), resultPath);
        }
        let client;
        try { client = await openClient(session); } catch (err) {
          return finish(EXIT.UNAVAILABLE, failReport(wireError('E_UNSUPPORTED', err?.unavailable || 'could not connect to the running MIXOMESH')), resultPath);
        }
        try {
          const out = await runSteps(checked.job, client.call, abortPromise);
          return await finish(out.code, out.report, resultPath);
        } finally { client.close(); }
      }
      // local: wait for the renderer, then dispatch in-process
      if (!localAvailable()) {
        return finish(EXIT.UNAVAILABLE, failReport(wireError('E_UNSUPPORTED', 'the automation API is disabled in this MIXOMESH (Preferences), so a job cannot run')), resultPath);
      }
      const ready = await raceWith(Promise.resolve().then(waitReady), limits.readyMs, abortPromise);
      if (ready.aborted) return finish(EXIT.STEP_FAILED, failReport(wireError('E_INTERNAL', ready.aborted)), resultPath);
      if (ready.timedOut || ready.value !== true) {
        return finish(EXIT.TIMEOUT, failReport(wireError('E_TIMEOUT', 'the app did not become ready in time')), resultPath);
      }
      const out = await runSteps(checked.job, dispatchLocal, abortPromise);
      return await finish(out.code, out.report, resultPath);
    } finally {
      abortFn = null;
    }
  }

  return { run, abort };
}

module.exports = { createJobRunner, validateJob, toStepError, EXIT, LIMITS, API_VERSION, JOB_FORBIDDEN_METHODS };
