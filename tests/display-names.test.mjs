// Task 4.8 — §4.4 name-clash DISPLAY rules (rules 3–4). Pure: no Babylon.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  qualifyDisplayNames, qualifiedDisplayName, displayNameParts,
  isGenericTextureName, rawDisplayName,
} from '../src/core/assets/DisplayNames.js';

const mesh = (id, filename, extra = {}) => ({ id, kind: 'mesh', filename, name: filename.replace(/\.[^.]+$/, ''), ...extra });
const folder = (path, label = '') => ({ source: { kind: 'folder', refKey: 'dir_x', path, label } });
const lib = (...assets) => Object.fromEntries(assets.map(a => [a.id, a]));

test('a unique name is never qualified', () => {
  const L = lib(mesh('a1', 'chair.glb', folder('downloads/chair.glb')), mesh('a2', 'table.glb'));
  assert.equal(qualifiedDisplayName('a1', L), 'chair.glb');
  assert.equal(displayNameParts('a1', L).qualifier, '');
  assert.equal(qualifiedDisplayName('a2', L), 'table.glb');
});

test('same name, different folders → shortest distinguishing folder suffix (VS Code style)', () => {
  const L = lib(
    mesh('a1', 'chair.glb', folder('downloads/chair.glb')),
    mesh('a2', 'chair.glb', folder('kits/chair.glb')),
  );
  assert.equal(qualifiedDisplayName('a1', L), 'chair.glb · downloads');
  assert.equal(qualifiedDisplayName('a2', L), 'chair.glb · kits');
});

test('shared parent folder → qualifier grows until it differs', () => {
  const L = lib(
    mesh('a1', 'chair.glb', folder('a/parts/chair.glb')),
    mesh('a2', 'chair.glb', folder('b/parts/chair.glb')),
  );
  assert.equal(qualifiedDisplayName('a1', L), 'chair.glb · a/parts');
  assert.equal(qualifiedDisplayName('a2', L), 'chair.glb · b/parts');
});

test('mount label counts as the outermost folder', () => {
  const L = lib(
    mesh('a1', 'chair.glb', folder('chair.glb', 'Library')),
    mesh('a2', 'chair.glb', folder('chair.glb', 'Downloads')),
  );
  assert.equal(qualifiedDisplayName('a1', L), 'chair.glb · Library');
  assert.equal(qualifiedDisplayName('a2', L), 'chair.glb · Downloads');
});

test('ambiguity is case-insensitive', () => {
  const L = lib(mesh('a1', 'Chair.glb', folder('x/Chair.glb')), mesh('a2', 'chair.glb', folder('y/chair.glb')));
  assert.equal(qualifiedDisplayName('a1', L), 'Chair.glb · x');
  assert.equal(qualifiedDisplayName('a2', L), 'chair.glb · y');
});

test('no folder to tell them apart → #2, #3 by library order; the first stays plain', () => {
  const L = lib(mesh('a1', 'chair.glb'), mesh('a2', 'chair.glb'), mesh('a3', 'chair.glb'));
  assert.equal(qualifiedDisplayName('a1', L), 'chair.glb');
  assert.equal(qualifiedDisplayName('a2', L), 'chair.glb · #2');
  assert.equal(qualifiedDisplayName('a3', L), 'chair.glb · #3');
});

test('identical folders tie → folder plus ordinal', () => {
  const L = lib(mesh('a1', 'chair.glb', folder('dl/chair.glb')), mesh('a2', 'chair.glb', folder('dl/chair.glb')));
  assert.equal(qualifiedDisplayName('a1', L), 'chair.glb · dl');
  assert.equal(qualifiedDisplayName('a2', L), 'chair.glb · dl #2');
});

test('qualification disappears once the clash is gone', () => {
  const both = lib(mesh('a1', 'chair.glb', folder('dl/chair.glb')), mesh('a2', 'chair.glb', folder('kit/chair.glb')));
  assert.equal(qualifiedDisplayName('a1', both), 'chair.glb · dl');
  const { a2: _gone, ...rest } = both;
  assert.equal(qualifiedDisplayName('a1', rest), 'chair.glb');
});

