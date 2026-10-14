// Publish tab (PB.9): the pure decisions in src/ui/print/PublishModel.js plus the
// PublishClient.retryPublish persistence seam.
//   node --import ./tests/register-hooks.mjs --test tests/publish-tab.test.mjs

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installEnv } from './env.mjs';

installEnv();
const M = await import('../src/ui/print/PublishModel.js');
const { retryPublish } = await import('../src/core/publish/PublishClient.js');

// -- price + button label --------------------------------------------------

test('parsePriceInput: empty and 0 are free, comma decimals work, junk is NaN', () => {
  assert.equal(M.parsePriceInput(''), null);
  assert.equal(M.parsePriceInput('  '), null);
  assert.equal(M.parsePriceInput('0'), null);
  assert.equal(M.parsePriceInput(undefined), null);
  assert.equal(M.parsePriceInput('4'), 4);
  assert.equal(M.parsePriceInput('4,50'), 4.5);
  assert.ok(Number.isNaN(M.parsePriceInput('abc')));
});

test('formatPrice: currency symbol per locale, safe fallback for unknown codes', () => {
  assert.equal(M.formatPrice(4, 'EUR', 'en'), '€4.00');
  assert.equal(M.formatPrice(1234.5, 'USD', 'en'), '$1,234.50');
  assert.match(M.formatPrice(4, 'EUR', 'ja'), /4\.00/);
  assert.equal(M.formatPrice(4, 'ZZ', 'en'), '4.00 ZZ');
});

test('primaryAction names the consequence: live+price, free, draft, update', () => {
  assert.deepEqual(M.primaryAction({ label: 'Cults3D', amount: 4, currency: 'EUR' }),
    { key: 'publish.btn.live', params: { label: 'Cults3D', price: '€4.00' } });
  assert.deepEqual(M.primaryAction({ label: 'Cults3D', amount: null, currency: 'EUR' }),
    { key: 'publish.btn.liveFree', params: { label: 'Cults3D' } });
  assert.equal(M.primaryAction({ label: 'X', amount: 0 }).key, 'publish.btn.liveFree');
  assert.equal(M.primaryAction({ label: 'X', amount: 4, currency: 'EUR', drafts: true }).key, 'publish.btn.draft');
  // an existing listing always wins: publishing again is an update
  assert.equal(M.primaryAction({ label: 'X', amount: 4, currency: 'EUR', drafts: true, remoteId: 'r1' }).key, 'publish.btn.update');
});

test('primaryAction with a visibility choice: secret is worded "secretly", public is live', () => {
  const base = { label: 'Cults3D', amount: 4, currency: 'EUR', drafts: true };
  assert.deepEqual(M.primaryAction({ ...base, visibility: 'secret' }), { key: 'publish.btn.secret', params: { label: 'Cults3D', price: '€4.00' } });
  assert.deepEqual(M.primaryAction({ ...base, amount: null, visibility: 'secret' }), { key: 'publish.btn.secretFree', params: { label: 'Cults3D' } });
  assert.equal(M.primaryAction({ ...base, visibility: 'public' }).key, 'publish.btn.live');
  assert.equal(M.primaryAction({ ...base, amount: null, visibility: 'public' }).key, 'publish.btn.liveFree');
  assert.equal(M.primaryAction({ ...base, visibility: 'secret', remoteId: 'r' }).key, 'publish.btn.update');
});

