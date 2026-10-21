/**
 * Pure helpers for the Print > Publish tab (PB.9): no DOM, no state access.
 * The tab (PublishTab.js) renders; this file decides: button wording, price
 * formatting, tag chips, form -> listing mapping, step plan + progress, the
 * first blocking issue. Everything here is unit-tested (tests/publish-tab.test.mjs).
 */

import { createListing, validateListing } from '../../listbridge/index.js';

/** The one account slot per platform (credentials id `<platform>:default`). */
export const ACCOUNT_ID = 'default';
/** Own-bucket file host record id (`filehost:default`). */
export const S3_HOST_ID = 'default';
/** Automatic temporary-link host: needs no credentials, always connected. */
export const TUNNEL_HOST_ID = 'tunnel';

export const platformCredentialId = platform => `${platform}:${ACCOUNT_ID}`;
export const fileHostCredentialId = id => `filehost:${id}`;

// -- price ---------------------------------------------------------------

/**
 * Price input text -> number. '' / 0 = free (null). NaN when not a number.
 * Accepts a decimal comma ("4,50").
 * @param {string|number|null|undefined} text
 * @returns {number|null}
 */
export function parsePriceInput(text) {
  if (text == null) return null;
  const s = String(text).trim().replace(',', '.');
  if (s === '') return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return NaN;
  return n === 0 ? null : n;
}

/**
 * Locale-aware money text. Falls back to "4.00 XYZ" for unknown codes.
 * @param {number} amount @param {string} currency @param {string} [locale]
 */
export function formatPrice(amount, currency, locale = 'en') {
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(amount);
  } catch {
    return `${Number(amount).toFixed(2)} ${currency}`;
  }
}

// -- primary button ------------------------------------------------------

/**
 * Which consequence-naming label the primary button shows, as an i18n key +
 * params (the UI calls t()). `visibility` ('secret' | 'public') is passed only for platforms that
 * offer a choice: secret = "only people with the link" (worded "secretly", never "draft");
 * without it, `drafts` keeps the older "Save as draft" wording.
 * @param {{ label: string, remoteId?: string|null, drafts?: boolean, visibility?: string|null,
 *   amount?: number|null, currency?: string, locale?: string }} a
 * @returns {{ key: string, params: Record<string,string> }}
 */
export function primaryAction({ label, remoteId = null, drafts = false, visibility = null, amount = null, currency = '', locale = 'en' }) {
  if (remoteId) return { key: 'publish.btn.update', params: { label } };
  const free = amount == null || !(amount > 0);
  const price = free ? null : formatPrice(amount, currency, locale);
  if (visibility === 'secret') {
    return free ? { key: 'publish.btn.secretFree', params: { label } } : { key: 'publish.btn.secret', params: { label, price } };
  }
  if (!visibility && drafts) return { key: 'publish.btn.draft', params: { label } };
  if (free) return { key: 'publish.btn.liveFree', params: { label } };
  return { key: 'publish.btn.live', params: { label, price } };
}

// -- category / license options (from publish:listOptions) -----------------

/**
 * Licenses offered for a listing: free listings see those valid on free designs, priced
 * ones those valid on priced designs. A license record without the flags is always offered.
 * @param {Array<{code:string,name:string,free?:boolean,priced?:boolean}>} licenses
 * @param {number|null} amount price amount (null / 0 = free)
 */
export function licensesFor(licenses, amount) {
  const priced = amount != null && amount > 0;
  return (licenses ?? []).filter(l => (priced ? l.priced !== false : l.free !== false));
}

/** Children of a top-level category id (empty when unknown). */
export function subCategoriesOf(categories, id) {
  return (categories ?? []).find(c => c.id === id)?.children ?? [];
}

// -- tags ----------------------------------------------------------------

/**
 * Chip-input parsing. Splits `text` on commas / newlines, adds finished tokens
 * (case-insensitive de-dupe), and returns the unfinished tail as `rest`.
 * `commit: true` (Enter / blur) also takes the tail.
 * @param {string[]} tags @param {string} text @param {{commit?: boolean}} [opts]
 * @returns {{ tags: string[], rest: string }}
 */
