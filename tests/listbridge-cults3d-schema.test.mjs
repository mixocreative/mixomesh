// Schema-drift guard (plan PB.3b): every GraphQL operation the Cults3D adapter can emit is parsed and
// checked against the LIVE introspection (docs/reference/cults3d-schema.json): field names, argument
// names, argument TYPES (a variable may be stricter than the argument, never looser), required
// arguments, enum literals, and every enum value the adapter can send. If Cults changes its schema and
// the introspection is regenerated (scripts/cults-introspect.mjs), this fails where the adapter drifts.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { cults3dAdapter as a, createListing } from '../src/listbridge/index.js';

const schema = JSON.parse(readFileSync(new URL('../docs/reference/cults3d-schema.json', import.meta.url), 'utf8'));
const TYPES = new Map(schema.types.map((t) => [t.name, t]));

const typeStr = (t) => (t.kind === 'NON_NULL' ? `${typeStr(t.ofType)}!` : t.kind === 'LIST' ? `[${typeStr(t.ofType)}]` : t.name);
const named = (t) => (t.ofType ? named(t.ofType) : t.name);
const enumValues = (name) => (TYPES.get(name)?.enumValues ?? []).map((v) => v.name);

/** Tokenise the small GraphQL subset the adapter emits. */
function tokens(src) {
  return src.match(/\$?[A-Za-z_][A-Za-z0-9_]*|"[^"]*"|-?\d+(?:\.\d+)?|[{}()[\]:!,]/g) ?? [];
}

/** @returns {{ vars: Record<string,string>, selections: any[] }} */
function parseOperation(src) {
  const tk = tokens(src);
  let i = 0;
  const peek = () => tk[i];
  const eat = (x) => { assert.equal(tk[i], x, `expected ${x} at token ${i} (${tk.slice(i, i + 4).join(' ')}) in:\n${src}`); i++; };
  const parseType = () => {
    let s;
    if (peek() === '[') { i++; s = `[${parseType()}]`; eat(']'); } else s = tk[i++];
    if (peek() === '!') { i++; s += '!'; }
    return s;
  };
  const parseValue = () => {
    if (peek() === '[') { i++; const out = []; while (peek() !== ']') { out.push(parseValue()); if (peek() === ',') i++; } i++; return { list: out }; }
    const v = tk[i++];
    return v.startsWith('$') ? { variable: v.slice(1) } : { literal: v };
  };
  const parseSelections = () => {
    eat('{');
    const out = [];
    while (peek() !== '}') {
      const sel = { name: tk[i++], args: {}, children: null };
      if (peek() === '(') {
        i++;
        while (peek() !== ')') { const n = tk[i++]; eat(':'); sel.args[n] = parseValue(); if (peek() === ',') i++; }
        i++;
      }
      if (peek() === '{') sel.children = parseSelections();
      out.push(sel);
    }
    eat('}');
    return out;
  };
  const kind = tk[i++];
  assert.ok(kind === 'query' || kind === 'mutation', `operation kind: ${kind}`);
  if (peek() !== '{' && peek() !== '(') i++;   // operation name
  const vars = {};
  if (peek() === '(') {
    i++;
    while (peek() !== ')') { const n = tk[i++]; eat(':'); vars[n.slice(1)] = parseType(); if (peek() === ',') i++; }
    i++;
  }
  return { kind, vars, selections: parseSelections() };
}

/** Check the selections against the schema type; collect problems. */
function checkSelections(typeName, selections, op, values, where, problems) {
  const type = TYPES.get(typeName);
  for (const sel of selections) {
    const field = type?.fields?.find((f) => f.name === sel.name);
    const here = `${where}.${sel.name}`;
    if (!field) { problems.push(`${here}: no such field on ${typeName}`); continue; }
    const argsByName = new Map(field.args.map((x) => [x.name, x]));
    for (const [argName, val] of Object.entries(sel.args)) {
      const arg = argsByName.get(argName);
      if (!arg) { problems.push(`${here}(${argName}): no such argument`); continue; }
      const want = typeStr(arg.type);
      if (val.variable) {
        const have = op.vars[val.variable];
        if (!have) { problems.push(`${here}(${argName}): variable $${val.variable} is not declared`); continue; }
        if (have !== want && have !== `${want}!`) problems.push(`${here}(${argName}): variable type ${have} is not compatible with ${want}`);
        for (const v of [].concat(values[val.variable] ?? [])) {
          const en = enumValues(named(arg.type));
          if (en.length) assert.ok(en.includes(v), `${here}(${argName}): ${JSON.stringify(v)} is not in enum ${named(arg.type)}`);
        }
      } else if (val.literal !== undefined) {
        const en = enumValues(named(arg.type));
        if (en.length && !en.includes(val.literal)) problems.push(`${here}(${argName}): literal ${val.literal} is not in enum ${named(arg.type)}`);
      }
    }
    for (const arg of field.args) {
      if (arg.type.kind === 'NON_NULL' && !(arg.name in sel.args)) problems.push(`${here}: required argument ${arg.name} is missing`);
    }
    if (sel.children) checkSelections(named(field.type), sel.children, op, values, here, problems);
    else if (['OBJECT', 'INTERFACE'].includes(TYPES.get(named(field.type))?.kind)) problems.push(`${here}: object field needs a selection set`);
  }
}

