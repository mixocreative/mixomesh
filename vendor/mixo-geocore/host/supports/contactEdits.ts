import type { RekeyedHandWork, SupportPoint } from '../core/analysis/types';

export type { RekeyedHandWork };
import type { Vector } from '../core/vec3';
import { supportEngine } from './supportEngine';

/*
 * Host adapter of the manual-edit model in the Rust core (`crates/geometry-core/src/supports/edits.rs`
 * and `contact_id.rs`): automatic contact IDs encode the position on a 0.01 mm grid, and a unit's
 * deleted IDs and per-support settings follow a fresh placement by ID. Strings and typed arrays go in,
 * the re-keyed lists come out; the matching itself runs in Rust.
 */

// The edit calls of the engine module (crates/geometry-wasm), typed here because they are not part
// of `SupportEngine`. Positions are flat xyz f64, unit-local mm.
interface EditsEngine {
  position_ids(positions: Float64Array): string[];
  remap_deleted_ids(deleted: string[], pointIds: string[], pointPositions: Float64Array, matchRadius: number): string[];
  hiding_removal_ids(autoIds: string[], deleted: string[]): string[];
  contacts_hidden_by_marker_ids(autoIds: string[], autoPositions: Float64Array, markers: string[], eraseRadius: number): string[];
  rekey_contact_ids(ids: string[], positions: Float64Array): string[];
  rekey_hand_work(deleted: string[], overrideIds: string[], manualIds: string[], pointIds: string[], pointPositions: Float64Array, matchRadius: number): {
    take_deleted(): string[]; take_targets(): string[]; take_counts(): Uint32Array; free(): void;
  };
}

const engine = () => supportEngine() as unknown as EditsEngine;
const flat = (points: readonly { position: Vector }[]) => Float64Array.from(points.flatMap((p) => p.position));

/** The IDs the positions encode on the 0.01 mm grid (`auto-X_Y_Z`). */
export function positionIds(positions: readonly Vector[]): string[] {
  return positions.length === 0 ? [] : engine().position_ids(Float64Array.from(positions.flat()));
}

/** The ID one position encodes (see `positionIds`). */
export function positionId(position: Vector): string {
  return positionIds([position])[0]!;
}

/** The `deleted` IDs that hide an automatic contact right now; one whose spot is gone hides nothing. */
export function hidingRemovals(auto: readonly SupportPoint[], deleted: readonly string[]): Set<string> {
  return new Set(engine().hiding_removal_ids(auto.map((p) => p.id), [...deleted]));
}

/** Re-keys removed IDs for a fresh placement (an ID with no neighbour within `matchRadius` is kept). */
export function remapDeleted(deleted: readonly string[], points: readonly SupportPoint[], matchRadius: number): string[] {
  return deleted.length === 0 ? [] : engine().remap_deleted_ids([...deleted], points.map((p) => p.id), flat(points), matchRadius);
}

/** The automatic contacts an old radius removal hid. Only the load migration of the retired `suppressed` list uses it. */
export function contactsHiddenByMarkers(auto: readonly SupportPoint[], markers: readonly string[], eraseRadius: number): string[] {
  return markers.length === 0 ? [] : engine().contacts_hidden_by_marker_ids(auto.map((p) => p.id), flat(auto), [...markers], eraseRadius);
}

/** Gives every automatic contact the ID its stored position encodes; `ids` maps each changed old ID to its new one. */
export function rekeyPoints(points: readonly SupportPoint[]): { points: SupportPoint[]; ids: Map<string, string> } {
  const ids = new Map<string, string>();
  if (points.length === 0) return { points: [], ids };
  const rekeyed = engine().rekey_contact_ids(points.map((p) => p.id), flat(points));
  const out = points.map((point, k) => {
    const id = rekeyed[k]!;
    if (id === point.id) return point;
    ids.set(point.id, id);
    return { ...point, id };
  });
  return { points: out, ids };
}

/**
 * Follows a fresh placement with the unit's removals and per-support settings in one match, so a new
 * contact is claimed by one of them at most. A removal or a setting no new contact matches is dropped
 * and counted, so nothing stays stored for an id that names no support.
 */
export function rekeyHandWork<T>(deleted: readonly string[], overrides: Readonly<Record<string, T>>, manualIds: ReadonlySet<string>, points: readonly SupportPoint[], matchRadius: number): RekeyedHandWork<T> {
  const overrideIds = Object.keys(overrides);
  const result = engine().rekey_hand_work([...deleted], overrideIds, [...manualIds], points.map((p) => p.id), flat(points), matchRadius);
  try {
    const targets = result.take_targets();
    // `targets[k]` is the new id of override k, '' when no new contact matched it (dropped and counted).
    // Counts come as one Uint32Array: removals kept, removals reset, overrides kept, overrides reset.
    const [removalsKept, removalsReset, customisedKept, customisedReset] = result.take_counts();
    const out: Record<string, T> = {};
    overrideIds.forEach((id, k) => {
      if (targets[k] !== '') out[targets[k]!] = overrides[id]!;
    });
    return {
      deleted: result.take_deleted(),
      overrides: out,
      removals: { kept: removalsKept!, reset: removalsReset! },
      customised: { kept: customisedKept!, reset: customisedReset! },
    };
  } finally {
    result.free();
  }
}
