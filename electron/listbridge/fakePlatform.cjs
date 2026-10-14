// Dress-rehearsal fake platform (plan PB.15). DEV ONLY.
//
// `LISTBRIDGE_FAKE_PLATFORM=1` (+ `LISTBRIDGE_FAKE_URL=<local fake GraphQL endpoint>`) replaces the
// real 'cults3d' adapter with a wrapper that keeps every real request builder / parser but sends
// the GraphQL calls to a local fake server (tests/listbridge-rehearsal.mjs) which downloads the
// file / image links through the public tunnel like Cults would. Nothing else changes: same
// runner, same tunnel host, same IPC.
//
// HARD REQUIREMENT: a packaged build ignores the switch. The guard lives HERE, in the helper
// main.cjs calls with `app.isPackaged`, and is unit-tested (tests/listbridge-fake-platform.test.mjs).

const FAKE_CONFIRM_QUERY = 'query Confirm($id: ID!) {\n  creation(id: $id) { id url(locale: EN) filesIngested }\n}';

/**
 * @param {object} real the real adapter (src/listbridge/adapters/cults3d.js)
 * @param {string} endpoint local fake GraphQL URL
 */
function createFakeCultsAdapter(real, endpoint) {
  const redirect = spec => ({ ...spec, url: endpoint });
  return {
    ...real,
    buildCreate: (...a) => redirect(real.buildCreate(...a)),
    buildUpdate: (...a) => redirect(real.buildUpdate(...a)),
    testConnection: (...a) => redirect(real.testConnection(...a)),
    // Cults' read-back (shape is the fake's own; the real one is reconciled in PB.3b/PB.11).
    buildConfirm: result => ({
      method: 'POST', url: endpoint, headers: { Accept: 'application/json' },
      body: { query: FAKE_CONFIRM_QUERY, variables: { id: result.remoteId } },
    }),
    parseConfirm: res => {
      const c = res.json?.data?.creation;
      if (!c) throw new Error('fake platform: no creation in confirm response');
      return c.filesIngested ? { confirmed: true, status: 'published', url: c.url || undefined } : { confirmed: false };
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
