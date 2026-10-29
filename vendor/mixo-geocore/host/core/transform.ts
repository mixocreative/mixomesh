import type { Vector } from './vec3';

/**
 * Rigid placement of an object: translation in mm, then rotation as Euler angles in radians,
 * order 'XYZ' (world frame Y up, right-handed). The matrix is `T · R`, R = Rx · Ry · Rz. Rigid only, no
 * scale: `applyToDirection` uses the linear part as is (not the inverse transpose), which is right
 * only for rotation matrices; a scaled matrix would give wrong normals.
 */
export interface Placement {
  position: Vector;
  rotation: Vector;
}

/** 4×4 matrix, column-major (element `[col * 4 + row]`), the layout three.js and Babylon use. */
export type Matrix4 = Float64Array;
