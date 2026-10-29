/**
 * Support core jobs: everything placement, a support check or a support mesh build needs, as plain
 * data (no app types), so any host can run them on any thread. The app makes them from its units
 * in `src/supports/unitSupports.ts` (the only adapter) and runs them with `src/supports/jobRunner.ts`.
 *
 * Meshes are unit-local; a job's transform says where the unit stood (Euler XYZ radians, mm).
 */
import type { CheckSettings } from './analysis/supportCheck';
import type { PlacementSettings, SupportPoint, TriangleMesh } from './analysis/types';
import type { LiveSupportSettings, ShapeOverride } from './supports/settings';
import type { ZoneStamp } from './supports/zones';
import type { Vector } from './vec3';

/** Position and Euler XYZ rotation (radians) of a unit on the plate. */
export interface JobTransform {
  position: Vector;
  rotation: Vector;
}

/** The unit's edits that decide its final contacts. */
export interface ContactInputs {
  /** Automatic placement points (none before a placement). */
  points: readonly SupportPoint[];
  manual: readonly SupportPoint[];
  /** Exact removals by contact ID. */
  deleted: readonly string[];
  zones: readonly ZoneStamp[];
  /** Per-support settings by contact id; a contact without an entry is built from the job's settings. */
  contactSettings: Readonly<Record<string, ShapeOverride>>;
}

/** One unit's support mesh, built in unit-local space. */
export interface SupportJob {
  mesh: TriangleMesh;
  /** The transform the supports were generated at (the build frame); null: no supports, an empty mesh. */
  frame: JobTransform | null;
  /**
   * The plate's height in `frame` (absent: 0, the frame's own plate). A lift change keeps `frame`, so
   * the build reuses the model placed by it and every cache on it, and moves the plate instead.
   */
  plate?: number;
  settings: LiveSupportSettings;
  contacts: ContactInputs;
  /** Label text embossed on the raft (the unit's own text or its automatic letter). */
  labelText: string;
  mode: 'preview' | 'export';
}

/** Automatic placement on the model turned by `orientation` (its position is ignored). */
export interface PlacementJob {
  mesh: TriangleMesh;
  orientation: JobTransform;
  settings: PlacementSettings;
}

/** What the contacts leave unsupported, with model and contacts turned by `orientation`. */
export interface CheckJob {
  mesh: TriangleMesh;
  orientation: JobTransform;
  /** Unit-local contact positions. */
  contacts: Vector[];
  settings: CheckSettings;
}
