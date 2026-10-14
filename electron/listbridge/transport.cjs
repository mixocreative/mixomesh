// Listbridge HTTP transport (ADR 0004, plan PB.4): fetch with a per-attempt timeout and
// rate-limit-aware retries. Pure Node — fetch, sleep and clock are injected.
//
// Retry policy:
//   * 'all' (default): retry on HTTP 429, any 5xx, and network errors / timeouts.
//   * 'rate-limit': retry ONLY on 429. Used for non-idempotent calls (create / update a
//     listing): a 5xx or a timeout may mean the platform already created it, so a blind
//     resend could duplicate a paid listing — the job fails instead and the user retries.
// Backoff: 1 s → 5 s → 10 s → 30 s (at most 4 retries). A `Retry-After` header (seconds or
// HTTP date) or `x-ratelimit-reset` replaces the scheduled delay (capped at 5 min). After any
// response that reports `x-ratelimit-remaining: 0`, the next request waits for the reset.
//
// Nothing here logs, and errors never include request headers (they carry Authorization).

const BACKOFF_MS = Object.freeze([1000, 5000, 10000, 30000]);
const MAX_WAIT_MS = 5 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 30000;

function headersToObject(h) {
  const out = {};
  if (!h) return out;
  if (typeof h.forEach === 'function') h.forEach((v, k) => { out[String(k).toLowerCase()] = String(v); });
  else for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = String(v);
  return out;
}

// ms to wait as the server asked, or null. `nowMs` = current epoch ms.
function serverDelayMs(headers, nowMs) {
  const ra = headers['retry-after'];
  if (ra != null && ra !== '') {
    const secs = Number(ra);
    if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
    const at = Date.parse(ra);
    if (Number.isFinite(at)) return Math.max(0, at - nowMs);
  }
  const reset = Number(headers['x-ratelimit-reset']);
  if (headers['x-ratelimit-reset'] != null && Number.isFinite(reset)) {
    // Epoch seconds (large) or seconds-until-reset (small) — both are in the wild.
    return Math.max(0, reset > 1e9 ? reset * 1000 - nowMs : reset * 1000);
  }
  return null;
}

/**
 * @param {object} [deps]
 * @param {typeof fetch} [deps.fetchImpl]
 * @param {(ms: number) => Promise<void>} [deps.sleep]
 * @param {() => number} [deps.now] epoch ms
 */
function createTransport({
  fetchImpl = globalThis.fetch,
  sleep = ms => new Promise(r => setTimeout(r, ms)),
  now = Date.now,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('Listbridge transport: fetch is not available');
  let blockedUntil = 0;

  async function attempt({ url, method, headers, body, timeoutMs, signal }) {
    const ctrl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, timeoutMs);
    const onAbort = () => ctrl.abort();
    if (signal) {
      if (signal.aborted) ctrl.abort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    try {
      const res = await fetchImpl(url, { method, headers, body, signal: ctrl.signal });
      const text = await res.text();
      return { res, text };
    } catch (err) {
      if (signal?.aborted) {
        const e = new Error('Listbridge transport: request cancelled');
        /** @type {any} */ (e).cancelled = true;
        throw e;
      }
      const e = new Error(timedOut
        ? `Listbridge transport: ${method} ${safeUrl(url)} timed out after ${timeoutMs} ms`
        : `Listbridge transport: ${method} ${safeUrl(url)} network error (${err?.message || err})`);
      /** @type {any} */ (e).network = true;
      throw e;
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }

  /**
   * @param {object} req
   * @param {string} req.url
   * @param {string} [req.method='GET']
   * @param {Record<string,string>} [req.headers]
   * @param {any} [req.body] string / Uint8Array / ArrayBuffer / FormData sent as-is; a plain object is JSON-encoded.
   * @param {number} [req.timeoutMs=30000]
   * @param {AbortSignal} [req.signal]
   * @param {'all'|'rate-limit'} [req.retry='all']
   * @returns {Promise<{ status: number, ok: boolean, headers: Record<string,string>, json: any, text: string, attempts: number }>}
   */
  async function request({
    url, method = 'GET', headers = {}, body, timeoutMs = DEFAULT_TIMEOUT_MS, signal, retry = 'all',
  } = {}) {
    if (typeof url !== 'string' || !/^https?:\/\//.test(url)) throw new Error('Listbridge transport: url must be http(s)');
    const sendHeaders = { ...headers };
    let sendBody = body;
    const isRaw = body == null || typeof body === 'string' || body instanceof ArrayBuffer || ArrayBuffer.isView(body)
      || (typeof FormData !== 'undefined' && body instanceof FormData) || (typeof Blob !== 'undefined' && body instanceof Blob);
    if (!isRaw) {
      sendBody = JSON.stringify(body);
      if (!Object.keys(sendHeaders).some(k => k.toLowerCase() === 'content-type')) sendHeaders['Content-Type'] = 'application/json';
    }

    for (let tries = 0; ; tries++) {
      const wait = blockedUntil - now();
      if (wait > 0) await sleep(Math.min(wait, MAX_WAIT_MS));
      if (signal?.aborted) {
        const e = new Error('Listbridge transport: request cancelled');
        /** @type {any} */ (e).cancelled = true;
        throw e;
      }
      let res; let text; let netErr = null;
      try {
        ({ res, text } = await attempt({ url, method, headers: sendHeaders, body: sendBody, timeoutMs, signal }));
      } catch (err) {
        if (/** @type {any} */ (err).cancelled) throw err;
        netErr = err;
      }

      const hdrs = res ? headersToObject(res.headers) : {};
      if (res && hdrs['x-ratelimit-remaining'] === '0') {
        const d = serverDelayMs({ 'x-ratelimit-reset': hdrs['x-ratelimit-reset'] }, now());
        if (d != null) blockedUntil = now() + Math.min(d, MAX_WAIT_MS);
      }
      const status = res ? res.status : 0;
      const retryable = retry === 'rate-limit'
        ? status === 429
        : netErr != null || status === 429 || status >= 500;

      if (!retryable || tries >= BACKOFF_MS.length) {
        if (netErr) throw netErr;
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch { json = null; }
        return { status, ok: status >= 200 && status < 300, headers: hdrs, json, text, attempts: tries + 1 };
      }
      const asked = res ? serverDelayMs(hdrs, now()) : null;
      await sleep(Math.min(asked ?? BACKOFF_MS[tries], MAX_WAIT_MS));
    }
  }

  return Object.freeze({ request });
}

// Strip query + credentials from a URL before it goes into an error message
// (presigned URLs carry signatures in the query string).
function safeUrl(url) {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return '<invalid url>';
  }
}

module.exports = { createTransport, BACKOFF_MS, _internal: Object.freeze({ serverDelayMs, headersToObject, safeUrl }) };
