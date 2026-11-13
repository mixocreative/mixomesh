import { describe, expect, it } from 'vitest';
import type { TriangleMesh } from '@mixo-geocore/host/core/analysis/types';
import { NOISE_MM3, noiseShellVolumes, shellsOf } from './noiseShells';

/**
 * Volumes are compared RELATIVELY, not to ten decimal places: positions are a `Float32Array`, so a
 * 0.05 mm cube's 1.25e-4 mm3 arrives as 1.24998e-4. An absolute tolerance here would be asserting
 * float64 arithmetic on float32 data — a test failing for being right.
 */
const near = (got: number | undefined, want: number) => expect(Math.abs((got ?? 0) / want - 1)).toBeLessThan(1e-4);

/** A closed axis-aligned box, appended to `into`; returns the face indices it added. */
function addBox(into: { positions: number[]; indices: number[] }, min: [number, number, number], size: number): number[] {
  const base = into.positions.length / 3;
  const [x, y, z] = min;
  const s = size;
  for (const [dx, dy, dz] of [[0, 0, 0], [s, 0, 0], [s, s, 0], [0, s, 0], [0, 0, s], [s, 0, s], [s, s, s], [0, s, s]]) {
    into.positions.push(x + dx!, y + dy!, z + dz!);
  }
  const quads = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [3, 7, 6, 2], [0, 4, 7, 3], [1, 2, 6, 5]];
  const faces: number[] = [];
  for (const [a, b, c, d] of quads) {
    faces.push(into.indices.length / 3);
    into.indices.push(base + a!, base + b!, base + c!);
    faces.push(into.indices.length / 3);
    into.indices.push(base + a!, base + c!, base + d!);
  }
  return faces;
}

function scene(...boxes: { at: [number, number, number]; size: number }[]): { mesh: TriangleMesh; components: number[][] } {
  const build = { positions: [] as number[], indices: [] as number[] };
  const components = boxes.map((b) => addBox(build, b.at, b.size));
  return { mesh: { positions: new Float32Array(build.positions), indices: new Uint32Array(build.indices) }, components };
}

describe('noiseShellVolumes', () => {
  it('finds a speck beside a model and gives its volume', () => {
    // 10 mm cube (1000 mm³) and a 0.05 mm speck (1.25e-4 mm³, under the 1e-3 limit).
    const { mesh, components } = scene({ at: [0, 0, 0], size: 10 }, { at: [20, 0, 0], size: 0.05 });
    const found = noiseShellVolumes(mesh, components);
    expect(found).toHaveLength(1);
    near(found[0], 0.05 ** 3);
    expect(found[0]!).toBeLessThanOrEqual(NOISE_MM3);
  });

  it('says nothing about a deliberate small part above the limit', () => {
    // 2 mm cube = 8 mm³: small, and emphatically not scan noise.
    const { mesh, components } = scene({ at: [0, 0, 0], size: 10 }, { at: [20, 0, 0], size: 2 });
    expect(noiseShellVolumes(mesh, components)).toEqual([]);
  });

  it('never reports the largest shell, so a tiny object is not called noise', () => {
    // Every shell here is under the limit. Calling the model itself debris would be worse than
    // silence — the operator would be told to delete their own part.
    const { mesh, components } = scene({ at: [0, 0, 0], size: 0.08 }, { at: [1, 0, 0], size: 0.05 });
    const found = noiseShellVolumes(mesh, components);
    expect(found).toHaveLength(1);
    near(found[0], 0.05 ** 3);
  });

  it('says nothing about a single-shell object, however small', () => {
    const { mesh, components } = scene({ at: [0, 0, 0], size: 0.02 });
    expect(noiseShellVolumes(mesh, components)).toEqual([]);
  });

  it('reports several specks, largest first', () => {
    const { mesh, components } = scene(
      { at: [0, 0, 0], size: 10 },
      { at: [20, 0, 0], size: 0.05 },
      { at: [30, 0, 0], size: 0.08 },
    );
    const found = noiseShellVolumes(mesh, components);
    expect(found).toHaveLength(2);
    expect(found[0]).toBeGreaterThan(found[1]!);
  });

  it('is unsigned, so an inside-out speck still counts', () => {
    // A mirrored shell has a negative signed volume; its SIZE is what matters here.
    const { mesh, components } = scene({ at: [0, 0, 0], size: 10 }, { at: [20, 0, 0], size: 0.05 });
    const flipped = { ...mesh, indices: new Uint32Array(mesh.indices) };
    for (const face of components[1]!) {
      const at = face * 3;
      const swap = flipped.indices[at + 1]!;
      flipped.indices[at + 1] = flipped.indices[at + 2]!;
      flipped.indices[at + 2] = swap;
    }
    expect(noiseShellVolumes(flipped, components)).toHaveLength(1);
  });
});

describe('shellsOf', () => {
  it('finds the separate shells of a welded mesh', () => {
    const { mesh, components } = scene({ at: [0, 0, 0], size: 10 }, { at: [20, 0, 0], size: 0.05 });
    const found = shellsOf(mesh);
    expect(found).toHaveLength(2);
    // Same grouping as the fixture built, order aside.
    expect(found.map((f) => f.length).sort()).toEqual(components.map((c) => c.length).sort());
  });

  it('is one shell for one box, and feeds the volume pass end to end', () => {
    const { mesh } = scene({ at: [0, 0, 0], size: 10 });
    expect(shellsOf(mesh)).toHaveLength(1);
    const two = scene({ at: [0, 0, 0], size: 10 }, { at: [20, 0, 0], size: 0.05 });
    expect(noiseShellVolumes(two.mesh, shellsOf(two.mesh))).toHaveLength(1);
  });

  it('every face lands in exactly one shell', () => {
    const { mesh } = scene({ at: [0, 0, 0], size: 10 }, { at: [20, 0, 0], size: 1 }, { at: [40, 0, 0], size: 0.05 });
    const found = shellsOf(mesh);
    expect(found.flat().sort((a, b) => a - b)).toEqual([...Array(mesh.indices.length / 3).keys()]);
  });
});
