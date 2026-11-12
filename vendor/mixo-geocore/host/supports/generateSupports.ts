import { packLimits, type GenerateTimeLimits } from './generateLimits';
import { packRules, type GenerateRules } from './generateRules';
import { GENERATE_PHASES, PROGRESS_STAGE, type GeneratePhase, type GeneratePhaseCallback } from '../core/progress';
import type { ProgressCallback, TriangleMesh } from '../core/analysis/types';
import type { JobTransform } from '../core/jobs';
import type { GeneratedSupportMesh, SupportContact, SupportIssue, SupportPart, SupportVerdict, UnresolvedKind, UnresolvedPoint } from '../core/supports/mesh';
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
  /** A denture policy's islands, `ISLAND_STRIDE` numbers each (`dental/dentureIslands.ts` decodes them); empty for any other policy. */
  island_facts(): Float64Array;
  /** Why a denture policy could not tell its islands; empty when it could. */
  islands_note(): string;
  /** A denture policy's dental rim lows that face up and got no tip (rule `rimLowNeedsOverhang`); 0 for any other policy. */
  rim_lows_facing_up(): number;
  /** A dental policy's parts (dentures engine 50, aligners engine 56), `PART_STRIDE` numbers each (`dental/dentureParts.ts` decodes them); empty for any other policy. */
  part_list?(): Float64Array;
  /** A dental policy's part id of every face of the file; empty for any other policy. */
  face_parts?(): Uint32Array;
  /** The dental model-landing allow list (tip ids; engine 33, unplaced lowest points become candidates since engine 51, an island id `island-<vertex>` gets a tip at its lowest point since engine 54). Optional so test doubles may omit it. */
  set_model_landing_allow?(ids: string[]): void;
  free(): void;
}

/** The session calls a policy is made with (`crates/geometry-wasm/src/generic.rs`). */
export interface PolicySession extends SupportSession {
  generic_policy(model: number, settings: Float64Array,
    autoIds: string[], autoPositions: Float64Array, autoNormals: Float64Array, autoSources: Uint8Array,
    manualIds: string[], manualPositions: Float64Array, manualNormals: Float64Array, manualSources: Uint8Array,
    deleted: string[], zones: Float64Array, repairBudget: number): PolicyHandle;
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

/**
 * Dental two-contour jobs: built coverage of one rim, 5 f64 per ring in the `take_rings` rows
 * (perimeter mm, retained contacts, largest gap mm, review gap mm, needs review 0/1).
 */
export interface RingMeasure {
  perimeterMm: number;
  retained: number;
  maxGapMm: number;
  reviewGapMm: number;
  needsReview: boolean;
}

/** Options of one `generateSupports` call. */
export interface GenerateOptions {
  /** Preview (mode 0, default) or full export resolution (mode 1). */
  mode?: 'preview' | 'export';
  /** The unit-local model; `frame` places it on the plate (absent: it is already in plate space). */
  model: TriangleMesh;
  frame?: JobTransform;
  /** The plate's height in `frame` (default 0); a lift change moves it instead of the model (see `SupportJob.plate`). */
  plateY?: number;
  /** Text embossed on the raft label; '' for none. */
  labelText?: string;
  /** No-support zone stamps, in the build frame. */
  zones?: readonly ZoneStamp[];
  /** The unit's persistent build site (the mesh worker's); absent: a one-shot session for this build. */
  site?: BuildSite;
  /** Overrides of the engine's time rule (see `GenerateTimeLimits`); absent: the engine's defaults. */
  limits?: GenerateTimeLimits;
  /** Overrides of the planner's rules (see `GenerateRules`); absent: the engine's defaults. */
  rules?: GenerateRules;
  /** The request's revision: the engine echoes it so the host can drop a result that is not the newest. */
  revision?: number;
  onProgress?: ProgressCallback;
  /** The engine's phases while it builds (see `GENERATE_PHASES`), for a staged progress bar; the result is the same with or without it. */
  onPhase?: GeneratePhaseCallback;
}

/** What `generateSupports` returns: the mesh with its verdicts, dental ring coverage, structure fallbacks and repair trials spent. */
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
  take_left_out_ids(): string[]; take_left_out_points(): Float64Array; take_left_out_reasons(): string[];
  take_last_resort_ids(): string[]; take_last_resort_tiers(): Uint8Array; take_last_resort_clearances(): Float64Array;
  contact_fits(): Uint32Array;
  take_model_landed_ids(): string[]; take_model_landed_tiers(): Uint8Array; take_model_landed_points(): Float64Array;
  take_unresolved_ids(): string[]; take_unresolved_streams(): string[]; take_unresolved_points(): Float64Array; take_unresolved_reasons(): string[];
  take_unresolved_best_gaps(): Float64Array; take_unresolved_needed(): Float64Array;
  /*
   * Engine 51 and 53. REQUIRED (GEO-008): they were optional "so test doubles may omit them", but
   * `assertGeometryVersion` refuses any engine that is not this host's, so no real engine could ever
   * reach the fallbacks - they were production branches that existed only for fakes, which is the
   * inverse of coverage. One of them invented geometry: a short `normals` array yielded a
   * fabricated straight-down normal, and that normal is what the app hands to `reroute_support` to
   * re-aim a support, so a sideways overhang got a reroute aimed into the model.
   */
  take_unresolved_kinds(): string[]; take_unresolved_normals(): Float64Array;
  take_footprint(): Float64Array;
  status(): number; reason(): string; stop_reason(): string; take_issues(): Uint32Array;
  take_island_heights(): Float64Array; take_island_vertices(): Uint32Array; take_island_status(): Uint8Array; island_reason(): string;
  take_rings(): Float64Array; trials(): number; revision(): number; free(): void;
}

