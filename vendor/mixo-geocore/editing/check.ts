import type { Vector } from '../host/core/vec3';
import type { StatusMessage } from './types';

/**
 * Support check results as the user sees them. A check that was replaced, cancelled or failed is
 * "incomplete", never "no spots": the status line must tell "not checked" from "checked, clean".
 */
export interface CheckTally {
  /** Spots that may print unsupported. */
  spots: number;
  /** Spots inside no-support zones (unsupported on purpose). */
  inZone: number;
  /** Units whose check did not finish. */
  incomplete: number;
  /** Units whose islands could not be judged (the island verdict was inconclusive): never counted as clean. */
  unjudged: number;
}

/** Sums per-unit results; `undefined` is a unit whose check did not finish. */
export function tallyChecks(results: readonly ({ spots: number; inZone: number; unjudged?: number } | undefined)[]): CheckTally {
  return results.reduce<CheckTally>((sum, result) => (result
    ? { ...sum, spots: sum.spots + result.spots, inZone: sum.inZone + result.inZone, unjudged: sum.unjudged + (result.unjudged ?? 0) }
    : { ...sum, incomplete: sum.incomplete + 1 }), { spots: 0, inZone: 0, incomplete: 0, unjudged: 0 });
}

/** The sentence for objects whose islands could not be judged; `see` points to the list. */
function unjudgedNote(n: number, see: boolean): StatusMessage {
  return see
    ? { key: 'Islands could not be judged on 1 object: see Check supports.', other: 'Islands could not be judged on {n} objects: see Check supports.', vars: { n } }
    : { key: 'Islands could not be judged on 1 object.', other: 'Islands could not be judged on {n} objects.', vars: { n } };
}

/** The status line after Check for unsupported spots. */
export function checkStatus({ spots, inZone, incomplete, unjudged }: CheckTally): StatusMessage {
  if (incomplete > 0) return { key: 'The check did not finish for 1 object: run it again.', other: 'The check did not finish for {n} objects: run it again.', vars: { n: incomplete } };
  if (spots + inZone === 0) return unjudged > 0 ? unjudgedNote(unjudged, true) : { key: 'No unsupported spots found.' };
  const found: StatusMessage = { key: '1 spot may print unsupported: see Check supports.', other: '{n} spots may print unsupported: see Check supports.', vars: { n: spots + inZone } };
  return unjudged > 0 ? { ...found, then: unjudgedNote(unjudged, false) } : found;
}

/** The status line after an export, with what its companion check found. */
export function exportStatus(files: string, tally: CheckTally): StatusMessage {
  const base = exportFound(files, tally);
  return tally.unjudged > 0 && tally.incomplete === 0 ? { ...base, then: unjudgedNote(tally.unjudged, true) } : base;
}

function exportFound(files: string, { spots, inZone, incomplete }: CheckTally): StatusMessage {
  if (incomplete > 0) {
    return {
      key: 'Exported {files}, but the support check did not finish for 1 object: run Check supports.',
      other: 'Exported {files}, but the support check did not finish for {n} objects: run Check supports.',
      vars: { files, n: incomplete },
    };
  }
  // Spots inside no-support zones are left unsupported on purpose: not counted, only mentioned.
  if (spots > 0 && inZone > 0) return { key: 'Exported {files}. 1 spot may print unsupported ({m} more inside no-support zones): see Check supports.', other: 'Exported {files}. {n} spots may print unsupported ({m} more inside no-support zones): see Check supports.', vars: { files, n: spots, m: inZone } };
  if (spots > 0) return { key: 'Exported {files}. 1 spot may print unsupported: see Check supports.', other: 'Exported {files}. {n} spots may print unsupported: see Check supports.', vars: { files, n: spots } };
  if (inZone > 0) return { key: 'Exported {files}. 1 unsupported spot is inside a no-support zone.', other: 'Exported {files}. {n} unsupported spots are inside no-support zones.', vars: { files, n: inZone } };
  return { key: 'Exported {files}.', vars: { files } };
}

const runTokens = new WeakMap<object, Map<object | undefined, object>>();

/**
 * One token per unit version and support build: a check of the same unit against another build
 * (or none) is a different job, so it never joins one that counted other contacts.
 */
export function runToken(unit: object, build: object | undefined): object {
  let byBuild = runTokens.get(unit);
  if (!byBuild) runTokens.set(unit, (byBuild = new Map()));
  let token = byBuild.get(build);
  if (!token) byBuild.set(build, (token = {}));
  return token;
}

/**
 * Runs `start` for `key` unless a job for the same `token` (see `runToken`) is running, which is
 * joined instead: the user's check and an export's check of an unchanged unit share one run rather
 * than one replacing the other. A new token starts its own job.
 */
export function joinRun<T>(running: Map<string, { token: object; promise: Promise<T> }>, key: string, token: object, start: () => Promise<T>): Promise<T> {
  const current = running.get(key);
  if (current && current.token === token) return current.promise;
  const promise = start();
  running.set(key, { token, promise });
  const clear = () => {
    if (running.get(key)?.promise === promise) running.delete(key);
  };
  promise.then(clear, clear);
  return promise;
}

/** How near a new support must land to cover a finding: the support spacing, or the finding's own size when that is larger. */
export const coverRadius = (spacing: number, area: number): number => Math.max(spacing, Math.sqrt(area));

/** A check finding being fixed: its place in the object's frame and how near a new support must land to cover it. */
export interface FixSpot { unitId: string; position: Vector; radius: number }

/** Whether `position` (the object's frame) lies within the spot's cover radius. */
export const atSpot = (position: Vector, spot: FixSpot): boolean => Math.hypot(position[0] - spot.position[0], position[1] - spot.position[1], position[2] - spot.position[2]) <= spot.radius;

/** The status line once the re-check that follows a support added at a Fix spot has finished: the real check says whether it is still unsupported. */
export function recheckStatus(spot: FixSpot, findings: readonly { position: Vector }[]): StatusMessage {
  return findings.some((finding) => atSpot(finding.position, spot)) ? { key: 'Still unsupported here.' } : { key: 'Spot covered.' };
}

/**
 * The findings of an out of date check that no support covers yet: a finding goes the moment a
 * support (added by hand or placed again) lands within its cover radius, without waiting for a new
 * check. `keep` names findings that stay listed whatever lands near them (the spot being re-checked).
 */
export function uncovered<P extends { position: Vector; area: number }>(findings: readonly P[], supports: readonly { position: Vector }[], spacing: number, keep?: (finding: P) => boolean): P[] {
  return findings.filter((finding) => {
    if (keep?.(finding)) return true;
    const radius = coverRadius(spacing, finding.area);
    return !supports.some((support) => Math.hypot(support.position[0] - finding.position[0], support.position[1] - finding.position[1], support.position[2] - finding.position[2]) <= radius);
  });
}
