/**
 * The Rust support calls (`generateSupports`, `genericPolicy`, `genericPlacement`, `contactEdits`)
 * run on. The host registers its engine once it is ready (`geometryReady` in each realm; tests and
 * Node scripts register the pkg-node build), like `state/transformEngine`: support builds are
 * synchronous, so the engine is held here.
 */
export interface SupportSession {
  load_mesh(positions: Float32Array, indices: Uint32Array): number;
  free(): void;
}

export interface SupportProblemsHandle {
  take_positions(): Float64Array;
  take_areas(): Float64Array;
  free(): void;
}

export interface SupportEngine {
  GeometrySession: new (maxBytes: number) => SupportSession;
  check_support_problems(positions: Float32Array, indices: Uint32Array, contacts: Float64Array, overhangAngleDegrees: number, spacing: number): SupportProblemsHandle;
  zoned_at(zones: Float64Array, point: Float64Array, normal: Float64Array): boolean;
  refine_for_overlay(positions: Float32Array, indices: Uint32Array, maxEdge: number, maxTriangles: number): { take_positions(): Float32Array; take_indices(): Uint32Array; free(): void };
}

let current: SupportEngine | undefined;

export function setSupportEngine(engine: SupportEngine): void {
  current = engine;
}

export function supportEngine(): SupportEngine {
  if (!current) throw new Error('Geometry engine is not ready: await geometryReady() before building supports');
  return current;
}

/** Mesh bytes a session may hold. */
export const SESSION_BYTES = 0x30000000;

/** Runs `run` with a fresh one-shot session and frees it afterwards. */
export function withSession<T>(run: (session: SupportSession) => T): T {
  const session = new (supportEngine().GeometrySession)(SESSION_BYTES);
  try {
    return run(session);
  } finally {
    session.free();
  }
}
