import { PROGRESS_STAGE } from '../core/progress';
import type { ProgressCallback, TriangleMesh } from '../core/analysis/types';
import type { JobTransform } from '../core/jobs';
import type { GeneratedSupportMesh, SupportContact, SupportIssue, SupportPart, SupportVerdict } from '../core/supports/mesh';
import type { LiveSupportSettings } from '../core/supports/settings';
import type { ZoneStamp } from '../core/supports/zones';
import { decodeComponents, packContacts, packSettings, packZones, type ColumnInput } from './supportBuildWasm';
import { supportEngine, SESSION_BYTES, type SupportSession } from './supportEngine';

/*
 * Host adapter of the Rust `generate` (U7): one call runs permit, build, the exact body check, the
 * bounded repair and the verdicts for either policy. The policy is made in Rust inside the same
 * session (`generic_policy` on the unit's loaded mesh) and handed to `generate` as
 * a handle: the host never assembles one. No callback into the host and no retry loop here.
 */

/** A `PolicyResult` Rust made; handed to `generate` as is (`crates/geometry-wasm/src/safety.rs`). */
export interface PolicyHandle {
  candidate_ids(): string[];
  candidate_points(): Float64Array;
  /** Point then normal per suggested tip Add can snap to. */
  suggested_points(): Float64Array;
  candidate_faces(): Float64Array;
  alternate_owners(): string[];
  alternate_points(): Float64Array;
  alternate_faces(): Float64Array;
  structures(): Uint8Array;
  repair_budget(): number;
  automatic(): number;
  landing_rule(): number;
  islands_outside_permitted(): boolean;
  permitted_faces(): Uint8Array;
  ring_count(): number;
  reproduced(): boolean;
  profile_id(): string;
  free(): void;
}

/** The session calls a policy is made with (`crates/geometry-wasm/src/generic.rs`). */
export interface PolicySession extends SupportSession {
  generic_policy(model: number, settings: Float64Array,
    autoIds: string[], autoPositions: Float64Array, autoNormals: Float64Array, autoSources: Uint8Array,
    manualIds: string[], manualPositions: Float64Array, manualNormals: Float64Array, manualSources: Uint8Array,
    deleted: string[], zones: Float64Array): PolicyHandle;
}

/** Makes the unit's policy in `session`; `model` is the unit-local mesh handle. The caller frees the handle. */
export type MakePolicy = (session: PolicySession, model: number) => PolicyHandle;

/**
 * Where a build runs: a session with the unit's model loaded (`source`), its plate-space copy for a
 * frame and the policy made for it. A one-shot site (`oneShotSite`) loads everything for one build
 * and frees it after; the mesh worker's per-unit site (`workers/buildSessions`) keeps them across
 * builds of the same unit. `release` of a policy frees it unless the site keeps it.
 */
export interface BuildSite {
  readonly session: GenerateSession;
  readonly source: number;
  /** The model placed by `frame` (the model itself when the frame is absent or the identity). */
  placed(frame: JobTransform | undefined): number;
  policy(make: MakePolicy, frame: JobTransform | undefined): { handle: PolicyHandle; release(): void };
}

/** A frame as a key: positions and rotations as exact number strings; '' for none or the identity. */
export function frameKey(frame: JobTransform | undefined): string {
  const values = frame ? [...frame.position, ...frame.rotation] : [];
  return values.some((v) => v !== 0) ? values.join(',') : '';
}

/** Runs `run` on a fresh session with `model` loaded once; everything is freed afterwards. */
export function withOneShotSite<T>(model: TriangleMesh, run: (site: BuildSite) => T): T {
  const session = new (supportEngine().GeometrySession)(SESSION_BYTES) as unknown as GenerateSession;
  try {
    const source = session.load_mesh(Float32Array.from(model.positions), Uint32Array.from(model.indices));
    return run({
      session, source,
      placed: (frame) => (frameKey(frame) ? session.load_placed(source, frameArray(frame!)) : source),
      policy: (make) => {
        const handle = make(session, source);
        return { handle, release: () => handle.free() };
      },
    });
  } finally {
    session.free();
  }
}

export interface RingMeasure {
  perimeterMm: number;
  retained: number;
  maxGapMm: number;
  reviewGapMm: number;
  needsReview: boolean;
}

export interface GenerateOptions {
  mode?: 'preview' | 'export';
  /** The unit-local model; `frame` places it on the plate (absent: it is already in plate space). */
  model: TriangleMesh;
  frame?: JobTransform;
  /** The plate's height in `frame` (default 0); a lift change moves it instead of the model (see `SupportJob.plate`). */
  plateY?: number;
  labelText?: string;
  zones?: readonly ZoneStamp[];
  /** The unit's persistent build site (the mesh worker's); absent: a one-shot session for this build. */
  site?: BuildSite;
  /** Ends the repair and the checks early with an inconclusive verdict. */
  timeoutMs?: number;
  /** The request's revision: the engine echoes it so the host can drop a result that is not the newest. */
  revision?: number;
  onProgress?: ProgressCallback;
}

export interface GenerateOutput {
  mesh: GeneratedSupportMesh;
  rings: RingMeasure[];
  fallback: Array<'tree' | 'brace' | 'brace-pruned'>;
  trials: number;
  revision: number;
}

interface Generation {
  take_positions(): Float32Array; take_indices(): Uint32Array; take_tags(): Uint32Array;
  take_reach(): Float64Array; take_intents(): Float64Array; take_contact_ids(): string[];
  take_dropped(): string[]; take_dropped_by_zones(): string[]; take_fallback(): Uint8Array;
  status(): number; reason(): string; take_issues(): Uint32Array;
  take_island_heights(): Float64Array; take_island_vertices(): Uint32Array; take_island_status(): Uint8Array; island_reason(): string;
  take_rings(): Float64Array; trials(): number; revision(): number; free(): void;
}

