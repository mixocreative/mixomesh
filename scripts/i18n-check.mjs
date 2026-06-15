#!/usr/bin/env node
// Verifies every t('key') / data-i18n-key use has a matching locale entry.
// Also flags hardcoded visible UI text inside src/ui markup strings.
// JA / zh-Hant missing keys WARN (not fail) — translators fill incrementally.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import en from '../src/i18n/locales/en.json' with { type: 'json' };
import ja from '../src/i18n/locales/ja.json' with { type: 'json' };
import zhHant from '../src/i18n/locales/zh-Hant.json' with { type: 'json' };

const SRC = 'src';
const T_CALL = /\b(?:t|_txt|_attr)\(\s*['"]([^'"]+)['"]/g;
const DATA_KEY = /data-i18n-(?:key|title|aria-label|placeholder)=["']([^"']+)["']/g;
const LABEL_KEY = /\blabelKey:\s*['"]([^'"]+)['"]/g;
const INLINE_TEXT = />\s*([^<>{}`]*[A-Za-z][^<>{}`]*)\s*</g;
const ATTR_TEXT = /\b(?:title|aria-label|placeholder)=["']([^"']*[A-Za-z][^"']*)["']/g;
const UI_LITERAL_ALLOW_LINE = [
  /\b<title>/,
  /\bid=["']project-name["']/,
  /<option[^>]*value=["'](?:x|y)["'][^>]*>[XY]</,
  /<span class=["']np-axis/,
  /<strong>\$\{/,
];
const INLINE_TEXT_ALLOW_LINE = [/\bdata-i18n-key=/];

function isCommentOrNonMarkupLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return true;
  if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return true;
  return !/<[a-z][\w:-]*\b/i.test(line) && !/\b(?:title|aria-label|placeholder)=/.test(line);
}

function isDynamicTemplateValue(value) {
  return value.includes('${') || value.includes('t(') || value.includes('escape');
}

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
const hardcodedUi = [];
for (const file of walk(SRC)) {
  const text = readFileSync(file, 'utf8');
  for (const m of text.matchAll(T_CALL)) used.add(m[1]);
  for (const m of text.matchAll(DATA_KEY)) used.add(m[1]);
  for (const m of text.matchAll(LABEL_KEY)) used.add(m[1]);
  if (file.replace(/\\/g, '/').startsWith('src/ui/')) {
    const lines = text.split(/\r?\n/);
    lines.forEach((line, idx) => {
      if (isCommentOrNonMarkupLine(line)) return;
      if (UI_LITERAL_ALLOW_LINE.some(re => re.test(line))) return;
      if (!INLINE_TEXT_ALLOW_LINE.some(re => re.test(line))) {
        for (const m of line.matchAll(INLINE_TEXT)) {
          const value = m[1].trim();
          if (value && !isDynamicTemplateValue(value)) hardcodedUi.push(`${file}:${idx + 1}: ${value}`);
        }
      }
      const attrLine = line.replace(/\bdata-i18n-(?:title|aria-label|placeholder)=["'][^"']*["']/g, '');
      for (const m of attrLine.matchAll(ATTR_TEXT)) {
        const value = m[1].trim();
        if (value && !isDynamicTemplateValue(value)) hardcodedUi.push(`${file}:${idx + 1}: ${value}`);
      }
    });
  }
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

if (hardcodedUi.length) {
  hadError = true;
  console.error(`✗ ${hardcodedUi.length} hardcoded UI text literal(s) in src/ui:`);
  for (const item of hardcodedUi) console.error(`    ${item}`);
}

const warnJa = [...used].filter(k => k in en && !(k in ja));
const warnZh = [...used].filter(k => k in en && !(k in zhHant));
if (warnJa.length) console.warn(`! ${warnJa.length} key(s) missing from ja.json (fallback to EN at runtime)`);
if (warnZh.length) console.warn(`! ${warnZh.length} key(s) missing from zh-Hant.json (fallback to EN at runtime)`);

if (hadError) process.exit(1);
console.log(`✓ i18n: ${used.size} key(s) checked. ${warnJa.length + warnZh.length} translator gap(s).`);
