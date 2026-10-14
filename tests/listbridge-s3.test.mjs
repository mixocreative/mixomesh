// Listbridge S3-compatible file host (plan PB.5): SigV4 against the official AWS test
// vectors, then a fake S3 server (node:http on 127.0.0.1) that independently re-verifies
// every signature, stores objects in memory, serves presigned GETs and rejects expired URLs.
//   node --test tests/listbridge-s3.test.mjs

import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { createRequire } from 'node:module';
import http from 'node:http';
import crypto from 'node:crypto';

const require = createRequire(import.meta.url);
const { createS3FileHost, _internal } = require('../electron/listbridge/filehosts/s3.cjs');

// AWS documentation example credentials (public, not a real key).
const AWS_KEY = 'AKIAIOSFODNN7EXAMPLE';
const AWS_SECRET = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
const VECTOR_DATE = () => new Date(Date.UTC(2013, 4, 24, 0, 0, 0));

// ── 1. Official AWS SigV4 vectors ────────────────────────────────────────────

test('presigned GET matches the AWS docs vector (virtual-host style)', () => {
  const s3 = createS3FileHost({
    endpoint: 'https://s3.amazonaws.com', region: 'us-east-1', bucket: 'examplebucket',
    accessKeyId: AWS_KEY, secretAccessKey: AWS_SECRET, prefix: '', style: 'virtual', now: VECTOR_DATE,
    fetchImpl: () => { throw new Error('no network'); },
  });
  const url = new URL(s3.presignGet('test.txt', 86400));
  assert.equal(url.origin, 'https://examplebucket.s3.amazonaws.com');
  assert.equal(url.pathname, '/test.txt');
  assert.equal(url.searchParams.get('X-Amz-Algorithm'), 'AWS4-HMAC-SHA256');
  assert.equal(url.searchParams.get('X-Amz-Credential'), 'AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request');
  assert.equal(url.searchParams.get('X-Amz-Date'), '20130524T000000Z');
  assert.equal(url.searchParams.get('X-Amz-Expires'), '86400');
  assert.equal(url.searchParams.get('X-Amz-SignedHeaders'), 'host');
  assert.equal(url.searchParams.get('X-Amz-Signature'),
    'aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404');
});

