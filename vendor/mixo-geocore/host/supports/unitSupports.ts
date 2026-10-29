import { labelForIndex } from '../core/analysis/mesh';
import type { PlacementResult, ProgressCallback, SupportPoint } from '../core/analysis/types';
import { hidingRemovals, positionIds, rekeyHandWork, type RekeyedHandWork } from './contactEdits';
import { jobContacts } from './genericPolicy';
import { type CheckJob, type ContactInputs, type JobTransform, type PlacementJob, type SupportJob } from '../core/jobs';
import type { GeneratedSupportMesh, SupportContact } from '../core/supports/mesh';
import { defaultSupportSettings, toPlacementSettings, type LiveSupportSettings, type SettingKey } from '../core/supports/settings';
import type { ContactSettings, JSONObject, PrintUnit, SceneCommand, SupportSettings } from '../state/projectTypes';
import { inverseTransformDirection, inverseTransformPoint, transformedMinY, type ModelTransform } from '../state/transform';
import { runSupportJob } from './jobRunner';

/*
 * App glue between scene units and the support core: the only place a PrintUnit becomes a core
 * job (SupportJob, PlacementJob, CheckJob), plus the per-unit caches the UI reads.
 */

/** Unit settings stored in the scene, completed with defaults for any missing key. */
export function resolveSettings(settings: SupportSettings | undefined): LiveSupportSettings {
  return { ...defaultSupportSettings, roofSeededModes: [], ...(settings as Partial<LiveSupportSettings> | undefined) };
}

/** Settings whose change moves contacts: the unit's placement is out of date until it is generated again. */
export const PLACEMENT_KEYS: readonly SettingKey[] = [
  'scatterSpacing', 'scatterAngle', 'scatterFacingDown', 'scatterIslands', 'scatterRidgeAngle', 'reinforceOverhangEdges', 'liftHeight',
];

/** The placement settings a generation ran with; stored with the unit's supports so a later change shows. */
export function placementSignature(settings: LiveSupportSettings): JSONObject {
  return Object.fromEntries(PLACEMENT_KEYS.map((key) => [key, settings[key]]));
}

/**
 * The unit's placement settings changed since its contacts were placed (Support Edit Mode holds a
 * regeneration back, and leaving it does not run one). Derived, so Undo and Regenerate clear it by
 * themselves. A unit placed before settings were recorded, or with hand-added supports only, is not pending.
 */
export function placementPending(unit: PrintUnit): boolean {
  const placed = unit.supports?.data.placed as JSONObject | undefined;
  if (!placed) return false;
  const now = resolveSettings(unit.settings);
  return PLACEMENT_KEYS.some((key) => placed[key] !== now[key]);
}

const contactCache = new WeakMap<PrintUnit, readonly SupportContact[]>();
const builtCache = new WeakMap<PrintUnit, { dropped: readonly string[]; contacts: readonly SupportContact[] }>();

/** What the latest build omitted, with the no-support-zone subset recorded separately. */
export type BuiltSupports = Pick<GeneratedSupportMesh, 'dropped' | 'droppedByZones'>;

/** A unit's latest support build and the unit version it was built from. */
export interface UnitBuild<T extends BuiltSupports = GeneratedSupportMesh> {
  unit: PrintUnit;
  mesh: T;
}

/**
 * The build of `unit` as it is now, or undefined when the unit changed since (that build's
 * `dropped` may name contacts the current unit keeps). Checks and export use only this.
 */
export function currentBuild<T extends BuiltSupports>(unit: PrintUnit, latest: UnitBuild<T> | undefined): T | undefined {
  return latest?.unit === unit ? latest.mesh : undefined;
}

/** The current builds of `units` by unit id (see `currentBuild`), for the export plan. */
export function currentBuilds<T extends BuiltSupports>(units: readonly PrintUnit[], latest: ReadonlyMap<string, UnitBuild<T>>): Map<string, T> {
  const out = new Map<string, T>();
  for (const unit of units) {
    const mesh = currentBuild(unit, latest.get(unit.id));
    if (mesh) out.set(unit.id, mesh);
  }
  return out;
}