test('licensesFor filters by free vs priced; subCategoriesOf; requires; step label; progress counts', () => {
  const ls = [{ code: 'a', free: true, priced: true }, { code: 'b', free: true, priced: false }, { code: 'c', free: false, priced: true }, { code: 'd' }];
  assert.deepEqual(M.licensesFor(ls, null).map(l => l.code), ['a', 'b', 'd']);
  assert.deepEqual(M.licensesFor(ls, 4).map(l => l.code), ['a', 'c', 'd']);
  assert.deepEqual(M.subCategoriesOf([{ id: '1', children: [{ id: '2' }] }], '1'), [{ id: '2' }]);
  assert.deepEqual(M.subCategoriesOf([], '1'), []);
  const form = { ...M.emptyForm('T', 'EUR'), description: 'd' };
  const args = { form, hasHero: true, galleryCount: 0, fileCount: 1 };
  assert.ok(!M.validateForm(args).some(i => i.code === 'category-required'));
  assert.deepEqual(M.validateForm({ ...args, requires: ['categoryHint', 'license'] }).map(i => i.code), ['category-required', 'license-required']);
  assert.deepEqual(M.validateForm({ ...args, form: { ...form, category: '1', license: 'x' }, requires: ['categoryHint', 'license'] }), []);
  assert.equal(M.stepLabelKey('host'), 'publish.step.host');
  assert.equal(M.stepLabelKey('host', { direct: true }), 'publish.step.hostDirect');
  assert.equal(M.stepLabelKey('create', { direct: true }), 'publish.step.create');
  assert.equal(M.errorKey('upload-failed'), 'publish.err.uploadFailed');
  assert.equal(M.errorKey('upload-slot-failed'), 'publish.err.uploadSlotFailed');
  const steps = M.applyProgress(M.initialSteps(false), { step: 'host', status: 'running', phase: 'upload', done: 1, total: 3 });
  assert.deepEqual(steps.find(s => s.id === 'host'), { id: 'host', status: 'run', message: undefined, phase: 'upload', done: 1, total: 3 });
});

test('form <-> listing carries visibility (default secret) and the sub-category', () => {
  assert.equal(M.emptyForm().visibility, 'secret');
  const l = M.formToListing({ ...M.emptyForm('T'), category: '1', subCategory: ' 2 ', visibility: 'public' });
  assert.equal(l.visibility, 'public');
  assert.deepEqual(l.subCategoryIds, ['2']);
  assert.deepEqual(M.formToListing(M.emptyForm('T')).subCategoryIds, []);
  const back = M.formFromRecord({ title: 'x', visibility: 'public', subCategoryIds: ['9'], categoryId: '1' });
  assert.deepEqual([back.visibility, back.subCategory, back.category], ['public', '9', '1']);
  assert.equal(M.formFromRecord({ title: 'x' }).visibility, 'secret');
});

// -- tags ------------------------------------------------------------------

test('addTagsFromText: commas finish tags, tail stays, dedupe ignores case', () => {
  assert.deepEqual(M.addTagsFromText([], 'owl, full colour, fig'), { tags: ['owl', 'full colour'], rest: 'fig' });
  assert.deepEqual(M.addTagsFromText(['Owl'], 'owl, bird,'), { tags: ['Owl', 'bird'], rest: '' });
  assert.deepEqual(M.addTagsFromText(['a'], ' b ', { commit: true }), { tags: ['a', 'b'], rest: '' });
  assert.deepEqual(M.addTagsFromText(['a'], '  ', { commit: true }), { tags: ['a'], rest: '' });
  assert.deepEqual(M.addTagsFromText([], 'a、b，'), { tags: ['a', 'b'], rest: '' });
  assert.deepEqual(M.removeTag(['a', 'b', 'c'], 1), ['a', 'c']);
});

// -- form <-> listing ------------------------------------------------------

test('formToListing maps price / license / category and free = null price', () => {
  const form = { ...M.emptyForm('Owl', 'EUR'), description: 'd', tags: ['a'], category: ' Art ', license: '', price: '4,5', currency: 'eur', madeWithAi: true };
  const l = M.formToListing(form, { locale: 'ja' });
  assert.deepEqual(l.price, { amount: 4.5, currency: 'EUR' });
  assert.equal(l.categoryHint, 'Art');
  assert.equal(l.license, null);
  assert.equal(l.madeWithAi, true);
  assert.equal(l.locale, 'ja');
  assert.equal(M.formToListing({ ...form, price: '' }).price, null);
});

