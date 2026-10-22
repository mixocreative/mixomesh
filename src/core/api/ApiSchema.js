// ApiSchema — v1 method table + per-method param validators (ADR 0005, API.1).
// Pure ES module, no imports from app modules. Each METHODS entry carries a plain
// `validate(params)` function; `validateParams(method, params)` dispatches to it.
// Both return a normalised COPY or throw an apiError object (E_INVALID_PARAMS /
// E_LIMIT / E_METHOD_NOT_FOUND). Unknown fields are rejected.
// Path-typed params are only shape-checked here (non-empty string, no NUL); real
// path validation lives in main (`validateLaunchPath`), never in the renderer.

import { apiError } from './ApiErrors.js';

export const LIMITS = Object.freeze({
  maxImportFiles: 32,
  maxPathChars: 32767,
  maxIds: 4096,
  maxStringChars: 1024,
  maxFormats: 16,
  maxImageDim: 8192,
  maxRequestIdChars: 128,
});

export const EVENT_TYPES = Object.freeze([
  'objectAdded', 'objectRemoved', 'selectionChanged', 'validationDone',
  'exportDone', 'projectOpened', 'projectSaved', 'busy',
]);

// --- field spec builders ------------------------------------------------
const str = (o = {}) => ({ type: 'string', ...o });
const idStr = () => ({ type: 'string', required: true, nonEmpty: true });
const path = () => ({ type: 'path', required: true });
const bool = () => ({ type: 'boolean' });
const int = o => ({ type: 'integer', ...o });
const vec3 = () => ({ type: 'vec3' });
const scale = () => ({ type: 'scale' });
const obj = () => ({ type: 'object' });
const strArr = (o = {}) => ({ type: 'stringArray', ...o });

const bad = (method, field, why) =>
  apiError('E_INVALID_PARAMS', `${method}: ${field ? `"${field}" ` : ''}${why}`, field ? { field } : {});

const isPos = n => typeof n === 'number' && Number.isFinite(n) && n > 0;
const isNum = n => typeof n === 'number' && Number.isFinite(n);

function checkField(method, name, spec, v) {
  switch (spec.type) {
    case 'string':
      if (typeof v !== 'string') throw bad(method, name, 'must be a string');
      if (v.length > LIMITS.maxStringChars) throw bad(method, name, 'is too long');
      if (spec.nonEmpty && v === '') throw bad(method, name, 'must not be empty');
      return v;
    case 'path':
      if (typeof v !== 'string' || v === '') throw bad(method, name, 'must be a non-empty path string');
      if (v.length > LIMITS.maxPathChars || v.includes('\0')) throw bad(method, name, 'is not a valid path');
      return v;
    case 'boolean':
      if (typeof v !== 'boolean') throw bad(method, name, 'must be a boolean');
      return v;
    case 'integer':
      if (!Number.isInteger(v)) throw bad(method, name, 'must be an integer');
      if (spec.min != null && v < spec.min) throw bad(method, name, `must be >= ${spec.min}`);
      if (spec.max != null && v > spec.max) throw bad(method, name, `must be <= ${spec.max}`);
      return v;
    case 'vec3':
      if (!Array.isArray(v) || v.length !== 3 || !v.every(isNum)) {
        throw bad(method, name, 'must be [x, y, z] of finite numbers');
      }
      return [v[0], v[1], v[2]];
    case 'scale':
      if (isPos(v)) return v;
      if (Array.isArray(v) && v.length === 3 && v.every(isPos)) return [v[0], v[1], v[2]];
      throw bad(method, name, 'must be a positive number or [x, y, z] of positive numbers');
    case 'object':
      if (!v || typeof v !== 'object' || Array.isArray(v)) throw bad(method, name, 'must be an object');
      return { ...v };
    case 'stringArray': {
      if (!Array.isArray(v)) throw bad(method, name, 'must be an array of strings');
      const max = spec.max ?? LIMITS.maxIds;
      if (v.length > max) {
        throw apiError('E_LIMIT', `${method}: "${name}" has more than ${max} entries`, { field: name, limit: max });
      }
      if (spec.min != null && v.length < spec.min) throw bad(method, name, `needs at least ${spec.min} entries`);
      for (const s of v) {
        if (typeof s !== 'string' || s === '') throw bad(method, name, 'entries must be non-empty strings');
        const cap = spec.item === 'path' ? LIMITS.maxPathChars : LIMITS.maxStringChars;
        if (s.length > cap || (spec.item === 'path' && s.includes('\0'))) throw bad(method, name, 'has an invalid entry');
        if (spec.enum && !spec.enum.includes(s)) throw bad(method, name, `entries must be one of ${spec.enum.join('|')}`);
      }
      return v.slice();
    }
    default:
      throw bad(method, name, 'has an unsupported schema type');
  }
}

/** Build a validator from a field map; rejects unknown fields and non-object params. */
function makeValidator(method, fields, extra) {
  return function validate(params) {
    const p = params === undefined || params === null ? {} : params;
    if (typeof p !== 'object' || Array.isArray(p)) throw bad(method, '', 'params must be an object');
    for (const k of Object.keys(p)) {
      if (!Object.prototype.hasOwnProperty.call(fields, k)) throw bad(method, k, 'is not a known parameter');
    }
    const out = {};
    for (const [name, spec] of Object.entries(fields)) {
      const v = p[name];
      if (v === undefined) {
        if (spec.required) throw bad(method, name, 'is required');
        continue;
      }
      out[name] = checkField(method, name, spec, v);
    }
    if (extra) extra(out);
    return out;
  };
}

