import type { SupportProblem } from '../host/core/analysis/supportCheck';
import type { GeneratedSupportMesh } from '../host/core/supports/mesh';
import type { Vector } from '../host/core/vec3';

/**
 * The "Supports left out" entry of the check, from the build's `dropped` list: automatic supports the
 * build did not make because they would cross the model, broke a placement rule, or the repair
 * took them out. The build does not say which of these it was per support, so the entry does not
 * either. Supports that a no-support zone caused (`droppedByZones`) are the user's own choice and are
 * counted elsewhere, not here; a manual support is never dropped. Informational: no count as a spot.
 *
 * `contacts` are the unit's contacts before the build's drops (`unitContacts(unit, undefined)`), in
 * the unit frame like every other finding. No current build lists nothing.
 */
export function omittedProblems(
  contacts: readonly { id: string; position: Vector }[],
  built: Pick<GeneratedSupportMesh, 'dropped' | 'droppedByZones'> | undefined,
): SupportProblem[] {
  if (!built) return [];
  const byZone = new Set(built.droppedByZones);
  const left = new Set(built.dropped.filter((id) => !byZone.has(id)));
  const points = contacts.filter((contact) => left.has(contact.id)).map((contact) => contact.position);
  return points.length === 0 ? [] : [{ kind: 'omitted', position: points[0]!, area: 0, points }];
}
