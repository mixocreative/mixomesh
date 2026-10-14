import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LISTBRIDGE_FORMAT, createListing, validateListing, planBundle, toManifest, fromManifest, assertAdapter,
} from '../src/listbridge/index.js';

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`# PASS  ${name}`); passed++; }
  catch (err) { console.log(`# FAIL  ${name}\n      ${err.stack || err.message}`); failed++; }
}

const b = (...n) => new Uint8Array(n);
const good = (over = {}) => createListing({
  title: 'Dragon', description: '# hi', tags: ['a'], price: { amount: 5, currency: 'usd' },
  images: [{ name: 'h.png', mime: 'image/png', bytes: b(1), role: 'hero' }],
  files: [{ name: 'm.stl', mime: 'model/stl', bytes: b(1, 2) }], ...over,
});
const codes = (p, l) => validateListing(p, l).map((i) => i.code);

await test('createListing normalises tags, currency, defaults', () => {
  const p = createListing({ title: '  T  ', tags: [' Foo ', 'foo', '', 'Bar', '  '], price: { amount: 3, currency: ' eur ' } });
  assert.equal(p.listbridge, LISTBRIDGE_FORMAT);
  assert.equal(p.title, 'T');
  assert.deepEqual(p.tags, ['Foo', 'Bar']);
  assert.deepEqual(p.price, { amount: 3, currency: 'EUR' });
  assert.equal(p.locale, 'en');
  assert.equal(p.license, null);
  assert.equal(p.madeWithAi, false);
  assert.equal(createListing({}).price, null);
});

await test('valid listing has no issues', () => assert.deepEqual(validateListing(good()), []));
await test('title rules', () => {
  assert.ok(codes(good({ title: '  ' })).includes('title-empty'));
  assert.ok(codes(good({ title: 'x'.repeat(121) })).includes('title-too-long'));
  assert.ok(!codes(good({ title: 'x'.repeat(5) }), { maxTitle: 5 }).includes('title-too-long'));
});
await test('description required', () => assert.ok(codes(good({ description: ' ' })).includes('description-empty')));
await test('tag count and length', () => {
  assert.ok(codes(good({ tags: Array.from({ length: 21 }, (_, i) => `t${i}`) })).includes('tags-too-many'));
  assert.ok(codes(good({ tags: ['x'.repeat(41)] })).includes('tag-too-long'));
});
await test('price rules', () => {
  assert.ok(codes(good({ price: { amount: -1, currency: 'USD' } })).includes('price-invalid'));
  assert.ok(codes(good({ price: { amount: NaN, currency: 'USD' } })).includes('price-invalid'));
  assert.ok(codes(good({ price: { amount: 1.234, currency: 'USD' } })).includes('price-precision'));
  assert.deepEqual(codes(good({ price: { amount: 19.99, currency: 'USD' } })), []);
  assert.deepEqual(codes(good({ price: { amount: 0, currency: 'USD' } })), []);
  assert.ok(codes(good({ price: { amount: 1, currency: 'US' } })).includes('currency-invalid'));
  assert.ok(codes(good(), { currencies: ['EUR'] }).includes('currency-unsupported'));
  assert.deepEqual(codes(good(), { currencies: ['USD'] }), []);
  assert.deepEqual(codes(good({ price: null })), []);
});
await test('images: required, hero, max', () => {
  assert.ok(codes(good({ images: [] })).includes('images-none'));
  const mk = (role, n) => ({ name: n, mime: 'image/png', bytes: b(1), role });
  assert.ok(codes(good({ images: [mk('gallery', 'a.png')] })).includes('hero-count'));
  assert.ok(codes(good({ images: [mk('hero', 'a.png'), mk('hero', 'b.png')] })).includes('hero-count'));
  assert.ok(!codes(good({ images: [mk('gallery', 'a.png')] }), { requireHero: false }).includes('hero-count'));
  const many = Array.from({ length: 11 }, (_, i) => mk(i ? 'gallery' : 'hero', `i${i}.png`));
  assert.ok(codes(good({ images: many })).includes('images-too-many'));
  assert.ok(!codes(good({ images: many }), { maxImages: 11 }).includes('images-too-many'));
});
await test('files: required, unique, safe; over maxFiles is not an issue', () => {
  const f = (name) => ({ name, mime: 'x', bytes: b(1) });
  assert.ok(codes(good({ files: [] })).includes('files-none'));
  assert.ok(codes(good({ files: [f('A.stl'), f('a.STL')] })).includes('file-name-duplicate'));
  for (const bad of ['a/b.stl', 'a\\b.stl', '..', 'a..b', 'a\u0001b', '']) {
    assert.ok(codes(good({ files: [f(bad)] })).includes('file-name-unsafe'), JSON.stringify(bad));
  }
  const many = Array.from({ length: 30 }, (_, i) => f(`f${i}.stl`));
  assert.deepEqual(codes(good({ files: many }), { maxFiles: 10 }), []);
});

