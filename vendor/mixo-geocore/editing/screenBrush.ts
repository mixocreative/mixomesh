import type { GeneratedSupportMesh } from '../host/core/supports/mesh';

/**
 * Drag over in screen space: the brush is a circle of fixed size in canvas pixels that follows the
 * pointer. A support is under it when its projected body (each part reduced to its axis) comes
 * within the circle and some part of it under the circle is not hidden behind the model. The
 * maths runs in the Rust core (`body_segments`, `GeometrySession.project_brush`); this file is the
 * typed host glue. The TypeScript version it replaced lives with the tests
 * as a reference.
 */

export type Point2 = readonly [number, number];

/** Support bodies as axis segments: contact `ids[i]` owns segments `first[i]` to `first[i + 1]`; 6 floats each (a, b). */
export interface BodySegments {
  ids: string[];
  first: Uint32Array;
  points: Float32Array;
}

/** What the engine's `body_segments` call returns (its WASM result object). */
interface BodySegmentsEngine {
  body_segments(positions: Float32Array, indices: Uint32Array, contact: Uint32Array, start: Uint32Array, count: Uint32Array): {
    take_keys(): ArrayLike<number>;
    take_first(): ArrayLike<number>;
    take_points(): Float32Array;
    free(): void;
  };
}

const NO_CONTACT = 0xffffffff;

/** Each support part with a contact reduced to its axis, per contact (unit-local, like the mesh). Built once per support mesh. */
export function bodySegments(engine: BodySegmentsEngine, mesh: Pick<GeneratedSupportMesh, 'positions' | 'indices' | 'components'>): BodySegments {
  const names: string[] = [];
  const keyOf = new Map<string, number>();
  const { components } = mesh;
  const contact = new Uint32Array(components.length);
  const start = new Uint32Array(components.length);
  const count = new Uint32Array(components.length);
  components.forEach((component, k) => {
    let key = NO_CONTACT;
    if (component.contactId) {
      key = keyOf.get(component.contactId) ?? names.length;
      if (key === names.length) {
        keyOf.set(component.contactId, key);
        names.push(component.contactId);
      }
    }
    contact[k] = key;
    start[k] = component.start;
    count[k] = component.count;
  });
  const result = engine.body_segments(mesh.positions, mesh.indices, contact, start, count);
  try {
    return { ids: Array.from(result.take_keys(), (key) => names[key]!), first: Uint32Array.from(result.take_first()), points: result.take_points() };
  } finally {
    result.free();
  }
}

/** A visible model hiding supports: its session mesh, the support-local to model-local matrix (column-major) and the material side (0 front, 1 back, 2 double). */
export interface BrushOccluder {
  handle: number;
  toLocal: ArrayLike<number>;
  side: number;
}

/** Where the support group sits on the canvas: support-local to clip matrix, the camera in support-local space, the canvas size in px. */
export interface BrushView {
  clip: ArrayLike<number>;
  eye: readonly [number, number, number];
  width: number;
  height: number;
}

/** What the engine's `GeometrySession.project_brush` takes of the session. */
export interface BrushSession {
  project_brush(
    bodyPoints: Float32Array, bodyFirst: Uint32Array, occluderHandles: Uint32Array, occluderMatrices: Float64Array, occluderSides: Uint32Array,
    matrix: Float64Array, eye: Float64Array, size: Float64Array, radius: number, stroke: Float64Array, start: number, end: number, want: Uint8Array,
  ): Uint32Array;
}

/**
 * Contact ids whose support body the brush circle (radius px) touches on its path from `from` (the
 * previous pointer position in this stroke; undefined for a lone circle) to `to` and can see
 * (not behind an occluder), among supports `start` onward. `want` filters ids before any
 * visibility test (the ones a stroke would change). One batched Rust call per step.
 */
export function brushHits(
  session: BrushSession,
  bodies: BodySegments,
  occluders: readonly BrushOccluder[],
  view: BrushView,
  from: Point2 | undefined,
  to: Point2,
  radius: number,
  start = 0,
  want?: (id: string) => boolean,
): string[] {
  const slots = bodies.ids.length;
  const mask = new Uint8Array(want ? slots : 0);
  if (want) for (let slot = 0; slot < slots; slot++) mask[slot] = want(bodies.ids[slot]!) ? 1 : 0;
  const matrices = new Float64Array(occluders.length * 16);
  occluders.forEach((occluder, k) => matrices.set(Array.from(occluder.toLocal), k * 16));
  const hits = session.project_brush(
    bodies.points, bodies.first,
    Uint32Array.from(occluders, (occluder) => occluder.handle), matrices, Uint32Array.from(occluders, (occluder) => occluder.side),
    Float64Array.from(view.clip), Float64Array.from(view.eye), Float64Array.of(view.width, view.height),
    radius, Float64Array.from(from ? [from[0], from[1], to[0], to[1]] : [to[0], to[1]]), start, slots, mask,
  );
  return Array.from(hits, (slot) => bodies.ids[slot]!);
}
