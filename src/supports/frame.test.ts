import { describe, expect, it } from 'vitest';
import { signedVolume } from '../core/print/PrintSpace.js';
import {
  ENGINE_MM_PER_BU, indicesAcross, meshFromEngine, normalFromEngine, normalToEngine, partsToEngine,
  pointFromEngine, pointToEngine, positionsFromEngine, positionsToEngine, weldByPosition,
} from './frame';

/** Unit cube [0,1]^3 in mm, counter-clockwise-outward in a right-handed frame (engine convention). */
function engineCube() {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1]);
  const indices = new Uint32Array([
    0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7,
  ]);
  return { positions, indices };
}

describe('frame: Babylon world <-> engine', () => {
  it('uses the export seam unit (1 BU = 1000 mm)', () => {
    expect(ENGINE_MM_PER_BU).toBe(1000);
  });

  it('negates Z and scales points; round trips both ways', () => {
    expect(pointToEngine([0.001, 0.002, 0.003])).toEqual([1, 2, -3]);
    const back = pointFromEngine(pointToEngine([0.0125, -0.5, 0.25]));
    expect(back[0]).toBeCloseTo(0.0125, 12);
    expect(back[1]).toBeCloseTo(-0.5, 12);
    expect(back[2]).toBeCloseTo(0.25, 12);
    expect(pointFromEngine([10, 20, 30])).toEqual([0.01, 0.02, -0.03]);
  });

  it('negates Z of normals without scaling; round trips', () => {
    expect(normalToEngine([0, -1, 0.5])).toEqual([0, -1, -0.5]);
    expect(normalFromEngine(normalToEngine([0.6, 0, 0.8]))).toEqual([0.6, 0, 0.8]);
  });

  it('round trips position buffers', () => {
    const src = new Float32Array([0.01, 0.02, 0.03, -0.004, 0.005, -0.006]);
    const back = positionsFromEngine(positionsToEngine(src));
    for (let i = 0; i < src.length; i++) expect(back[i]).toBeCloseTo(src[i]!, 7);
    expect(Array.from(positionsToEngine(src))).toEqual(Array.from(src, (v, i) => Math.fround(i % 3 === 2 ? -v * 1000 : v * 1000)));
  });

  it('swaps indices 1<->2 only for a clockwise-front Babylon mesh, and is its own inverse', () => {
    const idx = [0, 1, 2, 3, 4, 5];
    expect(Array.from(indicesAcross(idx, true))).toEqual([0, 2, 1, 3, 5, 4]);
    expect(Array.from(indicesAcross(idx, false))).toEqual(idx);
    expect(Array.from(indicesAcross(indicesAcross(idx, true), true))).toEqual(idx);
  });

  it('winding: an outward engine mesh comes back with the Babylon sign for each front face, and returns outward', () => {
    const cube = engineCube();
    expect(signedVolume(cube.positions, cube.indices)).toBeCloseTo(1, 9);
    // Clockwise-front (glTF import): Babylon positions have POSITIVE right-handed volume.
    const cw = meshFromEngine(cube, true);
    expect(signedVolume(cw.positions, cw.indices)).toBeGreaterThan(0);
    // Counter-clockwise-front (native mesh): NEGATIVE, Babylon's own convention (PrintSpace.printIndices).
    const ccw = meshFromEngine(cube, false);
    expect(signedVolume(ccw.positions, ccw.indices)).toBeLessThan(0);
    for (const [part, clockwise] of [[cw, true], [ccw, false]] as const) {
      const back = partsToEngine([{ positions: part.positions, indices: part.indices, clockwise }]);
      expect(signedVolume(back.mesh.positions, back.mesh.indices)).toBeCloseTo(1, 6);
    }
  });
});

describe('frame: weld by position (geometry only)', () => {
  it('merges seam duplicates, keeps distinct points, drops collapsed triangles', () => {
    // Two triangles sharing an edge, each with its own copy of the shared vertices (a UV seam).
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0.0001]);
    const indices = new Uint32Array([0, 1, 2, 3, 4, 5, 6, 7, 0]);
    const { mesh, sourceFace } = weldByPosition({ positions, indices });
    expect(mesh.positions.length / 3).toBe(4);
    expect(Array.from(mesh.indices)).toEqual([0, 1, 2, 1, 3, 2]);
    expect(Array.from(sourceFace)).toEqual([0, 1]);
  });

  it('keeps points one weld cell apart', () => {
    const { mesh } = weldByPosition({ positions: new Float32Array([0, 0, 0, 0.002, 0, 0, 0, 1, 0]), indices: new Uint32Array([0, 1, 2]) });
    expect(mesh.positions.length / 3).toBe(3);
  });

  it('welds parts across meshes after the frame change', () => {
    // A quad split into two meshes (two shader slots) sharing the diagonal.
    const a = { positions: [0, 0, 0, 0.001, 0, 0, 0.001, 0, 0.001], indices: [0, 1, 2], clockwise: true };
    const b = { positions: [0, 0, 0, 0.001, 0, 0.001, 0, 0, 0.001], indices: [0, 1, 2], clockwise: true };
    const model = partsToEngine([a, b]);
    expect(model.sourceVertices).toBe(6);
    expect(model.mesh.positions.length / 3).toBe(4);
    expect(model.mesh.indices.length).toBe(6);
  });
});
