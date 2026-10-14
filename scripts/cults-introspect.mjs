// Cults3D GraphQL introspection (plan PB.0a). The owner runs this once:
//   CULTS_USER / CULTS_API_KEY in the environment, then `node scripts/cults-introspect.mjs`.
// Writes docs/reference/cults3d-schema.json and docs/reference/cults3d-findings.md.
// Credentials come from env only and are never printed or written. <= 3 requests.
//
// Structure: pure reporter (buildFindings + helpers, driven by the unit test with a fixture)
// plus a thin main() that does the I/O.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ENDPOINT = 'https://cults3d.com/graphql';

export const INTROSPECTION_QUERY = `query IntrospectionQuery { __schema {
  queryType { name } mutationType { name }
  types { kind name description
    fields(includeDeprecated: true) { name description args { name description type { ...TypeRef } defaultValue } type { ...TypeRef } }
    inputFields { name description type { ...TypeRef } defaultValue }
    enumValues(includeDeprecated: true) { name description }
  } } }
fragment TypeRef on __Type { kind name ofType { kind name ofType { kind name ofType { kind name ofType { kind name ofType { kind name } } } } } }`;

const UPLOAD_RE = /upload|directUpload|blob|signed|presign|attachment|createSignedUrl/i;
const AI_RE = /(^|_)ai(_|$)|^ai[A-Z]|[a-z]Ai$|generated|artificial/;
const VIS_RE = /visib|draft|publish|status/i;
const DESC_RE = /descri|markdown|html/i;
const RATE_RE = /^(x-ratelimit|ratelimit|retry-after)/i;

export function typeStr(t) {
  if (!t) return '?';
  if (t.kind === 'NON_NULL') return `${typeStr(t.ofType)}!`;
  if (t.kind === 'LIST') return `[${typeStr(t.ofType)}]`;
  return t.name ?? '?';
}
export function namedType(t) {
  while (t && !t.name && t.ofType) t = t.ofType;
  return t?.name ?? null;
}

function index(schema) {
  const byName = new Map((schema.types ?? []).map((t) => [t.name, t]));
  return { byName, query: byName.get(schema.queryType?.name), mutation: byName.get(schema.mutationType?.name) };
}

const field = (type, name) => type?.fields?.find((f) => f.name === name);
const code = (s) => `\`${s}\``;

/** Flatten an argument/input-field list, recursing into INPUT_OBJECTs (depth-limited, cycle-safe). */
function flattenInputs(byName, items, prefix = '', seen = new Set(), depth = 0) {
  const rows = [];
  for (const it of items ?? []) {
    const p = prefix + it.name;
    rows.push({ path: p, type: typeStr(it.type), name: it.name, named: namedType(it.type) });
    const nt = byName.get(namedType(it.type));
    if (nt?.kind === 'INPUT_OBJECT' && depth < 4 && !seen.has(nt.name)) {
      rows.push(...flattenInputs(byName, nt.inputFields, p + '.', new Set([...seen, nt.name]), depth + 1));
    }
  }
  return rows;
}

function enumValues(byName, row) {
  const e = byName.get(row.named);
  return e?.kind === 'ENUM' ? (e.enumValues ?? []).map((v) => v.name) : null;
}

const table = (rows, fmt) => (rows.length ? rows.map(fmt).join('\n') : '_none found_');

function sigOf(f) {
  const args = (f.args ?? []).map((a) => `${a.name}: ${typeStr(a.type)}`).join(', ');
  return `${f.name}(${args}): ${typeStr(f.type)}`;
}

export function sectionMutations(schema) {
  const { byName, mutation } = index(schema);
  const out = ['## 1. createCreation / updateCreation'];
  for (const name of ['createCreation', 'updateCreation']) {
    const f = field(mutation, name);
    out.push(`### ${name}`);
    if (!f) { out.push('_mutation not found_'); continue; }
    out.push(code(sigOf(f)), '');
    const rows = flattenInputs(byName, f.args);
    out.push(table(rows, (r) => {
      const ev = enumValues(byName, r);
      return `- ${code(r.path)}: ${code(r.type)}${ev ? ` (enum: ${ev.join(', ')})` : ''}`;
    }));
    const vis = rows.filter((r) => VIS_RE.test(r.name));
    out.push('', `Visibility / draft / published args: ${vis.length ? vis.map((r) => code(r.path)).join(', ') : '_none_'}`);
    const desc = rows.filter((r) => DESC_RE.test(r.name));
    out.push(`Description-format fields: ${desc.length ? desc.map((r) => `${code(r.path)} (${r.type})`).join(', ') : '_none_'}`, '');
  }
  return out.join('\n');
}

export function sectionPricing(schema) {
  const { byName, query, mutation } = index(schema);
  const out = ['## 2. Price, license, categories, tags'];
  const rows = [];
  for (const n of ['createCreation', 'updateCreation']) {
    const f = field(mutation, n);
    if (f) rows.push(...flattenInputs(byName, f.args).map((r) => ({ ...r, mut: n })));
  }
  const pick = (re) => rows.filter((r) => re.test(r.name));
  const show = (title, list) => {
    out.push(`### ${title}`);
    out.push(table(list, (r) => {
      const ev = enumValues(byName, r);
      return `- ${r.mut}.${code(r.path)}: ${code(r.type)}${ev ? ` (enum: ${ev.join(', ')})` : ''}`;
    }));
  };
  show('Price / currency / minimum', pick(/price|currency|amount|cents|minimum|min/i));
  show('License', pick(/licen[sc]e/i));
  show('Category / subcategory', pick(/categor/i));
  show('Tags (type; any limit is not visible in introspection)', pick(/tag/i));
  const cat = field(query, 'categories');
  out.push('### categories query', cat ? code(sigOf(cat)) : '_no `categories` query_');
  const lic = [...byName.values()].filter((t) => t.kind === 'ENUM' && /licen[sc]e/i.test(t.name));
  out.push('### License enum types', table(lic, (t) => `- ${code(t.name)}: ${(t.enumValues ?? []).map((v) => v.name).join(', ')}`), '');
  return out.join('\n');
}

