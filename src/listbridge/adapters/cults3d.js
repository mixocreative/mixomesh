/**
 * Listbridge adapter: Cults3D, reconciled with the LIVE GraphQL schema (plan PB.3b; introspected
 * in PB.0: docs/reference/cults3d-schema.json + docs/reference/cults3d-findings.md, which are the
 * authority; tests/listbridge-cults3d-schema.test.mjs fails if this file drifts from them).
 * Pure: no host imports.
 *
 * CONFIRMED by the live schema:
 *  - Endpoint https://cults3d.com/graphql, JSON { query, variables }, HTTP Basic nickname:apiKey.
 *  - createCreation(name, description, details, categoryId!, subCategoryIds, tagNames, metaTags,
 *    locale!, downloadPrice, currency, licenseCode, usages, visibility, fileUrls, fileKeys, imageUrls,
 *    imageKeys, madeWithAi, openPriced) -> { creation, errors:[String!]! }; updateCreation(id!, same
 *    metadata, locale!) has no file / image arguments.
 *  - Native upload: createFileUploader / createImageUploader (no args) -> { errors, uploader { url,
 *    fields[{name,value}] } }, an S3-style presigned POST. This is the default transfer; the tunnel
 *    file host is only the fallback for URL-only platforms (fileUrls / imageUrls still build).
 *  - visibility PUBLIC | SECRET | DEACTIVATED (SECRET = only people with the link); LocaleEnum
 *    (EN ES DE FR IT PT JA TR RU ZH); CurrencyEnum (26 codes, below); madeWithAi is a real Boolean.
 *  - Read-back: creation(slug) { blueprints, illustrations, visibility, url }; licenses and
 *    categories queries; me { nick } for the connection test; myself { creationsBatch } ("List my
 *    designs") for finding a creation whose create answer was lost.
 *
 * STILL UNCONFIRMED (introspection cannot show these; check on the first live publish, PB.11):
 *  U1  fileKeys / imageKeys take the presign `key` field value verbatim (with ${filename} replaced
 *      by the uploaded file's name).
 *  U2  maxFiles / maxImages = 10 per creation, and per-file size limits.
 *  U3  Accepted printable / other file extensions and image mimes (PRINTABLE_EXT, OTHER_EXT, IMAGE_MIMES).
 *  U4  Tag count / length limits (core defaults: 20 tags of 40 characters).
 *  U5  `description` is plain text or Markdown (we send the listing's Markdown as-is).
 *  U6  Which uploaded files appear as `blueprints`: we expect one per MODEL file (PRINTABLE_EXT); a
 *      zip / pdf may not, so confirm requires blueprints >= model-file count (not zip contents).
 *  U7  Price is a major-unit decimal (4.5), and any minimum price.
 *  U8  Whether `me` is null (not an error) for a bad key; the connection test relies on HTTP 401.
 *  U9  Whether myself.creationsBatch lists SECRET creations and in which order. A creation it does
 *      not show is never assumed absent: the runner then refuses to create again (fails closed).
 */

export const CULTS3D_ENDPOINT = 'https://cults3d.com/graphql';

const MAX_FILES = 10; // U2
const MAX_IMAGES = 10; // U2
const CURRENCIES = ['ARS', 'AUD', 'BGN', 'BRL', 'CAD', 'CHF', 'CNY', 'CZK', 'DKK', 'EUR', 'GBP', 'HRK', 'HUF', 'INR', 'JPY', 'KRW', 'MXN', 'NOK', 'NZD', 'PLN', 'RON', 'RUB', 'SEK', 'TRY', 'USD', 'ZAR'];
const LOCALES = ['EN', 'ES', 'DE', 'FR', 'IT', 'PT', 'JA', 'TR', 'RU', 'ZH'];
const VISIBILITY_ENUM = { public: 'PUBLIC', secret: 'SECRET' };
const USAGES = ['3dp']; // Cults "technology": 3D printing
const PRINTABLE_EXT = ['stl', 'obj', '3mf', 'step', 'stp', 'ply', 'amf']; // U3
const OTHER_EXT = ['zip', 'rar', '7z', 'pdf', 'blend', 'fbx', 'gcode', 'scad', 'f3d', 'dxf', 'svg']; // U3
const IMAGE_MIMES = ['image/png', 'image/jpeg']; // U3

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

/**
 * App locale (en, ja, zh-Hant, ...) -> Cults LocaleEnum. zh-* -> ZH; anything unknown -> EN.
 * @param {string} locale
 */
export function localeEnum(locale) {
  const m = /^[a-z]{2}/i.exec(String(locale || ''));
  const code = m ? m[0].toUpperCase() : 'EN';
  return LOCALES.includes(code) ? code : 'EN';
}

