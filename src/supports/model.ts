/**
 * Supports data model (plan 2026-10-29 P3.1). One record per logical object, stored on the
 * logical-object LEAD as `object.supports` (never on a part; `canonicalObjectId`).
 *
 * Frame: every point, normal and stamp is in the object's support frame: the engine frame (mm,
 * right-handed, Y up, `frame.ts`) of the object at its build pose, minus its bounding-box centre
 * (`supportJob.toLocal`). Translation therefore never invalidates hand work; rotation and scale do,
 * and are recorded in `pose` (stale rule, `stale.ts`).
 *
 * State is JSON-safe (D19): plain arrays and objects only. Stamps, the one list that grows with use,
 * are packed 7 numbers per stamp and switch to base64 Float64 once they pass 10k numbers.
 *
 * Settings are the full `LiveSupportSettings` (complete, so a later default change never moves an
 * object's supports): `settings.preset` is the preset name (LIGHT / MIDDLE / HEAVY / CUSTOM) and
 * `settings.liftHeight` the lift in mm (P3 lift decision). They are read through `presetName` and
 * `liftMm`, not copied into fields of their own that could drift.
 *
 * Multi-part logical objects (P3.3): the support frame belongs to the whole logical object and the
 * drawn supports follow the LEAD's translation only (layers/index.ts, BabylonViewportPort anchor).
 * This assumes the parts stay fixed relative to the lead. It holds by construction: `sourceHash` is
 * taken over the parts in the lead's local frame (sceneSource `leadLocalParts`), so a part moved,
 * rotated or scaled on its own changes the hash and the supports go stale ('geometry') instead of
 * silently drifting from that part.
 */
import type { SupportPoint } from '@mixo-geocore/host/core/analysis/types';
import type { ZoneStamp } from '@mixo-geocore/host/core/supports/zones';
import type { LiveSupportSettings, ShapeOverride, SupportPreset } from '@mixo-geocore/host/core/supports/settings';
import { PLACEMENT_KEYS } from '@mixo-geocore/host/supports/unitSupports';
import { presetSettings } from './supportJob';

/** Rotation (unit quaternion x, y, z, w) and scale of the lead at build time; translation is free. */
export interface SupportPose {
  rotation: [number, number, number, number];
  scale: [number, number, number];
}

/** Why built supports no longer fit their object; null = they fit. */
export type StaleReason = 'geometry' | 'pose';

/**
 * Zone stamps in order (the last covering stamp wins). `kinds`: one char per stamp, `p` paint
 * (no-support zone) or `e` erase. `data`: 7 numbers per stamp (center xyz, radius, normal xyz),
 * a plain array up to `PACK_LIMIT` numbers, else base64 of the Float64 values.
 */
export interface PackedStamps {
  kinds: string;
  data: number[] | string;
}

/** The placement settings the contacts were placed with (unitSupports `placementSignature`). */
export type PlacementSignature = Record<string, number | boolean>;

export interface ObjectSupports {
  settings: LiveSupportSettings;
  /** Automatic contact ids the user removed (ids encode the position, `auto-X_Y_Z`). */
  deleted: string[];
  /** Hand-added contacts, support frame. */
  manual: SupportPoint[];
  /** Per-support shape settings by contact id (automatic or manual): only the keys the user set. */
  overrides: Record<string, ShapeOverride>;
  stamps: PackedStamps;
  /** Hash of the welded engine copy the contacts were placed on (`sourceHash.ts`); null = never built. */
  sourceHash: string | null;
  /** Lead pose at build time; null = never built. */
  pose: SupportPose | null;
  /** Placement settings of the last placement; null = never placed. */
  placed: PlacementSignature | null;
  /** Bumped by every edit (monotonic across undo, `nextRevision`); the runtime caches key on it. */
  revision: number;
  /** Derived by `stale.ts`, written outside history. */
  stale: StaleReason | null;
}

/** Numbers above which a packed list is stored as base64 (D19). */
export const PACK_LIMIT = 10_000;
const STAMP_STRIDE = 7;

export function presetName(s: Pick<ObjectSupports, 'settings'>): SupportPreset {
  return s.settings.preset;
}

export function liftMm(s: Pick<ObjectSupports, 'settings'>): number {
  return s.settings.liftHeight;
}

export function emptySupports(settings: LiveSupportSettings = presetSettings('MIDDLE')): ObjectSupports {
  return {
    settings: cloneJson(settings),
    deleted: [],
    manual: [],
    overrides: {},
    stamps: { kinds: '', data: [] },
    sourceHash: null,
    pose: null,
    placed: null,
    revision: 0,
    stale: null,
  };
}

/** Whether the record carries a build (stale detection applies). */
export function isBuilt(s: ObjectSupports | undefined | null): boolean {
  return !!s && s.sourceHash !== null && s.pose !== null;
}

export function placementSignature(settings: LiveSupportSettings): PlacementSignature {
  return Object.fromEntries(PLACEMENT_KEYS.map((key) => [key, settings[key] as number | boolean]));
}

let lastRevision = 0;

/** A revision never handed out before in this session (and above `current`). */
export function nextRevision(current: number): number {
  lastRevision = Math.max(lastRevision, current) + 1;
  return lastRevision;
}

// ── packed numbers ───────────────────────────────────────

export function packNumbers(values: readonly number[]): number[] | string {
  if (values.length <= PACK_LIMIT) return [...values];
  const bytes = new Uint8Array(Float64Array.from(values).buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export function unpackNumbers(data: number[] | string): number[] {
  if (Array.isArray(data)) return [...data];
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return Array.from(new Float64Array(bytes.buffer));
}

export function readStamps(packed: PackedStamps): ZoneStamp[] {
  const data = unpackNumbers(packed.data);
  const out: ZoneStamp[] = [];
  for (let k = 0; k < packed.kinds.length; k++) {
    const o = k * STAMP_STRIDE;
    out.push({
      kind: packed.kinds[k] === 'p' ? 'paint' : 'erase',
      center: [data[o]!, data[o + 1]!, data[o + 2]!],
      radius: data[o + 3]!,
      normal: [data[o + 4]!, data[o + 5]!, data[o + 6]!],
    });
  }
  return out;
}

export function packStamps(stamps: readonly ZoneStamp[]): PackedStamps {
  const data: number[] = [];
  let kinds = '';
  for (const s of stamps) {
    kinds += s.kind === 'paint' ? 'p' : 'e';
    data.push(s.center[0], s.center[1], s.center[2], s.radius, s.normal[0], s.normal[1], s.normal[2]);
  }
  return { kinds, data: packNumbers(data) };
}

export function appendStamps(packed: PackedStamps, stamps: readonly ZoneStamp[]): PackedStamps {
  return packStamps([...readStamps(packed), ...stamps]);
}

// ── pose ─────────────────────────────────────────────────

const ROT_EPS = 1e-9;
const SCALE_EPS = 1e-6;

/** Same rotation (q and -q are one rotation) and scale, within float noise of a decompose. */
export function samePose(a: SupportPose, b: SupportPose): boolean {
  const dot = a.rotation[0] * b.rotation[0] + a.rotation[1] * b.rotation[1] + a.rotation[2] * b.rotation[2] + a.rotation[3] * b.rotation[3];
  if (1 - Math.abs(dot) > ROT_EPS) return false;
  return a.scale.every((s, i) => Math.abs(s - b.scale[i]!) <= SCALE_EPS * Math.max(1, Math.abs(s)));
}

export function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
