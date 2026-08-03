const VALID_SIDES = new Set(['front', 'back']);
const DEFAULTS = Object.freeze({
  planeOffsetMM: 0,
  maleSide: 'front',
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
  const planeOffsetMM = _finite(options.planeOffsetMM, DEFAULTS.planeOffsetMM);
  const diameterMM = _positive(options.diameterMM, DEFAULTS.diameterMM);
  const depthMM = _positive(options.depthMM, DEFAULTS.depthMM);
  const clearanceMM = _nonNegative(options.clearanceMM, DEFAULTS.clearanceMM);
  return {
    maleSide,
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

/**
 * Produce the deterministic split/connector plan consumed by Babylon CSG and
 * by headless tests. The plane is viewport-first: callers pass a camera-derived
 * normal and a drag-derived offset along that normal.
 */
export function planSliceConnector(bounds, options = {}) {
  const opts = normalizeSliceConnectorOptions(options);
  const planeNormal = _normalize(options.cameraNormal, { x: 0, y: 0, z: 1 });
  const sourceCenter = _boundsCenter(bounds);
  const planeCenter = _addScaled(sourceCenter, planeNormal, opts.planeOffsetBU);
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

  const peg = B.MeshBuilder.CreateCylinder(`${namePrefix}_peg`, {
    diameter: plan.pegDiameterBU,
    height: plan.connectorLengthBU,
    tessellation: 32,
  }, scene);
  _orientLocalYTo(B, peg, plan.pegDirection);
  peg.position = _vector3(B, plan.connectorCenter);

  const socket = B.MeshBuilder.CreateCylinder(`${namePrefix}_socket`, {
    diameter: plan.socketDiameterBU,
    height: plan.connectorLengthBU + plan.clearanceBU,
    tessellation: 32,
  }, scene);
  _orientLocalYTo(B, socket, plan.pegDirection);
  socket.position = _vector3(B, plan.connectorCenter);

  for (const m of [positiveCutter, negativeCutter, peg, socket]) {
    m.metadata = { ...(m.metadata ?? {}), sliceConnectorFurniture: true };
    m.isVisible = false;
    m.isPickable = false;
  }
  return { positiveCutter, negativeCutter, peg, socket };
}
