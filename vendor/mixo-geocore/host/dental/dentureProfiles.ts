import type { Lang } from './alignerProfiles';
import type { LiveSupportSettings } from '../core/supports/settings';
import { DENTURE_PROFILE_FILES } from './dentureProfileFiles';

/*
 * The denture types the dental flow offers for `kind: 'denture'`, read from the same JSON files the
 * Rust core embeds (`crates/geometry-core/src/dental/denture/profiles/*.json`, shipped to the host as
 * `dentureProfileFiles.ts`, written by `npm run profiles:gen`). Parsing is strict like the Rust
 * side (`dental::denture::profile`): an unknown or a missing key throws.
 */

/** The upright rule's data (Rust `denture::profile::Upright`; only the geometry uses it). */
export interface DentureUpright {
  endBandFraction: number;
  legsGapMinRatio: number;
  teethBandFraction: number;
  teethOffsetMinMm: number;
  flatnessMax: number;
}

/** The print-angle search (Rust `denture::profile::Pose`): tilts 0..range from upright, leaning teeth side up. */
export interface DenturePose {
  tiltRangeDeg: number;
  tiltStepDeg: number;
  tiltMarginDeg: number;
  overhangAngleDeg: number;
  overhangTieFraction: number;
}

/** Tip placement (Rust `denture::profile::Placement`). Lengths mm, angles degrees. */
export interface DenturePlacement {
  tipPitchMm: number;
  barPitchMultiplier: number;
  lightPitchMultiplier: number;
  bottomBandMm: number;
  barThicknessMaxMm: number;
  minimumProminenceMm: number;
  hardEdgeDeg: number;
  middleEdgeNearMm: number;
  middleEdgeMinLengthMm: number;
  downEdgeMaxDeg: number;
  downBandMm: number;
  downPitchMm: number;
  /** Tip spacing (mm) along the dental rim and over the dental rim band; absent inherits `downPitchMm`. */
  dentalRimPitchMm?: number;
  /** Tip spacing (mm) over the hole band; absent inherits `downPitchMm`. */
  holePitchMm?: number;
  /** Overhang faces within this distance (mm along the surface) of the dental rim are support-allowed outside the oral cavity area. */
  rimBandMm: number;
  /** A lowest point outside the allowed area still gets a tip outside the no-support zone or within this distance (mm along the surface) of the dental rim. */
  lowRimBandMm: number;
  tipMinFromUpBarDeg: number;
}

/** The support settings a denture starts with (Rust `denture::profile::SupportDefaults`), mm. */
export interface DentureSupports {
  /** Contact ball diameter. */
  tipBallMm: number;
  /** Frustum under the ball: base diameter and height. */
  frustumBaseMm: number;
  frustumHeightMm: number;
  pillarDiameterMm: number;
  /** Lattice bracing between pillars. */
  lattice: boolean;
  /** Raft layer thicknesses from the plate up. */
  raftLayersMm: readonly number[];
  liftHeightMm: number;
  /** How far the thin contact cone sinks into the model, mm (the `pointDepth` setting). */
  biteDepthMm: number;
  /** Diameter of the narrowest part of the neck, mm (carried; the engine tapers straight from contact to pillar). */
  upperDiameterMm: number;
  /** Gap (mm) pillars, angled necks and branches keep from the model (the `minClearance` setting). */
  minClearanceMm: number;
  /** Farthest sideways shift (mm) of a pillar top from its tip (the `neckMaxShift` setting). */
  neckMaxShiftMm: number;
}

/** One denture profile file as the host reads it. */
export interface DentureProfileData {
  id: string;
  name: Record<Lang, string>;
  description: Record<Lang, string>;
  /** Top-view line art in a 120 by 90 box: SVG path data. */
  card: readonly string[];
  upright: Readonly<DentureUpright>;
  pose: Readonly<DenturePose>;
  placement: Readonly<DenturePlacement>;
  supports: Readonly<DentureSupports>;
  stability: Readonly<{ maxSlendernessUnbraced: number; maxSlendernessBraced: number }>;
  engine: Readonly<{ repairBudget: number }>;
}

