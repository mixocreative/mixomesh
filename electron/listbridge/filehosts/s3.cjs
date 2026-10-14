// Listbridge file host: S3-compatible object storage (ADR 0004 "File host", plan PB.5).
//
// URL-only platforms (Cults3D) accept files/images only as public HTTPS links. We upload
// each file to the OWNER's bucket (Cloudflare R2 by default; AWS S3 or any S3-compatible
// endpoint works) under an unguessable random prefix, hand the platform a SHORT-LIVED
// presigned GET URL, and delete the object once the platform confirms ingestion. Paid files
// therefore never sit at a permanent public URL.
//
// Pure Node: only node:crypto + an injected fetch. No Electron import, no AWS SDK, so any
// Node runner can reuse it (tests/listbridge-s3.test.mjs drives it against a fake S3).
//
// Signing (AWS Signature Version 4, implemented here with HMAC-SHA256 / SHA-256):
//   * GET for the platform  -> presigned query-string URL, X-Amz-SignedHeaders=host,
//     UNSIGNED-PAYLOAD, expiry 1 s .. 7 days (SigV4 maximum; larger values are clamped).
//   * PUT / DELETE (ours)   -> header-signed requests (Authorization header) with the REAL
//     payload SHA-256 in x-amz-content-sha256. Chosen over presigned PUT/DELETE because
//     (a) the store verifies the uploaded bytes against the signed hash (integrity), and
//     (b) no credential-bearing write URL ever exists that could leak into a log.
//   * Path-style URLs by default (https://<endpoint>/<bucket>/<key>): works for R2
//     (https://<account>.r2.cloudflarestorage.com, region 'auto') and AWS
//     (https://s3.<region>.amazonaws.com). `style: 'virtual'` gives <bucket>.<host>/<key>.
//
// Secrets: the secret key lives only in this closure. It and every computed signature are
// redacted from any thrown message; nothing here logs.

const crypto = require('node:crypto');

const ALGORITHM = 'AWS4-HMAC-SHA256';
const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';
const MAX_PRESIGN_SEC = 7 * 24 * 60 * 60;   // SigV4 hard limit: 604800 s
const DEFAULT_PRESIGN_SEC = 3600;
const MAX_NAME_BYTES = 180;                  // keeps whole keys well under S3's 1024-byte cap

const sha256Hex = data => crypto.createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data, 'utf8').digest();

// RFC 3986 encoding as SigV4 requires: unreserved (A-Z a-z 0-9 - . _ ~) kept, everything
// else percent-encoded from UTF-8 with uppercase hex. `keepSlash` for object-key paths.
function uriEncode(str, keepSlash = false) {
  const out = encodeURIComponent(String(str)).replace(/[!'()*]/g,
    c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return keepSlash ? out.replace(/%2F/g, '/') : out;
}

// 20130524T000000Z
function amzDateOf(date) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function signingKey(secretAccessKey, dateStamp, region, service = 's3') {
  const kDate = hmac('AWS4' + secretAccessKey, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, 'aws4_request');
}

function canonicalQueryString(params) {
  return Object.keys(params)
    .map(k => [uriEncode(k), uriEncode(params[k])])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0)))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
}