export function addTagsFromText(tags, text, { commit = false } = {}) {
  const parts = String(text ?? '').split(/[,\n，、]/);
  const rest = commit ? '' : (parts.pop() ?? '');
  const seen = new Set(tags.map(x => x.toLowerCase()));
  const out = [...tags];
  for (const raw of parts) {
    const tag = raw.trim();
    if (!tag || seen.has(tag.toLowerCase())) continue;
    seen.add(tag.toLowerCase());
    out.push(tag);
  }
  return { tags: out, rest: rest.replace(/^\s+/, '') };
}

export const removeTag = (tags, index) => tags.filter((_, i) => i !== index);

// -- form <-> listing ----------------------------------------------------

/**
 * @typedef {{ title: string, description: string, tags: string[], category: string, subCategory: string,
 *   license: string, price: string, currency: string, madeWithAi: boolean, visibility: 'secret'|'public' }} PublishForm
 */

/** @returns {PublishForm} */
export function emptyForm(title = '', currency = 'EUR') {
  return {
    title, description: '', tags: [], category: '', subCategory: '', license: '', price: '', currency,
    madeWithAi: false, visibility: 'secret',
  };
}

/**
 * Prefill from a persisted listing record (Listings.js), else defaults.
 * @param {any|null} record @param {{ title?: string, currency?: string }} [defaults]
 * @returns {PublishForm}
 */
export function formFromRecord(record, defaults = {}) {
  const base = emptyForm(defaults.title ?? '', defaults.currency ?? 'EUR');
  if (!record) return base;
  return {
    title: record.title || base.title,
    description: record.description || '',
    tags: Array.isArray(record.tags) ? [...record.tags] : [],
    category: record.categoryId || '',
    subCategory: Array.isArray(record.subCategoryIds) ? (record.subCategoryIds[0] || '') : '',
    visibility: record.visibility === 'public' ? 'public' : 'secret',
    license: record.license || '',
    price: record.price ? String(record.price) : '',
    currency: record.currency || base.currency,
    madeWithAi: record.madeWithAi === true,
  };
}

/**
 * Form -> the `listing` input of PublishClient.buildListingPackage.
 * @param {PublishForm} form @param {{ locale?: string }} [opts]
 */
export function formToListing(form, { locale = 'en' } = {}) {
  const amount = parsePriceInput(form.price);
  return {
    title: form.title.trim(),
    description: form.description,
    tags: [...form.tags],
    price: amount == null ? null : { amount, currency: String(form.currency || '').trim().toUpperCase() },
    license: form.license.trim() || null,
    madeWithAi: !!form.madeWithAi,
    categoryHint: form.category.trim() || null,
    subCategoryIds: form.subCategory && form.subCategory.trim() ? [form.subCategory.trim()] : [],
    visibility: form.visibility === 'public' ? 'public' : 'secret',
    locale,
  };
}

// -- validation ----------------------------------------------------------

const ISSUE_KEYS = Object.freeze({
  'title-empty': 'publish.issue.titleEmpty',
  'description-empty': 'publish.issue.descriptionEmpty',
  'images-none': 'publish.issue.imagesNone',
  'files-none': 'publish.issue.filesNone',
  'price-invalid': 'publish.issue.priceInvalid',
  'price-precision': 'publish.issue.pricePrecision',
  'currency-invalid': 'publish.issue.currencyInvalid',
  'currency-unsupported': 'publish.issue.currencyUnsupported',
  'category-required': 'publish.issue.categoryRequired',
  'license-required': 'publish.issue.licenseRequired',
});

/** i18n key for a core issue code, or null (then the UI shows the core message). */
export const issueKey = code => ISSUE_KEYS[code] ?? null;

const ERROR_KEYS = Object.freeze({
  'no-credentials': 'publish.err.noCredentials',
  'no-file-host': 'publish.err.noFileHost',
  'upload-slot-failed': 'publish.err.uploadSlotFailed',
  'upload-failed': 'publish.err.uploadFailed',
  'cloudflared-missing': 'publish.err.cloudflaredMissing',
  'tunnel-start-timeout': 'publish.err.tunnelStartTimeout',
  'tunnel-not-public': 'publish.err.tunnelNotPublic',
  'platform-http': 'publish.err.platformHttp',
  'platform-rejected': 'publish.err.platformRejected',
  'not-confirmed': 'publish.err.notConfirmed',
  'cleanup-left': 'publish.err.cleanupLeft',
  'cancelled': 'publish.err.cancelled',
  'create-unknown': 'publish.err.createUnknown',
});

/** i18n key for a job error code, or null (then the UI shows the raw error message). */
export const errorKey = code => ERROR_KEYS[code] ?? null;

