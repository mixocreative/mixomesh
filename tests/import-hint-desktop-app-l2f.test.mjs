// L2-12: a too-heavy import on Safari told the user to "use the desktop app",
// which ships for Windows only. The hint and the refusal point at the
// desktop app only where it can be installed; elsewhere they say simplify or
// split.
//   node --import ./tests/register-hooks.mjs --test tests/import-hint-desktop-app-l2f.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installEnv } from './env.mjs';

installEnv();
const { classifyImportFailure } = await import('../src/core/import/ImportFailure.js');
const { assertPreParseCapacity, OVER_BUDGET } = await import('../src/core/import/ImportLimits.js');
const { desktopAppOffered } = await import('../src/core/storage/capabilities.js');

const MAC_SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148';
const WIN_CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const MAC_CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

test('the desktop app is offered on Windows browsers only', () => {
  assert.equal(desktopAppOffered(WIN_CHROME), true);
  for (const ua of [MAC_SAFARI, IPHONE, MAC_CHROME]) assert.equal(desktopAppOffered(ua), false, ua);
});

test('without a desktop app to offer, the refusal says simplify or split', () => {
  const refuse = desktopApp => {
    try {
      assertPreParseCapacity({ triangles: 3_500_000, confidence: 'exact' },
        { budget: 1_000_000, limit: 3_000_000, filename: 'pillow.stl', desktopApp });
    } catch (err) { return err; }
    return null;
  };
  const mac = refuse(false);
  assert.equal(mac.code, OVER_BUDGET);
  assert.doesNotMatch(mac.message, /desktop app/);
  assert.match(mac.message, /Simplify or split/);
  assert.match(refuse(true).message, /desktop app/, 'Windows still hears about the desktop app');

  assert.equal(classifyImportFailure(mac, 'pillow.stl', { desktopApp: false }).hintKey, 'import.fix.polygons');
  assert.equal(classifyImportFailure(mac, 'pillow.stl', { desktopApp: true }).hintKey, 'import.fix.polygonsWeb');
});