test('header-signed GET (Range) matches the AWS docs vector', () => {
  const emptyHash = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
  const { signature, signedHeaders } = _internal.computeSignature({
    method: 'GET', canonicalUri: '/test.txt', query: {},
    headers: { host: 'examplebucket.s3.amazonaws.com', range: 'bytes=0-9', 'x-amz-content-sha256': emptyHash, 'x-amz-date': '20130524T000000Z' },
    payloadHash: emptyHash, amzDate: '20130524T000000Z', region: 'us-east-1', secretAccessKey: AWS_SECRET,
  });
  assert.equal(signedHeaders, 'host;range;x-amz-content-sha256;x-amz-date');
  assert.equal(signature, 'f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
});

test('header-signed PUT matches the AWS docs vector ($ in key is encoded)', () => {
  const body = 'Welcome to Amazon S3.';
  const hash = crypto.createHash('sha256').update(body).digest('hex');
  assert.equal(hash, '44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072');
  const canonicalUri = '/' + _internal.uriEncode('test$file.text', true);
  assert.equal(canonicalUri, '/test%24file.text');
  const { signature } = _internal.computeSignature({
    method: 'PUT', canonicalUri, query: {},
    headers: {
      date: 'Fri, 24 May 2013 00:00:00 GMT', host: 'examplebucket.s3.amazonaws.com',
      'x-amz-content-sha256': hash, 'x-amz-date': '20130524T000000Z', 'x-amz-storage-class': 'REDUCED_REDUNDANCY',
    },
    payloadHash: hash, amzDate: '20130524T000000Z', region: 'us-east-1', secretAccessKey: AWS_SECRET,
  });
  assert.equal(signature, '98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd');
});

test('URI encoding is RFC 3986 (slash kept only in paths)', () => {
  const { uriEncode } = _internal;
  assert.equal(uriEncode("a b/c!'()*~._-ü", true), "a%20b/c%21%27%28%29%2A~._-%C3%BC");
  assert.equal(uriEncode('a/b'), 'a%2Fb');
});

test('presign expiry is validated and clamped to 7 days; config is validated', () => {
  const s3 = createS3FileHost({
    endpoint: 'https://acc.r2.cloudflarestorage.com', region: 'auto', bucket: 'mixo-files',
    accessKeyId: 'AK', secretAccessKey: 'SK', fetchImpl: async () => { throw new Error('x'); },
  });
  const u = new URL(s3.presignGet('listbridge/abcdefgh/a.stl', 10 * 24 * 3600));
  assert.equal(u.searchParams.get('X-Amz-Expires'), '604800');
  assert.equal(u.pathname, '/mixo-files/listbridge/abcdefgh/a.stl');   // path style by default
  assert.equal(new URL(s3.presignGet('listbridge/abcdefgh/a.stl')).searchParams.get('X-Amz-Expires'), '3600');
  assert.throws(() => s3.presignGet('listbridge/x/a.stl', 0), /expiresSec/);
  assert.throws(() => s3.presignGet('listbridge/x/a.stl', NaN), /expiresSec/);
  assert.throws(() => s3.presignGet('other/a.stl'), /outside the configured prefix/);
  assert.throws(() => s3.presignGet('listbridge/../secret'), /invalid object key/);
  assert.throws(() => createS3FileHost({ endpoint: 'http://example.com', region: 'auto', bucket: 'bkt', accessKeyId: 'a', secretAccessKey: 'b' }), /https/);
  assert.throws(() => createS3FileHost({ endpoint: 'https://x', region: 'auto', bucket: 'bkt', accessKeyId: 'a' }), /secretAccessKey/);
});

test('safeFileName keeps name + extension, strips paths, caps length', () => {
  const { safeFileName } = _internal;
  assert.equal(safeFileName('C:\\models\\dragon v2.3mf'), 'dragon v2.3mf');
  assert.equal(safeFileName('../../etc/passwd'), 'passwd');
  assert.equal(safeFileName(''), 'file');
  const long = safeFileName('龍'.repeat(200) + '.obj');
  assert.ok(long.endsWith('.obj'));
  assert.ok(Buffer.byteLength(long) <= 180);
});

// ── 2. Fake S3 server ────────────────────────────────────────────────────────

const SECRET = 'fakeSecret/+K7MDENG-EXAMPLE-0123456789';
const ACCESS = 'FAKEACCESSKEY';
const BUCKET = 'test-bucket';
const REGION = 'auto';
const store = new Map();          // raw (decoded) key -> { body, type }
let forceError = null;            // { status, code, message } to answer every request with
let server; let endpoint;

// Independent SigV4 verifier (does not reuse the module's signer).
const enc = s => encodeURIComponent(s).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
const hm = (k, d) => crypto.createHmac('sha256', k).update(d).digest();
function expectedSig({ method, path, query, headers, signedHeaders, payloadHash, amzDate }) {
  const cq = [...query].map(([k, v]) => [enc(k), enc(v)]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`).join('&');
  const names = signedHeaders.split(';');
  const ch = names.map(n => `${n}:${String(headers[n]).trim()}\n`).join('');
  const creq = [method, path, cq, ch, signedHeaders, payloadHash].join('\n');
  const scope = `${amzDate.slice(0, 8)}/${REGION}/s3/aws4_request`;
  const sts = ['AWS4-HMAC-SHA256', amzDate, scope, crypto.createHash('sha256').update(creq).digest('hex')].join('\n');
  const k = hm(hm(hm(hm('AWS4' + SECRET, amzDate.slice(0, 8)), REGION), 's3'), 'aws4_request');
  return crypto.createHmac('sha256', k).update(sts).digest('hex');
}
const xmlError = (res, status, code, message) => {
  res.writeHead(status, { 'content-type': 'application/xml' });
  res.end(`<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${message}</Message><RequestId>1</RequestId></Error>`);
};
const parseAmzDate = d => Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8), +d.slice(9, 11), +d.slice(11, 13), +d.slice(13, 15));

function handle(req, res, body) {
  if (forceError) return xmlError(res, forceError.status, forceError.code, forceError.message);
  const [rawPath, rawQuery = ''] = req.url.split('?');
  const prefix = `/${BUCKET}/`;
  if (!rawPath.startsWith(prefix)) return xmlError(res, 404, 'NoSuchBucket', 'no bucket');
  const key = decodeURIComponent(rawPath.slice(prefix.length));
  const query = new URLSearchParams(rawQuery);
  let ok = false;
  if (query.has('X-Amz-Signature')) {
    const given = query.get('X-Amz-Signature');
    query.delete('X-Amz-Signature');
    const amzDate = query.get('X-Amz-Date');
    if (query.get('X-Amz-Credential') !== `${ACCESS}/${amzDate.slice(0, 8)}/${REGION}/s3/aws4_request`) return xmlError(res, 403, 'InvalidAccessKeyId', 'bad credential');
    ok = given === expectedSig({ method: req.method, path: rawPath, query, headers: req.headers, signedHeaders: query.get('X-Amz-SignedHeaders'), payloadHash: 'UNSIGNED-PAYLOAD', amzDate });
    if (ok && Date.now() > parseAmzDate(amzDate) + Number(query.get('X-Amz-Expires')) * 1000) {
      return xmlError(res, 403, 'AccessDenied', 'Request has expired');
    }
  } else {
    const m = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/[^,]+, SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/.exec(req.headers.authorization || '');
    if (!m || m[1] !== ACCESS) return xmlError(res, 403, 'AccessDenied', 'no auth');
    const payloadHash = req.headers['x-amz-content-sha256'];
    if (payloadHash !== crypto.createHash('sha256').update(body).digest('hex')) return xmlError(res, 400, 'XAmzContentSHA256Mismatch', 'hash');
    ok = m[3] === expectedSig({ method: req.method, path: rawPath, query, headers: req.headers, signedHeaders: m[2], payloadHash, amzDate: req.headers['x-amz-date'] });
  }
  if (!ok) return xmlError(res, 403, 'SignatureDoesNotMatch', 'The request signature we calculated does not match');
  if (req.method === 'PUT') { store.set(key, { body, type: req.headers['content-type'] }); res.writeHead(200); return res.end(); }
  if (req.method === 'GET') {
    const o = store.get(key);
    if (!o) return xmlError(res, 404, 'NoSuchKey', 'The specified key does not exist.');
    res.writeHead(200, { 'content-type': o.type || 'application/octet-stream' }); return res.end(o.body);
  }
  if (req.method === 'DELETE') {
    if (!store.delete(key)) return xmlError(res, 404, 'NoSuchKey', 'The specified key does not exist.');
    res.writeHead(204); return res.end();
  }
  return xmlError(res, 405, 'MethodNotAllowed', 'nope');
}

before(async () => {
  server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => handle(req, res, Buffer.concat(chunks)));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  endpoint = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise(r => server.close(r)));

let seq = 0;
const host = (over = {}) => createS3FileHost({
  endpoint, region: REGION, bucket: BUCKET, accessKeyId: ACCESS, secretAccessKey: SECRET,
  randomId: () => `rnd${String(++seq).padStart(6, '0')}`, ...over,
});

test('put -> presignGet -> fetch bytes -> remove -> GET 404', async () => {
  const s3 = host();
  const bytes = crypto.randomBytes(4096);
  const { key } = await s3.put('model.stl', bytes, 'model/stl');
  assert.match(key, /^listbridge\/rnd\d{6}\/model\.stl$/);
  const url = s3.presignGet(key, 600);
  assert.ok(new URL(url).pathname.endsWith('/model.stl'), 'extension visible at end of URL path');
  const res = await fetch(url);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'model/stl');
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), bytes);
  await s3.remove(key);
  assert.equal((await fetch(s3.presignGet(key))).status, 404);
  await s3.remove(key);   // already gone -> 404 counts as success
});

test('unicode + space filename round-trips', async () => {
  const s3 = host();
  const name = 'ドラゴン 像 (v2) #1 ü.3mf';
  const { key } = await s3.put(name, Buffer.from('hello'), 'application/vnd.ms-package.3dmanufacturing-3dmodel+xml');
  assert.ok(key.endsWith(name));
  const url = s3.presignGet(key);
  assert.ok(url.split('?')[0].endsWith('.3mf'));
  assert.ok(!/[ ()#]/.test(url.split('?')[0].slice(endpoint.length)), 'path is percent-encoded');
  assert.equal(await (await fetch(url)).text(), 'hello');
  assert.ok(store.has(key));
  await s3.remove(key);
  assert.ok(!store.has(key));
});

test('expired presigned URL is rejected; tampered URL fails signature', async () => {
  const s3 = host();
  const { key } = await s3.put('a.png', Buffer.from([1, 2, 3]), 'image/png');
  const old = host({ now: () => new Date(Date.now() - 2 * 3600 * 1000) });
  const expired = await fetch(old.presignGet(key, 60));
  assert.equal(expired.status, 403);
  assert.match(await expired.text(), /expired/);
  const tampered = s3.presignGet(key).replace('X-Amz-Expires=3600', 'X-Amz-Expires=604800');
  assert.equal((await fetch(tampered)).status, 403);
  const wrongSecret = host({ secretAccessKey: 'nope' });
  await assert.rejects(wrongSecret.put('b.png', Buffer.from([1])), /HTTP 403.*SignatureDoesNotMatch/);
  await s3.remove(key);
});

test('S3 XML errors are parsed; secret and signature never in the message', async () => {
  const s3 = host();
  forceError = { status: 403, code: 'AccessDenied', message: `Access Denied for ${SECRET}` };
  try {
    let err;
    try { await s3.put('x.stl', Buffer.from('x'), 'model/stl'); } catch (e) { err = e; }
    assert.ok(err, 'put should throw');
    assert.equal(err.status, 403);
    assert.equal(err.code, 'AccessDenied');
    assert.match(err.message, /HTTP 403/);
    assert.match(err.message, /AccessDenied/);
    assert.ok(!err.message.includes(SECRET), 'secret leaked');
    assert.ok(!/[0-9a-f]{64}/.test(err.message), 'signature leaked');
    await assert.rejects(s3.remove('listbridge/rndx0000/x.stl'), e => e.status === 403 && !e.message.includes(SECRET));
    const r = await s3.testConnection();
    assert.equal(r.ok, false);
    assert.match(r.message, /AccessDenied/);
    assert.ok(!r.message.includes(SECRET));
  } finally {
    forceError = null;
  }
});

test('testConnection round-trips a probe object and leaves nothing behind', async () => {
  const before = store.size;
  const r = await host().testConnection();
  assert.equal(r.ok, true, r.message);
  assert.equal(store.size, before);
});

test('network failure message does not include the secret', async () => {
  const s3 = host({ fetchImpl: async () => { throw new Error(`connect ECONNREFUSED ${SECRET}`); } });
  await assert.rejects(s3.put('a.stl', Buffer.from('a')), e => /network error/.test(e.message) && !e.message.includes(SECRET));
});
