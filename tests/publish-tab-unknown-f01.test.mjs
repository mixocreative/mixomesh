// cia F-01 (Publish tab): a create whose answer was lost offers "check again", never a blind Retry.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installEnv } from './env.mjs';

installEnv();
const M = await import('../src/ui/print/PublishModel.js');

test('create-unknown: the failed panel checks the platform instead of retrying, and offers an explicit new listing', () => {
  const v = M.failureView({ ok: false, status: 'failed', failedStep: 'create', code: 'create-unknown' });
  assert.equal(v.retryKey, 'publish.unknown.check');
  assert.equal(v.hintKey, 'publish.unknown.howTo');
  assert.equal(v.publishNew, true);
  assert.equal(M.errorKey('create-unknown'), 'publish.err.createUnknown');
});

test('any other failure keeps the plain Retry and no "publish as new" escape', () => {
  for (const code of ['platform-rejected', 'upload-failed', 'not-confirmed', null]) {
    const v = M.failureView({ ok: false, status: 'failed', code });
    assert.equal(v.retryKey, 'publish.retry', String(code));
    assert.equal(v.publishNew, false, String(code));
  }
});