test('formFromRecord prefills from a persisted listing, else defaults', () => {
  assert.deepEqual(M.formFromRecord(null, { title: 'T', currency: 'USD' }), M.emptyForm('T', 'USD'));
  const f = M.formFromRecord({ title: 'Owl', description: 'd', tags: ['x'], price: 4, currency: 'EUR', license: 'std', madeWithAi: true, categoryId: 'art' });
  assert.equal(f.title, 'Owl'); assert.equal(f.price, '4'); assert.equal(f.category, 'art'); assert.equal(f.madeWithAi, true);
  assert.notEqual(f.tags, undefined);
});

test('validateForm reports the first core issue without building files', () => {
  const ok = { ...M.emptyForm('Owl'), description: 'd' };
  assert.deepEqual(M.validateForm({ form: ok, hasHero: true, galleryCount: 0, fileCount: 1 }), []);
  const codes = f => M.validateForm({ form: f, hasHero: true, galleryCount: 0, fileCount: 1 }).map(i => i.code);
  assert.deepEqual(codes({ ...ok, title: ' ' }), ['title-empty']);
  assert.deepEqual(codes({ ...ok, description: '' }), ['description-empty']);
  assert.deepEqual(codes({ ...ok, price: 'x' }), ['price-invalid']);
  assert.deepEqual(codes({ ...ok, price: '1.234' }), ['price-precision']);
  assert.ok(M.validateForm({ form: ok, hasHero: false, galleryCount: 0, fileCount: 1 }).some(i => i.code === 'images-none'));
  assert.ok(M.validateForm({ form: ok, hasHero: true, galleryCount: 0, fileCount: 0 }).some(i => i.code === 'files-none'));
  assert.ok(M.validateForm({ form: { ...ok, price: '4', currency: 'JPY' }, hasHero: true, galleryCount: 0, fileCount: 1, limits: { currencies: ['EUR'] } })
    .some(i => i.code === 'currency-unsupported'));
  assert.ok(M.validateForm({ form: ok, hasHero: true, galleryCount: 3, fileCount: 1, limits: { maxImages: 2 } }).some(i => i.code === 'images-too-many'));
  assert.equal(M.issueKey('title-empty'), 'publish.issue.titleEmpty');
  assert.equal(M.issueKey('hero-count'), null);
});

test('errorKey maps all error codes, returns null for unknown', () => {
  assert.equal(M.errorKey('no-credentials'), 'publish.err.noCredentials');
  assert.equal(M.errorKey('no-file-host'), 'publish.err.noFileHost');
  assert.equal(M.errorKey('cloudflared-missing'), 'publish.err.cloudflaredMissing');
  assert.equal(M.errorKey('tunnel-start-timeout'), 'publish.err.tunnelStartTimeout');
  assert.equal(M.errorKey('platform-http'), 'publish.err.platformHttp');
  assert.equal(M.errorKey('platform-rejected'), 'publish.err.platformRejected');
  assert.equal(M.errorKey('not-confirmed'), 'publish.err.notConfirmed');
  assert.equal(M.errorKey('cleanup-left'), 'publish.err.cleanupLeft');
  assert.equal(M.errorKey('cancelled'), 'publish.err.cancelled');
  assert.equal(M.errorKey('unknown-code'), null);
});

test('pending error translations file has all codes in all three locales', async () => {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const pendingFile = path.join(root, '.tmp', 'locale-pending', 'publish-errors.json');
  const content = await fs.readFile(pendingFile, 'utf8');
  const pending = JSON.parse(content);
  const locales = ['en', 'ja', 'zh-Hant'];
  const codes = ['no-credentials', 'no-file-host', 'cloudflared-missing', 'tunnel-start-timeout', 'platform-http', 'platform-rejected', 'not-confirmed', 'cleanup-left', 'cancelled'];
  for (const code of codes) {
    const key = M.errorKey(code);
    assert.ok(key, `errorKey(${code}) must return a key`);
    for (const locale of locales) {
      assert.ok(pending[locale]?.[key], `pending translations must have ${key} for locale ${locale}`);
    }
  }
});

// -- steps -----------------------------------------------------------------

