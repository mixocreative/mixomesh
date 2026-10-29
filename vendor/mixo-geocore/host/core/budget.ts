/**
 * Heavy-mesh budgets (shared heavy-mesh spec, mixomesh `capabilities.js` / `ImportLimits.js`
 * pattern): a triangle budget per runtime, a warning above 1x, a refusal above 4x, and the tiers
 * the editor uses to decide what it can offer on a mesh.
 *
 * Budget numbers, measured (Task 9, synthetic 2M/5M/10M STL, Chrome, 64 GB / RTX 3090): import is
 * cheap (10M in 10 s, no main-thread block), but Generate peaks at about 0.85 GB of renderer memory
 * per million triangles (2M 1.75 GB, 5M 4.0 GB) and a 10M placement stopped the tab at about 6.5 GB.
 * So both runtimes refuse above 6M: a desktop shell runs the same Chromium renderer. (mixomesh, which
 * only imports and edits meshes, measured 2.5M / 10M web.) Raise these when placement memory drops.
 */

export type Runtime = 'web' | 'desktop';

/** Triangle budget per runtime: above it the editor warns and switches to the heavy tier. */
export const TRIANGLE_BUDGET: Readonly<Record<Runtime, number>> = { web: 1_500_000, desktop: 1_500_000 };

/** Above this many times the budget an import is refused. */
export const REFUSE_FACTOR = 4;

/** Estimated (not exact) counts are refused only this far over the limit (sampling margin). */
export const ESTIMATE_MARGIN = 1.25;

/** Up to this many triangles every tool works as usual. */
export const FULL_TIER_MAX = 300_000;

/**
 * full: everything. large (up to the budget): contact-tips preview by default, no zone overlay
 * refinement. heavy (over the budget): editing tools off; generation and export still use the
 * full mesh in workers; the viewport shows a simplified copy.
 */
export type Tier = 'full' | 'large' | 'heavy';

export function meshTier(triangles: number, runtime: Runtime): Tier {
  if (triangles < FULL_TIER_MAX) return 'full';
  return triangles <= TRIANGLE_BUDGET[runtime] ? 'large' : 'heavy';
}

export function refusalLimit(runtime: Runtime): number {
  return TRIANGLE_BUDGET[runtime] * REFUSE_FACTOR;
}

/**
 * An import over the triangle or memory limit. `code` is the shared error code ('too-large') and
 * `reason` which limit it hit, so the UI explains it in the user's language.
 */
export class CapacityError extends Error {
  readonly code: 'too-large' | 'out-of-memory';
  /** The numbers the shared message needs (editing/errors). */
  readonly vars: { n: number; limit: number };
  constructor(readonly fileName: string, readonly triangles: number, readonly limit: number, readonly runtime: Runtime, readonly reason: 'triangles' | 'memory' = 'triangles') {
    super(reason === 'triangles'
      ? `"${fileName}" has about ${triangles.toLocaleString('en-US')} triangles; this ${runtime} build handles up to ${limit.toLocaleString('en-US')}. Simplify or split the model.`
      : `"${fileName}" (about ${triangles.toLocaleString('en-US')} triangles) needs more memory than this device can give the editor. Simplify or split the model.`);
    this.code = reason === 'triangles' ? 'too-large' : 'out-of-memory';
    this.vars = { n: triangles, limit };
  }
}

/**
 * Refuses `triangles` over 4x the runtime budget: an exact count at once, an estimate only past
 * the sampling margin (the post-parse check catches the rest).
 */
export function assertTriangleCapacity(fileName: string, triangles: number, runtime: Runtime, exact: boolean): void {
  const limit = refusalLimit(runtime);
  if (triangles > (exact ? limit : limit * ESTIMATE_MARGIN)) throw new CapacityError(baseName(fileName), Math.round(triangles), limit, runtime);
}

