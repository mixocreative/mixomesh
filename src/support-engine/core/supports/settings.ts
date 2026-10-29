import type { PlacementSettings } from '../analysis/types';

/**
 * Live support settings transcribed from the Blender Resin UV support tab
 * (`mixo3d/properties.py` + `helpers/slasg_map.py`). Lengths are millimetres and
 * angles are degrees. Bake and hidden proxy/original-copy settings are excluded.
 */
export type PresetName = 'LIGHT' | 'MIDDLE' | 'HEAVY';
export type SupportPreset = PresetName | 'CUSTOM';
export type RoofMode = 'OFF' | 'ROOF' | 'CAGE';
export type PreviewMode = 'FULL' | 'ONLY_TIP';
/** What touches the model: a Contact Ø sphere or the tip itself. */
export type ContactShape = 'NONE' | 'SPHERE';
/** Cross-section of the tip: round, square or a "+" of two plates. */
export type TipSection = 'ROUND' | 'SQUARE' | 'CROSS';
/** Tapered narrows from Middle Ø to the contact end (cone, pyramid); Straight keeps the end Ø. */
export type TipProfile = 'TAPERED' | 'STRAIGHT';

export type LiveSupportSettings = {
  preset: SupportPreset;
  // Top / contact
  contactShape: ContactShape;
  /** Diameter of the tip end touching the model when Contact shape is None. */
  pointDiameter: number;
  /** How far that tip end sinks into the model so it fuses; None only. */
  pointDepth: number;
  tipSection: TipSection;
  /** Width of each plate of a Cross tip, in % of the tip Ø. */
  tipCrossWidth: number;
  tipProfile: TipProfile;
  touchDiameter: number;
  touchDepth: number;
  neckDiameter: number;
  neckLength: number;
  maxNeckAngle: number;
  // Middle / pillar
  pillarDiameter: number;
  treeSectionIncrement: number;
  // Bottom / base
  baseDiameter: number;
  baseHeight: number;
  // Bracing
  trussEnabled: boolean;
  trussDiameter: number;
  trussAngle: number;
  trussSpacing: number;
  trussMinHeight: number;
  trussTopSpacing: number;
  trussDistanceLimit: number;
  // Raft
  raftEnabled: boolean;
  raftExpandWidth: number;
  raftFloorThickness: number;
  raftWallHeight: number;
  raftWallThickness: number;
  raftWallAngle: number;
  voxelResolution: number;
  // Roof / cage
  roofMode: RoofMode;
  /** Modes whose defaults were already seeded; Blender seeds a mode only on first use. */
  roofSeededModes: Exclude<RoofMode, 'OFF'>[];
  roofGap: number;
  cageSideGap: number;
  cageTopGap: number;
  cagePitch: number;
  cageRingDiameter: number;
  columnCount: number;
  columnDiameter: number;
  diagonalEnabled: boolean;
  diagonalDiameter: number;
  braceConcentric: number;
  braceThickness: number;
  braceAngle: number;
  storeyFloorThickness: number;
  storeyEncloseCeiling: boolean;
  // Letter label
  labelEnabled: boolean;
  labelText: string;
  labelSize: number;
  labelHeight: number;
  labelMargin: number;
  labelOffsetX: number;
  labelOffsetY: number;
  // Advanced
  previewMode: PreviewMode;
  autoSnap: boolean;
  lowPolyMode: boolean;
  resolution: number;
  // Automatic placement
  scatterSpacing: number;
  scatterAngle: number;
  scatterSafeDistance: number;
  scatterFacingDown: boolean;
  scatterIslands: boolean;
  scatterRidgeAngle: number;
  scatterAutoTree: boolean;
  scatterMergeDistance: number;
  scatterBranchDescent: number;
  reinforceOverhangEdges: boolean;
  // Unit placement and editing
  liftHeight: number;
  eraseRadius: number;
};

export type SettingKey = Exclude<keyof LiveSupportSettings, 'preset' | 'roofSeededModes'>;
type NumericKey = { [K in SettingKey]: LiveSupportSettings[K] extends number ? K : never }[SettingKey];

