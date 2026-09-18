/**
 * Material presets for the cost quote — loaded at RUNTIME from an editable
 * file, never bundled (owner ask 2026-09-18: "presets can be edited in a
 * file, point the user to it; live edits in the panel never write back").
 *
 *   web / dev  → `<base>/config/materials.json` (public/config/materials.json)
 *   desktop    → `<userData>/config/materials.json`, seeded from the shipped
 *                copy on first run (electron/main.cjs `config:read`), so the
 *                user edits a plain file outside the app bundle.
 *
 * A missing or malformed file is NOT silent: the built-in fallback (one
 * generic entry) loads, `source.error` carries the reason, and CostBlock
 * shows it next to the path. Tests inject a list with `setMaterialPresets`.
 */

import { dispatch } from '../StateManager.js';
import { EVENTS } from '../events.js';

const FILE_NAME = 'materials.json';

/** @typedef {{id:string,name:string,process?:string,densityGcm3:number,pricePerGram:number,supportDensityGcm3?:number,supportPricePerGram?:number,defaultSupportPercent?:number,note?:string}} MaterialPreset */

const FALLBACK = [
  { id: 'generic', name: 'Generic (presets file missing)', process: 'Custom', densityGcm3: 1.0, pricePerGram: 0, supportDensityGcm3: 1.0, supportPricePerGram: 0, defaultSupportPercent: 0 },
];

let _materials = FALLBACK;
let _source = { kind: 'builtin', path: `config/${FILE_NAME}`, error: null, loaded: false };

/** @returns {MaterialPreset[]} the current list (fallback until loaded). */
export function getMaterialPresets() { return _materials; }

/** Where the list came from — shown in the Cost panel so the user knows what to edit. */
export function getMaterialPresetsSource() { return _source; }

/** Validate + normalise a parsed presets document. Throws on a malformed one. */
export function parseMaterialPresets(doc) {
  const list = Array.isArray(doc) ? doc : doc?.materials;
  if (!Array.isArray(list) || !list.length) throw new Error(`${FILE_NAME}: "materials" must be a non-empty array`);
  const seen = new Set();
  return list.map((m, i) => {
    if (!m || typeof m.id !== 'string' || !m.id.trim()) throw new Error(`${FILE_NAME}: materials[${i}] needs a string "id"`);
    if (seen.has(m.id)) throw new Error(`${FILE_NAME}: duplicate id "${m.id}"`);
    seen.add(m.id);
    const num = (k, fallback) => {
      const v = m[k];
      if (v == null) return fallback;
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new Error(`${FILE_NAME}: "${m.id}".${k} must be a number ≥ 0`);
      return v;
    };
    const densityGcm3 = num('densityGcm3', null);
    if (!(densityGcm3 > 0)) throw new Error(`${FILE_NAME}: "${m.id}".densityGcm3 must be > 0`);
    return {
      id: m.id,
      name: typeof m.name === 'string' && m.name.trim() ? m.name : m.id,
      process: typeof m.process === 'string' ? m.process : 'Custom',
      densityGcm3,
      pricePerGram: num('pricePerGram', 0),
      supportDensityGcm3: num('supportDensityGcm3', densityGcm3),
      supportPricePerGram: num('supportPricePerGram', num('pricePerGram', 0)),
      defaultSupportPercent: num('defaultSupportPercent', 0),
      note: typeof m.note === 'string' ? m.note : '',
    };
  });
}

/** Test / tooling seam: replace the list without touching the disk. */
export function setMaterialPresets(list, source = { kind: 'injected', path: null, error: null, loaded: true }) {
  _materials = parseMaterialPresets(list);
  _source = source;
  dispatch(EVENTS.MATERIALS_LOADED, { count: _materials.length, source: _source });
}

async function _readDesktop() {
  const api = globalThis.window?.electronAPI;
  if (typeof api?.readUserConfig !== 'function') return null;
  const res = await api.readUserConfig(FILE_NAME);
  if (!res || typeof res.text !== 'string') throw new Error(res?.error || 'desktop config read failed');
  return { text: res.text, path: res.path, kind: 'desktop' };
}

async function _readWeb() {
  const url = new URL(`config/${FILE_NAME}`, globalThis.document?.baseURI ?? globalThis.location?.href ?? 'http://localhost/');
  const res = await fetch(url.href, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${url.pathname}: HTTP ${res.status}`);
  return { text: await res.text(), path: url.pathname.replace(/^\//, ''), kind: 'web' };
}

/**
 * Load the presets once at boot. Never throws: on failure the fallback list
 * stays, the error is recorded on the source (surfaced by CostBlock) and
 * logged with the file name.
 */
export async function loadMaterialPresets() {
  let read = null;
  try {
    read = (await _readDesktop()) ?? (await _readWeb());
    _materials = parseMaterialPresets(JSON.parse(read.text));
    _source = { kind: read.kind, path: read.path, error: null, loaded: true };
  } catch (err) {
    const message = err?.message ?? String(err);
    console.error(`Material presets: could not load ${FILE_NAME} — using the built-in fallback:`, message);
    _materials = FALLBACK;
    _source = { kind: 'builtin', path: read?.path ?? `config/${FILE_NAME}`, error: message, loaded: true };
  }
  dispatch(EVENTS.MATERIALS_LOADED, { count: _materials.length, source: _source });
  return _materials;
}
