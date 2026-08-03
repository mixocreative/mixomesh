const EPSILON = 1e-9;

const normalize = vector => {
  const length = Math.hypot(vector?.x ?? 0, vector?.y ?? 0, vector?.z ?? 0);
  return length > EPSILON
    ? { x: vector.x / length, y: vector.y / length, z: vector.z / length }
    : { x: 0, y: 1, z: 0 };
};

export function dropToBedDelta(bounds) {
  return { x: 0, y: -(bounds?.min?.y ?? 0), z: 0 };
}

export function centerOnBedDelta(bounds) {
  const min = bounds?.min ?? { x: 0, z: 0 };
  const max = bounds?.max ?? min;
  return { x: -(min.x + max.x) / 2, y: 0, z: -(min.z + max.z) / 2 };
}

/** Quaternion rotating a picked world-space face normal onto world up. */
export function quaternionFromNormalToUp(normal) {
  const from = normalize(normal);
  const dot = Math.max(-1, Math.min(1, from.y));
  if (dot > 1 - EPSILON) return { x: 0, y: 0, z: 0, w: 1 };
  if (dot < -1 + EPSILON) return { x: 1, y: 0, z: 0, w: 0 };
  const cross = { x: -from.z, y: 0, z: from.x };
  const q = { ...cross, w: 1 + dot };
  const length = Math.hypot(q.x, q.y, q.z, q.w);
  return { x: q.x / length, y: q.y / length, z: q.z / length, w: q.w / length };
}

export function multiplyQuaternion(a, b) {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}

export function rotateVector(vector, quaternion) {
  const qv = { x: vector.x, y: vector.y, z: vector.z, w: 0 };
  const inverse = { x: -quaternion.x, y: -quaternion.y, z: -quaternion.z, w: quaternion.w };
  const rotated = multiplyQuaternion(multiplyQuaternion(quaternion, qv), inverse);
  return { x: rotated.x, y: rotated.y, z: rotated.z };
}