/**
 * What the failed panel offers. A create whose answer was lost (`create-unknown`) may exist on the
 * platform: its button only checks again, and publishing anew is a separate, confirmed choice.
 * @returns {{ retryKey: string, hintKey: string, publishNew: boolean }}
 */
export function failureView(outcome) {
  return outcome?.code === 'create-unknown'
    ? { retryKey: 'publish.unknown.check', hintKey: 'publish.unknown.howTo', publishNew: true }
    : { retryKey: 'publish.retry', hintKey: 'publish.failed.reuse', publishNew: false };
}

/**
 * Validate the form the way the main process will, without building files:
 * placeholder images / files stand in for the real bytes.
 * @param {{ form: PublishForm, hasHero: boolean, galleryCount: number, fileCount: number,
 *   limits?: { maxImages?: number, currencies?: string[] }, locale?: string,
 *   requires?: string[] }} a  `requires` = describe().requires (listing fields the platform insists on)
 * @returns {Array<{field:string, code:string, message:string}>}
 */
export function validateForm({ form, hasHero, galleryCount, fileCount, limits = {}, locale = 'en', requires = [] }) {
  const amount = parsePriceInput(form.price);
  const stub = { name: 'x', mime: 'application/octet-stream', bytes: new Uint8Array(0) };
  const images = [
    ...(hasHero ? [{ ...stub, name: 'hero.png', role: 'hero' }] : []),
    ...Array.from({ length: galleryCount }, (_, i) => ({ ...stub, name: `gallery-${i + 1}.png`, role: 'gallery' })),
  ];
  const files = Array.from({ length: fileCount }, (_, i) => ({ ...stub, name: `file-${i + 1}` }));
  const listing = formToListing(form, { locale });
  if (Number.isNaN(amount)) listing.price = { amount: NaN, currency: listing.price?.currency ?? form.currency };
  const pkg = createListing({ ...listing, images, files });
  const issues = validateListing(pkg, { maxImages: limits.maxImages, currencies: limits.currencies });
  if (requires.includes('categoryHint') && !pkg.categoryHint) issues.push({ field: 'category', code: 'category-required', message: 'Choose a category.' });
  if (requires.includes('license') && !pkg.license) issues.push({ field: 'license', code: 'license-required', message: 'Choose a license.' });
  return issues;
}

// -- steps ---------------------------------------------------------------

const STEP_LABEL_KEYS = Object.freeze({
  build: 'publish.step.build',
  validate: 'publish.step.validate',
  bundle: 'publish.step.bundle',
  host: 'publish.step.host',
  create: 'publish.step.create',
  update: 'publish.step.update',
  confirm: 'publish.step.confirm',
  cleanup: 'publish.step.cleanup',
});

/**
 * i18n key for a step id (build = renderer-side; the rest are jobs.cjs STEPS).
 * `direct` = the platform takes uploads itself: the host step reads "Upload files to ...".
 */
export const stepLabelKey = (id, { direct = false } = {}) => (direct && id === 'host' ? 'publish.step.hostDirect' : (STEP_LABEL_KEYS[id] ?? null));

/** Ordered step ids; 'publish' in jobs.cjs reports as create (new) or update (remoteId). */
export const stepPlan = isUpdate => ['build', 'validate', 'bundle', 'host', isUpdate ? 'update' : 'create', 'confirm', 'cleanup'];

/** @returns {Array<{id:string, status:'todo'|'run'|'done'|'failed'|'skipped', message?:string}>} */
export const initialSteps = isUpdate => stepPlan(isUpdate).map(id => ({ id, status: 'todo' }));

/**
 * Fold one progress event ({step,status,message,skipped}) into the step list.
 * Unknown steps are ignored. Earlier unfinished steps are closed as done.
 */
export function applyProgress(steps, event) {
  const i = steps.findIndex(s => s.id === event?.step);
  if (i < 0) return steps;
  const status = event.status === 'running' ? 'run'
    : event.status === 'done' ? (event.skipped ? 'skipped' : 'done')
      : event.status === 'failed' ? 'failed' : null;
  if (!status) return steps;
  return steps.map((s, j) => {
    if (j === i) {
      const { phase: _old, done: _d, total: _t, ...rest } = s;
      return {
        ...rest, status, message: event.message ?? s.message, ...(event.phase ? { phase: event.phase } : {}),
        ...(Number.isFinite(event.done) && Number.isFinite(event.total) ? { done: event.done, total: event.total } : {}),
      };
    }
    if (j < i && (s.status === 'todo' || s.status === 'run')) return { ...s, status: 'done' };
    return s;
  });
}

