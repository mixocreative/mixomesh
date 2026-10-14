import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  API_VERSION, ERROR_CODES, apiError, isApiError, rpcCodeFor, symbolicCodeFor,
} from '../src/core/api/ApiErrors.js';
import {
  METHODS, LIMITS, getMethod, methodNames, validateParams,
} from '../src/core/api/ApiSchema.js';

const code = fn => { try { fn(); } catch (e) { return e.data && e.data.code; } return null; };

test('API_VERSION is 1', () => assert.equal(API_VERSION, 1));

test('error codes: stable snapshot, unique numbers', () => {
  assert.deepEqual({ ...ERROR_CODES }, {
    E_INVALID_PARAMS: -32602, E_METHOD_NOT_FOUND: -32601, E_INTERNAL: -32603,
    E_NOT_FOUND: -32000, E_PATH_REJECTED: -32001, E_BUSY: -32002, E_CONFIRM_REQUIRED: -32003,
    E_DIRTY: -32004, E_CANCELLED: -32005, E_UNSUPPORTED: -32006, E_EXPORT_GATE: -32007,
    E_LIMIT: -32008, E_TIMEOUT: -32009,
  });
  const nums = Object.values(ERROR_CODES);
  assert.equal(new Set(nums).size, nums.length);
  assert.equal(Object.keys(ERROR_CODES).length, 13);
  assert.ok(Object.isFrozen(ERROR_CODES));
});

test('apiError: shape, merge, unknown code degrades to E_INTERNAL', () => {
  const e = apiError('E_NOT_FOUND', 'no such id', { id: 'x' });
  assert.deepEqual(e, { code: -32000, message: 'no such id', data: { id: 'x', code: 'E_NOT_FOUND' } });
  assert.ok(isApiError(e));
  assert.equal(apiError('E_BUSY').message, 'E_BUSY');
  const u = apiError('E_TYPO', 'x');
  assert.equal(u.code, -32603);
  assert.equal(u.data.code, 'E_INTERNAL');
  assert.equal(u.data.requestedCode, 'E_TYPO');
  assert.equal(apiError('E_BUSY', 'm', { code: 'E_FAKE' }).data.code, 'E_BUSY');
  assert.equal(rpcCodeFor('E_LIMIT'), -32008);
  assert.equal(symbolicCodeFor(-32009), 'E_TIMEOUT');
  assert.equal(symbolicCodeFor(1), null);
  assert.ok(!isApiError(new Error('x')));
});

test('every method has a validator, unique name, since 1', () => {
  const names = methodNames();
  assert.equal(new Set(names).size, names.length);
  for (const m of METHODS) {
    assert.equal(typeof m.validate, 'function', m.name);
    assert.equal(m.since, 1);
    assert.equal(typeof m.destructive, 'boolean');
    assert.equal(typeof m.needsPath, 'boolean');
    assert.equal(getMethod(m.name), m);
  }
  assert.equal(getMethod('nope'), null);
  assert.equal(getMethod(5), null);
});

test('v1 method list is pinned (publish.* absent, repair.run present)', () => {
  assert.deepEqual(methodNames().sort(), [
    'app.capabilities', 'app.info', 'app.ping', 'cost.quote', 'events.subscribe', 'export.run',
    'library.list', 'library.mount', 'printer.get', 'printer.list', 'printer.set',
    'project.info', 'project.new', 'project.open', 'project.save', 'project.saveAs',
    'readiness.get', 'render.png', 'render.thumbnail', 'repair.run',
    'scene.get', 'scene.import', 'scene.list', 'scene.remove', 'scene.select', 'scene.transform',
    'validate.run',
  ].sort());
  assert.ok(!methodNames().some(n => n.startsWith('publish.')));
});

test('destructive methods = {project.new, project.open, scene.remove, repair.run}', () => {
  assert.deepEqual(METHODS.filter(m => m.destructive).map(m => m.name).sort(),
    ['project.new', 'project.open', 'repair.run', 'scene.remove']);
});

test('needsPath methods are exactly those with path params', () => {
  assert.deepEqual(METHODS.filter(m => m.needsPath).map(m => m.name).sort(), [
    'export.run', 'library.mount', 'project.open', 'project.saveAs',
    'render.png', 'render.thumbnail', 'scene.import',
  ]);
  for (const m of METHODS) {
    const hasPath = Object.values(m.params).some(s => s.type === 'path' || s.item === 'path');
    assert.equal(m.needsPath, hasPath, m.name);
  }
});

test('unknown field rejected on every method', () => {
  for (const m of METHODS) {
    assert.equal(code(() => m.validate({ bogus: 1 })), 'E_INVALID_PARAMS', m.name);
    assert.equal(code(() => m.validate([])), 'E_INVALID_PARAMS', m.name);
    assert.equal(code(() => m.validate('x')), 'E_INVALID_PARAMS', m.name);
  }
});

