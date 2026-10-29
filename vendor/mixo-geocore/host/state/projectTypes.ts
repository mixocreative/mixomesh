// Types of the scene a unit (one printable object) carries, from mixodental src/state/project.ts.
// Only the types: the scene reducer, normalisers and (de)serialisation are not ported (mixomesh
// stores supports on its own objects and its own undo stack, plan D21).
import type { DentalPolicy } from '../dental/dentalPolicy';
import type { PlacementResult, SupportPoint, TriangleMesh } from '../core/analysis/types';
import type { ShapeOverride } from '../core/supports/settings';
import type { ZoneStamp } from '../core/supports/zones';
import type { ModelTransform } from './transform';

export type JSONPrimitive = string | number | boolean | null;
export type JSONValue = JSONPrimitive | JSONValue[] | { [key: string]: JSONValue };
export type JSONObject = { [key: string]: JSONValue };

export type SupportSettings = JSONObject & { preset?: string };

/** A serializable representation of geometry derived from support contacts. */
export interface SupportMesh {
  kind: string;
  data: JSONObject;
}

export type ContactSettings = Record<string, ShapeOverride>;

export interface PrintUnit {
  id: string;
  name: string;
  /** Imported model geometry; the scene owns a private copy that commands never mutate. */
  source: TriangleMesh;
  transform: ModelTransform;
  settings: SupportSettings;
  placement?: PlacementResult;
  supports?: SupportMesh;
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

export interface PrintScene {
  units: PrintUnit[];
  selectedUnitIds: string[];
  activeUnitId?: string;
}

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