/**
 * Final contacts in unit-local space: automatic minus deleted and no-support zones, plus
 * manual, minus those whose support the unit's latest build (`built`) dropped at a secondary landing.
 * Units are immutable, so each list is worked out once per unit object and build; it is frozen and
 * shared by every caller, never to be changed in place.
 */
export function unitContacts(unit: PrintUnit, built: BuiltSupports | undefined): readonly SupportContact[] {
  let contacts = contactCache.get(unit);
  if (!contacts) {
    contacts = Object.freeze(jobContacts(contactInputs(unit)));
    contactCache.set(unit, contacts);
  }
  if (!built || built.dropped.length === 0) return contacts;
  const cached = builtCache.get(unit);
  if (cached?.dropped === built.dropped) return cached.contacts;
  const dropped = new Set(built.dropped);
  const kept = Object.freeze(contacts.filter((contact) => !dropped.has(contact.id)));
  builtCache.set(unit, { dropped: built.dropped, contacts: kept });
  return kept;
}

/** The unit's contacts as they would stand if `points` were its automatic placement (the tip preview): minus deleted, plus manual. */
export function contactsWith(unit: PrintUnit, points: readonly SupportPoint[]): readonly SupportContact[] {
  return jobContacts({ ...contactInputs(unit), points });
}

const rekeyedCache = new WeakMap<PrintUnit, { points: readonly SupportPoint[]; unit: PrintUnit }>();

/**
 * The unit with its removals and per-support settings followed onto `points`, a recomputed placement
 * (the tip preview). A project saved before the even belt names deleted tips by positions that
 * the new belt does not have; each removal moves to the nearest new tip, or resets when none is near.
 * It is the same match a fresh placement makes (`placementCommands`), so Generate lands what was shown.
 */
export function withRekeyedHandWork(unit: PrintUnit, points: readonly SupportPoint[]): PrintUnit {
  const cached = rekeyedCache.get(unit);
  if (cached?.points === points) return cached.unit;
  const matchRadius = resolveSettings(unit.settings).scatterSpacing / 2;
  const handWork = rekeyHandWork(unit.deleted, unit.contactSettings, new Set(unit.manual.map((point) => point.id)), points, matchRadius);
  const sameDeleted = handWork.deleted.length === unit.deleted.length && handWork.deleted.every((id, k) => id === unit.deleted[k]);
  const out = sameDeleted && Object.keys(handWork.overrides).length === Object.keys(unit.contactSettings).length && Object.keys(handWork.overrides).every((id) => id in unit.contactSettings)
    ? unit : { ...unit, deleted: handWork.deleted, contactSettings: handWork.overrides };
  rekeyedCache.set(unit, { points, unit: out });
  return out;
}

const hiddenCache = new WeakMap<PrintUnit, { droppedByZones: readonly string[] | undefined; count: number }>();

/**
 * How many automatic supports the unit's no-support zones hide: the contacts a zone takes out of
 * the list, plus those the shown build dropped because their column lands in a zone. Manual
 * supports are never hidden by zones (neither the contact list nor the build drops them), so they
 * are not counted. Worked out once per unit object and build.
 */
export function hiddenByZones(unit: PrintUnit, built: BuiltSupports | undefined): number {
  if (unit.zones.length === 0) return 0;
  const dropped = built?.droppedByZones ?? built?.dropped;
  const cached = hiddenCache.get(unit);
  if (cached && cached.droppedByZones === dropped) return cached.count;
  const automatic = (contacts: readonly SupportContact[]) => contacts.filter((contact) => contact.origin !== 'manual').length;
  const zoneDropped = new Set(dropped);
  const visible = jobContacts(contactInputs(unit)).filter((contact) => !zoneDropped.has(contact.id));
  const count = automatic(jobContacts({ ...contactInputs(unit), zones: [] })) - automatic(visible);
  hiddenCache.set(unit, { droppedByZones: dropped, count });
  return count;
}

/** The unit's edits that decide its contacts. */
function contactInputs(unit: PrintUnit): ContactInputs {
  return { points: unit.placement?.points ?? [], manual: unit.manual, deleted: unit.deleted, zones: unit.zones, contactSettings: unit.contactSettings };
}

const removedCache = new WeakMap<PrintUnit, number>();

