// Dress-rehearsal fake platform (plan PB.15). DEV ONLY.
//
// `LISTBRIDGE_FAKE_PLATFORM=1` (+ `LISTBRIDGE_FAKE_URL=<local fake GraphQL endpoint>`) replaces the
// real 'cults3d' adapter with a wrapper that keeps every real request builder / parser but sends
// the GraphQL calls to a local fake server (tests/listbridge-rehearsal.mjs). The fake answers
// createFileUploader / createImageUploader with a local presigned-POST target, receives the
// multipart uploads, and serves licenses / categories / the creation(slug) read-back. Nothing else
// changes: same runner, same IPC.
//
// HARD REQUIREMENT: a packaged build ignores the switch. The guard lives HERE, in the helper
// main.cjs calls with `app.isPackaged`, and is unit-tested (tests/listbridge-fake-platform.test.mjs).

/**
 * @param {object} real the real adapter (src/listbridge/adapters/cults3d.js)
 * @param {string} endpoint local fake GraphQL URL
 */
function createFakeCultsAdapter(real, endpoint) {
  const redirect = spec => ({ ...spec, url: endpoint });
  const loopbackUrl = 'https://loopback.invalid/';
  return {
    ...real,
    // Every GraphQL request goes to the local fake; the payload builders / parsers stay the REAL ones.
    buildCreate: (...a) => redirect(real.buildCreate(...a)),
    buildUpdate: (...a) => redirect(real.buildUpdate(...a)),
    testConnection: (...a) => redirect(real.testConnection(...a)),
    buildUploadSlot: (...a) => redirect(real.buildUploadSlot(...a)),
    buildConfirm: (...a) => redirect(real.buildConfirm(...a)),
    buildOwnListings: (...a) => redirect(real.buildOwnListings(...a)),
    buildListOptions: (...a) => real.buildListOptions(...a).map(redirect),
    // The real parser insists on an https slot; the fake's slot is a loopback http POST target.
    parseUploadSlot: (res, item) => {
      const payload = res.json?.data?.createFileUploader ?? res.json?.data?.createImageUploader;
      const url = payload?.uploader?.url;
      if (typeof url !== 'string') return real.parseUploadSlot(res, item);
      const swapped = { ...res, json: { data: Object.fromEntries(Object.entries(res.json.data).map(([k, v]) => [k, { ...v, uploader: { ...v.uploader, url: loopbackUrl } }])) } };
      return { ...real.parseUploadSlot(swapped, item), url };
    },
  };
}

/**
 * The adapters to register. Returns `null` (use the real ones) unless this is an UNPACKAGED
 * run with LISTBRIDGE_FAKE_PLATFORM=1 and a LISTBRIDGE_FAKE_URL; never anything when packaged.
 * @param {{ isPackaged: boolean, env?: NodeJS.ProcessEnv, realAdapters?: any[] }} opts
 * @returns {any[]|null}
 */
function fakePlatformAdapters({ isPackaged, env = process.env, realAdapters = [] }) {
  if (isPackaged) return null;
  if (env.LISTBRIDGE_FAKE_PLATFORM !== '1') return null;
  const endpoint = env.LISTBRIDGE_FAKE_URL;
  if (!/^http:\/\/127\.0\.0\.1:\d+(\/.*)?$/.test(String(endpoint || ''))) return null;   // loopback only
  const real = realAdapters.find(a => a.describe().id === 'cults3d');
  if (!real) return null;
  return realAdapters.map(a => (a === real ? createFakeCultsAdapter(real, endpoint) : a));
}

module.exports = { fakePlatformAdapters, createFakeCultsAdapter };
