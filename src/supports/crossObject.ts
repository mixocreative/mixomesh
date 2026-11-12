import type { TriangleMesh } from '@mixo-geocore/host/core/analysis/types';
import { contactsBuried } from '@mixo-geocore/host/supports/partTips';
import type { Vec3 } from './frame';

/*
 * Contacts of one object that sit inside ANOTHER object (C2, decided 2026-11-13).
 *
 * The engine's overlap rule masks faces buried inside another PART of the SAME object, so a
 * body-and-arm object gets no supports in the overlap. Separate those meshes into two objects and
 * the rule stops applying — the overlap is no longer within one object — and both would get supports
 * inside solid material, which can be neither printed nor removed.
 *
 * The instrument is GEOMETRY, not history. The plan's first idea was for a split to record its
 * parent, but history is neither necessary nor sufficient: it misses two unrelated objects pushed
 * into each other, and it still fires for split siblings the operator has since moved apart. It also
 * needed a save-format field that does not exist. This asks the question that actually matters —
 * is this contact inside another object's material — and `contactsBuried` already answers it: hand
 * it two objects' meshes CONCATENATED and the engine treats them as two parts of one file.
 *
 * It WARNS. It does not drop and it does not refuse. Dropping would make object A's supports depend
 * on object B's pose with nothing to restale them: move B away and A is silently under-supported,
 * a failed print nobody was told about. Refusing is wrong because overlapping objects are a normal,
 * intended state in this app. Extra supports with a warning on screen is the recoverable error.
 */

/** Axis-aligned bounds of a mesh, in its own local frame. */
export function boundsOf(mesh: TriangleMesh): { min: Vec3; max: Vec3 } | null {
  const p = mesh.positions;
  if (p.length < 3) return null;
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i + 2 < p.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      const v = p[i + a]!;
      if (v < min[a]!) min[a] = v;
      if (v > max[a]!) max[a] = v;
    }
  }
  return { min, max };
}

/**
 * Do two objects' boxes overlap, once `other` is shifted into `mesh`'s frame by `offset`?
 *
 * The prefilter, and the reason this check costs nothing on the common path: a plate of objects that
 * do not touch never reaches the engine at all. `margin` is slack, so a pair that merely abuts is
 * still asked about (the engine decides whether it is really buried).
 */
export function boxesOverlap(mesh: TriangleMesh, other: TriangleMesh, offset: Vec3, margin = 0): boolean {
  const a = boundsOf(mesh);
  const b = boundsOf(other);
  if (!a || !b) return false;
  return [0, 1, 2].every((axis) =>
    a.min[axis]! - margin <= b.max[axis]! + offset[axis]! && a.max[axis]! + margin >= b.min[axis]! + offset[axis]!);
}

/**
 * `mesh` with `others` concatenated into its frame, each shifted by its own offset.
 *
 * Pure, and the piece worth testing: the engine is handed ONE mesh and told nothing about objects,
 * so if a shift is wrong the question asked is about geometry that is not where the operator sees it
 * — and the answer would look plausible. Indices are re-based per mesh; nothing is welded here (the
 * engine welds duplicate corners itself, engine 68).
 */
export function combined(mesh: TriangleMesh, others: readonly { mesh: TriangleMesh; offset: Vec3 }[]): TriangleMesh {
  const vertexCount = mesh.positions.length + others.reduce((n, o) => n + o.mesh.positions.length, 0);
  const indexCount = mesh.indices.length + others.reduce((n, o) => n + o.mesh.indices.length, 0);
  const positions = new Float32Array(vertexCount);
  const indices = new Uint32Array(indexCount);
  positions.set(mesh.positions);
  indices.set(mesh.indices);
  let atVertex = mesh.positions.length;
  let atIndex = mesh.indices.length;
  for (const { mesh: other, offset } of others) {
    const base = atVertex / 3;
    for (let i = 0; i + 2 < other.positions.length; i += 3) {
      positions[atVertex + i] = other.positions[i]! + offset[0]!;
      positions[atVertex + i + 1] = other.positions[i + 1]! + offset[1]!;
      positions[atVertex + i + 2] = other.positions[i + 2]! + offset[2]!;
    }
    for (let k = 0; k < other.indices.length; k++) indices[atIndex + k] = other.indices[k]! + base;
    atVertex += other.positions.length;
    atIndex += other.indices.length;
  }
  return { positions, indices };
}

/** One neighbour: its mesh and where its local origin sits relative to the asked object's. */
export interface Neighbour {
  objectId: string;
  name: string;
  mesh: TriangleMesh;
  /** `other.center - mine.center`: both frames differ by a translation only (`toLocal` never rotates). */
  offset: Vec3;
}

export interface InsideOthers {
  /** Positions of the contacts that sit inside a neighbour, in the asked object's frame. */
  positions: Vec3[];
  /** Names of the neighbours that overlap, for the sentence. */
  names: string[];
}

/**
 * Which of `contacts` sit inside one of `neighbours`.
 *
 * Every overlapping neighbour goes into ONE engine call, not one call each: the cost is a parts
 * split plus a ray index over the combined mesh, and paying that per pair on a full plate is what
 * would make this too slow to run at generate time.
 *
 * A contact buried in the object's OWN other parts never reaches here — the placement already
 * dropped those — so anything marked is inside a neighbour.
 */
export function contactsInsideOthers(
  mesh: TriangleMesh,
  contacts: readonly { position: Vec3 }[],
  neighbours: readonly Neighbour[],
  options: { radius?: number; margin?: number } = {},
): InsideOthers {
  const empty: InsideOthers = { positions: [], names: [] };
  if (contacts.length === 0 || neighbours.length === 0) return empty;
  const near = neighbours.filter((n) => boxesOverlap(mesh, n.mesh, n.offset, options.margin ?? 0));
  if (near.length === 0) return empty;
  const marked = contactsBuried(combined(mesh, near), contacts as readonly { position: readonly [number, number, number] }[], { radius: options.radius ?? 0 });
  const positions = contacts.flatMap((contact, k) => (marked[k] ? [contact.position] : []));
  return positions.length === 0 ? empty : { positions, names: near.map((n) => n.name) };
}
