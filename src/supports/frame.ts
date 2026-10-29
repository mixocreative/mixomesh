/**
 * Support frame adapter: the ONLY handedness seam between the mixomesh scene and the support
 * engine (plan 2026-10-29 D9, D10; the other two seams are ImportNormalizer and PrintSpace).
 *
 *   Babylon world   left-handed, Y up, scene units (1 BU = 1 m, `MM_PER_BU` = ExportContext `BU_TO_MM`)
 *   engine frame    right-handed, Y up, millimetres (mixo-geocore `generate`, placement, goldens)
 *
 * Positions: (x, y, z) BU -> (x, y, -z) * MM_PER_BU mm, and back. Normals: (x, y, z) -> (x, y, -z).
 * The map is a reflection (det -1), so it reverses apparent triangle winding. Which index order is
 * "outward" on the Babylon side depends on the mesh's effective front face, exactly like
 * PrintSpace.printIndices: glTF imports are tagged ClockWise, native meshes CounterClockWise, and a
 * mirrored world matrix flips it again (Babylon flips culling for det < 0). So the rule, both
 * directions, is: swap indices 1<->2 of every triangle when the Babylon side is clockwise-front,
 * keep them when it is counter-clockwise-front. Engine meshes are counter-clockwise-outward in a
 * right-handed frame (positive signed volume). Verified empirically, not by this reasoning
 * (tests/browser-support-spike.mjs: signed volumes + trimesh + cull on/off screenshots).
 *
 * Also the geometry-only weld: mixomesh splits textured meshes at UV / colour seams, and the engine
 * keys edges by vertex index, so the copy sent to the engine is welded by position (UVs dropped).
 */
import type { TriangleMesh } from '@mixo-geocore/host/core/analysis/types';
import { MM_PER_BU } from '../core/scene/SceneConstants.js';

export type Vec3 = [number, number, number];

/** Babylon scene units to engine millimetres (ExportContext.js `BU_TO_MM`, SceneConstants `MM_PER_BU`). */
export const ENGINE_MM_PER_BU: number = MM_PER_BU;

/**
 * Weld and snap grid in engine mm (1 um). Seam duplicates come from one source vertex, so they match
 * far closer than this; float32 metre storage is good to ~0.03 um across a 300 mm bed.
 */
export const WELD_CELL_MM = 1e-3;

export function pointToEngine([x, y, z]: Readonly<Vec3>): Vec3 {
  return [x * ENGINE_MM_PER_BU, y * ENGINE_MM_PER_BU, 0 - z * ENGINE_MM_PER_BU];
}

export function pointFromEngine([x, y, z]: Readonly<Vec3>): Vec3 {
  return [x / ENGINE_MM_PER_BU, y / ENGINE_MM_PER_BU, 0 - z / ENGINE_MM_PER_BU];
}

/** Directions carry no unit; the reflection is its own inverse. */
export function normalToEngine([x, y, z]: Readonly<Vec3>): Vec3 {
  return [x, y, 0 - z];
}

export const normalFromEngine = normalToEngine;

/** Babylon world positions (BU) -> engine positions (mm). */
export function positionsToEngine(positions: ArrayLike<number>): Float32Array {
  const out = new Float32Array(positions.length);
  for (let i = 0; i + 2 < positions.length; i += 3) {
    out[i] = positions[i]! * ENGINE_MM_PER_BU;
    out[i + 1] = positions[i + 1]! * ENGINE_MM_PER_BU;
    out[i + 2] = 0 - positions[i + 2]! * ENGINE_MM_PER_BU;
  }
  return out;
}

/** Engine positions (mm) -> Babylon world positions (BU). */
export function positionsFromEngine(positions: ArrayLike<number>): Float32Array {
  const out = new Float32Array(positions.length);
  for (let i = 0; i + 2 < positions.length; i += 3) {
    out[i] = positions[i]! / ENGINE_MM_PER_BU;
    out[i + 1] = positions[i + 1]! / ENGINE_MM_PER_BU;
    out[i + 2] = 0 - positions[i + 2]! / ENGINE_MM_PER_BU;
  }
  return out;
}

/**
 * Index list across the seam: a copy, with indices 1 and 2 of every triangle swapped when the
 * Babylon side is clockwise-front. The same call converts in both directions.
 */
export function indicesAcross(indices: ArrayLike<number>, babylonClockwise: boolean): Uint32Array {
  const out = Uint32Array.from(indices);
  if (!babylonClockwise) return out;
  for (let i = 0; i + 2 < out.length; i += 3) {
    const b = out[i + 1]!;
    out[i + 1] = out[i + 2]!;
    out[i + 2] = b;
  }
  return out;
}