// Core SigV4 step shared by both signing modes. `headers` = lowercase-name -> value of the
// headers to SIGN (must include host). Returns the hex signature + signed-header list.
function computeSignature({
  method, canonicalUri, query = {}, headers, payloadHash, amzDate, region, secretAccessKey,
}) {
  const names = Object.keys(headers).map(n => n.toLowerCase()).sort();
  const lower = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  const canonicalHeaders = names
    .map(n => `${n}:${String(lower[n]).trim().replace(/\s+/g, ' ')}\n`).join('');
  const signedHeaders = names.join(';');
  const canonicalRequest = [
    method, canonicalUri, canonicalQueryString(query), canonicalHeaders, signedHeaders, payloadHash,
  ].join('\n');
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = [ALGORITHM, amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const signature = crypto.createHmac('sha256', signingKey(secretAccessKey, dateStamp, region))
    .update(stringToSign, 'utf8').digest('hex');
  return { signature, signedHeaders, scope };
}

// Presigned query-string auth. Returns the full query (incl. X-Amz-Signature) as a string.
function presignQuery({
  method, canonicalUri, host, amzDate, region, accessKeyId, secretAccessKey, expiresSec,
}) {
  const scope = `${amzDate.slice(0, 8)}/${region}/s3/aws4_request`;
  const query = {
    'X-Amz-Algorithm': ALGORITHM,
    'X-Amz-Credential': `${accessKeyId}/${scope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(expiresSec),
    'X-Amz-SignedHeaders': 'host',
  };
  const { signature } = computeSignature({
    method, canonicalUri, query, headers: { host }, payloadHash: UNSIGNED_PAYLOAD,
    amzDate, region, secretAccessKey,
  });
  return `${canonicalQueryString(query)}&X-Amz-Signature=${signature}`;
}

// Header auth. Returns the Authorization header value + the signature (for redaction).
function authorizationHeader({
  method, canonicalUri, query, headers, payloadHash, amzDate, region, accessKeyId, secretAccessKey,
}) {
  const { signature, signedHeaders, scope } = computeSignature({
    method, canonicalUri, query, headers, payloadHash, amzDate, region, secretAccessKey,
  });
  return {
    authorization: `${ALGORITHM} Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    signature,
  };
}

// Filename -> safe last key segment. Keeps the original name + extension (Cults needs the
// extension in the link), unicode allowed (it is percent-encoded in the URL), strips path
// parts / control chars, and caps the UTF-8 length while keeping the extension.
function safeFileName(name) {
  let s = String(name ?? '').normalize('NFC').replace(/\\/g, '/');
  s = s.slice(s.lastIndexOf('/') + 1);
  s = s.replace(/[\u0000-\u001f\u007f]/g, '').trim().replace(/[. ]+$/, '');
  if (!s || s === '.' || s === '..') s = 'file';
  if (Buffer.byteLength(s, 'utf8') > MAX_NAME_BYTES) {
    const dot = s.lastIndexOf('.');
    const ext = dot > 0 && s.length - dot <= 16 ? s.slice(dot) : '';
    let stem = ext ? s.slice(0, dot) : s;
    while (stem && Buffer.byteLength(stem + ext, 'utf8') > MAX_NAME_BYTES) {
      stem = Array.from(stem).slice(0, -1).join('');   // drop whole code points
    }
    s = (stem || 'file') + ext;
  }
  return s;
}

function normalizePrefix(prefix) {
  let p = String(prefix ?? '').replace(/^\/+/, '');
  if (p && !p.endsWith('/')) p += '/';
  if (p.split('/').some(seg => seg === '.' || seg === '..')) {
    throw new Error('S3 file host: prefix must not contain "." or ".." segments');
  }
  return p;
}

function parseS3Error(text) {
  const pick = tag => {
    const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(text || '');
    return m ? m[1].trim() : '';
  };
  return { code: pick('Code'), message: pick('Message') };
}

const isLoopback = hostname => hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]';

/**
 * @param {object} cfg
 * @param {string} cfg.endpoint        e.g. https://<account>.r2.cloudflarestorage.com
 * @param {string} cfg.region          'auto' for R2, e.g. 'us-east-1' for AWS
 * @param {string} cfg.bucket
 * @param {string} cfg.accessKeyId
 * @param {string} cfg.secretAccessKey
 * @param {string} [cfg.prefix='listbridge/']
 * @param {'path'|'virtual'} [cfg.style='path']
 * @param {typeof fetch} [cfg.fetchImpl]
 * @param {() => Date} [cfg.now]
 * @param {() => string} [cfg.randomId]
 */
