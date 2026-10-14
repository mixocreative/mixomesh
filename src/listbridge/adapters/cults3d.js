/**
 * Listbridge adapter: Cults3D (plan PB.3a), built on the COMMUNITY-documented GraphQL
 * schema (https://github.com/CheekyCodexConjurer/cults3d-api-docs). Pure: no host imports.
 * Everything below marked `COMMUNITY-DOCUMENTED` is unverified until PB.0 introspects the
 * live schema; PB.3b then reconciles this file (payload builder + fixtures only).
 *
 * ASSUMPTIONS (each marked inline with `// COMMUNITY-DOCUMENTED — confirm in PB.0`):
 *  A1  Endpoint: POST https://cults3d.com/graphql, JSON body { query, variables }.
 *  A2  Auth: HTTP Basic, base64(nickname:apiKey).
 *  A3  Mutations createCreation / updateCreation exist and return { creation { id url }, errors }.
 *  A4  createCreation args: name, description, imageUrls, fileUrls, locale, categoryId,
 *      downloadPrice, currency, licenseCode, tagNames, madeWithAi (+ subCategoryIds, metaTags unused).
 *  A5  GraphQL variable type names: String!, [String!]!, ID!, Float, Boolean, LocaleEnum!,
 *      CurrencyEnum (the CurrencyEnum name is a guess; LocaleEnum is seen in a community query).
 *  A6  Locale / currency are upper-case enums (EN, EUR ...).
 *  A7  Price is a decimal major-unit Float (42.5), not cents; free listings omit price + currency.
 *  A8  fileUrls / imageUrls accept public HTTPS links; at most 10 of each per create call.
 *  A9  licenseCode is a string like "cults_cu"; the listing's `license` is passed through verbatim.
 *  A10 categoryId is an opaque ID; the listing's categoryHint is passed through verbatim.
 *  A11 `errors` on the mutation payload is an array of strings.
 *  A12 updateCreation edits metadata only (no file / image args); assets use separate mutations.
 *  A13 Accepted printable extensions and image mimes (png / jpeg) listed below.
 *  A14 A `visibility` argument may not exist; it is only sent when VISIBILITY_SUPPORTED is true.
 *  A15 Connection test query { myself { user { nick } } }.
 *  A16 New creations land as drafts / pending review (status reported as 'submitted').
 */

export const CULTS3D_ENDPOINT = 'https://cults3d.com/graphql'; // COMMUNITY-DOCUMENTED — confirm in PB.0

/** Flipped in PB.3b once the live schema confirms a `visibility` argument. */
export const VISIBILITY_SUPPORTED = false; // COMMUNITY-DOCUMENTED — confirm in PB.0

const MAX_FILES = 10; // COMMUNITY-DOCUMENTED — confirm in PB.0
const MAX_IMAGES = 10; // COMMUNITY-DOCUMENTED — confirm in PB.0
const CURRENCIES = ['EUR', 'USD', 'GBP']; // COMMUNITY-DOCUMENTED — confirm in PB.0
const PRINTABLE_EXT = ['stl', 'obj', '3mf', 'step', 'stp', 'ply', 'amf']; // COMMUNITY-DOCUMENTED — confirm in PB.0
const OTHER_EXT = ['zip', 'rar', '7z', 'pdf', 'blend', 'fbx', 'gcode', 'scad', 'f3d', 'dxf', 'svg']; // COMMUNITY-DOCUMENTED — confirm in PB.0
const IMAGE_MIMES = ['image/png', 'image/jpeg']; // COMMUNITY-DOCUMENTED — confirm in PB.0

/** @typedef {import('../core/adapter.js').Adapter} Adapter */
/** @typedef {import('../core/package.js').ListingPackage} ListingPackage */
/** @typedef {import('../core/package.js').Issue} Issue */

/** @param {string} name */
const extOf = (name) => {
  const i = String(name).lastIndexOf('.');
  return i < 0 ? '' : String(name).slice(i + 1).toLowerCase();
};

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * Base64 of a UTF-8 string without Buffer / btoa (the core must run in browsers and Node).
 * @param {string} text
 */
export function base64Utf8(text) {
  const b = new TextEncoder().encode(text);
  let out = '';
  for (let i = 0; i < b.length; i += 3) {
    const n = (b[i] << 16) | ((b[i + 1] || 0) << 8) | (b[i + 2] || 0);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63]
      + (i + 1 < b.length ? B64[(n >> 6) & 63] : '=') + (i + 2 < b.length ? B64[n & 63] : '=');
  }
  return out;
}

/** @param {string} locale */
const localeEnum = (locale) => {
  const m = /^[a-z]{2}/i.exec(String(locale || ''));
  return m ? m[0].toUpperCase() : 'EN'; // COMMUNITY-DOCUMENTED — confirm in PB.0
};

/**
 * Build an operation whose variable list contains only the supplied values.
 * @param {string} field mutation field name, e.g. createCreation
 * @param {Array<[string, string, any]>} args [argumentName, graphqlType, value]; undefined values are skipped
 */
function mutation(field, args) {
  const used = args.filter((a) => a[2] !== undefined);
  const decl = used.map(([n, t]) => `$${n}: ${t}`).join(', ');
  const call = used.map(([n]) => `${n}: $${n}`).join(', ');
  const query = `mutation ${field[0].toUpperCase()}${field.slice(1)}(${decl}) {\n`
    + `  ${field}(${call}) {\n    creation { id url(locale: EN) }\n    errors\n  }\n}`;
  /** @type {Record<string, any>} */
  const variables = {};
  for (const [n, , v] of used) variables[n] = v;
  return { query, variables };
}