/**
 * How many of the unit's removals (deleted IDs) hide a contact right now; one whose
 * spot is gone after a regeneration, or that was made before any placement, is not counted.
 */
export function unitRemovedCount(unit: PrintUnit): number {
  let count = removedCache.get(unit);
  if (count === undefined) {
    count = hidingRemovals(unit.placement?.points ?? [], unit.deleted).size;
    removedCache.set(unit, count);
  }
  return count;
}

/**
 * The transform the supports were generated at. Supports stay rigid with the model
 * afterwards (they share the unit parent), so plate space is this transform's frame.
 */
export function generationTransform(unit: PrintUnit): ModelTransform {
  const stored = unit.supports?.data.transform as unknown as ModelTransform | undefined;
  return stored && Array.isArray(stored.position) && Array.isArray(stored.rotation) ? stored : unit.transform;
}

/**
 * The plate's height in the generation frame: 0 after a generate; a lift change keeps that frame
 * (and the model placed by it, with every cache keyed on it) and moves the plate instead.
 */
export function generationPlate(unit: PrintUnit): number {
  const plate = unit.supports?.data.plate;
  return typeof plate === 'number' && Number.isFinite(plate) ? plate : 0;
}

/** Rotation without translation: the frame placement and checks analyse a unit in (map their results back with it). */
export function orientationOf(unit: PrintUnit): JobTransform {
  return { position: [0, 0, 0], rotation: [...unit.transform.rotation] };
}

/** The unit's support mesh job; the unit's own source mesh goes in as is (callers copy before a transfer). */
export function supportJobOf(unit: PrintUnit, unitIndex: number, mode: 'preview' | 'export' = 'preview'): SupportJob {
  const settings = resolveSettings(unit.settings);
  return {
    mesh: unit.source,
    frame: unit.supports === undefined ? null : generationTransform(unit),
    ...(generationPlate(unit) !== 0 ? { plate: generationPlate(unit) } : {}),
    settings,
    contacts: contactInputs(unit),
    // The label is the object's own text, else its letter A, B, …
    labelText: settings.labelText || labelForIndex(unitIndex),
    mode,
  };
}

/** Automatic placement of the unit, analysed turned but not moved (so moving never shifts the lattice). */
export function placementJobOf(unit: PrintUnit): PlacementJob {
  return { mesh: unit.source, orientation: orientationOf(unit), settings: toPlacementSettings(resolveSettings(unit.settings)) };
}

/** Support check of the unit's current contacts (as its latest build left them), in the same turned frame as placement. */
export function checkJobOf(unit: PrintUnit, built: BuiltSupports | undefined): CheckJob {
  const settings = resolveSettings(unit.settings);
  return {
    mesh: unit.source,
    orientation: orientationOf(unit),
    contacts: unitContacts(unit, built).map((contact) => [...contact.position]),
    settings: { overhangAngleDegrees: settings.scatterAngle, spacing: settings.scatterSpacing },
  };
}

/** Live support mesh for a unit in its local space, ready to render under the unit's parent group. */
export function unitSupportMesh(unit: PrintUnit, unitIndex: number, mode: 'preview' | 'export' = 'preview', onProgress?: ProgressCallback): GeneratedSupportMesh {
  return runSupportJob(supportJobOf(unit, unitIndex, mode), onProgress);
}

/**
 * Lowest plate-space y of the unit's model: exactly `meshBounds(applyTransform(unit.source,
 * unit.transform)).min[1]` (same matrix, same float32 rounding) without copying the model, so
 * Generate costs no full-mesh copy on the main thread.
 */
export function unitLowestY(unit: PrintUnit): number {
  return transformedMinY(unit.source.positions, unit.transform);
}

/**
 * A lift height change of a placed unit, as commands: placement analyses the turned, unmoved model,
 * so the lift moves no contact. Only the height changes (the lowest point `settings.liftHeight`
 * above the plate, like `placementCommands`), in the batch that sets the settings, so the supports
 * are rebuilt once and no placement job runs. The supports keep their generation frame and the plate
 * moves in it instead (`generationPlate`: the frame's height above the unit's new one), so the
 * rebuild reuses the placed model and its caches; a unit turned since takes the new frame. Undefined
 * when the unit has no placed supports, or another placement setting is pending (it is placed again).
 */
