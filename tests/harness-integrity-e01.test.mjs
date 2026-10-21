import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const dir = new URL('.', import.meta.url);
const files = fs.readdirSync(dir).filter(f => f.endsWith('.test.mjs') && f !== 'harness-integrity-e01.test.mjs');

test('no hand-rolled synchronous test() harness wraps an async body', () => {
  const offenders = [];
  for (const f of files) {
    const src = fs.readFileSync(new URL(f, dir), 'utf8');
    if (/from ['"]node:test['"]/.test(src)) continue;
    const syncHarness = /^function test\(/m.test(src);
    const asyncBody = /^test\(.*(async|await)\b/m.test(src) || /^\s+await /m.test(src);
    if (syncHarness && asyncBody) offenders.push(f);
  }
  assert.deepEqual(offenders, [], 'a sync harness never awaits the body, so process.exit fires before it runs');
});

test('no hand-rolled async test() harness is called without await', () => {
  const offenders = [];
  for (const f of files) {
    const src = fs.readFileSync(new URL(f, dir), 'utf8');
    if (/from ['"]node:test['"]/.test(src)) continue;
    if (!/^async function test\(/m.test(src)) continue;
    if (/^test\(/m.test(src)) offenders.push(f);
  }
  assert.deepEqual(offenders, []);
});