/** @param {ListingPackage} pkg @returns {Array<[string, string, any]>} */
function metadataArgs(pkg) {
  const free = !pkg.price || !(pkg.price.amount > 0);
  return [
    // COMMUNITY-DOCUMENTED — confirm in PB.0 (argument names + variable types, A4/A5)
    ['name', 'String!', pkg.title],
    ['description', 'String!', pkg.description],
    ['locale', 'LocaleEnum!', localeEnum(pkg.locale)],
    ['tagNames', '[String!]', pkg.tags && pkg.tags.length ? [...pkg.tags] : undefined],
    ['downloadPrice', 'Float', free ? undefined : pkg.price?.amount],
    ['currency', 'CurrencyEnum', free ? undefined : pkg.price?.currency],
    ['licenseCode', 'String', pkg.license || undefined],
    ['categoryId', 'ID', pkg.categoryHint || undefined],
    ['madeWithAi', 'Boolean', !!pkg.madeWithAi],
    ...(VISIBILITY_SUPPORTED ? /** @type {Array<[string, string, any]>} */ ([['visibility', 'VisibilityEnum', 'DRAFT']]) : []),
  ];
}

/** @param {Array<{name:string,url?:string}>} list @param {string} what @returns {string[]} */
function urlsOf(list, what) {
  return list.map((x) => {
    if (!x.url) throw new Error(`Cults3D needs a public link for ${what} "${x.name}" (no hosted URL was provided).`);
    return x.url;
  });
}

/** @type {Adapter} */
export const cults3dAdapter = {
  describe() {
    return {
      id: 'cults3d',
      label: 'Cults3D',
      transfer: 'url',
      maxFiles: MAX_FILES,
      maxImages: MAX_IMAGES,
      currencies: [...CURRENCIES],
      fields: ['title', 'description', 'tags', 'price', 'license', 'categoryHint', 'madeWithAi', 'locale'],
      credentials: ['nickname', 'apiKey'],
    };
  },

  validate(pkg) {
    /** @type {Issue[]} */
    const issues = [];
    const files = pkg.files || [];
    let printable = 0;
    for (const f of files) {
      const e = extOf(f.name);
      if (PRINTABLE_EXT.includes(e)) printable++;
      else if (!OTHER_EXT.includes(e)) {
        issues.push({ field: 'files', code: 'file-type-unsupported', message: `Cults3D does not accept ".${e || '?'}" files ("${f.name}").` });
      }
    }
    if (files.length && !printable) {
      issues.push({ field: 'files', code: 'no-printable-file', message: 'Add at least one printable model file (STL, OBJ, 3MF, STEP).' });
    }
    for (const i of pkg.images || []) {
      if (!IMAGE_MIMES.includes(i.mime)) {
        issues.push({ field: 'images', code: 'image-type-unsupported', message: `Image "${i.name}" must be PNG or JPEG.` });
      }
    }
    return issues;
  },

  authHeaders(record) {
    const nick = String(record?.nickname ?? '');
    const key = String(record?.apiKey ?? '');
    return { Authorization: `Basic ${base64Utf8(`${nick}:${key}`)}` }; // COMMUNITY-DOCUMENTED — confirm in PB.0
  },

  buildCreate(pkg, ctx) {
    const fileUrls = urlsOf(ctx.files, 'file');
    const imageUrls = urlsOf(ctx.images, 'image');
    const op = mutation('createCreation', [
      ...metadataArgs(pkg),
      ['imageUrls', '[String!]!', imageUrls],
      ['fileUrls', '[String!]!', fileUrls],
    ]);
    return { method: 'POST', url: CULTS3D_ENDPOINT, headers: { Accept: 'application/json' }, body: op };
  },

  buildUpdate(remoteId, pkg) {
    // COMMUNITY-DOCUMENTED — confirm in PB.0 (A12: metadata only)
    const op = mutation('updateCreation', [['id', 'ID!', remoteId], ...metadataArgs(pkg)]);
    return { method: 'POST', url: CULTS3D_ENDPOINT, headers: { Accept: 'application/json' }, body: op };
  },

  parseResult(res) {
    /** @type {Issue[]} */
    const issues = [];
    const j = res.json;
    if (!j || typeof j !== 'object') issues.push({ field: 'platform', code: 'bad-response', message: `Cults3D returned an unreadable response (HTTP ${res.status}).` });
    for (const e of Array.isArray(j?.errors) ? j.errors : []) {
      issues.push({ field: 'platform', code: 'graphql-error', message: String(e?.message ?? e) });
    }
    const payload = j?.data?.createCreation ?? j?.data?.updateCreation ?? null;
    for (const e of Array.isArray(payload?.errors) ? payload.errors : []) { // A11
      issues.push({ field: 'platform', code: 'creation-error', message: typeof e === 'string' ? e : String(e?.message ?? JSON.stringify(e)) });
    }
    const creation = payload?.creation;
    if (!issues.length && (!creation || !creation.id)) {
      issues.push({ field: 'platform', code: 'no-creation', message: 'Cults3D accepted the request but returned no creation.' });
    }
    if (issues.length) {
      const err = /** @type {Error & { issues?: Issue[] }} */ (new Error(`Cults3D: ${issues.map((i) => i.message).join('; ')}`));
      err.issues = issues;
      throw err;
    }
    return { remoteId: String(creation.id), url: String(creation.url || ''), status: 'submitted' }; // A16
  },

  testConnection() {
    return {
      method: 'POST',
      url: CULTS3D_ENDPOINT,
      headers: { Accept: 'application/json' },
      body: { query: 'query Connection {\n  myself { user { nick } }\n}', variables: {} }, // COMMUNITY-DOCUMENTED — confirm in PB.0
    };
  },
};

