// Renderer-side glue for marketplace publishing (ADR 0004, PB.6). MIXOMESH
// layer: builds a Listbridge ListingPackage from the current project and hands
// it to the Electron main process (`window.electronAPI.listbridge`). No
// credentials, no platform specifics, no second export writer live here — files
// come from the SAME export pipeline (PrintManager.collectExportFiles) and the
// platform logic stays in src/listbridge + electron/listbridge.
//
// Publishing is NOT an undoable edit: the resulting listing record goes through
// setState (which marks the project dirty), never a Command.

import { createListing, toManifest } from '../../listbridge/index.js';
import { caps as liveCaps } from '../storage/capabilities.js';
import { getState, setState } from '../StateManager.js';
import { upsertListing, findListing } from './Listings.js';
import { mintProjectId } from '../persist/ProjectId.js';

const EXT_BY_MIME = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

/** Injectable seams (tests pass fakes); defaults are the live app. */
function resolveDeps(deps = {}) {
  return {
    caps: deps.caps ?? liveCaps,
    api: deps.api ?? (typeof window !== 'undefined' ? window.electronAPI?.listbridge : undefined),
    getState: deps.getState ?? getState,
    setState: deps.setState ?? setState,
    collectExportFiles: deps.collectExportFiles
      ?? (async (formats, options) => (await import('../PrintManager.js')).collectExportFiles(formats, options)),
    now: deps.now ?? (() => new Date().toISOString()),
  };
}

/** True when publishing exists in this runtime (desktop shell with the bridge). */
export function isAvailable(deps) {
  const d = resolveDeps(deps);
  return !!d.caps?.publish && !!d.api;
}

function requireApi(deps) {
  const d = resolveDeps(deps);
  if (!d.caps?.publish || !d.api) {
    throw new Error('Publishing is only available in the MIXOMESH desktop app.');
  }
  return d;
}

async function imageEntry(blob, role, index) {
  const mime = blob.type || 'image/png';
  const ext = EXT_BY_MIME[mime] ?? 'png';
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return { name: role === 'hero' ? `hero.${ext}` : `gallery-${index}.${ext}`, mime, bytes, role };
}

/**
 * Build the ListingPackage for the current project.
 * @param {{ listing: object, exportSelection?: {formats: string[], options?: object},
 *   heroBlob: Blob, galleryBlobs?: Blob[] }} input
 *   `listing` = the typed fields (title, description, tags, price, license, madeWithAi, categoryHint, locale).
 * @returns {Promise<{blocked:false, pkg:object}
 *   | {blocked:true, code:string, readinessIssues:any[]}>}
 *   `blocked` = the export readiness gate said no (nothing was produced).
 */
export async function buildListingPackage(input, deps) {
  const d = resolveDeps(deps);
  const { listing = {}, exportSelection = { formats: [] }, heroBlob, galleryBlobs = [] } = input ?? {};
  const formats = exportSelection.formats ?? [];
  let files = [];
  if (formats.length) {
    const res = await d.collectExportFiles(formats, exportSelection.options ?? {});
    if (res.blocked) return res;
    files = res.files;
  }
  const images = [];
  if (heroBlob) images.push(await imageEntry(heroBlob, 'hero', 0));
  for (let i = 0; i < galleryBlobs.length; i++) images.push(await imageEntry(galleryBlobs[i], 'gallery', i + 1));
  return { blocked: false, pkg: createListing({ ...listing, images, files }) };
}

function recordFor(pkg, req, outcome, status, now, existing = null) {
  const r = outcome.result ?? {};
  // A metadata-only update sends no files: the listing still carries the files it was published with.
  const fileNames = pkg.files.length || !existing ? pkg.files.map(f => f.name) : [...(existing.fileNames ?? [])];
  return {
    platform: req.platform,
    accountId: req.accountId,
    title: pkg.title,
    description: pkg.description,
    tags: pkg.tags,
    price: pkg.price ? pkg.price.amount : null,
    currency: pkg.price ? pkg.price.currency : null,
    license: pkg.license,
    madeWithAi: pkg.madeWithAi,
    categoryId: pkg.categoryHint,
    subCategoryIds: pkg.subCategoryIds ?? [],
    visibility: pkg.visibility ?? null,
    remoteId: r.remoteId ?? req.remoteId ?? null,
    url: r.url ?? null,
    publishedAt: status === 'published' ? now : null,
    updatedAt: now,
    fileNames,
    status,
  };
}

