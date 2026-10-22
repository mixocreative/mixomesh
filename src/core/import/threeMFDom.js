// DOM-side reading of a 3MF model skeleton (the small XML ThreeMFXml keeps
// after it has pulled the geometry out): element lookups that ignore
// namespace prefixes, placement matrices and instance names.

const BABYLON = window.BABYLON;

const NS_PRODUCTION = 'http://schemas.microsoft.com/3dmanufacturing/production/2015/06';

export function localName(node) {
  return node?.localName || String(node?.tagName ?? '').split(':').pop();
}

export function directChildren(node, name) {
  const kids = node?.children ? [...node.children] : [...(node?.childNodes ?? [])].filter(n => n.nodeType === 1);
  return kids.filter(child => localName(child) === name);
}

export function firstDirect(node, name) {
  return directChildren(node, name)[0] ?? null;
}

/** Parse model XML; a parser error throws rather than yielding a partial document. */
export function parseModelXml(modelXml) {
  const doc = new DOMParser().parseFromString(modelXml, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) {
    throw new Error('3MF: malformed 3D model XML');
  }
  return doc;
}

/** `<object id>` → element, over the whole document. */
export function objectsById(doc) {
  const objects = new Map();
  for (const obj of doc.getElementsByTagName('object')) {
    objects.set(obj.getAttribute('id'), obj);
  }
  return objects;
}

/**
 * Parse a 3MF `<item>`/transform 12-tuple → Babylon row-major Matrix.
 * Absent attribute → null (caller treats as identity, the spec default);
 * a present-but-malformed value (wrong count / NaN) THROWS — a placement we
 * cannot read must not silently collapse to identity (audit F11).
 */
export function itemMatrix(transformStr, where = 'item') {
  if (transformStr == null || transformStr === '') return null;
  const n = transformStr.trim().split(/\s+/).map(Number);
  if (n.length !== 12 || n.some(x => !Number.isFinite(x))) {
    throw new Error(`3MF: malformed transform "${transformStr}" on ${where}`);
  }
  // 3MF: row-major 4×3 (rotation/scale 3×3 then translation row).
  return BABYLON.Matrix.FromValues(
    n[0], n[1], n[2], 0,
    n[3], n[4], n[5], 0,
    n[6], n[7], n[8], 0,
    n[9], n[10], n[11], 1,
  );
}

/**
 * Placement of an item/component in millimetres. The translation row is in
 * the unit of the model part that holds the element (Core §3.4: `unit`
 * covers "all vertices, locations, or measurements"), so it is scaled here;
 * the 3x3 part is unitless (cia C-06).
 */
export function matrixFor(componentOrItem, kind, unitScale) {
  const where = `${kind} objectid=${componentOrItem?.getAttribute('objectid')}`;
  const matrix = itemMatrix(componentOrItem?.getAttribute('transform'), where);
  if (!matrix) return BABYLON.Matrix.Identity();
  const m = matrix.m;
  matrix.setTranslationFromFloats(m[12] * unitScale, m[13] * unitScale, m[14] * unitScale);
  return matrix;
}

export function multiplyMatrices(a, b) {
  if (!a) return b ?? BABYLON.Matrix.Identity();
  if (!b) return a;
  return b.multiply(a);
}

/** The model part a `<component>` points at (Production extension `p:path`), or '' for its own. */
export function componentModelPath(component) {
  return component?.getAttribute('p:path')
    || component?.getAttribute('path')
    || component?.getAttributeNS?.(NS_PRODUCTION, 'path')
    || '';
}

/** `name` (or `Part_<id>`), suffixed `.002`, `.003`… for repeat instances. */
export function instanceName(obj, objectId, counts) {
  const base = obj.getAttribute('name') || `Part_${objectId}`;
  const n = (counts.get(objectId) ?? 0) + 1;
  counts.set(objectId, n);
  return n === 1 ? base : `${base}.${String(n).padStart(3, '0')}`;
}