/**
 * Measured costs (Task 9, Chrome renderer private bytes, synthetic 2M/5M/10M STL):
 *   import  ≈ 56 B per triangle: the import worker peaks at 388 MB for 10M (weld table, read chunk,
 *            mesh, pick index) and the scene keeps the 18 B/triangle mesh;
 *   Generate ≈ 850 MiB per million triangles (2M → 1.89 GB, 5M → 4.13 GB renderer peak), the
 *            placement and support jobs' working memory; 10M stopped the tab at 6.5 GB.
 */
export const IMPORT_BYTES_PER_TRIANGLE = 56;
export const GENERATE_BYTES_PER_TRIANGLE = Math.round(850 * 2 ** 20 / 1e6);
const IMPORT_OVERHEAD_BYTES = 64 * 1024 * 1024;

export function estimateImportBytes(triangles: number): number {
  return triangles * IMPORT_BYTES_PER_TRIANGLE + IMPORT_OVERHEAD_BYTES;
}

export function estimateGenerateBytes(triangles: number): number {
  return triangles * GENERATE_BYTES_PER_TRIANGLE;
}

/**
 * Memory the editor may plan for: the JS heap limit and half the device memory where the browser
 * reports them (Chrome), else a conservative 1 GiB.
 */
export function memoryCapBytes({ jsHeapSizeLimit, deviceMemoryGb }: { jsHeapSizeLimit?: number; deviceMemoryGb?: number }): number {
  const known = [jsHeapSizeLimit, deviceMemoryGb === undefined ? undefined : deviceMemoryGb * 1024 ** 3 / 2].filter((value): value is number => typeof value === 'number' && value > 0);
  return known.length > 0 ? Math.min(...known) : 1024 ** 3;
}

/** Refuses an import whose estimated peak is over the memory cap (`limit`: the triangles the cap allows). */
export function assertMemoryCapacity(fileName: string, triangles: number, runtime: Runtime, capBytes: number): void {
  if (estimateImportBytes(triangles) > capBytes) {
    throw new CapacityError(baseName(fileName), Math.round(triangles), Math.floor((capBytes - IMPORT_OVERHEAD_BYTES) / IMPORT_BYTES_PER_TRIANGLE), runtime, 'memory');
  }
}

/**
 * Refuses a Generate whose jobs could need more than half the device memory at once, only where the
 * browser reports a small device: navigator.deviceMemory is clamped at 8, so 8 (or nothing) means
 * unknown or large and the 6M job gate alone applies. `triangles`: what can run at the same time
 * (the job gate never lets more than the refusal limit run together).
 */
export const LARGE_DEVICE_MEMORY_GB = 8;

export function assertGenerateMemory(triangles: number, runtime: Runtime, deviceMemoryGb: number | undefined): void {
  if (deviceMemoryGb === undefined || deviceMemoryGb >= LARGE_DEVICE_MEMORY_GB) return;
  const cap = deviceMemoryGb * 1024 ** 3 / 2;
  if (estimateGenerateBytes(triangles) > cap) throw new CapacityError('', Math.round(triangles), Math.floor(cap / GENERATE_BYTES_PER_TRIANGLE), runtime, 'memory');
}

/** Refuses an import that would put more triangles on the plate than the refusal limit. */
export function assertPlateCapacity(fileName: string, plateTriangles: number, runtime: Runtime): void {
  const limit = refusalLimit(runtime);
  if (plateTriangles > limit) throw new PlateFullError(baseName(fileName), plateTriangles, limit);
}

/** The plate would hold more triangles than the runtime handles (code 'plate-full'). */
export class PlateFullError extends Error {
  readonly code = 'plate-full';
  readonly vars: { n: number; limit: number };
  constructor(readonly fileName: string, triangles: number, limit: number) {
    super(`The plate would hold ${triangles.toLocaleString('en-US')} triangles with "${fileName}"; the limit is ${limit.toLocaleString('en-US')}. Delete or simplify an object first.`);
    this.vars = { n: triangles, limit };
  }
}

function baseName(fileName: string): string {
  return fileName.replace(/^.*[\\/]/, '');
}