/** The project's stable id (minted silently when it has none): the main process journals creates by it. */
function projectKey(d) {
  let id = d.getState().project?.id;
  if (!id) {
    id = mintProjectId();
    d.setState(s => ({ ...s, project: { ...s.project, id } }), { silent: true });
  }
  return id;
}

/** The main process keeps a created listing on disk until the project has its record; then drop it. */
async function acknowledge(outcome, d) {
  if (!outcome?.jobId || !outcome.result?.remoteId || typeof d.api.resolvePending !== 'function') return;
  try { await d.api.resolvePending(outcome.jobId, 'ack'); } catch { /* kept: the next load records it again (same remoteId, no duplicate) */ }
}

/** Persist the outcome in project.listings (non-undoable; marks dirty). */
function recordOutcome(pkg, req, outcome, d) {
  if (!outcome) return;
  const now = d.now();
  let rec = null;
  if (outcome.ok) {
    // 'published' = public; anything else ('secret' = link only, or a platform draft) stays a draft record.
    const published = outcome.result?.status === 'published';
    const existing = req.remoteId ? findListing(d.getState().project?.listings, req.platform, req.accountId) : null;
    rec = recordFor(pkg, req, outcome, published ? 'published' : 'draft', now, existing?.remoteId === req.remoteId ? existing : null);
  } else if (outcome.status === 'invalid') {
    return;   // never reached the platform; nothing to record
  } else if (outcome.result?.remoteId || req.remoteId) {
    // A remote listing exists (created before a later step failed, or an update
    // failed): keep its record, flag it failed. A first publish that never
    // created anything leaves project.listings untouched.
    const remoteId = outcome.result?.remoteId ?? req.remoteId;
    const existing = findListing(d.getState().project?.listings, req.platform, req.accountId);
    const base = existing && existing.remoteId === remoteId ? existing : recordFor(pkg, req, outcome, 'failed', now);
    rec = { ...base, remoteId, updatedAt: now, status: 'failed' };
  }
  if (!rec) return;
  d.setState(s => ({ ...s, project: { ...s.project, listings: upsertListing(s.project?.listings, rec) } }));
}

/**
 * Early persistence (PB.14): the moment a create/update step reports `remoteId`, write the
 * listing record (status 'failed' = "exists remotely, publish not finished"), so a crash,
 * reload or quit before confirm/cleanup cannot lose the id (the next publish would create a
 * duplicate). recordOutcome() upgrades it to published/draft when the job settles. An update
 * of a record that already has this remoteId changes nothing early.
 */
function persistEarly(pkg, req, ev, d) {
  if (!ev || ev.status !== 'done' || !ev.remoteId) return;
  if (ev.step !== 'create' && ev.step !== 'update') return;
  const existing = findListing(d.getState().project?.listings, req.platform, req.accountId);
  if (existing && existing.remoteId === ev.remoteId) return;
  const rec = recordFor(pkg, req, { result: { remoteId: ev.remoteId, url: ev.url ?? null } }, 'failed', d.now());
  d.setState(s => ({ ...s, project: { ...s.project, listings: upsertListing(s.project?.listings, rec) } }));
}

/** Subscribe to progress: early persistence first, then the caller's listener. Returns unsubscribe. */
function watchProgress(pkg, req, onProgress, d) {
  const listener = ev => {
    try { persistEarly(pkg, req, ev, d); } catch { /* the outcome write below is the fallback */ }
    if (typeof onProgress === 'function') onProgress(ev);
  };
  return d.api.onProgress?.(listener) ?? null;
}

/**
 * Publish (or update, when `remoteId` is given) a package.
 * @param {object} pkg ListingPackage
 * @param {{ platform: string, accountId: string, remoteId?: string, fileHostId?: string }} req
 * @param {(event: object) => void} [onProgress]
 * @returns {Promise<object>} the job outcome from the main process
 */
