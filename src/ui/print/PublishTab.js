/**
 * Print > Publish tab (PB.9, ADR 0004). Desktop only (caps.publish): the panel
 * does not even list the tab elsewhere. Three states, one module:
 *
 *   connect   no saved account  -> credential form (+ file-host choice when the
 *                                  platform takes URLs), nothing else is shown
 *   ready     connected         -> hero, listing fields, file checklist, ONE
 *                                  primary button that names platform + price
 *   publish   running / done / failed -> step checklist driven by progress
 *                                  events, Cancel, Retry, success box
 *
 * Secrets never live here: password inputs are read at click time, sent over
 * IPC, and never re-rendered. Listing text lives in a module-level form so the
 * panel's full re-render (it rebuilds on every state event) never loses a
 * half-typed title. Pure decisions are in PublishModel.js.
 *
 * "Save listing package..." (no account, no network) is also offered from the
 * Export tab on tiers without publish, via saveListingPackageFromView().
 */

import { getState } from '../../core/StateManager.js';
import { t, getLocale } from '../../i18n/index.js';
import { icon } from '../../core/Icons.js';
import { escapeHtml, escapeAttr } from '../renderSafe.js';
import { FORMAT_KEYS, effectivePrintSettings } from '../../core/print/PrintProfileSettings.js';
import { getPrinterProfile } from '../../core/print/PrinterProfiles.js';
import { findListing } from '../../core/publish/Listings.js';
import * as Publish from '../../core/publish/PublishClient.js';
import { saveListingPackage } from '../../core/publish/ListingPackageExport.js';
import { captureListingShot } from '../../core/RenderOutput.js';
import { reportError } from '../Status.js';
import { Toast } from '../Toast.js';
import { Modal } from '../Modal.js';
import { ProgressOverlay } from '../ProgressOverlay.js';
import { formatLabel } from './printLabels.js';
import * as M from './PublishModel.js';

const HERO_SIZE = 1600;
const HOST_MODE_KEY = 'mx-publish-hostmode';
const EXT_GROUP = { obj: ['obj', 'mtl', 'png', 'jpg', 'jpeg'], '3mf': ['3mf'], stl: ['stl'], ply: ['ply'], wrl: ['wrl'] };

// ---------------------------------------------------------------------------
// Module state (survives the panel's full re-render). Never holds a secret.
// ---------------------------------------------------------------------------

function _loadHostMode() {
  try { return localStorage.getItem(HOST_MODE_KEY) === 's3' ? 's3' : 'tunnel'; } catch { return 'tunnel'; }
}

const S = {
  desc: null,              // { platforms, fileHosts } from describe()
  descError: null,
  loading: false,
  platformId: null,
  connected: {},           // platform id -> bool
  s3Connected: false,
  hostMode: _loadHostMode(),   // 'tunnel' (default, no fields) | 's3'
  editingConn: false,
  connBusy: false,
  connMsg: null,           // { ok, text }
  form: null,
  formKey: null,
  tagDraft: '',
  hero: null,              // { blob, url, transparent }
  gallery: [],             // [{ blob, url }]
  transparent: false,
  capturing: false,
  heroTried: false,
  formats: null,           // Set of format keys (null = follow the Export tab's format)
  built: [],               // [{ name, size }] from the last build
  phase: 'form',           // form | publishing | done | failed
  steps: [],
  jobId: null,
  outcome: null,
  lastPkg: null,
  lastReq: null,
  blocked: null,           // build refused by the export gate
  note: null,              // one-line notice on the form (cancelled, invalid...)
  cancelRequested: false,
  hold: null,              // { served, total, remainingMs } while the platform downloads from the temporary link
  linksOpen: null,         // { ms, at } after a confirm failure while the links stay open
  extending: false,        // a Keep waiting request is in flight
  options: {},             // platform id -> { status:'loading'|'ok'|'failed', categories, licenses, message } (publish:listOptions)
  pending: [],             // unsettled creates of this project held by the main process (publish:pending)
  pendingFor: undefined,   // project id the pending list belongs to (undefined = not checked yet)
  pendingBusy: false,
};

const _api = () => (typeof window !== 'undefined' ? window.electronAPI?.listbridge : undefined);
const _platform = () => S.desc?.platforms?.find(p => p.id === S.platformId) ?? null;
const _needsHost = d => d?.transfer === 'url';
const _s3Spec = () => S.desc?.fileHosts?.find(h => h.type === 's3') ?? null;