await test('planBundle both branches', () => {
  const files = Array.from({ length: 3 }, (_, i) => ({ name: `f${i}`, mime: 'x', bytes: b(1) }));
  const under = planBundle(files, 3);
  assert.equal(under.loose.length, 3);
  assert.deepEqual(under.bundles, []);
  const over = planBundle(files, 2);
  assert.equal(over.loose.length, 0);
  assert.equal(over.bundles.length, 1);
  assert.equal(over.bundles[0].name, 'files.zip');
  assert.equal(over.bundles[0].files.length, 3);
  assert.equal(planBundle(files, 2, { zipName: 'pack.zip' }).bundles[0].name, 'pack.zip');
});

await test('manifest round-trip', async () => {
  const p = good({ license: 'CC-BY', madeWithAi: true, categoryHint: 'toys', locale: 'ja' });
  const m = JSON.parse(JSON.stringify(toManifest(p)));
  assert.equal(m.images[0].path, 'images/h.png');
  assert.equal(m.files[0].path, 'files/m.stl');
  assert.equal(m.files[0].size, 2);
  assert.ok(!('bytes' in m.files[0]));
  const store = { 'images/h.png': b(1), 'files/m.stl': b(1, 2) };
  const back = await fromManifest(m, async (pth) => store[pth]);
  assert.equal(back.images[0].name, 'h.png');
  assert.deepEqual(back.files[0].bytes, b(1, 2));
  assert.deepEqual(toManifest(back), toManifest(p));
});
await test('fromManifest rejects future format and junk', async () => {
  await assert.rejects(() => fromManifest({ listbridge: 2 }, () => b()), /future format 2/);
  await assert.rejects(() => fromManifest({}, () => b()), /format version/);
  await assert.rejects(() => fromManifest(null, () => b()), /not an object/);
});

await test('assertAdapter', () => {
  const fn = () => {};
  const ok = { describe: fn, validate: fn, buildCreate: fn, buildUpdate: fn, parseResult: fn };
  assert.equal(assertAdapter(ok), ok);
  assert.doesNotThrow(() => assertAdapter({ ...ok, listCategories: fn }));
  assert.throws(() => assertAdapter({ describe: fn }), /validate, buildCreate, buildUpdate, parseResult/);
  assert.throws(() => assertAdapter({ ...ok, listCategories: 1 }), /listCategories/);
  assert.throws(() => assertAdapter(null), /object/);
});

await test('portability: src/listbridge is self-contained', () => {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'listbridge');
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.js') ? [path.join(d, e.name)] : []);
  const files = walk(root);
  assert.ok(files.length >= 3);
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    const specs = [
      ...[...src.matchAll(/\bfrom\s*['"]([^'"]+)['"]/g)].map((m) => m[1]),
      ...[...src.matchAll(/\bimport\s*['"]([^'"]+)['"]/g)].map((m) => m[1]),
      ...[...src.matchAll(/import\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1]),
    ];
    for (const s of specs) {
      assert.ok(s.startsWith('./') || s.startsWith('../'), `${file}: non-relative import ${s}`);
      const target = path.resolve(path.dirname(file), s);
      assert.ok(target.startsWith(root + path.sep), `${file}: import escapes src/listbridge: ${s}`);
    }
    const hit = src.match(/\b(window|document|fetch|Blob|require|process)\b/);
    assert.equal(hit, null, `${file}: references ${hit && hit[0]}`);
  }
});


await test('fromManifest never passes a manifest path to the reader (traversal)', async () => {
  const seen = [];
  const read = (p) => { seen.push(p); return new Uint8Array([1]); };
  const m = { listbridge: 1, title: 't', description: 'd', images: [{ name: 'a.png', mime: 'image/png', role: 'hero', path: '../../../etc/passwd' }], files: [{ name: 'm.stl', mime: 'model/stl', path: 'files/../../secret' }] };
  await fromManifest(m, read);
  assert.deepEqual(seen, ['images/a.png', 'files/m.stl']);
  let threw = false;
  try { await fromManifest({ ...m, files: [{ name: '../x.stl', mime: 'model/stl' }] }, read); } catch { threw = true; }
  assert.ok(threw, 'unsafe entry name rejected');
});

console.log(`# ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