test('stepPlan mirrors jobs.cjs: publish reports as create or update', () => {
  assert.deepEqual(M.stepPlan(false), ['build', 'validate', 'bundle', 'host', 'create', 'confirm', 'cleanup']);
  assert.deepEqual(M.stepPlan(true), ['build', 'validate', 'bundle', 'host', 'update', 'confirm', 'cleanup']);
  for (const id of M.stepPlan(false).concat(['update'])) assert.match(M.stepLabelKey(id), /^publish\.step\./);
  assert.equal(M.stepLabelKey('nope'), null);
});

test('applyProgress folds events, closes earlier steps, handles skipped + failed', () => {
  let s = M.initialSteps(false);
  assert.equal(M.progressFraction(s), 0);
  s = M.applyProgress(s, { step: 'validate', status: 'running' });
  assert.equal(s.find(x => x.id === 'build').status, 'done');
  assert.equal(s.find(x => x.id === 'validate').status, 'run');
  s = M.applyProgress(s, { step: 'validate', status: 'done' });
  s = M.applyProgress(s, { step: 'host', status: 'done', skipped: true });
  assert.equal(s.find(x => x.id === 'host').status, 'skipped');
  assert.equal(s.find(x => x.id === 'bundle').status, 'done');   // never reported, still closed
  s = M.applyProgress(s, { step: 'create', status: 'failed', message: 'category is required' });
  assert.equal(s.find(x => x.id === 'create').status, 'failed');
  assert.equal(s.find(x => x.id === 'create').message, 'category is required');
  assert.strictEqual(M.applyProgress(s, { step: 'unknown', status: 'running' }), s);
  assert.ok(M.progressFraction(s) > 0.5 && M.progressFraction(s) < 1);
});

// -- credentials -----------------------------------------------------------

test('credential helpers: ids, secret detection, labels, collection', () => {
  assert.equal(M.platformCredentialId('cults3d'), 'cults3d:default');
  assert.equal(M.fileHostCredentialId(M.TUNNEL_HOST_ID), 'filehost:tunnel');
  assert.equal(M.fileHostCredentialId(M.S3_HOST_ID), 'filehost:default');
  assert.ok(M.isSecretField('apiKey') && M.isSecretField('secretAccessKey'));
  assert.ok(!M.isSecretField('nickname') && !M.isSecretField('accessKeyId') && !M.isSecretField('bucket'));
  assert.equal(M.humanizeField('accessKeyId'), 'Access key id');
  assert.equal(M.credentialFieldKey('apiKey'), 'publish.cred.apiKey');
  assert.equal(M.credentialFieldKey('mystery'), null);
  const c = M.collectCredentials({ a: ' 1 ', b: '', c: 'x' }, ['a', 'b'], ['c', 'd']);
  assert.deepEqual(c, { secret: { a: '1', c: 'x' }, missing: ['b'] });
  assert.equal(M.zipLimit({ maxFiles: 10 }), 10);
  assert.equal(M.zipLimit({}), null);
  assert.equal(M.formatBytes(8.2 * 1024 * 1024), '8.2 MB');
  assert.equal(M.formatBytes(undefined), '—');
});

// -- retryPublish persists like publish() ----------------------------------

function fakeDeps(outcome) {
  let project = { listings: [] };
  return {
    deps: {
      caps: { publish: true },
      api: { retry: async id => { assert.equal(id, 'job1'); return outcome; }, onProgress: cb => { cb({ step: 'create', status: 'running' }); return () => {}; } },
      getState: () => ({ project }),
      setState: fn => { const next = fn({ project }); project = next.project; },
      now: () => '2026-10-14T00:00:00.000Z',
    },
    listings: () => project.listings,
  };
}
const pkg = { title: 'Owl', description: 'd', tags: [], price: { amount: 4, currency: 'EUR' }, license: null, madeWithAi: false, categoryHint: null, files: [{ name: 'a.3mf' }], images: [] };

