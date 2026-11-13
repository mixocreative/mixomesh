import type { TriangleMesh } from '@mixo-geocore/host/core/analysis/types';

/*
 * Tiny separate shells in an object — scan noise, stray fragments — which the generic support policy
 * WILL support and the printer will print (C4 of docs/plans/2026-11-12-parts-and-focus-mode.md).
 *
 * The plan's U1 decision was that `debris` stays a DENTAL judgement: in a generic object a small part
 * is as likely to be a deliberate detail (a pin, a label, a bead) as it is noise, so the generic
 * policy supports every part it is given. That decision stands — but it carries a consequence, and
 * the plan said so when it was made: *"a generic object with scan noise will get supports on the
 * noise... Without that, this recommendation trades one silent wrong for another."*
 *
 * So the operator is told, and decides. Nothing is dropped, nothing is deleted: the engine's own
 * noise-shell report says "reported only; the body is still in the mesh" (`host/core/repairMesh.ts`)
 * and this follows it.
 *
 * Computed app-side from two things that already exist — position-connected components and a signed
 * volume — rather than by asking the engine for a part list. `partTips` would answer it, but it runs
 * a placement per part to do so, which is far more work than measuring a volume.
 */

/** Volume (mm3) at or under which a separate shell is noise rather than a detail. */
export const NOISE_MM3 = 0.001;

/**
 * Volumes of the shells at or under `limit`, largest first.
 *
 * `components` is the position-connected grouping (`MeshRepair.triangleComponents`): by POSITION, so
 * a UV seam — two vertices at one place — never splits one shell into two and reports a solid object
 * as a cloud of noise. That is the mistake this signature exists to prevent.
 *
 * A single-shell object returns nothing: the whole model is not noise however small it is, and a
 * 0.5 mm part printed on purpose must not be called scan debris.
 */
export function noiseShellVolumes(mesh: TriangleMesh, components: readonly (readonly number[])[], limit = NOISE_MM3): number[] {
  if (components.length < 2) return [];
  const volumes = components.map((faces) => Math.abs(shellVolume(mesh, faces)));
  // Never the largest: in an object that IS tiny, every shell is under the limit, and calling the
  // model itself noise would be worse than saying nothing.
  const biggest = Math.max(...volumes);
  return volumes.filter((v) => v <= limit && v !== biggest).sort((a, b) => b - a);
}

/** Signed volume (mm3) of the faces listed, by the divergence sum over their triangles. */
function shellVolume(mesh: TriangleMesh, faces: readonly number[]): number {
  const p = mesh.positions;
  const i = mesh.indices;
  let total = 0;
  for (const face of faces) {
    const a = i[face * 3]! * 3;
    const b = i[face * 3 + 1]! * 3;
    const c = i[face * 3 + 2]! * 3;
    // (a · (b × c)) / 6, the tetrahedron to the origin; summed over a closed shell it is its volume.
    total += (p[a]! * (p[b + 1]! * p[c + 2]! - p[b + 2]! * p[c + 1]!)
      - p[a + 1]! * (p[b]! * p[c + 2]! - p[b + 2]! * p[c]!)
      + p[a + 2]! * (p[b]! * p[c + 1]! - p[b + 1]! * p[c]!)) / 6;
  }
  return total;
}

/**
 * Position-connected shells of a WELDED mesh, as face-index lists.
 *
 * Index connectivity only, which is sound here and nowhere else: this is for a mesh that has been
 * through `frame.ts weldByPosition`, so two vertices at one position are already one vertex. Handed
 * an UNWELDED render mesh it would split a solid at every UV seam and report an object as a cloud of
 * noise — which is why its doc says welded and its caller is `objectModel`, after the weld.
 *
 * Union-find over typed arrays on purpose: `MeshRepair.triangleComponents` answers the same question
 * but takes array-of-arrays, and building those for a million triangles is far more work than the
 * question.
 */
export function shellsOf(mesh: TriangleMesh): number[][] {
  const vertices = mesh.positions.length / 3;
  const parent = new Int32Array(vertices);
  for (let v = 0; v < vertices; v++) parent[v] = v;
  const find = (x: number): number => {
    let r = x;
    while (parent[r] !== r) { parent[r] = parent[parent[r]!]!; r = parent[r]!; }
    return r;
  };
  const i = mesh.indices;
  for (let at = 0; at + 2 < i.length; at += 3) {
    const a = find(i[at]!);
    const b = find(i[at + 1]!);
    const c = find(i[at + 2]!);
    if (a !== b) parent[a] = b;
    if (find(b) !== c) parent[find(b)] = c;
  }
  const byRoot = new Map<number, number[]>();
  for (let face = 0; face * 3 + 2 < i.length; face++) {
    const root = find(i[face * 3]!);
    const list = byRoot.get(root);
    if (list) list.push(face);
    else byRoot.set(root, [face]);
  }
  return [...byRoot.values()];
}
