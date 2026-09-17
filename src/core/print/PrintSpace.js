/**
 * PrintSpace — the ONE axis + winding seam between Babylon and every print
 * file format (3MF, STL, OBJ-via-Babylon, and the 3MF loader).
 *
 * Babylon scene: LEFT-handed, Y-up. Print formats (3MF Core §3, STL, slicer
 * beds): RIGHT-handed, Z-up, millimetres (PrintPrep already bakes mm).
 *
 * Ground truth (verified 2026-09-17 with a PrusaSlicer 2.9.3-written 3MF and
 * trimesh, tests/fixtures/prusa-tetra.3mf): a glTF vertex (x, y, z) arrives in
 * Babylon as (-x, y, z) — Babylon's glTF loader bakes a reflection for the
 * left-handed scene — and must leave for a slicer as (x, -z, y). Composing
 * the two gives the map below. It is IMPROPER (det = -1): a reflection, not a
 * rotation, because the handedness flips. That is why triangle winding must
 * be handled per mesh (see {@link printIndices}) rather than by a blanket
 * reversal, and why the previous RotationX(±90°) + unconditional flip shipped
 * mirrored, upside-down parts.
 */

const CLOCKWISE = 0;   // BABYLON.Material.ClockWiseSideOrientation

/** Determinant sign of the Babylon → print-space map. Always -1 (reflection). */
export const PRINT_MAP_DET = -1;

/** Babylon (x, y, z) → print space [x', y', z'] (right-handed, Z-up). */
export function toPrintSpace(x, y, z) {
  return [0 - x, 0 - z, y];   // `0 - v` keeps -0 out of the file
}

/** Print space (x, y, z) → Babylon [x', y', z'] (left-handed, Y-up). */
export function fromPrintSpace(x, y, z) {
  return [0 - x, z, 0 - y];
}

/**
 * Babylon draws a mesh's front faces clockwise when its effective side
 * orientation is ClockWise (material.sideOrientation overrides
 * mesh.sideOrientation when non-null — Material._getEffectiveOrientation).
 * Babylon's glTF loader tags meshes ClockWise in left-handed scenes; native
 * meshes and every other loader leave the default (CounterClockWise).
 */
export function frontFaceIsClockwise(mesh) {
  const matSide = mesh?.material?.sideOrientation;
  const side = matSide != null ? matSide
    : (mesh?.overrideMaterialSideOrientation ?? mesh?.sideOrientation);
  return side === CLOCKWISE;
}

/**
 * Index list to write into a right-handed file so triangles come out
 * counter-clockwise-outward (3MF Core §4.1.3 / STL convention).
 *
 * The map is a reflection, so it reverses apparent winding. Babylon's own
 * convention is that a CounterClockWise-flagged outward mesh has NEGATIVE
 * signed volume in the right-handed formula (verified on
 * MeshBuilder.CreateBox), and the reflection flips that positive — so
 * CounterClockWise-flagged meshes are written as-is and ClockWise-flagged
 * meshes (glTF imports) are reversed. This is exactly the rule Babylon's OBJ
 * serializer applies for its own (x-negating, also improper) map.
 *
 * @param {object} mesh Babylon mesh (or duck-typed test mesh)
 * @returns {number[]} a NEW array; the mesh's buffer is never mutated
 */
export function printIndices(mesh) {
  const idx = mesh.getIndices?.() ?? [];
  const out = new Array(idx.length);
  if (frontFaceIsClockwise(mesh)) {
    for (let i = 0; i + 2 < idx.length; i += 3) {
      out[i] = idx[i]; out[i + 1] = idx[i + 2]; out[i + 2] = idx[i + 1];
    }
  } else {
    for (let i = 0; i < idx.length; i++) out[i] = idx[i];
  }
  return out;
}

/**
 * Signed volume (right-handed formula, sum of tetrahedra to the origin).
 * Positive ⇒ counter-clockwise-outward in a right-handed space. O(triangles).
 */
export function signedVolume(positions, indices) {
  let v6 = 0;
  for (let i = 0; i + 2 < indices.length; i += 3) {
    const a = indices[i] * 3, b = indices[i + 1] * 3, c = indices[i + 2] * 3;
    const ax = positions[a], ay = positions[a + 1], az = positions[a + 2];
    const bx = positions[b], by = positions[b + 1], bz = positions[b + 2];
    const cx = positions[c], cy = positions[c + 1], cz = positions[c + 2];
    v6 += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
  }
  return v6 / 6;
}

/**
 * Convert a mesh's position buffer into print space.
 * @param {ArrayLike<number>} positions Babylon xyz triples (already mm-baked)
 * @returns {Float32Array} print-space xyz triples
 */
export function positionsToPrintSpace(positions) {
  const out = new Float32Array(positions.length);
  for (let i = 0; i + 2 < positions.length; i += 3) {
    const [x, y, z] = toPrintSpace(positions[i], positions[i + 1], positions[i + 2]);
    out[i] = x; out[i + 1] = y; out[i + 2] = z;
  }
  return out;
}
