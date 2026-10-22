// cia D-11: every en.json key is referenced by code (literal or a dynamic
// prefix such as t(`import.fix.${code}`)), so translators never pay for dead
// strings. KEEP lists keys that docs/TRANSLATIONS.md uses as worked examples and
// the storage.opfs.* boot-gate texts (to be wired into OpfsStorageAdapter.js).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const KEEP = new Set([
  'panel.shader.title', 'btn.reset', 'btn.export', 'toast.saved', '_plural.objects',
  'import.error.title',
  'storage.opfs.unsupported.title', 'storage.opfs.unsupported.body',
  'storage.opfs.unavailable.title', 'storage.opfs.unavailable.body',
]);

const files = [join(root, 'index.html')];
function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { if (!p.endsWith(`${sep}locales`)) walk(p); }
    else if (/\.(js|mjs|cjs|html)$/.test(name)) files.push(p);
  }
}
walk(join(root, 'src'));
walk(join(root, 'electron'));
const blob = files.map(f => readFileSync(f, 'utf8')).join('\n');

const prefixes = new Set();
for (const m of blob.matchAll(/[`'"]([a-zA-Z0-9_.-]+\.)\$\{/g)) prefixes.add(m[1]);
for (const m of blob.matchAll(/[`'"]([a-zA-Z0-9_.-]+\.)[`'"]\s*\+/g)) prefixes.add(m[1]);

const en = JSON.parse(readFileSync(join(root, 'src/i18n/locales/en.json'), 'utf8'));

test('no en.json key is unreferenced', () => {
  const dead = Object.keys(en).filter(k =>
    !KEEP.has(k)
    && !blob.includes(`'${k}'`) && !blob.includes(`"${k}"`) && !blob.includes(`\`${k}\``)
    && ![...prefixes].some(p => k.startsWith(p)));
  assert.deepEqual(dead, []);
});
