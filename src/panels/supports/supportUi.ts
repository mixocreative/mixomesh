/**
 * Runtime UI state of Support Mode that is not the document and not the edit session (plan P3.4):
 * the object the panel edits, the live generation job (progress), the support check findings, and
 * the viewport view flags. Nothing here is saved or undoable.
 *
 * SEAMS for P3.5 (live generation) and P3.3 wiring: the panels only read these values and call the
 * handlers below; P3.5 writes `job` / `problems` and registers `handlers`. Until then the Generate
 * button is off (no generator registered) and the problem list is empty.
 */
import { useSyncExternalStore } from 'react';
import type { SupportProblem } from '@mixo-geocore/host/core/analysis/supportCheck';

/** A support check finding of one object, as the list shows it. */
export type PanelProblem = SupportProblem & { unitId: string; inZone: boolean };

export interface JobInfo {
  /** A generation job runs for the target object. */
  running: boolean;
  /** 0..1 when known; omitted = indeterminate. */
  progress?: number;
  /** Locale key of the stage ("supports.progress.findingOverhangs"). */
  stageKey?: string;
}

/** The engine's verdict on the latest build of an object (plan P3.5). */
export interface VerdictInfo {
  status: 'clear' | 'blocked' | 'inconclusive';
  /** Automatic supports the build left out. */
  dropped: number;
  /** Islands no support carries to the plate. */
  islands: number;
}

export interface SupportUiState {
  /** The object the panel edits (one of the mode's objects). */
  targetId: string | undefined;
  job: JobInfo;
  problems: readonly PanelProblem[];
  /** A newer job runs: the findings are listed but greyed until its verdict lands. */
  problemsStale: boolean;
  /** Verdict of the latest build per object id. */
  verdicts: Readonly<Record<string, VerdictInfo>>;
  /** Bottom view is on (the camera looks up at the contacts; the grid and floor disc are hidden). */
  bottomView: boolean;
}

export interface SupportUiHandlers {
  /** Generate / Regenerate the supports of these objects (P3.5). */
  generate?(objectIds: readonly string[]): void;
  cancelJob?(objectId: string): void;
  /** Frame the camera on a finding (P3.5 owns the camera move). */
  showProblem?(problem: PanelProblem): void;
  /** Fix: Show, then wait for a support at the spot and report whether it is covered. */
  fixProblem?(problem: PanelProblem): void;
  /** Bottom view on / off (camera + grid), Fit view (frame the mode's objects). */
  setBottomView?(on: boolean): void;
  fitView?(): void;
  /** Remove the supports of these objects (the models and hand edits stay) and offer to drop them to the bed. */
  removeAll?(objectIds: readonly string[]): void;
  /** Apply the settings of the object `from` to every other of `objectIds` (one undo step). */
  applyToAll?(from: string, objectIds: readonly string[]): void;
}

const INITIAL: SupportUiState = { targetId: undefined, job: { running: false }, problems: [], problemsStale: false, verdicts: {}, bottomView: false };

let state: SupportUiState = INITIAL;
const listeners = new Set<() => void>();
export const handlers: SupportUiHandlers = {};

export const supportUi = {
  get: (): SupportUiState => state,
  set(patch: Partial<SupportUiState>): void {
    const next = { ...state, ...patch };
    if ((Object.keys(next) as (keyof SupportUiState)[]).every((k) => next[k] === state[k])) return;
    state = next;
    listeners.forEach((fn) => fn());
  },
  subscribe(fn: () => void): () => void { listeners.add(fn); return () => { listeners.delete(fn); }; },
  reset(): void { state = INITIAL; listeners.forEach((fn) => fn()); },
  /** P3.5 registers its generator, camera moves... here; returns the call that removes them. */
  register(next: SupportUiHandlers): () => void {
    Object.assign(handlers, next);
    return () => { for (const key of Object.keys(next) as (keyof SupportUiHandlers)[]) if (handlers[key] === next[key]) delete handlers[key]; };
  },
};

export function useSupportUi(): SupportUiState {
  return useSyncExternalStore(supportUi.subscribe, supportUi.get, supportUi.get);
}
