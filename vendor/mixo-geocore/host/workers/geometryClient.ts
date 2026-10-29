// The engine is the module returned by
// loadGeometryEngine (../loadGeometry.js), so there are no static named imports from the wasm
// package and no `?url` asset import. The host calls `configureGeometry` once per realm (main
// thread and each worker) with absolute URLs (or, when it bundles the glue itself, the imported
// module namespace and the wasm URL), then awaits `geometryReady()`.
import type * as GeometryModule from '@mixo-geocore/engine';
import { loadGeometryEngine } from '../loadGeometry.js';
import { setDentalEngine } from '../dental/dentalEngine';
import { setSupportEngine } from '../supports/supportEngine';
import { setTransformEngine } from '../state/transformEngine';

/** The vendored engine's module namespace (its `.d.ts` is the contract). */
export type GeometryEngine = typeof GeometryModule;
export type GeometrySessionLike = InstanceType<GeometryEngine['GeometrySession']>;

interface GeometrySource {
  /** The glue's absolute URL, or the glue module the host imported itself. */
  glue: string | GeometryEngine;
  wasm?: string | URL | BufferSource;
}

let source: GeometrySource | undefined;
let ready: Promise<GeometryEngine> | undefined;
let loaded: GeometryEngine | undefined;

/**
 * Where this realm loads the engine from: the glue's absolute URL, or the glue module namespace
 * when the host bundles it (then pass the wasm URL too). Call before the first `geometryReady()`;
 * a later call is ignored once loading began.
 */
export function configureGeometry(glue: string | GeometryEngine, wasm?: string | URL | BufferSource): void {
  if (ready) return;
  source = wasm === undefined ? { glue } : { glue, wasm };
}

/**
 * The engine once `geometryReady()` has resolved in this realm, else undefined. For synchronous
 * interactive code (brush, pick, gizmo maths) that cannot await.
 */
export function geometryNow(): GeometryEngine | undefined {
  return loaded;
}

/** Mesh bytes the shared main-thread session may hold (picked, brushed and overlaid models). */
const SHARED_SESSION_BYTES = 0x20000000;
let shared: GeometrySessionLike | undefined;

/** The main thread's session for meshes the viewport picks against; undefined until `geometryReady()` has resolved. */
export function sharedSession(): GeometrySessionLike | undefined {
  if (!loaded) return undefined;
  return (shared ??= new loaded.GeometrySession(SHARED_SESSION_BYTES));
}

/** One WASM instance per realm; loadGeometryEngine refuses a mismatched engine version before any call. */
export function geometryReady(): Promise<GeometryEngine> {
  if (!source) return Promise.reject(new Error('Geometry engine is not configured: call configureGeometry(glueUrl) first'));
  const { glue, wasm } = source;
  ready ??= (loadGeometryEngine(glue, wasm) as Promise<GeometryEngine>).then((engine) => {
    loaded = engine;
    setTransformEngine(engine);
    setSupportEngine(engine);
    setDentalEngine(engine);
    return engine;
  }).catch((error: unknown) => { ready = undefined; throw error; });
  return ready;
}
