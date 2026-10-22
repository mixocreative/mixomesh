// cia D-09: an EVENTS key nobody references is a trap (a module that subscribes
// to it waits forever and nothing fails). Every key must be used outside events.js.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(js|mjs|cjs)$/.test(name)) files.push(p);
  }
})(join(root, 'src'));
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(js|mjs|cjs)$/.test(name)) files.push(p);
  }
})(join(root, 'electron'));
const sources = files
  .filter(f => relative(root, f).replace(/\\/g, '/') !== 'src/core/events.js')
  .map(f => readFileSync(f, 'utf8'));

const { EVENTS } = await import('../src/core/events.js');

test('every EVENTS key is referenced by code outside events.js', () => {
  const dead = Object.entries(EVENTS)
    .filter(([key, value]) => !sources.some(s => s.includes(`EVENTS.${key}`) || s.includes(`'${value}'`)))
    .map(([key]) => key);
  assert.deepEqual(dead, []);
});
