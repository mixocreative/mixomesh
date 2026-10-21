// STL → welded, indexed geometry (heavy-mesh spec §4, §7.3). Mirrors Babylon's
// STLFileLoader conventions exactly — binary/ASCII detection, file (x, y, z) →
// Babylon (x, z, y), corner order kept, mesh name `stlmesh` for binary and the
// solid name for ASCII — so placement, export and goldens do not move. What
// differs: vertices are welded (Uint32 indices) and normals are crease-aware
// instead of one copy of the file normal per corner (84 → ~20 B/triangle).
// ASCII is decoded in chunks, never as one string. Pure; worker + Node tests.

import { weldPositions, creaseNormals } from './weld.js';

const HEADER = 84;
const FACET = 50;
const ASCII_CHUNK = 8 * 1024 * 1024;

/** Babylon's STLFileLoader._isBinary rule. */
export function isBinaryStl(bytes) {
  if (bytes.byteLength <= 80) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const faces = view.getUint32(80, true);
  if (HEADER + faces * FACET === bytes.byteLength) return true;
  const solid = [115, 111, 108, 105, 100];
  for (let i = 0; i < 5; i++) if (bytes[i] !== solid[i]) return true;
  return false;
}

/** Binary facets → corner soup in Babylon space. */
export function binaryStlSoup(bytes, onProgress) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const faces = Math.min(view.getUint32(80, true), Math.floor((bytes.byteLength - HEADER) / FACET));
  const soup = new Float32Array(faces * 9);
  let o = 0;
  for (let f = 0; f < faces; f++) {
    const s = HEADER + f * FACET + 12;
    for (let k = 0; k < 3; k++) {
      const v = s + k * 12;
      soup[o] = view.getFloat32(v, true);
      soup[o + 1] = view.getFloat32(v + 8, true);
      soup[o + 2] = view.getFloat32(v + 4, true);
      o += 3;
    }
    if (onProgress && (f & 0xfffff) === 0) onProgress(f / faces);
  }
  return soup;
}

function floatBuilder() {
  let data = new Float32Array(1 << 16);
  let length = 0;
  return {
    push3(a, b, c) {
      if (length + 3 > data.length) {
        const next = new Float32Array(data.length * 2);
        next.set(data);
        data = next;
      }
      data[length] = a; data[length + 1] = b; data[length + 2] = c;
      length += 3;
    },
    get length() { return length; },
    finish() { return data.slice(0, length); },
  };
}

/** ASCII solids → [{ name, soup }] in Babylon space, decoded chunk by chunk. */
export function asciiStlSolids(bytes, onProgress) {
  const decoder = new TextDecoder();
  const solids = [];
  let current = null;
  let carry = '';
  const line = (raw) => {
    const text = raw.trim();
    if (text.startsWith('vertex')) {
      if (!current) current = { name: 'stlmesh', soup: floatBuilder() };
      const parts = text.split(/\s+/);
      current.soup.push3(Number(parts[1]), Number(parts[3]), Number(parts[2]));
    } else if (text.startsWith('endsolid')) {
      if (current) solids.push(current);
      current = null;
    } else if (text.startsWith('solid')) {
      if (current) solids.push(current);
      current = { name: text.split(/\s+/)[1] || 'stlmesh', soup: floatBuilder() };
    }
  };
  for (let off = 0; off < bytes.byteLength; off += ASCII_CHUNK) {
    const end = Math.min(bytes.byteLength, off + ASCII_CHUNK);
    const text = carry + decoder.decode(bytes.subarray(off, end), { stream: end < bytes.byteLength });
    const lines = text.split('\n');
    carry = lines.pop();
    for (const l of lines) line(l);
    onProgress?.(end / bytes.byteLength);
  }
  if (carry) line(carry);
  if (current) solids.push(current);
  return solids
    .map(s => ({ name: s.name, soup: s.soup.finish() }))
    .filter(s => s.soup.length >= 9)
    .map(s => ({ name: s.name, soup: s.soup.length % 9 ? s.soup.slice(0, s.soup.length - (s.soup.length % 9)) : s.soup }));
}

/**
 * Parse an STL into welded meshes.
 * @param {ArrayBuffer|Uint8Array} data
 * @param {{ creaseDeg?: number, onProgress?: (e: { stage: string, fraction: number }) => void }} [opts]
 * @returns {{ name: string, positions: Float32Array, normals: Float32Array, indices: Uint32Array }[]}
 */
export function parseStl(data, { creaseDeg = 40, onProgress } = {}) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const report = (stage, lo, hi) => (f) => onProgress?.({ stage, fraction: lo + (hi - lo) * f });
  const solids = isBinaryStl(bytes)
    ? [{ name: 'stlmesh', soup: binaryStlSoup(bytes, report('parse', 0, 0.3)) }]
    : asciiStlSolids(bytes, report('parse', 0, 0.3));
  const out = [];
  for (const { name, soup } of solids) {
    const welded = weldPositions(soup, { onProgress: report('weld', 0.3, 0.65) });
    const shaded = creaseNormals(welded.positions, welded.indices, { creaseDeg, onProgress: report('normals', 0.65, 1) });
    out.push({ name, ...shaded });
  }
  onProgress?.({ stage: 'normals', fraction: 1 });
  return out;
}
