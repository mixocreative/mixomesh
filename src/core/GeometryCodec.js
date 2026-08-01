// Compact binary codec for baked mesh geometry (ADR 0002).
//
// A destructive Boolean result has no source file — it is baked in world space
// and persisted as its OWN bytes (a synthetic `.mxvd` embedded asset). This codec
// is that byte format: positions + indices (+ optional normals), enough to rebuild
// the mesh verbatim on reload WITHOUT re-running import normalization. UVs are not
// stored (CSG2/Manifold drops them; Boolean is solid-colour only).
//
// Layout (little-endian; browsers are LE, and a .mixo is embedded+reopened in the
// same runtime class, so native typed-array order is safe):
//   'MXVD' (4 bytes) · version u32 · flags u32 (bit0 = normals present)
//   vertexCount u32 · indexCount u32
//   positions f32[vertexCount*3] · [normals f32[vertexCount*3]] · indices u32[indexCount]

const MAGIC = 0x4458564d; // 'MXVD' read little-endian as u32
const VERSION = 1;
const FLAG_NORMALS = 1;
const HEADER_BYTES = 20; // magic + version + flags + vertexCount + indexCount (5 × u32)

/**
 * @typedef {Object} GeometryData
 * @property {ArrayLike<number>} positions  Flat xyz triples (length = vertexCount*3).
 * @property {ArrayLike<number>} indices    Triangle indices (length = indexCount).
 * @property {ArrayLike<number>} [normals]  Flat xyz triples (length = vertexCount*3).
 */

/**
 * Encode baked geometry to a compact ArrayBuffer.
 * @param {GeometryData} geo
 * @returns {ArrayBuffer}
 */
export function encodeGeometry(geo) {
  const positions = geo?.positions;
  const indices = geo?.indices;
  if (!positions || !indices) throw new Error('encodeGeometry: positions and indices are required');
  if (positions.length % 3 !== 0) throw new Error('encodeGeometry: positions length must be a multiple of 3');

  const vertexCount = positions.length / 3;
  const indexCount = indices.length;
  const hasNormals = !!geo.normals && geo.normals.length === positions.length;

  const bytes = HEADER_BYTES
    + positions.length * 4
    + (hasNormals ? geo.normals.length * 4 : 0)
    + indexCount * 4;

  const buffer = new ArrayBuffer(bytes);
  const view = new DataView(buffer);
  view.setUint32(0, MAGIC, true);
  view.setUint32(4, VERSION, true);
  view.setUint32(8, hasNormals ? FLAG_NORMALS : 0, true);
  view.setUint32(12, vertexCount, true);
  view.setUint32(16, indexCount, true);

  let offset = HEADER_BYTES;
  new Float32Array(buffer, offset, positions.length).set(positions);
  offset += positions.length * 4;
  if (hasNormals) {
    new Float32Array(buffer, offset, geo.normals.length).set(geo.normals);
    offset += geo.normals.length * 4;
  }
  new Uint32Array(buffer, offset, indexCount).set(indices);
  return buffer;
}

/**
 * Decode an ArrayBuffer produced by encodeGeometry. Returns fresh typed arrays.
 * @param {ArrayBuffer} buffer
 * @returns {{ positions: Float32Array, indices: Uint32Array, normals: Float32Array|null }}
 */
export function decodeGeometry(buffer) {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < HEADER_BYTES) {
    throw new Error('decodeGeometry: not a valid geometry buffer');
  }
  const view = new DataView(buffer);
  if (view.getUint32(0, true) !== MAGIC) throw new Error('decodeGeometry: bad magic');
  const version = view.getUint32(4, true);
  if (version !== VERSION) throw new Error(`decodeGeometry: unsupported version ${version}`);
  const hasNormals = (view.getUint32(8, true) & FLAG_NORMALS) !== 0;
  const vertexCount = view.getUint32(12, true);
  const indexCount = view.getUint32(16, true);

  let offset = HEADER_BYTES;
  const positions = new Float32Array(buffer.slice(offset, offset + vertexCount * 12));
  offset += vertexCount * 12;
  let normals = null;
  if (hasNormals) {
    normals = new Float32Array(buffer.slice(offset, offset + vertexCount * 12));
    offset += vertexCount * 12;
  }
  const indices = new Uint32Array(buffer.slice(offset, offset + indexCount * 4));
  return { positions, indices, normals };
}