export async function publish(pkg, req, onProgress, deps) {
  const d = requireApi(deps);
  // Exactly the shape electron/listbridge/index.cjs `publish:start` reads.
  const request = {
    platform: req.platform,
    accountId: req.accountId,
    projectKey: projectKey(d),
    ...(req.remoteId ? { remoteId: req.remoteId } : {}),
    ...(req.fileHostId ? { fileHostId: req.fileHostId } : {}),
    manifest: toManifest(pkg),
    images: pkg.images.map(i => i.bytes),
    files: pkg.files.map(f => f.bytes),
  };
  const off = watchProgress(pkg, req, onProgress, d);
  let outcome;
  try {
    outcome = await d.api.start(request);
  } finally {
    if (typeof off === 'function') off();
  }
  recordOutcome(pkg, req, outcome, d);
  await acknowledge(outcome, d);
  return outcome;
}

/**
 * Retry a failed job AND persist its outcome like publish() does (the plain
 * `retry` below only returns the outcome). `pkg` + `req` are the ones the
 * failed publish() used.
 */
export async function retryPublish(jobId, pkg, req, onProgress, deps) {
  const d = requireApi(deps);
  const off = watchProgress(pkg, req, onProgress, d);
  let outcome;
  try {
    outcome = await d.api.retry(jobId);
  } finally {
    if (typeof off === 'function') off();
  }
  recordOutcome(pkg, req, outcome, d);
  await acknowledge(outcome, d);
  return outcome;
}

/**
 * Creates of this project that the main process holds and this window never recorded: a publish
 * that finished while the window reloaded or crashed, or one the app quit in the middle of (cia B-04).
 * Created listings are written to project.listings and acknowledged; the rest are returned.
 * @returns {Promise<{ adopted: object[], unresolved: object[] }>} unresolved entries carry
 *   `state: 'running'` (still publishing) or `'unknown'` (the create may have landed: check first)
 */
export async function pendingPublishes(deps) {
  const d = requireApi(deps);
  if (typeof d.api.pending !== 'function') return { adopted: [], unresolved: [] };
  const entries = await d.api.pending(projectKey(d));
  const adopted = [];
  const unresolved = [];
  for (const e of Array.isArray(entries) ? entries : []) {
    if (e.state !== 'created' || !e.remoteId) { unresolved.push(e); continue; }
    const l = e.listing ?? {};
    const pkg = {
      title: l.title ?? e.title ?? '', description: l.description ?? '', tags: l.tags ?? [], price: l.price ?? null,
      license: l.license ?? null, madeWithAi: !!l.madeWithAi, categoryHint: l.categoryHint ?? null,
      subCategoryIds: l.subCategoryIds ?? [], visibility: l.visibility ?? null, files: (l.fileNames ?? []).map(name => ({ name })),
    };
    const outcome = { jobId: e.jobId, ok: true, result: { remoteId: e.remoteId, url: e.url ?? null, status: e.status } };
    recordOutcome(pkg, { platform: e.platform, accountId: e.accountId }, outcome, d);
    await acknowledge(outcome, d);
    adopted.push(e);
  }
  return { adopted, unresolved };
}

/** Look an unsettled create up on the platform again ('check'), or drop it to publish anew ('discard'). */
export const resolvePending = async (jobId, action, deps) => requireApi(deps).api.resolvePending(jobId, action);

/**
 * Category + license lists for a platform (needs a saved account). Never throws for platform
 * trouble: resolves `{ ok:true, categories, licenses }` or `{ ok:false, message }` (the tab then
 * falls back to free-text fields).
 * @param {string} platform @param {string} [locale]
 */
export async function listOptions(platform, locale = 'en', deps) {
  const d = requireApi(deps);
  if (typeof d.api.listOptions !== 'function') return { ok: false, message: 'This build cannot load the lists.' };
  try {
    return await d.api.listOptions(platform, locale);
  } catch (err) {
    return { ok: false, message: String(err?.message || err) };
  }
}

export const retry = async (jobId, deps) => requireApi(deps).api.retry(jobId);
export const cancel = async (jobId, deps) => requireApi(deps).api.cancel(jobId);
/**
 * "Keep waiting": add `ms` (the main process caps one call at 60 min) to a temporary-link hold,
 * or to a failed job's retry window. Resolves { ok, holdRemainingMs?, linksOpenMs?, message? }.
 */
export const extendHold = async (jobId, ms, deps) => requireApi(deps).api.extendHold(jobId, ms);
