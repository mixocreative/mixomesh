// Ported from mixosupports src/workers/geometryVersion.ts (engine_version 9).

/** Must equal the Rust `engine_version()`; both change together on any ABI change. */
export const HOST_GEOMETRY_VERSION = 9;

export class GeometryVersionMismatch extends Error {
  /** @param {number} actual */
  constructor(actual) {
    super(`Geometry core schema ${actual} does not match host schema ${HOST_GEOMETRY_VERSION}`);
    this.name = 'GeometryVersionMismatch';
    this.code = 'geometry-version-mismatch';
    this.actual = actual;
  }
}

/** @param {number} actual */
export function assertGeometryVersion(actual) {
  if (actual !== HOST_GEOMETRY_VERSION) throw new GeometryVersionMismatch(actual);
}

/**
 * @template T
 * @param {() => Promise<unknown>} ready
 * @param {() => T | Promise<T>} work
 * @returns {Promise<T>}
 */
export async function runAfterGeometryReady(ready, work) {
  await ready();
  return work();
}