/**
 * The settings one support may own (tip, contact, neck and foot). Pillar thickness is not one:
 * trees, braces and the raft share it, so it stays object-wide.
 */
export const SHAPE_KEYS = [
  'contactShape', 'tipSection', 'tipCrossWidth', 'tipProfile',
  'pointDiameter', 'touchDiameter', 'pointDepth', 'touchDepth', 'neckDiameter',
  'neckLength', 'maxNeckAngle', 'baseDiameter', 'baseHeight',
] as const satisfies readonly SettingKey[];
export type ShapeKey = typeof SHAPE_KEYS[number];
export type ShapeSettings = Pick<LiveSupportSettings, ShapeKey>;
/** One support's own values: only the keys the user set; every other key follows the object. */
export type ShapeOverride = Partial<ShapeSettings>;

const SHAPE_CHOICES: { [K in ShapeKey]?: readonly LiveSupportSettings[K][] } = {
  contactShape: ['NONE', 'SPHERE'],
  tipSection: ['ROUND', 'SQUARE', 'CROSS'],
  tipProfile: ['TAPERED', 'STRAIGHT'],
};

/** Untrusted input (a project file, a command) as a shape override: unknown keys and wrong values dropped, lengths clamped. */
export function parseShapeOverride(value: unknown): ShapeOverride {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  const input = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of SHAPE_KEYS) {
    const entry = input[key];
    if (entry === undefined) continue;
    const choices = SHAPE_CHOICES[key] as readonly unknown[] | undefined;
    if (choices) {
      if (choices.includes(entry)) out[key] = entry;
    } else if (typeof entry === 'number' && Number.isFinite(entry)) {
      out[key] = clampSetting(key as NumericKey, entry);
    }
  }
  return out as ShapeOverride;
}

/** The settings a support is built with: the object's, with its own override on top. */
export function withShape(settings: Readonly<LiveSupportSettings>, shape: ShapeOverride | undefined): Readonly<LiveSupportSettings> {
  return shape ? { ...settings, ...shape } : settings;
}

const BASE_DIAMETER = 3;
const BASE_HEIGHT = 1.2;

function preset(touch: number, depth: number, neck: number, neckLength: number, pillar: number, merge: number, descent: number) {
  return {
    touchDiameter: touch,
    touchDepth: depth,
    neckDiameter: neck,
    neckLength,
    pillarDiameter: pillar,
    baseDiameter: BASE_DIAMETER,
    baseHeight: BASE_HEIGHT,
    raftFloorThickness: 1,
    raftWallHeight: 1.5,
    raftWallThickness: 0.5,
    raftWallAngle: 30,
    raftExpandWidth: 3,
    trussMinHeight: 3,
    trussSpacing: 2,
    trussDiameter: pillar,
    maxNeckAngle: 45,
    voxelResolution: 16,
    scatterAngle: 50,
    scatterMergeDistance: merge,
    scatterBranchDescent: descent,
  } satisfies Partial<LiveSupportSettings>;
}

export type PresetValues = ReturnType<typeof preset>;

export const presetValues: Readonly<Record<PresetName, Readonly<PresetValues>>> = {
  LIGHT: preset(0.5, 0, 0.3, 2, 0.8, 2, 2),
  MIDDLE: preset(0.8, 0, 0.4, 2, 1.2, 3, 3),
  HEAVY: preset(1, 0, 0.6, 3, 1.5, 4, 5),
};

/** Keys owned by presets; editing one switches the preset to Custom. Support spacing is deliberately not one. */
export const PRESET_KEYS = Object.keys(presetValues.LIGHT) as (keyof PresetValues)[];

const ROOF_DEFAULTS: Record<Exclude<RoofMode, 'OFF'>, Partial<LiveSupportSettings>> = {
  ROOF: {
    roofGap: 5, columnCount: 12, columnDiameter: 1.5, diagonalEnabled: true, diagonalDiameter: 1,
    braceConcentric: 3, braceThickness: 1, braceAngle: 40, storeyFloorThickness: 1.5, storeyEncloseCeiling: true,
  },
  CAGE: {
    cagePitch: 10, cageTopGap: 5, cageRingDiameter: 1, cageSideGap: 4, columnCount: 12, columnDiameter: 1.2,
    diagonalEnabled: true, diagonalDiameter: 1,
  },
};

