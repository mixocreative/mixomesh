/*
 * MX-08: a support build that returns NOTHING must be as loud as its mirror.
 *
 *   node --import ./tests/register-hooks.mjs --test tests/supports-nothing-built.test.mjs
 *
 * `_addSupportClones` had `if (!built) continue;` three lines from `:670`, where the same condition
 * on the `supportsOnly` route throws `EXPORT_NO_SUPPORTS`. So a unit the viewport shows standing on
 * supports could leave the file without them and the export still said "✓ Exported".
 *
 * The audit rates this POSSIBLE, not CONFIRMED: it could not construct an input where
 * `buildSupportsForExport` returns null on the printable route. What is being fixed is the
 * ASYMMETRY — two mirror paths, one throwing and one shrugging — not a proven user-facing bug. That
 * is also why the builder is injected here rather than reached through its real preconditions: if
 * those preconditions were known to be satisfiable the finding would have been CONFIRMED.
 *
 * Invariant: a unit with built supports is either in the exported file or named in the outcome.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installEnv } from './env.mjs';

installEnv();
const { __test: Pipeline } = await import('../src/core/print/PrintPipeline.js');
const { t } = await import('../src/i18n/index.js');

/** The one unit shape `_addSupportClones` reads: built supports, a name, one part. */
const unitWithSupports = (name = 'Pumpkin') => ({
  logicalId: 'u1',
  name,
  // hasBuiltSupports(obj): a lead carrying `supports` with both sourceHash and pose.
  obj: { supports: { sourceHash: 'abc', pose: {} } },
  parts: [{ mesh: { getScene: () => null } }],
});

const ctxWith = unit => ({ units: [unit], ratioFactor: 1, repairSkipped: [] });

test('a support build that returns nothing names the object in the export outcome', async () => {
  const ctx = ctxWith(unitWithSupports());
  const out = [];
  await Pipeline.addSupportClones(ctx, out, async () => null);

  assert.equal(out.length, 0, 'nothing was built, so nothing is in the file');
  assert.equal(ctx.repairSkipped.length, 1, `expected one named warning, got ${JSON.stringify(ctx.repairSkipped)}`);
  // The warning the user actually reads is this list joined into one toast.
  const warning = t('toast.exportedWithWarnings', { names: ctx.repairSkipped.join(', ') });
  assert.match(warning, /Pumpkin/, warning);
});

test('the name it reports is the unit it came from, not a generic one', async () => {
  const ctx = ctxWith(unitWithSupports('猫 モデル'));
  await Pipeline.addSupportClones(ctx, [], async () => null);
  assert.match(t('toast.exportedWithWarnings', { names: ctx.repairSkipped.join(', ') }), /猫 モデル/);
});

test('a unit with no built supports is not a warning — it was never promised any', async () => {
  const ctx = ctxWith({ logicalId: 'u2', name: 'Plain', obj: {}, parts: [] });
  await Pipeline.addSupportClones(ctx, [], async () => null);
  assert.deepEqual(ctx.repairSkipped, []);
});
