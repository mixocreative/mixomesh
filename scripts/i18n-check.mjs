#!/usr/bin/env node
// Verifies every t('key') call in src/ has a matching entry in en.json.
// JA / zh-Hant missing keys WARN (not fail) — translators fill incrementally.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import en from '../src/i18n/locales/en.json' with { type: 'json' };
import ja from '../src/i18n/locales/ja.json' with { type: 'json' };
import zhHant from '../src/i18n/locales/zh-Hant.json' with { type: 'json' };

const SRC = 'src';
const T_CALL = /\bt\(\s*['"]([^'"]+)['"]/g;
const DATA_KEY = /data-i18n-key=["']([^"']+)["']/g;

function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) walk(p, acc);
    else if (['.js', '.ts', '.mjs', '.html'].includes(extname(name))) acc.push(p);
  }
  return acc;
}

const used = new Set();
for (const file of walk(SRC)) {
  const text = readFileSync(file, 'utf8');
  for (const m of text.matchAll(T_CALL)) used.add(m[1]);
  for (const m of text.matchAll(DATA_KEY)) used.add(m[1]);
}
// Also scan index.html.
for (const m of readFileSync('index.html', 'utf8').matchAll(DATA_KEY)) used.add(m[1]);

let hadError = false;
const missingEn = [...used].filter(k => !(k in en));
if (missingEn.length) {
  hadError = true;
  console.error(`✗ ${missingEn.length} key(s) used in code but missing from en.json:`);
  for (const k of missingEn) console.error(`    ${k}`);
}

const warnJa = [...used].filter(k => k in en && !(k in ja));
const warnZh = [...used].filter(k => k in en && !(k in zhHant));
if (warnJa.length) console.warn(`! ${warnJa.length} key(s) missing from ja.json (fallback to EN at runtime)`);
if (warnZh.length) console.warn(`! ${warnZh.length} key(s) missing from zh-Hant.json (fallback to EN at runtime)`);

if (hadError) process.exit(1);
console.log(`✓ i18n: ${used.size} key(s) checked. ${warnJa.length + warnZh.length} translator gap(s).`);