test('retryPublish: success after a retry saves the listing record', async () => {
  const { deps, listings } = fakeDeps({ ok: true, jobId: 'job1', status: 'done', result: { remoteId: 'r9', url: 'https://x/y', status: 'published' } });
  const seen = [];
  const out = await retryPublish('job1', pkg, { platform: 'cults3d', accountId: 'default' }, e => seen.push(e), deps);
  assert.equal(out.ok, true);
  assert.equal(seen.length, 1);
  assert.equal(listings().length, 1);
  assert.equal(listings()[0].remoteId, 'r9');
  assert.equal(listings()[0].status, 'published');
});

test('retryPublish: another failure with no remote listing records nothing', async () => {
  const { deps, listings } = fakeDeps({ ok: false, jobId: 'job1', status: 'failed', error: 'nope' });
  const out = await retryPublish('job1', pkg, { platform: 'cults3d', accountId: 'default' }, null, deps);
  assert.equal(out.ok, false);
  assert.deepEqual(listings(), []);
});

test('retryPublish refuses outside the desktop shell', async () => {
  await assert.rejects(() => retryPublish('j', pkg, {}, null, { caps: { publish: false }, api: {} }), /desktop/);
});

// -- PB.14: Keep waiting model helpers --------------------------------------

test('nextHold: only the structured confirm hold event sets it; any other event clears it', () => {
  const ev = { step: 'confirm', status: 'running', hold: true, served: 1, total: 3, holdRemainingMs: 125000 };
  assert.deepEqual(M.nextHold(null, ev), { served: 1, total: 3, remainingMs: 125000 });
  assert.deepEqual(M.nextHold(null, { ...ev, served: undefined, total: undefined }), { served: null, total: null, remainingMs: 125000 });
  const held = M.nextHold(null, ev);
  assert.equal(M.nextHold(held, { step: 'confirm', status: 'done' }), null);
  assert.equal(M.nextHold(held, { step: 'confirm', status: 'failed', linksOpenMs: 5 }), null);
  assert.equal(M.nextHold(held, { step: 'confirm', status: 'running' }), null, 'plain running (no hold flag) is not a hold');
  assert.equal(M.nextHold(held, undefined), held, 'no event: unchanged');
});

test('minutesLeft rounds up and never shows 0; holdText picks the counted or plain wording', () => {
  assert.equal(M.minutesLeft(0), 1);
  assert.equal(M.minutesLeft(59_000), 1);
  assert.equal(M.minutesLeft(60_001), 2);
  assert.equal(M.minutesLeft(15 * 60_000), 15);
  assert.equal(M.minutesLeft(undefined), 1);
  assert.deepEqual(M.holdText({ served: 2, total: 5, remainingMs: 600_000 }, 'Cults3D'),
    { key: 'publish.hold.status', params: { label: 'Cults3D', served: 2, total: 5, min: 10 } });
  assert.deepEqual(M.holdText({ served: null, total: null, remainingMs: 30_000 }, 'Cults3D'),
    { key: 'publish.hold.statusNoCount', params: { label: 'Cults3D', min: 1 } });
  assert.equal(M.KEEP_WAITING_MS, 900000);
});

test('linksOpenFromEvent: only a confirm failure with linksOpenMs > 0; countdown never goes negative', () => {
  const fail = { step: 'confirm', status: 'failed', linksOpenMs: 600000 };
  const info = M.linksOpenFromEvent(fail, 1000);
  assert.deepEqual(info, { ms: 600000, at: 1000 });
  assert.equal(M.linksOpenFromEvent({ ...fail, step: 'create' }, 1), null);
  assert.equal(M.linksOpenFromEvent({ ...fail, linksOpenMs: 0 }, 1), null);
  assert.equal(M.linksOpenFromEvent({ ...fail, linksOpenMs: undefined }, 1), null);
  assert.equal(M.linksOpenFromEvent({ ...fail, status: 'running' }, 1), null);
  assert.equal(M.linksOpenLeft(info, 61000), 540000);
  assert.equal(M.linksOpenLeft(info, 9e9), 0);
  assert.equal(M.linksOpenLeft(null, 5), 0);
});