export const defaultSupportSettings: Readonly<LiveSupportSettings> = {
  preset: 'LIGHT',
  ...presetValues.LIGHT,
  contactShape: 'NONE',
  pointDiameter: 0.2,
  pointDepth: 0.2,
  tipSection: 'ROUND',
  tipCrossWidth: 40,
  tipProfile: 'TAPERED',
  treeSectionIncrement: 20,
  trussEnabled: true,
  trussAngle: 45,
  trussTopSpacing: 0,
  trussDistanceLimit: 100,
  raftEnabled: true,
  roofMode: 'OFF',
  roofSeededModes: [],
  roofGap: 5,
  cageSideGap: 4,
  cageTopGap: 5,
  cagePitch: 10,
  cageRingDiameter: 1,
  columnCount: 6,
  columnDiameter: 1.5,
  diagonalEnabled: false,
  diagonalDiameter: 1,
  braceConcentric: 3,
  braceThickness: 1,
  braceAngle: 40,
  storeyFloorThickness: 1.5,
  storeyEncloseCeiling: true,
  labelEnabled: true,
  labelText: '',
  labelSize: 5,
  labelHeight: 0.6,
  labelMargin: 0,
  labelOffsetX: 0,
  labelOffsetY: 0,
  previewMode: 'FULL',
  autoSnap: false,
  lowPolyMode: false,
  resolution: 12,
  scatterSpacing: 2,
  scatterSafeDistance: 0,
  scatterFacingDown: true,
  scatterIslands: true,
  scatterRidgeAngle: 45,
  scatterAutoTree: false,
  reinforceOverhangEdges: true,
  liftHeight: 5,
  eraseRadius: 1.5,
};

interface NumericLimit {
  min: number;
  max: number;
  integer?: boolean;
}

const LENGTH: NumericLimit = { min: 0, max: 1000 };
const ANGLE_90: NumericLimit = { min: 0, max: 90 };

/** Blender property min/max limits; edits are clamped like Blender's UI. */
export const settingLimits: Record<NumericKey, NumericLimit> = {
  pointDiameter: { min: 0.05, max: 1000 },
  tipCrossWidth: { min: 10, max: 90 },
  // A bare tip must reach into the model to fuse with it.
  pointDepth: { min: 0.05, max: 1000 },
  touchDiameter: LENGTH,
  touchDepth: { min: -2, max: 1000 },
  neckDiameter: LENGTH,
  neckLength: LENGTH,
  maxNeckAngle: { min: 0, max: 89 },
  pillarDiameter: LENGTH,
  treeSectionIncrement: { min: 0, max: 100 },
  baseDiameter: LENGTH,
  baseHeight: LENGTH,
  trussDiameter: LENGTH,
  trussAngle: { min: 10, max: 60 },
  trussSpacing: LENGTH,
  trussMinHeight: LENGTH,
  trussTopSpacing: LENGTH,
  trussDistanceLimit: LENGTH,
  raftExpandWidth: LENGTH,
  raftFloorThickness: LENGTH,
  raftWallHeight: LENGTH,
  raftWallThickness: LENGTH,
  raftWallAngle: ANGLE_90,
  voxelResolution: { min: 2, max: 512, integer: true },
  roofGap: { min: 1, max: 100 },
  cageSideGap: { min: 1, max: 20 },
  cageTopGap: { min: 0, max: 100 },
  cagePitch: { min: 3, max: 50 },
  cageRingDiameter: { min: 0.3, max: 10 },
  columnCount: { min: 3, max: 64, integer: true },
  columnDiameter: { min: 0.5, max: 20 },
  diagonalDiameter: { min: 0.3, max: 10 },
  braceConcentric: { min: 0, max: 32, integer: true },
  braceThickness: { min: 0.3, max: 10 },
  braceAngle: ANGLE_90,
  storeyFloorThickness: { min: 0.5, max: 20 },
  labelSize: { min: 1, max: 50 },
  labelHeight: { min: 0.1, max: 5 },
  labelMargin: { min: 0, max: 20 },
  labelOffsetX: { min: -200, max: 200 },
  labelOffsetY: { min: -200, max: 200 },
  resolution: { min: 3, max: 64, integer: true },
  scatterSpacing: { min: 0.2, max: 100 },
  scatterAngle: ANGLE_90,
  scatterSafeDistance: LENGTH,
  scatterRidgeAngle: { min: 0, max: 180 },
  scatterMergeDistance: LENGTH,
  scatterBranchDescent: { min: -1000, max: 1000 },
  liftHeight: { min: 0, max: 200 },
  eraseRadius: { min: 0.1, max: 50 },
};