/** @param {string} message @param {string} code @param {Issue[]} issues @returns {Error} */
function typedError(message, code, issues) {
  const err = /** @type {Error & { issues?: Issue[], code?: string }} */ (new Error(message));
  err.code = code;
  err.issues = issues;
  return err;
}

const post = (/** @type {string} */ query, /** @type {Record<string, any>} */ variables = {}) => ({
  method: 'POST', url: CULTS3D_ENDPOINT, headers: { Accept: 'application/json' }, body: { query, variables },
});

/**
 * Build an operation whose variable list contains only the supplied values.
 * @param {string} field mutation field name, e.g. createCreation
 * @param {Array<[string, string, any]>} args [argumentName, graphqlType, value]; undefined values are skipped
 * @param {string} locale LocaleEnum literal for the returned url
 */
function mutation(field, args, locale) {
  const used = args.filter((a) => a[2] !== undefined);
  const decl = used.map(([n, t]) => `$${n}: ${t}`).join(', ');
  const call = used.map(([n]) => `${n}: $${n}`).join(', ');
  const query = `mutation ${field[0].toUpperCase()}${field.slice(1)}(${decl}) {\n`
    + `  ${field}(${call}) {\n    creation { id slug url(locale: ${locale}) visibility }\n    errors\n  }\n}`;
  /** @type {Record<string, any>} */
  const variables = {};
  for (const [n, , v] of used) variables[n] = v;
  return { query, variables };
}

/**
 * Metadata shared by createCreation / updateCreation. The argument TYPES differ: create requires
 * name / description / categoryId, update takes them optionally.
 * @param {ListingPackage} pkg @param {boolean} create @returns {Array<[string, string, any]>}
 */
function metadataArgs(pkg, create) {
  const free = !pkg.price || !(pkg.price.amount > 0);
  const subs = pkg.subCategoryIds && pkg.subCategoryIds.length ? [...pkg.subCategoryIds] : undefined;
  return [
    ['name', create ? 'String!' : 'String', pkg.title],
    ['description', create ? 'String!' : 'String', pkg.description],
    ['locale', 'LocaleEnum!', localeEnum(pkg.locale)],
    ['categoryId', create ? 'ID!' : 'ID', pkg.categoryHint || undefined],
    ['subCategoryIds', '[ID!]', subs],
    ['tagNames', '[String!]', pkg.tags && pkg.tags.length ? [...pkg.tags] : undefined],
    ['downloadPrice', 'Float', free ? undefined : pkg.price?.amount],
    ['currency', 'CurrencyEnum', free ? undefined : pkg.price?.currency],
    ['licenseCode', 'String', pkg.license || undefined],
    ['usages', '[String!]', [...USAGES]],
    ['visibility', 'CreationVisibilityEnum', VISIBILITY_ENUM[pkg.visibility] || VISIBILITY_ENUM.secret],
    ['madeWithAi', 'Boolean', !!pkg.madeWithAi],
  ];
}

/**
 * Delivery of files / images: upload keys (native upload, default) when every item has one,
 * else public urls (tunnel / S3 fallback).
 * @param {Array<{name:string,url?:string,key?:string}>} list @param {string} what
 * @returns {{ field: 'keys'|'urls', values: string[] }}
 */
function deliveryOf(list, what) {
  if (list.length && list.every((x) => x.key)) return { field: 'keys', values: list.map((x) => /** @type {string} */ (x.key)) };
  return {
    field: 'urls',
    values: list.map((x) => {
      if (!x.url) throw new Error(`Cults3D needs an uploaded key or a public link for ${what} "${x.name}" (neither was provided).`);
      return x.url;
    }),
  };
}

/** @param {any} j @returns {string[]} */
function gqlErrors(j) {
  return (Array.isArray(j?.errors) ? j.errors : []).map((/** @type {any} */ e) => String(e?.message ?? e));
}

/** Cults visibility -> PublishResult.status: 'published' (PUBLIC), 'secret' (link only), else the raw value. */
function statusOf(/** @type {any} */ v) {
  return v === 'PUBLIC' ? 'published' : v === 'SECRET' ? 'secret' : String(v || 'submitted').toLowerCase();
}

