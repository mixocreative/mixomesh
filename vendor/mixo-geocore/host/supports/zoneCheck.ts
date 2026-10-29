import type { Vector } from '../core/vec3';
import type { ZoneStamp } from '../core/supports/zones';
import { packZones } from './supportBuildWasm';
import { supportEngine } from './supportEngine';

/**
 * Whether `point` is zoned: the last stamp covering it decides (paint zones, erase clears), and
 * `normal`, when given, keeps the far side of a thin wall out. The rule is Rust's
 * (`AreaStamp::resolve`, called through `zoned_at`); there is no TypeScript copy of it.
 */
export function zonedAt(zones: readonly ZoneStamp[], point: Vector, normal?: Vector): boolean {
  if (zones.length === 0) return false;
  return supportEngine().zoned_at(packZones(zones), Float64Array.from(point), normal ? Float64Array.from(normal) : new Float64Array(0));
}

/**
 * Whether a support-check spot lies in a no-support zone. Spots are downward-facing, so `downLocal`
 * (plate down in unit-local space) stands in for their normal: a zone painted on the top of a thin
 * floor leaves the spot under it out.
 */
export function problemInZone(zones: readonly ZoneStamp[], positionLocal: Vector, downLocal: Vector): boolean {
  return zonedAt(zones, positionLocal, downLocal);
}
