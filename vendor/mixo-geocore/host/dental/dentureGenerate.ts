import type { SupportContact } from '../core/supports/mesh';
import type { LiveSupportSettings } from '../core/supports/settings';
import { generateSupports, type GenerateOptions, type GenerateOutput, type MakePolicy } from '../supports/generateSupports';

/*
 * UNUSED HELPER (measured no gain 2026-10-30: more lift left the same tips out on every case and tripled the build time;
 * the mixodental batch builds once at the profile lift). Kept for a later case where lift does route tips.
 * REGISTERED: docs/GAP-REGISTER.md section F carries the measurement, its date and the condition that
 * would wire it - a comment in the file itself is the one place a person asking "what are we carrying
 * and why" will not look (GEO-016). Its three tests in dentureGenerate.test.ts keep it compiling,
 * which is the whole cost; if the row goes, so does the code.
 *
 * Denture support build with the extra-lift retry (owner rule, 2026-10-30). A denture is built at the
 * profile's lift (3.5 mm). When automatic tips are left out for lack of a route at that lift, the same
 * build is repeated with the plate lowered by 2.5 mm more, then by 5 mm more (at most 8.5 mm of lift
 * in all), and the build with the fewest tips left out is kept (the lowest lift wins a tie). Nothing
 * about routes is decided here: the engine reports `leftOut` and this only chooses among its builds.
 *
 * The plate moves in the generation frame (`GenerateOptions.plateY`), as a lift change does
 * (`liftCommands`); the caller that keeps a retried build must raise the unit by `extraLiftMm` so
 * the unit and its plate agree.
 */

/** Extra lift tried after the first build, mm over the profile's lift (the last one makes 8.5 mm in all). */
export const EXTRA_LIFT_STEPS_MM: readonly number[] = [2.5, 5];

/** One attempt of the retry: the extra lift it used and how many tips it left out. */
export interface LiftAttempt {
  extraLiftMm: number;
  leftOut: number;
}

/** The kept build with the extra lift it was made at and every attempt (in the order tried). */
export interface RetriedBuild<T> {
  output: T;
  extraLiftMm: number;
  attempts: LiftAttempt[];
}

/**
 * Runs `build(extraLiftMm)` at 0 and, while tips are left out, at each of `steps`; keeps the build with the
 * fewest left out (the lowest lift on a tie). `count` reads how many tips a build left out.
 */
export function retryWithExtraLift<T>(build: (extraLiftMm: number) => T, count: (output: T) => number, steps: readonly number[] = EXTRA_LIFT_STEPS_MM): RetriedBuild<T> {
  const attempts: LiftAttempt[] = [];
  let best: { output: T; extraLiftMm: number; left: number } | undefined;
  for (const extraLiftMm of [0, ...steps]) {
    const output = build(extraLiftMm);
    const left = count(output);
    attempts.push({ extraLiftMm, leftOut: left });
    if (!best || left < best.left) best = { output, extraLiftMm, left };
    if (left === 0) break;
  }
  return { output: best!.output, extraLiftMm: best!.extraLiftMm, attempts };
}

/** `generateSupports` for a denture unit, with the extra-lift retry. */
export function generateDentureSupports(contacts: readonly SupportContact[], settings: Readonly<LiveSupportSettings>, policy: MakePolicy, options: GenerateOptions): RetriedBuild<GenerateOutput> {
  const plate = options.plateY ?? 0;
  return retryWithExtraLift(
    (extra) => generateSupports(contacts, settings, policy, { ...options, plateY: plate - extra }),
    (out) => out.mesh.leftOut?.length ?? 0,
  );
}