export interface GenerateSession extends PolicySession {
  release_mesh(handle: number): void;
  load_placed(model: number, frame: Float64Array): number;
  generate(model: number, ids: string[], contacts: Float64Array, shapes: Float64Array, settings: Float64Array, mode: number,
    labelText: string, zones: Float64Array, policy: PolicyHandle, timeoutMs: number, revision: number, plateY: number, frame: Float64Array): Generation;
}

const PARTS: readonly SupportPart[] = [
  'tip', 'neck', 'pillar', 'foot', 'brace', 'raft', 'tree-branch', 'tree-trunk', 'roof', 'column', 'roof-brace', 'cross-bar', 'cage-ring', 'label',
];
const STATUS = ['clear', 'blocked', 'inconclusive'] as const;
const NO_CONTACT = 0xffffffff;
const ISSUE_STRIDE = 5;
const ISSUE_ORIGIN = ['auto', 'manual', 'structural'] as const;
const ISLAND_STATUS = ['resolved', 'unresolved', 'manual-only', 'outside-policy'] as const;

/** A placement as the session calls take it: position xyz then rotation xyz. */
export const frameArray = (frame: JobTransform): Float64Array => Float64Array.of(...frame.position, ...frame.rotation);

/** Contacts are in the build frame (`options.frame` applied); the policy is made from the unit-local model. */
export function generateSupports(contacts: readonly SupportContact[], settings: Readonly<LiveSupportSettings>, policy: MakePolicy, options: GenerateOptions): GenerateOutput {
  const empty = (): GenerateOutput => ({
    mesh: { positions: new Float32Array(), indices: new Uint32Array(), parts: [], components: [], dropped: [], droppedByZones: [],
      verdict: { status: 'clear', issues: [] }, islands: { status: 'ok', islands: [] } },
    rings: [], fallback: [], trials: 0, revision: options.revision ?? 0,
  });
  if (contacts.length === 0) return empty();
  const { model } = options;
  options.onProgress?.(0.05, PROGRESS_STAGE.samplingNormals);
  const build = (site: BuildSite) => {
    const wasm = site.session;
    const handle = site.placed(options.frame);
    const inputs = contacts.map((contact): ColumnInput => ({
      id: contact.id,
      position: contact.position,
      normal: contact.normal,
      origin: contact.origin === 'manual' ? 'manual' : 'auto',
      ...(contact.kind ? { kind: contact.kind } : {}),
      ...(contact.shape ? { shape: contact.shape } : {}),
    }));
    const packed = packContacts(inputs);
    const data = site.policy(policy, options.frame);
    let result: Generation;
    try {
      result = wasm.generate(handle, inputs.map((c) => c.id), packed.contacts, packed.shapes, packSettings(settings), options.mode === 'export' ? 1 : 0,
        options.labelText ?? '', packZones(options.zones ?? []), data.handle, options.timeoutMs ?? 0, options.revision ?? 0, options.plateY ?? 0,
        options.frame ? frameArray(options.frame) : new Float64Array());
    } finally {
      data.release();
    }
    try {
      const ids = result.take_contact_ids();
      const components = decodeComponents(result.take_tags(), result.take_reach(), result.take_intents(), (k) => ids[k]!);
      const parts: SupportPart[] = [];
      for (const component of components) if (!parts.includes(component.part)) parts.push(component.part);
      const issues = result.take_issues();
      const found: SupportIssue[] = [];
      for (let k = 0; k < issues.length; k += ISSUE_STRIDE) {
        found.push({
          ...(issues[k] === NO_CONTACT ? {} : { contactId: ids[issues[k]!]! }),
          part: PARTS[issues[k + 1]!]!, modelFace: issues[k + 2]!, blocked: issues[k + 3] === 1, origin: ISSUE_ORIGIN[issues[k + 4]!]!,
        });
      }
      const reason = result.reason();
      const verdict: SupportVerdict = { status: STATUS[result.status()]!, ...(reason ? { reason } : {}), issues: found };
      const islandReason = result.island_reason();
      const heights = result.take_island_heights();
      const vertices = result.take_island_vertices();
      const status = result.take_island_status();
      const islands = islandReason
        ? { status: 'inconclusive' as const, reason: islandReason }
        : { status: 'ok' as const, islands: Array.from(heights, (height, k) => ({ height, vertex: vertices[k]!, status: ISLAND_STATUS[status[k]!]! })) };
      const rows = result.take_rings();
      const rings: RingMeasure[] = [];
      for (let k = 0; k < rows.length; k += 5) {
        rings.push({ perimeterMm: rows[k]!, retained: rows[k + 1]!, maxGapMm: rows[k + 2]!, reviewGapMm: rows[k + 3]!, needsReview: rows[k + 4] === 1 });
      }
      const revision = result.revision();
      const mesh: GeneratedSupportMesh = {
        revision,
        positions: result.take_positions(), indices: result.take_indices(), parts, components,
        dropped: result.take_dropped(), droppedByZones: result.take_dropped_by_zones(), verdict, islands,
      };
      return { mesh, rings, fallback: Array.from(result.take_fallback(), (f) => (f === 1 ? 'tree' as const : f === 3 ? 'brace-pruned' as const : 'brace' as const)), trials: result.trials(), revision };
    } finally {
      result.free();
    }
  };
  return options.site ? build(options.site) : withOneShotSite(model, build);
}