/** 0..1 for the progress bar (a running step counts half). */
export function progressFraction(steps) {
  if (!steps.length) return 0;
  let n = 0;
  for (const s of steps) n += s.status === 'done' || s.status === 'skipped' ? 1 : s.status === 'run' ? 0.5 : 0;
  return n / steps.length;
}

// -- credentials ---------------------------------------------------------

const KNOWN_FIELDS = Object.freeze({
  nickname: 'publish.cred.nickname',
  apiKey: 'publish.cred.apiKey',
  endpoint: 'publish.cred.endpoint',
  region: 'publish.cred.region',
  bucket: 'publish.cred.bucket',
  accessKeyId: 'publish.cred.accessKeyId',
  secretAccessKey: 'publish.cred.secretAccessKey',
  prefix: 'publish.cred.prefix',
  style: 'publish.cred.style',
});
/** i18n key for a credential field name, or null (UI then humanizes the name). */
export const credentialFieldKey = name => KNOWN_FIELDS[name] ?? null;

/** True when the field's value must be a password input and never be shown again. */
export const isSecretField = name => /key|secret|token|password|passw/i.test(name) && name !== 'accessKeyId';

/** "someFieldName" -> "Some field name" (fallback label for unknown credential fields). */
export function humanizeField(name) {
  const s = String(name).replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim().toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Trimmed non-empty values only; missing required names reported. */
export function collectCredentials(values, required, optional = []) {
  const out = {};
  const missing = [];
  for (const k of required) {
    const v = String(values[k] ?? '').trim();
    if (v) out[k] = v; else missing.push(k);
  }
  for (const k of optional) {
    const v = String(values[k] ?? '').trim();
    if (v) out[k] = v;
  }
  return { secret: out, missing };
}

/** "Files over N are zipped": N from describe().maxFiles, or null when unknown. */
export const zipLimit = desc => (Number.isFinite(desc?.maxFiles) ? desc.maxFiles : null);

/** Human size, "8.2 MB"; an em dash when unknown. */
export function formatBytes(n) {
  if (!Number.isFinite(n)) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// -- temporary-link hold ("Keep waiting", PB.14) --------------------------

/** One "Keep waiting" press adds this much (the main process caps a call at 60 min). */
export const KEEP_WAITING_MS = 15 * 60 * 1000;

/** Whole minutes for display, rounded up, never below 1. */
export const minutesLeft = ms => Math.max(1, Math.ceil((Number(ms) || 0) / 60000));

/**
 * The hold state after one progress event: set by the runner's structured
 * { step:'confirm', status:'running', hold:true, served?, total?, holdRemainingMs } event,
 * cleared by any other event of the job. Pure.
 * @returns {{ served: number|null, total: number|null, remainingMs: number }|null}
 */
export function nextHold(prev, ev) {
  if (ev?.step === 'confirm' && ev.status === 'running' && ev.hold === true) {
    const n = v => (Number.isFinite(v) ? v : null);
    return { served: n(ev.served), total: n(ev.total), remainingMs: Math.max(0, Number(ev.holdRemainingMs) || 0) };
  }
  return ev ? null : prev;
}

/** i18n key + params for the hold line (the UI calls t()). */
export function holdText(hold, label) {
  const min = minutesLeft(hold.remainingMs);
  return hold.total != null && hold.served != null
    ? { key: 'publish.hold.status', params: { label, served: hold.served, total: hold.total, min } }
    : { key: 'publish.hold.statusNoCount', params: { label, min } };
}

/**
 * Links-still-open info after a failed event: only a confirm-step failure that reports
 * linksOpenMs > 0 qualifies. `at` is when it was observed (for the countdown). Pure.
 * @returns {{ ms: number, at: number }|null}
 */
export function linksOpenFromEvent(ev, at) {
  if (ev?.step === 'confirm' && ev.status === 'failed' && Number(ev.linksOpenMs) > 0) return { ms: Number(ev.linksOpenMs), at };
  return null;
}

/** Milliseconds the links stay open from now (0 once gone). */
export const linksOpenLeft = (info, now) => (info ? Math.max(0, info.ms - (now - info.at)) : 0);
