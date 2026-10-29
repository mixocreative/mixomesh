/**
 * Pure inputs of a live support job (plan P3.5): whether a job must place anew, and the engine job
 * a record makes on an object model. No workers, no scene: unit-tested on their own.
 */
import type { ContactInputs, SupportJob } from '@mixo-geocore/host/core/jobs';
import { PLACEMENT_KEYS } from '@mixo-geocore/host/supports/unitSupports';
import type { LocalModel } from '../supportJob';
import type { ObjectSupports } from '../model';
import { cachedPlacement } from '../supportCache';

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
export function buildJob(model: Pick<LocalModel, 'local' | 'center' | 'minY'>, record: ObjectSupports, inputs: ContactInputs): SupportJob {
  return {
    mesh: model.local,
    frame: { position: [...model.center], rotation: [0, 0, 0] },
    plate: model.minY - record.settings.liftHeight,
    settings: record.settings,
    contacts: inputs,
    labelText: '',
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

