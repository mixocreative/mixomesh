/**
 * Pure inputs of a live support job (plan P3.5): whether a job must place anew, and the engine job
 * a record makes on an object model. No workers, no scene: unit-tested on their own.
 */
import type { ContactInputs, SupportJob } from '@mixo-geocore/host/core/jobs';
import { PLACEMENT_KEYS } from '@mixo-geocore/host/supports/unitSupports';
import { defaultSupportSettings } from '@mixo-geocore/host/core/supports/settings';
import type { LocalModel } from '../supportJob';
import type { ObjectSupports } from '../model';
import { cachedPlacement } from '../supportCache';
import { labelTextFor } from '../label';

/**
 * Safety-repair trials every generic build may spend (plan P5.2): a budget of 0 only reports, so brace
 * pruning (drop exactly the braces that cross the model) and the structure fallbacks never run.
 */
export const REPAIR_BUDGET = 3;

/**
 * Largest raft wall lean the engine builds: at 90 degrees the flare offset is tan(90) (engine 11 never
 * returns), so the host stops one degree short. The settings limit (0-90) stays the engine's; this is
 * the app's guard for every path (panel, project file, automation API).
 */
export const RAFT_WALL_ANGLE_MAX = 89;

/** The record's settings as the engine may take them. */
export function engineSettings(settings: ObjectSupports['settings']): ObjectSupports['settings'] {
  /*
   * A SETTING THE SAVED RECORD PREDATES IS FILLED HERE, at the one place settings cross to the
   * engine. `isSupportsRecord` checks that `settings` is an object with a string `preset` and
   * nothing more -- and it should not enumerate the keys, because a record is not invalid for
   * having been written by an older build. But the engine's type requires every number, so a
   * `.mixo` saved before `neckMaxShift` and `minClearance` existed (engine 65) would hand it two
   * `undefined`s, and an undefined neck offset is not a refusal, it is garbage geometry.
   *
   * Generic, not those two by name, because the next setting added will do the same thing. The
   * record's own values always win; only what is MISSING is filled.
   *
   * It is HERE and not in `restoreSupports` for a reason worth keeping: the persistence modules are
   * plain JSON by design (D19) and are loaded by `tests/*.test.mjs` under BARE NODE, which cannot
   * resolve the `@mixo-geocore/host` alias that the bundler and vitest both resolve. Importing the
   * engine's defaults there broke 108 node tests while tsc and all 223 vitest tests passed.
   */
  const filled = { ...defaultSupportSettings, ...settings };
  return filled.raftWallAngle > RAFT_WALL_ANGLE_MAX ? { ...filled, raftWallAngle: RAFT_WALL_ANGLE_MAX } : filled;
}

/** Placement settings differ from the ones the contacts were placed with (lift does not move contacts). */
export function placementChanged(record: ObjectSupports): boolean {
  if (!record.placed) return true;
  const settings = record.settings as unknown as Record<string, unknown>;
  return PLACEMENT_KEYS.some((key) => key !== 'liftHeight' && record.placed![key] !== settings[key]);
}

/** Whether a job must place anew: no placement in hand, other geometry, or other placement settings. */
export function needsPlacement(record: ObjectSupports, hash: string | null, havePlacement: boolean): boolean {
  return !havePlacement || !!record.stale || record.sourceHash !== hash || placementChanged(record);
}

/** The support job of a record on an object model, in the support frame (object-local). */
export function buildJob(model: Pick<LocalModel, 'local' | 'center' | 'minY'>, record: ObjectSupports, inputs: ContactInputs, objectName = ''): SupportJob {
  return {
    mesh: model.local,
    frame: { position: [...model.center], rotation: [0, 0, 0] },
    plate: model.minY - record.settings.liftHeight,
    settings: engineSettings(record.settings),
    contacts: inputs,
    labelText: labelTextFor(record.settings.labelText, objectName),
    repairBudget: REPAIR_BUDGET,
    mode: 'preview',
  };
}

export interface Contact { id: string; position: readonly number[] }

/** The contacts on show of an object, support frame: automatic ones not removed, then the hand-added ones. */
export function liveContacts(objectId: string, record: ObjectSupports | undefined): Contact[] {
  if (!record) return [];
  const removed = new Set(record.deleted);
  return [...(cachedPlacement(objectId) ?? []).filter((p) => !removed.has(p.id)), ...record.manual].map((p) => ({ id: p.id, position: p.position }));
}

/** The contact id of a triangle of the support mesh (engine index order), if the triangle belongs to a contact's support. */
export function contactOfTriangle(components: readonly { contactId?: string; start: number; count: number }[], triangle: number): string | undefined {
  const at = triangle * 3;
  for (const c of components) if (at >= c.start && at < c.start + c.count) return c.contactId;
  return undefined;
}


/**
 * The job inputs of an export at another print size (plan P4.2 ratio rule). Supports are
 * mm-physical: the model and every contact position scale by `scale` about the support-frame origin
 * (the object's box centre), the contacts keep their ids (same contacts, rescaled points), and the
 * shape settings, overrides and lift stay in mm, so the engine builds tips of the same size on the
 * larger or smaller model. Zone stamps scale with the surface they were painted on.
 */
export function scaledJobInputs(model: Pick<LocalModel, 'local' | 'center' | 'minY'>, inputs: ContactInputs, scale: number): { model: Pick<LocalModel, 'local' | 'center' | 'minY'>; inputs: ContactInputs } {
  if (!(scale > 0)) throw new Error('scaledJobInputs: scale must be positive');
  const s3 = (p: readonly number[]): [number, number, number] => [p[0]! * scale, p[1]! * scale, p[2]! * scale];
  const positions = new Float32Array(model.local.positions.length);
  for (let i = 0; i < positions.length; i++) positions[i] = model.local.positions[i]! * scale;
  return {
    model: {
      local: { positions, indices: model.local.indices },
      center: [...model.center] as [number, number, number],
      minY: model.center[1] + (model.minY - model.center[1]) * scale,
    },
    inputs: {
      ...inputs,
      points: inputs.points.map((p) => ({ ...p, position: s3(p.position) })),
      manual: inputs.manual.map((p) => ({ ...p, position: s3(p.position) })),
      zones: inputs.zones.map((z) => ({ ...z, center: s3(z.center), radius: z.radius * scale })),
    },
  };
}
