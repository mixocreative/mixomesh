/**
 * 3D vector helpers on plain `[x, y, z]` tuples (millimetres, see conventions.ts). Every
 * function returns a new tuple and keeps the exact floating-point operation order the support
 * core was pinned with (goldens), so do not "simplify" a formula here.
 */
export type Vector = [number, number, number];

export function add(a: Vector, b: Vector): Vector { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
export function subtract(a: Vector, b: Vector): Vector { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
export function scale(v: Vector, s: number): Vector { return [v[0] * s, v[1] * s, v[2] * s]; }
export function dot(a: Vector, b: Vector): number { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
export function cross(a: Vector, b: Vector): Vector { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
export function length(v: Vector): number { return Math.hypot(v[0], v[1], v[2]); }
export function lengthSq(v: Vector): number { return v[0] * v[0] + v[1] * v[1] + v[2] * v[2]; }
export function distance(a: Vector, b: Vector): number { return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]); }
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
