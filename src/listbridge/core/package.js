/**
 * Listbridge core: platform-neutral listing package model.
 * Portable: no host imports, no DOM, no Node built-ins. Bytes are Uint8Array.
 */

export const LISTBRIDGE_FORMAT = 1;

/**
 * @typedef {{ name: string, mime: string, bytes: Uint8Array, role: 'hero'|'gallery' }} ListingImage
 * @typedef {{ name: string, mime: string, bytes: Uint8Array }} ListingFile
 * @typedef {{ amount: number, currency: string }} ListingPrice
 * @typedef {object} ListingPackage
 * @property {number} listbridge
 * @property {string} title
 * @property {string} description Markdown.
 * @property {string[]} tags
 * @property {ListingPrice|null} price null = free
 * @property {string|null} license
 * @property {boolean} madeWithAi
 * @property {string|null} categoryHint
 * @property {string} locale
 * @property {ListingImage[]} images
 * @property {ListingFile[]} files
 * @typedef {{ field: string, code: string, message: string }} Issue
 * @typedef {{ maxTitle?: number, maxTags?: number, maxTagLength?: number, maxImages?: number,
 *   maxFiles?: number, currencies?: string[], requireHero?: boolean }} Limits
 */

/** @param {any} v @returns {string} */
const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));

/** @param {any} list @returns {string[]} */
function normaliseTags(list) {
  const seen = new Set();
  /** @type {string[]} */
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const t = str(raw).trim();
    if (!t) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

/** @param {any} p @returns {ListingPrice|null} */
function normalisePrice(p) {
  if (p == null) return null;
  return { amount: Number(p.amount), currency: str(p.currency).trim().toUpperCase() };
}

/**
 * Build a normalised ListingPackage.
 * @param {Record<string, any>} [fields]
 * @returns {ListingPackage}
 */
export function createListing(fields = {}) {
  const f = fields || {};
  return {
    listbridge: LISTBRIDGE_FORMAT,
    title: str(f.title).trim(),
    description: str(f.description),
    tags: normaliseTags(f.tags),
    price: normalisePrice(f.price),
    license: f.license == null ? null : str(f.license),
    madeWithAi: !!f.madeWithAi,
    categoryHint: f.categoryHint == null ? null : str(f.categoryHint),
    locale: f.locale ? str(f.locale) : 'en',
    images: (f.images || []).map((/** @type {any} */ i) => ({
      name: str(i.name), mime: str(i.mime), bytes: i.bytes, role: i.role === 'hero' ? 'hero' : 'gallery',
    })),
    files: (f.files || []).map((/** @type {any} */ x) => ({ name: str(x.name), mime: str(x.mime), bytes: x.bytes })),
  };
}

/** @param {any} name */
function safeName(name) {
  if (typeof name !== 'string' || !name.trim()) return false;
  if (/[\\/]/.test(name) || name.includes('..')) return false;
  for (let i = 0; i < name.length; i++) {
    const c = name.charCodeAt(i);
    if (c < 32 || c === 127) return false;
  }
  return true;
}

/**
 * @param {ListingPackage} pkg
 * @param {Limits} [limits]
 * @returns {Issue[]}
 */
export function validateListing(pkg, limits = {}) {
  const {
    maxTitle = 120, maxTags = 20, maxTagLength = 40, maxImages = 10, currencies, requireHero = true,
  } = limits;
  /** @type {Issue[]} */
  const issues = [];
  /** @param {string} field @param {string} code @param {string} message */
  const add = (field, code, message) => issues.push({ field, code, message });

  const title = str(pkg.title).trim();
  if (title.length < 1) add('title', 'title-empty', 'Title is required.');
  else if (title.length > maxTitle) add('title', 'title-too-long', `Title is longer than ${maxTitle} characters.`);

  if (!str(pkg.description).trim()) add('description', 'description-empty', 'Description is required.');

  const tags = pkg.tags || [];
  if (tags.length > maxTags) add('tags', 'tags-too-many', `At most ${maxTags} tags allowed.`);
  for (const t of tags) {
    if (t.length > maxTagLength) add('tags', 'tag-too-long', `Tag "${t}" is longer than ${maxTagLength} characters.`);
  }

  if (pkg.price) {
    const { amount, currency } = pkg.price;
    if (!Number.isFinite(amount) || amount < 0) {
      add('price', 'price-invalid', 'Price must be a number of 0 or more.');
    } else if (Math.abs(Math.round(amount * 100) - amount * 100) > 1e-6) {
      add('price', 'price-precision', 'Price may have at most 2 decimal places.');
    }
    if (!/^[A-Z]{3}$/.test(str(currency))) add('price', 'currency-invalid', 'Currency must be a 3-letter ISO 4217 code.');
    else if (currencies && !currencies.includes(currency)) {
      add('price', 'currency-unsupported', `Currency ${currency} is not supported.`);
    }
  }

  const images = pkg.images || [];
  if (images.length < 1) add('images', 'images-none', 'At least one image is required.');
  if (images.length > maxImages) add('images', 'images-too-many', `At most ${maxImages} images allowed.`);
  if (requireHero && images.length >= 1) {
    const heroes = images.filter((i) => i.role === 'hero').length;
    if (heroes !== 1) add('images', 'hero-count', 'Exactly one image must have role "hero".');
  }
  for (const i of images) {
    if (!safeName(i.name)) add('images', 'image-name-unsafe', `Unsafe image name "${i.name}".`);
  }

  const files = pkg.files || [];
  if (files.length < 1) add('files', 'files-none', 'At least one file is required.');
  const seen = new Set();
  for (const f of files) {
    if (!safeName(f.name)) { add('files', 'file-name-unsafe', `Unsafe file name "${f.name}".`); continue; }
    const k = f.name.toLowerCase();
    if (seen.has(k)) add('files', 'file-name-duplicate', `Duplicate file name "${f.name}".`);
    seen.add(k);
  }
  return issues;
}

/**
 * Decide how files are delivered. Over the limit => everything goes in one zip
 * (zipping itself is the runner's job).
 * @param {ListingFile[]} files
 * @param {number} maxFiles
 * @param {{ zipName?: string }} [opts]
 * @returns {{ bundles: Array<{ name: string, files: ListingFile[] }>, loose: ListingFile[] }}
 */
export function planBundle(files, maxFiles, { zipName = 'files.zip' } = {}) {
  if (files.length <= maxFiles) return { bundles: [], loose: [...files] };
  return { bundles: [{ name: zipName, files: [...files] }], loose: [] };
}

/**
 * JSON-serialisable manifest (listing.json): everything except bytes.
 * @param {ListingPackage} pkg
 */
export function toManifest(pkg) {
  return {
    listbridge: LISTBRIDGE_FORMAT,
    title: pkg.title,
    description: pkg.description,
    tags: [...pkg.tags],
    price: pkg.price ? { amount: pkg.price.amount, currency: pkg.price.currency } : null,
    license: pkg.license,
    madeWithAi: pkg.madeWithAi,
    categoryHint: pkg.categoryHint,
    locale: pkg.locale,
    images: pkg.images.map((i) => ({
      name: i.name, mime: i.mime, role: i.role, path: `images/${i.name}`, size: i.bytes.length,
    })),
    files: pkg.files.map((f) => ({ name: f.name, mime: f.mime, path: `files/${f.name}`, size: f.bytes.length })),
  };
}

/**
 * @param {any} manifest
 * @param {(path: string) => Promise<Uint8Array>|Uint8Array} readBytes
 * @returns {Promise<ListingPackage>}
 */
export async function fromManifest(manifest, readBytes) {
  if (!manifest || typeof manifest !== 'object') throw new Error('Listbridge: manifest is not an object.');
  const v = manifest.listbridge;
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error('Listbridge: manifest has no format version.');
  if (v > LISTBRIDGE_FORMAT) {
    throw new Error(`Listbridge: unsupported future format ${v} (this build reads up to ${LISTBRIDGE_FORMAT}).`);
  }
  // The manifest is untrusted input: never hand its `path` to the reader (a
  // crafted "images/../../x" would read outside the package). The path is
  // rebuilt from a validated name, so a reader only ever sees images/<n> or files/<n>.
  const entryPath = (dir, entry) => {
    if (!safeName(entry?.name)) throw new Error(`Listbridge: unsafe ${dir} entry name "${entry?.name}".`);
    return `${dir}/${entry.name}`;
  };
  const images = [];
  for (const i of manifest.images || []) images.push({ ...i, bytes: await readBytes(entryPath('images', i)) });
  const files = [];
  for (const f of manifest.files || []) files.push({ ...f, bytes: await readBytes(entryPath('files', f)) });
  return createListing({ ...manifest, images, files });
}