const CONFIRM = { confirm: bool() };
const needOneTransform = out => {
  if (out.position_mm === undefined && out.rotation_deg === undefined && out.scale === undefined) {
    throw bad('scene.transform', '', 'needs at least one of position_mm, rotation_deg, scale');
  }
};

// [name, params, flags, extraCheck]
const SPECS = [
  ['app.info', {}, {}],
  ['app.capabilities', {}, {}],
  ['app.ping', {}, {}],

  ['project.new', { ...CONFIRM }, { destructive: true }],
  ['project.open', { file: path(), ...CONFIRM }, { destructive: true, needsPath: true }],
  ['project.save', {}, {}],
  ['project.saveAs', { file: path(), overwrite: bool() }, { needsPath: true }],
  ['project.info', {}, {}],

  ['scene.list', { includeValidation: bool() }, {}],
  ['scene.get', { id: idStr(), includeValidation: bool() }, {}],
  ['scene.import', { files: strArr({ required: true, min: 1, max: LIMITS.maxImportFiles, item: 'path' }) }, { needsPath: true }],
  ['scene.remove', { ids: strArr({ required: true, min: 1 }), ...CONFIRM }, { destructive: true }],
  ['scene.select', { ids: strArr({ required: true }), additive: bool() }, {}],
  ['scene.transform', { id: idStr(), position_mm: vec3(), rotation_deg: vec3(), scale: scale() }, {}, needOneTransform],

  ['library.mount', { dir: path() }, { needsPath: true }],
  ['library.list', { subdir: str() }, {}],

  ['printer.list', {}, {}],
  ['printer.get', {}, {}],
  ['printer.set', { id: idStr() }, {}],

  ['validate.run', { ids: strArr() }, {}],
  ['repair.run', { ids: strArr(), ...CONFIRM }, { destructive: true }],
  ['readiness.get', {}, {}],
  ['cost.quote', { ids: strArr(), options: obj() }, {}],

  ['export.run', {
    formats: strArr({ required: true, min: 1, max: LIMITS.maxFormats }),
    outDir: path(),
    selectedOnly: bool(),
    overwrite: bool(),
    options: obj(),
  }, { needsPath: true }],

  ['render.png', {
    outFile: path(),
    width: int({ min: 16, max: LIMITS.maxImageDim }),
    height: int({ min: 16, max: LIMITS.maxImageDim }),
    preset: str(),
    overwrite: bool(),
  }, { needsPath: true }],
  ['render.thumbnail', { outFile: path(), size: int({ min: 16, max: 2048 }), overwrite: bool() }, { needsPath: true }],

  ['events.subscribe', { events: strArr({ max: EVENT_TYPES.length, enum: EVENT_TYPES }) }, {}],
];

/**
 * @typedef {{name:string, params:Record<string,object>, destructive:boolean,
 *   needsPath:boolean, since:number, validate:(params:any)=>Record<string,any>}} MethodSpec
 */
/** @type {ReadonlyArray<MethodSpec>} */
export const METHODS = Object.freeze(SPECS.map(([name, params, flags, extra]) => Object.freeze({
  name,
  params: Object.freeze({ ...params }),
  destructive: !!flags.destructive,
  needsPath: !!flags.needsPath,
  since: 1,
  validate: makeValidator(name, params, extra),
})));

const BY_NAME = new Map(METHODS.map(m => [m.name, m]));

/** @returns {MethodSpec|null} */
export function getMethod(name) {
  return typeof name === 'string' ? (BY_NAME.get(name) || null) : null;
}

export function methodNames() {
  return METHODS.map(m => m.name);
}

/**
 * Split the optional `requestId` (any method; the dispatcher answers a repeat
 * within its window with the first outcome) off `params`. Throws
 * E_INVALID_PARAMS when it is present but not a 1..128 character string.
 * @param {string} method
 * @param {unknown} params
 * @returns {{ requestId: string|null, params: unknown }}
 */
export function takeRequestId(method, params) {
  if (!params || typeof params !== 'object' || Array.isArray(params) || !('requestId' in params)) {
    return { requestId: null, params };
  }
  const { requestId, ...rest } = /** @type {Record<string, unknown>} */ (params);
  if (typeof requestId !== 'string' || requestId === '' || requestId.length > LIMITS.maxRequestIdChars) {
    throw bad(String(method).slice(0, 64), 'requestId', `must be a string of 1 to ${LIMITS.maxRequestIdChars} characters`);
  }
  return { requestId, params: rest };
}

/**
 * Validate params for `method`. Returns a normalised copy; throws an apiError.
 * @param {string} method
 * @param {unknown} params
 */
export function validateParams(method, params) {
  const m = getMethod(method);
  if (!m) throw apiError('E_METHOD_NOT_FOUND', `unknown method "${String(method).slice(0, 64)}"`);
  return m.validate(params);
}