test('no-param methods accept undefined / null / {}', () => {
  for (const n of ['app.info', 'app.capabilities', 'app.ping', 'project.save', 'project.info',
    'printer.list', 'printer.get', 'readiness.get']) {
    assert.deepEqual(validateParams(n, undefined), {});
    assert.deepEqual(validateParams(n, null), {});
    assert.deepEqual(validateParams(n, {}), {});
  }
});

test('validateParams: unknown method -> E_METHOD_NOT_FOUND', () => {
  assert.equal(code(() => validateParams('nope.x', {})), 'E_METHOD_NOT_FOUND');
  assert.equal(code(() => validateParams('publish.start', {})), 'E_METHOD_NOT_FOUND');
});

test('required fields and types', () => {
  assert.equal(code(() => validateParams('scene.get', {})), 'E_INVALID_PARAMS');
  assert.equal(code(() => validateParams('scene.get', { id: '' })), 'E_INVALID_PARAMS');
  assert.equal(code(() => validateParams('scene.get', { id: 5 })), 'E_INVALID_PARAMS');
  assert.deepEqual(validateParams('scene.get', { id: 'a', includeValidation: true }), { id: 'a', includeValidation: true });
  assert.equal(code(() => validateParams('project.open', {})), 'E_INVALID_PARAMS');
  assert.equal(code(() => validateParams('project.open', { file: 'a.mixo', confirm: 'yes' })), 'E_INVALID_PARAMS');
  assert.deepEqual(validateParams('project.open', { file: 'a.mixo', confirm: true }), { file: 'a.mixo', confirm: true });
  assert.equal(code(() => validateParams('library.mount', { dir: 'a\0b' })), 'E_INVALID_PARAMS');
});

test('scene.import: 1..32 files, E_LIMIT above', () => {
  assert.equal(code(() => validateParams('scene.import', { files: [] })), 'E_INVALID_PARAMS');
  assert.equal(code(() => validateParams('scene.import', { files: [''] })), 'E_INVALID_PARAMS');
  const ok = Array.from({ length: LIMITS.maxImportFiles }, (_, i) => `f${i}.stl`);
  assert.equal(validateParams('scene.import', { files: ok }).files.length, 32);
  assert.equal(code(() => validateParams('scene.import', { files: [...ok, 'x.stl'] })), 'E_LIMIT');
});

test('scene.transform: vec3, scale forms, needs one change', () => {
  assert.equal(code(() => validateParams('scene.transform', { id: 'a' })), 'E_INVALID_PARAMS');
  assert.deepEqual(validateParams('scene.transform', { id: 'a', position_mm: [1, 2, 3], scale: 2 }),
    { id: 'a', position_mm: [1, 2, 3], scale: 2 });
  assert.deepEqual(validateParams('scene.transform', { id: 'a', scale: [1, 2, 3] }).scale, [1, 2, 3]);
  for (const s of [0, -1, [1, 2], [1, 0, 1], 'x', NaN]) {
    assert.equal(code(() => validateParams('scene.transform', { id: 'a', scale: s })), 'E_INVALID_PARAMS');
  }
  assert.equal(code(() => validateParams('scene.transform', { id: 'a', rotation_deg: [0, 0] })), 'E_INVALID_PARAMS');
  assert.equal(code(() => validateParams('scene.transform', { id: 'a', position_mm: [0, 0, Infinity] })), 'E_INVALID_PARAMS');
});

test('export.run / render / events params', () => {
  assert.equal(code(() => validateParams('export.run', { outDir: 'd' })), 'E_INVALID_PARAMS');
  assert.equal(code(() => validateParams('export.run', { formats: [], outDir: 'd' })), 'E_INVALID_PARAMS');
  assert.deepEqual(validateParams('export.run', { formats: ['stl'], outDir: 'd', selectedOnly: true, options: { a: 1 } }),
    { formats: ['stl'], outDir: 'd', selectedOnly: true, options: { a: 1 } });
  assert.equal(code(() => validateParams('render.png', { outFile: 'a.png', width: 8 })), 'E_INVALID_PARAMS');
  assert.equal(code(() => validateParams('render.png', { outFile: 'a.png', width: 100.5 })), 'E_INVALID_PARAMS');
  assert.equal(validateParams('render.png', { outFile: 'a.png', width: 800, height: 600 }).width, 800);
  assert.equal(code(() => validateParams('events.subscribe', { events: ['nope'] })), 'E_INVALID_PARAMS');
  assert.deepEqual(validateParams('events.subscribe', { events: ['busy', 'exportDone'] }), { events: ['busy', 'exportDone'] });
  assert.deepEqual(validateParams('events.subscribe', {}), {});
});

test('validators return copies, not the caller objects', () => {
  const input = { ids: ['a'], confirm: true };
  const out = validateParams('scene.remove', input);
  assert.notEqual(out.ids, input.ids);
  assert.deepEqual(out, input);
  assert.equal(code(() => validateParams('scene.remove', { ids: [] })), 'E_INVALID_PARAMS');
});
