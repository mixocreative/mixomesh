// Keep mesh coordinates out of the XML DOM. A compressed 17 MB relief can
// contain millions of XML elements; representing those as DOM nodes exhausts
// browser memory before Babylon ever sees the geometry.
//
// Heavy-mesh spec §4: the parser is push-based (`createThreeMFXmlParser`) so a
// model part can be streamed in decoded chunks and never becomes one JS string
// (V8's ~2^29-character limit made 10M-triangle 3MFs unloadable). Triangles are
// packed Int32 (7 fields, 28 B/triangle; was 56 B Float64).
import { SaxesParser } from 'saxes';
import { assertTriangleCapacity } from './ImportLimits.js';

const CHUNK_CHARS = 128 * 1024;
const CORE_NS = 'http://schemas.microsoft.com/3dmanufacturing/core/2015/02';
const TRIANGLE_FIELDS = ['v1', 'v2', 'v3', 'pid', 'p1', 'p2', 'p3'];

function bufferBuilder(Type = Float64Array) {
  let data = new Type(4096);
  let length = 0;
  return {
    push(value) {
      if (length === data.length) {
        const next = new Type(data.length * 2);
        next.set(data);
        data = next;
      }
      data[length++] = value;
    },
    finish() { return data.subarray(0, length); },
  };
}

function escapeXmlText(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeXml(value) {
  return escapeXmlText(value).replace(/"/g, '&quot;')
    .replace(/\r/g, '&#13;').replace(/\n/g, '&#10;').replace(/\t/g, '&#9;');
}

function numericAttribute(attributes, name, optional = false) {
  const raw = attributes[name]?.value;
  if (raw == null) {
    if (optional) return -1;
    throw new Error(`3MF: missing ${name} in mesh geometry`);
  }
  const value = raw.trim() === '' ? NaN : Number(raw);
  if (!Number.isFinite(value) || (!['x', 'y', 'z'].includes(name)
      && (!Number.isSafeInteger(value) || value < 0 || value > 0x7fffffff))) {
    throw new Error(['x', 'y', 'z'].includes(name)
      ? `3MF: non-numeric coordinate ${name} in mesh geometry`
      : `3MF: invalid ${name} in mesh geometry`);
  }
  return value;
}

/**
 * Push parser: feed decoded text with write(chunk), then close() → result.
 * Geometry goes into packed typed arrays; only the small XML skeleton
 * (resources, materials, build, components) is kept as text.
 * @param {{ triangleBudget?: number }} [opts]
 * @returns {{ write(chunk: string): void, close(): { xml: string, geometry: Map<string, { positions: Float64Array, triangles: Int32Array }> } }}
 */
export function createThreeMFXmlParser({ triangleBudget = 0 } = {}) {
  const parser = new SaxesParser({ xmlns: true });
  const skeleton = [];
  const geometry = new Map();
  const stack = [];
  let objectId = null;
  let mesh = null;
  let suppressed = 0;
  let triangleCount = 0;
  parser.on('doctype', () => { throw new Error('3MF: XML document types are not supported'); });
  parser.on('opentag', node => {
    const core = !node.uri || node.uri === CORE_NS;
    const name = core ? node.local : node.name;
    const parent = stack.at(-1);
    stack.push(name);
    if (core && name === 'object' && parent === 'resources') objectId = node.attributes.id?.value;
    if (core && name === 'mesh' && parent === 'object') {
      if (objectId == null || geometry.has(objectId)) throw new Error('3MF: missing or duplicate mesh object id');
      mesh = { positions: bufferBuilder(Float64Array), triangles: bufferBuilder(Int32Array) };
      geometry.set(objectId, mesh);
    }
    if (suppressed) {
      suppressed++;
      if (core && name === 'vertex' && parent === 'vertices') {
        for (const field of ['x', 'y', 'z']) mesh.positions.push(numericAttribute(node.attributes, field));
      } else if (core && name === 'triangle' && parent === 'triangles') {
        assertTriangleCapacity(++triangleCount, triangleBudget, '3MF model');
        for (const field of TRIANGLE_FIELDS) mesh.triangles.push(numericAttribute(node.attributes, field, field[0] === 'p'));
      }
      return;
    }
    if (mesh && core && (name === 'vertices' || name === 'triangles') && parent === 'mesh') {
      suppressed = 1;
      return;
    }
    skeleton.push(`<${name}`);
    for (const attr of Object.values(node.attributes)) skeleton.push(` ${attr.name}="${escapeXml(attr.value)}"`);
    skeleton.push('>');
  });
  parser.on('closetag', () => {
    const name = stack.pop();
    if (suppressed) { suppressed--; return; }
    skeleton.push(`</${name}>`);
    if (name === 'mesh' && mesh) {
      geometry.set(objectId, { positions: mesh.positions.finish(), triangles: mesh.triangles.finish() });
      mesh = null;
    }
    if (name === 'object') objectId = null;
  });
  // Attribute whitespace needs references; document whitespace must stay literal.
  // A character reference before/after the root is invalid XML in browser DOMParser.
  const onText = text => { if (!suppressed) skeleton.push(escapeXmlText(text)); };
  parser.on('text', onText);
  parser.on('cdata', onText);
  return {
    write(chunk) { parser.write(chunk); },
    close() {
      parser.close();
      return { xml: skeleton.join(''), geometry };
    },
    get triangles() { return triangleCount; },
  };
}

/**
 * Parse geometry into packed numbers and return only small XML resources/hierarchy.
 * @param {string | AsyncIterable<string>} source  whole XML text, or decoded chunks
 */
export async function parseThreeMFXml(source, { triangleBudget = 0, yieldControl = () => new Promise(resolve => setTimeout(resolve, 0)) } = {}) {
  const push = createThreeMFXmlParser({ triangleBudget });
  if (typeof source === 'string') {
    for (let offset = 0; offset < source.length; offset += CHUNK_CHARS) {
      push.write(source.slice(offset, offset + CHUNK_CHARS));
      if (offset + CHUNK_CHARS < source.length) await yieldControl();
    }
  } else {
    for await (const chunk of source) push.write(chunk);
  }
  return push.close();
}
