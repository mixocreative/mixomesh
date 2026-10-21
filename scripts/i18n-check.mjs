#!/usr/bin/env node
// Verifies every t('key') / data-i18n-key use has a matching locale entry.
// Flags hardcoded visible UI text inside src/ui markup strings, and
// hard-coded English passed to a user-facing sink (toast, progress overlay,
// progress callbacks) anywhere under src/, core included.
// JA / zh-Hant missing keys WARN (not fail) — translators fill incrementally.
//   node scripts/i18n-check.mjs

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import en from '../src/i18n/locales/en.json' with { type: 'json' };
import ja from '../src/i18n/locales/ja.json' with { type: 'json' };
import zhHant from '../src/i18n/locales/zh-Hant.json' with { type: 'json' };

const SRC = 'src';
const MIN_KEYS_CHECKED = 200;
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

// Calls whose string arguments the user reads. A literal passed here must be a
// t() key, not English.
const SINK_CALL = /\b(?:Toast\.(?:show|error|info|success|warn)|ProgressOverlay\.(?:update|show)|onProgress\??\.?|progress|_overlayUpdate|reportError)\(/g;
const KEY_LIKE = /^[a-z][\w-]*(?:\.[\w-]+)+$/;
const NON_TEXT_ARGS = new Set(['info', 'error', 'warn', 'warning', 'success', 'loading']);

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

/** Hard-coded text in src/ui markup strings: `file:line: text` per offender. */
export function findHardcodedMarkup(text, file) {
  const found = [];
  text.split(/\r?\n/).forEach((line, idx) => {
    if (isCommentOrNonMarkupLine(line)) return;
    if (UI_LITERAL_ALLOW_LINE.some(re => re.test(line))) return;
    if (!INLINE_TEXT_ALLOW_LINE.some(re => re.test(line))) {
      for (const m of line.matchAll(INLINE_TEXT)) {
        const value = m[1].trim();
        if (value && !isDynamicTemplateValue(value)) found.push(`${file}:${idx + 1}: ${value}`);
      }
    }
    const attrLine = line.replace(/\bdata-i18n-(?:title|aria-label|placeholder)=["'][^"']*["']/g, '');
    for (const m of attrLine.matchAll(ATTR_TEXT)) {
      const value = m[1].trim();
      if (value && !isDynamicTemplateValue(value)) found.push(`${file}:${idx + 1}: ${value}`);
    }
  });
  return found;
}

/** Top-level comma-separated arguments of the call whose "(" precedes `from`. */
function callArguments(text, from) {
  const args = [];
  let depth = 0, quote = null, start = from;
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
    } else if (c === "'" || c === '"' || c === '`') quote = c;
    else if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) {
      if (depth === 0) { args.push(text.slice(start, i)); return args; }
      depth--;
    } else if (c === ',' && depth === 0) { args.push(text.slice(start, i)); start = i + 1; }
  }
  return args;
}

const WHOLE_LITERAL = /^\s*(['"`])((?:\\.|(?!\1).)*)\1\s*$/;
const TERNARY_LITERALS = /\?\s*(['"`])((?:\\.|(?!\1).)*)\1\s*:\s*(['"`])((?:\\.|(?!\3).)*)\3\s*$/;

function userFacingText(value) {
  const v = value.replace(/\$\{[^}]*\}/g, '').trim();
  if (!/[A-Za-z]{3,}/.test(v) || KEY_LIKE.test(v) || NON_TEXT_ARGS.has(v)) return null;
  const interpolated = v !== value.trim();
  return interpolated || /\s|^[A-Z]|…/.test(v) ? v : null;
}

/**
 * English literals passed as a whole argument to a toast / progress sink:
 * `file:line: text` per offender. t()/tr() results, key-shaped strings, toast
 * type words and non-literal arguments (protocol objects, variables) are fine.
 */
export function findHardcodedSinkText(text, file) {
  const found = [];
  const lines = text.split(/\r?\n/);
  const lineOf = pos => text.slice(0, pos).split('\n').length;
  for (const call of text.matchAll(SINK_CALL)) {
    const line = lineOf(call.index);
    const source = lines[line - 1] ?? '';
    if (/^\s*(\/\/|\*|\/\*)/.test(source)) continue;
    if (/^\s*(?:export\s+)?(?:async\s+)?function\b/.test(source)) continue;
    for (const arg of callArguments(text, call.index + call[0].length)) {
      const whole = arg.match(WHOLE_LITERAL);
      const ternary = whole ? null : arg.match(TERNARY_LITERALS);
      const candidates = whole ? [whole[2]] : ternary ? [ternary[2], ternary[4]] : [];
      for (const raw of candidates) {
        const value = userFacingText(raw);
        if (value) found.push(`${file}:${line}: ${value}`);
      }
    }
  }
  return found;
}

function scan() {
  const used = new Set();
  const hardcodedUi = [];
  const hardcodedSinks = [];
  for (const file of walk(SRC)) {
    const text = readFileSync(file, 'utf8');
    const rel = file.replace(/\\/g, '/');
    for (const m of text.matchAll(T_CALL)) used.add(m[1]);
    for (const m of text.matchAll(DATA_KEY)) used.add(m[1]);
    for (const m of text.matchAll(LABEL_KEY)) used.add(m[1]);
    if (rel.startsWith('src/ui/')) hardcodedUi.push(...findHardcodedMarkup(text, file));
    if (!rel.startsWith('src/i18n/')) hardcodedSinks.push(...findHardcodedSinkText(text, file));
  }
  for (const m of readFileSync('index.html', 'utf8').matchAll(DATA_KEY)) used.add(m[1]);
  return { used, hardcodedUi, hardcodedSinks };
}

function main() {
  const { used, hardcodedUi, hardcodedSinks } = scan();
  let hadError = false;
  const missingEn = [...used].filter(k => !(k in en));
  if (missingEn.length) {
    hadError = true;
    console.error(`✗ ${missingEn.length} key(s) used in code but missing from en.json:`);
    for (const k of missingEn) console.error(`    ${k}`);
  }

  if (used.size < MIN_KEYS_CHECKED) {
    hadError = true;
    console.error(`✗ only ${used.size} key(s) found (floor ${MIN_KEYS_CHECKED}): the scanner is blind, not clean`);
  }

  if (hardcodedUi.length) {
    hadError = true;
    console.error(`✗ ${hardcodedUi.length} hardcoded UI text literal(s) in src/ui:`);
    for (const item of hardcodedUi) console.error(`    ${item}`);
  }

  if (hardcodedSinks.length) {
    hadError = true;
    console.error(`✗ ${hardcodedSinks.length} hardcoded English string(s) passed to a toast/progress sink (use t('key')):`);
    for (const item of hardcodedSinks) console.error(`    ${item}`);
  }

  const warnJa = [...used].filter(k => k in en && !(k in ja));
  const warnZh = [...used].filter(k => k in en && !(k in zhHant));
  if (warnJa.length) console.warn(`! ${warnJa.length} key(s) missing from ja.json (fallback to EN at runtime)`);
  if (warnZh.length) console.warn(`! ${warnZh.length} key(s) missing from zh-Hant.json (fallback to EN at runtime)`);

  if (hadError) process.exit(1);
  console.log(`✓ i18n: ${used.size} key(s) checked. ${warnJa.length + warnZh.length} translator gap(s).`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
