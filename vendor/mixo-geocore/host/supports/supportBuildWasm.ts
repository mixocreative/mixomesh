import type { ContactIntent, SupportPart } from '../core/supports/mesh';
import { SHAPE_KEYS, type LiveSupportSettings, type SettingKey, type ShapeOverride } from '../core/supports/settings';
import type { ZoneStamp } from '../core/supports/zones';
import type { Vector } from '../core/vec3';

/*
 * Host adapter for the Rust support calls: packs validated settings, contacts and zones into the flat
 * typed arrays the ABI takes, and unpacks the component tags `generate` returns. Layouts
 * are defined in crates/geometry-core/src/supports/{settings,flat}.rs and checked against the engine.
 */

/** Order of the flat settings array (Rust `SETTINGS_LAYOUT`). */
export const SETTINGS_ORDER = [
  'contactShape', 'pointDiameter', 'pointDepth', 'tipSection', 'tipCrossWidth', 'tipProfile',
  'touchDiameter', 'touchDepth', 'neckDiameter', 'neckLength', 'maxNeckAngle',
  'pillarDiameter', 'treeSectionIncrement', 'baseDiameter', 'baseHeight',
  'trussEnabled', 'trussDiameter', 'trussAngle', 'trussSpacing', 'trussMinHeight', 'trussTopSpacing', 'trussDistanceLimit',
  'raftEnabled', 'raftExpandWidth', 'raftFloorThickness', 'raftWallHeight', 'raftWallThickness', 'raftWallAngle', 'voxelResolution',
  'roofMode', 'roofGap', 'cageSideGap', 'cageTopGap', 'cagePitch', 'cageRingDiameter', 'columnCount', 'columnDiameter',
  'diagonalEnabled', 'diagonalDiameter', 'braceConcentric', 'braceThickness', 'braceAngle', 'storeyFloorThickness', 'storeyEncloseCeiling',
  'labelEnabled', 'labelSize', 'labelHeight', 'labelMargin', 'labelOffsetX', 'labelOffsetY',
  'previewMode', 'autoSnap', 'lowPolyMode', 'resolution',
  'scatterSpacing', 'scatterAngle', 'scatterSafeDistance', 'scatterFacingDown', 'scatterIslands', 'scatterRidgeAngle',
  'scatterAutoTree', 'scatterMergeDistance', 'scatterBranchDescent', 'reinforceOverhangEdges',
  'liftHeight', 'eraseRadius',
] as const satisfies readonly SettingKey[];

/** Order of a per-contact shape override (Rust `SHAPE_LAYOUT`); the same order as `SHAPE_KEYS`. */
export const SHAPE_ORDER = [
  'contactShape', 'tipSection', 'tipCrossWidth', 'tipProfile', 'pointDiameter', 'touchDiameter', 'pointDepth',
  'touchDepth', 'neckDiameter', 'neckLength', 'maxNeckAngle', 'baseDiameter', 'baseHeight',
] as const satisfies readonly (typeof SHAPE_KEYS)[number][];

const ENUMS: Record<string, readonly string[]> = {
  contactShape: ['NONE', 'SPHERE'],
  tipSection: ['ROUND', 'SQUARE', 'CROSS'],
  tipProfile: ['TAPERED', 'STRAIGHT'],
  roofMode: ['OFF', 'ROOF', 'CAGE'],
  previewMode: ['FULL', 'ONLY_TIP'],
};

function encode(key: string, value: unknown): number {
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'string') {
    const code = ENUMS[key]?.indexOf(value) ?? -1;
    if (code < 0) throw new RangeError(`${key}: unknown value ${value}`);
    return code;
  }
  return value as number;
}

export function packSettings(settings: Readonly<LiveSupportSettings>): Float64Array {
  return Float64Array.from(SETTINGS_ORDER, (key) => encode(key, settings[key]));
}

export const ZONE_STRIDE = 8;

export function packZones(zones: readonly ZoneStamp[]): Float64Array {
  const flat = new Float64Array(zones.length * ZONE_STRIDE);
  zones.forEach((z, k) => flat.set([...z.center, ...z.normal, z.radius, z.kind === 'paint' ? 1 : 0], k * ZONE_STRIDE));
  return flat;
}