function check(spec, label) {
  const op = parseOperation(spec.body.query);
  const root = op.kind === 'mutation' ? schema.mutationType.name : schema.queryType.name;
  const problems = [];
  checkSelections(root, op.selections, op, spec.body.variables, label, problems);
  for (const v of Object.keys(spec.body.variables)) assert.ok(v in op.vars, `${label}: variable ${v} has a value but no declaration`);
  assert.deepEqual(problems, [], `${label} drifted from the live schema:\n${problems.join('\n')}`);
  return op;
}

const pkg = (over = {}) => createListing({
  title: 'T', description: 'D', tags: ['a'], price: { amount: 4, currency: 'EUR' }, license: 'cults_cu', categoryHint: '1',
  subCategoryIds: ['2'], madeWithAi: true, locale: 'en',
  images: [{ name: 'a.png', mime: 'image/png', role: 'hero', bytes: new Uint8Array(1) }],
  files: [{ name: 'd.stl', mime: 'model/stl', bytes: new Uint8Array(1) }], ...over,
});
const keyed = { files: [{ name: 'd.stl', key: 'k1' }], images: [{ name: 'a.png', key: 'k2' }] };
const linked = { files: [{ name: 'd.stl', url: 'https://t/d.stl' }], images: [{ name: 'a.png', url: 'https://t/a.png' }] };

test('createCreation / updateCreation arguments match the live schema (keys and urls)', () => {
  check(a.buildCreate(pkg(), keyed), 'createCreation(keys)');
  check(a.buildCreate(pkg(), linked), 'createCreation(urls)');
  check(a.buildCreate(pkg({ price: null, tags: [], subCategoryIds: [] }), keyed), 'createCreation(minimal)');
  check(a.buildUpdate('1', pkg(), keyed), 'updateCreation');
  check(a.buildUpdate('1', pkg({ price: null, visibility: 'public' }), keyed), 'updateCreation(minimal)');
});

test('every enum value the adapter can send exists: locales, currencies, visibility', () => {
  for (const locale of ['en', 'ja', 'zh-Hant', 'zh', 'es', 'de', 'fr', 'it', 'pt', 'tr', 'ru', 'xx', '']) {
    const op = a.buildCreate(pkg({ locale }), keyed);
    check(op, `locale ${locale}`);
    assert.ok(enumValues('LocaleEnum').includes(op.body.variables.locale), `locale ${locale} -> ${op.body.variables.locale}`);
  }
  const live = enumValues('CurrencyEnum');
  assert.deepEqual([...a.describe().currencies].sort(), [...live].sort(), 'describe().currencies must equal CurrencyEnum');
  for (const currency of a.describe().currencies) check(a.buildCreate(pkg({ price: { amount: 1, currency } }), keyed), `currency ${currency}`);
  for (const visibility of ['public', 'secret']) check(a.buildUpdate('1', pkg({ visibility }), keyed), `visibility ${visibility}`);
  assert.deepEqual(enumValues('CreationVisibilityEnum').filter((v) => ['PUBLIC', 'SECRET'].includes(v)).sort(), ['PUBLIC', 'SECRET']);
});

test('upload slot mutations, list options, confirm and connection queries match the live schema', () => {
  check(a.buildUploadSlot('file', { name: 'x' }), 'createFileUploader');
  check(a.buildUploadSlot('image', { name: 'x' }), 'createImageUploader');
  for (const locale of ['en', 'ja', 'zh-Hant']) for (const spec of a.buildListOptions({ locale })) check(spec, `listOptions ${locale}`);
  check(a.buildConfirm({ remoteId: '1', slug: 's', url: '', status: 'secret' }), 'creation(slug)');
  check(a.testConnection(), 'me');
});

test('the checker itself catches drift (guards against a vacuous pass)', () => {
  const bad = a.buildCreate(pkg(), keyed);
  bad.body.query = bad.body.query.replace('categoryId: $categoryId', 'category: $categoryId');
  assert.throws(() => check(bad, 'bad arg name'), /no such argument/);
  const loose = a.buildCreate(pkg(), keyed);
  loose.body.query = loose.body.query.replace('$name: String!', '$name: String');
  assert.throws(() => check(loose, 'loose type'), /not compatible/);
  const field = a.buildConfirm({ slug: 's' });
  field.body.query = field.body.query.replace('blueprints', 'blueprint');
  assert.throws(() => check(field, 'bad field'), /no such field/);
  const enumBad = a.buildCreate(pkg(), keyed);
  enumBad.body.variables.visibility = 'DRAFT';
  assert.throws(() => check(enumBad, 'bad enum'), /not in enum/);
});
