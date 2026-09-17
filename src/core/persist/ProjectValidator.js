// Shape + version validation of a parsed .mixo document (audit 2026-09-17
// persist H1). Runs BEFORE historyClear()/resetWorld() so a bad file leaves
// the current project intact. Throws; never mutates state.

import { SCHEMA_VERSION } from './constants.js';

// Every field loadProject iterates with `for..of` / `.map` — a string or
// number there would iterate characters or throw mid-load (after the reset).
const ARRAY_FIELDS = [
  'assetLibrary', 'sceneObjects', 'textureImages', 'shaders',
  'collections', 'groups', 'userSwatches',
];
// Fields spread or Object.entries()'d as plain objects (null = absent).
const OBJECT_FIELDS = [
  'scene', 'sceneSettings', 'project', 'print', 'uvOverrides',
  'selection', 'gizmo', 'ui',
];

function _isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function _major(version) {
  const n = parseInt(String(version).split('.')[0], 10);
  return Number.isFinite(n) ? n : null;
}

export const SCHEMA_MAJOR = _major(SCHEMA_VERSION);

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
}