/**
 * The `GeometrySession` calls a build uses: meshes are handles into the session; `load_placed`
 * makes a plate-space copy of a model for a frame, `release_mesh` frees a handle (and the Rust
 * caches keyed on it).
 */
export interface GenerateSession extends PolicySession {
  release_mesh(handle: number): void;
  load_placed(model: number, frame: Float64Array): number;
  generate(model: number, ids: string[], contacts: Float64Array, shapes: Float64Array, settings: Float64Array, mode: number,
    labelText: string, zones: Float64Array, policy: PolicyHandle, limits: Float64Array, rules: Float64Array, revision: number, plateY: number, frame: Float64Array,
    onPhase?: (phase: string, done: number, total: number) => void): Generation;
}

const PARTS: readonly SupportPart[] = [
  'tip', 'neck', 'pillar', 'foot', 'brace', 'raft', 'tree-branch', 'tree-trunk', 'roof', 'column', 'roof-brace', 'cross-bar', 'cage-ring', 'label',
];
// GEO-005: STATUS already HAS an honest unknown - `inconclusive` - so an unrecognised status code
// falls back to it rather than to a second unknown member. That also keeps the export gate's
// refusal working: `inconclusive` is refused, `'unknown'` would have to teach every consumer.
const STATUS = ['clear', 'blocked', 'inconclusive'] as const;
const NO_CONTACT = 0xffffffff;
// Issue rows (u32 x ISSUE_STRIDE): contact index (NO_CONTACT none), part code, model face,
// blocked 0/1, origin code (ISSUE_ORIGIN). Status / island codes index STATUS / ISLAND_STATUS.
const ISSUE_STRIDE = 5;
const ISSUE_ORIGIN = ['auto', 'manual', 'structural'] as const;
// Index 0 is the engine's "no tier", which is why the table starts with `undefined`. GEO-005: an
// unknown code (and a tier 0 that should not reach here) is `unknown`, not "other surface".
const LANDING_TIERS = [undefined, 'allowed', 'other', 'no-support'] as const;
const ISLAND_STATUS = ['resolved', 'unresolved', 'manual-only', 'outside-policy'] as const;

/**
 * The reason a zero-contact build carries in its verdict and island report: the engine was never
 * asked (GEO-003). It is a code, not display text - the app translates it like every other reason.
 */
export const NOT_JUDGED = 'not judged: no contacts';

/**
 * A flat footprint (`take_footprint`) as loops relative to the unit's plate position `origin`
 * (plan x, z). Empty in, empty out: a build with no footprint is a legal state.
 *
 * GEO-006: the cursor reads its loop count and its point counts OUT OF THE DATA, so a truncated
 * array used to walk past the end and push NaN coordinates into the loops `arrange_plate` is then
 * asked to pack. The bounds below refuse instead, which is what the engine's own `INVALID_LENGTH`
 * would have done had the truncation happened on its side.
 *
 * @throws RangeError when a count does not fit the array
 */