const LANGS: readonly Lang[] = ['en', 'ja', 'zh-Hant'];
const TOP_KEYS = ['id', 'name', 'description', 'card', 'upright', 'pose', 'placement', 'supports', 'stability', 'engine'];
const UPRIGHT_KEYS: readonly (keyof DentureUpright)[] = ['endBandFraction', 'legsGapMinRatio', 'teethBandFraction', 'teethOffsetMinMm', 'flatnessMax'];
const POSE_KEYS: readonly (keyof DenturePose)[] = ['tiltRangeDeg', 'tiltStepDeg', 'tiltMarginDeg', 'overhangAngleDeg', 'overhangTieFraction'];
const PLACEMENT_OPTIONAL = ['dentalRimPitchMm', 'holePitchMm'] as const;
const PLACEMENT_KEYS: readonly (keyof DenturePlacement)[] = ['tipPitchMm', 'barPitchMultiplier', 'lightPitchMultiplier', 'bottomBandMm', 'barThicknessMaxMm',
  'minimumProminenceMm', 'tipMinFromUpBarDeg', 'hardEdgeDeg', 'middleEdgeNearMm', 'middleEdgeMinLengthMm', 'downEdgeMaxDeg', 'downBandMm', 'downPitchMm', 'rimBandMm', 'lowRimBandMm'];
const SUPPORT_NUMBERS = ['tipBallMm', 'frustumBaseMm', 'frustumHeightMm', 'pillarDiameterMm', 'liftHeightMm', 'biteDepthMm', 'upperDiameterMm', 'minClearanceMm', 'neckMaxShiftMm'] as const;
const STABILITY_KEYS = ['maxSlendernessUnbraced', 'maxSlendernessBraced'] as const;

function object(value: unknown, keys: readonly string[], where: string, optional: readonly string[] = []): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError(`${where} must be an object`);
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) if (!keys.includes(key) && !optional.includes(key)) throw new TypeError(`${where}: unknown key '${key}'`);
  for (const key of keys) if (!(key in record)) throw new TypeError(`${where}: missing key '${key}'`);
  return record;
}

function numbers<K extends string>(value: unknown, keys: readonly K[], where: string, optional: readonly string[] = []): Record<K, number> {
  const record = object(value, keys, where, optional);
  for (const key of [...keys, ...optional.filter((k) => k in record)]) if (typeof record[key] !== 'number' || !Number.isFinite(record[key])) throw new TypeError(`${where}.${key} must be a number`);
  return record as Record<K, number>;
}

function texts(value: unknown, where: string): Record<Lang, string> {
  const record = object(value, LANGS, where);
  for (const lang of LANGS) if (typeof record[lang] !== 'string') throw new TypeError(`${where}.${lang} must be text`);
  return record as Record<Lang, string>;
}

function supports(value: unknown, where: string): DentureSupports {
  const record = object(value, [...SUPPORT_NUMBERS, 'lattice', 'raftLayersMm'], where);
  for (const key of SUPPORT_NUMBERS) if (typeof record[key] !== 'number' || !Number.isFinite(record[key]) || (record[key] as number) <= 0) throw new TypeError(`${where}.${key} must be a positive number`);
  if (typeof record.lattice !== 'boolean') throw new TypeError(`${where}.lattice must be true or false`);
  const layers = record.raftLayersMm;
  if (!Array.isArray(layers) || layers.length === 0 || layers.some((v) => typeof v !== 'number' || !(v > 0))) throw new TypeError(`${where}.raftLayersMm must be positive thicknesses`);
  return record as unknown as DentureSupports;
}