export function liftCommands(unit: PrintUnit, settings: LiveSupportSettings): SceneCommand[] | undefined {
  if (!unit.supports || !unit.placement) return undefined;
  const placed = unit.supports.data.placed as JSONObject | undefined;
  if (placed && PLACEMENT_KEYS.some((key) => key !== 'liftHeight' && placed[key] !== settings[key])) return undefined;
  const [x, y, z] = unit.transform.position;
  const transform: ModelTransform = { position: [x, y + settings.liftHeight - unitLowestY(unit), z], rotation: [...unit.transform.rotation] };
  const frame = generationTransform(unit);
  const turned = frame.rotation.some((angle, axis) => angle !== transform.rotation[axis]);
  const kept = turned ? transform : frame;
  const { plate: _plate, ...data } = unit.supports.data;
  const plate = turned ? 0 : frame.position[1] - transform.position[1];
  return [
    { type: 'transform/set', unitId: unit.id, transform },
    { type: 'supports/set', unitId: unit.id, placement: unit.placement, supports: { ...unit.supports, data: {
      ...data,
      transform: { position: [...kept.position], rotation: [...kept.rotation] },
      ...(plate !== 0 ? { plate } : {}),
      ...(placed ? { placed: { ...placed, liftHeight: settings.liftHeight } } : {}),
    } } },
  ];
}

/**
 * A finished placement's contacts as the unit stores them. They come back in the turned frame;
 * unit-local space is that frame turned back, and their IDs are re-derived from the unit-local
 * position, so an ID and the stored position share one frame.
 */
export function placedPoints(orientation: JobTransform, result: Pick<PlacementResult, 'points'>): SupportPoint[] {
  const positions = result.points.map((point) => inverseTransformPoint(orientation, point.position));
  const ids = positionIds(positions);
  return result.points.map((point, k): SupportPoint => ({ ...point, id: ids[k]!, position: positions[k]!, normal: inverseTransformDirection(orientation, point.normal) }));
}

/**
 * The commands that apply a finished placement to the unit as it is now (placement can take
 * tens of seconds on a big model, and the gizmo stays live meanwhile). A move made in the
 * meantime is kept: only the height changes, so the lowest point sits `liftHeight` above the
 * plate. `placed`: the placement settings it ran with (see `placementPending`). The unit's removals
 * and per-support settings follow the new contacts (`handWork` says what became of them). Undefined
 * when the unit was rotated since `orientation` was analysed: its contacts face the old way, so the
 * caller places again rather than undo the rotation.
 */
export function placementCommands(unit: PrintUnit, orientation: JobTransform, result: Pick<PlacementResult, 'points' | 'regions'>, liftHeight: number, matchRadius: number, placed?: JSONObject): { commands: SceneCommand[]; handWork: RekeyedHandWork<ContactSettings[string]> } | undefined {
  if (unit.transform.rotation.some((angle, axis) => angle !== orientation.rotation[axis])) return undefined;
  const [x, y, z] = unit.transform.position;
  const transform: ModelTransform = { position: [x, y + liftHeight - unitLowestY(unit), z], rotation: [...unit.transform.rotation] };
  const points = placedPoints(orientation, result);
  const handWork = rekeyHandWork(unit.deleted, unit.contactSettings, new Set(unit.manual.map((point) => point.id)), points, matchRadius);
  const commands: SceneCommand[] = [
    { type: 'transform/set', unitId: unit.id, transform },
    {
      type: 'supports/set',
      unitId: unit.id,
      placement: {
        points,
        regions: result.regions,
        contactPositions: new Float32Array(points.flatMap((point) => point.position)),
        contactNormals: new Float32Array(points.flatMap((point) => point.normal)),
      },
      supports: { kind: 'live', data: { transform: { position: [...transform.position], rotation: [...transform.rotation] }, ...(placed ? { placed } : {}) } },
    },
    { type: 'handWork/set', unitId: unit.id, deleted: handWork.deleted, contactSettings: handWork.overrides },
  ];
  return { commands, handWork };
}