export function unpackFootprint(flat: Float64Array, origin: readonly [number, number]): Array<Array<[number, number]>> {
  const loops: Array<Array<[number, number]>> = [];
  if (flat.length === 0) return loops;
  const count = flat[0]!;
  if (!Number.isInteger(count) || count < 0) throw new RangeError(`footprint: ${count} is not a loop count`);
  let at = 1;
  for (let l = 0; l < count; l++) {
    const n = flat[at++]!;
    if (!Number.isInteger(n) || n < 0 || at + n * 2 > flat.length) {
      throw new RangeError(`footprint loop ${l}: ${n} points do not fit the remaining ${flat.length - at} values`);
    }
    const loop: Array<[number, number]> = [];
    for (let k = 0; k < n; k++, at += 2) loop.push([flat[at]! - origin[0], flat[at + 1]! - origin[1]]);
    loops.push(loop);
  }
  return loops;
}

/**
 * The engine's phase name as one the app can switch on: its own, or `unknown`.
 *
 * GEO-015: this used to DROP a name the host did not know, so a phase added to the engine without a
 * host update reported nothing at all and the bar stopped moving mid-build. Forwarding `unknown`
 * keeps the bar alive and lets the app say it cannot name the step.
 */
export const phaseOf = (name: string): GeneratePhase => ((GENERATE_PHASES as readonly string[]).includes(name) ? name as GeneratePhase : 'unknown');

/** The wasm callback for an `onPhase` (undefined without one: the engine then reports nothing). */
export function phaseListener(onPhase: GeneratePhaseCallback | undefined): ((name: string, done: number, total: number) => void) | undefined {
  return onPhase && ((name, done, total) => onPhase(phaseOf(name), done, total));
}

/** The kind of an unresolved entry: the engine's word (engine 51), else read from the id and stream as engine 50 named them. */
export function unresolvedKind(word: string | undefined, id: string, stream: string): UnresolvedKind {
  if (word === 'island' || word === 'lowest' || word === 'tip') return word;
  if (id.startsWith('island-') || stream === 'island') return 'island';
  return stream === 'low' ? 'lowest' : 'tip';
}

/** A placement as the session calls take it: position xyz then rotation xyz. */
export const frameArray = (frame: JobTransform): Float64Array => Float64Array.of(...frame.position, ...frame.rotation);