export function applyPreset(name: PresetName, base: Readonly<LiveSupportSettings> = defaultSupportSettings): LiveSupportSettings {
  return { ...cloneSettings(base), ...presetValues[name], preset: name };
}

export function updateSetting<K extends SettingKey>(
  settings: Readonly<LiveSupportSettings>,
  key: K,
  value: LiveSupportSettings[K],
): LiveSupportSettings {
  const next = cloneSettings(settings);
  next[key] = (key in settingLimits ? clampSetting(key as NumericKey, value as number) : value) as LiveSupportSettings[K];
  if (next.preset !== 'CUSTOM' && (PRESET_KEYS as string[]).includes(key) && next[key] !== settings[key]) next.preset = 'CUSTOM';
  return next;
}

/** Changes roof/cage mode, seeding that mode's defaults the first time it is used. */
export function setRoofMode(settings: Readonly<LiveSupportSettings>, mode: RoofMode): LiveSupportSettings {
  const next = { ...cloneSettings(settings), roofMode: mode };
  if (mode === 'OFF' || next.roofSeededModes.includes(mode)) return next;
  return { ...next, ...ROOF_DEFAULTS[mode], roofSeededModes: [...next.roofSeededModes, mode] };
}

/** Radius of the tip end at the model: Upper Ø under a contact sphere, else Point Ø. */
export function tipRadius(settings: Readonly<LiveSupportSettings>): number {
  return (settings.contactShape === 'SPHERE' ? settings.neckDiameter : settings.pointDiameter) / 2;
}

/**
 * How far the contact end sits inside the model: Contact Depth under a sphere (which sinks
 * by its own radius too), else Penetration.
 */
export function tipDepth(settings: Readonly<LiveSupportSettings>): number {
  return settings.contactShape === 'SPHERE' ? settings.touchDepth : settings.pointDepth;
}

/** Radius of what touches the model: the Contact Ø sphere, or the Point Ø tip end. */
export function contactRadius(settings: Readonly<LiveSupportSettings>): number {
  return (settings.contactShape === 'SPHERE' ? settings.touchDiameter : settings.pointDiameter) / 2;
}

export function toPlacementSettings(settings: Readonly<LiveSupportSettings>): PlacementSettings {
  return {
    overhangAngleDegrees: settings.scatterAngle,
    spacing: settings.scatterSpacing,
    // Blender insets edge anchors by the contact radius plus EDGE_INSET_MARGIN (0.05 mm), measured.
    edgeInset: contactRadius(settings) + 0.05,
    sharpEdgeAngleDegrees: settings.scatterRidgeAngle,
    includeIslands: settings.scatterIslands,
    includeDownward: settings.scatterFacingDown,
    reinforceEdges: settings.reinforceOverhangEdges,
  };
}

function clampSetting(key: NumericKey, value: number): number {
  if (!Number.isFinite(value)) throw new RangeError(`${key} must be a finite number`);
  const limit = settingLimits[key];
  const clamped = Math.min(limit.max, Math.max(limit.min, value));
  return limit.integer ? Math.min(limit.max, Math.max(limit.min, Math.round(clamped))) : clamped;
}

function cloneSettings(settings: Readonly<LiveSupportSettings>): LiveSupportSettings {
  return { ...settings, roofSeededModes: [...settings.roofSeededModes] };
}
