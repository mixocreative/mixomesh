import type { ContactInputs } from '../core/jobs';
import type { SupportPoint } from '../core/analysis/types';
import type { SupportContact } from '../core/supports/mesh';
import { defaultSupportSettings, type LiveSupportSettings } from '../core/supports/settings';
import { packSettings, packZones } from './supportBuildWasm';
import { supportEngine } from './supportEngine';
import type { MakePolicy } from './generateSupports';

/*
 * Host adapter of the Rust `generic_policy`: the final contacts of a unit (unit-local space) are its
 * automatic placement minus the exact deleted IDs plus its manual additions, minus the automatic ones
 * a no-support zone covers (`crates/geometry-core/src/generic/policy.rs`). Packs validated numbers in
 * and unpacks the arrays out; no decision is made here.
 */

// Index = the Rust source code; `KINDS` index = the Rust point-kind code (0 none).
const SOURCES: readonly SupportPoint['source'][] = ['interior', 'physical-boundary', 'sharp-ridge', 'island'];
const KINDS = [undefined, 'face', 'edge', 'vertical'] as const;

interface PolicyEngine {
  generic_policy_contacts(
    faceCount: number, settings: Float64Array,
    autoIds: string[], autoPositions: Float64Array, autoNormals: Float64Array, autoSources: Uint8Array,
    manualIds: string[], manualPositions: Float64Array, manualNormals: Float64Array, manualSources: Uint8Array,
    deleted: string[], zones: Float64Array,
  ): { take_ids(): string[]; take_positions(): Float64Array; take_normals(): Float64Array; take_origins(): Uint8Array; take_kinds(): Uint8Array; free(): void };
}

function packPoints(points: readonly SupportPoint[]) {
  const positions = new Float64Array(points.length * 3);
  const normals = new Float64Array(points.length * 3);
  points.forEach((p, k) => {
    positions.set(p.position, k * 3);
    normals.set(p.normal, k * 3);
  });
  return { ids: points.map((p) => p.id), positions, normals, sources: Uint8Array.from(points, (p) => SOURCES.indexOf(p.source)) };
}

/**
 * The generic policy of a unit for `generate`, made in Rust (`GeometrySession.generic_policy`) from
 * the same edits: its contacts, every face permitted, the structures the settings ask for, and
 * `repairBudget` safety-repair trials (default 0: report only; brace pruning needs a budget).
 */
export function genericPolicy(inputs: ContactInputs, settings: Readonly<LiveSupportSettings>, repairBudget = 0): MakePolicy {
  const auto = packPoints(inputs.points);
  const manual = packPoints(inputs.manual);
  return (session, model) => session.generic_policy(model, packSettings(settings),
    auto.ids, auto.positions, auto.normals, auto.sources, manual.ids, manual.positions, manual.normals, manual.sources,
    [...inputs.deleted], packZones(inputs.zones), repairBudget);
}

/**
 * Final contacts in unit-local space: automatic minus deleted and no-support zones, plus manual
 * (manual contacts ignore zones and never join Auto Tree branches). A support that lands in a zone is
 * the support build's call: it reports those contacts as `dropped`.
 */
export function jobContacts(inputs: ContactInputs, settings: Readonly<LiveSupportSettings> = defaultSupportSettings as LiveSupportSettings): SupportContact[] {
  if (inputs.points.length + inputs.manual.length === 0) return [];
  const auto = packPoints(inputs.points);
  const manual = packPoints(inputs.manual);
  const result = (supportEngine() as unknown as PolicyEngine).generic_policy_contacts(
    0, packSettings(settings),
    auto.ids, auto.positions, auto.normals, auto.sources,
    manual.ids, manual.positions, manual.normals, manual.sources,
    [...inputs.deleted], packZones(inputs.zones),
  );
  try {
    const ids = result.take_ids();
    const positions = result.take_positions();
    const normals = result.take_normals();
    const origins = result.take_origins();
    const kinds = result.take_kinds();
    return ids.map((id, k): SupportContact => {
      const shape = inputs.contactSettings[id];
      const kind = KINDS[kinds[k]!];
      return {
        id,
        position: [positions[k * 3]!, positions[k * 3 + 1]!, positions[k * 3 + 2]!],
        normal: [normals[k * 3]!, normals[k * 3 + 1]!, normals[k * 3 + 2]!],
        ...(kind ? { kind } : {}),
        origin: origins[k] === 1 ? 'manual' : 'auto',
        ...(shape ? { shape } : {}),
      };
    });
  } finally {
    result.free();
  }
}