function createS3FileHost({
  endpoint, region, bucket, accessKeyId, secretAccessKey,
  prefix = 'listbridge/', style = 'path',
  fetchImpl = globalThis.fetch, now = () => new Date(),
  randomId = () => crypto.randomBytes(16).toString('hex'),
} = {}) {
  for (const [k, v] of Object.entries({ endpoint, region, bucket, accessKeyId, secretAccessKey })) {
    if (typeof v !== 'string' || !v.trim()) throw new Error(`S3 file host: "${k}" is required`);
  }
  if (typeof fetchImpl !== 'function') throw new Error('S3 file host: fetch is not available');
  if (style !== 'path' && style !== 'virtual') throw new Error('S3 file host: style must be "path" or "virtual"');
  let base;
  try { base = new URL(endpoint); } catch { throw new Error('S3 file host: endpoint is not a valid URL'); }
  if (base.protocol !== 'https:' && !(base.protocol === 'http:' && isLoopback(base.hostname))) {
    throw new Error('S3 file host: endpoint must use https://');
  }
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) {
    throw new Error('S3 file host: bucket name is not valid (3-63 chars: a-z 0-9 . -)');
  }
  const keyPrefix = normalizePrefix(prefix);
  const host = style === 'virtual' ? `${bucket}.${base.host}` : base.host;
  const origin = `${base.protocol}//${host}`;
  const basePath = base.pathname.replace(/\/+$/, '');   // tolerate an endpoint with a path

  // Never let the secret (or a signature we produced) reach an error message.
  const redact = (msg, extra = []) => {
    let out = String(msg);
    for (const s of [secretAccessKey, ...extra]) if (s) out = out.split(s).join('[redacted]');
    return out;
  };

  function canonicalUriFor(key) {
    const encKey = uriEncode(key, true);
    return style === 'virtual' ? `${basePath}/${encKey}` : `${basePath}/${uriEncode(bucket)}/${encKey}`;
  }

  function checkKey(key) {
    if (typeof key !== 'string' || !key || key.startsWith('/')) throw new Error('S3 file host: invalid object key');
    if (key.split('/').some(seg => seg === '.' || seg === '..')) throw new Error('S3 file host: invalid object key');
    // Only ever touch objects this host created: a bad key cannot delete the rest of the bucket.
    if (!key.startsWith(keyPrefix)) throw new Error('S3 file host: key is outside the configured prefix');
  }

  async function signedFetch(method, canonicalUri, { body, contentType } = {}) {
    const amzDate = amzDateOf(now());
    const payloadHash = sha256Hex(body ?? Buffer.alloc(0));
    const signed = { host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
    const { authorization, signature } = authorizationHeader({
      method, canonicalUri, query: {}, headers: signed, payloadHash, amzDate, region, accessKeyId, secretAccessKey,
    });
    const headers = {
      Authorization: authorization,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
    };
    if (contentType) headers['Content-Type'] = contentType;
    let res;
    try {
      res = await fetchImpl(origin + canonicalUri, { method, headers, body });
    } catch (err) {
      throw new Error(redact(`S3 ${method} failed: network error (${err?.message || err})`, [signature]));
    }
    return { res, signature };
  }

  async function failure(method, res, signature) {
    let text = '';
    try { text = await res.text(); } catch { /* body unreadable: status alone */ }
    const { code, message } = parseS3Error(text);
    const detail = [code, message].filter(Boolean).join(': ') || res.statusText || 'request failed';
    const err = new Error(redact(`S3 ${method} failed (HTTP ${res.status}) ${detail}`, [signature]));
    /** @type {any} */ (err).status = res.status;
    /** @type {any} */ (err).code = code || undefined;
    return err;
  }

  async function put(name, bytes, mime) {
    let body;
    if (bytes instanceof ArrayBuffer) body = new Uint8Array(bytes);
    else if (ArrayBuffer.isView(bytes)) body = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    else throw new Error('S3 file host: put() needs bytes (ArrayBuffer / Uint8Array / Buffer)');
    const id = String(randomId());
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(id)) throw new Error('S3 file host: randomId() must return 8-128 url-safe chars');
    const key = `${keyPrefix}${id}/${safeFileName(name)}`;
    const { res, signature } = await signedFetch('PUT', canonicalUriFor(key), {
      body, contentType: typeof mime === 'string' && mime ? mime : 'application/octet-stream',
    });
    if (!res.ok) throw await failure('PUT', res, signature);
    try { await res.arrayBuffer(); } catch { /* drain */ }
    return { key };
  }

  function presignGet(key, expiresSec = DEFAULT_PRESIGN_SEC) {
    checkKey(key);
    const n = Number(expiresSec);
    if (!Number.isFinite(n) || n < 1) throw new Error('S3 file host: expiresSec must be a positive number of seconds');
    const expires = Math.min(Math.floor(n), MAX_PRESIGN_SEC);
    const canonicalUri = canonicalUriFor(key);
    const q = presignQuery({
      method: 'GET', canonicalUri, host, amzDate: amzDateOf(now()), region,
      accessKeyId, secretAccessKey, expiresSec: expires,
    });
    return `${origin}${canonicalUri}?${q}`;
  }

  async function remove(key) {
    checkKey(key);
    const { res, signature } = await signedFetch('DELETE', canonicalUriFor(key));
    if (res.ok || res.status === 404) {
      try { await res.arrayBuffer(); } catch { /* drain */ }
      return;
    }
    throw await failure('DELETE', res, signature);
  }

  // Round-trips a tiny probe object (write + delete permission is exactly what we need).
  async function testConnection() {
    try {
      const { key } = await put('connection-test.txt', new TextEncoder().encode('listbridge probe'), 'text/plain');
      await remove(key);
      return { ok: true, message: `Connected: bucket "${bucket}" accepts uploads and deletes.` };
    } catch (err) {
      return { ok: false, message: redact(err?.message || String(err)) };
    }
  }

  return Object.freeze({ put, presignGet, remove, testConnection });
}

module.exports = {
  createS3FileHost,
  // Exposed for the SigV4 test vectors; not part of the runner contract.
  _internal: Object.freeze({
    uriEncode, amzDateOf, canonicalQueryString, computeSignature, presignQuery,
    authorizationHeader, safeFileName, parseS3Error, MAX_PRESIGN_SEC,
  }),
};