/** A contact as the Rust column builder takes it; the neck normal is sampled on the remesh by Rust (by `kind`). */
export interface ColumnInput {
  id: string;
  position: Vector;
  normal: Vector;
  sourceFace?: number;
  origin: 'auto' | 'manual';
  /** SLASG point class: `face` and `edge` contacts take their neck normal from the remesh, `vertical` ones point straight down. */
  kind?: 'face' | 'edge' | 'vertical';
  shape?: ShapeOverride;
}

export const CONTACT_STRIDE = 17;
const KIND_CODE = { face: 1, edge: 2, vertical: 3 } as const;

export function packContacts(contacts: readonly ColumnInput[]): { contacts: Float64Array; shapes: Float64Array } {
  const flat = new Float64Array(contacts.length * CONTACT_STRIDE);
  contacts.forEach((c, k) => {
    flat.set([...c.position, ...c.normal, c.sourceFace ?? -1, c.origin === 'manual' ? 1 : 0, 0, 0, 0, 0, 0, 0, 0, -1, c.kind ? KIND_CODE[c.kind] : 0], k * CONTACT_STRIDE);
  });
  const any = contacts.some((c) => c.shape && Object.keys(c.shape).length > 0);
  const shapes = any ? new Float64Array(contacts.length * SHAPE_ORDER.length).fill(NaN) : new Float64Array();
  if (any) {
    contacts.forEach((c, k) => SHAPE_ORDER.forEach((key, i) => {
      const value = c.shape?.[key];
      if (value !== undefined) shapes[k * SHAPE_ORDER.length + i] = encode(key, value);
    }));
  }
  return { contacts: flat, shapes };
}

const PARTS: readonly SupportPart[] = [
  'tip', 'neck', 'pillar', 'foot', 'brace', 'raft', 'tree-branch', 'tree-trunk', 'roof', 'column', 'roof-brace', 'cross-bar', 'cage-ring', 'label',
];
const NO_CONTACT = 0xffffffff;

export interface TaggedComponent {
  part: SupportPart;
  structureKind?: 'tree';
  contactId?: string;
  /** Origin of the owning contact; absent for structural parts. */
  origin?: 'auto' | 'manual';
  start: number;
  count: number;
  landingReach?: number;
  contactIntent?: ContactIntent[];
}

/** Decodes the per-component tag tables of the Rust build (layout in `supports/flat.rs`); `idOf` names a contact by its index in the build input. */
export function decodeComponents(tags: Uint32Array, reach: Float64Array, intents: Float64Array, idOf: (contact: number) => string): TaggedComponent[] {
  const components: TaggedComponent[] = [];
  for (let k = 0; k < reach.length; k += 1) {
    const t = k * 8;
    const contact = tags[t + 2]!;
    const origin = tags[t + 3]!;
    const intentStart = tags[t + 6]! * 9;
    const intentCount = tags[t + 7]!;
    components.push({
      part: PARTS[tags[t]!]!,
      ...(contact === NO_CONTACT ? {} : { contactId: idOf(contact) }),
      ...(origin === 0 ? {} : { origin: origin === 2 ? 'manual' as const : 'auto' as const }),
      start: tags[t + 4]!,
      count: tags[t + 5]!,
      ...(Number.isNaN(reach[k]!) ? {} : { landingReach: reach[k]! }),
      ...(intentCount === 0 ? {} : {
        contactIntent: Array.from({ length: intentCount }, (_, j): ContactIntent => {
          const o = intentStart + j * 9;
          const face = intents[o + 2]!;
          const point = [intents[o + 3]!, intents[o + 4]!, intents[o + 5]!] as Vector;
          const normal = [intents[o + 6]!, intents[o + 7]!, intents[o + 8]!] as Vector;
          return intents[o] === 1
            ? { kind: 'primary', contactId: idOf(intents[o + 1]!), point, normal, ...(face < 0 ? {} : { faceIndex: face }) }
            : { kind: 'secondary', point, normal, ...(face < 0 ? {} : { faceIndex: face }) };
        }),
      }),
      // Key order follows the TS builder so serialised tags compare equal.
      ...(tags[t + 1] === 1 ? { structureKind: 'tree' as const } : {}),
    });
  }
  return components;
}