test('stored displayName wins over filename (never renames the user file)', () => {
  const L = lib(mesh('a1', 'chair.glb', { displayName: 'kit / Cola' }));
  assert.equal(rawDisplayName(L.a1), 'kit / Cola');
  assert.equal(qualifiedDisplayName('a1', L), 'kit / Cola');
  assert.equal(L.a1.filename, 'chair.glb');
});

test('generic texture names → `<model> · <slot>`, original in the tooltip', () => {
  for (const n of ['baseColor', 'albedo.png', 'Diffuse', 'Image_0', 'texture', 'texture2', 'tex_4', 'material_1.jpg']) {
    assert.ok(isGenericTextureName(n), n);
  }
  for (const n of ['wood_baseColor', 'Image_', 'paint.png', 'textures']) assert.ok(!isGenericTextureName(n), n);
  const L = lib(
    mesh('m1', 'chair.glb'),
    { id: 't1', kind: 'texture', filename: 'Image_0', isImported: true, sourceAssetId: 'm1' },
    { id: 't2', kind: 'texture', filename: 'wood.png', isImported: true, sourceAssetId: 'm1' },
  );
  const p = displayNameParts('t1', L);
  assert.equal(p.text, 'chair · baseColor');
  assert.equal(p.generic, true);
  assert.equal(p.tooltip, 'Image_0');
  assert.equal(qualifiedDisplayName('t2', L), 'wood.png', 'a meaningful texture name is kept');
});

test('generic textures of two same-named models inherit the model folder qualifier', () => {
  const L = lib(
    mesh('m1', 'chair.glb', folder('dl/chair.glb')),
    mesh('m2', 'chair.glb', folder('kit/chair.glb')),
    { id: 't1', kind: 'texture', filename: 'Image_0', sourceAssetId: 'm1' },
    { id: 't2', kind: 'texture', filename: 'Image_0', sourceAssetId: 'm2' },
  );
  assert.equal(qualifiedDisplayName('t1', L), 'chair · baseColor · dl');
  assert.equal(qualifiedDisplayName('t2', L), 'chair · baseColor · kit');
});

test('stable across save → reload: identical result from a JSON round-trip of the library', () => {
  const L = lib(
    mesh('a1', 'chair.glb', folder('dl/chair.glb')),
    mesh('a2', 'chair.glb'),
    mesh('a3', 'chair.glb'),
    mesh('a4', 'chair.glb', folder('dl/chair.glb')),
    { id: 't1', kind: 'texture', filename: 'texture', sourceAssetId: 'a1' },
  );
  // ProjectSerializer writes assets as an ordered array; the loader rebuilds
  // the library in that order with the same persisted fields.
  const reloaded = Object.fromEntries(JSON.parse(JSON.stringify(Object.values(L))).map(a => [a.id, a]));
  const before = [...qualifyDisplayNames(L)].map(([id, d]) => [id, d.text]);
  const after = [...qualifyDisplayNames(reloaded)].map(([id, d]) => [id, d.text]);
  assert.deepEqual(after, before);
  assert.deepEqual(before, [
    ['a1', 'chair.glb · dl'], ['a2', 'chair.glb'], ['a3', 'chair.glb · #2'],
    ['a4', 'chair.glb · dl #2'], ['t1', 'chair · baseColor'],
  ]);
});

test('memoised per library object; unknown id falls back safely', () => {
  const L = lib(mesh('a1', 'x.glb'));
  assert.equal(qualifyDisplayNames(L), qualifyDisplayNames(L));
  assert.equal(displayNameParts('nope', L), null);
  assert.equal(qualifiedDisplayName('nope', L), 'nope');
  assert.equal(qualifiedDisplayName('a1', undefined), 'a1');
});
