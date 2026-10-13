// Unit tests for ProjectValidator (task 6.6e).
//   node --import ./tests/register-hooks.mjs tests/project-validator.test.mjs

import assert from 'node:assert/strict';

const {
  validateDocument, parseSchemaVersion, compareSchemaVersions, isNewerMinor,
  preservedTopLevelKeys, KNOWN_TOP_LEVEL_KEYS, SCHEMA_MAJOR,
} = await import('../src/core/persist/ProjectValidator.js');
const { SCHEMA_VERSION } = await import('../src/core/persist/constants.js');

let passed = 0, failed = 0;
const out = [];
async function test(name, fn) {
  try { await fn(); out.push(`PASS  ${name}`); passed++; }
  catch (e) { out.push(`FAIL  ${name}\n      ${e.stack || e.message}`); failed++; }
}

const ours = parseSchemaVersion(SCHEMA_VERSION);
const nextMinor = `${ours.major}.${ours.minor + 1}`;
const nextMajor = `${ours.major + 1}.0`;

await test('accepts a minimal valid document and the current version', () => {
  assert.doesNotThrow(() => validateDocument({ version: SCHEMA_VERSION }));
  assert.doesNotThrow(() => validateDocument({
    version: SCHEMA_VERSION, sceneObjects: [], assetLibrary: [], scene: {}, ui: {},
  }));
  assert.doesNotThrow(() => validateDocument({}));   // legacy: no version
});

await test('null fields count as absent', () => {
  assert.doesNotThrow(() => validateDocument({ sceneObjects: null, scene: null, version: null }));
});

await test('rejects non-object documents', () => {
  for (const bad of [null, undefined, 42, 'str', [], true]) {
    assert.throws(() => validateDocument(bad), /malformed: document must be an object/, String(bad));
  }
});

await test('array fields reject strings, numbers and objects', () => {
  for (const f of ['assetLibrary', 'sceneObjects', 'textureImages', 'shaders', 'collections', 'groups', 'userSwatches']) {
    for (const bad of ['abc', 3, {}]) {
      assert.throws(() => validateDocument({ [f]: bad }), new RegExp(`${f} must be an array`), `${f}=${JSON.stringify(bad)}`);
    }
  }
});

await test('object fields reject arrays, strings and numbers', () => {
  for (const f of ['scene', 'sceneSettings', 'project', 'print', 'uvOverrides', 'selection', 'gizmo', 'ui']) {
    for (const bad of [[], 'x', 7]) {
      assert.throws(() => validateDocument({ [f]: bad }), new RegExp(`${f} must be an object`), `${f}=${JSON.stringify(bad)}`);
    }
  }
});

await test('version must be a string and parseable', () => {
  assert.throws(() => validateDocument({ version: 3.4 }), /version must be a string/);
  assert.throws(() => validateDocument({ version: 'abc' }), /unrecognised version "abc"/);
  assert.throws(() => validateDocument({ version: '' }), /unrecognised version/);
});

await test('refuses a newer major, accepts same/older major', () => {
  assert.throws(() => validateDocument({ version: nextMajor }), /newer MIXOMESH/);
  assert.throws(() => validateDocument({ version: '99.0' }), /newer MIXOMESH \(v99\)/);
  assert.doesNotThrow(() => validateDocument({ version: '1.0' }));
  assert.doesNotThrow(() => validateDocument({ version: `${ours.major}.0` }));
  assert.equal(SCHEMA_MAJOR, ours.major);
});

await test('accepts a newer minor of the same major', () => {
  assert.doesNotThrow(() => validateDocument({ version: nextMinor }));
  assert.doesNotThrow(() => validateDocument({ version: `${ours.major}.${ours.minor + 50}` }));
});

await test('parseSchemaVersion / compareSchemaVersions / isNewerMinor', () => {
  assert.deepEqual(parseSchemaVersion(undefined), { major: 3, minor: 0 });
  assert.deepEqual(parseSchemaVersion(null), { major: 3, minor: 0 });
  assert.deepEqual(parseSchemaVersion('4'), { major: 4, minor: 0 });
  assert.deepEqual(parseSchemaVersion('3.7'), { major: 3, minor: 7 });
  assert.equal(parseSchemaVersion('x.y'), null);
  assert.equal(compareSchemaVersions({ major: 3, minor: 1 }, { major: 3, minor: 2 }), -1);
  assert.equal(compareSchemaVersions({ major: 4, minor: 0 }, { major: 3, minor: 9 }), 1);
  assert.equal(compareSchemaVersions({ major: 3, minor: 2 }, { major: 3, minor: 2 }), 0);
  assert.equal(isNewerMinor(nextMinor), true);
  assert.equal(isNewerMinor(SCHEMA_VERSION), false);
  assert.equal(isNewerMinor(nextMajor), false);
  assert.equal(isNewerMinor('garbage'), false);
});

await test('preservedTopLevelKeys keeps unknown keys only for newer minors', () => {
  const doc = { version: nextMinor, sceneObjects: [], futureThing: { a: 1 }, other: 2 };
  assert.deepEqual(preservedTopLevelKeys(doc), { futureThing: { a: 1 }, other: 2 });
  assert.deepEqual(preservedTopLevelKeys({ ...doc, version: SCHEMA_VERSION }), {});
  assert.deepEqual(preservedTopLevelKeys(null), {});
  assert.deepEqual(preservedTopLevelKeys([]), {});
  for (const k of ['version', 'sceneObjects', 'groups', 'scene']) assert.ok(KNOWN_TOP_LEVEL_KEYS.has(k), k);
});

await test('never mutates the input document', () => {
  const doc = {
    version: nextMinor, sceneObjects: [{ id: 'a' }], scene: { x: 1 }, extra: { y: [1, 2] },
  };
  const snap = structuredClone(doc);
  validateDocument(doc);
  preservedTopLevelKeys(doc);
  assert.deepEqual(doc, snap);
  const bad = { sceneObjects: 'oops', ui: [] };
  const badSnap = structuredClone(bad);
  assert.throws(() => validateDocument(bad));
  assert.deepEqual(bad, badSnap);
});

console.log('\n' + out.join('\n'));
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
