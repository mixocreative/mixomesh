// Shape + version validation of a parsed .mixo document (audit 2026-09-17
// persist H1). Runs BEFORE historyClear()/resetWorld() so a bad file leaves
// the current project intact. Throws; never mutates state.

import { SCHEMA_VERSION } from './constants.js';
import { validateHierarchy } from '../hierarchy/HierarchyIntegrity.js';

// Every field loadProject iterates with `for..of` / `.map` — a string or
// number there would iterate characters or throw mid-load (after the reset).
const ARRAY_FIELDS = [
  'assetLibrary', 'sceneObjects', 'textureImages', 'shaders',
  'collections', 'groups', 'userSwatches',
];
// Fields spread or Object.entries()'d as plain objects (null = absent).
// Lists whose entries the loader dereferences by `.id` before any guard.
const ID_ENTRY_FIELDS = ['assetLibrary', 'sceneObjects', 'shaders', 'collections', 'groups'];
// Entries carrying a saved world transform the loader applies verbatim.
const TRANSFORM_ENTRY_FIELDS = ['sceneObjects', 'groups'];
const OBJECT_FIELDS = [
  'scene', 'sceneSettings', 'project', 'print', 'uvOverrides',
  'selection', 'gizmo', 'ui',
];

function _isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function _isFiniteTuple(v, n) {
  return Array.isArray(v) && v.length === n && v.every(Number.isFinite);
}

function _isTransform(t) {
  return t === undefined || t === null
    || (_isPlainObject(t) && _isFiniteTuple(t.p, 3) && _isFiniteTuple(t.q, 4) && _isFiniteTuple(t.s, 3));
}

// The loader tolerates a dangling group parent (the group restores at root),
// so only a cycle, which the roots-first walk cannot order, is refused.
function _assertAcyclicGroups(groupList) {
  const ids = new Set(groupList.map(g => g.id));
  const groups = Object.fromEntries(groupList.map(g => [
    g.id, { id: g.id, parentId: ids.has(g.parentId) ? g.parentId : null },
  ]));
  try {
    validateHierarchy({ scene: { objects: {}, groups } });
  } catch (err) {
    throw new Error(`.mixo is malformed: ${err.message}`);
  }
}

function _major(version) {
  const n = parseInt(String(version).split('.')[0], 10);
  return Number.isFinite(n) ? n : null;
}

export const SCHEMA_MAJOR = _major(SCHEMA_VERSION);

/**
 * `"3.4"` → `{ major: 3, minor: 4 }`. A missing version is a pre-versioned
 * legacy save and reads as 3.0; an unparsable one returns null (validateDocument
 * rejects those before migrate() runs).
 * @param {unknown} version
 * @returns {{ major: number, minor: number } | null}
 */
export function parseSchemaVersion(version) {
  if (version === undefined || version === null) return { major: 3, minor: 0 };
  const [maj, min] = String(version).split('.');
  const major = parseInt(maj, 10);
  const minor = min === undefined ? 0 : parseInt(min, 10);
  if (!Number.isFinite(major) || !Number.isFinite(minor)) return null;
  return { major, minor };
}

/** -1 / 0 / 1 ordering of two parsed schema versions. */
export function compareSchemaVersions(a, b) {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  return 0;
}

/** True for a doc written by a NEWER minor of this major (e.g. 3.6 when we are 3.5). */
export function isNewerMinor(version) {
  const v = parseSchemaVersion(version);
  const ours = parseSchemaVersion(SCHEMA_VERSION);
  return !!v && !!ours && v.major === ours.major && v.minor > ours.minor;
}

/**
 * Every top-level key this build reads or writes (schema 3.5, plus the legacy
 * 3.0 `scene` block). Anything else in a newer-minor document is preserved
 * verbatim and written back on save (forward compatibility, task 4.1).
 */
export const KNOWN_TOP_LEVEL_KEYS = new Set([
  'version', 'savedAt', 'project', 'sceneSettings', 'print',
  'assetLibrary', 'textureImages', 'collections', 'shaders', 'uvOverrides',
  'userSwatches', 'sceneObjects', 'groups', 'selection', 'gizmo', 'ui',
  'scene',
]);

/**
 * Unknown top-level keys of a newer-minor document, to round-trip on save.
 * Older/same-minor documents return {} — their unknown keys are legacy noise.
 * @param {Record<string, unknown>} doc
 * @returns {Record<string, unknown>}
 */
export function preservedTopLevelKeys(doc) {
  if (!_isPlainObject(doc) || !isNewerMinor(doc.version)) return {};
  const out = {};
  for (const [k, v] of Object.entries(doc)) {
    if (!KNOWN_TOP_LEVEL_KEYS.has(k)) out[k] = v;
  }
  return out;
}

/**
 * @param {unknown} doc  parsed JSON
 * @throws {Error} on a malformed document or a newer major schema version
 */
export function validateDocument(doc) {
  if (!_isPlainObject(doc)) {
    throw new Error('.mixo is malformed: document must be an object');
  }
  // Missing version = legacy (pre-versioned) save; migrate() handles it.
  if (doc.version !== undefined && doc.version !== null) {
    if (typeof doc.version !== 'string') {
      throw new Error('.mixo is malformed: version must be a string');
    }
    const major = _major(doc.version);
    if (major === null) {
      throw new Error(`.mixo is malformed: unrecognised version "${doc.version}"`);
    }
    if (major > SCHEMA_MAJOR) {
      throw new Error(`This .mixo was saved by a newer MIXOMESH (v${major}) — update the app to open it`);
    }
  }
  for (const f of OBJECT_FIELDS) {
    const v = doc[f];
    if (v !== undefined && v !== null && !_isPlainObject(v)) {
      throw new Error(`.mixo is malformed: ${f} must be an object`);
    }
  }
  for (const f of ARRAY_FIELDS) {
    const v = doc[f];
    if (v !== undefined && v !== null && !Array.isArray(v)) {
      throw new Error(`.mixo is malformed: ${f} must be an array`);
    }
  }
  for (const f of ID_ENTRY_FIELDS) {
    (doc[f] ?? []).forEach((entry, i) => {
      if (!_isPlainObject(entry) || typeof entry.id !== 'string' || !entry.id) {
        throw new Error(`.mixo is malformed: ${f}[${i}] must be an object with an id`);
      }
    });
  }
  for (const f of TRANSFORM_ENTRY_FIELDS) {
    for (const entry of doc[f] ?? []) {
      if (!_isTransform(entry.transform)) {
        throw new Error(`.mixo is malformed: ${f} "${entry.id}" has an invalid transform`);
      }
    }
  }
  _assertAcyclicGroups(doc.groups ?? []);
  for (const [i, image] of (doc.textureImages ?? []).entries()) {
    if (!_isPlainObject(image)) throw new Error(`.mixo is malformed: textureImages[${i}] must be an object`);
  }
}
