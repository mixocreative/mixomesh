/*
 * MX-09 / MX-10: an exported function with no caller, and a state field with no reader.
 *
 *   node --import ./tests/register-hooks.mjs --test tests/no-orphan-exports-mx09.test.mjs
 *
 * The audit found eight orphan exports and two orphan state fields, every one confirmed by reading
 * each hit of a whole-repo grep. Deleting them is a one-off; this is what stops the next one.
 *
 * Scope is the modules MX-09 named, not the whole tree — a tree-wide sweep belongs to
 * tools/sweep_leads.py, which is where the finding came from. The point here is that these files
 * were the ones that grew accessors nobody ever called, so these are the files worth watching.
 *
 * The trap this test has to avoid: a name can be reached without being written next to an import.
 * So the search covers .js/.jsx/.ts/.tsx/.mjs/.cjs/.html across src, electron and tests, counts any
 * occurrence outside the defining file, and treats a namespace import of the module as "every
 * export of it is reachable" — which means a module imported as `* as X` anywhere is simply not
 * checkable this way and is skipped, loudly, rather than producing a confident wrong answer.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const ROOT = resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));

/** The modules MX-09 named. Add a module here when it starts collecting accessors. */
const WATCHED = [
  'src/core/persist/ProjectSerializer.js',
  'src/core/scene/AdaptiveResolution.js',
  'src/core/scene/CameraRig.js',
  'src/core/scene/PivotSession.js',
  'src/core/shaders/ColorSpace.js',
  'src/ui/print/PublishTab.js',
];

const CODE = /\.(?:js|jsx|ts|tsx|mjs|cjs|html)$/;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.tmp', '.runs', 'graphify-out', '.audit', 'vendor', 'public']);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (CODE.test(name)) out.push(path);
  }
  return out;
}

const FILES = ['src', 'electron', 'tests'].flatMap(d => walk(join(ROOT, d)));
const SOURCE = new Map(FILES.map(p => [relative(ROOT, p).replace(/\\/g, '/'), readFileSync(p, 'utf8')]));

/** Exported function / const names of a module, in source order. */
function exportsOf(text) {
  return [...text.matchAll(/^export\s+(?:async\s+)?(?:function|const|let|class)\s+([A-Za-z_$][\w$]*)/gm)].map(m => m[1]);
}

test('MX-09: no exported function in the watched modules is without a caller', () => {
  const orphans = [];
  const unverifiable = [];
  for (const module of WATCHED) {
    const text = SOURCE.get(module);
    assert.ok(text, `${module} is in WATCHED but not on disk — update the list`);
    const base = module.split('/').pop();
    // A namespace import defeats a name search: `X.foo()` reads as `foo` only by luck of spelling.
    const namespaced = [...SOURCE].some(([path, src]) =>
      path !== module && new RegExp(`import\\s+\\*\\s+as\\s+\\w+\\s+from\\s+['"][^'"]*${base.replace('.', '\\.')}['"]`).test(src));
    if (namespaced) { unverifiable.push(module); continue; }
    for (const name of exportsOf(text)) {
      const used = [...SOURCE].some(([path, src]) =>
        path !== module && new RegExp(`\\b${name}\\b`).test(src));
      if (!used) orphans.push(`${module} → ${name}`);
    }
  }
  assert.deepEqual(orphans, [],
    `exported with no caller anywhere in src / electron / tests — delete it, or write beside it what would call it:\n  ${orphans.join('\n  ')}`);
  // Said out loud rather than silently passing: these modules cannot be checked this way.
  if (unverifiable.length) console.log(`  (namespace-imported, not name-checkable: ${unverifiable.join(', ')})`);
});

test('MX-10: every field of the ui state default has a reader', () => {
  const sm = SOURCE.get('src/core/StateManager.js');
  assert.ok(sm, 'StateManager.js not found');
  // The `ui:` block of the initial state — plausible-looking panel state is exactly what a future
  // reader treats as live, so a field with no reader is worse than no field.
  const block = sm.match(/\n\s*ui:\s*\{([\s\S]*?)\n\s*\},/);
  assert.ok(block, 'could not find the ui block of the initial state — has the shape changed?');
  // `[{,\n]` not `^`: the first field of the block sits after a newline, and `^` without the `m`
  // flag never matched it — which silently excused the very field MX-10 is about.
  const fields = [...block[1].matchAll(/[{,\n]\s*([A-Za-z_$][\w$]*)\s*:/g)].map(m => m[1]);
  assert.ok(fields.length >= 3, `expected the ui defaults, parsed ${JSON.stringify(fields)}`);
  const orphans = fields.filter(name => ![...SOURCE].some(([path, src]) =>
    path !== 'src/core/StateManager.js' && new RegExp(`\\b${name}\\b`).test(src)));
  assert.deepEqual(orphans, [],
    `declared in the ui state default and read nowhere: ${orphans.join(', ')}`);
});
