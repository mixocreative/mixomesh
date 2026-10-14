// Listing records persisted in `.mixo` as `project.listings[]` (schema 3.5).
// Pure helpers, no state access. A record holds what the owner typed plus the
// remote result of a publish — NEVER credentials or file bytes. The platform
// specifics live in src/listbridge; this is the MIXOMESH glue layer.

const SECRET_KEY = /key|secret|token|password|passwd|credential|auth/i;
export const LISTING_STATUSES = ['draft', 'published', 'failed'];

const _str = (v, d = '') => (typeof v === 'string' ? v : d);
const _strOrNull = v => (typeof v === 'string' && v !== '' ? v : null);
const _iso = v => {
  if (typeof v !== 'string' || !v) return null;
  return Number.isNaN(Date.parse(v)) ? null : v;
};

/**
 * Coerce an arbitrary object into a clean ListingRecord. Unknown keys, and
 * anything named like a key/secret/token/password, are dropped.
 * Returns null when `raw` is not an object or has no platform.
 * @param {any} raw
 */
export function normalizeListing(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const platform = _str(raw.platform).trim();
  if (!platform) return null;
  const price = typeof raw.price === 'number' ? raw.price
    : (typeof raw.price === 'string' && raw.price.trim() !== '' ? Number(raw.price) : null);
  const strList = v => (Array.isArray(v) ? v.filter(x => typeof x === 'string' && x !== '') : []);
  const rec = {
    platform,
    accountId: _strOrNull(raw.accountId),
    title: _str(raw.title),
    description: _str(raw.description),
    tags: strList(raw.tags),
    price: Number.isFinite(price) ? price : null,
    currency: _strOrNull(raw.currency),
    license: _strOrNull(raw.license),
    madeWithAi: raw.madeWithAi === true,
    categoryId: _strOrNull(raw.categoryId),
    remoteId: _strOrNull(raw.remoteId),
    url: _strOrNull(raw.url),
    publishedAt: _iso(raw.publishedAt),
    updatedAt: _iso(raw.updatedAt),
    fileNames: strList(raw.fileNames),
    status: LISTING_STATUSES.includes(raw.status) ? raw.status : 'draft',
  };
  // Defence in depth: the whitelist above already excludes secret-named keys.
  for (const k of Object.keys(rec)) if (SECRET_KEY.test(k) && k !== 'accountId' && k !== 'categoryId') delete rec[k];
  return rec;
}

/** Normalize a whole list, dropping unusable entries. */
export function normalizeListings(list) {
  return Array.isArray(list) ? list.map(normalizeListing).filter(Boolean) : [];
}

/**
 * Insert or update. Matches by platform+accountId+remoteId; a record with a
 * null remoteId updates the draft (remoteId null) of that platform+account in
 * place. A record whose remoteId matches an existing published listing updates
 * it — never duplicates. Returns a NEW array.
 * @param {any[]} listings
 * @param {any} record
 */
export function upsertListing(listings, record) {
  const rec = normalizeListing(record);
  const list = normalizeListings(listings);
  if (!rec) return list;
  const same = l => l.platform === rec.platform && l.accountId === rec.accountId;
  let i = rec.remoteId !== null
    ? list.findIndex(l => same(l) && l.remoteId === rec.remoteId)
    : -1;
  // A draft becomes the remote listing once it gets a remoteId.
  if (i < 0 && rec.remoteId !== null) i = list.findIndex(l => same(l) && l.remoteId === null);
  if (i < 0 && rec.remoteId === null) i = list.findIndex(l => same(l) && l.remoteId === null);
  if (i < 0) return [...list, rec];
  const next = list.slice();
  next[i] = rec;
  return next;
}

/** The listing for a platform+account (first match), or null. */
export function findListing(listings, platform, accountId = null) {
  const list = Array.isArray(listings) ? listings : [];
  return list.find(l => l && l.platform === platform && (l.accountId ?? null) === (accountId ?? null)) ?? null;
}