export function sectionAi(schema) {
  const out = ['## 3. AI-related inputs/fields'];
  const hits = [];
  for (const t of schema.types ?? []) {
    if (t.name?.startsWith('__')) continue;
    for (const f of t.inputFields ?? []) if (AI_RE.test(f.name)) hits.push(`${t.name}.${f.name}: ${typeStr(f.type)}`);
    for (const f of t.fields ?? []) {
      if (AI_RE.test(f.name)) hits.push(`${t.name}.${f.name}: ${typeStr(f.type)}`);
      for (const a of f.args ?? []) if (AI_RE.test(a.name)) hits.push(`${t.name}.${f.name}(${a.name}: ${typeStr(a.type)})`);
    }
  }
  out.push(table(hits, (h) => `- ${code(h)}`), '');
  return out.join('\n');
}

export function sectionUpload(schema) {
  const out = ['## 4. Native upload path'];
  const hits = [];
  for (const t of schema.types ?? []) {
    if (t.name?.startsWith('__')) continue;
    for (const f of t.fields ?? []) {
      if (UPLOAD_RE.test(f.name)) hits.push(`${t.name}.${sigOf(f)}`);
    }
    for (const f of t.inputFields ?? []) {
      if (UPLOAD_RE.test(f.name)) hits.push(`${t.name} (input).${f.name}: ${typeStr(f.type)}`);
    }
  }
  out.push(table(hits, (h) => `- ${code(h)}`));
  out.push('', hits.length
    ? 'Verdict: native upload candidates exist; PB.3b builds on them and the tunnel becomes a fallback.'
    : 'Verdict: no native upload path found; the tunnel stays the default.', '');
  return out.join('\n');
}

export function sectionReadBack(schema) {
  const { byName, query } = index(schema);
  const out = ['## 5. Read-back queries'];
  const names = ['me', 'myCreations', 'creations', 'creation'];
  out.push(table(names.map((n) => field(query, n)).filter(Boolean), (f) => `- ${code(sigOf(f))}`));
  const missing = names.filter((n) => !field(query, n));
  if (missing.length) out.push(`Not present: ${missing.join(', ')}`);
  const cr = byName.get('Creation');
  out.push('### Creation status fields (files / images / state)');
  out.push(table((cr?.fields ?? []).filter((f) => /file|image|status|state|publish|visib|ingest|process/i.test(f.name)),
    (f) => `- ${code(`${f.name}: ${typeStr(f.type)}`)}`), '');
  return out.join('\n');
}

export function sectionRateLimits(headers) {
  const out = ['## 6. Rate-limit headers'];
  const entries = Object.entries(headers ?? {}).filter(([k]) => RATE_RE.test(k));
  out.push(table(entries, ([k, v]) => `- ${code(k)}: ${code(v)}`), '');
  return out.join('\n');
}

/** Pure: introspection JSON ({data:{__schema}} or the schema itself) -> findings markdown. */
export function buildFindings(introspection, { headers = {}, generatedAt = null } = {}) {
  const schema = introspection?.data?.__schema ?? introspection?.__schema ?? introspection;
  if (!schema?.types) throw new Error('introspection result has no __schema.types');
  return [
    '# Cults3D GraphQL findings',
    '',
    `Generated by scripts/cults-introspect.mjs${generatedAt ? ` on ${generatedAt}` : ''}. Contains no credentials.`,
    '',
    sectionMutations(schema), sectionPricing(schema), sectionAi(schema),
    sectionUpload(schema), sectionReadBack(schema), sectionRateLimits(headers),
  ].join('\n');
}

export function readCredentials(env) {
  const user = env.CULTS_USER;
  const key = env.CULTS_API_KEY;
  return user && key ? { user, key } : null;
}

async function gql(fetchImpl, creds, query) {
  const auth = Buffer.from(`${creds.user}:${creds.key}`).toString('base64');
  const res = await fetchImpl(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Basic ${auth}` },
    body: JSON.stringify({ query }),
  });
  const headers = {};
  res.headers.forEach((v, k) => { headers[k] = v; });
  if (!res.ok) throw new Error(`Cults3D HTTP ${res.status}`);
  return { json: await res.json(), headers };
}

export async function main(env = process.env, fetchImpl = globalThis.fetch) {
  const creds = readCredentials(env);
  if (!creds) {
    console.error('Set CULTS_USER and CULTS_API_KEY in your shell, then re-run (no request was made).');
    return 2;
  }
  const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'reference');
  const intro = await gql(fetchImpl, creds, INTROSPECTION_QUERY);
  if (intro.json.errors) throw new Error('introspection returned GraphQL errors');
  let headers = intro.headers;
  // Optional probe requests (<= 3 total); failures are non-fatal.
  for (const q of ['query { me { __typename } }', 'query { categories { __typename } }']) {
    try {
      const r = await gql(fetchImpl, creds, q);
      headers = { ...headers, ...r.headers };
    } catch { /* optional */ }
  }
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'cults3d-schema.json'), JSON.stringify(intro.json.data.__schema, null, 2));
  fs.writeFileSync(path.join(outDir, 'cults3d-findings.md'),
    buildFindings(intro.json, { headers, generatedAt: new Date().toISOString().slice(0, 10) }));
  console.log('Wrote docs/reference/cults3d-schema.json and cults3d-findings.md');
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((c) => { process.exitCode = c; }, (e) => { console.error(`Failed: ${e.message}`); process.exitCode = 1; });
}