/** Contacts are in the build frame (`options.frame` applied); the policy is made from the unit-local model. */
export function generateSupports(contacts: readonly SupportContact[], settings: Readonly<LiveSupportSettings>, policy: MakePolicy, options: GenerateOptions): GenerateOutput {
  // No contacts: the engine is never called, so this return must not answer in its name.
  //
  // GEO-003: it used to say `verdict: clear` and `islands: ok` - the exact output of a check that
  // examined everything and found nothing, from a check that examined nothing. The island verdict is
  // a property of the MODEL, not of the contacts (Rust `island_verdict` walks the topology and says
  // `Inconclusive` when it cannot), so `ok` here was a judgement nobody made. One model, two answers,
  // measured: asked, the knot fixture reports `inconclusive: non-manifold edge`; not asked, it
  // reported `ok`.
  //
  // GEO-002: `revision` went on the output and not on the MESH, which is the field every consumer
  // judges freshness by (`meshClient.fresh`, `meshWorker.exportFiles`, `exportGate`). `undefined`
  // compared unequal to the revision asked for, so a build that WAS the newest was refused `stale`
  // for ever, and the documented remedy - export again - produced the same refusal every time. It is
  // carried onto the mesh rather than made a required option because every caller already passes it;
  // a required field would ripple through every call site to fix a one-line omission.
  const empty = (): GenerateOutput => {
    const revision = options.revision ?? 0;
    return {
      mesh: { revision, positions: new Float32Array(), indices: new Uint32Array(), parts: [], components: [], dropped: [], droppedByZones: [],
        verdict: { status: 'inconclusive', reason: NOT_JUDGED, issues: [] }, islands: { status: 'inconclusive', reason: NOT_JUDGED } },
      rings: [], fallback: [], trials: 0, revision,
    };
  };
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
    // The policy handle is only borrowed by `generate`: release it right after the call (a site that
    // keeps policies makes `release` a no-op).
    const data = site.policy(policy, options.frame);
    let result: Generation;
    try {
      result = wasm.generate(handle, inputs.map((c) => c.id), packed.contacts, packed.shapes, packSettings(settings), options.mode === 'export' ? 1 : 0,
        options.labelText ?? '', packZones(options.zones ?? []), data.handle, packLimits(options.limits), packRules(options.rules), options.revision ?? 0, options.plateY ?? 0,
        options.frame ? frameArray(options.frame) : new Float64Array(), phaseListener(options.onPhase));
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
          part: PARTS[issues[k + 1]!] ?? 'unknown', modelFace: issues[k + 2]!, blocked: issues[k + 3] === 1, origin: ISSUE_ORIGIN[issues[k + 4]!] ?? 'unknown',
        });
      }
      // A build the time rule stopped says so in full ("stopped: no progress for 30 s"), not by the short code.
      const stop = result.stop_reason();
      const worded = (code: string) => (stop && code.startsWith('stopped') ? stop : code);
      const reason = worded(result.reason());
      const verdict: SupportVerdict = { status: STATUS[result.status()] ?? 'inconclusive', ...(reason ? { reason } : {}), issues: found };
      const islandReason = worded(result.island_reason());
      const heights = result.take_island_heights();
      const vertices = result.take_island_vertices();
      const status = result.take_island_status();
      const islands = islandReason
        ? { status: 'inconclusive' as const, reason: islandReason }
        : { status: 'ok' as const, islands: Array.from(heights, (height, k) => ({ height, vertex: vertices[k]!, status: ISLAND_STATUS[status[k]!] ?? 'unknown' })) };
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
        lastResort: (() => {
          const ids = result.take_last_resort_ids();
          const tiers = result.take_last_resort_tiers();
          const clearances = result.take_last_resort_clearances();
          return ids.map((id, k) => ({ id, tier: (tiers[k] === 1 ? 1 : 2) as 1 | 2, clearanceMm: clearances[k]! }));
        })(),
        contactFits: (() => {
          const f = result.contact_fits();
          return { fitted: f[0] ?? 0, seat: f[1] ?? 0, unconverged: f[2] ?? 0 };
        })(),
        modelLanded: (() => {
          const ids = result.take_model_landed_ids();
          const tiers = result.take_model_landed_tiers();
          const points = result.take_model_landed_points();
          return ids.map((id, k) => ({ id, tier: LANDING_TIERS[tiers[k]!] ?? 'unknown', position: [points[k * 3]!, points[k * 3 + 1]!, points[k * 3 + 2]!] as [number, number, number] }));
        })(),
        footprint: unpackFootprint(result.take_footprint(), options.frame ? [options.frame.position[0], options.frame.position[2]] : [0, 0]),
        unresolved: (() => {
          const ids = result.take_unresolved_ids();
          const streams = result.take_unresolved_streams();
          const points = result.take_unresolved_points();
          const reasons = result.take_unresolved_reasons();
          const gaps = result.take_unresolved_best_gaps();
          const needed = result.take_unresolved_needed();
          const kinds = result.take_unresolved_kinds();
          const normals = result.take_unresolved_normals();
          return ids.map((id, k): UnresolvedPoint => ({
            id, kind: unresolvedKind(kinds[k], id, streams[k]!), stream: streams[k]!, position: [points[k * 3]!, points[k * 3 + 1]!, points[k * 3 + 2]!],
            // GEO-008: `null`, never a plausible number. The package's own pattern for a value the
            // engine did not give is `bestGapMm` on the next line - a nullable, not an invention.
            normal: normals.length >= k * 3 + 3 ? [normals[k * 3]!, normals[k * 3 + 1]!, normals[k * 3 + 2]!] : null,
            heightMm: points[k * 3 + 1]! - (options.plateY ?? 0),
            reason: reasons[k]!, bestGapMm: Number.isNaN(gaps[k]!) ? null : gaps[k]!, neededMm: needed[k]!,
          }));
        })(),
        leftOut: (() => {
          const ids = result.take_left_out_ids();
          const points = result.take_left_out_points();
          const reasons = result.take_left_out_reasons();
          return ids.map((id, k) => ({ id, position: [points[k * 3]!, points[k * 3 + 1]!, points[k * 3 + 2]!] as [number, number, number], reason: reasons[k]! }));
        })(),
      };
      // Fallback codes: 1 tree, 3 brace-pruned, anything else brace.
      return { mesh, rings, fallback: Array.from(result.take_fallback(), (f) => (f === 1 ? 'tree' as const : f === 3 ? 'brace-pruned' as const : 'brace' as const)), trials: result.trials(), revision };
    } finally {
      result.free();
    }
  };
  return options.site ? build(options.site) : withOneShotSite(model, build);
}
