/*
 * The time rule of a support build, host side. The numbers and the rule itself live in Rust
 * (`supports::limits::TimeRules`); the host only passes overrides and sizes its own outer timeouts
 * from the ceiling. No heavy imports here: the main thread reads it too.
 */

/**
 * The engine's time rule, all in ms, each optional (absent: the engine's default, set in Rust
 * `supports::limits::TimeRules`). A build gets `baseMs + perTipMs * tips + per100kTrianglesMs *
 * triangles / 100000` to start with (never above the ceiling), is then extended for as long as it keeps
 * progressing, and stops with an inconclusive verdict only after `stallMs` with no progress or at
 * `ceilingMs`. Defaults today: 60 s, 1.5 s per tip, 15 s per 100k triangles, 30 s stall, 15 min ceiling.
 */
export interface GenerateTimeLimits {
  baseMs?: number;
  perTipMs?: number;
  per100kTrianglesMs?: number;
  stallMs?: number;
  ceilingMs?: number;
}

/** The engine's default ceiling (ms), mirrored here so the host's outer timeouts can stay above it. Keep equal to Rust `TimeRules::default().ceiling_ms`. */
export const DEFAULT_GENERATE_CEILING_MS = 900_000;

/** The ceiling a call with these limits runs under (ms). */
export const generateCeilingMs = (limits?: GenerateTimeLimits): number => limits?.ceilingMs ?? DEFAULT_GENERATE_CEILING_MS;

/** `limits` as the engine reads it: base, per tip, per 100k triangles, stall, ceiling; NaN keeps the engine's default. */
export function packLimits(limits?: GenerateTimeLimits): Float64Array {
  const { baseMs, perTipMs, per100kTrianglesMs, stallMs, ceilingMs } = limits ?? {};
  return Float64Array.of(baseMs ?? NaN, perTipMs ?? NaN, per100kTrianglesMs ?? NaN, stallMs ?? NaN, ceilingMs ?? NaN);
}

/**
 * The overrides every `generate` call uses; empty, so the engine's defaults apply. Put values here to
 * tune the rule without a Rust rebuild. The build is extended while it progresses and stopped only
 * after a stall or at the ceiling; the verdict is then inconclusive, never clear.
 */
export const GENERATE_LIMITS: GenerateTimeLimits = {};
