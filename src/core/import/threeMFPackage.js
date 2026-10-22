// The ONE way ThreeMFLoader reads a 3MF package: a package reader with a
// root model path, pre-parsed model parts and raw bytes for every other part.
// The app builds it from `meshImportCore.importThreeMFBuffer` (the same SAX
// pass, in the worker or inline on the main thread); tests assemble one from
// loose pieces. No Babylon, no DOM.

import { parseThreeMFXml } from './ThreeMFXml.js';
import { zipEntryTextChunks } from './zipText.js';

export const DEFAULT_MODEL_PATH = '3D/3dmodel.model';

/**
 * @typedef {object} ThreeMFPackage
 * @property {string} rootPath  clean path of the root model part
 * @property {(path: string) => Promise<{ xml: string, geometry: Map<string, object> } | null>} model
 *   pre-parsed model part at a clean path, or null when the package has none
 * @property {(path: string) => Promise<Uint8Array | null>} partBytes  any other part's bytes
 * @property {(path: string) => Promise<string | null>} partText  any other part as text
 */

/** Strip a leading slash and whitespace: OPC part names are compared clean. */
export function cleanPackagePath(path) {
  return String(path || '').trim().replace(/^\/+/, '');
}

/** Resolve a part reference against the part that holds it (absolute if it starts with `/`). */
export function resolvePackagePath(path, basePath = '') {
  const clean = cleanPackagePath(path);
  if (!clean) return '';
  if (String(path || '').trim().startsWith('/')) return clean;
  const base = cleanPackagePath(basePath);
  const slash = base.lastIndexOf('/');
  return `${slash >= 0 ? base.slice(0, slash + 1) : ''}${clean}`.replace(/\/+/g, '/');
}

/**
 * Package reader over `importThreeMFBuffer`'s result (worker transfer or inline).
 * @param {{ rootPath: string, models: { path: string, xml: string, geometry: [string, object][] }[], parts: [string, Uint8Array][] }} parsed
 * @returns {ThreeMFPackage}
 */
export function preparsedPackage(parsed) {
  const models = new Map(parsed.models.map(m => [cleanPackagePath(m.path), { xml: m.xml, geometry: new Map(m.geometry) }]));
  const parts = new Map(parsed.parts.map(([path, bytes]) => [cleanPackagePath(path), bytes]));
  return {
    rootPath: cleanPackagePath(parsed.rootPath) || DEFAULT_MODEL_PATH,
    async model(path) { return models.get(cleanPackagePath(path)) ?? null; },
    async partBytes(path) { return parts.get(cleanPackagePath(path)) ?? null; },
    async partText(path) {
      const bytes = parts.get(cleanPackagePath(path));
      return bytes ? new TextDecoder().decode(bytes) : null;
    },
  };
}

/**
 * Test seam: a package from a JSZip (or a `{ file(path) }` stand-in) plus the
 * root model's XML, parsed on demand with the same SAX parser.
 * @param {{ file(path: string): { async(type: string): Promise<any>, internalStream?: Function } | null } | null} zip
 * @param {string | AsyncIterable<string> | null} rootXml
 * @param {{ rootPath?: string, triangleLimit?: number }} [opts]
 * @returns {ThreeMFPackage}
 */
export function loosePackage(zip, rootXml, { rootPath = DEFAULT_MODEL_PATH, triangleLimit = 0 } = {}) {
  const root = cleanPackagePath(rootPath) || DEFAULT_MODEL_PATH;
  const entry = (path) => zip?.file?.(cleanPackagePath(path)) ?? null;
  return {
    rootPath: root,
    async model(path) {
      const clean = cleanPackagePath(path) || DEFAULT_MODEL_PATH;
      if (clean === root && rootXml != null) return parseThreeMFXml(rootXml, { triangleLimit });
      const file = entry(clean);
      return file ? parseThreeMFXml(zipEntryTextChunks(file), { triangleLimit }) : null;
    },
    async partBytes(path) {
      const file = entry(path);
      return file ? file.async('uint8array') : null;
    },
    async partText(path) {
      const file = entry(path);
      if (!file) return null;
      const text = await file.async('text');
      return typeof text === 'string' ? text : new TextDecoder().decode(text);
    },
  };
}
