// fetch() for a test server on 127.0.0.1:<port from listen(0)>, over node:http.
//
// Global fetch refuses the WHATWG "bad ports" (1719, 2049, 5060, 6000,
// 6665-6669, 10080, ...) with `TypeError: fetch failed, cause: bad port`.
// On a machine whose dynamic port range starts at 1024 the OS hands those
// out to listen(0) now and then, and a loopback test failed for no reason
// (listbridge-tunnel, about 1 run in 20). A real client never meets those
// ports: production traffic goes through the public tunnel URL or a real S3
// endpoint. Supports what the tests use: method, headers, string or byte
// body, signal; the Response is a standard one.

import http from 'node:http';

const NO_BODY = new Set([101, 204, 205, 304]);

export function localFetch(url, { method = 'GET', headers, body, signal } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(String(url), { method, headers, signal }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('error', reject);
      res.on('end', () => {
        const pairs = [];
        for (let i = 0; i < res.rawHeaders.length; i += 2) pairs.push([res.rawHeaders[i], res.rawHeaders[i + 1]]);
        const empty = method === 'HEAD' || NO_BODY.has(res.statusCode);
        resolve(new Response(empty ? null : Buffer.concat(chunks), {
          status: res.statusCode, statusText: res.statusMessage, headers: pairs,
        }));
      });
    });
    req.on('error', reject);
    if (body != null) req.write(typeof body === 'string' ? body : Buffer.from(body));
    req.end();
  });
}
