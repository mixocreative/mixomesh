import type { PolicyHandle } from '../supports/generateSupports';
import type { TriangleMesh } from '../core/analysis/types';
import type { JobTransform } from '../core/jobs';
import { frameArray, frameKey, type BuildSite, type GenerateSession, type MakePolicy } from '../supports/generateSupports';
import { SESSION_BYTES, supportEngine } from '../supports/supportEngine';

/**
 * The preview mesh worker's build sessions, one per unit: the unit's model is loaded into a WASM
 * session once and stays there with its plate-space copy (and that copy's pick index) for the
 * current frame and the policy made for that frame, so a settings change rebuilds without
 * copying the model again, re-indexing it or remaking the policy. The Rust caches keyed on a mesh
 * (remesh, policy) stay warm while its handle lives and are freed when it is released.
 *
 * A unit's session is replaced when its model changes (new source token), its placed copy when its
 * frame changes (a lift or a move), its policy when the policy or the frame changes (new policy
 * token or frame). `forget` frees a unit's session (unit removed, model evicted from the source
 * cache); a cancelled build terminates the whole worker, which frees every session with it.
 */
export class BuildSessions {
  private readonly units = new Map<string, UnitSite>();

  /** The unit's site for a build of `mesh` (`sourceToken`) whose policy is `policyToken` (none: made per build). */
  site(unitId: string, sourceToken: number, mesh: TriangleMesh, policyToken?: number): BuildSite {
    let unit = this.units.get(unitId);
    if (unit?.sourceToken !== sourceToken) {
      unit?.free();
      unit = new UnitSite(sourceToken, mesh);
      this.units.set(unitId, unit);
    }
    unit.policyToken = policyToken;
    return unit;
  }

  forget(unitId: string): void {
    this.units.get(unitId)?.free();
    this.units.delete(unitId);
  }

  /** Frees every session (tests: a terminated worker frees its WASM instance with them). */
  clear(): void {
    for (const unitId of [...this.units.keys()]) this.forget(unitId);
  }

  get size(): number {
    return this.units.size;
  }
}

class UnitSite implements BuildSite {
  readonly session: GenerateSession;
  readonly source: number;
  policyToken: number | undefined;
  private placedKey = '';
  private placedHandle: number;
  private policyKey: string | undefined;
  private policyHandle: PolicyHandle | undefined;

  constructor(readonly sourceToken: number, mesh: TriangleMesh) {
    this.session = new (supportEngine().GeometrySession)(SESSION_BYTES) as unknown as GenerateSession;
    try {
      this.source = this.session.load_mesh(Float32Array.from(mesh.positions), Uint32Array.from(mesh.indices));
    } catch (error) {
      this.session.free();
      throw error;
    }
    this.placedHandle = this.source;
  }

  placed(frame: JobTransform | undefined): number {
    const key = frameKey(frame);
    if (key === this.placedKey) return this.placedHandle;
    // The old copy goes first, with the Rust caches keyed on its bits; the model's own stay warm.
    if (this.placedHandle !== this.source) this.session.release_mesh(this.placedHandle);
    this.placedKey = '';
    this.placedHandle = this.source;
    if (key) {
      this.placedHandle = this.session.load_placed(this.source, frameArray(frame!));
      this.placedKey = key;
    }
    return this.placedHandle;
  }

  policy(make: MakePolicy, frame: JobTransform | undefined): { handle: PolicyHandle; release(): void } {
    if (this.policyToken === undefined) {
      const handle = make(this.session, this.source);
      return { handle, release: () => handle.free() };
    }
    const key = `${this.policyToken}|${frameKey(frame)}`;
    if (key !== this.policyKey || !this.policyHandle) {
      this.dropPolicy();
      this.policyHandle = make(this.session, this.source);
      this.policyKey = key;
    }
    return { handle: this.policyHandle, release: () => {} };
  }

  free(): void {
    this.dropPolicy();
    // Released one by one so the Rust caches keyed on them are freed too; the session goes after.
    try {
      if (this.placedHandle !== this.source) this.session.release_mesh(this.placedHandle);
      this.session.release_mesh(this.source);
    } finally {
      this.session.free();
    }
  }

  private dropPolicy(): void {
    this.policyHandle?.free();
    this.policyHandle = undefined;
    this.policyKey = undefined;
  }
}
