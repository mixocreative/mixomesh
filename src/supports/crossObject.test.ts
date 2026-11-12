import { describe, expect, it } from 'vitest';
import type { TriangleMesh } from '@mixo-geocore/host/core/analysis/types';
import { boundsOf, boxesOverlap, combined } from './crossObject';
import type { Vec3 } from './frame';

/*
 * The GEOMETRY of the cross-object check, without the engine.
 *
 * `contactsInsideOthers` itself is one engine call wrapped around these three; what can be wrong
 * here is the frame arithmetic, and that is the dangerous kind of wrong: the engine is handed ONE
 * mesh and told nothing about objects, so a bad shift asks a well-formed question about geometry
 * that is not where the operator sees it, and the answer looks plausible.
 */

/** An axis-aligned box as a triangle soup; only the positions matter to these three. */
function box(min: Vec3, max: Vec3): TriangleMesh {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  const corners: Vec3[] = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]];
  return {
    positions: new Float32Array(corners.flat()),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6]),
  };
}

describe('boundsOf', () => {
  it('is the box of the positions, and null for an empty mesh', () => {
    expect(boundsOf(box([1, 2, 3], [4, 5, 6]))).toEqual({ min: [1, 2, 3], max: [4, 5, 6] });
    expect(boundsOf({ positions: new Float32Array(), indices: new Uint32Array() })).toBeNull();
  });
});

describe('boxesOverlap', () => {
  const mine = box([0, 0, 0], [10, 10, 10]);

  it('is the prefilter: a neighbour the operator moved away never reaches the engine', () => {
    expect(boxesOverlap(mine, box([0, 0, 0], [4, 4, 4]), [20, 0, 0])).toBe(false);
    expect(boxesOverlap(mine, box([0, 0, 0], [4, 4, 4]), [8, 0, 0])).toBe(true);
  });

  it('counts the offset on every axis, not just the one that happens to be tested', () => {
    for (const axis of [0, 1, 2]) {
      const far: Vec3 = [0, 0, 0];
      far[axis] = 50;
      expect(boxesOverlap(mine, box([0, 0, 0], [4, 4, 4]), far), `axis ${axis}`).toBe(false);
    }
  });

  it('still asks about a pair that merely abuts, and `margin` widens that', () => {
    // Touching exactly: asked, because the engine decides whether it is really buried.
    expect(boxesOverlap(mine, box([0, 0, 0], [4, 4, 4]), [10, 0, 0])).toBe(true);
    // A hair apart: not asked, unless the margin says to.
    expect(boxesOverlap(mine, box([0, 0, 0], [4, 4, 4]), [10.5, 0, 0])).toBe(false);
    expect(boxesOverlap(mine, box([0, 0, 0], [4, 4, 4]), [10.5, 0, 0], 1)).toBe(true);
  });
});

describe('combined', () => {
  const mine = box([0, 0, 0], [10, 10, 10]);
  const other = box([0, 0, 0], [2, 2, 2]);

  it('shifts the neighbour into this object frame', () => {
    const out = combined(mine, [{ mesh: other, offset: [5, 1, -2] }]);
    const at = mine.positions.length;
    // The neighbour's first corner was its own origin; it must land at the offset.
    expect([out.positions[at], out.positions[at + 1], out.positions[at + 2]]).toEqual([5, 1, -2]);
    // And its far corner carries the same shift, so it is translated and not scaled.
    expect([out.positions[at + 18], out.positions[at + 19], out.positions[at + 20]]).toEqual([7, 3, 0]);
  });

  it('re-bases the indices, so the neighbour triangles are its own vertices', () => {
    const out = combined(mine, [{ mesh: other, offset: [0, 0, 0] }]);
    const base = mine.positions.length / 3;
    expect(out.indices.slice(mine.indices.length, mine.indices.length + 3)).toEqual(new Uint32Array([base, base + 1, base + 2]));
    // The one failure that would look like success: indices left at 0..n would make a valid mesh
    // out of the WRONG triangles, and the engine would answer about it without complaint.
    expect(Math.max(...out.indices)).toBe(base + 7);
  });

  it('keeps this object own vertices and triangles first and unchanged', () => {
    const out = combined(mine, [{ mesh: other, offset: [5, 5, 5] }]);
    expect(out.positions.slice(0, mine.positions.length)).toEqual(mine.positions);
    expect(out.indices.slice(0, mine.indices.length)).toEqual(mine.indices);
  });

  it('takes several neighbours, each with its own offset', () => {
    const out = combined(mine, [{ mesh: other, offset: [1, 0, 0] }, { mesh: other, offset: [0, 7, 0] }]);
    expect(out.positions.length).toBe(mine.positions.length + 2 * other.positions.length);
    expect(out.indices.length).toBe(mine.indices.length + 2 * other.indices.length);
    const second = mine.positions.length + other.positions.length;
    expect([out.positions[second], out.positions[second + 1], out.positions[second + 2]]).toEqual([0, 7, 0]);
    // Every index points inside the combined buffer: the check a re-base bug fails.
    expect(Math.max(...out.indices)).toBeLessThan(out.positions.length / 3);
  });

  it('is the mesh itself when there are no neighbours', () => {
    const out = combined(mine, []);
    expect(out.positions).toEqual(mine.positions);
    expect(out.indices).toEqual(mine.indices);
  });
});
