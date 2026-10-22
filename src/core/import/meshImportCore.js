// Worker-side import cores for STL and 3MF (heavy-mesh spec §7.3). Pure — no
// window, no Babylon — so they run in workers/MeshImport.worker.js and under
// Node tests. Results are plain objects of typed arrays plus the list of
// buffers to transfer back.

import { parseStl } from './stlParse.js';
import { createThreeMFXmlParser } from './ThreeMFXml.js';
import { zipEntryTextChunks } from './zipText.js';
import { IMPORT_LIMITS, assertImportFileSize, assertZipSafe } from './ImportLimits.js';

const DEFAULT_MODEL = '3D/3dmodel.model';

/**
 * Read a blob URL into one ArrayBuffer, reporting byte progress.
 * @param {string} url
 * @param {(e: { stage: string, fraction: number }) => void} [progress]
 */
export async function readUrl(url, progress) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not read the file (${res.status})`);
  const total = Number(res.headers.get('content-length')) || 0;
  if (!total || !res.body?.getReader) return res.arrayBuffer();
  const out = new Uint8Array(total);
  const reader = res.body.getReader();
  let at = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (at + value.length > total) throw new Error('File changed while it was being read');
    out.set(value, at);
    at += value.length;
    progress?.({ stage: 'read', fraction: at / total });
  }
  return at === total ? out.buffer : out.buffer.slice(0, at);
}

/**
 * STL bytes → welded meshes.
 * @returns {{ result: { meshes: object[] }, transfer: ArrayBuffer[] }}
 */
export function importStlBuffer(buffer, progress) {
  const meshes = parseStl(buffer, { onProgress: progress });
  const transfer = meshes.flatMap(m => [m.positions.buffer, m.normals.buffer, m.indices.buffer]);
  return { result: { meshes }, transfer };
}

/** Root model part path from `_rels/.rels` text (first 3dmodel relationship). */
export function modelPathFromRels(relsText) {
  for (const tag of String(relsText ?? '').match(/<(?:\w+:)?Relationship\b[^>]*>/g) ?? []) {
    const type = /\bType\s*=\s*["']([^"']*)["']/.exec(tag)?.[1] ?? '';
    const target = /\bTarget\s*=\s*["']([^"']*)["']/.exec(tag)?.[1];
    if (type.includes('3dmodel') && target) return target.replace(/^\//, '');
  }
  return DEFAULT_MODEL;
}

/**
 * 3MF bytes → pre-parsed model parts (geometry in typed arrays, small XML
 * skeletons) plus every other package part's bytes (textures), ready for
 * ThreeMFLoader.buildThreeMFContainerFromParsed on the main thread.
 * @param {ArrayBuffer} buffer
 * @param {{ JSZip: any, triangleLimit?: number, progress?: Function, limits?: object }} opts
 */
export async function importThreeMFBuffer(buffer, { JSZip, triangleLimit = 0, progress, limits = IMPORT_LIMITS }) {
  assertImportFileSize(buffer.byteLength, '3MF file', limits);
  const zip = await JSZip.loadAsync(buffer);
  assertZipSafe(zip, '3MF file', limits);
  const rels = zip.file('_rels/.rels');
  let rootPath = rels ? modelPathFromRels(await rels.async('text')) : DEFAULT_MODEL;
  if (!zip.file(rootPath)) rootPath = DEFAULT_MODEL;
  if (!zip.file(rootPath)) throw new Error('3MF: no 3D model part found in package');

  const names = Object.keys(zip.files).filter(n => !zip.files[n].dir);
  const modelNames = names.filter(n => /\.model$/i.test(n));
  const totalModelBytes = modelNames.reduce((s, n) => s + (zip.files[n]._data?.uncompressedSize ?? 0), 0) || 1;
  const models = [];
  const transfer = [];
  let doneBytes = 0;
  for (const name of [rootPath, ...modelNames.filter(n => n !== rootPath)]) {
    const file = zip.file(name);
    const size = file._data?.uncompressedSize ?? 0;
    const parser = createThreeMFXmlParser({ triangleLimit });
    for await (const chunk of zipEntryTextChunks(file, {
      onProgress: f => progress?.({ stage: 'parse', fraction: (doneBytes + f * size) / totalModelBytes }),
    })) parser.write(chunk);
    const parsed = parser.close();
    doneBytes += size;
    // Builder views sit on capacity buffers up to 2x their length: trim here,
    // off the UI thread, so the transfer carries no slack (review M11).
    const fit = (a) => (a.byteLength === a.buffer.byteLength ? a : a.slice());
    const geometry = [...parsed.geometry.entries()].map(([id, g]) => [id, { positions: fit(g.positions), triangles: fit(g.triangles) }]);
    for (const [, g] of geometry) transfer.push(g.positions.buffer, g.triangles.buffer);
    models.push({ path: name, xml: parsed.xml, geometry });
  }
  const parts = [];
  for (const name of names) {
    if (/\.model$/i.test(name)) continue;
    const bytes = await zip.file(name).async('uint8array');
    parts.push([name, bytes]);
    transfer.push(bytes.buffer);
  }
  return { result: { rootPath, models, parts }, transfer };
}
