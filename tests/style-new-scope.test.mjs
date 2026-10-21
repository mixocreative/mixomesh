// Original must render exactly as before: every rule in style-new.css has to
// be scoped to the New style, or it leaks into data-ui-style="original".
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';

const SCOPE = ':root:not([data-ui-style="original"])';

// Split a selector list on commas outside parentheses (:is(a, b) stays whole).
function splitTopLevel(list) {
  const parts = [];
  let depth = 0, start = 0;
  for (let i = 0; i < list.length; i++) {
    if (list[i] === '(') depth++;
    else if (list[i] === ')') depth--;
    else if (list[i] === ',' && depth === 0) { parts.push(list.slice(start, i)); start = i + 1; }
  }
  parts.push(list.slice(start));
  return parts;
}

export function unscopedSelectors(css) {
  const body = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/@import[^;]+;/g, '');
  const bad = [];
  // Selector text = whatever precedes a '{' that is not an @-rule header.
  for (const m of body.matchAll(/([^{}]+)\{/g)) {
    const prelude = m[1].trim();
    if (!prelude || prelude.startsWith('@')) continue;
    for (const sel of splitTopLevel(prelude)) {
      if (!sel.trim().startsWith(SCOPE)) bad.push(sel.trim());
    }
  }
  return bad;
}

test('every style-new.css selector is scoped to the New style', () => {
  const css = readFileSync(new URL('../src/styles/style-new.css', import.meta.url), 'utf8');
  assert.deepEqual(unscopedSelectors(css), []);
});

test('the scope check catches a leaking rule', () => {
  const css = `${SCOPE} .a { color: red; }\n@media (min-width: 1px) { .leak, ${SCOPE} .b { color: red; } }`;
  assert.deepEqual(unscopedSelectors(css), ['.leak']);
});
