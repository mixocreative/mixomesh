const VALID_SIDES = new Set(['front', 'back']);
const VALID_SHAPES = new Set(['round', 'square']);
const DEFAULTS = Object.freeze({
  planeOffsetMM: 0,
  maleSide: 'front',
  connectorShape: 'round',
  diameterMM: 6,
  depthMM: 8,
  clearanceMM: 0.2,
});
const MM_TO_BU = 0.001;
const CUTTER_MARGIN_FACTOR = 4;
const CONNECTOR_ROOT_BU = 0.001;

export const DEFAULT_SLICE_CONNECTOR_TRIANGLE_CAP = 250_000;

export function mmToBU(mm) {
  return Number(mm) * MM_TO_BU;
}

function _finite(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function _positive(value, fallback) {
  const n = _finite(value, fallback);
  return n > 0 ? n : fallback;
}

function _nonNegative(value, fallback) {
  const n = _finite(value, fallback);
  return n >= 0 ? n : fallback;
}

function _cleanNumber(n) {
  return Object.is(n, -0) || Math.abs(n) < 1e-12 ? 0 : n;
}

function _cleanVector(v) {
  return { x: _cleanNumber(v.x), y: _cleanNumber(v.y), z: _cleanNumber(v.z) };
}

function _normalize(v, fallback = { x: 0, y: 0, z: 1 }) {
  const len = Math.hypot(v?.x ?? 0, v?.y ?? 0, v?.z ?? 0);
  if (!Number.isFinite(len) || len < 1e-9) return { ...fallback };
  return _cleanVector({ x: v.x / len, y: v.y / len, z: v.z / len });
}

function _addScaled(base, dir, amount) {
  return {
    x: base.x + dir.x * amount,
    y: base.y + dir.y * amount,
    z: base.z + dir.z * amount,
  };
}

function _boundsCenter(bounds) {
  return {
    x: (bounds.min.x + bounds.max.x) / 2,
    y: (bounds.min.y + bounds.max.y) / 2,
    z: (bounds.min.z + bounds.max.z) / 2,
  };
}

function _boundsDiag(bounds) {
  return Math.hypot(
    bounds.max.x - bounds.min.x,
    bounds.max.y - bounds.min.y,
    bounds.max.z - bounds.min.z,
  );
}

/**
 * Normalize user-facing Slice & Connector dimensions. UI fields are millimetres;
 * geometry code consumes Babylon units.
 */
export function normalizeSliceConnectorOptions(options = {}) {
  const maleSide = VALID_SIDES.has(options.maleSide) ? options.maleSide : DEFAULTS.maleSide;
  const connectorShape = VALID_SHAPES.has(options.connectorShape) ? options.connectorShape : DEFAULTS.connectorShape;
  const planeOffsetMM = _finite(options.planeOffsetMM, DEFAULTS.planeOffsetMM);
  const diameterMM = _positive(options.diameterMM, DEFAULTS.diameterMM);
  const depthMM = _positive(options.depthMM, DEFAULTS.depthMM);
  const clearanceMM = _nonNegative(options.clearanceMM, DEFAULTS.clearanceMM);
  return {
    maleSide,
    connectorShape,
    planeOffsetMM,
    diameterMM,
    depthMM,
    clearanceMM,
    planeOffsetBU: mmToBU(planeOffsetMM),
    diameterBU: mmToBU(diameterMM),
    depthBU: mmToBU(depthMM),
    clearanceBU: mmToBU(clearanceMM),
  };
}

function _baseNameFromObject(source) {
  const recipeBase = source?.sliceRecipe?.baseName;
  if (typeof recipeBase === 'string' && recipeBase.trim()) return recipeBase.trim();
  return String(source?.name || 'Part').replace(/\s+-\s+Part\s+\d+$/i, '').trim() || 'Part';
}

/**
 * Allocate short stable part names for one cut. Repeated cuts keep the same
 * base name and increment the family part number instead of nesting cut labels.
 */
export function nextSlicePartNames(objects = {}, source = {}) {
  const baseName = _baseNameFromObject(source);
  let maxIndex = 0;
  const escaped = baseName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const visiblePattern = new RegExp(`^${escaped}\\s+-\\s+Part\\s+(\\d+)$`, 'i');
  for (const obj of Object.values(objects ?? {})) {
    const recipe = obj?.sliceRecipe;
    if (recipe?.baseName === baseName && Number.isInteger(recipe.partIndex)) {
      maxIndex = Math.max(maxIndex, recipe.partIndex);
    }
    const match = String(obj?.name ?? '').match(visiblePattern);
    if (match) maxIndex = Math.max(maxIndex, Number(match[1]) || 0);
  }
  const malePartIndex = maxIndex + 1;
  const femalePartIndex = maxIndex + 2;
  const fmt = n => String(n).padStart(2, '0');
  return {
    baseName,
    maleName: `${baseName} - Part ${fmt(malePartIndex)}`,
    femaleName: `${baseName} - Part ${fmt(femalePartIndex)}`,
    malePartIndex,
    femalePartIndex,
  };
}

export function findSliceRecipePair(objects = {}, objectId) {
  const selected = objects?.[objectId];
  const recipeId = selected?.sliceRecipe?.recipeId;
  if (!recipeId) return null;
  let maleId = null;
  let femaleId = null;
  for (const obj of Object.values(objects ?? {})) {
    if (obj?.sliceRecipe?.recipeId !== recipeId) continue;
    if (obj.sliceRecipe.role === 'male') maleId = obj.id;
    if (obj.sliceRecipe.role === 'female') femaleId = obj.id;
  }
  if (!maleId || !femaleId) return null;
  return { recipeId, maleId, femaleId, ids: [maleId, femaleId] };
}

/**
 * Pure preflight for Slice & Connector.
 */
export function evaluateSliceConnectorEligibility(operand, opts = {}) {
  const triangleCap = Number.isFinite(opts.triangleCap) ? opts.triangleCap : DEFAULT_SLICE_CONNECTOR_TRIANGLE_CAP;
  if ((operand?.partCount ?? 1) > 1) return { ok: false, reason: 'multi-part' };
  const totalTriangles = Number(operand?.triangles) || 0;
  if (triangleCap > 0 && totalTriangles > triangleCap) {
    return { ok: false, reason: 'too-large', totalTriangles, triangleCap };
  }
  if (!operand?.solidColor) return { ok: false, reason: 'needs-texture-bake' };
  return { ok: true, reason: 'ready', totalTriangles, triangleCap };
}

export function projectPointToPlane(point, planeCenter, planeNormal) {
  const n = _normalize(planeNormal);
  const delta = {
    x: point.x - planeCenter.x,
    y: point.y - planeCenter.y,
    z: point.z - planeCenter.z,
  };
  const d = delta.x * n.x + delta.y * n.y + delta.z * n.z;
  return _cleanVector(_addScaled(point, n, -d));
}

export function planeFromCutLine({ lineStart, lineEnd, cameraNormal }) {
  const start = {
    x: _finite(lineStart?.x, 0),
    y: _finite(lineStart?.y, 0),
    z: _finite(lineStart?.z, 0),
  };
  const end = {
    x: _finite(lineEnd?.x, 0),
    y: _finite(lineEnd?.y, 0),
    z: _finite(lineEnd?.z, 0),
  };
  const lineDirection = _normalize({
    x: end.x - start.x,
    y: end.y - start.y,
    z: end.z - start.z,
  }, { x: 1, y: 0, z: 0 });
  const cameraDir = _normalize(cameraNormal, { x: 0, y: 0, z: 1 });
  const planeNormal = _normalize({
    x: lineDirection.y * cameraDir.z - lineDirection.z * cameraDir.y,
    y: lineDirection.z * cameraDir.x - lineDirection.x * cameraDir.z,
    z: lineDirection.x * cameraDir.y - lineDirection.y * cameraDir.x,
  }, { x: 1, y: 0, z: 0 });
  return {
    lineStart: start,
    lineEnd: end,
    lineDirection,
    cameraNormal: cameraDir,
    planeNormal,
    planeCenter: _cleanVector({
      x: (start.x + end.x) / 2,
      y: (start.y + end.y) / 2,
      z: (start.z + end.z) / 2,
    }),
  };
}

/**
 * Produce the deterministic split/connector plan consumed by Babylon CSG and
 * by headless tests. The plane is viewport-first: callers pass a camera-derived
 * normal and a drag-derived offset along that normal.
 */
export function planSliceConnector(bounds, options = {}) {
  const opts = normalizeSliceConnectorOptions(options);
  const linePlane = options.lineStart && options.lineEnd
    ? planeFromCutLine({ lineStart: options.lineStart, lineEnd: options.lineEnd, cameraNormal: options.cameraNormal })
    : null;
  const planeNormal = linePlane?.planeNormal ?? _normalize(options.cameraNormal, { x: 0, y: 0, z: 1 });
  const sourceCenter = _boundsCenter(bounds);
  const baseCenter = linePlane?.planeCenter ?? sourceCenter;
  const planeCenter = _addScaled(baseCenter, planeNormal, opts.planeOffsetBU);
  const connectorOnPlane = projectPointToPlane(options.connectorPoint ?? planeCenter, planeCenter, planeNormal);
  const maleSign = opts.maleSide === 'front' ? 1 : -1;
  const pegDirection = _cleanVector({
    x: planeNormal.x * maleSign,
    y: planeNormal.y * maleSign,
    z: planeNormal.z * maleSign,
  });
  const connectorCenter = _addScaled(connectorOnPlane, pegDirection, (opts.depthBU - CONNECTOR_ROOT_BU) / 2);
  const span = Math.max(_boundsDiag(bounds), 0.001) * CUTTER_MARGIN_FACTOR;
  const connectorLengthBU = opts.depthBU + CONNECTOR_ROOT_BU;
  return {
    ...opts,
    planeCenter: _cleanVector(planeCenter),
    planeNormal,
    lineStart: linePlane?.lineStart ?? null,
    lineEnd: linePlane?.lineEnd ?? null,
    lineDirection: linePlane?.lineDirection ?? null,
    connectorPoint: connectorOnPlane,
    connectorCenter: _cleanVector(connectorCenter),
    pegDirection,
    maleSideKey: opts.maleSide,
    femaleSideKey: opts.maleSide === 'front' ? 'back' : 'front',
    connectorLengthBU,
    pegDiameterBU: opts.diameterBU,
    socketDiameterBU: opts.diameterBU + opts.clearanceBU * 2,
    positiveCutter: {
      center: _cleanVector(_addScaled(planeCenter, planeNormal, span / 2)),
      size: { x: span, y: span, z: span },
      normal: planeNormal,
    },
    negativeCutter: {
      center: _cleanVector(_addScaled(planeCenter, planeNormal, -span / 2)),
      size: { x: span, y: span, z: span },
      normal: _cleanVector({ x: -planeNormal.x, y: -planeNormal.y, z: -planeNormal.z }),
    },
  };
}

function _vector3(B, p) {
  return new B.Vector3(p.x, p.y, p.z);
}

function _orientLocalYTo(B, mesh, dir) {
  const q = new B.Quaternion();
  B.Quaternion.FromUnitVectorsToRef(B.Vector3.Up(), _vector3(B, _normalize(dir)), q);
  mesh.rotationQuaternion = q;
}

function _makeConnectorPrimitive(B, scene, name, plan, socket = false) {
  const diameter = socket ? plan.socketDiameterBU : plan.pegDiameterBU;
  const height = socket ? plan.connectorLengthBU + plan.clearanceBU : plan.connectorLengthBU;
  if (plan.connectorShape === 'square') {
    return B.MeshBuilder.CreateBox(name, { width: diameter, depth: diameter, height }, scene);
  }
  return B.MeshBuilder.CreateCylinder(name, {
    diameter,
    height,
    tessellation: 32,
  }, scene);
}

export function worldBoundsForMesh(mesh) {
  mesh.computeWorldMatrix(true);
  const bb = mesh.getBoundingInfo().boundingBox;
  return {
    min: { x: bb.minimumWorld.x, y: bb.minimumWorld.y, z: bb.minimumWorld.z },
    max: { x: bb.maximumWorld.x, y: bb.maximumWorld.y, z: bb.maximumWorld.z },
  };
}

export function createSliceConnectorMeshes(B, scene, plan, namePrefix = 'slice_connector') {
  const positiveCutter = B.MeshBuilder.CreateBox(`${namePrefix}_front_cutter`, plan.positiveCutter.size, scene);
  positiveCutter.position = _vector3(B, plan.positiveCutter.center);
  _orientLocalYTo(B, positiveCutter, plan.planeNormal);

  const negativeCutter = B.MeshBuilder.CreateBox(`${namePrefix}_back_cutter`, plan.negativeCutter.size, scene);
  negativeCutter.position = _vector3(B, plan.negativeCutter.center);
  _orientLocalYTo(B, negativeCutter, plan.planeNormal);

  const peg = _makeConnectorPrimitive(B, scene, `${namePrefix}_peg`, plan, false);
  _orientLocalYTo(B, peg, plan.pegDirection);
  peg.position = _vector3(B, plan.connectorCenter);

  const socket = _makeConnectorPrimitive(B, scene, `${namePrefix}_socket`, plan, true);
  _orientLocalYTo(B, socket, plan.pegDirection);
  socket.position = _vector3(B, plan.connectorCenter);

  for (const m of [positiveCutter, negativeCutter, peg, socket]) {
    m.metadata = { ...(m.metadata ?? {}), sliceConnectorFurniture: true };
    m.isVisible = false;
    m.isPickable = false;
  }
  return { positiveCutter, negativeCutter, peg, socket };
}