/** One denture profile file, strictly: every key the Rust struct has, nothing else. */
export function parseDentureProfile(value: unknown, where = 'denture profile'): DentureProfileData {
  const record = object(value, TOP_KEYS, where);
  const { id, card } = record;
  if (typeof id !== 'string' || id === '') throw new TypeError(`${where}.id must be text`);
  if (!Array.isArray(card) || card.some((path) => typeof path !== 'string')) throw new TypeError(`${where}.card must be SVG path data`);
  const engine = object(record.engine, ['repairBudget'], `${where}.engine`);
  if (typeof engine.repairBudget !== 'number' || !Number.isInteger(engine.repairBudget) || engine.repairBudget < 0) throw new TypeError(`${where}.engine.repairBudget must be a whole number`);
  return {
    id, card: [...card] as string[],
    name: texts(record.name, `${where}.name`), description: texts(record.description, `${where}.description`),
    upright: numbers(record.upright, UPRIGHT_KEYS, `${where}.upright`),
    pose: numbers(record.pose, POSE_KEYS, `${where}.pose`),
    placement: numbers(record.placement, PLACEMENT_KEYS, `${where}.placement`, PLACEMENT_OPTIONAL) as DenturePlacement,
    supports: supports(record.supports, `${where}.supports`),
    stability: numbers(record.stability, STABILITY_KEYS, `${where}.stability`),
    engine: { repairBudget: engine.repairBudget },
  };
}

/** The profiles of a set of files (path to parsed JSON), in file order; each file is named after its id. */
export function dentureProfilesFrom(files: Readonly<Record<string, unknown>>): DentureProfileData[] {
  return Object.keys(files).sort().map((path) => {
    const profile = parseDentureProfile(files[path], path);
    if (!path.endsWith(`/${profile.id}.json`)) throw new TypeError(`${path}: a profile file is named after its id`);
    return profile;
  });
}

/** Every denture profile, the default first, then file order. */
export const DENTURE_PROFILES: readonly DentureProfileData[] = dentureProfilesFrom(DENTURE_PROFILE_FILES);

/** Profile #1 of the family: the reference partial denture. */
export const DEFAULT_DENTURE_PROFILE_ID = 'reference-denture';

/** The data of one denture profile; throws for an id no file defines. */
export function dentureProfileData(id: string): DentureProfileData {
  const found = DENTURE_PROFILES.find((profile) => profile.id === id);
  if (!found) throw new TypeError(`unknown denture profile '${id}'`);
  return found;
}

/**
 * The profile's support defaults as the host's settings: the thin contact cone (shape NONE: the tip
 * end of `tipBallMm` touches the model and sinks `biteDepthMm`) on a tapered tip widening over the
 * frustum height to the pillar; the pillar diameter; braces for the lattice (Tree off); a raft whose floor is the sum
 * of the layers; the lift. The operator can change every one afterwards.
 */
export function dentureSupportPreset(profile: DentureProfileData): Partial<LiveSupportSettings> {
  const s = profile.supports;
  return {
    contactShape: 'NONE',
    // tipBallMm is the diameter AT the surface: the tip end below it is narrower by the cone's slope over the bite depth.
    pointDiameter: 2 * Math.max(0.05, s.tipBallMm / 2 - ((s.pillarDiameterMm / 2 - s.tipBallMm / 2) * s.biteDepthMm) / s.frustumHeightMm),
    pointDepth: s.biteDepthMm,
    tipProfile: 'TAPERED',
    neckLength: s.frustumHeightMm,
    pillarDiameter: s.pillarDiameterMm,
    trussEnabled: s.lattice,
    trussDiameter: s.pillarDiameterMm,
    scatterAutoTree: false,
    raftEnabled: true,
    raftFloorThickness: s.raftLayersMm.reduce((sum, layer) => sum + layer, 0),
    liftHeight: s.liftHeightMm,
    minClearance: s.minClearanceMm,
    neckMaxShift: s.neckMaxShiftMm,
    roofMode: 'OFF',
  };
}