/** One Babylon mesh of a logical object, world space (BU), with its effective front face. */
export interface BabylonPart {
  positions: ArrayLike<number>;
  indices: ArrayLike<number>;
  /** Effective front face is clockwise: PrintSpace.frontFaceIsClockwise(mesh) XOR det(world) < 0. */
  clockwise: boolean;
}

/** A logical object in the engine frame, welded by position. */
export interface EngineModel {
  mesh: TriangleMesh;
  /** Engine face k came from face `sourceFace[k]` of the parts concatenated in order. */
  sourceFace: Uint32Array;
  /** Vertices before the weld (all parts). */
  sourceVertices: number;
}

/** The parts of one logical object, moved into the engine frame, concatenated and welded by position. */
export function partsToEngine(parts: readonly BabylonPart[]): EngineModel {
  let vertices = 0;
  let indexCount = 0;
  for (const part of parts) {
    vertices += part.positions.length / 3;
    indexCount += part.indices.length;
  }
  const positions = new Float32Array(vertices * 3);
  const indices = new Uint32Array(indexCount);
  let vOff = 0;
  let iOff = 0;
  for (const part of parts) {
    positions.set(positionsToEngine(part.positions), vOff * 3);
    const across = indicesAcross(part.indices, part.clockwise);
    for (let i = 0; i < across.length; i++) indices[iOff + i] = across[i]! + vOff;
    vOff += part.positions.length / 3;
    iOff += across.length;
  }
  const welded = weldByPosition({ positions, indices });
  return { mesh: welded.mesh, sourceFace: welded.sourceFace, sourceVertices: vertices };
}

/**
 * Merge vertices that share a position (grid `cellMm`), geometry only, and snap every vertex to the
 * grid. Snapping removes the sub-micron noise of the scene's float32 metre storage (a glTF corner at
 * 5 mm reaches the engine as 5.0000005): placement samples on exact edges and corners, so without it
 * the same model gave other contacts in the browser than in the goldens (48 vs 62 on cube-overhang).
 * Triangles that collapse are dropped; `sourceFace` maps each kept face to its input face. Open
 * addressing over the quantized coordinates (exact compare), so a dense scan costs no string keys.
 */
export function weldByPosition(mesh: TriangleMesh, cellMm = WELD_CELL_MM): { mesh: TriangleMesh; sourceFace: Uint32Array } {
  const { positions, indices } = mesh;
  const n = positions.length / 3;
  const q = new Float64Array(n * 3);
  for (let i = 0; i < n * 3; i++) q[i] = Math.round(positions[i]! / cellMm);
  let size = 1;
  while (size < n * 2) size <<= 1;
  const table = new Int32Array(size).fill(-1);
  const remap = new Uint32Array(n);
  const out: number[] = [];
  const canon: number[] = [];
  for (let i = 0; i < n; i++) {
    const x = q[i * 3]!, y = q[i * 3 + 1]!, z = q[i * 3 + 2]!;
    let h = (Math.imul(x | 0, 73856093) ^ Math.imul(y | 0, 19349663) ^ Math.imul(z | 0, 83492791)) & (size - 1);
    for (;;) {
      const slot = table[h]!;
      if (slot < 0) {
        table[h] = canon.length;
        remap[i] = canon.length;
        canon.push(i);
        out.push(x * cellMm, y * cellMm, z * cellMm);
        break;
      }
      const c = canon[slot]!;
      if (q[c * 3] === x && q[c * 3 + 1] === y && q[c * 3 + 2] === z) {
        remap[i] = slot;
        break;
      }
      h = (h + 1) & (size - 1);
    }
  }
  const kept: number[] = [];
  const faces: number[] = [];
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const a = remap[indices[t]!]!, b = remap[indices[t + 1]!]!, c = remap[indices[t + 2]!]!;
    if (a === b || b === c || c === a) continue;
    kept.push(a, b, c);
    faces.push(t / 3);
  }
  return { mesh: { positions: new Float32Array(out), indices: new Uint32Array(kept) }, sourceFace: new Uint32Array(faces) };
}

/** An engine-frame mesh (mm) as Babylon world geometry (BU) for a mesh drawn with the given front face. */
export function meshFromEngine(mesh: TriangleMesh, babylonClockwise = false): { positions: Float32Array; indices: Uint32Array } {
  return { positions: positionsFromEngine(mesh.positions), indices: indicesAcross(mesh.indices, babylonClockwise) };
}