/** Test seam: drop all module state. */
export function _resetPublishTabState() {
  for (const g of S.gallery) URL.revokeObjectURL(g.url);
  if (S.hero) URL.revokeObjectURL(S.hero.url);
  Object.assign(S, {
    desc: null, descError: null, loading: false, platformId: null, connected: {}, s3Connected: false,
    editingConn: false, connBusy: false, connMsg: null, form: null, formKey: null, tagDraft: '',
    hero: null, gallery: [], transparent: false, capturing: false, heroTried: false, formats: null,
    built: [], phase: 'form', steps: [], jobId: null, outcome: null, lastPkg: null, lastReq: null,
    blocked: null, note: null, cancelRequested: false, hold: null, linksOpen: null, extending: false, options: {},
    pending: [], pendingFor: undefined, pendingBusy: false,
  });
  _guardUnload(false);
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

async function _hydrate(refresh) {
  const api = _api();
  if (!api || S.loading || S.desc || S.descError) return;
  S.loading = true;
  try {
    const desc = await api.describe();
    S.desc = desc;
    S.platformId = desc.platforms?.[0]?.id ?? null;
    for (const p of desc.platforms ?? []) {
      S.connected[p.id] = (p.credentials?.length ?? 0) === 0 ? true : await api.hasCredentials(M.platformCredentialId(p.id));
    }
    if (_s3Spec()) S.s3Connected = await api.hasCredentials(M.fileHostCredentialId(M.S3_HOST_ID)).catch(() => false);
  } catch (err) {
    S.descError = err?.message ? String(err.message) : String(err);
  } finally {
    S.loading = false;
  }
  refresh();
}

// A publish that finished (or died) while this window was gone: record it, or show what is unsettled.
async function _checkPending(refresh) {
  if (S.pendingBusy) return;
  S.pendingBusy = true;
  S.pendingFor = getState().project?.id ?? null;
  try {
    const { adopted, unresolved } = await Publish.pendingPublishes();
    S.pending = unresolved;
    if (adopted.length) {
      S.form = null;
      S.note = t('publish.pending.adopted', { label: S.desc?.platforms?.find(p => p.id === adopted[0].platform)?.label ?? adopted[0].platform });
    }
    S.pendingFor = getState().project?.id ?? null;
  } catch (err) {
    S.pending = [];
    reportError(err, { title: t('publish.pending.checkFailed') });
  } finally {
    S.pendingBusy = false;
  }
  refresh();
}

async function _resolvePending(jobId, action, desc, refresh) {
  if (S.pendingBusy) return;
  S.pendingBusy = true;
  refresh();
  try {
    await Publish.resolvePending(jobId, action);
  } catch (err) {
    reportError(err, { title: t('publish.pending.checkFailed') });
  } finally {
    S.pendingBusy = false;
  }
  await _checkPending(refresh);
  if (action === 'discard' && !S.pending.length) _publish(desc, refresh);
}

// Category + license lists, loaded once per connected platform (and again on Reload / reconnect).
// A failure leaves the free-text fields in place with a note: publishing is never blocked by it.
async function _loadOptions(desc, refresh) {
  const cur = S.options[desc.id];
  if (!desc?.listOptions || cur) return;
  S.options[desc.id] = { status: 'loading' };
  try {
    const res = await Publish.listOptions(desc.id, getLocale());
    S.options[desc.id] = res?.ok
      ? { status: 'ok', categories: res.categories ?? [], licenses: res.licenses ?? [] }
      : { status: 'failed', message: String(res?.message ?? '') };
  } catch (err) {
    S.options[desc.id] = { status: 'failed', message: err?.message ? String(err.message) : String(err) };
  }
  refresh();
}

function _currentFormats() {
  if (S.formats) return [...S.formats];
  const eff = effectivePrintSettings(getState().print ?? {}, getPrinterProfile(getState().print?.targetPrinterId));
  return [eff.exportFormat];
}

function _ensureForm(desc) {
  const key = desc ? `${desc.id}` : '';
  if (S.form && S.formKey === key) return S.form;
  const rec = desc ? findListing(getState().project?.listings, desc.id, M.ACCOUNT_ID) : null;
  const name = getState().project?.name;
  S.form = M.formFromRecord(rec, {
    title: name && name !== 'Untitled' ? name : '',
    currency: desc?.currencies?.[0] ?? 'EUR',
  });
  S.formKey = key;
  S.tagDraft = '';
  return S.form;
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

async function _captureShot(background) {
  return captureListingShot({ size: HERO_SIZE, background });
}

async function _captureHero(refresh) {
  if (S.capturing) return;
  S.capturing = true; S.heroTried = true;
  refresh();
  try {
    const blob = await _captureShot(S.transparent ? 'transparent' : 'studio');
    if (S.hero) URL.revokeObjectURL(S.hero.url);
    S.hero = { blob, url: URL.createObjectURL(blob), transparent: S.transparent };
  } catch (err) {
    reportError(err, { title: t('publish.captureFailed') });
  } finally {
    S.capturing = false;
    refresh();
  }
}

async function _addGalleryShot(refresh, max) {
  if (S.capturing || S.gallery.length >= max) return;
  S.capturing = true;
  refresh();
  try {
    const blob = await _captureShot('studio');
    S.gallery.push({ blob, url: URL.createObjectURL(blob) });
  } catch (err) {
    reportError(err, { title: t('publish.captureFailed') });
  } finally {
    S.capturing = false;
    refresh();
  }
}

// ---------------------------------------------------------------------------
// Save listing package (works on every tier; also used by the Export tab)
// ---------------------------------------------------------------------------

/**
 * Build the package from the current view + current Export format and save it
 * through the storage adapter. Captures a hero automatically when none exists.
 * @param {{ onDone?: () => void }} [opts]
 */
export async function saveListingPackageFromView({ onDone } = {}) {
  ProgressOverlay.show(t('publish.overlay.building'));
  try {
    let heroBlob = S.hero?.blob;
    if (!heroBlob) heroBlob = await _captureShot('studio');
    const name = getState().project?.name;
    const form = S.form ?? M.emptyForm(name && name !== 'Untitled' ? name : t('publish.defaultTitle'));
    const listing = M.formToListing(form, { locale: getLocale() });
    if (!listing.description.trim()) listing.description = listing.title;
    const print = getState().print ?? {};
    const res = await Publish.buildListingPackage({
      listing,
      exportSelection: { formats: _currentFormats(), options: { individually: !!print.individually } },
      heroBlob,
      galleryBlobs: S.gallery.map(g => g.blob),
    });
    if (res.blocked) {
      ProgressOverlay.hide();
      reportError(new Error(t('print.readiness.blockedHint')), { title: t('print.readiness.blocked'), modal: true });
      return;
    }
    S.built = res.pkg.files.map(f => ({ name: f.name, size: f.bytes.byteLength }));
    ProgressOverlay.hide();
    const saved = await saveListingPackage(res.pkg);
    if (saved !== false) Toast.show(t('publish.toast.packageSaved'), 'success');
  } catch (err) {
    reportError(err, { title: t('publish.packageFailed'), modal: true });
  } finally {
    ProgressOverlay.hide();
    onDone?.();
  }
}

// ---------------------------------------------------------------------------
// Publishing
// ---------------------------------------------------------------------------

function _remoteId(desc) {
  return findListing(getState().project?.listings, desc.id, M.ACCOUNT_ID)?.remoteId ?? null;
}

function _request(desc) {
  const remoteId = _remoteId(desc);
  return {
    platform: desc.id,
    accountId: M.ACCOUNT_ID,
    ...(remoteId ? { remoteId } : {}),
    ...(_needsHost(desc) ? { fileHostId: S.hostMode === 's3' ? M.S3_HOST_ID : M.TUNNEL_HOST_ID } : {}),
  };
}

function _onProgress(refresh) {
  return ev => {
    if (ev?.jobId) S.jobId = ev.jobId;
    S.steps = M.applyProgress(S.steps, ev);
    S.hold = M.nextHold(S.hold, ev);
    const open = M.linksOpenFromEvent(ev, Date.now());
    if (open) S.linksOpen = open; else if (ev?.status === 'running') S.linksOpen = null;
    refresh();
  };
}

// A running publish must survive an accidental reload: the renderer dies on reload but the job
// keeps running in the main process, so ask first (main.cjs words the Electron prompt).
const _unloadGuard = e => { e.preventDefault(); e.returnValue = ''; };
let _guarding = false;
function _guardUnload(on) {
  if (typeof window === 'undefined' || on === _guarding) return;
  _guarding = on;
  if (on) window.addEventListener('beforeunload', _unloadGuard);
  else window.removeEventListener('beforeunload', _unloadGuard);
}

/** "Keep waiting": +15 min on the running hold, or on the failed job's open links. */
async function _keepWaiting(refresh) {
  if (!S.jobId || S.extending) return;
  S.extending = true;
  refresh();
  try {
    const r = await Publish.extendHold(S.jobId, M.KEEP_WAITING_MS);
    if (!r?.ok) throw new Error(String(r?.message ?? t('publish.hold.notWaiting')));
    if (r.holdRemainingMs != null && S.hold) S.hold = { ...S.hold, remainingMs: r.holdRemainingMs };
    if (r.linksOpenMs != null) S.linksOpen = { ms: r.linksOpenMs, at: Date.now() };
  } catch (err) {
    reportError(err, { title: t('publish.hold.extendFailed') });
  } finally {
    S.extending = false;
    refresh();
  }
}

function _settle(outcome, refresh) {
  S.outcome = outcome;
  S.pendingFor = undefined;   // the form re-reads what the main process still holds for this project
  S.hold = null;
  if (outcome?.ok || outcome?.status === 'cancelled' || outcome?.status === 'invalid') S.linksOpen = null;
  if (outcome?.ok) {
    S.phase = 'done'; S.lastPkg = null;
  } else if (outcome?.status === 'cancelled') {
    S.phase = 'form'; S.lastPkg = null; S.jobId = null;
    S.note = outcome.leftover?.length ? t('publish.note.cancelledLeftover', { n: outcome.leftover.length }) : t('publish.note.cancelled');
  } else if (outcome?.status === 'invalid') {
    S.phase = 'form'; S.jobId = null;
    S.note = (outcome.issues ?? []).map(i => i.message).join(' ');
  } else if (outcome?.status === 'pending') {
    S.phase = 'form'; S.jobId = null; S.lastPkg = null;
    S.pending = outcome.pending ?? [];
    S.pendingFor = getState().project?.id ?? null;
  } else {
    S.phase = 'failed';
  }
  _guardUnload(S.phase === 'publishing');
  refresh();
}

async function _publish(desc, refresh, { acknowledgeWarnings = false } = {}) {
  const form = S.form;
  const isUpdate = !!_remoteId(desc);
  S.phase = 'publishing'; S.steps = M.initialSteps(isUpdate); S.jobId = null; S.outcome = null;
  S.blocked = null; S.note = null; S.cancelRequested = false; S.hold = null; S.linksOpen = null;
  _guardUnload(true);
  S.steps = M.applyProgress(S.steps, { step: 'build', status: 'running' });
  refresh('#pub-status');
  try {
    const print = getState().print ?? {};
    const res = await Publish.buildListingPackage({
      listing: M.formToListing(form, { locale: getLocale() }),
      exportSelection: { formats: _currentFormats(), options: { individually: !!print.individually, acknowledgeWarnings } },
      heroBlob: S.hero?.blob,
      galleryBlobs: S.gallery.map(g => g.blob),
    });
    if (res.blocked) {
      S.phase = 'form'; S.blocked = res;
      _guardUnload(false);
      refresh();
      return;
    }
    S.built = res.pkg.files.map(f => ({ name: f.name, size: f.bytes.byteLength }));
    S.steps = M.applyProgress(S.steps, { step: 'build', status: 'done', message: String(res.pkg.files.length) });
    if (S.cancelRequested) {
      S.phase = 'form'; S.note = t('publish.note.cancelled');
      _guardUnload(false);
      refresh();
      return;
    }
    S.lastPkg = res.pkg;
    S.lastReq = _request(desc);
    refresh();
    _settle(await Publish.publish(res.pkg, S.lastReq, _onProgress(refresh)), refresh);
  } catch (err) {
    S.phase = 'failed'; S.hold = null;
    _guardUnload(false);
    S.outcome = { ok: false, error: err?.message ? String(err.message) : String(err) };
    refresh('#pub-status');
  }
}

async function _retry(desc, refresh) {
  if (!S.jobId || !S.lastPkg) return _publish(desc, refresh);
  S.phase = 'publishing'; S.linksOpen = null; S.hold = null;
  _guardUnload(true);
  S.steps = S.steps.map(s => (s.status === 'failed' ? { ...s, status: 'todo' } : s));
  refresh('#pub-status');
  try {
    _settle(await Publish.retryPublish(S.jobId, S.lastPkg, S.lastReq, _onProgress(refresh)), refresh);
  } catch (err) {
    S.phase = 'failed'; S.hold = null;
    _guardUnload(false);
    S.outcome = { ...S.outcome, ok: false, error: err?.message ? String(err.message) : String(err) };
    refresh('#pub-status');
  }
}

// Only after the seller checked the platform: a listing made by the lost request would be duplicated.
function _confirmPublishNew(desc, refresh) {
  Modal.register('publishNewListing', ({ data, close }) => {
    const el = document.createElement('div');
    el.className = 'pm-modal';
    el.innerHTML = `<p class="pm-modal-body">${escapeHtml(t('publish.unknown.confirmNew', data))}</p>
      <div class="pm-modal-actions">
        <button class="btn" data-r="cancel">${escapeHtml(t('publish.cancel'))}</button>
        <button class="btn btn-primary" data-r="new">${escapeHtml(t('publish.unknown.publishNew', data))}</button>
      </div>`;
    el.querySelectorAll('[data-r]').forEach(b => b.addEventListener('click', () => close(b.dataset.r)));
    return el;
  });
  Modal.open('publishNewListing', {
    label: desc.label, title: S.lastPkg?.title ?? S.form?.title ?? '',
    onClose: r => {
      if (r !== 'new') return;
      const jobId = S.jobId;
      if (jobId) void _resolvePending(jobId, 'discard', desc, refresh);
      else _publish(desc, refresh);
    },
  });
}

async function _cancel(refresh) {
  S.cancelRequested = true;
  if (!S.jobId) { refresh(); return; }
  try {
    _settle(await Publish.cancel(S.jobId), refresh);
  } catch (err) {
    S.outcome = { ok: false, error: err?.message ? String(err.message) : String(err) };
    S.phase = 'failed'; S.hold = null;
    _guardUnload(false);
    refresh('#pub-status');
  }
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

const _val = (root, name) => /** @type {HTMLInputElement|null} */ (root.querySelector(`[data-cred="${name}"]`))?.value ?? '';

async function _connect(root, desc, refresh) {
  const api = _api();
  if (!api || S.connBusy) return;
  const required = desc.credentials ?? [];
  const values = Object.fromEntries(required.map(k => [k, _val(root, k)]));
  const { secret, missing } = M.collectCredentials(values, required);
  const platformBlank = required.every(k => !String(values[k]).trim());
  const skipPlatform = S.editingConn && S.connected[desc.id] && platformBlank;
  if (!skipPlatform && missing.length) {
    S.connMsg = { ok: false, text: t('publish.connect.missing', { fields: missing.map(_fieldLabel).join(', ') }) };
    refresh();
    return;
  }
  let hostSecret = null;
  if (_needsHost(desc) && S.hostMode === 's3') {
    const spec = _s3Spec();
    const hv = Object.fromEntries([...(spec?.credentials ?? []), ...(spec?.optional ?? [])].map(k => [k, _val(root, `host.${k}`)]));
    const hostBlank = (spec?.credentials ?? []).every(k => !String(hv[k]).trim());
    if (!(S.editingConn && S.s3Connected && hostBlank)) {
      const c = M.collectCredentials(hv, spec?.credentials ?? [], spec?.optional ?? []);
      if (c.missing.length) {
        S.connMsg = { ok: false, text: t('publish.connect.missing', { fields: c.missing.map(_fieldLabel).join(', ') }) };
        refresh();
        return;
      }
      hostSecret = { type: 's3', ...c.secret };
    }
  }
  S.connBusy = true; S.connMsg = { ok: true, text: t('publish.connect.testing') };
  refresh('#pub-conn-msg');
  try {
    if (!skipPlatform) await api.setCredentials(M.platformCredentialId(desc.id), secret);
    if (hostSecret) await api.setCredentials(M.fileHostCredentialId(M.S3_HOST_ID), hostSecret);
    const results = [];
    if (!skipPlatform && desc.testConnection) results.push({ id: M.platformCredentialId(desc.id), res: await api.testConnection(M.platformCredentialId(desc.id)) });
    if (hostSecret) results.push({ id: M.fileHostCredentialId(M.S3_HOST_ID), res: await api.testConnection(M.fileHostCredentialId(M.S3_HOST_ID)) });
    const bad = results.find(r => !r.res?.ok);
    if (bad) {
      await api.clearCredentials(bad.id).catch(() => {});
      if (bad.id.startsWith('filehost:')) S.s3Connected = false; else S.connected[desc.id] = false;
      S.connMsg = { ok: false, text: String(bad.res?.message ?? t('publish.connect.failed')) };
    } else {
      S.connected[desc.id] = true;
      delete S.options[desc.id];
      if (hostSecret) S.s3Connected = true;
      S.editingConn = false;
      S.connMsg = null;
    }
  } catch (err) {
    S.connMsg = { ok: false, text: err?.message ? String(err.message) : String(err) };
  } finally {
    S.connBusy = false;
  }
  refresh(S.connected[desc.id] ? '#pub-acct' : '#pub-conn-msg');
}

async function _testSaved(desc, refresh) {
  const api = _api();
  if (!api || S.connBusy) return;
  S.connBusy = true; S.connMsg = { ok: true, text: t('publish.connect.testing') };
  refresh('#pub-conn-msg');
  try {
    const res = desc.testConnection ? await api.testConnection(M.platformCredentialId(desc.id)) : { ok: true, message: '' };
    S.connMsg = { ok: !!res.ok, text: String(res.message || (res.ok ? t('publish.connect.ok') : t('publish.connect.failed'))) };
  } catch (err) {
    S.connMsg = { ok: false, text: err?.message ? String(err.message) : String(err) };
  } finally {
    S.connBusy = false;
  }
  refresh('#pub-conn-msg');
}

async function _disconnect(desc, refresh) {
  try { await _api()?.clearCredentials(M.platformCredentialId(desc.id)); } catch { /* shown as still connected */ }
  S.connected[desc.id] = await _api()?.hasCredentials(M.platformCredentialId(desc.id)).catch(() => true);
  delete S.options[desc.id];
  S.connMsg = null;
  refresh('#pub-status');
}

// ---------------------------------------------------------------------------
// Markup
// ---------------------------------------------------------------------------

function _fieldLabel(name) {
  const key = M.credentialFieldKey(name);
  return key ? t(key) : M.humanizeField(name);
}

function _row(id, label, control) {
  return `<div class="pp-row pub-row"><label for="${id}">${escapeHtml(label)}</label>${control}</div>`;
}

function _credFields(names, prefix, optional = false) {
  return names.map(name => {
    const id = `pub-cred-${prefix}${name}`;
    const secret = M.isSecretField(name);
    let control;
    if (name === 'style') {
      control = `<select id="${id}" class="pp-preset-select" data-cred="${escapeAttr(prefix + name)}"><option value="">${escapeHtml(t('publish.s3.style.path'))}</option><option value="virtual">${escapeHtml(t('publish.s3.style.virtual'))}</option></select>`;
    } else {
      control = `<input id="${id}" class="pp-preset-select" type="${secret ? 'password' : 'text'}" data-cred="${escapeAttr(prefix + name)}" autocomplete="off" spellcheck="false"${secret ? ' autocapitalize="off"' : ''}>`;
    }
    return _row(id, _fieldLabel(name) + (optional ? ` (${t('publish.optional')})` : ''), control);
  }).join('');
}

function _connectHtml(desc) {
  const editing = S.editingConn && S.connected[desc.id];
  let h = '<div class="pub-box pub-connect">';
  h += `<p class="pp-help">${escapeHtml(t(_needsHost(desc) ? 'publish.connect.introHost' : 'publish.connect.intro', { label: desc.label }))}</p>`;
  h += _credFields(desc.credentials ?? [], '');
  if (editing) h += `<p class="pp-help">${escapeHtml(t('publish.connect.blankKeeps'))}</p>`;
  if (_needsHost(desc)) {
    h += `<div class="pub-sub" id="pub-host-label">${escapeHtml(t('publish.host.title'))}</div>`;
    h += '<div role="radiogroup" aria-labelledby="pub-host-label" class="pub-radios">';
    h += `<label class="pub-radio"><input type="radio" name="pub-host" value="tunnel"${S.hostMode === 'tunnel' ? ' checked' : ''}> <span>${escapeHtml(t('publish.host.auto'))}</span></label>`;
    h += `<span class="pp-help pub-radio-help">${escapeHtml(t('publish.host.autoHelp'))}</span>`;
    h += `<label class="pub-radio"><input type="radio" name="pub-host" value="s3"${S.hostMode === 's3' ? ' checked' : ''}> <span>${escapeHtml(t('publish.host.s3'))}</span></label>`;
    h += '</div>';
    if (S.hostMode === 's3') {
      const spec = _s3Spec();
      h += `<div class="pub-s3">${_credFields(spec?.credentials ?? [], 'host.')}${_credFields(spec?.optional ?? [], 'host.', true)}</div>`;
      if (S.s3Connected) h += `<p class="pp-help">${escapeHtml(t('publish.host.s3Saved'))}</p>`;
    }
  }
  h += '<div class="pub-btns">';
  h += `<button type="button" class="pp-primary-btn pub-inline" data-act="connect"${S.connBusy ? ' disabled' : ''}>${escapeHtml(t('publish.connect.button'))}</button>`;
  if (editing) h += `<button type="button" class="pub-btn" data-act="connect-cancel">${escapeHtml(t('publish.cancel'))}</button>`;
  h += '</div>';
  h += `<p class="pub-msg" id="pub-conn-msg" role="status" aria-live="polite"></p>`;
  if (desc.id === 'cults3d') h += `<p class="pp-help">${escapeHtml(t('publish.connect.keyHintCults'))}</p>`;
  h += '</div>';
  return h;
}

function _acctHtml(desc, connected) {
  let h = `<div class="pub-acct" id="pub-acct" tabindex="-1"><span class="pub-dot${connected ? '' : ' off'}" aria-hidden="true"></span>`;
  h += `<span class="pub-acct-name">${escapeHtml(desc.label)} · ${escapeHtml(connected ? t('publish.connected') : t('publish.notConnected'))}</span>`;
  if (connected && S.phase === 'form') {
    h += '<span class="pub-acct-actions">';
    if ((desc.credentials?.length ?? 0) > 0 || _needsHost(desc)) {
      h += `<button type="button" class="pp-link-btn" data-act="change-conn">${escapeHtml(t('publish.change'))}</button>`;
      h += `<button type="button" class="pp-link-btn" data-act="disconnect">${escapeHtml(t('publish.disconnect'))}</button>`;
    }
    h += '</span>';
  }
  h += '</div>';
  if (connected && S.phase === 'form' && desc.testConnection) {
    h += `<div class="pub-btns"><button type="button" class="pub-btn" data-act="test-conn"${S.connBusy ? ' disabled' : ''}>${escapeHtml(t('publish.test'))}</button></div>`;
    h += `<p class="pub-msg" id="pub-conn-msg" role="status" aria-live="polite"></p>`;
  }
  if (connected && _needsHost(desc) && S.phase === 'form') {
    h += `<p class="pp-help">${escapeHtml(t('publish.host.summary', { host: S.hostMode === 's3' ? t('publish.host.s3Short') : t('publish.host.autoShort') }))}</p>`;
  }
  return h;
}

function _stepsHtml(desc) {
  let h = `<div class="pub-prog" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(M.progressFraction(S.steps) * 100)}"><i style="width:${Math.round(M.progressFraction(S.steps) * 100)}%"></i></div>`;
  h += '<ol class="pub-steps">';
  for (const s of S.steps) {
    const mark = s.status === 'done' ? '✓' : s.status === 'run' ? '●' : s.status === 'failed' ? '!' : s.status === 'skipped' ? '–' : '○';
    const key = M.stepLabelKey(s.id, { direct: desc?.transfer === 'direct' });
    const hint = s.id === 'build' && s.status === 'done' ? (s.message ?? '')
      : s.id === 'host' && s.status === 'run' && s.phase === 'upload' && s.total ? `${s.done ?? 0}/${s.total}`
        : s.id === 'host' && s.status === 'run' && s.phase ? t('publish.host.reachable') : '';
    h += `<li class="pub-step ${s.status}"><span class="pub-step-i" aria-hidden="true">${mark}</span>`
      + `<span>${escapeHtml(key ? t(key, { label: desc?.label ?? '' }) : s.id)}${s.status === 'skipped' ? ` <span class="pub-hint">(${escapeHtml(t('publish.step.skipped'))})</span>` : ''}</span>`
      + `<span class="pub-hint pp-num">${escapeHtml(hint)}</span></li>`;
  }
  h += '</ol>';
  return h;
}

function _runHtml(desc) {
  let h = `<div id="pub-status" tabindex="-1" class="pub-status" role="status" aria-live="polite">`;
  if (S.phase === 'publishing') {
    h += `<p class="pub-title">${escapeHtml(t('publish.running', { label: desc.label }))}</p>${_stepsHtml(desc)}`;
    if (S.hold) {
      const ht = M.holdText(S.hold, desc.label);
      h += `<p class="pub-hold" role="status">${escapeHtml(t(ht.key, ht.params))}</p>`;
      h += `<div class="pub-btns"><button type="button" class="pub-btn" data-act="keep-waiting"${S.extending ? ' disabled' : ''}>${escapeHtml(t('publish.hold.keepWaiting'))}</button></div>`;
    }
    h += `<div class="pub-btns"><button type="button" class="pub-btn" data-act="cancel-run"${S.cancelRequested && !S.jobId ? ' disabled' : ''}>${escapeHtml(t('publish.cancel'))}</button></div>`;
  } else if (S.phase === 'done') {
    const res = S.outcome?.result ?? {};
    h += _stepsHtml(desc);
    h += `<div class="pub-ok"><b>${icon('CheckCircle', { width: 13, height: 13 })} ${escapeHtml(t(res.status === 'published' ? 'publish.done.live' : res.status === 'secret' ? 'publish.done.secret' : 'publish.done.draft', { label: desc.label }))}</b>`;
    if (res.url) {
      h += `<span class="pub-url"><input class="pp-preset-select pp-num" id="pub-url" type="text" readonly value="${escapeAttr(res.url)}" aria-label="${escapeAttr(t('publish.done.linkAria'))}">`
        + `<button type="button" class="pub-btn" data-act="copy-url">${icon('Copy', { width: 12, height: 12 })} ${escapeHtml(t('publish.copy'))}</button></span>`;
    }
    h += `<span class="pub-hint">${escapeHtml(t('publish.done.saved'))}</span></div>`;
    h += `<div class="pub-btns"><button type="button" class="pub-btn" data-act="back">${escapeHtml(t('publish.done.back'))}</button></div>`;
  } else if (S.phase === 'failed') {
    const o = S.outcome ?? {};
    const failed = S.steps.find(s => s.status === 'failed');
    h += _stepsHtml(desc);
    h += '<div class="pub-fail pub-job-fail" role="alert">';
    const view = M.failureView(o);
    const title = S.lastPkg?.title ?? S.form?.title ?? '';
    const errKey = M.errorKey(o.code);
    const errMsg = errKey ? t(errKey, { label: desc.label, title }) : (o.error ?? t('publish.failed.unknown'));
    const platformMsg = (o.code === 'platform-rejected' || o.code === 'platform-http') && o.error ? ` ${escapeHtml(o.error)}` : '';
    h += `<p><b>${escapeHtml(failed ? t('publish.failed.step', { step: t(M.stepLabelKey(failed.id, { direct: desc.transfer === 'direct' }) ?? 'publish.step.build', { label: desc.label }) }) : t('publish.failed.generic'))}</b> — ${escapeHtml(errMsg)}${platformMsg}</p>`;
    if (o.leftover?.length) h += `<p class="pub-hint">${escapeHtml(t('publish.note.cancelledLeftover', { n: o.leftover.length }))}</p>`;
    h += `<p class="pub-hint">${escapeHtml(t(view.hintKey, { label: desc.label, title }))}</p>`;
    const openLeft = failed?.id === 'confirm' ? M.linksOpenLeft(S.linksOpen, Date.now()) : 0;
    if (openLeft > 0) h += `<p class="pub-hint pub-links-open">${escapeHtml(t('publish.hold.linksOpen', { min: M.minutesLeft(openLeft) }))}</p>`;
    h += `<div class="pub-btns"><button type="button" class="pp-primary-btn pub-inline" data-act="retry">${escapeHtml(t(view.retryKey, { label: desc.label }))}</button>`
      + (view.publishNew ? `<button type="button" class="pub-btn" data-act="publish-new">${escapeHtml(t('publish.unknown.publishNew', { label: desc.label }))}</button>` : '')
      + (openLeft > 0 ? `<button type="button" class="pub-btn" data-act="keep-waiting"${S.extending ? ' disabled' : ''}>${escapeHtml(t('publish.hold.keepWaiting'))}</button>` : '')
      + `<button type="button" class="pub-btn" data-act="cancel-clean">${escapeHtml(t('publish.cancelClean'))}</button></div></div>`;
  }
  return `${h}</div>`;
}

function _pendingHtml(desc) {
  let h = '';
  for (const p of S.pending) {
    const title = p.title || p.listing?.title || '';
    const busy = S.pendingBusy ? ' disabled' : '';
    h += '<div class="pub-fail pub-pending" role="alert">';
    if (p.running) {
      h += `<p>${escapeHtml(t('publish.pending.running', { label: desc.label, title }))}</p>`
        + `<div class="pub-btns"><button type="button" class="pub-btn" data-act="pending-refresh"${busy}>${escapeHtml(t('publish.pending.refresh'))}</button></div>`;
    } else {
      h += `<p>${escapeHtml(t('publish.err.createUnknown', { label: desc.label, title }))}</p>`
        + `<p class="pub-hint">${escapeHtml(t('publish.unknown.howTo', { label: desc.label, title }))}</p>`
        + `<div class="pub-btns"><button type="button" class="pp-primary-btn pub-inline" data-act="pending-check" data-job="${escapeAttr(p.jobId)}"${busy}>${escapeHtml(t('publish.unknown.check', { label: desc.label }))}</button>`
        + `<button type="button" class="pub-btn" data-act="pending-new" data-job="${escapeAttr(p.jobId)}"${busy}>${escapeHtml(t('publish.unknown.publishNew', { label: desc.label }))}</button></div>`;
    }
    h += '</div>';
  }
  return h;
}

function _filesHtml(readiness, building) {
  const formats = new Set(_currentFormats());
  const sizes = Math.max(1, readiness?.targets?.length ?? 1);
  let h = `<div class="pub-sub">${escapeHtml(t('publish.files.title'))} <span class="pub-sub-aside">· ${escapeHtml(t('publish.files.fromExport'))}</span></div>`;
  h += `<fieldset class="pub-files"${building ? ' disabled' : ''}><legend class="pub-sr">${escapeHtml(t('publish.files.title'))}</legend>`;
  for (const key of FORMAT_KEYS) {
    const exts = EXT_GROUP[key] ?? [key];
    const mine = S.built.filter(f => exts.includes(f.name.split('.').pop().toLowerCase()));
    const size = mine.length ? M.formatBytes(mine.reduce((n, f) => n + f.size, 0)) : '—';
    h += `<label class="pub-file"><input type="checkbox" data-fmt-pick="${escapeAttr(key)}"${formats.has(key) ? ' checked' : ''}>`
      + `<span class="pub-file-name pp-num">${escapeHtml(formatLabel(key))}</span>`
      + `<span class="pub-hint">${escapeHtml(t('publish.files.perSize', { n: sizes }))}</span>`
      + `<span class="pub-file-size pp-num">${escapeHtml(size)}</span></label>`;
  }
  return `${h}</fieldset>`;
}

function _galleryHtml(max) {
  let h = '<div class="pub-thumbs">';
  S.gallery.forEach((g, i) => {
    h += `<span class="pub-thumb"><img src="${escapeAttr(g.url)}" alt="${escapeAttr(t('publish.gallery.alt', { n: i + 1 }))}">`
      + `<button type="button" class="pub-thumb-x" data-act="rm-shot" data-i="${i}" aria-label="${escapeAttr(t('publish.gallery.remove', { n: i + 1 }))}">×</button></span>`;
  });
  if (S.gallery.length < max) {
    h += `<button type="button" class="pub-thumb pub-thumb-add" data-act="add-shot" aria-label="${escapeAttr(t('publish.gallery.add'))}" title="${escapeAttr(t('publish.gallery.add'))}"${S.capturing ? ' disabled' : ''}>${icon('Plus', { width: 14, height: 14 })}</button>`;
  }
  return `${h}</div>`;
}

function _optionsOrText(id, list, value) {
  if (Array.isArray(list) && list.length) {
    const opts = list.map(o => (typeof o === 'string' ? { id: o, label: o } : o));
    return `<select id="${id}" class="pp-preset-select"><option value="">—</option>`
      + opts.map(o => `<option value="${escapeAttr(o.id)}"${o.id === value ? ' selected' : ''}>${escapeHtml(o.label ?? o.id)}</option>`).join('') + '</select>';
  }
  return `<input id="${id}" class="pp-preset-select" type="text" value="${escapeAttr(value)}" autocomplete="off">`;
}

function _formHtml(desc, readiness) {
  const f = _ensureForm(desc);
  const rec = findListing(getState().project?.listings, desc.id, M.ACCOUNT_ID);
  const max = Math.max(0, (desc.maxImages ?? 10) - 1);
  let h = '';
  if (rec?.remoteId && rec.url) {
    h += `<div class="pub-live"><b>${escapeHtml(t(rec.visibility === 'secret' ? 'publish.live.secret' : 'publish.live.on', { label: desc.label }))}</b>`
      + `<span class="pub-url"><input class="pp-preset-select pp-num" type="text" readonly value="${escapeAttr(rec.url)}" aria-label="${escapeAttr(t('publish.done.linkAria'))}"><button type="button" class="pub-btn" data-act="copy-live">${icon('Copy', { width: 12, height: 12 })} ${escapeHtml(t('publish.copy'))}</button></span>`
      + `<span class="pub-hint">${escapeHtml(t('publish.live.again'))}</span></div>`;
  }
  if (S.note) h += `<p class="pub-note" role="status">${escapeHtml(S.note)}</p>`;
  h += _pendingHtml(desc);
  if (S.blocked) {
    h += `<div class="pub-fail pub-gate" role="alert"><p>${escapeHtml(t(S.blocked.code === 'EXPORT_NEEDS_ACKNOWLEDGEMENT' ? 'publish.blocked.warnings' : 'publish.blocked.errors'))}</p>`;
    if (S.blocked.code === 'EXPORT_NEEDS_ACKNOWLEDGEMENT') h += `<div class="pub-btns"><button type="button" class="pub-btn" data-act="publish-anyway">${escapeHtml(t('publish.blocked.anyway'))}</button></div>`;
    h += '</div>';
  }
  // hero
  h += '<div class="pub-hero-wrap">';
  if (S.hero) {
    h += `<div class="pub-hero${S.hero.transparent ? ' transparent' : ''}"><img src="${escapeAttr(S.hero.url)}" alt="${escapeAttr(t('publish.hero.alt'))}">`
      + `<span class="pub-cap pp-num">${HERO_SIZE} × ${HERO_SIZE} · ${escapeHtml(S.hero.transparent ? t('publish.hero.transparent') : t('publish.hero.studio'))}</span></div>`;
  } else {
    h += `<div class="pub-hero pub-hero-empty" role="status">${escapeHtml(S.capturing ? t('publish.hero.capturing') : t('publish.hero.none'))}</div>`;
  }
  h += '</div>';
  h += '<div class="pub-btns">'
    + `<button type="button" class="pub-btn" data-act="retake"${S.capturing ? ' disabled' : ''}>${icon('Camera', { width: 12, height: 12 })} ${escapeHtml(t('publish.hero.retake'))}</button>`
    + `<button type="button" class="pp-toggle${S.transparent ? ' pp-toggle-on' : ''}" data-act="transparent" aria-pressed="${S.transparent}"><span class="pp-toggle-dot" aria-hidden="true"></span>${escapeHtml(t('publish.hero.transparent'))}</button></div>`;
  h += _galleryHtml(max);
  // fields
  h += _row('pub-title', t('publish.field.title'), `<input id="pub-title" class="pp-preset-select" type="text" value="${escapeAttr(f.title)}" autocomplete="off">`);
  h += _row('pub-desc', t('publish.field.description'), `<textarea id="pub-desc" class="pp-preset-select pub-area" rows="4">${escapeHtml(f.description)}</textarea>`);
  h += _row('pub-tag-input', t('publish.field.tags'),
    `<div class="pub-tags"><span class="pub-chips" id="pub-chips"></span><input id="pub-tag-input" class="pub-tag-input" type="text" autocomplete="off" placeholder="${escapeAttr(t('publish.tags.placeholder'))}"></div>`);
  const opt = S.options[desc.id];
  const have = opt?.status === 'ok';
  const amount = M.parsePriceInput(f.price);
  const licenses = have ? M.licensesFor(opt.licenses, Number.isNaN(amount) ? null : amount) : null;
  const subs = have ? M.subCategoriesOf(opt.categories, f.category) : [];
  if (have) {   // a stale choice (list changed, or the price now needs another license) is dropped
    if (f.category && !opt.categories.some(c => c.id === f.category)) f.category = '';
    if (f.subCategory && !subs.some(c => c.id === f.subCategory)) f.subCategory = '';
    if (f.license && !licenses.some(l => l.code === f.license)) f.license = '';
  }
  h += _row('pub-category', t('publish.field.category'),
    _optionsOrText('pub-category', have ? opt.categories.map(c => ({ id: c.id, label: c.name })) : null, f.category));
  if (subs.length) {
    h += _row('pub-subcategory', t('publish.field.subCategory'),
      _optionsOrText('pub-subcategory', subs.map(c => ({ id: c.id, label: c.name })), f.subCategory));
  }
  h += _row('pub-license', t('publish.field.license'),
    _optionsOrText('pub-license', licenses ? licenses.map(l => ({ id: l.code, label: l.name })) : null, f.license));
  if (Array.isArray(desc.visibility) && desc.visibility.length > 1) {
    h += _row('pub-visibility', t('publish.field.visibility'),
      `<select id="pub-visibility" class="pp-preset-select">${desc.visibility.map(v => `<option value="${escapeAttr(v)}"${v === f.visibility ? ' selected' : ''}>${escapeHtml(t(v === 'public' ? 'publish.visibility.public' : 'publish.visibility.secret'))}</option>`).join('')}</select>`);
  }
  const cur = Array.isArray(desc.currencies) && desc.currencies.length
    ? `<select id="pub-currency" class="pp-preset-select pub-cur" aria-label="${escapeAttr(t('publish.field.currency'))}">${desc.currencies.map(c => `<option${c === f.currency ? ' selected' : ''}>${escapeHtml(c)}</option>`).join('')}</select>`
    : `<input id="pub-currency" class="pp-preset-select pub-cur" type="text" maxlength="3" value="${escapeAttr(f.currency)}" aria-label="${escapeAttr(t('publish.field.currency'))}">`;
  h += _row('pub-price', t('publish.field.price'), `<div class="pub-price"><input id="pub-price" class="pp-preset-select pp-num" type="text" inputmode="decimal" value="${escapeAttr(f.price)}" placeholder="${escapeAttr(t('publish.price.free'))}">${cur}</div>`);
  if (!have) {
    const note = opt?.status === 'loading' ? t('publish.options.loading')
      : opt?.status === 'failed' ? t('publish.options.failed', { label: desc.label, reason: opt.message || '—' })
        : t('publish.category.freeText');
    h += `<p class="pp-help pub-help" role="status">${escapeHtml(note)}</p>`;
    if (opt?.status === 'failed') h += `<button type="button" class="pub-btn" data-act="reload-options">${escapeHtml(t('publish.options.reload'))}</button>`;
  }
  h += `<div class="pp-checkbox"><input type="checkbox" id="pub-ai"${f.madeWithAi ? ' checked' : ''}><label for="pub-ai">${escapeHtml(t('publish.field.madeWithAi'))}</label></div>`;
  h += _filesHtml(readiness, false);
  const limit = M.zipLimit(desc);
  if (limit != null) h += `<p class="pp-help">${escapeHtml(t('publish.files.zipHint', { n: limit }))}</p>`;
  h += `<p class="pub-blocker" id="pub-blocker" role="status"></p>`;
  h += '<button type="button" class="pp-primary-btn" id="pub-primary" data-act="publish" aria-describedby="pub-blocker"><span class="pp-primary-label"></span></button>';
  h += `<button type="button" class="pub-btn pub-wide" data-act="save-package">${escapeHtml(t('publish.savePackage'))}</button>`;
  h += `<p class="pp-help">${escapeHtml(t('publish.savePackage.help'))}</p>`;
  return h;
}

// ---------------------------------------------------------------------------
// Render + wiring
// ---------------------------------------------------------------------------

/** First reason the primary button is disabled, or '' when it can fire. */
function _blocker(desc, readiness) {
  if (S.pending.length && !_remoteId(desc)) return t('publish.pending.blocked', { label: desc.label });
  if (S.capturing && !S.hero) return t('publish.hero.capturing');
  if (_needsHost(desc) && S.hostMode === 's3' && !S.s3Connected) return t('publish.blocker.host');
  if (readiness && !readiness.canExport) return t('print.readiness.blockedHint');
  const formats = _currentFormats();
  if (!formats.length) return t('publish.blocker.noFormat');
  const sizes = Math.max(1, readiness?.targets?.length ?? 1);
  const issues = M.validateForm({
    form: S.form, hasHero: !!S.hero, galleryCount: S.gallery.length, fileCount: formats.length * sizes,
    limits: { maxImages: desc.maxImages, currencies: desc.currencies }, locale: getLocale(), requires: desc.requires ?? [],
  });
  if (!issues.length) return '';
  const key = M.issueKey(issues[0].code);
  return key ? t(key, { n: desc.maxImages ?? 10 }) : issues[0].message;
}

/**
 * @param {Object} args
 * @param {Object} args.readiness  PrintManager.getPrintReadiness()
 * @param {(focusSelector?: string) => void} args.rerender  panel re-render; optional selector to focus after
 * @returns {HTMLElement}
 */
export function renderPublishTab({ readiness, rerender }) {
  const el = document.createElement('div');
  el.className = 'pp-tab-content pub-tab';
  const refresh = (focusSel) => {
    const active = document.activeElement?.id;
    rerender();
    const sel = focusSel ?? (active ? `#${CSS.escape(active)}` : null);
    if (sel) setTimeout(() => document.querySelector(`#rp-print-body ${sel}`)?.focus?.(), 0);
  };

  if (!Publish.isAvailable()) {
    el.innerHTML = `<p class="pp-help">${escapeHtml(t('publish.unavailable'))}</p>`
      + `<button type="button" class="pub-btn pub-wide" data-act="save-package">${escapeHtml(t('publish.savePackage'))}</button>`;
    el.querySelector('[data-act="save-package"]')?.addEventListener('click', () => saveListingPackageFromView({ onDone: refresh }));
    return el;
  }
  void _hydrate(refresh);

  if (!S.desc) {
    el.innerHTML = `<p class="pp-help" role="status">${escapeHtml(S.descError ? t('publish.loadFailed', { message: S.descError }) : t('publish.loading'))}</p>`;
    return el;
  }
  const desc = _platform();
  let h = '';
  if (!desc) {
    h += `<div class="pub-box"><p class="pp-help" role="status">${escapeHtml(t('publish.noPlatform'))}</p></div>`;
    h += `<button type="button" class="pub-btn pub-wide" data-act="save-package">${escapeHtml(t('publish.savePackage'))}</button>`;
    h += `<p class="pp-help">${escapeHtml(t('publish.savePackage.help'))}</p>`;
    el.innerHTML = h;
    el.querySelector('[data-act="save-package"]')?.addEventListener('click', () => saveListingPackageFromView({ onDone: refresh }));
    return el;
  }

  const connected = !!S.connected[desc.id];
  const platforms = S.desc.platforms;
  h += `<div class="pp-row pub-row"><label for="pub-platform">${escapeHtml(t('publish.platform'))}</label>`
    + `<select id="pub-platform" class="pp-preset-select"${S.phase !== 'form' ? ' disabled' : ''}>${platforms.map(p => `<option value="${escapeAttr(p.id)}"${p.id === desc.id ? ' selected' : ''}>${escapeHtml(p.label)}</option>`).join('')}</select></div>`;
  h += _acctHtml(desc, connected);

  if (!connected || (S.editingConn && S.phase === 'form')) {
    h += _connectHtml(desc);
    if (!connected) {
      h += `<button type="button" class="pub-btn pub-wide" data-act="save-package">${escapeHtml(t('publish.savePackage'))}</button>`;
      h += `<p class="pp-help">${escapeHtml(t('publish.savePackage.help'))}</p>`;
    }
  } else if (S.phase === 'form') {
    if (desc.listOptions && !S.options[desc.id]) setTimeout(() => _loadOptions(desc, refresh), 0);
    if (S.pendingFor !== (getState().project?.id ?? null) && !S.pendingBusy) setTimeout(() => _checkPending(refresh), 0);
    h += _formHtml(desc, readiness);
  } else {
    h += _runHtml(desc);
  }
  el.innerHTML = h;
  if (S.connMsg) {
    const m = el.querySelector('#pub-conn-msg');
    if (m) { m.textContent = S.connMsg.text; m.classList.toggle('bad', !S.connMsg.ok); }
  }
  _wire(el, desc, readiness, refresh);
  return el;
}

function _wire(el, desc, readiness, refresh) {
  const on = (act, fn) => el.querySelectorAll(`[data-act="${act}"]`).forEach(b => b.addEventListener('click', () => fn(b)));

  el.querySelector('#pub-platform')?.addEventListener('change', e => {
    S.platformId = /** @type {HTMLSelectElement} */ (e.target).value; S.connMsg = null; S.editingConn = false; S.note = null;
    refresh('#pub-platform');
  });
  on('save-package', () => saveListingPackageFromView({ onDone: refresh }));
  on('connect', () => _connect(el, desc, refresh));
  on('connect-cancel', () => { S.editingConn = false; S.connMsg = null; refresh('#pub-acct'); });
  on('change-conn', () => { S.editingConn = true; S.connMsg = null; refresh('#pub-cred-' + (desc.credentials?.[0] ?? '')); });
  on('disconnect', () => _disconnect(desc, refresh));
  on('test-conn', () => _testSaved(desc, refresh));
  el.querySelectorAll('input[name="pub-host"]').forEach(r => r.addEventListener('change', () => {
    S.hostMode = /** @type {HTMLInputElement} */ (r).value === 's3' ? 's3' : 'tunnel';
    try { localStorage.setItem(HOST_MODE_KEY, S.hostMode); } catch { /* per-viewer convenience only */ }
    refresh(`input[name="pub-host"][value="${S.hostMode}"]`);
  }));

  // run states
  on('cancel-run', () => _cancel(refresh));
  on('retry', () => _retry(desc, refresh));
  on('publish-new', () => _confirmPublishNew(desc, refresh));
  on('pending-refresh', () => _checkPending(refresh));
  on('pending-check', b => _resolvePending(b.dataset.job, 'check', desc, refresh));
  on('pending-new', b => { S.jobId = b.dataset.job; _confirmPublishNew(desc, refresh); });
  on('keep-waiting', () => _keepWaiting(refresh));
  on('cancel-clean', () => _cancel(refresh).then(() => { S.phase = 'form'; refresh(); }));
  on('back', () => { S.phase = 'form'; S.steps = []; S.outcome = null; S.jobId = null; S.hold = null; S.linksOpen = null; refresh('#pub-title'); });
  on('copy-url', () => _copy(S.outcome?.result?.url));
  on('copy-live', () => _copy(findListing(getState().project?.listings, desc.id, M.ACCOUNT_ID)?.url));

  // ready form
  if (!el.querySelector('#pub-title')) return;
  const f = S.form;
  const bind = (id, key, kind = 'text') => el.querySelector(`#${id}`)?.addEventListener('input', e => {
    const tgt = /** @type {HTMLInputElement} */ (e.target);
    f[key] = kind === 'check' ? tgt.checked : tgt.value;
    paintAction();
  });
  bind('pub-title', 'title'); bind('pub-desc', 'description'); bind('pub-category', 'category');
  bind('pub-license', 'license'); bind('pub-price', 'price'); bind('pub-ai', 'madeWithAi', 'check');
  el.querySelector('#pub-category')?.addEventListener('change', e => {
    const tgt = /** @type {HTMLSelectElement} */ (e.target);
    f.category = tgt.value; f.subCategory = ''; paintAction();
    if (tgt.tagName === 'SELECT') refresh('#pub-category');   // the sub-category list depends on it
  });
  el.querySelector('#pub-subcategory')?.addEventListener('change', e => { f.subCategory = /** @type {HTMLSelectElement} */ (e.target).value; paintAction(); });
  el.querySelector('#pub-visibility')?.addEventListener('change', e => { f.visibility = /** @type {HTMLSelectElement} */ (e.target).value === 'public' ? 'public' : 'secret'; paintAction(); });
  // The license list depends on free vs priced: rebuild it when the price is committed.
  el.querySelector('#pub-price')?.addEventListener('change', () => { if (S.options[desc.id]?.status === 'ok') refresh('#pub-price'); });
  on('reload-options', () => { delete S.options[desc.id]; refresh(); });
  el.querySelector('#pub-license')?.addEventListener('change', e => { f.license = /** @type {HTMLSelectElement} */ (e.target).value; paintAction(); });
  el.querySelector('#pub-currency')?.addEventListener('input', e => { f.currency = /** @type {HTMLInputElement} */ (e.target).value.toUpperCase(); paintAction(); });
  el.querySelector('#pub-currency')?.addEventListener('change', e => { f.currency = /** @type {HTMLSelectElement} */ (e.target).value; paintAction(); });

  // tags
  const chips = /** @type {HTMLElement} */ (el.querySelector('#pub-chips'));
  const tagInput = /** @type {HTMLInputElement} */ (el.querySelector('#pub-tag-input'));
  const paintChips = () => {
    chips.innerHTML = f.tags.map((tag, i) => `<span class="pub-chip">${escapeHtml(tag)}<button type="button" data-rm-tag="${i}" aria-label="${escapeAttr(t('publish.tags.remove', { tag }))}">×</button></span>`).join('');
    chips.querySelectorAll('[data-rm-tag]').forEach(b => b.addEventListener('click', () => {
      f.tags = M.removeTag(f.tags, Number(/** @type {HTMLElement} */ (b).dataset.rmTag));
      paintChips(); paintAction(); tagInput.focus();
    }));
  };
  const takeTags = commit => {
    const r = M.addTagsFromText(f.tags, tagInput.value, { commit });
    f.tags = r.tags; tagInput.value = r.rest; paintChips(); paintAction();
  };
  tagInput.value = S.tagDraft;
  tagInput.addEventListener('input', () => { S.tagDraft = tagInput.value; if (/[,\n，、]/.test(tagInput.value)) { takeTags(false); S.tagDraft = tagInput.value; } });
  tagInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); takeTags(true); S.tagDraft = ''; }
    else if (e.key === 'Backspace' && !tagInput.value && f.tags.length) { f.tags = M.removeTag(f.tags, f.tags.length - 1); paintChips(); paintAction(); }
  });
  tagInput.addEventListener('blur', () => { if (tagInput.value.trim()) { takeTags(true); S.tagDraft = ''; } });
  paintChips();

  // hero / gallery
  on('retake', () => _captureHero(refresh));
  on('transparent', () => { S.transparent = !S.transparent; _captureHero(refresh); });
  on('add-shot', () => _addGalleryShot(refresh, Math.max(0, (desc.maxImages ?? 10) - 1)));
  on('rm-shot', b => {
    const i = Number(b.dataset.i); const [g] = S.gallery.splice(i, 1);
    if (g) URL.revokeObjectURL(g.url);
    refresh('[data-act="add-shot"]');
  });
  if (!S.hero && !S.capturing && !S.heroTried) setTimeout(() => _captureHero(refresh), 0);

  // files
  el.querySelectorAll('[data-fmt-pick]').forEach(cb => cb.addEventListener('change', () => {
    const set = new Set(_currentFormats());
    const key = /** @type {HTMLElement} */ (cb).dataset.fmtPick;
    if (/** @type {HTMLInputElement} */ (cb).checked) set.add(key); else set.delete(key);
    S.formats = set; S.built = [];
    paintAction();
  }));

  // primary
  const primary = /** @type {HTMLButtonElement} */ (el.querySelector('#pub-primary'));
  function paintAction() {
    const amount = M.parsePriceInput(f.price);
    const act = M.primaryAction({
      label: desc.label, remoteId: _remoteId(desc), drafts: desc.drafts === true,
      visibility: Array.isArray(desc.visibility) && desc.visibility.length ? f.visibility : null,
      amount: Number.isNaN(amount) ? null : amount, currency: (f.currency || '').toUpperCase(), locale: getLocale(),
    });
    const why = _blocker(desc, readiness);
    primary.querySelector('.pp-primary-label').textContent = t(act.key, act.params);
    primary.disabled = !!why;
    primary.setAttribute('aria-disabled', why ? 'true' : 'false');
    const out = el.querySelector('#pub-blocker');
    if (out) out.textContent = why;
  }
  paintAction();
  on('publish', () => { if (!primary.disabled) _publish(desc, refresh); });
  on('publish-anyway', () => _publish(desc, refresh, { acknowledgeWarnings: true }));
}

async function _copy(text) {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    Toast.show(t('publish.copied'), 'success');
  } catch {
    const input = /** @type {HTMLInputElement|null} */ (document.querySelector('#pub-url'));
    input?.select();   // clipboard blocked: the link is selected, Ctrl+C finishes it
  }
}
