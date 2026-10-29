// Types of the scene a unit (one printable object) carries, from mixodental src/state/project.ts.
// Only the types: the scene reducer, normalisers and (de)serialisation are not ported (mixomesh
// stores supports on its own objects and its own undo stack, plan D21).
import type { DentalPolicy } from '../dental/dentalPolicy';
import type { PlacementResult, SupportPoint, TriangleMesh } from '../core/analysis/types';
import type { ShapeOverride } from '../core/supports/settings';
import type { ZoneStamp } from '../core/supports/zones';
import type { ModelTransform } from './transform';

/** JSON scalar. */
export type JSONPrimitive = string | number | boolean | null;
/** Any JSON value. */
export type JSONValue = JSONPrimitive | JSONValue[] | { [key: string]: JSONValue };
/** A JSON object. */
export type JSONObject = { [key: string]: JSONValue };

/** A unit's stored support settings: a JSON form of `LiveSupportSettings`, possibly partial (see `unitSupports.resolveSettings`). */
export type SupportSettings = JSONObject & { preset?: string };

/** A serializable representation of geometry derived from support contacts. */
export interface SupportMesh {
  kind: string;
  data: JSONObject;
}

/** Per-support shape overrides by contact id. */
export type ContactSettings = Record<string, ShapeOverride>;

/**
 * One printable object on the plate and everything its supports are made from. Immutable: every
 * change makes a new object (the `unitSupports` caches are keyed on it).
 */
export interface PrintUnit {
  id: string;
  name: string;
  /** Imported model geometry; the scene owns a private copy that commands never mutate. */
  source: TriangleMesh;
  transform: ModelTransform;
  settings: SupportSettings;
  /** The latest automatic placement (unit-local); absent before one. */
  placement?: PlacementResult;
  /** The supports' stored data (`data.transform` generation frame, `data.plate`, `data.placed`); absent: no supports. */
  supports?: SupportMesh;
  /** Hand-added contacts (unit-local). */
  manual: SupportPoint[];
  /** Exact removals by contact ID: each hides one automatic contact and nothing else. */
  deleted: string[];
  /** Ordered brush stamps of no-support zones (the last covering stamp wins); automatic contacts inside are dropped. */
  zones: ZoneStamp[];
  /** Per-support settings by exact contact id: only the keys the user set. */
  contactSettings: ContactSettings;
  /** Dental (host/dental): accepted local dental footprint and its ordered allow/erase edits; absent until the workflow is approved. */
  dental?: DentalPolicy;
}

/** The plate: its units and the selection. */
export interface PrintScene {
  units: PrintUnit[];
  selectedUnitIds: string[];
  activeUnitId?: string;
}

/** The scene edits the app's reducer applies (the reducer itself lives in the app). */
export type SceneCommand =
  | { type: 'batch'; commands: SceneCommand[] }
  | { type: 'unit/add'; unit: PrintUnit; owned?: boolean }
  | { type: 'unit/remove'; unitId: string }
  | { type: 'supports/clear-manual'; unitId: string }
  | { type: 'supports/set'; unitId: string; placement?: PlacementResult; supports?: SupportMesh }
  | { type: 'supports/remove'; unitId: string }
  | { type: 'selection/set'; unitIds: string[]; activeUnitId?: string }
  | { type: 'transform/set'; unitId: string; transform: ModelTransform }
  | { type: 'settings/set'; unitId: string; settings: SupportSettings }
  | { type: 'manual/add'; unitId: string; point: SupportPoint }
  | { type: 'manual/remove'; unitId: string; pointId: string }
  | { type: 'deletion/add'; unitId: string; pointIds: string[] }
  | { type: 'handWork/set'; unitId: string; deleted: string[]; contactSettings: ContactSettings }
  | { type: 'zones/add'; unitId: string; stamps: ZoneStamp[] }
  | { type: 'zones/clear'; unitId: string }
  | { type: 'contactSettings/set'; unitId: string; contactIds: string[]; patch: ShapeOverride }
  | { type: 'contactSettings/reset'; unitId: string; contactIds: string[] };
