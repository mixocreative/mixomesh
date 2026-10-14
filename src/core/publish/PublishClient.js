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

function recordFor(pkg, req, outcome, status, now) {
  const r = outcome.result ?? {};
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
    remoteId: r.remoteId ?? req.remoteId ?? null,
    url: r.url ?? null,
    publishedAt: status === 'published' ? now : null,
    updatedAt: now,
    fileNames: pkg.files.map(f => f.name),
    status,
  };
}

/** Persist the outcome in project.listings (non-undoable; marks dirty). */
function recordOutcome(pkg, req, outcome, d) {
  if (!outcome) return;
  const now = d.now();
  let rec = null;
  if (outcome.ok) {
    const published = outcome.result?.status === 'published';
    rec = recordFor(pkg, req, outcome, published ? 'published' : 'draft', now);
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
    ...(req.remoteId ? { remoteId: req.remoteId } : {}),
    ...(req.fileHostId ? { fileHostId: req.fileHostId } : {}),
    manifest: toManifest(pkg),
    images: pkg.images.map(i => i.bytes),
    files: pkg.files.map(f => f.bytes),
  };
  const off = typeof onProgress === 'function' ? d.api.onProgress?.(onProgress) : null;
  let outcome;
  try {
    outcome = await d.api.start(request);
  } finally {
    if (typeof off === 'function') off();
  }
  recordOutcome(pkg, req, outcome, d);
  return outcome;
}

export const retry = async (jobId, deps) => requireApi(deps).api.retry(jobId);
export const cancel = async (jobId, deps) => requireApi(deps).api.cancel(jobId);
