/**
 * 3D vector helpers on plain `[x, y, z]` tuples (millimetres, world frame Y up). Every
 * function returns a new tuple and keeps the exact floating-point operation order the support
 * core was pinned with (goldens), so do not "simplify" a formula here.
 */
/** A 3D point or direction `[x, y, z]` (mm for points). */
export type Vector = [number, number, number];

/** a + b. */
export function add(a: Vector, b: Vector): Vector { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
/** a - b. */
export function subtract(a: Vector, b: Vector): Vector { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
/** v * s. */
export function scale(v: Vector, s: number): Vector { return [v[0] * s, v[1] * s, v[2] * s]; }
/** Dot product a . b. */
export function dot(a: Vector, b: Vector): number { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
/** Cross product a x b (right-handed). */
export function cross(a: Vector, b: Vector): Vector { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
/** Euclidean length of v. */
export function length(v: Vector): number { return Math.hypot(v[0], v[1], v[2]); }
/** Squared length of v (no square root). */
export function lengthSq(v: Vector): number { return v[0] * v[0] + v[1] * v[1] + v[2] * v[2]; }
/** Distance between points a and b. */
export function distance(a: Vector, b: Vector): number { return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]); }
/** Squared distance between points a and b. */
export function distanceSq(a: Vector, b: Vector): number {
  const x = a[0] - b[0], y = a[1] - b[1], z = a[2] - b[2];
  return x * x + y * y + z * z;
}

/** Unit vector along `v`; a zero-length `v` gives `fallback` (callers differ: [0, 0, 0] or down). */
export function normalize(v: Vector, fallback: Vector = [0, 0, 0]): Vector {
  const size = length(v);
  return size === 0 ? fallback : [v[0] / size, v[1] / size, v[2] / size];
}

/** Unit vector, or straight down (plate frame, Y up) for a zero-length one. */
export const normalizeOrDown = (v: Vector): Vector => normalize(v, [0, -1, 0]);