/** @type {Adapter} */
export const cults3dAdapter = {
  describe() {
    return {
      id: 'cults3d',
      label: 'Cults3D',
      transfer: 'direct',
      transfers: ['direct', 'url'],
      maxFiles: MAX_FILES,
      maxImages: MAX_IMAGES,
      currencies: [...CURRENCIES],
      visibility: ['secret', 'public'],
      drafts: true, // SECRET = "only people with the link" (not a true draft)
      requires: ['categoryHint', 'license'],
      updateFiles: false, // updateCreation has no file / image arguments
      printableExtensions: [...PRINTABLE_EXT], // U3: a zip is an extra download, not a model (U6)
      fields: ['title', 'description', 'tags', 'price', 'license', 'categoryHint', 'subCategoryIds', 'visibility', 'madeWithAi', 'locale'],
      credentials: ['nickname', 'apiKey'],
    };
  },

  validate(pkg) {
    /** @type {Issue[]} */
    const issues = [];
    if (!pkg.categoryHint) issues.push({ field: 'category', code: 'category-required', message: 'Choose a Cults3D category.' });
    if (!pkg.license) issues.push({ field: 'license', code: 'license-required', message: 'Choose a license.' });
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
      const zips = files.filter((f) => extOf(f.name) === 'zip').map((f) => `"${f.name}"`);
      issues.push({
        field: 'files', code: 'no-printable-file',
        message: zips.length
          ? `${zips.join(', ')} is a zip: Cults3D offers it only as an extra download, not as the model. Add a model file that is not zipped (STL, 3MF or STEP; an OBJ export always arrives zipped).`
          : 'Add at least one printable model file (STL, OBJ, 3MF, STEP).',
      });
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
    return { Authorization: `Basic ${base64Utf8(`${nick}:${key}`)}` };
  },

  buildUploadSlot(kind) {
    const field = kind === 'image' ? 'createImageUploader' : 'createFileUploader';
    const op = `${field[0].toUpperCase()}${field.slice(1)}`;
    return post(`mutation ${op} {\n  ${field} {\n    errors\n    uploader { url fields { name value } }\n  }\n}`);
  },

  parseUploadSlot(res, item) {
    /** @type {Issue[]} */
    const issues = [];
    const j = res.json;
    if (!j || typeof j !== 'object') issues.push({ field: 'platform', code: 'bad-response', message: `Cults3D returned an unreadable response (HTTP ${res.status}).` });
    for (const m of gqlErrors(j)) issues.push({ field: 'platform', code: 'graphql-error', message: m });
    const payload = j?.data?.createFileUploader ?? j?.data?.createImageUploader ?? null;
    for (const e of Array.isArray(payload?.errors) ? payload.errors : []) {
      issues.push({ field: 'platform', code: 'upload-slot-error', message: String(e?.message ?? e) });
    }
    const up = payload?.uploader;
    if (!issues.length && (!up || typeof up.url !== 'string' || !/^https:\/\//.test(up.url) || !Array.isArray(up.fields))) {
      issues.push({ field: 'platform', code: 'no-upload-slot', message: 'Cults3D did not return an upload slot.' });
    }
    /** @type {Array<{ name: string, value: string }>} */
    let fields = [];
    let key = '';
    if (!issues.length) {
      fields = up.fields.map((/** @type {any} */ f) => ({ name: String(f?.name ?? ''), value: String(f?.value ?? '') }));
      const k = fields.find((f) => f.name.toLowerCase() === 'key');
      if (!k || !k.value) issues.push({ field: 'platform', code: 'no-upload-key', message: 'Cults3D upload slot has no "key" field.' });
      else key = k.value.split('${filename}').join(item?.name ?? '');
    }
    if (issues.length) throw typedError(`Cults3D upload slot: ${issues.map((i) => i.message).join('; ')}`, 'upload-slot-failed', issues);
    return { url: up.url, fields, key };
  },

  buildCreate(pkg, ctx) {
    const files = deliveryOf(ctx.files, 'file');
    const images = deliveryOf(ctx.images, 'image');
    const op = mutation('createCreation', [
      ...metadataArgs(pkg, true),
      [images.field === 'keys' ? 'imageKeys' : 'imageUrls', '[String!]', images.values],
      [files.field === 'keys' ? 'fileKeys' : 'fileUrls', '[String!]', files.values],
    ], localeEnum(pkg.locale));
    return { method: 'POST', url: CULTS3D_ENDPOINT, headers: { Accept: 'application/json' }, body: op };
  },

  buildUpdate(remoteId, pkg) {
    // updateCreation has no file / image arguments: an update edits the metadata only.
    const op = mutation('updateCreation', [['id', 'ID!', remoteId], ...metadataArgs(pkg, false)], localeEnum(pkg.locale));
    return { method: 'POST', url: CULTS3D_ENDPOINT, headers: { Accept: 'application/json' }, body: op };
  },

  parseResult(res) {
    /** @type {Issue[]} */
    const issues = [];
    const j = res.json;
    if (!j || typeof j !== 'object') issues.push({ field: 'platform', code: 'bad-response', message: `Cults3D returned an unreadable response (HTTP ${res.status}).` });
    for (const m of gqlErrors(j)) issues.push({ field: 'platform', code: 'graphql-error', message: m });
    const payload = j?.data?.createCreation ?? j?.data?.updateCreation ?? null;
    for (const e of Array.isArray(payload?.errors) ? payload.errors : []) {
      issues.push({ field: 'platform', code: 'creation-error', message: typeof e === 'string' ? e : String(e?.message ?? JSON.stringify(e)) });
    }
    const creation = payload?.creation;
    if (!issues.length && (!creation || !creation.id)) {
      issues.push({ field: 'platform', code: 'no-creation', message: 'Cults3D accepted the request but returned no creation.' });
    }
    if (issues.length) {
      // No error list and no creation proves nothing: the creation may exist (the runner then looks it up).
      const unclear = issues.every((i) => i.code === 'bad-response' || i.code === 'no-creation');
      throw typedError(`Cults3D: ${issues.map((i) => i.message).join('; ')}`, unclear ? 'platform-unclear' : 'platform-rejected', issues);
    }
    return {
      remoteId: String(creation.id), url: String(creation.url || ''), status: statusOf(creation.visibility),
      ...(creation.slug ? { slug: String(creation.slug) } : {}),
    };
  },

  buildConfirm(result) {
    if (!result?.slug) throw new Error('Cults3D confirm needs the creation slug (none was returned).');
    return post(
      'query Confirm($slug: String!) {\n  creation(slug: $slug) {\n    id slug visibility url\n    blueprints { id fileName }\n    illustrations { id }\n  }\n}',
      { slug: result.slug },
    );
  },

  parseConfirm(res, ctx) {
    const errs = gqlErrors(res.json);
    if (errs.length) throw typedError(`Cults3D: ${errs.join('; ')}`, 'platform-rejected', errs.map((m) => ({ field: 'platform', code: 'graphql-error', message: m })));
    const c = res.json?.data?.creation;
    if (!c) return { confirmed: false };
    // Blueprints are the model files; a zip / pdf is not expected to appear as one (U6).
    const expectBlueprints = (ctx?.files ?? []).filter((f) => PRINTABLE_EXT.includes(extOf(f.name))).length;
    const blueprints = Array.isArray(c.blueprints) ? c.blueprints.length : 0;
    const illustrations = Array.isArray(c.illustrations) ? c.illustrations.length : 0;
    const needImages = (ctx?.images ?? []).length > 0;
    // An update re-sends no files (updateCreation takes none): the creation existing is enough.
    if (!ctx?.update && (blueprints < expectBlueprints || (needImages && illustrations < 1))) return { confirmed: false };
    return { confirmed: true, status: statusOf(c.visibility), ...(c.url ? { url: String(c.url) } : {}) };
  },

  buildOwnListings(opts) {
    const l = localeEnum(opts?.locale ?? 'en');
    return post(`query OwnCreations {
  myself {
    creationsBatch(limit: 100) {
      results { id slug name(locale: ${l}) url(locale: ${l}) visibility }
    }
  }
}`);
  },

  parseOwnListings(res) {
    const errs = gqlErrors(res.json);
    const list = res.json?.data?.myself?.creationsBatch?.results;
    if (errs.length || !Array.isArray(list)) {
      throw typedError(`Cults3D: could not list your creations${errs.length ? ` (${errs.join('; ')})` : ''}.`, 'platform-rejected', []);
    }
    return list.filter((/** @type {any} */ c) => c && c.id != null).map((/** @type {any} */ c) => ({
      remoteId: String(c.id), name: String(c.name ?? ''), url: String(c.url || ''), status: statusOf(c.visibility),
      ...(c.slug ? { slug: String(c.slug) } : {}),
    }));
  },

  buildListOptions(opts) {
    const l = localeEnum(opts?.locale ?? 'en');
    return [post(
      `query ListOptions {\n  licenses { code name(locale: ${l}) allowsCommercialUse availableOnFreeDesigns availableOnPricedDesigns }\n`
      + `  categories { id name(locale: ${l}) children { id name(locale: ${l}) } }\n}`,
    )];
  },

  parseListOptions(responses) {
    const res = Array.isArray(responses) ? responses[0] : responses;
    const errs = gqlErrors(res?.json);
    const d = res?.json?.data;
    if (errs.length || !d || !Array.isArray(d.categories) || !Array.isArray(d.licenses)) {
      throw new Error(`Cults3D: could not load categories and licenses${errs.length ? ` (${errs.join('; ')})` : ''}.`);
    }
    return {
      categories: d.categories.map((/** @type {any} */ c) => ({
        id: String(c.id), name: String(c.name),
        children: (Array.isArray(c.children) ? c.children : []).map((/** @type {any} */ k) => ({ id: String(k.id), name: String(k.name) })),
      })),
      licenses: d.licenses.map((/** @type {any} */ l) => ({
        code: String(l.code), name: String(l.name),
        free: l.availableOnFreeDesigns === true, priced: l.availableOnPricedDesigns === true, commercial: l.allowsCommercialUse === true,
      })),
    };
  },

  testConnection() {
    return post('query Connection {\n  me { nick }\n}');
  },
};
